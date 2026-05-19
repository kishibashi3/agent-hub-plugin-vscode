// Unit tests for the vscode-free prompt-shaping helpers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_IDE_CONTEXT_SNAPSHOT,
  formatIdeContext,
  formatPrompt,
  type IdeContextSnapshot,
} from '../src/promptFormat';
import type { InboxMessage } from '../src/protocol';

const sampleMessage: InboxMessage = {
  id: '00000000-0000-4000-8000-000000000001',
  from: '@alice',
  to: '@bridge-vscode-impl',
  message: 'Please look at this test failure.',
  timestamp: '2026-05-19T03:00:00Z',
};

const sampleActiveFile = {
  uri: 'file:///workspace/example.ts',
  languageId: 'typescript',
  cursorLine: 42,
  cursorColumn: 8,
};

describe('formatIdeContext', () => {
  it('returns the empty string for an empty snapshot', () => {
    assert.equal(formatIdeContext(EMPTY_IDE_CONTEXT_SNAPSHOT), '');
  });

  it('renders the active-file header alone when no selection / window / diagnostics', () => {
    const snapshot: IdeContextSnapshot = {
      activeFile: sampleActiveFile,
      diagnostics: [],
    };
    const out = formatIdeContext(snapshot);
    assert.match(out, /^## IDE context\n/);
    assert.match(out, /Active file: `file:\/\/\/workspace\/example\.ts` \(typescript\)/);
    assert.match(out, /Cursor: line 42, column 8/);
    assert.doesNotMatch(out, /### Selection/);
    assert.doesNotMatch(out, /### Window around cursor/);
    assert.doesNotMatch(out, /### Diagnostics/);
  });

  it('renders a non-truncated selection block', () => {
    const snapshot: IdeContextSnapshot = {
      activeFile: sampleActiveFile,
      selection: { startLine: 40, endLine: 48, text: 'const x = 1;', truncated: false },
      diagnostics: [],
    };
    const out = formatIdeContext(snapshot);
    assert.match(out, /### Selection \(lines 40-48\)\n```\nconst x = 1;\n```/);
    assert.doesNotMatch(out, /truncated/);
  });

  it('marks a truncated selection in the block header', () => {
    const snapshot: IdeContextSnapshot = {
      activeFile: sampleActiveFile,
      selection: { startLine: 1, endLine: 200, text: '…huge…', truncated: true },
      diagnostics: [],
    };
    assert.match(formatIdeContext(snapshot), /### Selection \(lines 1-200, truncated\)/);
  });

  it('renders a cursor-window block when no selection is present', () => {
    const snapshot: IdeContextSnapshot = {
      activeFile: sampleActiveFile,
      cursorWindow: { startLine: 22, endLine: 62, text: '// surrounding code' },
      diagnostics: [],
    };
    const out = formatIdeContext(snapshot);
    assert.match(out, /### Window around cursor \(lines 22-62\)\n```\n\/\/ surrounding code\n```/);
  });

  it('prefers the selection block over the cursor-window block when both exist', () => {
    // collectIdeContext never sets both, but formatIdeContext should still
    // handle the data shape defensively.
    const snapshot: IdeContextSnapshot = {
      activeFile: sampleActiveFile,
      selection: { startLine: 40, endLine: 48, text: 'sel', truncated: false },
      cursorWindow: { startLine: 22, endLine: 62, text: 'cw' },
      diagnostics: [],
    };
    const out = formatIdeContext(snapshot);
    assert.match(out, /### Selection \(/);
    assert.doesNotMatch(out, /### Window around cursor/);
  });

  it('renders diagnostics with source-prefix and severity, in the order given', () => {
    const snapshot: IdeContextSnapshot = {
      activeFile: sampleActiveFile,
      diagnostics: [
        { line: 41, severity: 'error', source: 'ts', message: "Cannot find name 'foo'." },
        { line: 47, severity: 'warning', source: '', message: "Unused variable 'bar'." },
        { line: 50, severity: 'info', source: 'eslint', message: 'Prefer const.' },
      ],
    };
    const out = formatIdeContext(snapshot);
    assert.match(out, /### Diagnostics \(3 item\(s\)\)/);
    assert.match(out, /- line 41 error: \[ts\] Cannot find name 'foo'\./);
    assert.match(out, /- line 47 warning: Unused variable 'bar'\./);
    assert.match(out, /- line 50 info: \[eslint\] Prefer const\./);
  });

  it('emits no trailing whitespace', () => {
    const snapshot: IdeContextSnapshot = {
      activeFile: sampleActiveFile,
      diagnostics: [{ line: 1, severity: 'error', source: '', message: 'oops' }],
    };
    const out = formatIdeContext(snapshot);
    assert.equal(out, out.trimEnd());
  });
});

describe('formatPrompt', () => {
  it('builds the basic envelope with system prompt + IDE block + message', () => {
    const ideBlock = '## IDE context\n\nActive file: `x.ts` (typescript)';
    const out = formatPrompt('you are alice', sampleMessage, ideBlock);
    // System prompt first
    assert.match(out, /^you are alice\n\n---\n\n/);
    // Then IDE block
    assert.match(out, /## IDE context\n\nActive file: `x\.ts` \(typescript\)\n\n---\n\n/);
    // Then message envelope
    assert.match(out, /You have received a direct message via agent-hub\./);
    assert.match(out, /From: @alice/);
    assert.match(out, /Message id: 00000000-0000-4000-8000-000000000001/);
    assert.match(out, /Sent at: 2026-05-19T03:00:00Z/);
    assert.match(out, /Content:\nPlease look at this test failure\./);
  });

  it('drops the system-prompt block when the system prompt is empty or whitespace', () => {
    const ideBlock = '## IDE context';
    const out = formatPrompt('   ', sampleMessage, ideBlock);
    assert.equal(out.startsWith('## IDE context'), true);
    assert.doesNotMatch(out, /---\n\n## IDE context/); // no orphan separator above
  });

  it('drops the IDE block when the IDE string is empty', () => {
    const out = formatPrompt('persona', sampleMessage, '');
    // Order: system → message (no IDE block, no stray separator between)
    assert.match(out, /^persona\n\n---\n\nYou have received a direct message/);
    assert.doesNotMatch(out, /## IDE context/);
  });

  it('drops both blocks when system and IDE are empty', () => {
    const out = formatPrompt('', sampleMessage, '');
    assert.match(out, /^You have received a direct message via agent-hub\./);
  });

  it('preserves the message envelope when message body is multi-line', () => {
    const msg: InboxMessage = { ...sampleMessage, message: 'line1\nline2\nline3' };
    const out = formatPrompt('', msg, '');
    assert.match(out, /Content:\nline1\nline2\nline3$/);
  });
});

describe('IDE-context PR #5 Minor regression: maxSelectionChars = 0', () => {
  // collectIdeContext lives in the vscode-bound `./ideContext.ts` and isn't
  // directly testable here, but the *shape* it produces when
  // `maxSelectionChars = 0` is — no `selection`, no `cursorWindow` fall-
  // through. Verify formatIdeContext renders that shape as "active file +
  // diagnostics only" with no code-text block.
  it('renders no selection/window block when neither is set, even with diagnostics present', () => {
    const snapshot: IdeContextSnapshot = {
      activeFile: sampleActiveFile,
      diagnostics: [{ line: 10, severity: 'error', source: '', message: 'oops' }],
    };
    const out = formatIdeContext(snapshot);
    assert.match(out, /## IDE context/);
    assert.match(out, /### Diagnostics/);
    assert.doesNotMatch(out, /### Selection/);
    assert.doesNotMatch(out, /### Window around cursor/);
  });
});
