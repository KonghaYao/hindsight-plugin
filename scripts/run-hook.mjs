#!/usr/bin/env node
/**
 * Hook launcher.
 *
 * Claude Code runs each hook as a short-lived process (see hooks/hooks.json).
 * The bundled entry points live in dist/, which is a build artifact — this
 * launcher turns the missing-build case into an actionable message instead of a
 * raw module-resolution stack trace, and never fails the session: a stale
 * checkout must not block the user.
 *
 * Usage: node scripts/run-hook.mjs <hook-name>
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || dirname(scriptsDir);

async function main() {
  const hookName = process.argv[2];
  if (!hookName) {
    console.error(
      '[Hindsight] run-hook.mjs: missing hook name (expected `node run-hook.mjs recall`)',
    );
    return;
  }

  const entry = join(pluginRoot, 'dist', 'hooks', `${hookName}.js`);
  if (!existsSync(entry)) {
    console.error(
      `[Hindsight] ${entry} not found — the plugin has not been built.\n` +
        `[Hindsight] Build it once: cd "${pluginRoot}" && bun install && bun run build`,
    );
    return;
  }

  const mod = await import(pathToFileURL(entry).href);

  // Importing the bundle deliberately does NOT start the hook: each entry guards
  // its own startup on the process being that entry (so `session-end` can import
  // `retain` without running it twice). Calling the exported `run()` here is what
  // starts it — and it is `run`, not `main`, because `run` carries the hook's own
  // error handling and exit-code semantics.
  const start = typeof mod.run === 'function' ? mod.run : mod.main;
  if (typeof start !== 'function') {
    console.error(`[Hindsight] ${entry} exports neither run() nor main()`);
    return;
  }
  await start();
}

// No `process.exit()` anywhere above: stderr is asynchronous when it is a pipe,
// and exiting mid-write can truncate the very message the user needs to see.
await main();
