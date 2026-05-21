// Vscode-free helpers for AgentHubMcpProvider (issue #53).
//
// Pure functions extracted from `agentHubMcpProvider.ts` so they can be
// unit-tested with plain `node:test` / `tsx` without a VS Code shim.
//
// Keep this module vscode-free — no `import … from 'vscode'` allowed.

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
