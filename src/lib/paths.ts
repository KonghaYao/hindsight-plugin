/**
 * Filesystem locations the plugin depends on.
 *
 * The plugin runs from two very different layouts:
 *   - a source checkout during development (`bun run ...`)
 *   - the bundled `dist/` output that Claude Code executes (`node dist/...`)
 *
 * Both are handled by walking up from this module's own location until the
 * plugin manifest is found, with `CLAUDE_PLUGIN_ROOT` taking precedence when
 * Claude Code sets it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_MANIFEST_RELATIVE_PATH = join('.claude-plugin', 'plugin.json');

/**
 * Absolute path to the plugin root (the directory holding `.claude-plugin/`).
 *
 * Resolved on every call rather than cached: tests swap `CLAUDE_PLUGIN_ROOT`
 * between cases, and a stale root would silently read another sandbox's files.
 */
export function pluginRoot(): string {
  const fromEnv = process.env.CLAUDE_PLUGIN_ROOT;
  if (fromEnv) {
    return fromEnv;
  }

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(dir, PLUGIN_MANIFEST_RELATIVE_PATH))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  // Fall back to the module's own directory; callers degrade gracefully when the
  // manifest is missing (e.g. a stray source copy without the plugin wrapper).
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Read the plugin version from `.claude-plugin/plugin.json` (single source of
 * truth, shared with the marketplace manifest).
 */
export function pluginVersion(): string {
  try {
    const manifest = readFileSync(join(pluginRoot(), PLUGIN_MANIFEST_RELATIVE_PATH), 'utf8');
    const parsed: unknown = JSON.parse(manifest);
    if (parsed !== null && typeof parsed === 'object' && 'version' in parsed) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string') {
        return version;
      }
    }
  } catch {
    // Missing or unreadable manifest — report a placeholder rather than failing.
  }
  return '0.0.0';
}

/** Path to the plugin's shipped `settings.json` (default configuration). */
export function pluginSettingsPath(): string {
  return join(pluginRoot(), 'settings.json');
}

/** Path to the user's stable config file, shared across plugin versions. */
export function userConfigPath(): string {
  return join(homedir(), '.hindsight', 'claude-code.json');
}
