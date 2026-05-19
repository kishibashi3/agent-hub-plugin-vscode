// Unit tests for the vscode-free prompt-shaping helpers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_IDE_CONTEXT_SNAPSHOT,
  formatGitDiffBlock,
  formatIdeContext,
  formatPrompt,
  truncateDiff,
  type IdeContextSnapshot,
  type IdeGitChange,
  type IdeGitDiff,
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

describe('truncateDiff', () => {
  it('returns the input untouched when within the cap', () => {
    const r = truncateDiff('diff body', 100);
    assert.equal(r.text, 'diff body');
    assert.equal(r.truncated, false);
  });

  it('returns the input untouched when exactly at the cap', () => {
    const r = truncateDiff('abc', 3);
    assert.equal(r.text, 'abc');
    assert.equal(r.truncated, false);
  });

  it('slices and flags truncated when over the cap', () => {
    const r = truncateDiff('abcdefghij', 4);
    assert.equal(r.text, 'abcd');
    assert.equal(r.truncated, true);
  });

  it('returns empty text + truncated=true when maxChars=0 and the input is non-empty', () => {
    const r = truncateDiff('something', 0);
    assert.equal(r.text, '');
    assert.equal(r.truncated, true);
  });

  it('returns empty text + truncated=false when both the input and the cap are empty', () => {
    const r = truncateDiff('', 0);
    assert.equal(r.text, '');
    assert.equal(r.truncated, false);
  });
});

describe('formatGitDiffBlock', () => {
  const sampleChange: IdeGitChange = {
    path: 'src/example.ts',
    status: 'modified',
    diff: '@@ -1,3 +1,4 @@\n hello\n+added\n world',
    diffTruncated: false,
  };

  it('returns the empty string when there are no changes and no truncated count', () => {
    const diff: IdeGitDiff = {
      repoPath: 'frontend',
      branchName: 'main',
      changes: [],
      truncatedFileCount: 0,
    };
    assert.equal(formatGitDiffBlock(diff, 1500), '');
  });

  it('renders a single file diff with a fenced ```diff block', () => {
    const diff: IdeGitDiff = {
      repoPath: '',
      branchName: 'feat/x',
      changes: [sampleChange],
      truncatedFileCount: 0,
    };
    const out = formatGitDiffBlock(diff, 1500);
    assert.match(out, /^### Git diff \(working tree, branch=feat\/x, 1 file\(s\)\)/);
    assert.match(out, /#### `src\/example\.ts` — modified/);
    assert.match(out, /```diff\n@@ -1,3 \+1,4 @@/);
  });

  it('shows the truncated-file-count chip in the header when > 0', () => {
    const diff: IdeGitDiff = {
      repoPath: '',
      branchName: 'main',
      changes: [sampleChange],
      truncatedFileCount: 3,
    };
    assert.match(
      formatGitDiffBlock(diff, 1500),
      /### Git diff \(working tree, branch=main, 1 file\(s\), \+ 3 more truncated\)/
    );
  });

  it('renders "_diff body suppressed_" when maxCharsPerFile is 0', () => {
    const diff: IdeGitDiff = {
      repoPath: '',
      branchName: 'main',
      changes: [sampleChange],
      truncatedFileCount: 0,
    };
    const out = formatGitDiffBlock(diff, 0);
    assert.match(out, /#### `src\/example\.ts` — modified/);
    assert.match(out, /_diff body suppressed_/);
    assert.doesNotMatch(out, /```diff/);
  });

  it('appends a "… (truncated)" marker inside the fenced block when the per-file diff was capped', () => {
    const diff: IdeGitDiff = {
      repoPath: '',
      branchName: 'main',
      changes: [{ ...sampleChange, diffTruncated: true }],
      truncatedFileCount: 0,
    };
    const out = formatGitDiffBlock(diff, 1500);
    assert.match(out, /… \(truncated\)\n```/);
  });

  it('renders multiple file blocks in input order', () => {
    const diff: IdeGitDiff = {
      repoPath: '',
      branchName: 'main',
      changes: [
        { ...sampleChange, path: 'a.ts' },
        { ...sampleChange, path: 'b.ts', status: 'deleted' },
      ],
      truncatedFileCount: 0,
    };
    const out = formatGitDiffBlock(diff, 1500);
    const aIdx = out.indexOf('`a.ts`');
    const bIdx = out.indexOf('`b.ts`');
    assert.ok(aIdx >= 0);
    assert.ok(bIdx > aIdx);
  });

  it('omits the branch chip when branchName is empty', () => {
    const diff: IdeGitDiff = {
      repoPath: '',
      branchName: '',
      changes: [sampleChange],
      truncatedFileCount: 0,
    };
    assert.doesNotMatch(formatGitDiffBlock(diff, 1500), /branch=/);
  });
});

describe('formatIdeContext gitDiff integration', () => {
  it('renders the git-diff section after diagnostics when present', () => {
    const snapshot: IdeContextSnapshot = {
      activeFile: sampleActiveFile,
      diagnostics: [{ line: 1, severity: 'error', source: '', message: 'oops' }],
      gitDiff: {
        repoPath: '',
        branchName: 'main',
        changes: [
          {
            path: 'src/x.ts',
            status: 'modified',
            diff: '@@ -1 +1 @@\n-a\n+b',
            diffTruncated: false,
          },
        ],
        truncatedFileCount: 0,
      },
    };
    const out = formatIdeContext(snapshot);
    const diagIdx = out.indexOf('### Diagnostics');
    const gitIdx = out.indexOf('### Git diff');
    assert.ok(diagIdx >= 0);
    assert.ok(gitIdx > diagIdx);
  });

  it('omits the git-diff section entirely when snapshot.gitDiff is absent', () => {
    const snapshot: IdeContextSnapshot = {
      activeFile: sampleActiveFile,
      diagnostics: [],
    };
    assert.doesNotMatch(formatIdeContext(snapshot), /### Git diff/);
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
