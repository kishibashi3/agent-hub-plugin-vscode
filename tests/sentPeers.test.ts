// Unit tests for SentPeers (issue #32).
//
// No VS Code shim required — SentPeers is vscode-free.
// Run with: npm test (tsx --test tests/**/*.test.ts)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SentPeers } from '../src/sentPeers';

describe('SentPeers', () => {
  it('has() returns false for an unregistered handle', () => {
    const peers = new SentPeers();
    assert.equal(peers.has('@reviewer'), false);
  });

  it('has() returns true after add()', () => {
    const peers = new SentPeers();
    peers.add('@reviewer');
    assert.equal(peers.has('@reviewer'), true);
  });

  it('add() is idempotent — adding the same handle twice is a no-op', () => {
    const peers = new SentPeers();
    peers.add('@reviewer');
    peers.add('@reviewer');
    assert.equal(peers.size, 1);
    assert.equal(peers.has('@reviewer'), true);
  });

  it('tracks multiple handles independently', () => {
    const peers = new SentPeers();
    peers.add('@reviewer');
    peers.add('@planner');
    assert.equal(peers.has('@reviewer'), true);
    assert.equal(peers.has('@planner'), true);
    assert.equal(peers.has('@writer'), false);
    assert.equal(peers.size, 2);
  });

  it('delete() removes a registered handle', () => {
    const peers = new SentPeers();
    peers.add('@reviewer');
    peers.delete('@reviewer');
    assert.equal(peers.has('@reviewer'), false);
    assert.equal(peers.size, 0);
  });

  it('delete() on an unregistered handle is a no-op', () => {
    const peers = new SentPeers();
    peers.delete('@nobody');
    assert.equal(peers.size, 0);
  });

  it('clear() removes all handles', () => {
    const peers = new SentPeers();
    peers.add('@reviewer');
    peers.add('@planner');
    peers.clear();
    assert.equal(peers.size, 0);
    assert.equal(peers.has('@reviewer'), false);
    assert.equal(peers.has('@planner'), false);
  });

  it('size reflects the number of registered handles', () => {
    const peers = new SentPeers();
    assert.equal(peers.size, 0);
    peers.add('@a');
    assert.equal(peers.size, 1);
    peers.add('@b');
    assert.equal(peers.size, 2);
    peers.delete('@a');
    assert.equal(peers.size, 1);
  });
});
