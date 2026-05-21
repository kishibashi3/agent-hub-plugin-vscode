// ESLint flat config for agent-hub-bridge-vscode (issue #19).
//
// Scope:
//   - typescript-eslint recommendedTypeChecked rule set across src/ + tests/
//   - One custom rule: `no-restricted-imports` enforces the vscode-free
//     split (PR #8) — `protocol.ts` and `chatParticipantCore.ts` must never
//     `import * as vscode from 'vscode'`. Lifting this from convention to
//     lint-enforced invariant is the main marginal value over `tsc --strict`.
//
// What we deliberately don't include:
//   - Prettier / stylistic rules — `tsc --strict` covers the bug-bait
//     stylistic mistakes; a future Prettier addition can layer on top
//     without disturbing this config.
//   - `eslint-plugin-import` / `eslint-plugin-unicorn` etc. — plugin
//     footprint stays minimal; revisit if specific gaps emerge.

import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 1. Global ignores — paths that ESLint should not visit at all.
  {
    ignores: [
      // esbuild bundle output directory (since v0.5.0; was `out/` in ≤0.4.0).
      'dist/**',
      // Legacy tsc output directory — kept for safety on pre-0.5.0 checkouts.
      'out/**',
      'node_modules/**',
      '.vscode-test/**',
      // Build script — plain ESM, outside the TS project graph.
      'esbuild.mjs',
      // eslint.config.mjs is ESM and lives outside the TS project graph;
      // the recommendedTypeChecked rules can't parse it without a
      // dedicated tsconfig, so we exempt it from the type-aware pass.
      'eslint.config.mjs',
    ],
  },

  // 2. Recommended type-checked rules for the TS sources + tests.
  ...tseslint.configs.recommendedTypeChecked,

  // 3. Tell typescript-eslint where the project graph is so the
  //    type-aware rules can resolve imports / inferred types.
  //    Using `projectService: true` (typescript-eslint v8) so files
  //    outside the tsconfig's `include` (notably `tests/`) get the
  //    same type-aware treatment without needing a second tsconfig.
  {
    languageOptions: {
      parserOptions: {
        // `tests/**/*.test.ts` lives outside the tsconfig's `include`
        // (which targets src/). `allowDefaultProject` lets the project
        // service parse those files using the default inferred project,
        // so the lint pass still gets type-aware coverage without us
        // maintaining a second tsconfig.
        projectService: {
          allowDefaultProject: ['tests/*.test.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Honour the `_`-prefix convention for intentionally-unused args
  // (e.g. arrow callbacks where the signature is fixed by the API).
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // 4. Vscode-free-module enforcement — `protocol.ts` and
  //    `chatParticipantCore.ts` are pure Node modules (no vscode import).
  //    This rule keeps the pure side pure as a lint-enforced invariant.
  {
    files: ['src/protocol.ts', 'src/chatParticipantCore.ts', 'src/relayTracker.ts', 'src/stickyHandle.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message:
                'protocol.ts, chatParticipantCore.ts, relayTracker.ts, and stickyHandle.ts must remain vscode-free (PR #8 split). ' +
                'Move vscode-dependent code into the vscode-bound layer (agentHub.ts / ' +
                'lmDispatcher.ts / chatParticipant.ts / extension.ts).',
            },
          ],
        },
      ],
    },
  },

  // 5. Tests live outside the TS project's `rootDir` but should still
  //    be lint-covered. The recommendedTypeChecked rules apply, but we
  //    relax a handful of patterns that come up naturally in node:test
  //    assertion style and would force boilerplate without catching
  //    real bugs.
  {
    files: ['tests/**/*.test.ts'],
    rules: {
      // assert.equal / assert.deepEqual etc. accept `unknown`; the type-
      // aware rule flags every comparison against a `parsed` JSON value.
      // Tests are short and human-reviewed, so the noise outweighs signal.
      '@typescript-eslint/no-unsafe-argument': 'off',
      // node:test's `describe` / `it` return promises that the runner
      // manages internally; user code never needs to await them. The
      // rule wants every `describe(...)` / `it(...)` prefixed with
      // `void`, which adds zero safety. Off.
      '@typescript-eslint/no-floating-promises': 'off',
      // Many `it('…', async () => { assert.equal(…) })` test bodies are
      // genuinely synchronous. The async wrapping is harmless and lets
      // future async assertions land without a signature change; the
      // rule's diagnosis is noise here.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
