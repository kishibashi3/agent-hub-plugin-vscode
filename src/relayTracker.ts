// RelayTracker — FIFO waiter map for Chat-panel reply relay (issue #45).
//
// When the @agent-hub Chat participant sends a DM, it registers a waiter
// here via waitFor(sender, timeoutMs). The inbox drain calls tryResolve(msg)
// for every inbound message; if a matching waiter exists it is resolved and
// the Chat panel shows the reply directly instead of a VS Code notification.
//
// Only one waiter per sender at a time. A second waitFor call for the same
// sender cancels the first (the Chat participant re-sends to the same handle).
//
// This module is vscode-free — it only imports from the SDK and uses plain
// TypeScript. Keep it that way so it can be unit-tested without a VS Code shim.

import type { IncomingMessage } from '@kishibashi3/agent-hub-sdk';

/** Thrown by `waitFor` when no reply arrives within the timeout window. */
export class RelayTimeout extends Error {
  constructor(
    public readonly sender: string,
    public readonly timeoutMs: number
  ) {
    super(`No reply from ${sender} within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'RelayTimeout';
  }
}

interface Waiter {
  resolve: (msg: IncomingMessage) => void;
  reject: (err: RelayTimeout) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RelayTracker {
  private readonly waiters = new Map<string, Waiter>();

  /**
   * Wait for the first message from `sender`, up to `timeoutMs` milliseconds.
   *
   * Resolves with the `IncomingMessage` when it arrives.
   * Rejects with `RelayTimeout` when the window expires.
   *
   * A second call for the same sender cancels the first waiter before
   * registering the new one (the first rejects with RelayTimeout immediately).
   */
  waitFor(sender: string, timeoutMs: number): Promise<IncomingMessage> {
    // Cancel any previous waiter for this sender.
    this._cancel(sender);

    return new Promise<IncomingMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(sender);
        reject(new RelayTimeout(sender, timeoutMs));
      }, timeoutMs);

      // Wrap resolve to clear the timer and unregister before calling through.
      const wrappedResolve = (msg: IncomingMessage): void => {
        clearTimeout(timer);
        this.waiters.delete(sender);
        resolve(msg);
      };

      this.waiters.set(sender, { resolve: wrappedResolve, reject, timer });
    });
  }

  /**
   * If a waiter is registered for `msg.sender`, resolve it and return `true`.
   * Returns `false` when no waiter matches — caller falls through to the
   * normal VS Code notification path.
   */
  tryResolve(msg: IncomingMessage): boolean {
    const waiter = this.waiters.get(msg.sender);
    if (!waiter) return false;
    waiter.resolve(msg);
    return true;
  }

  /** Cancel and remove all pending waiters — call on extension deactivate. */
  dispose(): void {
    for (const sender of [...this.waiters.keys()]) {
      this._cancel(sender);
    }
  }

  private _cancel(sender: string): void {
    const waiter = this.waiters.get(sender);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(sender);
    waiter.reject(new RelayTimeout(sender, 0));
  }
}
