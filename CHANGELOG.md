# Changelog

All notable changes to `agent-hub-bridge-vscode` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0 with minor bumps treated as breaking-allowed per the spec).

## [Unreleased]

## [0.4.0] — 2026-05-19

### Added
- **Build & release pipeline** ([#16](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/16)): `@vscode/vsce` devDep + `npm run package` / `npm run package:check` scripts, `.vscodeignore`, `package-check` CI job on every push, and a tag-triggered `release.yml` that builds the `.vsix` and attaches it to a GitHub Release on `v*.*.*` tag pushes.
- **LICENSE** file (MIT) — package.json's `"license": "MIT"` claim now has substantive backing for the shipped artefact.
- **CHANGELOG.md** (this file) — Keep a Changelog format.
- **README Install section** — manual sideload instructions for the GitHub Release `.vsix`.

### Removed
- **`agentHubBridge.githubPat` setting** ([#15](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/15)) — the deprecated plaintext configuration entry first introduced in 0.1.1 as a SecretStorage migration legacy fallback. The auto-migration helper (`maybeMigratePatToSecretStorage`) was also deleted in the same PR per operator decision (no soft-handoff cycle). Users upgrading with a stale plaintext value will see VS Code's "unrecognized setting" warning and a friendly error pointing at the `agent-hub bridge: Set GitHub PAT` command. **This is a breaking change for any user still relying on the plaintext setting alone.**
- `resolvePatPrecedence` + `PatSource` type from `src/protocol.ts` (no longer needed — `SecretStorage` is the single source of truth).
- Eight `resolvePatPrecedence` unit-test assertions (67 → 59 total).

### Changed
- `resolveAuth`'s "neither PAT nor user is set" error message now points at the `Set GitHub PAT` command instead of the removed setting.
- `showStatus`'s `pat=<source>` chip simplified from `secret` / `setting` / `none` to `secret` / `none`.

## [0.3.0] — 2026-05-19

### Added
- **Multi-pane editor awareness** ([#13](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/13) / [#14](https://github.com/kishibashi3/agent-hub-bridge-vscode/pull/14)): `IdeContextSnapshot.secondaryEditors?` surfaces non-active visible text editors as header-only entries (URI + language + cursor only) so the LM can talk about "you also have foo.ts and bar.md open" in split-pane sessions. Cap defaults to 3.
- **Notebook awareness**: `IdeContextSnapshot.activeNotebook?` snapshots `vscode.window.activeNotebookEditor` (URI, notebook type, cell counts, active-cell language). Per-cell content is intentionally NOT included. Notebook-only sessions (no text editor focused) now surface the notebook block.
- `[ide-context]` log breadcrumb chips: `secondaries=N` + `notebook=<type>:<idx>/<count>`.
- 10 new unit-test assertions (`formatSecondaryEditorsBlock` 3 + `formatActiveNotebookBlock` 4 + `formatIdeContext` integration 3).

## [0.2.0] — 2026-05-19

### Added
- **Git-diff attach** ([#11](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/11) / [#12](https://github.com/kishibashi3/agent-hub-bridge-vscode/pull/12)): opt-in working-tree diff via the bundled `vscode.git` extension API. Four new config keys under `agentHubBridge.ideContext.gitDiff.*` with `enabled = false` default (privacy: diffs can carry sensitive in-flight code).
- `src/vscodeGit.d.ts` minimal local typings for the `vscode.git` extension API.
- `src/protocol.ts` re-exports `AgentHubClient` + pure helpers — no behaviour change vs 0.1.1.
- 14 new unit-test assertions (`truncateDiff` 5 + `formatGitDiffBlock` 7 + integration 2).

### Changed
- `collectIdeContext` is now `async` (git API is async). The dispatcher's collector injection slot broadened to `IdeContextSnapshot | Promise<IdeContextSnapshot>`.

### Fixed
- Addressed PR #10 reviewer Suggestions 1 + 2: `secrets.store` / `secrets.delete` failure handling (try/catch + user-facing error message), and the deprecation message for `agentHubBridge.githubPat` was updated to commit to removal in 0.3.0 (eventually shipped in 0.4.0).

## [0.1.1] — 2026-05-19

### Added
- **`SecretStorage` migration for `githubPat`** ([#9](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/9) / [#10](https://github.com/kishibashi3/agent-hub-bridge-vscode/pull/10)): two new commands `agent-hub bridge: Set GitHub PAT` and `agent-hub bridge: Clear GitHub PAT` that store the PAT via VS Code's OS-keychain-backed `SecretStorage` instead of plaintext `settings.json`. `Set GitHub PAT` validates the PAT against `https://api.github.com/user` before storing.
- Auto-migration on first `Start inbox watch` after upgrade: copies any leftover plaintext `agentHubBridge.githubPat` into secret storage with a one-time warning popup pointing at settings.json. (Removed in 0.4.0.)
- `resolvePatPrecedence` pure helper for the dual-source decision-table. (Removed in 0.4.0.)
- 8 new unit-test assertions for `resolvePatPrecedence`. (Removed in 0.4.0.)

### Deprecated
- `agentHubBridge.githubPat` setting — read as a legacy fallback when SecretStorage is empty; scheduled for removal in a future minor.

## [0.1.0] — 2026-05-19

First feature-complete release. Closes [#1](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/1).

### Added
- **VS Code extension scaffold** ([#2](https://github.com/kishibashi3/agent-hub-bridge-vscode/pull/2)): hand-written `package.json` / `tsconfig.json` / `src/extension.ts` with three command stubs (`Start inbox watch` / `Stop inbox watch` / `Show connection status`) and four configuration keys (`url` / `user` / `tenant` / `githubPat`). Declares `enabledApiProposals: ["languageModels"]` — runs on VS Code Insiders.
- **SSE inbox watch** ([#3](https://github.com/kishibashi3/agent-hub-bridge-vscode/pull/3)): long-lived MCP session subscribing to `inbox://@<user>`. TypeScript port of the `kishibashi3-plugins-claude` `watch.sh` script with three auth modes (trust / PAT / PAT+override) and exponential reconnect back-off (3s → 60s, reset on success). Redline #1 enforcement: warning popup + `[WARN]` log when `url` is left at the dev-localhost default.
- **LM bridging** ([#4](https://github.com/kishibashi3/agent-hub-bridge-vscode/pull/4)): `LmDispatcher` serial drain queue. On each inbox notification → `get_messages` MCP tool → prompt-build → `vscode.lm.sendRequest` → response stream → output channel log. Three new config keys: `systemPrompt`, `languageModel.vendor`, `languageModel.family`.
- **IDE-context auto-attach** ([#5](https://github.com/kishibashi3/agent-hub-bridge-vscode/pull/5)): snapshot active editor URI / selection (or cursor-window when no selection) / `vscode.languages.getDiagnostics` into a markdown block prepended to every LM prompt. Configurable caps via `ideContext.{maxSelectionChars, maxDiagnostics, windowLinesAroundCursor}` (each `0 = off`).
- **`send_message` reply relay** ([#6](https://github.com/kishibashi3/agent-hub-bridge-vscode/pull/6)): replaces the Step 3 `[response]` log path with a real DM relay back to the original sender. `mark_as_read` runs only on successful relay — any failure leaves the message unread for the next drain to retry.
- **CI** ([#7](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/7) / [#8](https://github.com/kishibashi3/agent-hub-bridge-vscode/pull/8)): GitHub Actions workflow (Node 22 LTS, `npm ci` → typecheck → compile → test), unit-test suite via `node:test` + `tsx` (1 new devDep, no runtime deps). Refactor: pure helpers split into `src/protocol.ts` + `src/promptFormat.ts` so they're require-able without a VS Code shim. 35 unit-test assertions.

[Unreleased]: https://github.com/kishibashi3/agent-hub-bridge-vscode/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/kishibashi3/agent-hub-bridge-vscode/releases/tag/v0.4.0
[0.3.0]: https://github.com/kishibashi3/agent-hub-bridge-vscode/releases/tag/v0.3.0
[0.2.0]: https://github.com/kishibashi3/agent-hub-bridge-vscode/releases/tag/v0.2.0
[0.1.1]: https://github.com/kishibashi3/agent-hub-bridge-vscode/releases/tag/v0.1.1
[0.1.0]: https://github.com/kishibashi3/agent-hub-bridge-vscode/releases/tag/v0.1.0
