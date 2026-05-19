// Minimal local typings for the bundled `vscode.git` extension's exported
// API. Upstream definition (the source of truth):
//   https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
//
// `@types/vscode` does not ship git types — the extension exposes its API
// via `vscode.extensions.getExtension('vscode.git')` instead of a typed
// module. We declare only the surface used by `agent-hub-bridge-vscode`
// (issue #11 git-diff attach) so a future shape change upstream surfaces
// as a type error here rather than failing silently at runtime.

import type { Uri } from 'vscode';

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

export interface GitAPI {
  readonly repositories: readonly Repository[];
  getRepository(uri: Uri): Repository | null;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  /** Returns the unified-diff body for `path` against HEAD (working-tree side). */
  diffWithHEAD(path: string): Promise<string>;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly workingTreeChanges: readonly Change[];
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
}

export interface Change {
  readonly uri: Uri;
  /**
   * Numeric value of the upstream `Status` enum. We don't redeclare the
   * enum here (a `.d.ts` cannot export runtime values); see
   * `GIT_STATUS_*` constants in `./ideContext.ts` for the names we
   * actually compare against.
   */
  readonly status: number;
}
