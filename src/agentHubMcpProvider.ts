// VS Code MCP server definition provider for agent-hub (issue #53).
//
// Registers the agent-hub MCP endpoint with VS Code so that Copilot
// (and other MCP clients inside VS Code 1.99+) can call agent-hub tools
// (`send_message`, `get_participants`, `get_messages`, etc.) directly
// without routing through the extension's Chat participant handler.
//
// Authentication is injected in `resolveMcpServerDefinition`:
//   - PAT mode  : `Authorization: Bearer <pat>` (PAT from SecretStorage)
//   - Trust mode: `X-User-Id: <user>`           (user from settings, localhost-only)
//
// The provider fires `onDidChangeMcpServerDefinitions` when the URL,
// user, tenant, or stored PAT changes so VS Code re-resolves the server.

import * as vscode from 'vscode';

import { buildAuthHeaders } from './agentHubMcpProviderCore';

const SECRET_KEY_GITHUB_PAT = 'agentHubBridge.githubPat';

/** Provider ID — must match the `id` declared in `contributes.mcpServerDefinitionProviders`. */
export const MCP_PROVIDER_ID = 'agent-hub';

/**
 * Provides the agent-hub MCP HTTP server definition to VS Code.
 *
 * VS Code 1.99+ exposes this to Copilot and other MCP clients, letting them
 * call agent-hub tools (`send_message`, `get_participants`, …) natively.
 *
 * Lifecycle:
 *   `provideMcpServerDefinitions` — returns server URL (no auth yet)
 *   `resolveMcpServerDefinition`  — injects auth headers before connecting
 */
export class AgentHubMcpProvider
  implements vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition>
{
  private readonly _changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions: vscode.Event<void> =
    this._changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Re-register when URL / user / tenant settings change.
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('agentHubBridge.url') ||
          e.affectsConfiguration('agentHubBridge.user') ||
          e.affectsConfiguration('agentHubBridge.tenant')
        ) {
          this._changeEmitter.fire();
        }
      })
    );

    // Re-register when the stored GitHub PAT is added / removed.
    context.subscriptions.push(
      context.secrets.onDidChange((e) => {
        if (e.key === SECRET_KEY_GITHUB_PAT) {
          this._changeEmitter.fire();
        }
      })
    );
  }

  /**
   * Return the base server definition (URL only, no auth headers).
   * Auth is added lazily in `resolveMcpServerDefinition`.
   */
  provideMcpServerDefinitions(
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.McpHttpServerDefinition[]> {
    const cfg = vscode.workspace.getConfiguration('agentHubBridge');
    const url = cfg.get<string>('url') || 'http://localhost:3000/mcp';

    return [new vscode.McpHttpServerDefinition('agent-hub', vscode.Uri.parse(url))];
  }

  /**
   * Inject authentication headers before VS Code connects to the server.
   *
   * Priority (mirrors `src/protocol.ts resolveAuth`):
   *   1. PAT present  → `Authorization: Bearer <pat>`
   *   2. user present → `X-User-Id: <user>` (trust mode, localhost-only on server)
   *   3. neither      → return unchanged (connection will likely fail auth)
   */
  async resolveMcpServerDefinition(
    server: vscode.McpHttpServerDefinition,
    _token: vscode.CancellationToken
  ): Promise<vscode.McpHttpServerDefinition> {
    const cfg = vscode.workspace.getConfiguration('agentHubBridge');
    const user = (cfg.get<string>('user') ?? '').trim();
    const tenant = (cfg.get<string>('tenant') ?? '').trim();
    const pat = ((await this.context.secrets.get(SECRET_KEY_GITHUB_PAT)) ?? '').trim();

    // Auth header logic lives in the vscode-free `./agentHubMcpProviderCore`
    // module so it can be unit-tested without a VS Code extension-host shim.
    const headers = buildAuthHeaders(pat, user, tenant);

    return new vscode.McpHttpServerDefinition(
      server.label,
      server.uri,
      headers,
      server.version
    );
  }

  dispose(): void {
    this._changeEmitter.dispose();
  }
}
