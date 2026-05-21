// Vscode-free helpers for AgentHubMcpProvider (issue #53).
//
// Pure functions extracted from `agentHubMcpProvider.ts` so they can be
// unit-tested with plain `node:test` / `tsx` without a VS Code shim.
//
// Keep this module vscode-free — no `import … from 'vscode'` allowed.

/** SecretStorage key for the GitHub PAT (mirrors the constant in extension.ts). */
export const GITHUB_PAT_SECRET_KEY = 'agentHubBridge.githubPat';

/** VS Code configuration keys whose change requires MCP server re-registration. */
export const MCP_RELOAD_CONFIG_KEYS = [
  'agentHubBridge.url',
  'agentHubBridge.user',
  'agentHubBridge.tenant',
] as const;

/**
 * Returns true if any key in `MCP_RELOAD_CONFIG_KEYS` matches the changed
 * configuration event, meaning VS Code should re-resolve the MCP server definition.
 *
 * @param affectsConfiguration — `(key: string) => boolean` predicate taken
 *   directly from `vscode.ConfigurationChangeEvent.affectsConfiguration`.
 */
export function requiresMcpReload(affectsConfiguration: (key: string) => boolean): boolean {
  return MCP_RELOAD_CONFIG_KEYS.some((key) => affectsConfiguration(key));
}

/**
 * Returns true when the changed secret key is the GitHub PAT, meaning VS
 * Code should re-resolve the MCP server definition (auth headers may change).
 *
 * @param changedKey — `vscode.SecretStorageChangeEvent.key`
 */
export function requiresMcpReloadOnSecretChange(changedKey: string): boolean {
  return changedKey === GITHUB_PAT_SECRET_KEY;
}

/**
 * Build the HTTP auth headers for an agent-hub MCP connection.
 *
 * Priority mirrors `src/protocol.ts resolveAuth`:
 *   1. PAT present  → `Authorization: Bearer <pat>`
 *   2. user present → `X-User-Id: <user>` (trust mode, localhost-only on server)
 *   3. neither      → no auth header (connection will likely be rejected)
 *
 * Tenant header is always appended when `tenant` is non-empty, regardless
 * of the auth mode.
 *
 * @param pat     GitHub PAT from SecretStorage (empty string = not set).
 * @param user    Trust-mode user handle from `agentHubBridge.user` (empty = not set).
 * @param tenant  Tenant id from `agentHubBridge.tenant` (empty = default tenant).
 */
export function buildAuthHeaders(
  pat: string,
  user: string,
  tenant: string
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (tenant) {
    headers['X-Tenant-Id'] = tenant;
  }

  if (pat) {
    headers['Authorization'] = `Bearer ${pat}`;
  } else if (user) {
    headers['X-User-Id'] = user;
  }

  return headers;
}
