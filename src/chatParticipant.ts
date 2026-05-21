// Copilot Chat participant — `@agent-hub` (issue #28, #45, #47, #50).
//
// Registers a VS Code Chat participant so users can send DMs to
// agent-hub participants directly from the Copilot Chat panel.
//
// Recipient resolution priority (issue #50):
//   1. Explicit handle:  `@agent-hub @<handle> <body>`  → parsePrompt
//   2. Handle, no body:  `@agent-hub @<handle>`         → parseHandle + InputBox
//   3. Sticky handle:    stickyHandle.value (last sender/recipient)
//   4. Default handle:   agentHubBridge.defaultHandle setting
//   5. Participant picker: vscode.window.showQuickPick
//
// Sticky handle (issue #47/#50):
//   - Updated to `to` after every successful send.
//   - Updated to `msg.sender` whenever a DM is received (lmDispatcher).
//   - Shared mutable ref — `extension.ts` owns the object; both
//     `registerChatParticipant` and `LmDispatcher` hold a reference.
//
// Relay flow (issue #45):
//   After send(), the handler awaits a reply (up to RELAY_TIMEOUT_MS).
//   The inbox drain's tryResolve() resolves the waiter; the reply appears
//   inline in the Chat panel. Timeout → "⏱ No reply within 60s".
//   User Escape → waiter removed from map to prevent message loss.
//
// This module is vscode-bound (imports vscode) — vscode-bound layer only.

import * as vscode from 'vscode';

import type { Participant } from '@kishibashi3/agent-hub-sdk';
import type { InboxWatcher } from './agentHub';
// parsePrompt lives in the vscode-free `./chatParticipantCore` module so it
// can be unit-tested with plain `node:test` / `tsx` without a VS Code shim.
// Re-exported here for call sites that `import { parsePrompt } from './chatParticipant'`.
export { parsePrompt, parseHandle } from './chatParticipantCore';
import { parseHandle, parsePrompt } from './chatParticipantCore';
import { RelayTimeout, type RelayTracker } from './relayTracker';

/** Wall-clock budget for awaiting a reply in the Chat panel (ms). */
export const RELAY_TIMEOUT_MS = 60_000;

export const CHAT_PARTICIPANT_ID = 'agent-hub.participant';

const USAGE_MARKDOWN = [
  'Usage: `@agent-hub @<handle> <message>`',
  '',
  'Or type `@agent-hub` / `@agent-hub <message>` to pick a recipient from a list.',
  '',
  'Examples:',
  '- `@agent-hub @planner 今日のタスクは？`',
  '- `@agent-hub @team-backend デプロイ状況を確認して`',
  '- `@agent-hub @ope-ultp1635 restart bridge-claude`',
].join('\n');

/**
 * Register the `@agent-hub` Copilot Chat participant.
 *
 * @param context      Extension context — participant is added to subscriptions.
 * @param getWatcher   Returns the currently-active `InboxWatcher` (or undefined).
 * @param autoStart    Called when no session is active; starts inbox watch.
 * @param log          Output-channel logger.
 * @param relayTracker Shared waiter map for Chat-panel reply relay (issue #45).
 * @param stickyHandle Shared mutable ref updated by both the send path (after
 *                     successful send) and the inbox drain (on every received DM).
 *                     Owned by `extension.ts`; passed to `LmDispatcher` as well.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  getWatcher: () => InboxWatcher | undefined,
  autoStart: () => Promise<void>,
  log: (msg: string) => void,
  relayTracker: RelayTracker,
  stickyHandle: { value: string | undefined }
): void {

  const participant = vscode.chat.createChatParticipant(
    CHAT_PARTICIPANT_ID,
    async (request, _chatContext, response, token) => {
      const parsed = parsePrompt(request.prompt);
      const promptBody = request.prompt.trim();

      // ── Ensure session (needed for both send and getParticipants) ─────
      let w = getWatcher();
      if (!w?.session) {
        log('[chat] no active session — auto-starting inbox watch');
        response.markdown('🔄 Starting inbox watch…\n\n');
        await autoStart();
        if (token.isCancellationRequested) return;
        w = getWatcher();
      }

      const session = w?.session;
      if (!session) {
        response.markdown(
          '❌ Could not start session. Check your `agentHubBridge.*` settings ' +
            'and run **agent-hub bridge: Start inbox watch** manually.'
        );
        return;
      }

      // ── Resolve recipient and body ────────────────────────────────────
      let to: string;
      let body: string;

      const handleOnly = !parsed ? parseHandle(request.prompt) : null;

      if (parsed) {
        // A. Normal path: `@<handle> <body>` both present.
        to = parsed.to;
        body = parsed.body;
        log(`[chat] request: to=${to} body=${JSON.stringify(body.slice(0, 80))}`);
      } else if (handleOnly) {
        // B. Handle present, body absent: `@agent-hub @<handle>` with no message.
        //    Skip the picker and jump straight to the body input box.
        to = handleOnly.handle;
        log(`[chat] handle-only prompt — asking for body (to=${to})`);
        const inputBody = await vscode.window.showInputBox({
          title: `DM to ${to}`,
          placeHolder: 'Message…',
          ignoreFocusOut: true,
        });
        if (inputBody === undefined || token.isCancellationRequested) return;
        body = inputBody.trim();
        if (!body) return; // empty submit — no-op
        log(`[chat] handle-only body=${JSON.stringify(body.slice(0, 80))}`);
      } else {
        // C. No explicit handle — resolve via sticky → defaultHandle → QuickPick.
        const sticky = stickyHandle.value;
        const defaultHandle =
          vscode.workspace.getConfiguration('agentHubBridge').get<string>('defaultHandle')?.trim() ?? '';

        if (sticky) {
          // C1. Sticky: use the most recently contacted/received handle.
          to = sticky;
          log(`[chat] no handle — sticky: ${to}`);
        } else if (defaultHandle) {
          // C2. Default: use the agentHubBridge.defaultHandle setting.
          to = defaultHandle;
          log(`[chat] no handle — defaultHandle config: ${to}`);
        } else {
          // C3. QuickPick: fetch participant list and let the user choose.
          log('[chat] no handle — showing participant picker');

          let participants: Participant[];
          try {
            participants = await session.getParticipants();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`[chat] getParticipants failed: ${msg}`);
            response.markdown(USAGE_MARKDOWN);
            return;
          }

          if (token.isCancellationRequested) return;

          // Sort: online first, then offline.
          const online = participants.filter((p) => p.isOnline);
          const offline = participants.filter((p) => !p.isOnline);
          const sorted = [...online, ...offline];

          const items: vscode.QuickPickItem[] = sorted.map((p) => ({
            label: p.name,
            description: p.isOnline ? '● online' : '○ offline',
            detail: p.displayName ?? undefined,
          }));

          const picked = await vscode.window.showQuickPick(items, {
            title: 'agent-hub: Select recipient',
            placeHolder: 'Pick a participant to DM',
            ignoreFocusOut: true,
          });

          if (!picked || token.isCancellationRequested) return;
          to = picked.label;
        }

        // Body: use whatever the user typed in the prompt, or ask via InputBox.
        body = promptBody;
        if (!body) {
          const inputBody = await vscode.window.showInputBox({
            title: `DM to ${to}`,
            placeHolder: 'Message…',
            ignoreFocusOut: true,
          });
          if (inputBody === undefined || token.isCancellationRequested) return;
          body = inputBody.trim();
          if (!body) return; // empty submit — no-op
        }

        log(`[chat] resolved: to=${to} body=${JSON.stringify(body.slice(0, 80))}`);
      }

      // ── Send + relay wait ─────────────────────────────────────────────
      try {
        await session.send(to, body);
        // Update sticky handle only after a successful send (issue #47 Minor #1).
        stickyHandle.value = to;
        log(`[chat] sent to ${to}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[chat] send error to ${to}: ${msg}`);
        response.markdown(`❌ Failed to send to **${to}**: ${msg}`);
        return;
      }

      response.markdown(`✅ Sent to **${to}**\n\n> ${body}\n\n⏳ Waiting for reply…`);

      // Race the relay wait against user cancellation.
      const cancelPromise = new Promise<never>((_, reject) =>
        token.onCancellationRequested(() => reject(new Error('cancelled')))
      );
      try {
        const reply = await Promise.race([
          relayTracker.waitFor(to, RELAY_TIMEOUT_MS),
          cancelPromise,
        ]);
        log(`[chat] relay received from ${to} (msg=${reply.id})`);
        response.markdown(`\n\n**${to}**: ${reply.body}`);
      } catch (err) {
        if (err instanceof RelayTimeout) {
          log(`[chat] relay timeout waiting for reply from ${to}`);
          response.markdown(`\n\n⏱ No reply within ${Math.round(RELAY_TIMEOUT_MS / 1000)}s.`);
        } else {
          // Cancellation — remove stale waiter so a late reply routes to
          // VS Code notification rather than being silently consumed.
          relayTracker.cancel(to);
        }
      }
    }
  );

  participant.iconPath = new vscode.ThemeIcon('comment-discussion');
  context.subscriptions.push(participant);
}
