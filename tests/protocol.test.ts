// Unit tests for the vscode-free protocol layer.
//
// Uses Node's built-in `node:test` runner via `tsx` (no test framework
// installed). Targets every export of `../src/protocol.ts` that the
// dispatcher and watcher rely on for correctness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractJsonRpcResponse,
  extractTextContent,
  isDefaultLocalhostUrl,
  LOCALHOST_DEFAULT_URL,
  nextBackoffMs,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_START_MS,
  resolveAuth,
  type BridgeConfig,
} from '../src/protocol';

describe('isDefaultLocalhostUrl', () => {
  it('returns true for the canonical default URL', () => {
    assert.equal(isDefaultLocalhostUrl(LOCALHOST_DEFAULT_URL), true);
  });

  it('returns false for any override (different host, port, path, or scheme)', () => {
    assert.equal(isDefaultLocalhostUrl('https://hub.example.com/mcp'), false);
    assert.equal(isDefaultLocalhostUrl('http://localhost:4000/mcp'), false);
    assert.equal(isDefaultLocalhostUrl('http://localhost:3000/'), false);
    assert.equal(isDefaultLocalhostUrl(''), false);
  });
});

describe('nextBackoffMs', () => {
  it('doubles the current value while below the cap', () => {
    assert.equal(nextBackoffMs(RECONNECT_BACKOFF_START_MS), 6_000);
    assert.equal(nextBackoffMs(6_000), 12_000);
    assert.equal(nextBackoffMs(12_000), 24_000);
    assert.equal(nextBackoffMs(24_000), 48_000);
  });

  it('clamps at RECONNECT_BACKOFF_MAX_MS', () => {
    assert.equal(nextBackoffMs(48_000), RECONNECT_BACKOFF_MAX_MS);
  });

  it('stays at the cap when called repeatedly after clamping', () => {
    assert.equal(nextBackoffMs(RECONNECT_BACKOFF_MAX_MS), RECONNECT_BACKOFF_MAX_MS);
  });
});

describe('extractJsonRpcResponse', () => {
  const baseId = 42;

  it('parses a plain-JSON body with the matching id', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: baseId, result: { ok: true } });
    const r = extractJsonRpcResponse(body, baseId);
    assert.ok(r);
    assert.deepEqual(r.result, { ok: true });
    assert.equal(r.error, undefined);
  });

  it('returns null when the plain-JSON body has a different id', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 99, result: { ok: true } });
    assert.equal(extractJsonRpcResponse(body, baseId), null);
  });

  it('parses an SSE-framed body and finds the matching id', () => {
    const body =
      ': keepalive\n' +
      'event: message\n' +
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: baseId, result: { hello: 'world' } })}\n` +
      '\n';
    const r = extractJsonRpcResponse(body, baseId);
    assert.ok(r);
    assert.deepEqual(r.result, { hello: 'world' });
  });

  it('skips malformed data lines and finds the matching id later in the stream', () => {
    const body =
      'data: not-json\n' +
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 100, result: 'wrong-id' })}\n` +
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: baseId, result: 'correct-id' })}\n`;
    const r = extractJsonRpcResponse(body, baseId);
    assert.ok(r);
    assert.equal(r.result, 'correct-id');
  });

  it('returns null when no data line matches', () => {
    const body = 'data: not-json\n' + 'data: {"jsonrpc":"2.0","id":1,"result":{}}\n';
    assert.equal(extractJsonRpcResponse(body, baseId), null);
  });

  it('surfaces server-side JSON-RPC errors via the `error` field', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: baseId,
      error: { code: -32_601, message: 'method not found' },
    });
    const r = extractJsonRpcResponse(body, baseId);
    assert.ok(r);
    assert.ok(r.error);
  });
});

describe('extractTextContent', () => {
  it('returns the first text part as a string', () => {
    const result = { content: [{ type: 'text', text: 'hello' }] };
    assert.equal(extractTextContent(result), 'hello');
  });

  it('throws when content is missing or empty', () => {
    assert.throws(() => extractTextContent({}), /non-empty content array/);
    assert.throws(() => extractTextContent({ content: [] }), /non-empty content array/);
    assert.throws(
      () => extractTextContent({ content: null }),
      /non-empty content array/
    );
  });

  it('throws when the first part is not text-typed', () => {
    assert.throws(
      () => extractTextContent({ content: [{ type: 'image', data: 'abc' }] }),
      /first content part to be text/
    );
  });

  it('throws when the first part has a non-string text field', () => {
    assert.throws(
      () => extractTextContent({ content: [{ type: 'text', text: 42 }] }),
      /first content part to be text/
    );
  });
});

describe('resolveAuth', () => {
  const baseCfg: BridgeConfig = {
    url: LOCALHOST_DEFAULT_URL,
    user: '',
    tenant: '',
    githubPat: '',
  };

  it('returns trust mode when only `user` is set', async () => {
    const auth = await resolveAuth({ ...baseCfg, user: 'alice' });
    assert.equal(auth.mode, 'trust');
    assert.equal(auth.userId, 'alice');
    assert.equal(auth.headers['X-User-Id'], 'alice');
    assert.equal(auth.headers['Authorization'], undefined);
  });

  it('returns pat mode when only `githubPat` is set, resolving handle from the injected resolver', async () => {
    const auth = await resolveAuth(
      { ...baseCfg, githubPat: 'ghp_test' },
      async () => 'bob'
    );
    assert.equal(auth.mode, 'pat');
    assert.equal(auth.userId, 'bob');
    assert.equal(auth.headers['Authorization'], 'Bearer ghp_test');
    assert.equal(auth.headers['X-User-Id'], undefined);
  });

  it('returns pat+override mode when both `user` and `githubPat` are set', async () => {
    const auth = await resolveAuth(
      { ...baseCfg, user: 'persona', githubPat: 'ghp_test' },
      async () => 'github-login'
    );
    assert.equal(auth.mode, 'pat+override');
    assert.equal(auth.userId, 'persona');
    assert.equal(auth.headers['Authorization'], 'Bearer ghp_test');
    assert.equal(auth.headers['X-User-Id'], 'persona');
  });

  it('attaches an `X-Tenant-Id` header when `tenant` is set, in every mode', async () => {
    const trust = await resolveAuth({ ...baseCfg, user: 'a', tenant: 't1' });
    assert.equal(trust.headers['X-Tenant-Id'], 't1');
    const pat = await resolveAuth(
      { ...baseCfg, githubPat: 'g', tenant: 't2' },
      async () => 'x'
    );
    assert.equal(pat.headers['X-Tenant-Id'], 't2');
  });

  it('throws when neither `user` nor `githubPat` is set', async () => {
    await assert.rejects(
      () => resolveAuth(baseCfg),
      /run the `agent-hub bridge: Set GitHub PAT` command .*or .*set agentHubBridge\.user/
    );
  });

  it('throws when the PAT resolver returns null (revoked / invalid PAT)', async () => {
    await assert.rejects(
      () => resolveAuth({ ...baseCfg, githubPat: 'ghp_bad' }, async () => null),
      /could not resolve GitHub login/
    );
  });
});

// `resolvePatPrecedence` (and its `PatSource` type) were deleted in 0.4.0
// when the legacy `agentHubBridge.githubPat` setting was removed (issue #15).
// The 8 assertions that used to live here covered the dual-source decision
// table; with only `SecretStorage` as a PAT source, no precedence logic
// remains to test.
