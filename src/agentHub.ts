// SSE inbox watcher (vscode-bound half).
//
// The vscode-free half — types, constants, pure helpers, and the
// `resolveAuth` 3-mode triage — lives in `./protocol.ts` and is
// re-exported here so existing call sites (`import {…} from './agentHub'`)
// keep working unchanged. This module's only original content is the
// `InboxWatcher` class itself, which uses `vscode.EventEmitter` to fan
// out `notifications/resources/updated` to subscribers.
//
// As of issue #21 the MCP-tools wrapper that used to live alongside
// (`AgentHubClient`) has been retired in favour of the SDK's
// `HubSession` (`@kishibashi3/agent-hub-sdk`) constructed via a thin
// `McpClient` adapter (`./mcpClient`). The wire protocol is unchanged;
// the SDK gives us typed `IncomingMessage` / `Participant` plus
// `PeerNotFoundError` / `HubTransientError` classification for free.
//
// Original behaviour mirrors
// `kishibashi3-plugins-claude/plugins/agent-hub-plugin/skills/agent-hub/scripts/watch.sh`:
//
//   1. POST `initialize`              → extract `mcp-session-id` header
//   2. POST `notifications/initialized`
//   3. POST `resources/subscribe` for `inbox://@<user>`
//   4. GET  `/mcp` with `Accept: text/event-stream` → long-lived stream
//   5. Parse `data:` lines, emit on `notifications/resources/updated`
//   6. On disconnect or error, reconnect with exponential back-off
//      (3 s → 6 s → 12 s → … capped at 60 s, reset on every successful
//      re-subscribe).

import * as vscode from 'vscode';

import {
  HubSession,
  type Config as SdkConfig,
} from '@kishibashi3/agent-hub-sdk';

import { createVscodeFetchMcpClient } from './mcpClient';
import {
  type AuthContext,
  type BridgeConfig,
  isDefaultLocalhostUrl,
  type InboxMessageNotification,
  LOCALHOST_DEFAULT_URL,
  type LoginResolver,
  nextBackoffMs,
  RECONNECT_BACKOFF_START_MS,
  resolveAuth,
  type WatcherMode,
  type WatcherState,
} from './protocol';

// Re-exports for public surface compatibility — pre-split call sites
// (`import { foo } from './agentHub'`) keep resolving. The hand-rolled
// `InboxMessage` bridge-local type is gone (issue #21): consumers
// import `IncomingMessage` from `@kishibashi3/agent-hub-sdk` directly
// (= `sender`/`body` field names match the SDK contract).
export {
  type AuthContext,
  type AuthMode,
  type BridgeConfig,
  extractJsonRpcResponse,
  extractTextContent,
  type InboxMessageNotification,
  isDefaultLocalhostUrl,
  LOCALHOST_DEFAULT_URL,
  type LoginResolver,
  nextBackoffMs,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_START_MS,
  resolveAuth,
  type WatcherMode,
  type WatcherState,
} from './protocol';

type Logger = (msg: string) => void;

/**
 * Long-lived inbox watcher. Owns one MCP session + one SSE stream and
 * reconnects on failure (exponential back-off, see `./protocol.ts`).
 *
 * Public surface kept intentionally tiny:
 *   - `start()` / `stop()` / `dispose()`
 *   - `state` snapshot for the status command
 *   - `onMessage` event for downstream consumers
 *   - `session` accessor that returns the SDK `HubSession` bound to
 *     the *current* MCP session (or `null` when not subscribed)
 */
export class InboxWatcher {
  private running = false;
  private abortController?: AbortController;
  private currentSessionId: string | null = null;
  private currentMode: WatcherMode = 'idle';
  private currentAuth: AuthContext | null = null;
  private currentSession: HubSession | null = null;
  private readonly emitter = new vscode.EventEmitter<InboxMessageNotification>();
  readonly onMessage: vscode.Event<InboxMessageNotification> = this.emitter.event;
  private readonly loginResolver: LoginResolver | undefined;

  constructor(
    private readonly cfg: BridgeConfig,
    private readonly log: Logger,
    loginResolver?: LoginResolver
  ) {
    // Threaded through `resolveAuth` below so an end-to-end test (or a
    // mocked GitHub backend) can inject a deterministic login without
    // hitting api.github.com.
    this.loginResolver = loginResolver;
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
   * The SDK `HubSession` bound to the watcher's *current* MCP session,
   * or `null` when the watcher is idle / reconnecting / pre-subscribe.
   *
   * Callers should re-read this property on each operation so that a
   * concurrent reconnect (= which mints a fresh session id, discards
   * the old `HubSession`, and binds a new one) is observed naturally
   * rather than via a long-lived stale reference. The `HubSession`
   * itself is just a typed facade around `MCP::tools/call`; the live
   * `(url, auth, sessionId)` triple is captured inside the underlying
   * `McpClient` closure (see `./mcpClient`).
   */
  get session(): HubSession | null {
    return this.currentSession;
  }

  /**
   * Build the SDK `Config` for the *current* MCP session. Called on
   * every successful subscribe (initial start + each reconnect) so the
   * `HubSession` reflects fresh `(auth, sessionId)`.
   *
   * `pat` is set to the bridge's stored PAT when available — otherwise
   * `''` so the (readonly, never-null) `Config.pat` field is satisfied
   * without lying about the value. The factory's closure carries the
   * actual `auth.headers` used at the HTTP layer, so this string is
   * never read by `callTool`; it's only here for surface-level
   * consistency with the SDK interface. `trust`-mode bridges therefore
   * see `Config.pat === ''` if anyone introspects.
   */
  private bindSession(auth: AuthContext, sessionId: string): void {
    const sdkConfig: SdkConfig = {
      user: auth.userId,
      // Surface a human-readable name in `get_participants` so operators
      // can confirm the bridge is live without inspecting raw user IDs.
      // "VS Code bridge" is intentionally generic — a future config key
      // (`agentHubBridge.displayName`) can override this if needed.
      displayName: 'VS Code bridge',
      mode: 'stateful',
      tenant: this.cfg.tenant || null,
      url: this.cfg.url,
      pat: this.cfg.githubPat ?? '',
    };
    const client = createVscodeFetchMcpClient(this.cfg.url, auth, sessionId);
    this.currentSession = new HubSession(client, sdkConfig);
  }

  /**
   * Register (or re-register) the bridge in the agent-hub participant
   * registry so it appears in `get_participants`.
   *
   * Called once after the initial subscribe and once after each reconnect
   * because a server restart wipes the in-memory registry. Failures are
   * non-fatal — the watcher continues running; the bridge is simply not
   * visible in `get_participants` until the next successful re-register.
   */
  private async registerSelf(context: string): Promise<void> {
    if (!this.currentSession) {
      return;
    }
    try {
      await this.currentSession.register();
      this.log(`[register] visible in get_participants (${context})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[WARN] register failed (${context}): ${msg} — bridge may be invisible in get_participants`);
    }
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
      auth = this.loginResolver
        ? await resolveAuth(this.cfg, this.loginResolver)
        : await resolveAuth(this.cfg);
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
      // Bind a fresh `HubSession` to the just-subscribed `sessionId`.
      // `LmDispatcher` reads `watcher.session` on every drain, so this
      // takes effect immediately for the first batch of tool calls.
      this.bindSession(auth, sessionId);
      this.log(
        `subscribed: inbox://@${auth.userId} (sessionId=${sessionId.slice(0, 8)}...) — waiting for pushes`
      );
      // Register in the participant registry so the bridge appears in
      // `get_participants`. Non-fatal: see `registerSelf` doc-comment.
      await this.registerSelf('initial start');
    } catch (err) {
      this.running = false;
      this.abortController = undefined;
      this.currentMode = 'idle';
      this.currentSessionId = null;
      this.currentAuth = null;
      this.currentSession = null;
      throw err;
    }

    // Fire-and-forget loop; reconnects on disconnect / error.
    void this.runLoop(auth);
  }

  /*
   * Keep the Promise return type so callers can `await w.stop()`
   * consistently; the body is synchronous today but the abort + future
   * cleanup could grow async work (e.g. flushing an in-flight tool
   * call) without changing this signature.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    this.currentMode = 'idle';
    this.currentSessionId = null;
    this.currentAuth = null;
    this.currentSession = null;
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
          // Rebind the SDK `HubSession` to the freshly-minted MCP
          // session id (= old session, with its captured closure, is
          // discarded). `LmDispatcher` re-reads `watcher.session` per
          // drain, so the next call lands on the new session.
          this.bindSession(auth, sessionId);
          this.log(
            `subscribed: inbox://@${auth.userId} (sessionId=${sessionId.slice(0, 8)}..., re-established)`
          );
          // Re-register after reconnect: the server's in-memory registry
          // is wiped on restart, so an earlier registration may no longer
          // be present. Non-fatal: see `registerSelf` doc-comment.
          await this.registerSelf('reconnect');
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
        // Drop the stale `HubSession` while we're disconnected so any
        // caller reading `watcher.session` during the backoff window
        // gets `null` (= "skipping drain", logged by `LmDispatcher`)
        // rather than firing tool calls against a dead session id.
        this.currentSession = null;
        sessionId = null;
        await sleep(backoffMs);
        backoffMs = nextBackoffMs(backoffMs);
      }
    }
    this.currentMode = 'idle';
    this.currentSessionId = null;
    this.currentAuth = null;
    this.currentSession = null;
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
    // Narrow the reader type so the destructure of `read()` returns a
    // typed `Uint8Array` chunk — `body.getReader()` is generic and some
    // lib.dom.d.ts versions widen `value` to `any`, which trips the
    // type-aware no-unsafe-* rules.
    const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder('utf-8');
    let buf = '';

    try {
      while (this.running) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error('SSE stream closed by server');
        }
        buf += decoder.decode(chunk.value, { stream: true });

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
