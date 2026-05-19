// agent-hub-bridge-vscode — entry point
//
// Scaffold only. Subsequent PRs will add:
//   - SSE inbox watch (MCP initialize → subscribe → GET /mcp stream)
//   - vscode.lm.sendRequest bridging
//   - IDE context (active editor / selection / diagnostics) auto-attach
//   - send_message relay back to agent-hub
//
// Reference: kishibashi3-plugins-claude/plugins/agent-hub-plugin/skills/agent-hub/scripts/watch.sh

import * as vscode from 'vscode';

const CHANNEL_NAME = 'agent-hub bridge';

let outputChannel: vscode.OutputChannel | undefined;

function log(msg: string): void {
  const ts = new Date().toISOString();
  outputChannel?.appendLine(`[${ts}] ${msg}`);
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  log('agent-hub bridge activated (scaffold; inbox watch not yet wired up)');

  context.subscriptions.push(
    vscode.commands.registerCommand('agentHubBridge.start', () => {
      log('start command invoked — inbox watch will be implemented in a follow-up PR');
      void vscode.window.showInformationMessage(
        'agent-hub bridge: inbox watch is not yet implemented (scaffold).'
      );
    }),
    vscode.commands.registerCommand('agentHubBridge.stop', () => {
      log('stop command invoked — no-op in scaffold');
    }),
    vscode.commands.registerCommand('agentHubBridge.status', () => {
      const cfg = vscode.workspace.getConfiguration('agentHubBridge');
      // Note: VS Code config returns "" for unset string keys (default declared in
      // package.json), never undefined. Use `||` everywhere so empty-string falls
      // through to the placeholder — `??` would only catch undefined and leave
      // the empty string in place (cosmetic bug, but easy to get wrong).
      const url = cfg.get<string>('url') || '';
      const user = cfg.get<string>('user') || '(unset)';
      const tenant = cfg.get<string>('tenant') || '(default)';
      const summary = `agent-hub bridge — url=${url} user=${user} tenant=${tenant} state=not-started`;
      log(summary);
      void vscode.window.showInformationMessage(summary);
    })
  );
}

export function deactivate(): void {
  log('agent-hub bridge deactivated');
  outputChannel?.dispose();
  outputChannel = undefined;
}
