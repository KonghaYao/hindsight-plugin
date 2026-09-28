/**
 * Filesystem locations the plugin depends on.
 *
 * The three layouts this code runs under are:
 *   - a source checkout, executed through `bun run …` / `vitest`
 *   - this repo's `dist/`, executed by `node dist/cli.js`
 *   - an npx cache, `…/node_modules/@peri-code/hindsight/dist/cli.js`
 *
 * Only the first two have a `settings.json` next door, so the lookup walks up
 * from this module until it finds one and falls back to the built-in defaults
 * when it cannot. Version reporting does *not* come from here — it is inlined at
 * build time (see `lib/version.ts`), which is the only approach that also works
 * in the npx cache.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How many directories to climb while looking for the package root.
 *
 * Deep enough for the source layout (`src/lib/paths.ts` → repo root is three
 * levels) and short enough that a stray global install never walks into `/`.
 */
const MAX_ROOT_DEPTH = 5;

/**
 * Absolute path to the directory holding the shipped `settings.json`.
 *
 * Resolved on every call rather than cached: tests swap `CLAUDE_PLUGIN_ROOT`
 * between cases, and a stale root would silently read another sandbox's files.
 *
 * `CLAUDE_PLUGIN_ROOT` wins when Claude Code sets it, which is what lets a test
 * (or a future bundled layout) point at a directory with no `package.json`.
 */
export function configRoot(): string {
  const fromEnv = process.env.CLAUDE_PLUGIN_ROOT;
  if (fromEnv) {
    return fromEnv;
  }

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < MAX_ROOT_DEPTH; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  // Fall back to the module's own directory; callers degrade gracefully when the
  // file is missing (the built-in defaults still apply).
  return dirname(fileURLToPath(import.meta.url));
}

/** Path to the shipped `settings.json` (default configuration). */
export function pluginSettingsPath(): string {
  return join(configRoot(), 'settings.json');
}

/** Path to the user's stable config file, shared across plugin versions. */
export function userConfigPath(): string {
  return join(homedir(), '.hindsight', 'claude-code.json');
}
