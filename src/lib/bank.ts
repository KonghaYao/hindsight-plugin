/**
 * Bank ID derivation and mission management.
 *
 * Port of Openclaw's deriveBankId() and banksWithMissionSet logic, adapted for
 * Claude Code's context model.
 *
 * Openclaw derives bank IDs from: agent, channel, user, provider.
 * Claude Code equivalent dimensions:
 *   - agent   → configured name or "claude-code" (HINDSIGHT_AGENT_NAME)
 *   - project → derived from cwd (working directory basename)
 *   - session → session_id from hook input
 *   - channel → from env var HINDSIGHT_CHANNEL_ID (for Telegram/Discord agents)
 *   - user    → from env var HINDSIGHT_USER_ID (for multi-user agents)
 *
 * The channel/user dimensions enable the same per-user/per-channel isolation
 * that Openclaw provides via its messageProvider/channelId/senderId context.
 * Telegram/Discord agents set HINDSIGHT_CHANNEL_ID and HINDSIGHT_USER_ID in
 * their environment to achieve equivalent behavior.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import type { PluginConfig } from './config';
import { readState, writeState } from './state';

export const DEFAULT_BANK_NAME = 'claude-code';

/** Valid granularity fields for Claude Code. */
const VALID_FIELDS = new Set(['agent', 'project', 'session', 'channel', 'user']);

/** Granularity used when the configured value is missing or not a list. */
const FALLBACK_FIELDS = ['agent', 'project'];

/** Git plumbing must never stall a hook — same 5s cap as the Python original. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * The slice of the API client `ensureBankMission` needs.
 *
 * Declared structurally on purpose: the client module knows nothing about
 * banks, and importing `HindsightClient` here would create a circular import
 * between the two.
 */
export interface BankMissionClient {
  setBankMission(
    bankId: string,
    mission: string,
    retainMission?: string | null,
    timeout?: number,
  ): Promise<unknown>;
}

/** Check the shared Git directory itself, independent of the current worktree. */
function isBareRepository(commonDir: string): boolean {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  try {
    const result = spawnSync('git', ['-C', commonDir, 'rev-parse', '--is-bare-repository'], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      env,
    });
    return result.status === 0 && result.stdout.trim() === 'true';
  } catch {
    // git missing, spawn failure, or timeout — same "not a bare repository"
    // answer the Python version gives for OSError/TimeoutExpired.
    return false;
  }
}

/**
 * Resolve the project name from the working directory.
 *
 * When resolveWorktrees is enabled (default), detects git worktrees and
 * resolves to the main repository basename so that all worktrees of the same
 * repo share the same bank.
 *
 * For a regular repo at /home/user/myproject:
 *     git-common-dir → /home/user/myproject/.git → basename "myproject"
 *
 * For a worktree at /home/user/myproject-wt1 linked to /home/user/myproject:
 *     git-common-dir → /home/user/myproject/.git → basename "myproject"
 *
 * Exported for tests; production callers should go through `deriveBankId`.
 */
export function resolveProjectName(cwd: string, config: PluginConfig): string {
  if (!cwd) {
    return 'unknown';
  }

  if (config.resolveWorktrees === false) {
    return pythonBasename(cwd);
  }

  try {
    const result = spawnSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', timeout: GIT_TIMEOUT_MS },
    );
    if (result.status === 0) {
      const gitCommonDir = result.stdout.trim();
      const commonName = pythonBasename(gitCommonDir);
      if (commonName === '.git') {
        return pythonBasename(dirname(gitCommonDir));
      }
      // Bare-hub plumbing is conventionally hidden (`.bare`, `.git-bare`). Keep
      // standalone bare clone names stable instead of mapping every
      // `/repos/*.git` to `repos`.
      if (commonName.startsWith('.') && isBareRepository(gitCommonDir)) {
        return pythonBasename(dirname(gitCommonDir));
      }
      return commonName;
    }
  } catch {
    // git unavailable — fall through to the basename fallback.
  }

  // Fallback: not a git repo or git not available
  return pythonBasename(cwd);
}

/**
 * Derive a bank ID from hook context and config.
 *
 * Port of: deriveBankId() in index.js
 *
 * Resolution order:
 *   1. directoryBankMap — explicit directory→bank mapping (highest priority)
 *   2. Static mode (dynamicBankId=false) — single bank for everything
 *   3. Dynamic mode (dynamicBankId=true) — composed from granularity fields
 *
 * `hookInput` is the hook's stdin JSON (has session_id, cwd). Every field is
 * optional at runtime, hence the untyped shape.
 */
export function deriveBankId(hookInput: Record<string, unknown>, config: PluginConfig): string {
  const prefix = config.bankIdPrefix ?? '';

  // Check explicit directory-to-bank mapping first
  const cwd = asString(hookInput.cwd);
  const dirMap = config.directoryBankMap ?? {};
  if (cwd && Object.keys(dirMap).length > 0) {
    // Normalize cwd for matching (trailing slashes, separators, and — via
    // normcase — drive-letter/path case on Windows, where launchers disagree:
    // PowerShell and git-bash hand children an UPPERCASE drive while the VS Code
    // extension spawn reports lowercase, so a case-sensitive compare silently
    // misses the map and falls through to the default bank. normcase is a no-op
    // on POSIX, preserving case-sensitive matching there.
    const normalizedCwd = normcase(tolerantRealpath(cwd));
    for (const [dirPath, mappedBankId] of Object.entries(dirMap)) {
      if (normcase(tolerantRealpath(dirPath)) === normalizedCwd) {
        return prefix ? `${prefix}-${mappedBankId}` : mappedBankId;
      }
    }
  }

  if (!config.dynamicBankId) {
    // Static mode — single bank for everything
    const base = config.bankId || DEFAULT_BANK_NAME;
    return prefix ? `${prefix}-${base}` : base;
  }

  // Dynamic mode — compose from granularity fields
  const configuredFields = asStringList(config.dynamicBankGranularity);
  const fields = configuredFields.length > 0 ? configuredFields : FALLBACK_FIELDS;

  // Warn on unknown fields (mirrors Openclaw's runtime check)
  for (const field of fields) {
    if (!VALID_FIELDS.has(field)) {
      const validFields = [...VALID_FIELDS].sort().join(', ');
      console.error(
        `[Hindsight] Unknown dynamicBankGranularity field "${field}" — valid for Claude Code: ${validFields}`,
      );
    }
  }

  // Build field values from hook context + env vars
  const sessionId = asString(hookInput.session_id);
  const agentName = config.agentName ?? 'claude-code';

  // Channel and user come from environment variables, set by the host agent
  // (e.g. Telegram bot sets HINDSIGHT_CHANNEL_ID=telegram-group-12345)
  const channelId = process.env.HINDSIGHT_CHANNEL_ID ?? '';
  const userId = process.env.HINDSIGHT_USER_ID ?? '';

  const fieldValues: Record<string, string> = {
    agent: agentName,
    project: resolveProjectName(cwd, config),
    session: sessionId || 'unknown',
    channel: channelId || 'default',
    user: userId || 'anonymous',
  };

  // bank_id is stored as-is server-side; HTTP path encoding is the client layer's job.
  const segments = fields.map((field) => fieldValues[field] ?? 'unknown');
  const baseBankId = segments.join('::');

  return prefix ? `${prefix}-${baseBankId}` : baseBankId;
}

/**
 * Set bank mission on first use, skip if already set.
 *
 * Port of: banksWithMissionSet Set tracking in index.js
 *
 * Uses a state file to persist which banks have had their mission set across
 * ephemeral hook invocations.
 */
export async function ensureBankMission(
  client: BankMissionClient,
  bankId: string,
  config: PluginConfig,
  debugFn?: (message: string) => void,
): Promise<void> {
  const mission = config.bankMission ?? '';
  if (!mission.trim()) {
    return;
  }

  // Check if we've already set mission for this bank
  const missionsSet = readState<Record<string, unknown>>('bank_missions.json', {});
  if (bankId in missionsSet) {
    return;
  }

  try {
    const retainMission = config.retainMission ?? null;
    await client.setBankMission(bankId, mission, retainMission, 10);
    missionsSet[bankId] = true;
    // Cap tracked banks (mirrors Openclaw's MAX_TRACKED_BANK_CLIENTS)
    if (Object.keys(missionsSet).length > 10_000) {
      const keys = Object.keys(missionsSet).sort();
      for (const key of keys.slice(0, Math.floor(keys.length / 2))) {
        delete missionsSet[key];
      }
    }
    writeState('bank_missions.json', missionsSet);
    if (debugFn) {
      debugFn(`Set mission for bank: ${bankId}`);
    }
  } catch (error) {
    // Don't fail if mission set fails — bank might not exist yet,
    // will be created on first retain (mirrors Openclaw behavior)
    if (debugFn) {
      debugFn(`Could not set bank mission for ${bankId}: ${describeError(error)}`);
    }
  }
}

/** Read a hook-input field defensively: anything that is not a string is absent. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Narrow a config value to a list of strings; a non-list becomes empty. */
function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: unknown[] = value;
  // Python keeps whatever the settings file held and stringifies it on use.
  return items.map((item) => (typeof item === 'string' ? item : String(item)));
}

/**
 * Python's `os.path.basename`.
 *
 * `path.basename` silently drops trailing separators ("/a/b/" → "b") while
 * Python keeps the empty final component that a trailing separator produces
 * (posixpath) or strips them first (ntpath) — the port follows Python so a cwd
 * with a trailing slash resolves identically.
 */
function pythonBasename(path: string): string {
  if (process.platform === 'win32') {
    return basename(path.replace(/[\\/]+$/, ''));
  }
  return path.slice(path.lastIndexOf(sep) + 1);
}

/**
 * `fs.realpathSync` throws for paths that do not exist, while Python's
 * `os.path.realpath` resolves as much as it can and hands back the rest
 * unchanged — the directory map must keep matching paths that only exist on
 * another machine.
 */
function tolerantRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Mirror of `os.path.normcase`: a no-op on POSIX, and on Windows lower-cases
 * the path and normalises `/` to `\` (what `ntpath.normcase` does).
 */
function normcase(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('/', '\\').toLowerCase() : path;
}

/** Python's `str(exc)` is the bare message, not JavaScript's `Error: ...` prefix. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
