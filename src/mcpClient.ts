// `McpClient` adapter that talks to agent-hub via the existing
// hand-rolled fetch transport (the same wire format `./agentHub.ts`'s
// `InboxWatcher` uses for `initialize` / `notifications/initialized` /
// `resources/subscribe` / SSE long-poll). Lets bridge-vscode consume
// the typed `HubSession` surface from `@kishibashi3/agent-hub-sdk`
// without dragging in `@modelcontextprotocol/sdk` (= keeps the .vsix
// bundle small and the SSE+reconnect loop under our direct control).
//
// Wiring (see `./agentHub.ts` for the lifecycle owner):
//
//   1. `InboxWatcher.start` resolves auth + opens the session (POST
//      `initialize`, `notifications/initialized`, `resources/subscribe`)
//      using its own raw fetch calls.
//   2. After subscribe succeeds, it builds an `McpClient` via
//      `createVscodeFetchMcpClient(url, auth, sessionId)` — the closure
//      captures the live `(url, auth, sessionId)` triple.
//   3. The watcher then constructs a fresh `HubSession(client, config)`
//      and exposes it via `watcher.session`. `LmDispatcher` reads
//      `watcher.session` per call so a reconnect (which mints a new
//      sessionId → new client → new HubSession) is observed naturally.
//
// Only `callTool` does real work. `initialize`/`close` are no-ops here
// because lifecycle is owned by the watcher; `subscribeResource` is
// inlined into the watcher's `subscribe` step; `listTools` is a stub
// (= bridge-vscode doesn't use `HubSession.heartbeat`); and
// `setNotificationHandler` is intentionally inert — the watcher fans
// SSE notifications out via its own `vscode.EventEmitter`, bypassing
// the SDK's push queue. If a future feature needs the SDK queue, we'd
// register the handler here and have the SSE parser fire it; for now
// the simpler EventEmitter wiring is preserved.

import type {
  McpClient,
  McpNotification,
  ToolResult,
} from '@kishibashi3/agent-hub-sdk';

import type { AuthContext } from './protocol';
import { extractJsonRpcResponse } from './protocol';

/**
 * Per-`callTool` HTTP timeout. Matches the value the pre-SDK
 * `AgentHubClient.callTool` used (= 30s).
 */
const CALL_TOOL_TIMEOUT_MS = 30_000;

/**
 * Build a thin `McpClient` bound to a live `(url, auth, sessionId)`
 * triple. The closure captures the triple so callers don't have to
 * thread it through `callTool` arguments — the SDK only passes the
 * resolved `Config` to the factory, which doesn't carry the live
 * session id by design.
 *
 * Reconnect semantics: this function is called once per *successful
 * subscribe*. The watcher discards the old client when it mints a new
 * session id (= reconnect path in `runLoop`) and constructs a fresh
 * one. So the captured `sessionId` is always fresh — no stale-id
 * defence is needed here.
 */
export function createVscodeFetchMcpClient(
  url: string,
  auth: AuthContext,
  sessionId: string
): McpClient {
  // `tools/call` JSON-RPC ids. Starts at 100 to stay clear of the
  // initialize (id=0) and resources/subscribe (id=1) ids that
  // `InboxWatcher` already reserved on the same session.
  let nextId = 100;

  return {
    async initialize(): Promise<void> {
      // No-op. `InboxWatcher.initialize` (POST initialize +
      // notifications/initialized) ran before this client was even
      // constructed. Re-running it would mint a stale session.
    },

    async close(): Promise<void> {
      // No-op. The MCP session is owned by `InboxWatcher.stop` /
      // `dispose`; closing here would race the watcher's abort
      // controller and produce confusing "stream closed by server"
      // logs that don't reflect a real disconnect.
    },

    async callTool(
      name: string,
      args: Record<string, unknown>
    ): Promise<ToolResult> {
      const id = nextId++;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...auth.headers,
          'mcp-session-id': sessionId,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name, arguments: args },
          id,
        }),
        signal: AbortSignal.timeout(CALL_TOOL_TIMEOUT_MS),
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
        // `response.error` is `unknown`. `JSON.stringify` is the safe
        // stringifier for both primitive and structured payloads —
        // primitives stringify as their literal, objects as JSON.
        // `String(err)` would yield "[object Object]" for the object
        // case. Same convention as the pre-SDK `AgentHubClient`.
        throw new Error(`tools/call ${name}: ${JSON.stringify(response.error)}`);
      }
      // `response.result` is the MCP `CallToolResult` shape
      // (`{ content: [...], isError?: ... }`), which is exactly the
      // SDK's `ToolResult` interface. The SDK's `HubSession` methods
      // (`send` / `getUnread` / `ack` / ...) read `content`/`isError`
      // and rethrow via `raiseForSendError` / `raiseForToolError`.
      return response.result as ToolResult;
    },

    async subscribeResource(_uri: string): Promise<void> {
      // No-op. `InboxWatcher.subscribe` already issued
      // `resources/subscribe` for `inbox://@<user>` during start /
      // reconnect. Re-issuing it here would be redundant and could
      // race the watcher's own subscribe accounting.
    },

    // Stub: bridge-vscode does not call `HubSession.heartbeat`
    // (= the SDK feature that probes liveness via list_tools); the
    // long-lived SSE GET is itself the liveness signal. Returning a
    // resolved `{}` keeps the interface satisfied without surfacing
    // a fake tool list to anything that might inspect this.
    // Using `Promise.resolve(...)` instead of `async () => {}` to
    // avoid the eslint `require-await` (= async function with no
    // await is a smell elsewhere; here it's deliberate).
    listTools(): Promise<unknown> {
      return Promise.resolve({});
    },

    setNotificationHandler(_handler: (n: McpNotification) => void): void {
      // No-op. bridge-vscode's `InboxWatcher` parses SSE lines itself
      // (see `handleSseLine` in `./agentHub.ts`) and fans them out
      // through a `vscode.EventEmitter` so VS Code consumers can
      // subscribe with the platform-native Disposable contract. The
      // SDK's push queue (= what this handler would feed) is therefore
      // unused. If we later swap to `HubSession.inboxPushes()` for
      // dispatch, this becomes the wire point.
    },
  };
}
