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
  type IdeGitChange,
  type IdeGitChangeStatus,
  type IdeGitDiff,
  type IdeGitDiffOptions,
  type IdeSelection,
  type DiagnosticSeverityLabel,
  truncateDiff,
} from './promptFormat';
import type { GitAPI, GitExtension, Repository } from './vscodeGit';

// Re-exports for public surface compatibility.
export {
  DEFAULT_IDE_CONTEXT_OPTIONS,
  type DiagnosticSeverityLabel,
  EMPTY_IDE_CONTEXT_SNAPSHOT,
  formatGitDiffBlock,
  formatIdeContext,
  type IdeActiveFile,
  type IdeContextOptions,
  type IdeContextSnapshot,
  type IdeCursorWindow,
  type IdeDiagnostic,
  type IdeGitChange,
  type IdeGitChangeStatus,
  type IdeGitDiff,
  type IdeGitDiffOptions,
  type IdeSelection,
  truncateDiff,
} from './promptFormat';

// ---------------------------------------------------------------------------
// Working-tree subset of the upstream `vscode.git` `Status` enum. Mirrored
// here as numeric constants because `.d.ts` files can't export runtime
// values (see `./vscodeGit.d.ts` for the type-only API surface).
//
// Upstream source: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
// Keep in sync if the enum ever shifts.
// ---------------------------------------------------------------------------
const GIT_STATUS_INDEX_RENAMED = 3;
const GIT_STATUS_MODIFIED = 5;
const GIT_STATUS_DELETED = 6;
const GIT_STATUS_UNTRACKED = 7;
const GIT_STATUS_IGNORED = 8;
const GIT_STATUS_INTENT_TO_ADD = 9;
const GIT_STATUS_TYPE_CHANGED = 11;
const GIT_STATUS_ADDED_BY_US = 12;
const GIT_STATUS_ADDED_BY_THEM = 13;
const GIT_STATUS_DELETED_BY_US = 14;
const GIT_STATUS_DELETED_BY_THEM = 15;
const GIT_STATUS_BOTH_ADDED = 16;
const GIT_STATUS_BOTH_DELETED = 17;
const GIT_STATUS_BOTH_MODIFIED = 18;

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
export async function collectIdeContext(opts: IdeContextOptions): Promise<IdeContextSnapshot> {
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

  const gitDiff = opts.gitDiff.enabled
    ? await collectGitDiff(doc.uri, opts.gitDiff)
    : undefined;

  const snapshot: IdeContextSnapshot = {
    activeFile,
    ...(sel ? { selection: sel } : {}),
    ...(window ? { cursorWindow: window } : {}),
    diagnostics,
    ...(gitDiff ? { gitDiff } : {}),
  };
  return snapshot;
}

/**
 * Best-effort working-tree diff snapshot for the repo owning `docUri`.
 * Returns `undefined` when:
 *   - The `vscode.git` extension is missing / disabled
 *   - The doc isn't tracked by any repo
 *   - Any unexpected throw from the git API
 *
 * Errors are swallowed (with a debug-grade no-op) because a snapshot
 * collector must never break the dispatch pipeline — the dispatcher's
 * `[ide-context]` log line still fires either way, and the LM just sees
 * the snapshot without a `gitDiff` section.
 */
async function collectGitDiff(
  docUri: vscode.Uri,
  opts: IdeGitDiffOptions
): Promise<IdeGitDiff | undefined> {
  let repo: Repository | null;
  let api: GitAPI;
  try {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext?.exports?.enabled) {
      return undefined;
    }
    api = ext.exports.getAPI(1);
    repo = api.getRepository(docUri);
  } catch {
    return undefined;
  }
  if (!repo) return undefined;

  const branchName = repo.state.HEAD?.name ?? '';
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(repo.rootUri);
  const repoPath = workspaceFolder
    ? vscode.workspace.asRelativePath(repo.rootUri, false)
    : repo.rootUri.fsPath;
  const repoPathRelative = repoPath === '.' ? '' : repoPath;

  // Filter by `includeUntracked` + ignored, sort, cap.
  const raw = repo.state.workingTreeChanges.filter((c) => {
    if (c.status === GIT_STATUS_IGNORED) return false;
    if (c.status === GIT_STATUS_UNTRACKED && !opts.includeUntracked) return false;
    return true;
  });
  const sorted = [...raw].sort((a, b) => {
    const sa = sortKeyForStatus(a.status);
    const sb = sortKeyForStatus(b.status);
    if (sa !== sb) return sa - sb;
    return a.uri.fsPath.localeCompare(b.uri.fsPath);
  });
  const surviving = opts.maxFiles > 0 ? sorted.slice(0, opts.maxFiles) : [];
  const truncatedFileCount = sorted.length - surviving.length;

  const changes: IdeGitChange[] = [];
  for (const change of surviving) {
    const status = toIdeChangeStatus(change.status);
    const relativePath = workspaceFolder
      ? vscode.workspace.asRelativePath(change.uri, false)
      : change.uri.fsPath;

    let diffBody = '';
    let diffTruncated = false;
    if (opts.maxCharsPerFile > 0) {
      try {
        const raw = await repo.diffWithHEAD(change.uri.fsPath);
        const truncated = truncateDiff(raw, opts.maxCharsPerFile);
        diffBody = truncated.text;
        diffTruncated = truncated.truncated;
      } catch {
        // Untracked / deleted files can throw on diffWithHEAD; surface as
        // an empty body so the LM still sees the path + status, just
        // without a diff hunk.
        diffBody = '';
        diffTruncated = false;
      }
    }

    changes.push({
      path: relativePath,
      status,
      diff: diffBody,
      diffTruncated,
    });
  }

  return {
    repoPath: repoPathRelative,
    branchName,
    changes,
    truncatedFileCount,
  };
}

/**
 * Sort key for working-tree changes — lower comes first in the prompt.
 * Order: modified → added → deleted → renamed → conflicted → untracked → other.
 */
function sortKeyForStatus(status: number): number {
  const mapped = toIdeChangeStatus(status);
  switch (mapped) {
    case 'modified':
      return 0;
    case 'added':
      return 1;
    case 'deleted':
      return 2;
    case 'renamed':
      return 3;
    case 'conflicted':
      return 4;
    case 'untracked':
      return 5;
    case 'other':
      return 6;
  }
}

function toIdeChangeStatus(status: number): IdeGitChangeStatus {
  switch (status) {
    case GIT_STATUS_MODIFIED:
    case GIT_STATUS_TYPE_CHANGED:
      return 'modified';
    case GIT_STATUS_INTENT_TO_ADD:
      return 'added';
    case GIT_STATUS_DELETED:
      return 'deleted';
    case GIT_STATUS_INDEX_RENAMED:
      return 'renamed';
    case GIT_STATUS_UNTRACKED:
      return 'untracked';
    case GIT_STATUS_ADDED_BY_US:
    case GIT_STATUS_ADDED_BY_THEM:
    case GIT_STATUS_DELETED_BY_US:
    case GIT_STATUS_DELETED_BY_THEM:
    case GIT_STATUS_BOTH_ADDED:
    case GIT_STATUS_BOTH_DELETED:
    case GIT_STATUS_BOTH_MODIFIED:
      return 'conflicted';
    default:
      return 'other';
  }
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
