// Vscode-free sticky-handle helpers (issue #52 / #54).
//
// Extracted from `lmDispatcher.ts` so the update logic can be unit-tested
// with plain `node:test` / `tsx` without a VS Code extension-host shim.
//
// Keep this module vscode-free — no `import … from 'vscode'` allowed.

/**
 * Mutable reference that holds the "last active peer" handle.
 *
 * Owned by `extension.ts`; shared (by reference) with both
 * `LmDispatcher` (updated on every received DM) and
 * `registerChatParticipant` (read when no explicit `@handle` is given;
 * updated after every successful `session.send()`).
 */
export interface StickyHandleRef {
  value: string | undefined;
}

/**
 * Update `ref.value` to `sender`.
 *
 * Extracted so the mutation can be unit-tested independently of the
 * VS Code–bound `LmDispatcher`. Currently a single assignment, but
 * future filtering rules (e.g. ignore self, ignore bots) can be added
 * here without touching the vscode-bound call site.
 *
 * @returns `true` when the value actually changed; `false` when it was
 *          already equal to `sender` (useful for conditional logging).
 */
export function updateStickyHandle(ref: StickyHandleRef, sender: string): boolean {
  if (ref.value === sender) return false;
  ref.value = sender;
  return true;
}
