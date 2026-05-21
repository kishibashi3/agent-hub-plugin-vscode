// RelayTracker — bridges the Chat participant fire-and-await flow with
// the LmDispatcher drain pipeline (issue #32).
//
// ## Problem
//
// When a user sends `@agent-hub @reviewer hello` in Copilot Chat, the
// bridge sends a DM to @reviewer and shows "✅ Sent". When @reviewer
// replies the inbox notification fires, but `LmDispatcher` mistakenly
// treats the reply as an autonomous inbound DM and forwards it to the
// LM instead of surfacing it in the Chat panel.
//
// ## Two modes
//
// | Mode       | Trigger                                    | Handler                     |
// |------------|--------------------------------------------|-----------------------------|
// | relay      | Reply to a Chat participant–originated DM  | Forward raw body to Chat    |
// | autonomous | Any other inbound DM                       | LM → reply to sender       |
//
// ## Design
//
// `RelayTracker` is a **vscode-free** FIFO waiter map:
//
//   chatParticipant.ts calls `waitFor('@reviewer', 30_000)` immediately
//   after `session.send()`, registering a pending waiter.
//
//   LmDispatcher.dispatchOne() calls `tryResolve(msg)` before any LM work.
//   If the sender matches a pending waiter, `tryResolve` resolves the
//   promise and returns `true` (skip LM). Otherwise returns `false`.
//
// Multiple concurrent `waitFor` calls for the **same** sender are queued
// FIFO so back-to-back Chat requests are matched in order.
//
// This module is vscode-free (no `import … from 'vscode'`) so it can be
// unit-tested with plain `node:test` / `tsx` without an extension-host
// shim. Its only external dependency is the `IncomingMessage` type from
// `@kishibashi3/agent-hub-sdk`, which is also importable in plain Node.

import type { IncomingMessage } from '@kishibashi3/agent-hub-sdk';

export { type IncomingMessage };

/**
 * Thrown by `waitFor` when no matching message arrives within the
 * configured timeout. The Chat participant catches this and shows a
 * human-readable fallback instead of leaving the panel hanging.
 */
export class RelayTimeout extends Error {
  constructor(sender: string, timeoutMs: number) {
    super(`No reply from ${sender} within ${timeoutMs} ms`);
    this.name = 'RelayTimeout';
  }
}

type Resolver = (msg: IncomingMessage) => void;
type Rejector = (err: Error) => void;

interface Waiter {
  resolve: Resolver;
  reject: Rejector;
}

/**
 * FIFO waiter map for relay replies.
 *
 * Thread-safety: single-threaded JS event loop — no locks needed.
 */
export class RelayTracker {
  /** sender handle → FIFO queue of waiting resolvers */
  private readonly pending = new Map<string, Waiter[]>();

  /**
   * Wait for the next message from `sender`, up to `timeoutMs` ms.
   *
   * Resolves with the first matching `IncomingMessage`. Rejects with
   * `RelayTimeout` if no matching message arrives in time.
   *
   * If multiple callers `waitFor` the same sender concurrently, each
   * call is queued FIFO and matched to successive incoming messages.
   */
  waitFor(sender: string, timeoutMs: number): Promise<IncomingMessage> {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };

      // Add to the FIFO queue for this sender.
      const q = this.pending.get(sender);
      if (q) {
        q.push(waiter);
      } else {
        this.pending.set(sender, [waiter]);
      }

      // Arm the timeout. On fire: remove ourselves from the queue
      // (so a late-arriving message doesn't double-resolve) and reject.
      const timer = setTimeout(() => {
        const queue = this.pending.get(sender);
        if (queue) {
          const idx = queue.indexOf(waiter);
          if (idx >= 0) {
            queue.splice(idx, 1);
          }
          if (queue.length === 0) {
            this.pending.delete(sender);
          }
        }
        reject(new RelayTimeout(sender, timeoutMs));
      }, timeoutMs);

      // Wrap resolve so the timer is cleared on success.
      // We capture `waiter` before the timeout fires so there's no race:
      // the FIFO dequeue in `tryResolve` removes us from the queue, then
      // calls this wrapped resolver, which clears the timer.
      const originalResolve = waiter.resolve;
      waiter.resolve = (msg: IncomingMessage) => {
        clearTimeout(timer);
        originalResolve(msg);
      };
    });
  }

  /**
   * Attempt to satisfy the oldest pending waiter for `msg.sender`.
   *
   * Returns `true` if the message was consumed by a relay waiter (the
   * caller should ack + skip LM processing). Returns `false` if no
   * waiter exists (the caller should treat the message as autonomous).
   */
  tryResolve(msg: IncomingMessage): boolean {
    const q = this.pending.get(msg.sender);
    if (!q || q.length === 0) {
      return false;
    }
    const waiter = q.shift()!;
    if (q.length === 0) {
      this.pending.delete(msg.sender);
    }
    waiter.resolve(msg);
    return true;
  }

  /**
   * Number of pending waiters across all senders.
   * Useful for diagnostics / tests.
   */
  get size(): number {
    let n = 0;
    for (const q of this.pending.values()) {
      n += q.length;
    }
    return n;
  }
}
