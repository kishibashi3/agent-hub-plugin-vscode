// agent-hub MCP client + SSE inbox watcher.
//
// TypeScript port of
// `kishibashi3-plugins-claude/plugins/agent-hub-plugin/skills/agent-hub/scripts/watch.sh`.
// Behaviour mirrors that script line-for-line:
//
//   1. POST `initialize`              → extract `mcp-session-id` header
//   2. POST `notifications/initialized`
//   3. POST `resources/subscribe` for `inbox://@<user>`
//   4. GET  `/mcp` with `Accept: text/event-stream` → long-lived stream
//   5. Parse `data:` lines, emit on `notifications/resources/updated`
//   6. On disconnect or error, reconnect after a 3s sleep
//
// This module only *detects* new inbox notifications and emits an event.
// Reading the message body, dispatching it to `vscode.lm.sendRequest`, and
// posting a reply via `send_message` arrive in subsequent PRs (Steps 3-5
// in issue #1's plan).

import * as vscode from 'vscode';

/** Public type — what subscribers (Steps 3-5) consume. */
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
 * The package.json default. Kept here so the redline #1 startup check
 * can compare against the canonical value (and reviewers can grep this
 * constant when auditing the rule).
 */
export const LOCALHOST_DEFAULT_URL = 'http://localhost:3000/mcp';

export function isDefaultLocalhostUrl(url: string): boolean {
  return url === LOCALHOST_DEFAULT_URL;
}

/**
 * Mirrors watch.sh's auth-mode triage:
 *   - PAT only           → pat (handle = GitHub login)
 *   - PAT + user         → pat+override (handle = user, owner = GitHub login)
 *   - user only          → trust (X-User-Id, localhost-only on the server side)
 *   - neither            → error
 *
 * Network access is performed iff `githubPat` is supplied (to resolve the
 * GitHub login). Exposed for unit-testing the branching logic without an
 * HTTP roundtrip if the caller injects a `loginResolver`.
 */
export async function resolveAuth(
  cfg: BridgeConfig,
  loginResolver: (pat: string) => Promise<string | null> = fetchGitHubLogin
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
    'agentHubBridge: set agentHubBridge.githubPat (pat mode) or agentHubBridge.user (trust mode)'
  );
}

async function fetchGitHubLogin(pat: string): Promise<string | null> {
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

type Logger = (msg: string) => void;
type LoginResolver = (pat: string) => Promise<string | null>;

/**
 * Reconnect back-off, in ms. Doubles per consecutive failure and caps at 60s
 * so a sustained outage doesn't pin us at 3s pinging forever. Reset to the
 * starting value on every successful subscribe.
 *
 * watch.sh uses a flat 3s `sleep` (no cap, no growth) — we diverge here
 * intentionally because a long-lived editor session is more likely to ride
 * out multi-minute outages than a developer-supervised shell.
 */
const RECONNECT_BACKOFF_START_MS = 3_000;
const RECONNECT_BACKOFF_MAX_MS = 60_000;

export function nextBackoffMs(currentMs: number): number {
  const doubled = currentMs * 2;
  return doubled >= RECONNECT_BACKOFF_MAX_MS ? RECONNECT_BACKOFF_MAX_MS : doubled;
}

/**
 * Shape of an unread inbox message as returned by the agent-hub server's
 * `get_messages` tool. Mirrors the server-side `handleGetMessages` response
 * (`agent-hub/src/mcp/tools/get_messages.ts`).
 */
export interface InboxMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly message: string;
  readonly timestamp: string;
}

/**
 * Thin MCP-tools client bound to a live session. Used by `LmDispatcher` to
 * fetch message bodies (`get_messages`) and ack them (`mark_as_read`) after
 * a successful LM dispatch.
 *
 * Instances are cheap and stateless apart from `nextId` — `InboxWatcher`
 * constructs a fresh one per call via `watcher.client`, so a session
 * invalidation (e.g. server restart) is naturally observed: the next
 * tool call comes back with an error and the dispatcher leaves the
 * message unread for the watcher to re-pick up after reconnect.
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
      throw new Error(
        `tools/call ${name}: ${
          typeof response.error === 'object' && response.error
            ? JSON.stringify(response.error)
            : String(response.error)
        }`
      );
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
   *
   * On `isError: true` the handler's text payload is surfaced as the
   * thrown error so the dispatcher can leave the message unread and
   * retry on the next drain.
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
 * Exported for future unit tests (CI follow-up).
 */
export function extractJsonRpcResponse(
  body: string,
  id: number
): { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown } | null {
  // Single JSON body.
  try {
    const obj = JSON.parse(body) as { id?: unknown };
    if (obj && typeof obj === 'object' && obj.id === id) {
      return obj as { id?: unknown; result?: unknown; error?: unknown };
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
      const obj = JSON.parse(dataStr) as { id?: unknown };
      if (obj && typeof obj === 'object' && obj.id === id) {
        return obj as { id?: unknown; result?: unknown; error?: unknown };
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
 * Exported for future unit tests (CI follow-up).
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

/**
 * Long-lived inbox watcher. Owns one MCP session + one SSE stream and
 * reconnects on failure (3s backoff, matching watch.sh).
 *
 * Public surface kept intentionally tiny:
 *   - `start()` / `stop()` / `dispose()`
 *   - `state` snapshot for the status command
 *   - `onMessage` event for downstream consumers
 *   - `client` accessor that returns a fresh `AgentHubClient` bound to
 *     the *current* session (or `null` when not subscribed)
 */
export class InboxWatcher {
  private running = false;
  private abortController?: AbortController;
  private currentSessionId: string | null = null;
  private currentMode: WatcherMode = 'idle';
  private currentAuth: AuthContext | null = null;
  private readonly emitter = new vscode.EventEmitter<InboxMessageNotification>();
  readonly onMessage: vscode.Event<InboxMessageNotification> = this.emitter.event;
  private readonly loginResolver: LoginResolver;

  constructor(
    private readonly cfg: BridgeConfig,
    private readonly log: Logger,
    loginResolver?: LoginResolver
  ) {
    // Threaded through `resolveAuth` below so an end-to-end test (or a
    // mocked GitHub backend) can inject a deterministic login without
    // hitting api.github.com.
    this.loginResolver = loginResolver ?? fetchGitHubLogin;
  }

  get state(): WatcherState {
    return {
      running: this.running,
      mode: this.currentMode,
      sessionId: this.currentSessionId,
      authMode: this.currentAuth?.mode ?? null,
      userId: this.currentAuth?.userId ?? null,
    };
  }

  /**
   * A short-lived `AgentHubClient` bound to the watcher's *current* session,
   * or `null` when the watcher is idle / reconnecting / pre-subscribe. The
   * caller should re-read this property on each operation so that a
   * concurrent reconnect (which mints a fresh session id) is observed
   * naturally rather than via a long-lived stale client.
   */
  get client(): AgentHubClient | null {
    if (!this.currentSessionId || !this.currentAuth) return null;
    return new AgentHubClient(this.cfg.url, this.currentAuth, this.currentSessionId);
  }

  /**
   * Begin watching. Resolves once the *first* subscribe call succeeds (or
   * rejects if config / auth is broken). Reconnects happen transparently
   * afterwards inside `runLoop`.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.log('start: already running');
      return;
    }

    // redline #1 forward-looking observation (issue #1, PR #2 review):
    // the `url` default is a dev-localhost. Warn loudly at startup so an
    // operator who forgot to override doesn't silently connect to a
    // non-existent or wrong endpoint.
    if (isDefaultLocalhostUrl(this.cfg.url)) {
      this.log(
        '[WARN] agentHubBridge.url is the dev-localhost default ' +
          `(${LOCALHOST_DEFAULT_URL}). If you intended a non-local deployment, ` +
          'set agentHubBridge.url before starting (redline #1: no silent ' +
          'production fallback).'
      );
    }
    // Tenant unset → same warning watch.sh emits at boot.
    if (!this.cfg.tenant) {
      this.log(
        '[WARN] agentHubBridge.tenant is unset → connecting to the default tenant. ' +
          'If a named tenant was intended, set agentHubBridge.tenant before starting.'
      );
    }

    let auth: AuthContext;
    try {
      auth = await resolveAuth(this.cfg, this.loginResolver);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[ERR] auth: ${msg}`);
      throw err;
    }

    this.currentAuth = auth;
    this.log(
      `auth: mode=${auth.mode} user=${auth.userId} tenant=${this.cfg.tenant || '(default)'} hub=${this.cfg.url}`
    );

    // First connect attempt happens synchronously so start() can reject on
    // configuration / network errors. Subsequent reconnects fire-and-forget.
    this.running = true;
    this.abortController = new AbortController();
    try {
      const sessionId = await this.initialize(auth);
      this.currentSessionId = sessionId;
      await this.notifyInitialized(auth, sessionId);
      await this.subscribe(auth, sessionId);
      this.currentMode = 'subscribed';
      this.log(
        `subscribed: inbox://@${auth.userId} (sessionId=${sessionId.slice(0, 8)}...) — waiting for pushes`
      );
    } catch (err) {
      this.running = false;
      this.abortController = undefined;
      this.currentMode = 'idle';
      this.currentSessionId = null;
      this.currentAuth = null;
      throw err;
    }

    // Fire-and-forget loop; reconnects on disconnect / error.
    void this.runLoop(auth);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    this.currentMode = 'idle';
    this.currentSessionId = null;
    this.currentAuth = null;
    this.log('stop: watcher halted');
  }

  dispose(): void {
    void this.stop();
    this.emitter.dispose();
  }

  // ─── internal ────────────────────────────────────────────────────────────

  private async runLoop(initialAuth: AuthContext): Promise<void> {
    const auth = initialAuth;
    let sessionId = this.currentSessionId;
    let backoffMs = RECONNECT_BACKOFF_START_MS;
    while (this.running) {
      try {
        if (!sessionId) {
          // Re-establish session after a disconnect.
          this.currentMode = 'connecting';
          sessionId = await this.initialize(auth);
          this.currentSessionId = sessionId;
          await this.notifyInitialized(auth, sessionId);
          await this.subscribe(auth, sessionId);
          this.currentMode = 'subscribed';
          this.log(
            `subscribed: inbox://@${auth.userId} (sessionId=${sessionId.slice(0, 8)}..., re-established)`
          );
        }
        // Re-subscribed successfully → reset the back-off so a transient
        // blip after a long stable run doesn't immediately wait the full
        // 60s cap on its next failure.
        backoffMs = RECONNECT_BACKOFF_START_MS;
        await this.streamSse(auth, sessionId);
        // streamSse returning without throw == stop() invoked.
      } catch (err) {
        if (!this.running) {
          break;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`[reconnect] ${msg} — retry in ${Math.round(backoffMs / 1000)}s`);
        this.currentMode = 'reconnecting';
        this.currentSessionId = null;
        sessionId = null;
        await sleep(backoffMs);
        backoffMs = nextBackoffMs(backoffMs);
      }
    }
    this.currentMode = 'idle';
    this.currentSessionId = null;
    this.currentAuth = null;
  }

  private async initialize(auth: AuthContext): Promise<string> {
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        ...auth.headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'agent-hub-bridge-vscode', version: '0.0.1' },
        },
        id: 0,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`initialize failed: HTTP ${res.status}`);
    }
    const sid = res.headers.get('mcp-session-id');
    // Drain the body so the underlying connection can be reused / closed
    // cleanly. We don't need its contents — the session id is in the headers.
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    if (!sid) {
      throw new Error('initialize failed: mcp-session-id header missing in response');
    }
    return sid;
  }

  private async notifyInitialized(auth: AuthContext, sid: string): Promise<void> {
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        ...auth.headers,
        'mcp-session-id': sid,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
      signal: AbortSignal.timeout(5_000),
    });
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    // Notifications have no response body to validate per MCP; we don't
    // assert res.ok here for parity with watch.sh which fires-and-forgets.
  }

  private async subscribe(auth: AuthContext, sid: string): Promise<void> {
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        ...auth.headers,
        'mcp-session-id': sid,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'resources/subscribe',
        params: { uri: `inbox://@${auth.userId}` },
        id: 1,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`subscribe failed: HTTP ${res.status} ${body}`);
    }
    if (body.includes('"error"')) {
      throw new Error(`subscribe failed: ${body}`);
    }
  }

  private async streamSse(auth: AuthContext, sid: string): Promise<void> {
    const res = await fetch(this.cfg.url, {
      method: 'GET',
      headers: {
        ...auth.headers,
        'mcp-session-id': sid,
        Accept: 'text/event-stream',
      },
      signal: this.abortController?.signal,
    });
    if (!res.ok) {
      throw new Error(`SSE GET failed: HTTP ${res.status}`);
    }
    const body = res.body;
    if (!body) {
      throw new Error('SSE GET failed: response has no body');
    }
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';

    try {
      while (this.running) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error('SSE stream closed by server');
        }
        buf += decoder.decode(value, { stream: true });

        // SSE is line-based, terminated by `\n` (and a blank line per event).
        // The agent-hub server emits one JSON object per `data:` line for
        // notifications, so a per-line scan (matching watch.sh's grep) is
        // sufficient — no need to fully buffer multi-line events.
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const rawLine = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          this.handleSseLine(line);
          nl = buf.indexOf('\n');
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore — already aborted or closed */
      }
    }
  }

  private handleSseLine(line: string): void {
    if (!line.startsWith('data:')) {
      return;
    }
    const dataStr = line.slice(5).trimStart();
    if (!dataStr || dataStr === '[DONE]') {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      return; // ignore non-JSON keepalives or partial payloads
    }
    if (!isResourceUpdatedNotification(parsed)) {
      return;
    }
    const uri = parsed.params.uri;
    this.log(`[NEW] ${uri}`);
    this.emitter.fire({ uri, receivedAt: new Date() });
  }
}

function isResourceUpdatedNotification(
  value: unknown
): value is { method: 'notifications/resources/updated'; params: { uri: string } } {
  if (!value || typeof value !== 'object') return false;
  const v = value as { method?: unknown; params?: unknown };
  if (v.method !== 'notifications/resources/updated') return false;
  if (!v.params || typeof v.params !== 'object') return false;
  const uri = (v.params as { uri?: unknown }).uri;
  return typeof uri === 'string' && uri.length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
