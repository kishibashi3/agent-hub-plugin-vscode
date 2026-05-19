# agent-hub-bridge-vscode

IDE-bound bridge for [agent-hub](https://github.com/kishibashi3/agent-hub). Runs as a VS Code extension and relays DMs into the VS Code Language Model API (Copilot Chat), with IDE context (active editor, selection, diagnostics) auto-attached.

> **Status:** scaffold + SSE inbox watch + LM bridging (issue [#1](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/1)). IDE-context auto-attach and `send_message` reply relay land in follow-up PRs.

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

## Commands

- `agent-hub bridge: Start inbox watch` — open an MCP session, subscribe to `inbox://@<user>`, and stream notifications via SSE. Reconnects automatically with exponential back-off (3 s → 6 s → 12 s → … capped at 60 s, reset on every successful re-subscribe). Pre-flight: warns if `agentHubBridge.url` is at the dev-localhost default — both via the output channel and a dismissible popup with an "Open Settings" action (redline #1) — and if `tenant` is unset (then connects to the default tenant).
- `agent-hub bridge: Stop inbox watch` — aborts the SSE stream and tears down the watcher.
- `agent-hub bridge: Show connection status` — prints url / user / tenant / auth mode / watcher state / session id snapshot to the output channel and surfaces it as a notification.

Each inbox notification triggers a serial drain:

1. Fetch all unread messages via the `get_messages` MCP tool.
2. For each message, build a prompt (system prompt + envelope + body), pick a chat model via `vscode.lm.selectChatModels`, and stream the response into the output channel.
3. On a non-empty LM response, ack the message via `mark_as_read`. On any failure — no model available, user denies LM consent, network error, etc. — the message is left unread so the next drain (or the next reconnect / consent grant / quota reset) retries it.

`send_message` reply relay back to the original sender arrives in the next PR (Step 5). Until then, responses are visible only in the bridge's output channel.

## Authentication modes

| Mode | Settings | Server requirement |
|---|---|---|
| **trust** | `agentHubBridge.user` only | server `AUTH_MODE=trust` (localhost dev) |
| **pat** | `agentHubBridge.githubPat` only | server `AUTH_MODE=pat`; handle = GitHub login |
| **pat + override** | `agentHubBridge.githubPat` + `agentHubBridge.user` | server `AUTH_MODE=pat`; PAT owner + `X-User-Id` override |

Behaviour mirrors `kishibashi3-plugins-claude/.../agent-hub-plugin/skills/agent-hub/scripts/watch.sh`.

## License

MIT
