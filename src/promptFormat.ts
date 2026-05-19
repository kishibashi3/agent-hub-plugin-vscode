// Vscode-free prompt-shaping helpers.
//
// `formatPrompt` (the LM prompt envelope) and `formatIdeContext` (the IDE
// snapshot → markdown block) plus the snapshot data types live here so a
// plain Node test runner can verify their output without a VS Code shim.
//
// `collectIdeContext` (which actually reads `vscode.window.activeTextEditor`
// + `vscode.languages.getDiagnostics`) stays in `./ideContext.ts` — it's
// the vscode-bound half of the split.
//
// Public surface compatibility: `./lmDispatcher.ts` and `./ideContext.ts`
// re-export the relevant pieces so existing call sites keep working.

import type { InboxMessage } from './protocol';

export interface IdeContextOptions {
  readonly enabled: boolean;
  readonly maxSelectionChars: number;
  readonly maxDiagnostics: number;
  readonly windowLinesAroundCursor: number;
}

// Frozen for `EMPTY_IDE_CONTEXT_SNAPSHOT` parity (PR #5 Suggestion 2) — a
// caller that accidentally mutates `DEFAULT_IDE_CONTEXT_OPTIONS.enabled = false`
// would otherwise quietly disable context for everyone else sharing the
// reference.
export const DEFAULT_IDE_CONTEXT_OPTIONS: IdeContextOptions = Object.freeze({
  enabled: true,
  maxSelectionChars: 4000,
  maxDiagnostics: 20,
  windowLinesAroundCursor: 20,
});

export type DiagnosticSeverityLabel = 'error' | 'warning' | 'info' | 'hint';

export interface IdeDiagnostic {
  readonly line: number; // 1-indexed
  readonly severity: DiagnosticSeverityLabel;
  readonly source: string; // empty string when unknown
  readonly message: string;
}

export interface IdeActiveFile {
  readonly uri: string;
  readonly languageId: string;
  /** 1-indexed cursor position. */
  readonly cursorLine: number;
  readonly cursorColumn: number;
}

export interface IdeSelection {
  /** 1-indexed inclusive line range. */
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly truncated: boolean;
}

export interface IdeCursorWindow {
  /** 1-indexed inclusive line range. */
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface IdeContextSnapshot {
  readonly activeFile?: IdeActiveFile;
  readonly selection?: IdeSelection;
  readonly cursorWindow?: IdeCursorWindow;
  readonly diagnostics: readonly IdeDiagnostic[];
}

/** Sentinel snapshot returned when context is disabled or no editor is focused. */
export const EMPTY_IDE_CONTEXT_SNAPSHOT: IdeContextSnapshot = Object.freeze({
  diagnostics: Object.freeze([]),
});

/**
 * Render an `IdeContextSnapshot` as a markdown block embedded in the LM
 * prompt. Returns the empty string when the snapshot carries nothing
 * (so callers can drop the surrounding separator without an extra check).
 *
 * Pure function — exported for unit-testing.
 */
export function formatIdeContext(snapshot: IdeContextSnapshot): string {
  const parts: string[] = [];

  if (snapshot.activeFile) {
    parts.push('## IDE context');
    parts.push('');
    parts.push(
      `Active file: \`${snapshot.activeFile.uri}\` (${snapshot.activeFile.languageId})`
    );
    parts.push(
      `Cursor: line ${snapshot.activeFile.cursorLine}, column ${snapshot.activeFile.cursorColumn}`
    );
    parts.push('');
  }

  if (snapshot.selection) {
    const range = `lines ${snapshot.selection.startLine}-${snapshot.selection.endLine}`;
    const suffix = snapshot.selection.truncated ? ', truncated' : '';
    parts.push(`### Selection (${range}${suffix})`);
    parts.push('```');
    parts.push(snapshot.selection.text);
    parts.push('```');
    parts.push('');
  } else if (snapshot.cursorWindow) {
    parts.push(
      `### Window around cursor (lines ${snapshot.cursorWindow.startLine}-${snapshot.cursorWindow.endLine})`
    );
    parts.push('```');
    parts.push(snapshot.cursorWindow.text);
    parts.push('```');
    parts.push('');
  }

  if (snapshot.diagnostics.length > 0) {
    parts.push(`### Diagnostics (${snapshot.diagnostics.length} item(s))`);
    for (const d of snapshot.diagnostics) {
      const src = d.source.length > 0 ? `[${d.source}] ` : '';
      parts.push(`- line ${d.line} ${d.severity}: ${src}${d.message}`);
    }
    parts.push('');
  }

  return parts.join('\n').trimEnd();
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
