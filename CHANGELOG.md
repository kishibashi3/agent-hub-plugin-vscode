# Changelog

All notable changes to `agent-hub-bridge-vscode` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0 with minor bumps treated as breaking-allowed per the spec).

## [Unreleased]

## [0.13.0] — 2026-05-22

### Added
- **Copilot MCP participant ([#53](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/53))** — the extension now registers the agent-hub MCP endpoint with VS Code 1.99+ so Copilot (and other MCP clients) can call agent-hub tools (`send_message`, `get_participants`, `get_messages`, …) directly via natural-language requests without routing through the Chat participant handler.
- `src/agentHubMcpProvider.ts` — `AgentHubMcpProvider` implements `McpServerDefinitionProvider<McpHttpServerDefinition>`. `provideMcpServerDefinitions` returns the configured URL; `resolveMcpServerDefinition` injects auth headers (PAT → `Authorization: Bearer`, trust mode → `X-Forwarded-User`, tenant → `X-Tenant-Id`). Fires `onDidChangeMcpServerDefinitions` on config / secret changes.
- `contributes.mcpServerDefinitionProviders` declared in `package.json` (id: `"agent-hub"`).

### Changed
- Minimum VS Code engine bumped to `^1.99.0` (required for `McpHttpServerDefinition` / `registerMcpServerDefinitionProvider` API).
- `src/extension.ts` — registers `AgentHubMcpProvider` in `activate()` alongside the existing Chat participant and SSE inbox watch (both paths remain fully functional).

## [0.12.0] — 2026-05-22

### Added
- **IDE context injection into relay DMs ([#48](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/48))** — when sending a DM via `@agent-hub`, the active editor's file path and selection (or cursor position) are automatically appended to the DM body, so peers can see the code context immediately.
- `agentHubBridge.ideContext` setting — controls injection policy: `"selection-only"` (default, appends only when text is selected), `"always"` (always append file + cursor info), `"off"` (disable).
- `src/ideContextCore.ts` — vscode-free `IdeContext` interface, `formatIdeContext()`, and `appendIdeContext()` helpers. Added to ESLint vscode-free rule.
- `src/ideContext.ts` — vscode-bound `gatherIdeContext(mode)` that reads `vscode.window.activeTextEditor`.
- `tests/ideContextCore.test.ts` — 11 unit tests for `formatIdeContext` and `appendIdeContext`.
- Chat panel confirmation now shows `_(+ 📎 file.ts L10)_` when context is injected.

## [0.11.1] — 2026-05-22

### Changed
- **Extract sticky-handle update to vscode-free helper ([#52](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/52) / [#54](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/54))** — `stickyHandle.value = msg.sender` in `lmDispatcher.ts` is now delegated to `updateStickyHandle()` in the new `src/stickyHandle.ts` module, enabling unit testing without a VS Code shim. Returns `true`/`false` to suppress redundant log entries.
- `src/extension.ts` — `stickyHandle` typed as `StickyHandleRef` (imported from `./stickyHandle`).
- `eslint.config.mjs` — `src/stickyHandle.ts` added to the vscode-free `no-restricted-imports` rule.

### Added
- `src/stickyHandle.ts` — vscode-free `StickyHandleRef` interface and `updateStickyHandle(ref, sender)` helper.
- `tests/stickyHandle.test.ts` — 5 unit tests for `updateStickyHandle`.

## [0.11.0] — 2026-05-22

### Added
- **Default handle setting + sticky reply mode ([#50](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/50))** — recipient resolution priority is now: explicit `@handle` → sticky handle → `agentHubBridge.defaultHandle` setting → usage message.
- **`@@` participant picker trigger** — type `@agent-hub @@` to open the QuickPick participant list. Using `@@` avoids VS Code's own `@` participant selector intercepting the input. Optionally pre-fill the body: `@agent-hub @@ hello`.
- `agentHubBridge.defaultHandle` configuration key — set a default DM recipient; bare `@agent-hub` resolves silently without the picker.
- Sticky handle now also updates on every received DM (not just on send).
- `isPickerTrigger` / `extractPickerBody` / `PICKER_TRIGGER` helpers in `src/chatParticipantCore.ts` (vscode-free, unit tested).
- 10 new unit tests for `isPickerTrigger` and `extractPickerBody`.

### Changed
- `src/lmDispatcher.ts` — `LmDispatcherDeps` gains `stickyHandle?: { value: string | undefined }`; `notifyOne()` writes `msg.sender` to it before relay/notification dispatch.
- `src/chatParticipant.ts` — `registerChatParticipant` gains a `stickyHandle` parameter. Handler dispatch order: `@@` picker trigger → explicit `@handle` → sticky → defaultHandle → usage. QuickPick no longer appears on bare `@agent-hub`.
- `src/extension.ts` — module-level `stickyHandle` ref threaded into both `LmDispatcher` and `registerChatParticipant`.

## [0.10.0] — 2026-05-22

### Added
- **Participant picker + sticky handle ([#47](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/47))** — when `@agent-hub` is invoked without an explicit `@<handle>`, a `vscode.window.showQuickPick` lists all current participants (online first, then offline). The last-used recipient is pinned at the top. If the body is also missing, a `showInputBox` prompts for the message.
- `parseHandle` helper in `src/chatParticipantCore.ts` — extracts a leading `@handle` from a prompt even when the body is absent. Used to skip the QuickPick when the user types `@agent-hub @<handle>` without a message body.
- 7 new unit tests for `parseHandle` in `tests/chatParticipant.test.ts`.
- 3 new unit tests for `RelayTracker.cancel()` in `tests/relayTracker.test.ts`.

### Changed
- `src/chatParticipant.ts` — `registerChatParticipant` now handles three prompt shapes: (A) `@handle body` → direct relay, (B) `@handle` only → InputBox for body, (C) no handle → QuickPick + optional InputBox. Sticky handle (`lastHandle`) is remembered across turns within the extension session.

## [0.9.0] — 2026-05-22

### Added
- **Chat-panel reply relay ([#45](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/45))** — after `@agent-hub @<handle> <message>` sends a DM, the Chat panel now awaits the recipient's reply (up to 60 s) and streams it back inline. Previously the reply arrived as a separate VS Code notification. On timeout, "⏱ No reply within 60s" is shown. No LM is invoked.
- `src/relayTracker.ts` — vscode-free `RelayTracker` class: `waitFor(sender, timeoutMs)` registers a FIFO waiter; `tryResolve(msg)` resolves the first matching waiter. `RelayTimeout` error class for expired waiters.
- 8 new unit-test assertions for `RelayTracker` in `tests/relayTracker.test.ts`.
- `relayTracker.ts` added to the `no-restricted-imports(vscode)` ESLint rule in `eslint.config.mjs`.

### Changed
- `src/lmDispatcher.ts` — `notifyOne()` now calls `relayTracker.tryResolve(msg)` first; messages consumed by the relay waiter are ack'd without a VS Code notification.
- `src/chatParticipant.ts` — `registerChatParticipant` gains a `relayTracker` parameter; after `session.send()`, registers a relay wait and streams the reply (or timeout message) into the Chat response.
- `src/extension.ts` — creates a module-level `RelayTracker` singleton and threads it into both `LmDispatcher` and `registerChatParticipant`.

## [0.8.0] — 2026-05-22

### Changed
- **Remove LM auto-dispatch ([#35](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/35))** — the inbox → LM → auto-reply pipeline has been removed. Inbound DMs are now surfaced as VS Code `showInformationMessage` notifications and logged to the output channel; the bridge no longer generates autonomous replies. Outbound DMs continue to work unchanged via the `@agent-hub` Copilot Chat participant.
- `src/lmDispatcher.ts` — LM invocation, model selection, IDE-context collection, and prompt formatting logic removed. The file now contains only the drain-loop skeleton (`requestDrain` / `drainLoop` / `drainOnce`) plus the new `notifyOne` sink.

### Removed
- `src/ideContext.ts` — IDE-context capture (active editor, selection, cursor-window, diagnostics, git diff, multi-editor, notebook). No longer needed.
- `src/promptFormat.ts` — `formatPrompt` / `formatIdeContext` / `formatGitDiffBlock` and related helpers. No longer needed.
- `src/vscodeGit.d.ts` — local typings for the `vscode.git` extension API. No longer needed.
- `tests/promptFormat.test.ts` — unit tests for the removed prompt-format helpers.
- `agentHubBridge.systemPrompt`, `agentHubBridge.languageModel.*`, and `agentHubBridge.ideContext.*` settings from `package.json` — no longer applicable.

## [0.7.0] — 2026-05-22

### Fixed
- **bridge-vscode visible in `get_participants` ([#23](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/23))** — `InboxWatcher` now calls `session.register()` after every successful subscribe (initial start and each reconnect). Previously the bridge bypassed `AgentHub.connect()` auto-register and had no explicit `register()` call, making it permanently invisible in `get_participants`. Register failures are non-fatal: a `[WARN]` log is emitted and the watcher continues running.
- `displayName` in `bindSession()` changed from `null` to `"VS Code bridge"` so the participant registry shows a human-readable label rather than falling back to the raw user ID.

### Changed
- `package.json` version bumped from `0.5.0` → `0.7.0` (0.6.0 entry existed in CHANGELOG but the `package.json` bump was omitted in PR #30; corrected here by jumping directly to 0.7.0).

## [0.6.0] — 2026-05-22

### Added
- **`@agent-hub` Copilot Chat participant ([#28](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/28))** — registers `@agent-hub` as a VS Code Copilot Chat participant so users can send DMs to agent-hub peers directly from the IDE chat panel without leaving VS Code. Usage: `@agent-hub @<handle> <message>` (e.g. `@agent-hub @planner 今日のタスクは？`). Flow is fire-and-forget (Option A): the message is delivered via `session.send()` and any reply arrives through the existing inbox-watch → LM-dispatch → reply-relay pipeline. The watcher is auto-started if not running.
- `src/chatParticipantCore.ts` — vscode-free `parsePrompt` helper (same split pattern as `protocol.ts` / `promptFormat.ts`) so it can be unit-tested without a VS Code extension-host shim.
- `src/chatParticipant.ts` — vscode-bound `registerChatParticipant` (re-exports `parsePrompt` from core for surface compatibility) + `CHAT_PARTICIPANT_ID`.
- 11 new unit-test assertions for `parsePrompt` in `tests/chatParticipant.test.ts`.
- `chatParticipants` contribution in `package.json` (`id: "agent-hub.participant"`, `name: "agent-hub"`).
- `eslint.config.mjs`: `src/chatParticipantCore.ts` added to the `no-restricted-imports(vscode)` rule alongside `protocol.ts` and `promptFormat.ts`.

## [0.5.0] — 2026-05-22

### Fixed
- **Activation error on VS Code Stable ([#25](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/25))** — `@kishibashi3/agent-hub-sdk` is ESM-only (`"type": "module"`) and could not be `require()`d by the VS Code extension host when shipped as a raw `node_modules` entry, producing `No "exports" main defined in …/agent-hub-sdk/package.json`. Resolved by switching to esbuild bundling (see Changed below): all runtime dependencies are now inlined into `dist/extension.js` at build time, eliminating the ESM/CJS boundary at runtime.

### Added
- **`esbuild.mjs` build script** — bundles `src/extension.ts` into a single CJS file (`dist/extension.js`). `vscode` is marked external (provided by the extension host at runtime). Production builds (`--production`) are minified without sourcemaps; development builds include inline sourcemaps.
- **`esbuild` devDependency** (`^0.25.0`).

### Changed
- **agent-hub-sdk migration (L1 dogfood, [#21](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/21))** — the hand-rolled `AgentHubClient` MCP-tools wrapper in `src/protocol.ts` and the bridge-local `InboxMessage` type were retired in favour of `HubSession` / `IncomingMessage` from `@kishibashi3/agent-hub-sdk`. The SDK is consumed through a thin `McpClient` adapter (`src/mcpClient.ts`) that conforms the existing fetch + JSON-RPC wire layer to the SDK's interface — preserving the `.vsix` bundle size (no `@modelcontextprotocol/sdk` runtime dep) and keeping SSE+reconnect under direct `InboxWatcher` control. `LmDispatcher` now calls `session.getUnread()` / `session.send()` / `session.ack()`. Field names follow the SDK: `msg.sender` (was `msg.from`) and `msg.body` (was `msg.message`). **No user-visible behaviour change.**
- `src/protocol.ts` slimmed down by ~110 lines (removed `AgentHubClient`, `InboxMessage`, `isInboxMessage`). `src/agentHub.ts`'s `client` getter (`AgentHubClient | null`) replaced by `session` getter (`HubSession | null`); rebinds on reconnect so the dispatcher follows the watcher across session-id changes.
- `compile` script: `tsc -p ./` → `node esbuild.mjs` (esbuild bundle to `dist/`).
- `watch` script: `tsc -watch -p ./` → `node esbuild.mjs --watch`.
- `vscode:prepublish` script: `npm run compile` → `node esbuild.mjs --production`.
- `package.json` `main`: `./out/extension.js` → `./dist/extension.js`.
- `tsconfig.json`: added `noEmit: true` — `tsc` is now typecheck-only; emission is handled by esbuild.
- `.vscodeignore`: updated for esbuild output (`dist/`); removed the `!node_modules/@kishibashi3/agent-hub-sdk/**` re-include (SDK is inlined by esbuild).

### Removed
- `enabledApiProposals: ["languageModels"]` from `package.json` — the `vscode.lm` Language Model API is now stable (VS Code 1.95+) and no longer requires opt-in.

## [0.4.0] — 2026-05-19

### Added
- **Build & release pipeline** ([#16](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/16)): `@vscode/vsce` devDep + `npm run package` / `npm run package:check` scripts, `.vscodeignore`, `package-check` CI job on every push, and a tag-triggered `release.yml` that builds the `.vsix` and attaches it to a GitHub Release on `v*.*.*` tag pushes.
- **LICENSE** file (MIT) — package.json's `"license": "MIT"` claim now has substantive backing for the shipped artefact.
- **CHANGELOG.md** (this file) — Keep a Changelog format.
- **README Install section** — manual sideload instructions for the GitHub Release `.vsix`.
- **ESLint** ([#19](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/19)): `eslint` + `typescript-eslint` devDeps, flat-config `eslint.config.mjs` with `recommendedTypeChecked` rules. One custom rule (`no-restricted-imports` on `src/protocol.ts` / `src/promptFormat.ts`) lifts the vscode-free / vscode-bound split from convention to lint-enforced invariant. CI gains a `Lint` step between `typecheck` and `compile` in both `ci.yml` and `release.yml`. `npm run lint` + `npm run lint:fix` scripts. No user-visible behaviour change; the shipped `.vsix` contents are unchanged.

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

[Unreleased]: https://github.com/kishibashi3/agent-hub-bridge-vscode/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/kishibashi3/agent-hub-bridge-vscode/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/kishibashi3/agent-hub-bridge-vscode/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/kishibashi3/agent-hub-bridge-vscode/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/kishibashi3/agent-hub-bridge-vscode/releases/tag/v0.5.0
[0.4.0]: https://github.com/kishibashi3/agent-hub-bridge-vscode/releases/tag/v0.4.0
[0.3.0]: https://github.com/kishibashi3/agent-hub-bridge-vscode/releases/tag/v0.3.0
[0.2.0]: https://github.com/kishibashi3/agent-hub-bridge-vscode/releases/tag/v0.2.0
[0.1.1]: https://github.com/kishibashi3/agent-hub-bridge-vscode/releases/tag/v0.1.1
[0.1.0]: https://github.com/kishibashi3/agent-hub-bridge-vscode/releases/tag/v0.1.0
