#!/usr/bin/env bun
/**
 * Build script — bundles the CLI into a single self-contained ESM file.
 *
 * The published package has no runtime dependencies: `@peri-code/hindsight`
 * ships `dist/cli.js` and nothing else, so npx can run it straight out of the
 * cache without an install step. That is only true if every import is inlined
 * here, which is why `splitting` is off and nothing is marked external.
 *
 * Two things are baked in that would otherwise need a file read at runtime:
 * the package version, and the shebang that lets npm expose the file as `bin`.
 */
import { chmodSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

/** The one entry point; `src/cli.ts` dispatches to each hook and the MCP server. */
const ENTRY_POINT = './src/cli.ts';

/** Where the bundle lands — the only directory the package publishes. */
const OUTDIR = 'dist';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

await rm(OUTDIR, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [ENTRY_POINT],
  outdir: OUTDIR,
  target: 'node',
  format: 'esm',
  // One self-contained file: `hindsight hook recall` must not need its siblings,
  // and the package ships without node_modules.
  splitting: false,
  sourcemap: 'linked',
  minify: false,
  define: {
    // Substituted for the `__HINDSIGHT_VERSION__` identifier in lib/version.ts.
    __HINDSIGHT_VERSION__: JSON.stringify(pkg.version),
  },
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const entry = join(OUTDIR, 'cli.js');

// npm links `bin` by symlink and relies on either the shebang or its own shim;
// the shebang is what makes the file runnable when invoked directly, and the
// executable bit is what makes `./dist/cli.js` work outside npm.
if (!readFileSync(entry, 'utf8').startsWith('#!')) {
  console.error(`Build failed: ${entry} is missing the shebang from ${ENTRY_POINT}`);
  process.exit(1);
}
chmodSync(entry, 0o755);

for (const output of result.outputs) {
  const sizeKib = (output.size / 1024).toFixed(1);
  console.log(`  ${output.path}  (${sizeKib} KiB)`);
}
