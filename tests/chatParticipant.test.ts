// Unit tests for the vscode-free helpers in src/chatParticipant.ts.
//
// parsePrompt is the only exported pure function in that module.
// The vscode-bound registerChatParticipant function is covered by
// type-checker + manual smoke tests in the Extension Development Host.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Import from the vscode-free core module so tsx can load it without a VS Code shim.
import { parsePrompt } from '../src/chatParticipantCore';

describe('parsePrompt', () => {
  // ── Happy-path cases ────────────────────────────────────────────────

  it('parses a simple @handle + body', () => {
    const result = parsePrompt('@planner 今日のタスクは？');
    assert.deepEqual(result, { to: '@planner', body: '今日のタスクは？' });
  });

  it('parses a team handle', () => {
    const result = parsePrompt('@team-backend デプロイ状況を確認して');
    assert.deepEqual(result, { to: '@team-backend', body: 'デプロイ状況を確認して' });
  });

  it('parses a multi-word body', () => {
    const result = parsePrompt('@ope-ultp1635 restart bridge-claude please');
    assert.deepEqual(result, { to: '@ope-ultp1635', body: 'restart bridge-claude please' });
  });

  it('parses a multi-line body', () => {
    const result = parsePrompt('@planner line one\nline two');
    assert.deepEqual(result, { to: '@planner', body: 'line one\nline two' });
  });

  it('trims leading/trailing whitespace from the input', () => {
    const result = parsePrompt('  @planner   hello  ');
    // outer trim → "@planner   hello", body is trimmed by parsePrompt
    assert.ok(result);
    assert.equal(result.to, '@planner');
    assert.equal(result.body, 'hello');
  });

  it('preserves body with leading @ that is not the handle', () => {
    const result = parsePrompt('@planner cc @reviewer please check');
    assert.deepEqual(result, { to: '@planner', body: 'cc @reviewer please check' });
  });

  // ── No-handle / malformed cases → null ─────────────────────────────

  it('returns null for a bare message with no @handle', () => {
    assert.equal(parsePrompt('ping'), null);
  });

  it('returns null for an @handle with no body', () => {
    assert.equal(parsePrompt('@planner'), null);
  });

  it('returns null for an @handle followed only by whitespace', () => {
    assert.equal(parsePrompt('@planner   '), null);
  });

  it('returns null for an empty string', () => {
    assert.equal(parsePrompt(''), null);
  });

  it('returns null for a plain message starting with a word', () => {
    assert.equal(parsePrompt('hello @planner'), null);
  });
});
