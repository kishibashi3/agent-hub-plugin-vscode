// Unit tests for updateStickyHandle (issue #52 / #54).
// Extracted from lmDispatcher.ts so the logic is testable without a VS Code shim.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { updateStickyHandle } from '../src/stickyHandle';
import type { StickyHandleRef } from '../src/stickyHandle';

describe('updateStickyHandle', () => {
  it('sets value on a ref that starts undefined', () => {
    const ref: StickyHandleRef = { value: undefined };
    const changed = updateStickyHandle(ref, '@planner');
    assert.equal(ref.value, '@planner');
    assert.equal(changed, true);
  });

  it('overwrites an existing value with a new sender', () => {
    const ref: StickyHandleRef = { value: '@planner' };
    const changed = updateStickyHandle(ref, '@reviewer');
    assert.equal(ref.value, '@reviewer');
    assert.equal(changed, true);
  });

  it('returns false (no-op) when sender equals current value', () => {
    const ref: StickyHandleRef = { value: '@planner' };
    const changed = updateStickyHandle(ref, '@planner');
    assert.equal(ref.value, '@planner');
    assert.equal(changed, false);
  });

  it('does not mutate other properties of the ref object', () => {
    const ref: StickyHandleRef = { value: undefined };
    updateStickyHandle(ref, '@reviewer');
    // Only `value` should be present; no extra keys added.
    assert.deepEqual(Object.keys(ref), ['value']);
  });

  it('handles handles with special characters', () => {
    const ref: StickyHandleRef = { value: undefined };
    updateStickyHandle(ref, '@ope-ultp1635');
    assert.equal(ref.value, '@ope-ultp1635');
  });
});
