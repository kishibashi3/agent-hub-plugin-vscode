// IDE-context capture (vscode-bound half).
//
// The pure prompt-shaping helpers and snapshot data types live in
// `./promptFormat.ts` and are re-exported here so existing call sites
// (`import {…} from './ideContext'`) keep working unchanged. This module's
// only original content is `collectIdeContext`, which actually reads
// `vscode.window.activeTextEditor` + `vscode.languages.getDiagnostics`.
//
// Design judgments (locked in PR #5, retained verbatim):
//
//   - Active editor only. `vscode.window.activeTextEditor` (not visible/
//     all/notebook editors). Multi-pane and split-view support is yagni
//     until a use-case asks for it.
//   - Configurable caps everywhere — `maxSelectionChars`, `maxDiagnostics`,
//     `windowLinesAroundCursor`. Defaults in `./promptFormat.ts`.
//   - No git diff. Out of scope for v1; would require either the
//     `vscode.git` extension API or shelling out, both PR of their own.
//   - Cursor-window context (lines around the caret when there's no
//     selection) so the LM gets *some* code context even when the user
//     hasn't highlighted anything. Cap at +/- 20 lines by default.
//   - When `ideContext.enabled = false`, the snapshot is a zero-content
//     object — `formatIdeContext` returns the empty string and the
//     prompt looks identical to Step 3 output.
//   - PR #5 Minor (path a): `maxSelectionChars = 0` SUPPRESSES the
//     selection block entirely (no cursor-window fall-through; the two
//     caps stay orthogonal "0 = off" knobs).

import * as vscode from 'vscode';

import {
  EMPTY_IDE_CONTEXT_SNAPSHOT,
  type IdeActiveFile,
  type IdeContextOptions,
  type IdeContextSnapshot,
  type IdeCursorWindow,
  type IdeDiagnostic,
  type IdeSelection,
  type DiagnosticSeverityLabel,
} from './promptFormat';

// Re-exports for public surface compatibility.
export {
  DEFAULT_IDE_CONTEXT_OPTIONS,
  type DiagnosticSeverityLabel,
  EMPTY_IDE_CONTEXT_SNAPSHOT,
  formatIdeContext,
  type IdeActiveFile,
  type IdeContextOptions,
  type IdeContextSnapshot,
  type IdeCursorWindow,
  type IdeDiagnostic,
  type IdeSelection,
} from './promptFormat';

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

  if (!selection.isEmpty && opts.maxSelectionChars > 0) {
    const rawText = doc.getText(selection);
    const truncated = rawText.length > opts.maxSelectionChars;
    sel = {
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
      text: truncated ? rawText.slice(0, opts.maxSelectionChars) + '…' : rawText,
      truncated,
    };
  } else if (!selection.isEmpty && opts.maxSelectionChars === 0) {
    // PR #5 Minor (path a): `maxSelectionChars = 0` is a privacy switch
    // that suppresses the *selection* block — we deliberately do NOT
    // fall through to the cursor-window branch because the user has
    // a selection and asked us not to share its contents. The user can
    // independently set `windowLinesAroundCursor = 0` if they want the
    // surrounding window suppressed as well; the two caps are
    // orthogonal "0 = off" knobs matching `maxDiagnostics = 0`.
    sel = undefined;
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
