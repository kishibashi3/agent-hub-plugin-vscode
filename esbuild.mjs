// esbuild bundle script for agent-hub-bridge-vscode.
//
// Produces a single CJS bundle at dist/extension.js so the VS Code
// extension host (which uses CJS `require()`) can load the extension
// even when its dependencies — in particular
// `@kishibashi3/agent-hub-sdk` — are ESM-only packages.
//
// Usage:
//   node esbuild.mjs              # development build (sourcemap, no minify)
//   node esbuild.mjs --watch      # incremental watch mode
//   node esbuild.mjs --production # release build (minified, no sourcemap)

import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',           // VS Code extension host requires CommonJS
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'],    // provided by the extension host at runtime
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('[esbuild] watching for changes…');
} else {
  await esbuild.build(buildOptions);
}
