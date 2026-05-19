// Vscode-free MCP protocol layer.
//
// This module is the "pure" half of `./agentHub.ts` — all the types,
// constants, helpers, and the `AgentHubClient` that talk to the
// agent-hub server but never touch the VS Code extension host APIs.
//
// Why a separate file: `agentHub.ts` imports `vscode` (for the
// EventEmitter used by `InboxWatcher`), which means `require('./agentHub.js')`
// from a plain Node test runner throws — there's no `vscode` module
// outside the extension host. Splitting the pure pieces here lets
// `node --test` exercise them directly with zero VS Code shims.
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

/**
 * Shape of an unread inbox message as returned by the agent-hub server's
 * `get_messages` tool. Mirrors `agent-hub/src/mcp/tools/get_messages.ts`.
 */
export interface InboxMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly message: string;
  readonly timestamp: string;
}

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

/**
 * Thin MCP-tools client bound to a live session. Used by `LmDispatcher` to
 * fetch message bodies (`get_messages`), post replies (`send_message`), and
 * ack messages (`mark_as_read`) after a successful LM dispatch.
 *
 * Stateless apart from `nextId` — `InboxWatcher` constructs a fresh one per
 * call via `watcher.client`, so a session invalidation (e.g. server
 * restart) is naturally observed: the next tool call comes back with an
 * error and the dispatcher leaves the message unread for the watcher to
 * re-pick up after reconnect.
 */
export class AgentHubClient {
  private nextId = 100; // initialize/subscribe use ids 0/1 — stay clear of those.

  constructor(
    private readonly url: string,
    private readonly auth: AuthContext,
    private readonly sessionId: string
  ) {}

  /** Generic `tools/call` over the streamable HTTP transport. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<unknown> {
    const id = this.nextId++;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        ...this.auth.headers,
        'mcp-session-id': this.sessionId,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name, arguments: args },
        id,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`tools/call ${name}: HTTP ${res.status}`);
    }
    const body = await res.text();
    const response = extractJsonRpcResponse(body, id);
    if (!response) {
      throw new Error(`tools/call ${name}: no matching response in body`);
    }
    if (response.error) {
      const err = response.error;
      // `err` is `unknown`. JSON.stringify is the safe stringifier for
      // both primitive and structured error payloads — primitives stringify
      // as their literal, objects stringify as JSON, undefined → "null".
      // `String(obj)` would yield "[object Object]" for the object case.
      throw new Error(`tools/call ${name}: ${JSON.stringify(err)}`);
    }
    return response.result;
  }

  /** Fetches the caller's unread inbox (DMs + team mail, sender-excluded). */
  async getMessages(): Promise<InboxMessage[]> {
    const result = await this.callTool('get_messages', {});
    const text = extractTextContent(result);
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error('get_messages: expected an array, got something else');
    }
    const out: InboxMessage[] = [];
    for (const item of parsed) {
      if (isInboxMessage(item)) {
        out.push(item);
      }
    }
    return out;
  }

  /**
   * Sends a DM (or team-broadcast, when `to` is a `@team-name`) via the
   * `send_message` MCP tool. The Step 5 reply path uses this to relay
   * the LM response back to the original sender.
   */
  async sendMessage(to: string, message: string): Promise<void> {
    const result = await this.callTool('send_message', { to, message });
    const r = result as { isError?: boolean; content?: Array<{ type?: unknown; text?: unknown }> };
    if (r.isError) {
      const first = Array.isArray(r.content) ? r.content[0] : undefined;
      const text = typeof first?.text === 'string' ? first.text : '(no detail)';
      throw new Error(`send_message: ${text}`);
    }
  }

  /**
   * Marks one message as read. Idempotent server-side, but the handler
   * returns `isError: true` when the message id is unknown or not owned
   * by the caller — we surface that as a thrown error so the caller can
   * decide whether to retry.
   */
  async markAsRead(messageId: string): Promise<void> {
    const result = await this.callTool('mark_as_read', { message_id: messageId });
    const r = result as { isError?: boolean; content?: Array<{ type?: unknown; text?: unknown }> };
    if (r.isError) {
      // Narrow via a local + optional chain instead of a non-null
      // assertion — the whole point of `noUncheckedIndexedAccess`
      // (added in PR #2) is to prevent `arr[0]!` bypasses.
      const first = Array.isArray(r.content) ? r.content[0] : undefined;
      const text = typeof first?.text === 'string' ? first.text : '(no detail)';
      throw new Error(`mark_as_read: ${text}`);
    }
  }
}

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

function isInboxMessage(value: unknown): value is InboxMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.from === 'string' &&
    typeof v.to === 'string' &&
    typeof v.message === 'string' &&
    typeof v.timestamp === 'string'
  );
}
