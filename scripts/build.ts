#!/usr/bin/env bun
/**
 * Build script — bundles every runtime entry point into a self-contained ESM
 * file under dist/.
 *
 * The plugin executes these files with plain `node` (see hooks/hooks.json and
 * .mcp.json), so each entry must inline its dependencies. Nothing may be
 * resolved from node_modules at runtime.
 */
import { rm } from 'node:fs/promises';

/** Runtime entry points. Add new hooks/MCP entry files here. */
const ENTRY_POINTS = [
  './src/hooks/session-start.ts',
  './src/hooks/recall.ts',
  './src/hooks/retain.ts',
  './src/hooks/session-end.ts',
  './src/mcp/server.ts',
  './src/setup/setup-hooks.ts',
];

await rm('dist', { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ENTRY_POINTS,
  outdir: 'dist',
  target: 'node',
  format: 'esm',
  // One self-contained file per entry: a hook invocation must never need its
  // siblings, and the plugin ships without node_modules.
  splitting: false,
  sourcemap: 'linked',
  minify: false,
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

for (const output of result.outputs) {
  const sizeKib = (output.size / 1024).toFixed(1);
  console.log(`  ${output.path}  (${sizeKib} KiB)`);
}
