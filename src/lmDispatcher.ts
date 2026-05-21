// Inbox notification sink — replaces the full LM-dispatch pipeline removed
// in issue #35. Autonomous LM dispatch (inbox → LM → send_message) is gone;
// inbound DMs are now shown as VS Code notifications and ack'd.
//
// Pipeline per inbound notification:
//   1. Inbox notification (InboxWatcher.onMessage) → requestDrain()
//   2. drainLoop serializes via a single-flight + redrain-pending flag
//   3. each drain calls session.getUnread() for ALL unread items
//   4. per message: log to output channel + VS Code notification + ack

import * as vscode from 'vscode';

import type {
  HubSession,
  IncomingMessage,
} from '@kishibashi3/agent-hub-sdk';

import type { InboxMessageNotification, InboxWatcher } from './agentHub';
import type { RelayTracker } from './relayTracker';

type Logger = (msg: string) => void;

export interface LmDispatcherDeps {
  readonly watcher: InboxWatcher;
  readonly log: Logger;
  /**
   * Optional relay tracker — when set, `notifyOne` calls `tryResolve` first.
   * If the message belongs to a pending Chat-panel waiter, it is handed off
   * there instead of being shown as a VS Code notification.
   */
  readonly relayTracker?: RelayTracker;
  /**
   * Shared sticky-handle reference (issue #50). When set, `notifyOne` writes
   * `msg.sender` here so that the Chat participant auto-addresses future
   * bare `@agent-hub` messages to the most recent DM sender.
   */
  readonly stickyHandle?: { value: string | undefined };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class LmDispatcher {
  private draining = false;
  private redrainPending = false;

  constructor(private readonly deps: LmDispatcherDeps) {}

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
    // No resources to clean up — the watcher manages its own lifecycle.
  }

  // ─── internal ────────────────────────────────────────────────────────────

  private async drainLoop(): Promise<void> {
    this.draining = true;
    try {
      do {
        this.redrainPending = false;
        await this.drainOnce();
      } while (this.redrainPending);
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
      await this.notifyOne(msg);
    }
  }

  private async notifyOne(msg: IncomingMessage): Promise<void> {
    this.deps.log(
      `[inbox] from=${msg.sender} id=${msg.id}: ${truncate(msg.body, 80)}`
    );

    // Sticky-handle update (issue #50): update on every received DM so the
    // Chat participant auto-addresses the next bare `@agent-hub` message to
    // the most recent sender. Runs before relay/notification so the handle
    // is always fresh regardless of which path handles the message.
    if (this.deps.stickyHandle) {
      this.deps.stickyHandle.value = msg.sender;
      this.deps.log(`[sticky] lastHandle \u2192 ${msg.sender}`);
    }

    // Chat-relay intercept (issue #45): if the Chat participant is awaiting a
    // reply from this sender, hand the message to the relay waiter so it
    // appears in the Chat panel instead of as a VS Code notification.
    if (this.deps.relayTracker?.tryResolve(msg)) {
      this.deps.log(`[relay] resolved Chat waiter for ${msg.sender} (msg=${msg.id})`);
      await this.markRead(msg);
      return;
    }

    void vscode.window.showInformationMessage(
      `agent-hub \u2014 ${msg.sender}: ${truncate(msg.body, 120)}`
    );
    await this.markRead(msg);
  }

  /**
   * Returns the SDK `HubSession` for the watcher's current MCP session, or
   * `null` when reconnecting / idle. Re-read per call so the dispatcher
   * naturally follows the watcher across reconnects.
   */
  private requireSession(): HubSession | null {
    return this.deps.watcher.session;
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
