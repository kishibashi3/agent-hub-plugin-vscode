// SentPeers — tracks handles that the Chat participant has sent DMs to
// (issue #32, simplified design).
//
// ## Purpose
//
// When a user sends `@agent-hub @reviewer hello` in Copilot Chat, the
// bridge DMs @reviewer via `session.send()`. If @reviewer later replies,
// `LmDispatcher` would normally treat the reply as an autonomous inbound
// DM and route it through the LM — generating an unwanted auto-response.
//
// `SentPeers` breaks that misrouting: `chatParticipant.ts` registers the
// target handle after a successful send; `LmDispatcher.dispatchOne` checks
// the registry before dispatching and, if the sender is known, acks the
// message and logs it to the Output channel instead of passing it to the LM.
//
// ## Design — intentionally minimal
//
// A plain `Set<string>` is sufficient. No timeouts, no FIFO queues, no
// Promises. The set persists for the extension's lifetime: once you DM
// @reviewer via Chat, all subsequent messages from @reviewer go to the
// Output channel rather than the LM. This is the desired behaviour — the
// user chose to talk to @reviewer directly; the LM should stay out of it.
//
// This module is vscode-free (no `import … from 'vscode'`) so it can be
// unit-tested with plain `node:test` / `tsx` without an extension-host shim.

/**
 * Registry of agent handles that the Chat participant has sent DMs to.
 *
 * `LmDispatcher` checks this set before dispatching an inbound message to
 * the LM. If `has(sender)` returns `true`, the dispatcher skips LM
 * processing (ack + output-channel log only) so the reply is not treated
 * as an autonomous inbound DM.
 */
export class SentPeers {
  private readonly handles = new Set<string>();

  /**
   * Register `handle` as a known DM target.
   * Idempotent — calling `add` twice for the same handle is a no-op.
   */
  add(handle: string): void {
    this.handles.add(handle);
  }

  /**
   * Returns `true` when `handle` is a registered DM target whose replies
   * should bypass the LM.
   */
  has(handle: string): boolean {
    return this.handles.has(handle);
  }

  /**
   * Remove a handle from the registry (e.g. if the user explicitly ends
   * the relay relationship). Not currently called by production code but
   * provided for completeness and testability.
   */
  delete(handle: string): void {
    this.handles.delete(handle);
  }

  /** Remove all registered handles. */
  clear(): void {
    this.handles.clear();
  }

  /** Number of registered handles. Useful for diagnostics / tests. */
  get size(): number {
    return this.handles.size;
  }
}
