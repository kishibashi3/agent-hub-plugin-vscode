// Copilot Chat participant — `@agent-hub` (issue #29).
//
// Registers a VS Code Chat participant so users can send DMs to
// agent-hub participants directly from the Copilot Chat panel:
//
//   @agent-hub @planner 今日のタスクは？
//   @agent-hub @team-backend デプロイ状況を確認して
//
// Flow (Option A — fire-and-forget):
//   1. Parse `@<handle> <body>` from request.prompt.
//   2. If no active session, call autoStart() to start inbox watch.
//   3. Call session.send(to, body).
//   4. Report "sent ✅" in the chat response stream.
//      The reply (if any) arrives via the normal inbox watch flow.
//
// This module is vscode-bound (imports vscode) so it lives in the
// vscode-bound layer alongside agentHub.ts / lmDispatcher.ts.

import * as vscode from 'vscode';

import type { InboxWatcher } from './agentHub';
// parsePrompt lives in the vscode-free `./chatParticipantCore` module so it
// can be unit-tested with plain `node:test` / `tsx` without a VS Code shim.
// Re-exported here for call sites that `import { parsePrompt } from './chatParticipant'`.
export { parsePrompt } from './chatParticipantCore';
import { parsePrompt } from './chatParticipantCore';

export const CHAT_PARTICIPANT_ID = 'agent-hub.participant';

const USAGE_MARKDOWN = [
  'Usage: `@agent-hub @<handle> <message>`',
  '',
  'Examples:',
  '- `@agent-hub @planner 今日のタスクは？`',
  '- `@agent-hub @team-backend デプロイ状況を確認して`',
  '- `@agent-hub @ope-ultp1635 restart bridge-claude`',
].join('\n');

/**
 * Register the `@agent-hub` Copilot Chat participant.
 *
 * @param context    Extension context — participant is added to subscriptions.
 * @param getWatcher Returns the currently-active `InboxWatcher` (or undefined).
 *                   Checked on each request so reconnects are transparent.
 * @param autoStart  Called when no session is active; starts inbox watch.
 *                   Must resolve after the watcher session is usable.
 * @param log        Output-channel logger (same as extension.ts `log`).
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  getWatcher: () => InboxWatcher | undefined,
  autoStart: () => Promise<void>,
  log: (msg: string) => void
): void {
  const participant = vscode.chat.createChatParticipant(
    CHAT_PARTICIPANT_ID,
    async (request, _chatContext, response, _token) => {
      const parsed = parsePrompt(request.prompt);

      if (!parsed) {
        response.markdown(USAGE_MARKDOWN);
        return;
      }

      const { to, body } = parsed;
      log(`[chat] request: to=${to} body=${JSON.stringify(body.slice(0, 80))}`);

      // ── Auto-start if no session is active ──────────────────────────
      let w = getWatcher();
      if (!w?.session) {
        log('[chat] no active session — auto-starting inbox watch');
        response.markdown('🔄 Starting inbox watch…\n\n');
        await autoStart();
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

      // ── Send ─────────────────────────────────────────────────────────
      try {
        await session.send(to, body);
        log(`[chat] sent to ${to}`);
        response.markdown(`✅ Sent to **${to}**\n\n> ${body}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[chat] send error to ${to}: ${msg}`);
        response.markdown(`❌ Failed to send to **${to}**: ${msg}`);
      }
    }
  );

  participant.iconPath = new vscode.ThemeIcon('comment-discussion');
  context.subscriptions.push(participant);
}
