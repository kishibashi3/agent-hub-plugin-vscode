// Unit tests for RelayTracker (issue #32).
//
// No VS Code shim required — RelayTracker is vscode-free.
// Run with: npm test (tsx --test tests/**/*.test.ts)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RelayTracker, RelayTimeout } from '../src/relayTracker';
import type { IncomingMessage } from '../src/relayTracker';

/** Minimal IncomingMessage fixture. */
function makeMsg(sender: string, body = 'hello'): IncomingMessage {
  return { id: `msg-${Math.random().toString(36).slice(2)}`, sender, body } as IncomingMessage;
}

describe('RelayTracker', () => {
  it('tryResolve returns false when no waiter is registered', () => {
    const tracker = new RelayTracker();
    const msg = makeMsg('@reviewer');
    assert.equal(tracker.tryResolve(msg), false);
  });

  it('tryResolve returns true and resolves the waiter for the matching sender', async () => {
    const tracker = new RelayTracker();
    const msg = makeMsg('@reviewer', 'LGTM ✅');
    const promise = tracker.waitFor('@reviewer', 1_000);
    const resolved = tracker.tryResolve(msg);
    assert.equal(resolved, true);
    const result = await promise;
    assert.equal(result.body, 'LGTM ✅');
  });

  it('tryResolve returns false for a non-matching sender', async () => {
    const tracker = new RelayTracker();
    const promise = tracker.waitFor('@reviewer', 1_000);
    const unrelated = makeMsg('@planner', 'something else');
    assert.equal(tracker.tryResolve(unrelated), false);
    // Still pending — resolve it to avoid timer leak in test
    tracker.tryResolve(makeMsg('@reviewer'));
    await promise;
  });

  it('rejects with RelayTimeout when no message arrives before the deadline', async () => {
    const tracker = new RelayTracker();
    const promise = tracker.waitFor('@reviewer', 30); // 30 ms — fast timeout for test
    await assert.rejects(promise, (err: unknown) => {
      assert.ok(err instanceof RelayTimeout, 'should be RelayTimeout');
      assert.match(err.message, /@reviewer/);
      assert.equal(err.name, 'RelayTimeout');
      return true;
    });
  });

  it('cleans up the pending entry after timeout', async () => {
    const tracker = new RelayTracker();
    const promise = tracker.waitFor('@reviewer', 30);
    try { await promise; } catch { /* expected timeout */ }
    assert.equal(tracker.size, 0);
  });

  it('cleans up the pending entry after resolution', async () => {
    const tracker = new RelayTracker();
    const promise = tracker.waitFor('@reviewer', 1_000);
    tracker.tryResolve(makeMsg('@reviewer'));
    await promise;
    assert.equal(tracker.size, 0);
  });

  it('FIFO: resolves two concurrent waiters for the same sender in order', async () => {
    const tracker = new RelayTracker();
    const p1 = tracker.waitFor('@reviewer', 1_000);
    const p2 = tracker.waitFor('@reviewer', 1_000);
    const first = makeMsg('@reviewer', 'first reply');
    const second = makeMsg('@reviewer', 'second reply');
    tracker.tryResolve(first);
    tracker.tryResolve(second);
    const r1 = await p1;
    const r2 = await p2;
    assert.equal(r1.body, 'first reply');
    assert.equal(r2.body, 'second reply');
  });

  it('different senders do not interfere with each other', async () => {
    const tracker = new RelayTracker();
    const pReviewer = tracker.waitFor('@reviewer', 1_000);
    const pPlanner = tracker.waitFor('@planner', 1_000);
    tracker.tryResolve(makeMsg('@planner', 'from planner'));
    tracker.tryResolve(makeMsg('@reviewer', 'from reviewer'));
    const rReviewer = await pReviewer;
    const rPlanner = await pPlanner;
    assert.equal(rReviewer.body, 'from reviewer');
    assert.equal(rPlanner.body, 'from planner');
  });

  it('size reflects the current number of pending waiters', async () => {
    const tracker = new RelayTracker();
    assert.equal(tracker.size, 0);
    const p1 = tracker.waitFor('@reviewer', 1_000);
    assert.equal(tracker.size, 1);
    const p2 = tracker.waitFor('@reviewer', 1_000);
    assert.equal(tracker.size, 2);
    tracker.tryResolve(makeMsg('@reviewer'));
    assert.equal(tracker.size, 1);
    tracker.tryResolve(makeMsg('@reviewer'));
    assert.equal(tracker.size, 0);
    await p1;
    await p2;
  });

  it('a timed-out waiter does not consume a subsequent tryResolve', async () => {
    const tracker = new RelayTracker();
    const p1 = tracker.waitFor('@reviewer', 30); // will time out
    // Let it time out
    await assert.rejects(p1, RelayTimeout);
    // Register a fresh waiter
    const p2 = tracker.waitFor('@reviewer', 1_000);
    tracker.tryResolve(makeMsg('@reviewer', 'late reply'));
    const r2 = await p2;
    assert.equal(r2.body, 'late reply');
    assert.equal(tracker.size, 0);
  });
});
