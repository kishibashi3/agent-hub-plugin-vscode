// Unit tests for RelayTracker (issue #45).
// Runs with plain node:test via tsx — no VS Code shim required.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RelayTracker, RelayTimeout } from '../src/relayTracker';
import type { IncomingMessage } from '@kishibashi3/agent-hub-sdk';

/** Minimal IncomingMessage stub. */
function msg(sender: string, body = 'hello', id = '1'): IncomingMessage {
  return { id, sender, body, timestamp: new Date().toISOString() } as IncomingMessage;
}

describe('RelayTracker', () => {
  it('tryResolve returns false when no waiter is registered', () => {
    const tracker = new RelayTracker();
    assert.equal(tracker.tryResolve(msg('alice')), false);
    tracker.dispose();
  });

  it('waitFor resolves when tryResolve is called with the matching sender', async () => {
    const tracker = new RelayTracker();
    const promise = tracker.waitFor('alice', 5_000);
    const m = msg('alice', 'hi');
    const resolved = tracker.tryResolve(m);
    assert.equal(resolved, true);
    const result = await promise;
    assert.equal(result.body, 'hi');
    tracker.dispose();
  });

  it('tryResolve returns false for a different sender than the registered waiter', async () => {
    const tracker = new RelayTracker();
    // Suppress the unhandled rejection from the alice waiter being cancelled.
    const aliceWait = tracker.waitFor('alice', 5_000).catch(() => {});
    assert.equal(tracker.tryResolve(msg('bob')), false);
    tracker.dispose(); // cancels alice waiter
    await aliceWait;
  });

  it('waitFor rejects with RelayTimeout when the window expires', async () => {
    const tracker = new RelayTracker();
    const promise = tracker.waitFor('alice', 10); // 10 ms — fires quickly
    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof RelayTimeout);
      assert.equal(err.sender, 'alice');
      return true;
    });
    tracker.dispose();
  });

  it('RelayTimeout.name is "RelayTimeout"', async () => {
    const tracker = new RelayTracker();
    const promise = tracker.waitFor('alice', 10);
    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof RelayTimeout);
      assert.equal(err.name, 'RelayTimeout');
      return true;
    });
    tracker.dispose();
  });

  it('a second waitFor for the same sender cancels the first', async () => {
    const tracker = new RelayTracker();
    const first = tracker.waitFor('alice', 5_000);
    const second = tracker.waitFor('alice', 5_000);
    // first should have been cancelled (rejected) by the second waitFor
    await assert.rejects(first, (err) => err instanceof RelayTimeout);
    // second should still be pending — resolve it
    tracker.tryResolve(msg('alice', 'second reply'));
    const result = await second;
    assert.equal(result.body, 'second reply');
    tracker.dispose();
  });

  it('dispose cancels all pending waiters', async () => {
    const tracker = new RelayTracker();
    const p1 = tracker.waitFor('alice', 5_000);
    const p2 = tracker.waitFor('bob', 5_000);
    tracker.dispose();
    await assert.rejects(p1, (err) => err instanceof RelayTimeout);
    await assert.rejects(p2, (err) => err instanceof RelayTimeout);
  });

  it('tryResolve after dispose returns false (no waiters)', async () => {
    const tracker = new RelayTracker();
    const aliceWait = tracker.waitFor('alice', 5_000).catch(() => {});
    tracker.dispose();
    await aliceWait;
    assert.equal(tracker.tryResolve(msg('alice')), false);
  });
});
