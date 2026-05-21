// Unit tests for agentHubMcpProviderCore helpers (issue #53).
//
// The three helpers (`buildAuthHeaders`, `requiresMcpReload`,
// `requiresMcpReloadOnSecretChange`) are extracted to a vscode-free module so
// the auth-header priority logic and the event-fire conditions can be tested
// without a VS Code extension-host shim.
// The vscode-bound wiring (AgentHubMcpProvider class constructor, VS Code
// EventEmitter) is covered by integration/manual testing only.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthHeaders,
  GITHUB_PAT_SECRET_KEY,
  requiresMcpReload,
  requiresMcpReloadOnSecretChange,
} from '../src/agentHubMcpProviderCore';

describe('buildAuthHeaders', () => {
  // ── PAT mode ───────────────────────────────────────────────────────────────

  it('sets Authorization: Bearer when PAT is provided', () => {
    const h = buildAuthHeaders('ghp_abc123', '', '');
    assert.equal(h['Authorization'], 'Bearer ghp_abc123');
  });

  it('does not set X-User-Id when PAT is provided (PAT takes priority)', () => {
    const h = buildAuthHeaders('ghp_abc123', '@user', '');
    assert.equal(h['Authorization'], 'Bearer ghp_abc123');
    assert.equal(h['X-User-Id'], undefined);
  });

  // ── Trust mode ─────────────────────────────────────────────────────────────

  it('sets X-User-Id when only user is provided (trust mode)', () => {
    const h = buildAuthHeaders('', '@ope-ultp1635', '');
    assert.equal(h['X-User-Id'], '@ope-ultp1635');
  });

  it('does not set Authorization when only user is provided', () => {
    const h = buildAuthHeaders('', '@user', '');
    assert.equal(h['Authorization'], undefined);
  });

  // ── No-auth mode ───────────────────────────────────────────────────────────

  it('returns empty headers when neither PAT nor user is set', () => {
    const h = buildAuthHeaders('', '', '');
    assert.deepEqual(h, {});
  });

  // ── Tenant header ──────────────────────────────────────────────────────────

  it('adds X-Tenant-Id when tenant is set (PAT mode)', () => {
    const h = buildAuthHeaders('ghp_token', '', 'acme');
    assert.equal(h['Authorization'], 'Bearer ghp_token');
    assert.equal(h['X-Tenant-Id'], 'acme');
  });

  it('adds X-Tenant-Id when tenant is set (trust mode)', () => {
    const h = buildAuthHeaders('', '@user', 'my-org');
    assert.equal(h['X-User-Id'], '@user');
    assert.equal(h['X-Tenant-Id'], 'my-org');
  });

  it('adds X-Tenant-Id even when no auth is set', () => {
    const h = buildAuthHeaders('', '', 'shared-tenant');
    assert.equal(h['X-Tenant-Id'], 'shared-tenant');
    assert.equal(h['Authorization'], undefined);
    assert.equal(h['X-User-Id'], undefined);
  });

  // ── Return shape ───────────────────────────────────────────────────────────

  it('does not add unexpected keys to the result', () => {
    const h = buildAuthHeaders('ghp_abc', '@user', 'tenant');
    // Only Authorization + X-Tenant-Id (user ignored because PAT wins)
    assert.deepEqual(Object.keys(h).sort(), ['Authorization', 'X-Tenant-Id'].sort());
  });
});

// ── requiresMcpReload ─────────────────────────────────────────────────────────
// Covers path 5: config change → event fire condition.

describe('requiresMcpReload', () => {
  it('returns true when agentHubBridge.url changes', () => {
    assert.equal(requiresMcpReload((key) => key === 'agentHubBridge.url'), true);
  });

  it('returns true when agentHubBridge.user changes', () => {
    assert.equal(requiresMcpReload((key) => key === 'agentHubBridge.user'), true);
  });

  it('returns true when agentHubBridge.tenant changes', () => {
    assert.equal(requiresMcpReload((key) => key === 'agentHubBridge.tenant'), true);
  });

  it('returns false for an unrelated config key', () => {
    assert.equal(requiresMcpReload((key) => key === 'editor.fontSize'), false);
  });

  it('returns false when the predicate always returns false', () => {
    assert.equal(requiresMcpReload(() => false), false);
  });
});

// ── requiresMcpReloadOnSecretChange ───────────────────────────────────────────
// Covers path 6: secret (GitHub PAT) change → event fire condition.

describe('requiresMcpReloadOnSecretChange', () => {
  it('returns true for the GitHub PAT secret key', () => {
    assert.equal(requiresMcpReloadOnSecretChange(GITHUB_PAT_SECRET_KEY), true);
  });

  it('returns false for an unrelated secret key', () => {
    assert.equal(requiresMcpReloadOnSecretChange('some.other.secret'), false);
  });

  it('GITHUB_PAT_SECRET_KEY constant equals the expected key', () => {
    assert.equal(GITHUB_PAT_SECRET_KEY, 'agentHubBridge.githubPat');
  });
});
