// Unit tests for the vscode-free helpers in src/ideContextCore.ts (issue #48).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appendIdeContext, formatIdeContext, type IdeContext } from '../src/ideContextCore';

// ── helpers ───────────────────────────────────────────────────────────────────

function ctx(overrides: Partial<IdeContext> = {}): IdeContext {
  return {
    file: 'src/foo.ts',
    languageId: 'typescript',
    startLine: 10,
    endLine: 10,
    selection: '',
    ...overrides,
  };
}

// ── formatIdeContext ──────────────────────────────────────────────────────────

describe('formatIdeContext', () => {
  it('shows file + single line when no selection', () => {
    const result = formatIdeContext(ctx({ startLine: 5, endLine: 5, selection: '' }));
    assert.equal(result, '📎 **src/foo.ts** L5');
  });

  it('shows file + range when start and end differ (no selection text)', () => {
    // endLine > startLine but selection is empty — treated as no-selection
    const result = formatIdeContext(ctx({ startLine: 5, endLine: 10, selection: '' }));
    assert.equal(result, '📎 **src/foo.ts** L5–10');
  });

  it('includes fenced code block with selection text', () => {
    const result = formatIdeContext(
      ctx({ startLine: 12, endLine: 18, selection: 'const x = 1;', languageId: 'typescript' })
    );
    assert.equal(result, '📎 **src/foo.ts** L12–18\n```typescript\nconst x = 1;\n```');
  });

  it('uses languageId as fence language', () => {
    const result = formatIdeContext(
      ctx({ languageId: 'python', startLine: 3, endLine: 3, selection: 'x = 1' })
    );
    assert.ok(result.includes('```python'));
  });

  it('preserves multi-line selection verbatim', () => {
    const sel = 'line one\nline two\nline three';
    const result = formatIdeContext(ctx({ startLine: 1, endLine: 3, selection: sel }));
    assert.ok(result.includes(sel));
  });

  it('shows single-line loc when startLine === endLine (with selection)', () => {
    const result = formatIdeContext(
      ctx({ startLine: 7, endLine: 7, selection: 'foo()' })
    );
    assert.ok(result.startsWith('📎 **src/foo.ts** L7'));
  });

  it('uses workspace-relative path as-is', () => {
    const result = formatIdeContext(ctx({ file: 'packages/core/index.ts', startLine: 1, endLine: 1 }));
    assert.ok(result.includes('packages/core/index.ts'));
  });
});

// ── appendIdeContext ──────────────────────────────────────────────────────────

describe('appendIdeContext', () => {
  it('returns body unchanged when ctx is null', () => {
    assert.equal(appendIdeContext('hello', null), 'hello');
  });

  it('appends formatted context separated by horizontal rule', () => {
    const result = appendIdeContext('hello', ctx({ startLine: 5, endLine: 5, selection: '' }));
    assert.equal(result, 'hello\n\n---\n📎 **src/foo.ts** L5');
  });

  it('appends code block when selection is present', () => {
    const result = appendIdeContext(
      'check this',
      ctx({ startLine: 10, endLine: 12, selection: 'const x = 1;' })
    );
    assert.ok(result.startsWith('check this\n\n---\n'));
    assert.ok(result.includes('```typescript'));
    assert.ok(result.includes('const x = 1;'));
  });

  it('does not mutate the original body string', () => {
    const body = 'original';
    appendIdeContext(body, ctx());
    assert.equal(body, 'original');
  });
});
