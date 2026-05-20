// Vscode-free MCP protocol layer.
//
// This module is the "pure" half of `./agentHub.ts` — all the types,
// constants, helpers, and the `resolveAuth` 3-mode triage that talk to
// the agent-hub server but never touch the VS Code extension host APIs.
//
// Why a separate file: `agentHub.ts` imports `vscode` (for the
// EventEmitter used by `InboxWatcher`), which means `require('./agentHub.js')`
// from a plain Node test runner throws — there's no `vscode` module
// outside the extension host. Splitting the pure pieces here lets
// `node --test` exercise them directly with zero VS Code shims.
//
// As of issue #21 the MCP-tools wrapper (`AgentHubClient`) and the
// bridge-local `InboxMessage` type have moved to the SDK:
// `@kishibashi3/agent-hub-sdk` exposes `HubSession` + `IncomingMessage`.
// The wire-level `extractJsonRpcResponse` / `extractTextContent`
// helpers stay here because the bridge-vscode `McpClient` adapter
// (`./mcpClient`) still uses them at the raw-fetch layer.
//
// Public surface compatibility: `./agentHub.ts` re-exports everything
// from this module so existing call sites (`import { foo } from
// './agentHub'`) keep working unchanged.

/** Public type — what subscribers (the LM dispatcher) consume. */
export interface InboxMessageNotification {
  /** `inbox://<owner>` per the agent-hub server canonicalisation. */
  readonly uri: string;
  readonly receivedAt: Date;
}

export interface BridgeConfig {
  readonly url: string;
  readonly user: string;
  readonly tenant: string;
  readonly githubPat: string;
}

export type AuthMode = 'trust' | 'pat' | 'pat+override';

export interface AuthContext {
  readonly userId: string;
  readonly headers: Record<string, string>;
  readonly mode: AuthMode;
}

export type WatcherMode = 'idle' | 'connecting' | 'subscribed' | 'reconnecting';

export interface WatcherState {
  readonly running: boolean;
  readonly mode: WatcherMode;
  readonly sessionId: string | null;
  readonly authMode: AuthMode | null;
  readonly userId: string | null;
}

// The bridge-local `InboxMessage` interface was retired in issue #21.
// Consumers now import `IncomingMessage` from
// `@kishibashi3/agent-hub-sdk` directly; field names changed from
// `from`/`message` to `sender`/`body` to match the SDK contract.

/**
 * The package.json default for `agentHubBridge.url`. Kept here so the
 * redline #1 startup check can compare against the canonical value (and
 * reviewers can grep this constant when auditing the rule).
 */
export const LOCALHOST_DEFAULT_URL = 'http://localhost:3000/mcp';

export function isDefaultLocalhostUrl(url: string): boolean {
  return url === LOCALHOST_DEFAULT_URL;
}

/**
 * Reconnect back-off, in ms. Doubles per consecutive failure and caps at 60s
 * so a sustained outage doesn't pin us at 3s pinging forever. Reset to the
 * starting value on every successful subscribe.
 *
 * watch.sh uses a flat 3s `sleep` (no cap, no growth) — we diverge here
 * intentionally because a long-lived editor session is more likely to ride
 * out multi-minute outages than a developer-supervised shell.
 */
export const RECONNECT_BACKOFF_START_MS = 3_000;
export const RECONNECT_BACKOFF_MAX_MS = 60_000;

export function nextBackoffMs(currentMs: number): number {
  const doubled = currentMs * 2;
  return doubled >= RECONNECT_BACKOFF_MAX_MS ? RECONNECT_BACKOFF_MAX_MS : doubled;
}

export type LoginResolver = (pat: string) => Promise<string | null>;

/**
 * Mirrors watch.sh's auth-mode triage:
 *   - PAT only           → pat (handle = GitHub login)
 *   - PAT + user         → pat+override (handle = user, owner = GitHub login)
 *   - user only          → trust (X-User-Id, localhost-only on the server side)
 *   - neither            → error
 *
 * Network access is performed iff `githubPat` is supplied (to resolve the
 * GitHub login). Exposed for unit-testing the branching logic without an
 * HTTP roundtrip — callers can inject a `loginResolver`.
 */
export async function resolveAuth(
  cfg: BridgeConfig,
  loginResolver: LoginResolver = fetchGitHubLogin
): Promise<AuthContext> {
  const headers: Record<string, string> = {};
  if (cfg.tenant) {
    headers['X-Tenant-Id'] = cfg.tenant;
  }

  if (cfg.githubPat) {
    headers['Authorization'] = `Bearer ${cfg.githubPat}`;
    const login = await loginResolver(cfg.githubPat);
    if (!login) {
      throw new Error(
        'could not resolve GitHub login from agentHubBridge.githubPat (revoked or invalid?)'
      );
    }
    if (cfg.user) {
      headers['X-User-Id'] = cfg.user;
      return { userId: cfg.user, headers, mode: 'pat+override' };
    }
    return { userId: login, headers, mode: 'pat' };
  }

  if (cfg.user) {
    headers['X-User-Id'] = cfg.user;
    return { userId: cfg.user, headers, mode: 'trust' };
  }

  throw new Error(
    'agentHubBridge: run the `agent-hub bridge: Set GitHub PAT` command (pat mode) or ' +
      'set agentHubBridge.user (trust mode)'
  );
}

/**
 * Resolves the GitHub login that owns a PAT by hitting `https://api.github.com/user`.
 * Returns `null` on any failure (network error, revoked PAT, non-2xx, missing
 * `login` field). Exported so the `agentHubBridge.setGithubPat` command can
 * validate the PAT before storing it in `SecretStorage` (issue #9).
 */
export async function fetchGitHubLogin(pat: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${pat}`,
        'User-Agent': 'agent-hub-bridge-vscode',
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return null;
    }
    const json = (await res.json()) as { login?: unknown };
    return typeof json.login === 'string' && json.login.length > 0 ? json.login : null;
  } catch {
    return null;
  }
}

// `AgentHubClient` was retired in issue #21 (= bridge-vscode SDK
// migration, L1 dogfood). It used to live here as a thin MCP-tools
// wrapper bound to a `(url, auth, sessionId)` triple, exposing
// `callTool` / `getMessages` / `sendMessage` / `markAsRead`. Its role
// has been split:
//
//   - The `tools/call` wire layer lives in `./mcpClient.ts` as a
//     `McpClient` adapter that conforms to the SDK's interface.
//   - The typed surface (`getMessages` / `sendMessage` / `markAsRead`)
//     comes from `HubSession.getUnread` / `send` / `ack` in
//     `@kishibashi3/agent-hub-sdk`, with `PeerNotFoundError` /
//     `HubTransientError` classification for free.
//
// `extractJsonRpcResponse` and `extractTextContent` below stay here
// because the new `./mcpClient` adapter still needs them at the raw
// fetch + JSON-RPC framing layer (the SDK doesn't see the wire format
// — only the parsed `CallToolResult` shape).

/**
 * Pulls the JSON-RPC response with the matching `id` out of a POST body
 * that may be plain JSON OR a `text/event-stream` SSE frame. The MCP
 * StreamableHTTPServerTransport can choose either depending on whether the
 * server-side handler streams — we accept both so we don't have to second-
 * guess the agent-hub server's framing decisions.
 *
 * Exported for unit-testing.
 */
export function extractJsonRpcResponse(
  body: string,
  id: number
): { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown } | null {
  // Single JSON body.
  try {
    const obj = JSON.parse(body) as { id?: unknown; result?: unknown; error?: unknown };
    if (obj && typeof obj === 'object' && obj.id === id) {
      return obj;
    }
  } catch {
    /* fall through to SSE parse */
  }
  // SSE: one `data:` line per JSON-RPC message. Scan for the matching id.
  for (const rawLine of body.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr) continue;
    try {
      const obj = JSON.parse(dataStr) as { id?: unknown; result?: unknown; error?: unknown };
      if (obj && typeof obj === 'object' && obj.id === id) {
        return obj;
      }
    } catch {
      /* keepalive / partial — skip */
    }
  }
  return null;
}

/**
 * Pulls the first text-typed content part out of an MCP `CallToolResult`.
 * Throws on shape mismatches so callers can surface a useful error.
 *
 * Exported for unit-testing.
 */
export function extractTextContent(result: unknown): string {
  const r = result as { content?: unknown };
  if (!Array.isArray(r.content) || r.content.length === 0) {
    throw new Error('CallToolResult: expected non-empty content array');
  }
  const first = r.content[0] as { type?: unknown; text?: unknown };
  if (first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('CallToolResult: expected first content part to be text');
  }
  return first.text;
}

// `isInboxMessage` was retired alongside `InboxMessage` in issue #21
// — the SDK's `parseMessages` (used internally by `HubSession.getUnread`)
// is the new home for the schema-drift defence.
