# agent-hub-bridge-vscode

[![CI](https://github.com/kishibashi3/agent-hub-bridge-vscode/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kishibashi3/agent-hub-bridge-vscode/actions/workflows/ci.yml)

IDE-bound bridge for [agent-hub](https://github.com/kishibashi3/agent-hub). Runs as a VS Code extension and relays DMs into the VS Code Language Model API (Copilot Chat), with IDE context (active editor, selection, diagnostics) auto-attached.

> **Status:** complete. Shipped: scaffold + SSE inbox watch + LM bridging + IDE-context auto-attach + reply relay ([#1](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/1)), CI ([#7](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/7)), SecretStorage migration ([#9](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/9)), git-diff attach ([#11](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/11)), multi-pane + notebook awareness ([#13](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/13)), build & release pipeline + ESLint ([#16](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/16), [#19](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/19)), SDK migration — `HubSession` / `IncomingMessage` from `@kishibashi3/agent-hub-sdk` ([#21](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/21)).

## Architecture

```
VS Code (Insiders)
  └── agent-hub-bridge-vscode (this extension)
        ├── inbox watch (agent-hub SSE)
        ├── DM → vscode.lm.sendRequest (Copilot Chat)
        ├── auto-attach IDE context (active file / selection / diagnostics)
        └── reply → agent-hub send_message
```

### Module layout

The source is split into a **vscode-free protocol / prompt-shaping core** and a **vscode-bound integration layer** so the pure helpers can be unit-tested with plain Node (`node:test` via `tsx`) without a VS Code shim.

| File | Imports `vscode`? | Contents |
|---|---|---|
| `src/protocol.ts` | no | MCP types, constants, pure helpers (`extractJsonRpcResponse`, `extractTextContent`, `nextBackoffMs`, `resolveAuth`, `isDefaultLocalhostUrl`). `AgentHubClient` and `InboxMessage` were retired in favour of the SDK ([#21](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/21)). |
| `src/mcpClient.ts` | no | `createVscodeFetchMcpClient` factory — thin `McpClient` adapter that conforms the bridge's existing fetch + JSON-RPC transport to the `@kishibashi3/agent-hub-sdk` interface; preserves `.vsix` bundle size (no `@modelcontextprotocol/sdk` runtime dep). |
| `src/promptFormat.ts` | no | `formatPrompt`, `formatIdeContext`, IDE-snapshot data types, `DEFAULT_IDE_CONTEXT_OPTIONS`, `EMPTY_IDE_CONTEXT_SNAPSHOT` |
| `src/agentHub.ts` | yes | `InboxWatcher` (vscode.EventEmitter); exposes `session` getter (`HubSession \| null`) rebuilt per successful subscribe via `McpClient` adapter — re-exports the protocol layer for surface compatibility |
| `src/ideContext.ts` | yes | `collectIdeContext` (vscode.window.activeTextEditor + vscode.languages.getDiagnostics) — re-exports the prompt-format layer |
| `src/lmDispatcher.ts` | yes | `LmDispatcher` (vscode.lm.sendRequest) — calls `session.getUnread()` / `session.send()` / `session.ack()` — re-exports `formatPrompt` |
| `src/extension.ts` | yes | `activate`/`deactivate`, command wiring, settings glue |

## VS Code version

The Language Model API (`vscode.lm`) shipped as a stable API in VS Code 1.95. The extension targets `"engines": { "vscode": "^1.95.0" }` and no longer requires VS Code Insiders.

## Install

This extension is **not on the VS Code Marketplace** (`private: true`) — it ships as a sideloadable `.vsix` attached to each GitHub Release. To install:

1. Grab the latest `agent-hub-bridge-vscode-<version>.vsix` from the [Releases page](https://github.com/kishibashi3/agent-hub-bridge-vscode/releases).
2. Install it into VS Code 1.95+:
   ```bash
   code --install-extension agent-hub-bridge-vscode-<version>.vsix
   ```
3. Reload VS Code.

See [`CHANGELOG.md`](./CHANGELOG.md) for the per-release history.

## Develop

```bash
npm install
npm run compile      # esbuild bundle → dist/extension.js (dev, with sourcemap)
npm run watch        # esbuild watch mode (incremental)
npm run typecheck    # tsc type check (no emit)
npm run lint         # ESLint (typescript-eslint recommended-type-checked)
npm run lint:fix     # autofix lintable rules where possible
npm test             # unit tests (node:test via tsx)
npm run test:watch   # tests in watch mode
```

Open this folder in VS Code and press <kbd>F5</kbd> to launch an Extension Development Host.

The unit-test suite targets the vscode-free helpers in `src/protocol.ts` and `src/promptFormat.ts`; the vscode-bound modules (`agentHub.ts` / `ideContext.ts` / `lmDispatcher.ts` / `extension.ts`) are covered by the type checker plus manual smoke-testing in the Extension Development Host. The CI workflow runs `typecheck` + `lint` + `compile` + `test` + `package-check` on every push / PR; the release workflow re-runs the same gates on every `v*.*.*` tag push before building the `.vsix` artefact.

Since v0.5.0 the extension is bundled by [esbuild](https://esbuild.github.io/) (`esbuild.mjs`). `npm run compile` produces a single `dist/extension.js` CJS bundle that inlines all dependencies including `@kishibashi3/agent-hub-sdk`. This resolves the ESM/CJS boundary that caused activation failures with the SDK's `"type": "module"` package (issue [#26](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/26)).

The ESLint config (`eslint.config.mjs`) extends [`typescript-eslint` `recommendedTypeChecked`](https://typescript-eslint.io/users/configs/#recommended-type-checked) and adds one custom rule: `no-restricted-imports` on `src/protocol.ts` / `src/promptFormat.ts` forbids `import * as vscode from 'vscode'`. This lifts the vscode-free / vscode-bound split (see [Module layout](#module-layout) below) from a convention into a lint-enforced invariant.

## Configuration

Available under `agentHubBridge.*`:

| Setting | Default | Notes |
|---|---|---|
| `agentHubBridge.url` | `http://localhost:3000/mcp` | agent-hub MCP endpoint. **Default is a dev-localhost value — override before connecting to any non-local deployment.** Production / Pi5 / remote tenants must set this explicitly; the follow-up SSE-watch PR will additionally `console.warn` (or refuse to start) when this is left at the default in a non-dev environment, per the ecosystem "no silent production fallback" rule (= redline #1). |
| `agentHubBridge.user` | (empty) | Handle (trust mode) / override (pat mode) |
| `agentHubBridge.tenant` | (empty = default tenant) | `X-Tenant-Id` |
| `agentHubBridge.systemPrompt` | (empty → built-in default) | Prepended to every DM forwarded to the LM. Empty falls back to a built-in prompt that frames the agent as an agent-hub participant. |
| `agentHubBridge.languageModel.vendor` | `copilot` | Passed to `vscode.lm.selectChatModels`. |
| `agentHubBridge.languageModel.family` | (empty) | Optional family filter (e.g. `gpt-4o`). Empty = no family constraint. |
| `agentHubBridge.ideContext.enabled` | `true` | Auto-attach IDE context (active editor / selection / cursor-window / diagnostics) to forwarded DMs. Disable for headless behaviour. |
| `agentHubBridge.ideContext.maxSelectionChars` | `4000` | Character cap on selection text; longer selections are truncated. `0` suppresses the selection block entirely (no cursor-window fall-through — pair with `windowLinesAroundCursor=0` if you want no code text shared at all). |
| `agentHubBridge.ideContext.maxDiagnostics` | `20` | Cap on diagnostics forwarded per dispatch (error-first ordering). `0` suppresses diagnostics. |
| `agentHubBridge.ideContext.windowLinesAroundCursor` | `20` | Lines of surrounding code forwarded when there's no selection. `0` suppresses the cursor-window block. |
| `agentHubBridge.ideContext.gitDiff.enabled` | **`false`** | Opt-in working-tree git diff via the bundled `vscode.git` extension. Off by default — diffs can carry sensitive in-flight code. |
| `agentHubBridge.ideContext.gitDiff.maxFiles` | `5` | Cap on files in the git-diff block. `0` suppresses file diffs (header still shown). |
| `agentHubBridge.ideContext.gitDiff.maxCharsPerFile` | `1500` | Per-file diff truncation cap. `0` suppresses diff bodies entirely (paths + statuses only). |
| `agentHubBridge.ideContext.gitDiff.includeUntracked` | `false` | Whether `?? new-file.txt` entries appear. Off by default — new files are often sensitive. |
| `agentHubBridge.ideContext.multiEditor.maxSecondaryEditors` | `3` | Cap on non-active *visible* text editors surfaced as header-only entries (URI + language + cursor only, no selection / window / diagnostics). `0` suppresses the section. |
| `agentHubBridge.ideContext.notebook.enabled` | `true` | Whether the active notebook's header (URI / type / cell position / language) is included. Per-cell content is never forwarded. |

## Commands

- `agent-hub bridge: Start inbox watch` — open an MCP session, subscribe to `inbox://@<user>`, and stream notifications via SSE. Reconnects automatically with exponential back-off (3 s → 6 s → 12 s → … capped at 60 s, reset on every successful re-subscribe). Pre-flight: warns if `agentHubBridge.url` is at the dev-localhost default — both via the output channel and a dismissible popup with an "Open Settings" action (redline #1) — and if `tenant` is unset (then connects to the default tenant).
- `agent-hub bridge: Stop inbox watch` — aborts the SSE stream and tears down the watcher.
- `agent-hub bridge: Show connection status` — prints url / user / tenant / auth mode / watcher state / session id snapshot to the output channel and surfaces it as a notification.

Each inbox notification triggers a serial drain:

1. Fetch all unread messages via `session.getUnread()` (wraps the `get_messages` MCP tool).
2. For each message, snapshot IDE context (active editor URI / selection or cursor-window text / diagnostics — see `agentHubBridge.ideContext.*`), build a prompt (system prompt + IDE block + envelope + body), pick a chat model via `vscode.lm.selectChatModels`, and stream the response.
3. **Reply relay**: on a non-empty LM response, call `session.send()` to DM the response back to the original sender. The full response is also logged as a `[reply-sent]` breadcrumb in the output channel for audit / debug.
4. **Ack only after a successful reply**: `session.ack()` runs only when the relay succeeds. Any failure — no model available, LM consent denied, network error, relay error, `ack` error, watcher reconnecting mid-pipeline — leaves the message unread so the next drain retries it.

The IDE context block looks roughly like:

```
## IDE context

Active file: `file:///…/example.ts` (typescript)
Cursor: line 42, column 8

### Selection (lines 40-48)
```ts
…the selected text…
```

### Diagnostics (3 item(s))
- line 41 error: [ts] Cannot find name 'foo'.
- line 47 warning: Unused variable 'bar'.
```

When there's no selection, a configurable window of lines around the caret is included instead. When there's no active text editor (e.g. the user is on the output channel), the block is omitted entirely and a `[ide-context] no active text editor` line is logged.

When the original sender is a `@team-…` handle, the reply goes to the team (matching agent-hub's `send_message` routing). When `LM` returns an empty response the message is left unread — the bridge errs on the side of "no signal is better than a misleading empty reply."

### Git diff (opt-in)

When `agentHubBridge.ideContext.gitDiff.enabled = true`, the snapshot also includes the working-tree diff of the repo owning the active editor. The block looks like:

```
### Git diff (working tree, branch=feat/x, 3 file(s), + 2 more truncated)

#### `src/a.ts` — modified
```diff
@@ -1 +1 @@
-old
+new
```
```

Defaults (`maxFiles=5`, `maxCharsPerFile=1500`, `includeUntracked=false`) keep the prompt within a token-budget range that pairs well with most chat models. All four `gitDiff.*` knobs follow the same "0 = off, N = cap" semantics as the other IDE-context caps.

The integration uses the bundled `vscode.git` extension's exported API (`vscode.extensions.getExtension('vscode.git')`); no shell-out. If `vscode.git` is disabled the diff is silently omitted.

### Multi-pane editors

When the user has a split layout (e.g. two side-by-side text editors), the secondary editors appear as a compact header-only block beneath the active-file / selection / diagnostics / gitDiff sections:

```
### Other visible editors (2)
- `file:///…/foo.ts` (typescript) — line 12, col 4
- `file:///…/bar.md` (markdown) — line 87, col 1
```

No selection text, no surrounding window, no per-file diagnostics — the cap (`maxSecondaryEditors`, default 3) plus the header-only shape keep the prompt budget bounded. The active editor still gets the full treatment via `activeFile` / `selection` / `cursorWindow` / `diagnostics`.

### Notebook awareness

When `vscode.window.activeNotebookEditor` is present, the snapshot includes a notebook header:

```
### Active notebook

URI: `file:///…/example.ipynb`
Type: jupyter-notebook
Active cell: 3 of 12 (python).
```

**Per-cell content is never included** — only the URI, notebook type, cell counts, and the active cell's language. Forwarding cell text would add per-cell handling for outputs, markdown vs code mode, multimodal content, and would routinely blow the prompt budget on data-heavy notebooks; that scope is intentionally deferred to a follow-up if/when a use-case emerges.

A notebook-only session (no text editor focused) still surfaces this block. Set `agentHubBridge.ideContext.notebook.enabled = false` to suppress collection entirely.

## Secrets

GitHub PATs are stored in [VS Code SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage) — backed by the OS keychain (Keychain on macOS, libsecret on Linux, DPAPI on Windows) — so the value never sits in `settings.json` and doesn't ride along when you commit / sync / back up that file.

Commands:

- `agent-hub bridge: Set GitHub PAT (secret storage)` — prompts via a masked input box, validates the PAT against `https://api.github.com/user`, then stores it. A bad PAT (revoked, expired, wrong scope) is rejected before anything touches the keychain.
- `agent-hub bridge: Clear GitHub PAT (secret storage)` — modal confirmation, then `secrets.delete`.

At startup:

1. **Secret storage** if populated — the bridge uses it.
2. Otherwise, **trust mode** if `agentHubBridge.user` is set.
3. Otherwise, startup fails with a clear error pointing at the `Set GitHub PAT` command.

> **Removed in 0.4.0**: the plaintext `agentHubBridge.githubPat` setting and its auto-migration helper. Users upgrading with a stale plaintext entry in `settings.json` will see VS Code's "unrecognized setting" warning + a friendly error message; running `agent-hub bridge: Set GitHub PAT` once moves the value into secret storage cleanly. There is no automatic copy from the old setting.

## Authentication modes

| Mode | Settings | Server requirement |
|---|---|---|
| **trust** | `agentHubBridge.user` only | server `AUTH_MODE=trust` (localhost dev) |
| **pat** | secret storage (`Set GitHub PAT` command) | server `AUTH_MODE=pat`; handle = GitHub login |
| **pat + override** | secret storage + `agentHubBridge.user` | server `AUTH_MODE=pat`; PAT owner + `X-User-Id` override |

Behaviour mirrors `kishibashi3-plugins-claude/.../agent-hub-plugin/skills/agent-hub/scripts/watch.sh`.

## License

MIT
