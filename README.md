# agent-hub-bridge-vscode

IDE-bound bridge for [agent-hub](https://github.com/kishibashi3/agent-hub). Runs as a VS Code extension and relays DMs into the VS Code Language Model API (Copilot Chat), with IDE context (active editor, selection, diagnostics) auto-attached.

> **Status:** complete (issue [#1](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/1) — scaffold + SSE inbox watch + LM bridging + IDE-context auto-attach + `send_message` reply relay). Follow-ups: CI, `SecretStorage` migration, `vscode.git` diff attach.

## Architecture

```
VS Code (Insiders)
  └── agent-hub-bridge-vscode (this extension)
        ├── inbox watch (agent-hub SSE)
        ├── DM → vscode.lm.sendRequest (Copilot Chat)
        ├── auto-attach IDE context (active file / selection / diagnostics)
        └── reply → agent-hub send_message
```

## Why VS Code Insiders?

The Language Model API (`vscode.lm`) is a [proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api), so the extension declares `enabledApiProposals: ["languageModels"]` in `package.json` and must run on VS Code Insiders (or a stabilized future release).

## Develop

```bash
npm install
npm run compile      # one-shot
npm run watch        # incremental
npm run typecheck    # no-emit type check
```

Open this folder in VS Code Insiders and press <kbd>F5</kbd> to launch an Extension Development Host.

## Configuration

Available under `agentHubBridge.*`:

| Setting | Default | Notes |
|---|---|---|
| `agentHubBridge.url` | `http://localhost:3000/mcp` | agent-hub MCP endpoint. **Default is a dev-localhost value — override before connecting to any non-local deployment.** Production / Pi5 / remote tenants must set this explicitly; the follow-up SSE-watch PR will additionally `console.warn` (or refuse to start) when this is left at the default in a non-dev environment, per the ecosystem "no silent production fallback" rule (= redline #1). |
| `agentHubBridge.user` | (empty) | Handle (trust mode) / override (pat mode) |
| `agentHubBridge.tenant` | (empty = default tenant) | `X-Tenant-Id` |
| `agentHubBridge.githubPat` | (empty) | PAT (pat mode); migrate to secret storage in a follow-up |
| `agentHubBridge.systemPrompt` | (empty → built-in default) | Prepended to every DM forwarded to the LM. Empty falls back to a built-in prompt that frames the agent as an agent-hub participant. |
| `agentHubBridge.languageModel.vendor` | `copilot` | Passed to `vscode.lm.selectChatModels`. |
| `agentHubBridge.languageModel.family` | (empty) | Optional family filter (e.g. `gpt-4o`). Empty = no family constraint. |
| `agentHubBridge.ideContext.enabled` | `true` | Auto-attach IDE context (active editor / selection / cursor-window / diagnostics) to forwarded DMs. Disable for headless behaviour. |
| `agentHubBridge.ideContext.maxSelectionChars` | `4000` | Character cap on selection text; longer selections are truncated. `0` suppresses the selection block entirely (no cursor-window fall-through — pair with `windowLinesAroundCursor=0` if you want no code text shared at all). |
| `agentHubBridge.ideContext.maxDiagnostics` | `20` | Cap on diagnostics forwarded per dispatch (error-first ordering). `0` suppresses diagnostics. |
| `agentHubBridge.ideContext.windowLinesAroundCursor` | `20` | Lines of surrounding code forwarded when there's no selection. `0` suppresses the cursor-window block. |

## Commands

- `agent-hub bridge: Start inbox watch` — open an MCP session, subscribe to `inbox://@<user>`, and stream notifications via SSE. Reconnects automatically with exponential back-off (3 s → 6 s → 12 s → … capped at 60 s, reset on every successful re-subscribe). Pre-flight: warns if `agentHubBridge.url` is at the dev-localhost default — both via the output channel and a dismissible popup with an "Open Settings" action (redline #1) — and if `tenant` is unset (then connects to the default tenant).
- `agent-hub bridge: Stop inbox watch` — aborts the SSE stream and tears down the watcher.
- `agent-hub bridge: Show connection status` — prints url / user / tenant / auth mode / watcher state / session id snapshot to the output channel and surfaces it as a notification.

Each inbox notification triggers a serial drain:

1. Fetch all unread messages via the `get_messages` MCP tool.
2. For each message, snapshot IDE context (active editor URI / selection or cursor-window text / diagnostics — see `agentHubBridge.ideContext.*`), build a prompt (system prompt + IDE block + envelope + body), pick a chat model via `vscode.lm.selectChatModels`, and stream the response.
3. **Reply relay**: on a non-empty LM response, call `send_message` to DM the response back to the original sender. The full response is also logged as a `[reply-sent]` breadcrumb in the output channel for audit / debug.
4. **Ack only after a successful reply**: `mark_as_read` runs only when the relay succeeds. Any failure — no model available, LM consent denied, network error, relay error, `mark_as_read` error, watcher reconnecting mid-pipeline — leaves the message unread so the next drain retries it.

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

## Authentication modes

| Mode | Settings | Server requirement |
|---|---|---|
| **trust** | `agentHubBridge.user` only | server `AUTH_MODE=trust` (localhost dev) |
| **pat** | `agentHubBridge.githubPat` only | server `AUTH_MODE=pat`; handle = GitHub login |
| **pat + override** | `agentHubBridge.githubPat` + `agentHubBridge.user` | server `AUTH_MODE=pat`; PAT owner + `X-User-Id` override |

Behaviour mirrors `kishibashi3-plugins-claude/.../agent-hub-plugin/skills/agent-hub/scripts/watch.sh`.

## License

MIT
