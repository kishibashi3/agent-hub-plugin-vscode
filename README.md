# agent-hub-bridge-vscode

[![CI](https://github.com/kishibashi3/agent-hub-bridge-vscode/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kishibashi3/agent-hub-bridge-vscode/actions/workflows/ci.yml)

IDE-bound plugin for [agent-hub](https://github.com/kishibashi3/agent-hub). Runs as a VS Code extension that lets you send direct messages to agent-hub participants from the Copilot Chat panel, and surfaces inbound DMs as VS Code notifications.

> **Status:** v0.8.0. Shipped: scaffold + SSE inbox watch + Chat Participant ([#28](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/28)) + LM auto-dispatch removed ([#35](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/35)), CI ([#7](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/7)), SecretStorage migration ([#9](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/9)), SDK migration ([#21](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/21)), esbuild bundling ([#25](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/25)).

## Architecture

```
VS Code 1.95+
  └── agent-hub-bridge-vscode (this extension)
        ├── inbox watch (agent-hub SSE)          ← inbound: DM → VS Code notification
        └── @agent-hub Chat Participant           ← outbound: Chat → DM
              └── @agent-hub @<handle> <message> → session.send()
```

## Chat Participant — outbound DM

Type `@agent-hub` in the Copilot Chat panel to send a direct message to any agent-hub participant:

```
@agent-hub @planner 今日のタスクは？
@agent-hub @team-backend デプロイ状況を確認して
@agent-hub @ope-ultp1635 restart bridge-claude
```

**Format:** `@agent-hub @<handle> <message body>`

- The first word after `@agent-hub` must be the recipient handle (starts with `@`).
- The rest of the prompt is the message body (may span multiple lines).
- If the inbox watch is not running it is **auto-started** before sending.
- The send is **fire-and-forget**: the acknowledgement appears instantly in the chat panel. Replies from the recipient arrive as VS Code notifications via the inbox watch.

### Module layout

The source is split into a **vscode-free protocol core** and a **vscode-bound integration layer** so the pure helpers can be unit-tested with plain Node (`node:test` via `tsx`) without a VS Code shim.

| File | Imports `vscode`? | Contents |
|---|---|---|
| `src/protocol.ts` | no | MCP types, constants, pure helpers (`extractJsonRpcResponse`, `extractTextContent`, `nextBackoffMs`, `resolveAuth`, `isDefaultLocalhostUrl`). |
| `src/mcpClient.ts` | no | `createVscodeFetchMcpClient` factory — thin `McpClient` adapter that conforms the bridge's existing fetch + JSON-RPC transport to the `@kishibashi3/agent-hub-sdk` interface; preserves `.vsix` bundle size (no `@modelcontextprotocol/sdk` runtime dep). |
| `src/chatParticipantCore.ts` | no | `parsePrompt` — pure helper that parses `@<handle> <body>` from a Copilot Chat prompt string |
| `src/agentHub.ts` | yes | `InboxWatcher` (vscode.EventEmitter); exposes `session` getter (`HubSession \| null`) rebuilt per successful subscribe via `McpClient` adapter — re-exports the protocol layer for surface compatibility |
| `src/lmDispatcher.ts` | yes | `LmDispatcher` — drain-loop skeleton (`requestDrain` / `drainLoop` / `drainOnce`) + `notifyOne` sink: calls `session.getUnread()`, shows each inbound DM as a `vscode.window.showInformationMessage`, then `session.ack()`. No LM invocation since v0.8.0. |
| `src/chatParticipant.ts` | yes | `registerChatParticipant` — registers the `@agent-hub` chat participant; re-exports `parsePrompt` from core |
| `src/extension.ts` | yes | `activate`/`deactivate`, command wiring, settings glue |

## VS Code version

The Chat Participant API (`vscode.chat.createChatParticipant`) shipped as a stable API in VS Code 1.95. The extension targets `"engines": { "vscode": "^1.95.0" }` and does not require VS Code Insiders.

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

The unit-test suite targets the vscode-free helpers in `src/protocol.ts` and `src/chatParticipantCore.ts`; the vscode-bound modules (`agentHub.ts` / `lmDispatcher.ts` / `chatParticipant.ts` / `extension.ts`) are covered by the type checker plus manual smoke-testing in the Extension Development Host. The CI workflow runs `typecheck` + `lint` + `compile` + `test` + `package-check` on every push / PR; the release workflow re-runs the same gates on every `v*.*.*` tag push before building the `.vsix` artefact.

Since v0.5.0 the extension is bundled by [esbuild](https://esbuild.github.io/) (`esbuild.mjs`). `npm run compile` produces a single `dist/extension.js` CJS bundle that inlines all dependencies including `@kishibashi3/agent-hub-sdk`. This resolves the ESM/CJS boundary that caused activation failures with the SDK's `"type": "module"` package (issue [#26](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/26)).

The ESLint config (`eslint.config.mjs`) extends [`typescript-eslint` `recommendedTypeChecked`](https://typescript-eslint.io/users/configs/#recommended-type-checked) and adds one custom rule: `no-restricted-imports` on `src/protocol.ts` / `src/chatParticipantCore.ts` forbids `import * as vscode from 'vscode'`. This lifts the vscode-free / vscode-bound split (see [Module layout](#module-layout) above) from a convention into a lint-enforced invariant.

## Configuration

Available under `agentHubBridge.*`:

| Setting | Default | Notes |
|---|---|---|
| `agentHubBridge.url` | `http://localhost:3000/mcp` | agent-hub MCP endpoint. **Default is a dev-localhost value — override before connecting to any non-local deployment.** |
| `agentHubBridge.user` | (empty) | Handle (trust mode) / override (pat mode) |
| `agentHubBridge.tenant` | (empty = default tenant) | `X-Tenant-Id` |

## Commands

- `agent-hub bridge: Start inbox watch` — open an MCP session, subscribe to `inbox://@<user>`, and stream notifications via SSE. Reconnects automatically with exponential back-off (3 s → 6 s → 12 s → … capped at 60 s, reset on every successful re-subscribe). Pre-flight: warns if `agentHubBridge.url` is at the dev-localhost default — both via the output channel and a dismissible popup with an "Open Settings" action (redline #1).
- `agent-hub bridge: Stop inbox watch` — aborts the SSE stream and tears down the watcher.
- `agent-hub bridge: Show connection status` — prints url / user / tenant / auth mode / watcher state / session id snapshot to the output channel and surfaces it as a notification.

Each inbox notification triggers a serial drain:

1. Fetch all unread messages via `session.getUnread()` (wraps the `get_messages` MCP tool).
2. For each message, log it to the output channel and show it as a VS Code `showInformationMessage` notification.
3. **Ack**: call `session.ack()` to mark the message read. If the watcher loses its session before ack, the message is left unread and redelivered on the next drain.

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

## License

MIT
