// LM dispatcher: glue between the agent-hub inbox watcher and VS Code's
// Language Model API (Copilot Chat). Step 3 of issue #1.
//
// Pipeline per inbound notification:
//
//   1. Inbox notification (`InboxWatcher.onMessage`) → `requestDrain()`
//   2. drainLoop serializes via a single-flight + redrain-pending flag
//   3. each drain calls `client.getMessages()` for ALL unread items
//      (a single fetch handles batched arrivals)
//   4. per message: build prompt, pick a chat model, `sendRequest`, stream
//      the response into the output channel
//   5. on success: `client.markAsRead(id)`; on failure leave the message
//      unread so the next drain (after reconnect, model availability,
//      consent grant, …) retries.
//
// Step 5 will replace the "log to output channel" line with a real
// `send_message` relay. Step 4 will enrich the prompt with the active
// editor / selection / diagnostics before `sendRequest`.

import * as vscode from 'vscode';

import type {
  HubSession,
  IncomingMessage,
} from '@kishibashi3/agent-hub-sdk';

import type { InboxMessageNotification, InboxWatcher } from './agentHub';
import { type SentPeers } from './sentPeers';
import {
  collectIdeContext,
  EMPTY_IDE_CONTEXT_SNAPSHOT,
  formatIdeContext,
  type IdeContextOptions,
  type IdeContextSnapshot,
} from './ideContext';
// `formatPrompt` now lives in the vscode-free `./promptFormat` module so
// it can be unit-tested without a VS Code shim. Re-exported here for
// public surface compatibility — existing `import { formatPrompt } from
// './lmDispatcher'` call sites keep working.
export { formatPrompt } from './promptFormat';

type Logger = (msg: string) => void;

export interface LmDispatcherConfig {
  /** Pre-pended to every prompt. Trimmed; an empty string means no preamble. */
  readonly systemPrompt: string;
  /** Selector passed to `vscode.lm.selectChatModels`. Empty fields are dropped. */
  readonly modelSelector: vscode.LanguageModelChatSelector;
  /** User-facing reason surfaced by VS Code when prompting for LM consent. */
  readonly justification: string;
  /** IDE-context-capture options. `enabled: false` short-circuits to an empty snapshot. */
  readonly ideContext: IdeContextOptions;
}

export interface LmDispatcherDeps {
  readonly watcher: InboxWatcher;
  readonly cfg: LmDispatcherConfig;
  readonly log: Logger;
  /**
   * Registry of handles the Chat participant has sent DMs to (issue #32).
   * When set, `dispatchOne` calls `sentPeers.has(msg.sender)` before any
   * LM work. If the sender is a known contact, the message is ack'd and
   * shown as a VS Code notification instead of being routed through the
   * LM. If `undefined`, every message is dispatched autonomously.
   */
  readonly sentPeers?: SentPeers;
  /**
   * Injection points for testing — production wiring passes the real
   * `vscode.lm.selectChatModels` and a fresh `CancellationTokenSource`.
   */
  readonly selectChatModels?: (
    selector: vscode.LanguageModelChatSelector
  ) => Thenable<vscode.LanguageModelChat[]>;
  /**
   * Test injection point for IDE-context capture. Production passes the
   * real `collectIdeContext` which reads `vscode.window.activeTextEditor`
   * + `vscode.languages.getDiagnostics` at call time.
   */
  readonly collectIdeContext?: (
    opts: IdeContextOptions
  ) => IdeContextSnapshot | Promise<IdeContextSnapshot>;
}

// `formatPrompt` is re-exported above; the implementation now lives in
// `./promptFormat` so a plain Node test runner can require it without a
// VS Code shim.
import { formatPrompt } from './promptFormat';

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class LmDispatcher {
  private draining = false;
  private redrainPending = false;
  private readonly cts = new vscode.CancellationTokenSource();
  private readonly selectChatModels: (
    selector: vscode.LanguageModelChatSelector
  ) => Thenable<vscode.LanguageModelChat[]>;
  private readonly collectIdeContext: (
    opts: IdeContextOptions
  ) => IdeContextSnapshot | Promise<IdeContextSnapshot>;

  constructor(private readonly deps: LmDispatcherDeps) {
    this.selectChatModels = deps.selectChatModels ?? ((s) => vscode.lm.selectChatModels(s));
    this.collectIdeContext = deps.collectIdeContext ?? collectIdeContext;
  }

  /** Suitable as an `InboxWatcher.onMessage` listener. */
  onInboxNotification = (_n: InboxMessageNotification): void => {
    this.requestDrain();
  };

  /**
   * Trigger an inbox drain. Safe to call repeatedly: if a drain is already
   * in flight, the second call sets a "redrain when done" flag so we don't
   * miss notifications that arrive *during* a drain.
   */
  requestDrain(): void {
    if (this.draining) {
      this.redrainPending = true;
      return;
    }
    void this.drainLoop();
  }

  dispose(): void {
    this.cts.cancel();
    this.cts.dispose();
  }

  // ─── internal ────────────────────────────────────────────────────────────

  private async drainLoop(): Promise<void> {
    this.draining = true;
    try {
      do {
        this.redrainPending = false;
        await this.drainOnce();
      } while (this.redrainPending && !this.cts.token.isCancellationRequested);
    } catch (err) {
      this.deps.log(`[ERR] drain: ${errMsg(err)}`);
    } finally {
      this.draining = false;
    }
  }

  private async drainOnce(): Promise<void> {
    const session = this.requireSession();
    if (!session) {
      this.deps.log('[drain] watcher not currently subscribed — skipping');
      return;
    }
    let messages: IncomingMessage[];
    try {
      messages = await session.getUnread();
    } catch (err) {
      this.deps.log(`[ERR] get_messages: ${errMsg(err)}`);
      return;
    }
    if (messages.length === 0) return;
    this.deps.log(`[drain] processing ${messages.length} unread message(s)`);
    for (const msg of messages) {
      if (this.cts.token.isCancellationRequested) return;
      await this.dispatchOne(msg);
    }
  }

  private async dispatchOne(msg: IncomingMessage): Promise<void> {
    this.deps.log(
      `[dispatch] from=${msg.sender} id=${msg.id}: ${truncate(msg.body, 80)}`
    );

    // ── Sent-peer intercept (issue #32) ─────────────────────────────────
    // If this message is a reply from a handle the Chat participant has
    // already DM'd, skip the LM entirely — show the reply as a VS Code
    // notification and log it to the output channel. This prevents the
    // bridge from generating an unwanted autonomous reply back to the peer.
    if (this.deps.sentPeers?.has(msg.sender)) {
      this.deps.log(
        `[relay] reply from ${msg.sender} (known contact) — skipping LM, showing notification (msg=${msg.id})`
      );
      void vscode.window.showInformationMessage(
        `agent-hub — ${msg.sender}: ${truncate(msg.body, 120)}`
      );
      await this.markRead(msg);
      return;
    }
    // ────────────────────────────────────────────────────────────────────

    const model = await this.pickModel();
    if (!model) return; // already logged

    // Snapshot the IDE *after* model selection so the editor state is as
    // fresh as possible at the moment the LM is about to read it. Cheap
    // (synchronous read) so order has no real cost; clarity over speed.
    let ideSnapshot: IdeContextSnapshot = EMPTY_IDE_CONTEXT_SNAPSHOT;
    try {
      // Collector may be sync (tests inject a fake) or async (production
      // reads vscode.git for the optional diff section). `await` handles
      // both cleanly thanks to the union return type on the dep slot.
      ideSnapshot = await this.collectIdeContext(this.deps.cfg.ideContext);
    } catch (err) {
      // A throwing IDE snapshotter shouldn't break the pipeline — degrade
      // to "no IDE context" and continue. Log so it's diagnosable.
      this.deps.log(
        `[WARN] collectIdeContext threw — proceeding without IDE context: ${errMsg(err)}`
      );
    }
    const ideContextStr = formatIdeContext(ideSnapshot);
    if (ideSnapshot.activeFile) {
      const sel = ideSnapshot.selection
        ? `selection ${ideSnapshot.selection.startLine}-${ideSnapshot.selection.endLine}${
            ideSnapshot.selection.truncated ? ' (truncated)' : ''
          }`
        : ideSnapshot.cursorWindow
          ? `cursor-window ${ideSnapshot.cursorWindow.startLine}-${ideSnapshot.cursorWindow.endLine}`
          : 'no selection/window';
      const git = ideSnapshot.gitDiff
        ? ` gitDiff=${ideSnapshot.gitDiff.changes.length}` +
          (ideSnapshot.gitDiff.truncatedFileCount > 0
            ? `+${ideSnapshot.gitDiff.truncatedFileCount}`
            : '') +
          (ideSnapshot.gitDiff.branchName.length > 0
            ? `@${ideSnapshot.gitDiff.branchName}`
            : '')
        : '';
      const secondaries =
        ideSnapshot.secondaryEditors && ideSnapshot.secondaryEditors.length > 0
          ? ` secondaries=${ideSnapshot.secondaryEditors.length}`
          : '';
      const notebook = ideSnapshot.activeNotebook
        ? ` notebook=${ideSnapshot.activeNotebook.notebookType}:` +
          `${ideSnapshot.activeNotebook.activeCellIndex >= 0
            ? ideSnapshot.activeNotebook.activeCellIndex + 1
            : '-'}/${ideSnapshot.activeNotebook.cellCount}`
        : '';
      this.deps.log(
        `[ide-context] file=${ideSnapshot.activeFile.uri} ` +
          `lang=${ideSnapshot.activeFile.languageId} ${sel} ` +
          `diagnostics=${ideSnapshot.diagnostics.length}${git}${secondaries}${notebook}`
      );
    } else if (this.deps.cfg.ideContext.enabled) {
      // Enabled but no editor focused — note it once per dispatch so the
      // operator knows the LM saw no IDE context for this reply.
      this.deps.log('[ide-context] no active text editor — sending message without IDE context');
    }

    const prompt = formatPrompt(this.deps.cfg.systemPrompt, msg, ideContextStr);
    const chatMessages = [vscode.LanguageModelChatMessage.User(prompt)];

    const responseText = await this.runChat(model, chatMessages, msg);
    if (responseText === undefined) return; // already logged on error path

    if (responseText.length === 0) {
      this.deps.log(
        `[WARN] LM returned empty text for msg=${msg.id} — leaving unread for retry`
      );
      return;
    }

    // Step 5: relay the LM response back via `send_message` BEFORE
    // marking the message read. The order matters — if the relay fails
    // (server restart, stale session, recipient deleted, …) we want the
    // message to stay in the inbox so the next drain retries.
    //
    // The full response text is still logged to the output channel as a
    // `[reply-sent]` breadcrumb so an operator can audit what got
    // forwarded without correlating with the agent-hub server logs.
    const replySession = this.requireSession();
    if (!replySession) {
      this.deps.log(
        `[WARN] watcher lost session before reply for msg=${msg.id} — ` +
          'message will be redelivered on the next drain'
      );
      return;
    }
    try {
      await replySession.send(msg.sender, responseText);
    } catch (err) {
      this.deps.log(
        `[ERR] send_message to=${msg.sender} msg=${msg.id}: ${errMsg(err)} — ` +
          'leaving message unread for retry'
      );
      return;
    }
    this.deps.log(
      `[reply-sent] to=${msg.sender} model=${model.id} msg=${msg.id} ` +
        `chars=${responseText.length}\n` +
        `--- begin reply ---\n${responseText}\n--- end reply ---`
    );

    await this.markRead(msg);
  }

  /**
   * The SDK `HubSession` for the watcher's *current* MCP session, or
   * `null` when reconnecting / idle. Re-read per call so the dispatcher
   * naturally follows the watcher across reconnects (= old session
   * discarded, new one bound after re-subscribe).
   */
  private requireSession(): HubSession | null {
    return this.deps.watcher.session;
  }

  private async pickModel(): Promise<vscode.LanguageModelChat | undefined> {
    let models: vscode.LanguageModelChat[];
    try {
      models = await this.selectChatModels(this.deps.cfg.modelSelector);
    } catch (err) {
      this.deps.log(
        `[ERR] selectChatModels: ${errMsg(err)} — leaving message unread for retry`
      );
      return undefined;
    }
    const model = models[0];
    if (!model) {
      this.deps.log(
        `[ERR] no chat model matches selector ` +
          `${JSON.stringify(this.deps.cfg.modelSelector)} — ` +
          'is Copilot Chat installed and signed in? Leaving message unread for retry.'
      );
      return undefined;
    }
    return model;
  }

  private async runChat(
    model: vscode.LanguageModelChat,
    chatMessages: vscode.LanguageModelChatMessage[],
    msg: IncomingMessage
  ): Promise<string | undefined> {
    try {
      const response = await model.sendRequest(
        chatMessages,
        { justification: this.deps.cfg.justification },
        this.cts.token
      );
      let buf = '';
      for await (const chunk of response.text) {
        if (this.cts.token.isCancellationRequested) return undefined;
        buf += chunk;
      }
      return buf;
    } catch (err) {
      // `LanguageModelError.code` covers NoPermissions / Blocked / NotFound;
      // include it in the log when present so an operator can see exactly
      // why we punted (e.g. "user denied consent" vs "quota exhausted").
      const code = (err as { code?: unknown }).code;
      const codeStr = typeof code === 'string' && code.length > 0 ? ` (code=${code})` : '';
      this.deps.log(
        `[ERR] LM dispatch model=${model.id} msg=${msg.id}${codeStr}: ${errMsg(err)} — ` +
          'leaving message unread for retry'
      );
      return undefined;
    }
  }

  private async markRead(msg: IncomingMessage): Promise<void> {
    const session = this.requireSession();
    if (!session) {
      this.deps.log(
        `[WARN] watcher lost session before mark_as_read msg=${msg.id} — ` +
          'message will be redelivered on the next drain'
      );
      return;
    }
    try {
      await session.ack(msg.id);
      this.deps.log(`[ack] mark_as_read msg=${msg.id}`);
    } catch (err) {
      this.deps.log(
        `[WARN] mark_as_read msg=${msg.id}: ${errMsg(err)} — ` +
          'message will be redelivered on the next drain'
      );
    }
  }
}
