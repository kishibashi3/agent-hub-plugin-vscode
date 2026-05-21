// VS Code–bound IDE context gathering (issue #48).
//
// Reads the active editor state via the VS Code API and produces an
// `IdeContext` snapshot for injection into outgoing DMs.
//
// Keep this module vscode-bound — pure formatting logic lives in the
// vscode-free `./ideContextCore.ts` for unit testability.

import * as path from 'path';
import * as vscode from 'vscode';

import type { IdeContext } from './ideContextCore';

/**
 * Controls when IDE context is appended to outgoing DMs.
 *
 * - `"selection-only"` (default): append only when the user has an active
 *   text selection. No noise for bare cursor positions.
 * - `"always"`: always append file + cursor/selection info, even when
 *   nothing is selected (shows file path + line number).
 * - `"off"`: never append IDE context.
 */
export type IdeContextMode = 'selection-only' | 'always' | 'off';

/**
 * Collect IDE context from the currently active text editor.
 *
 * Returns `null` when:
 * - `mode` is `"off"`, or
 * - no text editor is active, or
 * - `mode` is `"selection-only"` and nothing is selected.
 *
 * @param mode  Injection policy read from `agentHubBridge.ideContext`.
 */
export function gatherIdeContext(mode: IdeContextMode): IdeContext | null {
  if (mode === 'off') return null;

  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;

  const doc = editor.document;
  const sel = editor.selection;
  const hasSelection = !sel.isEmpty;

  if (mode === 'selection-only' && !hasSelection) return null;

  // Prefer workspace-relative path; fall back to absolute.
  const wsFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
  const file = wsFolder
    ? path.relative(wsFolder.uri.fsPath, doc.uri.fsPath)
    : doc.uri.fsPath;

  const startLine = sel.start.line + 1; // convert 0-based to 1-based
  const endLine = hasSelection ? sel.end.line + 1 : startLine;
  const selection = hasSelection ? doc.getText(sel) : '';

  return { file, languageId: doc.languageId, startLine, endLine, selection };
}
