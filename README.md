# agent-hub-bridge-vscode

IDE-bound bridge for [agent-hub](https://github.com/kishibashi3/agent-hub). Runs as a VS Code extension and relays DMs into the VS Code Language Model API (Copilot Chat), with IDE context (active editor, selection, diagnostics) auto-attached.

> **Status:** scaffold (issue [#1](https://github.com/kishibashi3/agent-hub-bridge-vscode/issues/1)). Inbox watch and LM bridging land in follow-up PRs.

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
| `agentHubBridge.url` | `http://localhost:3000/mcp` | agent-hub MCP endpoint |
| `agentHubBridge.user` | (empty) | Handle (trust mode) / override (pat mode) |
| `agentHubBridge.tenant` | (empty = default tenant) | `X-Tenant-Id` |
| `agentHubBridge.githubPat` | (empty) | PAT (pat mode); migrate to secret storage in a follow-up |

## Commands

- `agent-hub bridge: Start inbox watch` — begin SSE subscription (not yet implemented)
- `agent-hub bridge: Stop inbox watch` — stop the subscription
- `agent-hub bridge: Show connection status` — print current config / state to the output channel

## License

MIT
