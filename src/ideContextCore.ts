// Vscode-free IDE context helpers (issue #48).
//
// Contains pure functions that format IDE context for injection into
// outgoing DMs. Kept vscode-free so they can be unit-tested with plain
// `node:test` / `tsx` without a VS Code extension-host shim.
//
// The vscode-bound gathering logic lives in `./ideContext.ts`.

/**
 * Snapshot of the active editor state at DM send time.
 * Collected by `gatherIdeContext()` in `./ideContext.ts`.
 */
export interface IdeContext {
  /** Workspace-relative path (or absolute if outside workspace). */
  file: string;
  /** VS Code language identifier (e.g. "typescript", "python"). */
  languageId: string;
  /** 1-based line number of the selection start (or cursor line). */
  startLine: number;
  /** 1-based line number of the selection end (equals `startLine` when nothing is selected). */
  endLine: number;
  /** Selected text, or `""` when nothing is selected. */
  selection: string;
}

/**
 * Format an `IdeContext` snapshot as a markdown snippet suitable for
 * appending to a DM body.
 *
 * - With selection: file header + fenced code block containing the text.
 * - Without selection: file header + cursor line only (no code block).
 *
 * @example
 * // selection present
 * "📎 **src/foo.ts** L12–18\n```typescript\nconst x = 1;\n```"
 *
 * @example
 * // no selection (cursor at L5)
 * "📎 **src/foo.ts** L5"
 */
export function formatIdeContext(ctx: IdeContext): string {
  const loc =
    ctx.startLine === ctx.endLine
      ? `L${ctx.startLine}`
      : `L${ctx.startLine}–${ctx.endLine}`;
  const header = `📎 **${ctx.file}** ${loc}`;
  if (!ctx.selection) return header;
  return `${header}\n\`\`\`${ctx.languageId}\n${ctx.selection}\n\`\`\``;
}

/**
 * Append formatted IDE context to a DM body, separated by a horizontal rule.
 * Returns `body` unchanged when `ctx` is `null`.
 *
 * @param body  The original DM body text.
 * @param ctx   IDE context snapshot, or `null` to skip injection.
 */
export function appendIdeContext(body: string, ctx: IdeContext | null): string {
  if (!ctx) return body;
  return `${body}\n\n---\n${formatIdeContext(ctx)}`;
}
