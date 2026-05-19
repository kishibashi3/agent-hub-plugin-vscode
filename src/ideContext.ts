// IDE-context capture for Step 4 of issue #1.
//
// Two-layer split: `collectIdeContext()` snapshots VS Code editor state
// into a plain `IdeContextSnapshot`, and `formatIdeContext()` turns that
// snapshot into a markdown block embedded in the LM prompt. The split
// keeps the prompt-shape logic pure & unit-testable while the editor-
// API access stays isolated to one function the dispatcher injects.
//
// Design judgments locked in here (mentioned to @planner up front so they
// are reviewable as defaults rather than buried as constants):
//
//   - Active editor only. `vscode.window.activeTextEditor` (not visible/
//     all/notebook editors). Multi-pane and split-view support is yagni
//     until a use-case asks for it.
//   - Configurable caps everywhere — `maxSelectionChars`, `maxDiagnostics`,
//     `windowLinesAroundCursor`. Defaults below.
//   - No git diff. Out of scope for v1; would require either the
//     `vscode.git` extension API or shelling out, both of which are PR
//     of their own. Selection + diagnostics already cover the bulk of
//     "look at this code" use-cases.
//   - Cursor-window context (lines around the caret when there's no
//     selection) so the LM gets *some* code context even when the user
//     hasn't highlighted anything. Cap at +/- 20 lines by default.
//   - When `ideContext.enabled = false`, the snapshot is a zero-content
//     object — `formatIdeContext` returns the empty string and the
//     prompt looks identical to Step 3 output.

import * as vscode from 'vscode';

export interface IdeContextOptions {
  readonly enabled: boolean;
  readonly maxSelectionChars: number;
  readonly maxDiagnostics: number;
  readonly windowLinesAroundCursor: number;
}

export const DEFAULT_IDE_CONTEXT_OPTIONS: IdeContextOptions = {
  enabled: true,
  maxSelectionChars: 4000,
  maxDiagnostics: 20,
  windowLinesAroundCursor: 20,
};

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
 * Snapshot the current VS Code editor state. Synchronous read of
 * `vscode.window.activeTextEditor` + `vscode.languages.getDiagnostics`,
 * so the result is captured exactly at call time (no async surprises).
 *
 * Returns `EMPTY_IDE_CONTEXT_SNAPSHOT` when:
 *   - `opts.enabled === false`
 *   - There is no active text editor (e.g. user has focus on the output
 *     channel, settings view, or a non-text widget)
 */
export function collectIdeContext(opts: IdeContextOptions): IdeContextSnapshot {
  if (!opts.enabled) {
    return EMPTY_IDE_CONTEXT_SNAPSHOT;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return EMPTY_IDE_CONTEXT_SNAPSHOT;
  }

  const doc = editor.document;
  const selection = editor.selection;
  const cursor = selection.active;

  const activeFile: IdeActiveFile = {
    uri: doc.uri.toString(),
    languageId: doc.languageId,
    cursorLine: cursor.line + 1,
    cursorColumn: cursor.character + 1,
  };

  let sel: IdeSelection | undefined;
  let window: IdeCursorWindow | undefined;

  if (!selection.isEmpty) {
    const rawText = doc.getText(selection);
    const truncated = rawText.length > opts.maxSelectionChars;
    sel = {
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
      text: truncated ? rawText.slice(0, opts.maxSelectionChars) + '…' : rawText,
      truncated,
    };
  } else if (opts.windowLinesAroundCursor > 0) {
    const w = opts.windowLinesAroundCursor;
    const startLine = Math.max(0, cursor.line - w);
    const endLine = Math.min(doc.lineCount - 1, cursor.line + w);
    // Use Range across full line widths — VS Code clamps `Number.MAX_SAFE_INTEGER`
    // to the line's actual end column.
    const range = new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER);
    window = {
      startLine: startLine + 1,
      endLine: endLine + 1,
      text: doc.getText(range),
    };
  }

  const all = vscode.languages.getDiagnostics(doc.uri);
  // Sort by severity (0=Error, 1=Warning, 2=Info, 3=Hint) then by line so
  // truncation always drops less-severe / lower items first.
  const sorted = [...all].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity - b.severity;
    return a.range.start.line - b.range.start.line;
  });
  const capped = opts.maxDiagnostics > 0 ? sorted.slice(0, opts.maxDiagnostics) : [];
  const diagnostics: IdeDiagnostic[] = capped.map((d) => ({
    line: d.range.start.line + 1,
    severity: severityLabel(d.severity),
    source: typeof d.source === 'string' ? d.source : '',
    message: d.message,
  }));

  const snapshot: IdeContextSnapshot = {
    activeFile,
    ...(sel ? { selection: sel } : {}),
    ...(window ? { cursorWindow: window } : {}),
    diagnostics,
  };
  return snapshot;
}

/**
 * Render an `IdeContextSnapshot` as a markdown block embedded in the LM
 * prompt. Returns the empty string when the snapshot carries nothing
 * (so callers can drop the surrounding separator without an extra check).
 *
 * Pure function — exported for unit-testing the prompt shape without
 * needing a real VS Code editor.
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

  // Trim trailing whitespace — `parts.join('\n')` leaves a blank line at
  // the bottom we don't want adjacent to the prompt separator.
  return parts.join('\n').trimEnd();
}

function severityLabel(sev: vscode.DiagnosticSeverity): DiagnosticSeverityLabel {
  switch (sev) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
    default:
      // Forward compat: an unknown severity value still gets a meaningful
      // bucket rather than an empty string in the prompt.
      return 'info';
  }
}
