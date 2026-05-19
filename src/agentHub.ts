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

/**
 * Long-lived inbox watcher. Owns one MCP session + one SSE stream and
 * reconnects on failure (3s backoff, matching watch.sh).
 *
 * Public surface kept intentionally tiny:
 *   - `start()` / `stop()` / `dispose()`
 *   - `state` snapshot for the status command
 *   - `onMessage` event for downstream consumers
 */
export class InboxWatcher {
  private running = false;
  private abortController?: AbortController;
  private currentSessionId: string | null = null;
  private currentMode: WatcherMode = 'idle';
  private currentAuthMode: AuthMode | null = null;
  private currentUserId: string | null = null;
  private readonly emitter = new vscode.EventEmitter<InboxMessageNotification>();
  readonly onMessage: vscode.Event<InboxMessageNotification> = this.emitter.event;

  constructor(
    private readonly cfg: BridgeConfig,
    private readonly log: Logger
  ) {}

  get state(): WatcherState {
    return {
      running: this.running,
      mode: this.currentMode,
      sessionId: this.currentSessionId,
      authMode: this.currentAuthMode,
      userId: this.currentUserId,
    };
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
      auth = await resolveAuth(this.cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[ERR] auth: ${msg}`);
      throw err;
    }

    this.currentAuthMode = auth.mode;
    this.currentUserId = auth.userId;
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
    this.log('stop: watcher halted');
  }

  dispose(): void {
    void this.stop();
    this.emitter.dispose();
  }

  // ─── internal ────────────────────────────────────────────────────────────

  private async runLoop(initialAuth: AuthContext): Promise<void> {
    let auth = initialAuth;
    let sessionId = this.currentSessionId;
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
        await this.streamSse(auth, sessionId);
        // streamSse returning without throw == stop() invoked.
      } catch (err) {
        if (!this.running) {
          break;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`[reconnect] ${msg} — retry in 3s`);
        this.currentMode = 'reconnecting';
        this.currentSessionId = null;
        sessionId = null;
        await sleep(3_000);
      }
    }
    this.currentMode = 'idle';
    this.currentSessionId = null;
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
