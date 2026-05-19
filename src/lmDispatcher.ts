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

import type { AgentHubClient, InboxMessage, InboxMessageNotification, InboxWatcher } from './agentHub';
import {
  collectIdeContext,
  EMPTY_IDE_CONTEXT_SNAPSHOT,
  formatIdeContext,
  type IdeContextOptions,
  type IdeContextSnapshot,
} from './ideContext';

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
  readonly collectIdeContext?: (opts: IdeContextOptions) => IdeContextSnapshot;
}

/**
 * Pure helper that assembles the prompt fed to the LM. Exported for
 * unit-testing the prompt shape without needing a real VS Code editor.
 *
 * Order is deliberate:
 *
 *   1. System prompt   — operator-set persona / behaviour
 *   2. IDE context     — file the developer is looking at right now
 *   3. Message envelope + body — what the agent-hub peer actually sent
 *
 * The IDE context comes *before* the message so the LM can resolve
 * pronouns like "this bug" or "the file" against the active editor
 * even when the sender doesn't quote a path.
 */
export function formatPrompt(
  systemPrompt: string,
  msg: InboxMessage,
  ideContext: string
): string {
  const preamble = systemPrompt.trim();
  const head = preamble.length > 0 ? `${preamble}\n\n---\n\n` : '';
  const idePart = ideContext.length > 0 ? `${ideContext}\n\n---\n\n` : '';
  return (
    `${head}${idePart}You have received a direct message via agent-hub.\n\n` +
    `From: ${msg.from}\n` +
    `Message id: ${msg.id}\n` +
    `Sent at: ${msg.timestamp}\n\n` +
    `Content:\n${msg.message}`
  );
}

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
  private readonly collectIdeContext: (opts: IdeContextOptions) => IdeContextSnapshot;

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
    const client = this.requireClient();
    if (!client) {
      this.deps.log('[drain] watcher not currently subscribed — skipping');
      return;
    }
    let messages: InboxMessage[];
    try {
      messages = await client.getMessages();
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

  private async dispatchOne(msg: InboxMessage): Promise<void> {
    this.deps.log(
      `[dispatch] from=${msg.from} id=${msg.id}: ${truncate(msg.message, 80)}`
    );

    const model = await this.pickModel();
    if (!model) return; // already logged

    // Snapshot the IDE *after* model selection so the editor state is as
    // fresh as possible at the moment the LM is about to read it. Cheap
    // (synchronous read) so order has no real cost; clarity over speed.
    let ideSnapshot: IdeContextSnapshot = EMPTY_IDE_CONTEXT_SNAPSHOT;
    try {
      ideSnapshot = this.collectIdeContext(this.deps.cfg.ideContext);
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
      this.deps.log(
        `[ide-context] file=${ideSnapshot.activeFile.uri} ` +
          `lang=${ideSnapshot.activeFile.languageId} ${sel} ` +
          `diagnostics=${ideSnapshot.diagnostics.length}`
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

    // Step 5 replaces this with a real `send_message` relay. The Step 3
    // landing point is a visible LM response in the output channel so the
    // pipeline can be inspected end-to-end before reply infrastructure
    // arrives.
    this.deps.log(
      `[response] to=${msg.from} model=${model.id} msg=${msg.id}\n` +
        `--- begin response ---\n${responseText}\n--- end response ---`
    );

    await this.markRead(msg);
  }

  private requireClient(): AgentHubClient | null {
    return this.deps.watcher.client;
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
    msg: InboxMessage
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

  private async markRead(msg: InboxMessage): Promise<void> {
    const client = this.requireClient();
    if (!client) {
      this.deps.log(
        `[WARN] watcher lost session before mark_as_read msg=${msg.id} — ` +
          'message will be redelivered on the next drain'
      );
      return;
    }
    try {
      await client.markAsRead(msg.id);
      this.deps.log(`[ack] mark_as_read msg=${msg.id}`);
    } catch (err) {
      this.deps.log(
        `[WARN] mark_as_read msg=${msg.id}: ${errMsg(err)} — ` +
          'message will be redelivered on the next drain'
      );
    }
  }
}
