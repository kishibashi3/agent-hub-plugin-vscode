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

import type { IncomingMessage } from '@kishibashi3/agent-hub-sdk';

export interface IdeMultiEditorOptions {
  /**
   * Cap on the number of *secondary* (non-active visible) text editors
   * surfaced as header-only entries. `0` suppresses the section entirely
   * AND short-circuits enumeration in the collector. Default `3` —
   * enough for a typical two- or three-split layout without blowing
   * the prompt budget.
   */
  readonly maxSecondaryEditors: number;
}

export interface IdeNotebookOptions {
  /**
   * Whether to snapshot `vscode.window.activeNotebookEditor` at all.
   * Default `true` (symmetric with `ideContext.enabled`); per-cell
   * content is never included regardless — see issue #13 out-of-scope.
   */
  readonly enabled: boolean;
}

export interface IdeGitDiffOptions {
  /**
   * Opt-in. Diffs can carry sensitive working-tree state, so we require
   * an explicit user choice per workspace — unlike the rest of
   * `IdeContextOptions` (`enabled = true` by default).
   */
  readonly enabled: boolean;
  /** Cap on number of files included in the prompt. `0` suppresses all file diffs. */
  readonly maxFiles: number;
  /** Per-file diff truncation. `0` suppresses per-file diff bodies (path + status only). */
  readonly maxCharsPerFile: number;
  /** Whether `?? untracked.txt` entries appear. */
  readonly includeUntracked: boolean;
}

export interface IdeContextOptions {
  readonly enabled: boolean;
  readonly maxSelectionChars: number;
  readonly maxDiagnostics: number;
  readonly windowLinesAroundCursor: number;
  readonly gitDiff: IdeGitDiffOptions;
  readonly multiEditor: IdeMultiEditorOptions;
  readonly notebook: IdeNotebookOptions;
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
  gitDiff: Object.freeze({
    enabled: false, // intentional: opt-in vs. the rest of the snapshot
    maxFiles: 5,
    maxCharsPerFile: 1500,
    includeUntracked: false,
  }),
  multiEditor: Object.freeze({
    maxSecondaryEditors: 3,
  }),
  notebook: Object.freeze({
    enabled: true,
  }),
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

export type IdeGitChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'
  | 'other';

export interface IdeGitChange {
  /** Workspace-relative path, forward-slashed. */
  readonly path: string;
  readonly status: IdeGitChangeStatus;
  /** Unified-diff body, truncated per `maxCharsPerFile`. Empty when bodies are suppressed (`maxCharsPerFile = 0`) or when the diff fetch failed. */
  readonly diff: string;
  readonly diffTruncated: boolean;
}

export interface IdeGitDiff {
  /** Workspace-relative repo path (empty string when the repo IS the workspace root). */
  readonly repoPath: string;
  /** `Branch.name` from `vscode.git`. Empty string when detached / unknown. */
  readonly branchName: string;
  readonly changes: readonly IdeGitChange[];
  /** Number of files hidden by `maxFiles`. */
  readonly truncatedFileCount: number;
}

export interface IdeSecondaryEditor {
  /** Stringified URI of a *non-active* visible text editor. */
  readonly uri: string;
  readonly languageId: string;
  /** 1-indexed cursor position. */
  readonly cursorLine: number;
  readonly cursorColumn: number;
}

export interface IdeActiveNotebook {
  /** Stringified URI of the active notebook. */
  readonly uri: string;
  /** e.g. `"jupyter-notebook"` (`NotebookDocument.notebookType`). */
  readonly notebookType: string;
  /** 0-indexed; `-1` when there is no resolved active cell. */
  readonly activeCellIndex: number;
  readonly cellCount: number;
  /** Empty string when there is no active cell. */
  readonly activeCellLanguageId: string;
}

export interface IdeContextSnapshot {
  readonly activeFile?: IdeActiveFile;
  readonly selection?: IdeSelection;
  readonly cursorWindow?: IdeCursorWindow;
  readonly diagnostics: readonly IdeDiagnostic[];
  readonly gitDiff?: IdeGitDiff;
  readonly secondaryEditors?: readonly IdeSecondaryEditor[];
  readonly activeNotebook?: IdeActiveNotebook;
}

/** Sentinel snapshot returned when context is disabled or no editor is focused. */
export const EMPTY_IDE_CONTEXT_SNAPSHOT: IdeContextSnapshot = Object.freeze({
  diagnostics: Object.freeze([]),
});

/**
 * Truncate a unified-diff body to at most `maxChars` characters, marking
 * whether truncation happened. Pure function — exported for unit-testing.
 *
 * Behaviour pinned by tests:
 *   - `maxChars = 0` returns `{ text: '', truncated: input.length > 0 }`
 *     so callers can render "diff body suppressed (1500 chars omitted)"
 *     without re-checking the cap.
 *   - Truncation slices at the character boundary (UTF-16 code units),
 *     matching what `String#length` reports. UTF-32 codepoint splitting
 *     isn't worth the complexity for a diff renderer aimed at an LM.
 *   - The trailing newline (if any) is preserved when not truncated so
 *     fenced code blocks render cleanly.
 */
export function truncateDiff(
  diff: string,
  maxChars: number
): { readonly text: string; readonly truncated: boolean } {
  if (maxChars <= 0) {
    return { text: '', truncated: diff.length > 0 };
  }
  if (diff.length <= maxChars) {
    return { text: diff, truncated: false };
  }
  return { text: diff.slice(0, maxChars), truncated: true };
}

/**
 * Render an `IdeGitDiff` snapshot as a markdown block. Returns the empty
 * string when there's nothing to render (no changes AND no truncated
 * count), so `formatIdeContext` can drop the section cleanly. Pure
 * function — exported for unit-testing.
 *
 * `maxCharsPerFile = 0` means "names + status only, no diff body" — the
 * fenced block per file collapses to a one-liner annotation.
 */
export function formatGitDiffBlock(diff: IdeGitDiff, maxCharsPerFile: number): string {
  if (diff.changes.length === 0 && diff.truncatedFileCount === 0) {
    return '';
  }

  const headerParts: string[] = [];
  if (diff.branchName.length > 0) {
    headerParts.push(`branch=${diff.branchName}`);
  }
  if (diff.repoPath.length > 0) {
    headerParts.push(`repo=${diff.repoPath}`);
  }
  headerParts.push(`${diff.changes.length} file(s)`);
  if (diff.truncatedFileCount > 0) {
    headerParts.push(`+ ${diff.truncatedFileCount} more truncated`);
  }
  const header = `### Git diff (working tree, ${headerParts.join(', ')})`;

  const lines: string[] = [header, ''];

  for (const change of diff.changes) {
    lines.push(`#### \`${change.path}\` — ${change.status}`);
    if (maxCharsPerFile <= 0 || change.diff.length === 0) {
      lines.push('_diff body suppressed_');
    } else {
      lines.push('```diff');
      lines.push(change.diff);
      if (change.diffTruncated) {
        lines.push('… (truncated)');
      }
      lines.push('```');
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Render a list of secondary (non-active) visible text editors as a
 * compact markdown block. Header-only by design — no selection / window
 * / diagnostics surface here, so the per-secondary cost stays bounded.
 *
 * Returns the empty string for empty input so the caller can drop the
 * surrounding separator without an extra check.
 *
 * Pure function — exported for unit-testing.
 */
export function formatSecondaryEditorsBlock(
  editors: readonly IdeSecondaryEditor[]
): string {
  if (editors.length === 0) return '';
  const lines: string[] = [`### Other visible editors (${editors.length})`];
  for (const e of editors) {
    lines.push(`- \`${e.uri}\` (${e.languageId}) — line ${e.cursorLine}, col ${e.cursorColumn}`);
  }
  return lines.join('\n');
}

/**
 * Render the active notebook header — URI, type, cell position, active
 * cell's language. Per-cell content is intentionally NOT included
 * (see issue #13 out-of-scope discussion).
 *
 * Returns the empty string when `notebook` is `undefined` so the caller
 * can drop the surrounding separator without an extra check.
 *
 * Pure function — exported for unit-testing.
 */
export function formatActiveNotebookBlock(notebook: IdeActiveNotebook | undefined): string {
  if (!notebook) return '';
  const lines: string[] = ['### Active notebook'];
  lines.push('');
  lines.push(`URI: \`${notebook.uri}\``);
  lines.push(`Type: ${notebook.notebookType}`);
  if (notebook.cellCount === 0) {
    lines.push('(empty notebook — 0 cells)');
  } else if (notebook.activeCellIndex < 0) {
    lines.push(`${notebook.cellCount} cell(s); no active cell.`);
  } else {
    // Display cells as 1-indexed for human-friendliness in the prompt
    // (matches how Jupyter UIs talk about "cell 3 of 12").
    const displayIndex = notebook.activeCellIndex + 1;
    const lang =
      notebook.activeCellLanguageId.length > 0
        ? ` (${notebook.activeCellLanguageId})`
        : '';
    lines.push(
      `Active cell: ${displayIndex} of ${notebook.cellCount}${lang}.`
    );
  }
  return lines.join('\n').trimEnd();
}

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

  if (snapshot.gitDiff) {
    // `formatGitDiffBlock` returns its own internal trim, so we treat it
    // as an opaque chunk. The per-file max here is implied by the diff
    // bodies already having been truncated by `collectGitDiff`; we pass
    // `Number.MAX_SAFE_INTEGER` to avoid re-truncating inside the
    // formatter (which would mis-classify already-truncated bodies).
    const gitBlock = formatGitDiffBlock(snapshot.gitDiff, Number.MAX_SAFE_INTEGER);
    if (gitBlock.length > 0) {
      parts.push(gitBlock);
      parts.push('');
    }
  }

  if (snapshot.secondaryEditors && snapshot.secondaryEditors.length > 0) {
    const block = formatSecondaryEditorsBlock(snapshot.secondaryEditors);
    if (block.length > 0) {
      parts.push(block);
      parts.push('');
    }
  }

  if (snapshot.activeNotebook) {
    const block = formatActiveNotebookBlock(snapshot.activeNotebook);
    if (block.length > 0) {
      parts.push(block);
      parts.push('');
    }
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
  msg: IncomingMessage,
  ideContext: string
): string {
  const preamble = systemPrompt.trim();
  const head = preamble.length > 0 ? `${preamble}\n\n---\n\n` : '';
  const idePart = ideContext.length > 0 ? `${ideContext}\n\n---\n\n` : '';
  return (
    `${head}${idePart}You have received a direct message via agent-hub.\n\n` +
    `From: ${msg.sender}\n` +
    `Message id: ${msg.id}\n` +
    `Sent at: ${msg.timestamp}\n\n` +
    `Content:\n${msg.body}`
  );
}
