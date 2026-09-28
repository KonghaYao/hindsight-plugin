/**
 * Register hindsight-memory hooks into ~/.claude/settings.json.
 *
 * Claude Code's plugin installer does not currently merge hooks.json into
 * settings.json automatically. Run this once after installing the plugin:
 *
 *     npx @peri-code/hindsight setup
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { userConfigPath } from '../lib/paths';
import { PACKAGE_NAME, VERSION } from '../lib/version';

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

// Default hook timeout for UserPromptSubmit (auto-recall).
// Raised from 12s to 45s — the hooks.json shipped with the plugin also
// uses this floor, but setup-hooks.ts can tighten it further when the
// user has set a lower requestTimeoutSeconds (see buildHooks).
const HOOK_RECALL_TIMEOUT_DEFAULT = 45;
const HOOK_RECALL_TIMEOUT_MIN = 30;

/** Non-throwing `os.path.isfile`. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // Missing, unreadable, or traverses a non-directory — `os.path.isfile`
    // answers False for every OS error as well.
    return false;
  }
}

/** Non-throwing `os.path.isdir`. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Python's `str(e)` — the message alone, without the `Error: ` prefix. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Return user-configured requestTimeoutSeconds, or null if unavailable. */
function readRequestTimeout(): number | null {
  try {
    const cfg: unknown = JSON.parse(readFileSync(userConfigPath(), 'utf8'));
    if (cfg === null || typeof cfg !== 'object') {
      return null;
    }
    const value = (cfg as Record<string, unknown>).requestTimeoutSeconds;
    if (typeof value === 'number' && value > 0) {
      return Math.trunc(value);
    }
  } catch {
    // Missing file (OSError) or invalid JSON (JSONDecodeError) — no timeout.
  }
  return null;
}

/**
 * Compute the recall hook timeout.
 *
 * When the user has set requestTimeoutSeconds, the hook timeout is that
 * value plus a 15s margin so the hook process is never killed before the
 * MCP request it wraps has a chance to complete (see #2854).
 *
 * Otherwise a safe default is used.
 */
function recallTimeout(): number {
  const reqTimeout = readRequestTimeout();
  if (reqTimeout !== null) {
    return Math.max(reqTimeout + 15, HOOK_RECALL_TIMEOUT_MIN);
  }
  return HOOK_RECALL_TIMEOUT_DEFAULT;
}

/** Locate the installed hindsight-memory plugin cache directory. */
function findPluginRoot(): string {
  const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', 'hindsight', 'hindsight-memory');
  if (!isDirectory(cacheBase)) {
    throw new Error(
      'hindsight-memory plugin not found. ' +
        'Run /plugin install hindsight-memory inside Claude Code first.',
    );
  }
  const versions = readdirSync(cacheBase).sort().reverse();
  const latest = versions[0];
  if (latest === undefined) {
    throw new Error(`No versions found in ${cacheBase}`);
  }
  return join(cacheBase, latest);
}

/**
 * Build a hook command line.
 *
 * The hooks live in the published CLI rather than in a build output inside the
 * plugin directory, so the command names the package instead of
 * `${CLAUDE_PLUGIN_ROOT}` — nothing here needs the plugin's own install path.
 *
 * `-y` skips npx's "Ok to proceed?" prompt, which a hook has no way to answer,
 * and `-p <spec>` names the package explicitly so the command that follows is
 * unambiguous rather than inferred from the spec. The version is pinned on
 * purpose: an unpinned spec would let a later publish change this hook's
 * behaviour mid-session.
 */
function hookCommand(script: string): string {
  return `npx -y -p ${PACKAGE_NAME}@${VERSION} hindsight hook ${script}`;
}

/**
 * Build the hook registrations for the installed plugin.
 *
 * Mirrors the shipped `plugin/hooks/hooks.json`, except that recall's timeout is
 * computed from the user's `requestTimeoutSeconds` instead of being fixed — see
 * `recallTimeout`.
 */
function buildHooks(): Record<string, unknown> {
  const recallHookTimeout = recallTimeout();
  return {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand('recall'),
            timeout: recallHookTimeout,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand('retain'),
            timeout: 15,
            async: true,
          },
        ],
      },
    ],
    SessionStart: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand('session-start'),
            timeout: 5,
          },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand('session-end'),
            timeout: 10,
          },
        ],
      },
    ],
  };
}

/**
 * Merge this plugin's hooks into the user's settings file.
 *
 * Returns the process exit code rather than calling `process.exit()`: stdout is
 * asynchronous when it is a pipe, and exiting mid-write can truncate the last
 * line — which is the one telling the user to restart Claude Code.
 */
export async function run(): Promise<number> {
  let pluginRoot: string;
  try {
    pluginRoot = findPluginRoot();
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`);
    return 1;
  }

  if (!isFile(SETTINGS_PATH)) {
    console.error(`Error: ${SETTINGS_PATH} not found. Is Claude Code installed?`);
    return 1;
  }

  const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as Record<string, unknown>;

  const existingHooks = (settings.hooks ?? {}) as Record<string, unknown>;
  if (Object.keys(existingHooks).length > 0) {
    console.log('Existing hooks found — merging (hindsight-memory hooks take precedence).');
  }

  const newHooks = buildHooks();
  settings.hooks = { ...existingHooks, ...newHooks };
  const env = (settings.env ?? {}) as Record<string, unknown>;
  env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  settings.env = env;

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

  console.log('hindsight-memory hooks registered successfully.');
  console.log(`Plugin root: ${pluginRoot}`);
  console.log('Restart Claude Code for changes to take effect.');
  return 0;
}
