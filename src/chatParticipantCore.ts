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
