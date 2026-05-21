// Vscode-free core for the Copilot Chat participant (issue #28).
//
// Contains only pure helpers that can be unit-tested with plain
// `node:test` / `tsx` without a VS Code extension-host shim.
//
// The vscode-bound half (`registerChatParticipant`) lives in
// `./chatParticipant.ts` and re-exports `parsePrompt` from here so
// existing `import { parsePrompt } from './chatParticipant'` call sites
// keep working.

/**
 * Parse `@<handle> <body>` from a Copilot Chat prompt string.
 *
 * VS Code strips the leading `@agent-hub` prefix before invoking the
 * participant handler, so the prompt passed here starts with the
 * recipient handle (if the user provided one).
 *
 * Returns `{ to, body }` when the prompt starts with `@handle` followed
 * by at least one whitespace character and a non-empty body.
 * Returns `null` for bare messages with no leading `@handle`, an
 * `@handle`-only string, or an empty/whitespace-only string.
 *
 * Exported from both this module and `./chatParticipant` (re-export) so
 * the test suite can import directly from the vscode-free source.
 */
export function parsePrompt(prompt: string): { to: string; body: string } | null {
  // Match a leading @word (handle) followed by whitespace and a body.
  // The handle may include any non-whitespace char after @.
  const match = prompt.trim().match(/^(@\S+)\s+([\s\S]+)$/);
  if (!match) return null;
  // match[1] = "@planner", match[2] = "今日のタスクは？ …"
  const body = (match[2] as string).trim();
  if (!body) return null;
  return { to: match[1] as string, body };
}

/**
 * Extract a leading `@handle` (and optional trailing body) from a prompt.
 *
 * Unlike `parsePrompt`, the body is allowed to be absent.
 * Used by the Chat-panel participant picker (issue #47): when the user
 * types `@agent-hub @reviewer` (handle present, body absent) we can skip
 * the participant QuickPick and jump straight to the InputBox for the body.
 *
 * Returns `{ handle, body }` when the prompt starts with `@word`.
 * `body` is the trimmed text after the handle (may be empty string `""`).
 * Returns `null` when the prompt is empty or does not start with `@word`.
 *
 * Exported for unit testing in `tests/chatParticipantCore.test.ts`.
 */
export function parseHandle(prompt: string): { handle: string; body: string } | null {
  // Match an optional @word followed by optional trailing text.
  const match = prompt.trim().match(/^(@\S+)(?:\s+([\s\S]+))?$/);
  if (!match) return null;
  return {
    handle: match[1] as string,
    body: (match[2] ?? '').trim(),
  };
}

/**
 * The literal trigger string the user types to open the participant picker.
 *
 * Typing `@agent-hub @@` (where VS Code strips the `@agent-hub` prefix) causes
 * `request.prompt` to equal `"@@"`. Using a two-`@` prefix avoids interference
 * with VS Code's own `@` participant selector (issue #50).
 */
export const PICKER_TRIGGER = '@@';

/**
 * Returns `true` when the prompt is the `@@` participant-picker trigger.
 *
 * Matches both the bare trigger (`@@`) and a trigger with an optional pre-filled
 * body (`@@ <body>`), allowing `@agent-hub @@ hello` to open the picker with
 * the body "hello" already set.
 *
 * Checked before `parsePrompt` / `parseHandle` so `@@` is never mistaken for
 * a real `@`-handle.
 */
export function isPickerTrigger(prompt: string): boolean {
  const t = prompt.trim();
  return t === PICKER_TRIGGER || t.startsWith(PICKER_TRIGGER + ' ');
}

/**
 * Extract the body text that follows the `@@` trigger, if any.
 * Returns an empty string when no body is present.
 */
export function extractPickerBody(prompt: string): string {
  return prompt.trim().slice(PICKER_TRIGGER.length).trim();
}
