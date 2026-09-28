/**
 * File-based state persistence.
 *
 * Claude Code hooks are ephemeral processes — anything that must survive
 * between invocations lives in `$CLAUDE_PLUGIN_DATA/state/`.
 *
 * Concurrency: hooks can overlap (an async Stop hook while a new
 * UserPromptSubmit runs), so read-modify-write cycles take an exclusive lock.
 * Node has no `flock`, so this uses an `O_EXCL` lock file — the POSIX guarantee
 * that `open(..., 'wx')` fails for an existing path gives the same mutual
 * exclusion. Stale locks (a crashed hook) are reclaimed after a short timeout.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** State transition for a full-session retain attempt. */
export interface RetentionProgress {
  readonly chunkIndex: number;
  readonly compacted: boolean;
  readonly startIndex: number;
}

/** How long a lock file may sit untouched before it is treated as abandoned. */
const STALE_LOCK_MS = 10_000;
/** How long to wait for a contended lock before proceeding without it. */
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_INTERVAL_MS = 20;

/** Get the state directory, creating it if needed. */
export function stateDir(): string {
  const pluginData =
    process.env.CLAUDE_PLUGIN_DATA ||
    // Fallback for direct invocation outside Claude Code (e.g. tests, manual runs).
    join(homedir(), '.claude', 'plugins', 'data', 'hindsight-memory');
  const dir = join(pluginData, 'state');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Sanitize a filename to prevent path traversal.
 *
 * Strips path separators, `..`, and control characters. Mirrors the Openclaw
 * `sanitizeFilename()` helper.
 */
export function safeFilename(name: string): string {
  const stripped = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replaceAll('..', '_')
    .slice(0, 200);
  return stripped || 'state';
}

/** Get the path for a state file. The name is sanitized to prevent traversal. */
export function stateFile(name: string): string {
  const dir = stateDir();
  const base = resolve(dir);
  const path = resolve(base, safeFilename(name));
  // Defence in depth: the sanitized name must still land inside the state dir.
  if (path !== base && !path.startsWith(base + sep)) {
    throw new Error(`State file path escapes state directory: ${JSON.stringify(name)}`);
  }
  return path;
}

/** Read a JSON state file. Returns the default when missing or unreadable. */
export function readState<T>(name: string, defaultValue: T): T {
  try {
    const text = readFileSync(stateFile(name), 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return defaultValue;
  }
}

/** Write a JSON state file atomically (temp file + rename). */
export function writeState(name: string, data: unknown): void {
  const path = stateFile(name);
  const tmpPath = `${path}.tmp`;
  try {
    writeFileAtomic(tmpPath, path, JSON.stringify(data));
  } catch {
    // Best-effort cleanup of the temp file; a failed write must never throw at
    // the hook boundary (state is advisory, not load-bearing).
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore
    }
  }
}

function writeFileAtomic(tmpPath: string, path: string, contents: string): void {
  const fd = openSync(tmpPath, 'w');
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

/**
 * Run `fn` while holding an exclusive lock. Falls back to running without the
 * lock if it cannot be acquired, matching the Python implementation's behaviour
 * on platforms without `flock`.
 */
export function withLock<T>(lockName: string, fn: () => T): T {
  const lockPath = stateFile(lockName);
  const acquired = acquireLock(lockPath);
  try {
    return fn();
  } finally {
    if (acquired) {
      releaseLock(lockPath);
    }
  }
}

function acquireLock(lockPath: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;
  // Synchronous busy-wait: hooks are short-lived processes and the critical
  // sections are tiny file operations, so a sleep loop is simpler and more
  // predictable than an async lock.
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return false;
      }
    }

    if (isStaleLock(lockPath)) {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Another process may have won the race — retry the acquisition.
      }
      continue;
    }

    if (Date.now() >= deadline) {
      return false;
    }
    sleepSync(LOCK_RETRY_INTERVAL_MS);
  }
}

function releaseLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // ignore — a stale lock is reclaimed by the next contender
  }
}

function isStaleLock(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  // Atomics.wait is permitted on the Node main thread and gives a true
  // synchronous sleep without spawning a timer thread.
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/**
 * Increment and return the turn count for a session.
 *
 * Concurrent hooks (async Stop + new UserPromptSubmit) must not lose counts,
 * hence the lock.
 */
export function incrementTurnCount(sessionId: string): number {
  return withLock('turns.lock', () => {
    const turns = readState<Record<string, number>>('turns.json', {});
    turns[sessionId] = (turns[sessionId] ?? 0) + 1;
    capTrackedKeys(turns);
    writeState('turns.json', turns);
    return turns[sessionId];
  });
}

/** Drop the older half of a tracking map so long-lived installs stay bounded. */
function capTrackedKeys(data: Record<string, unknown>): void {
  const keys = Object.keys(data);
  if (keys.length <= 10_000) {
    return;
  }
  keys.sort();
  for (const key of keys.slice(0, Math.floor(keys.length / 2))) {
    delete data[key];
  }
}

/** Read-modify-write a state file under the lock. */
function lockedReadModifyWrite<T>(
  stateName: string,
  lockName: string,
  modify: (data: Record<string, unknown>) => [Record<string, unknown>, T],
): T {
  return withLock(lockName, () => {
    const data = readState<Record<string, unknown>>(stateName, {});
    const [updated, result] = modify(data);
    writeState(stateName, updated);
    return result;
  });
}

interface RetentionEntry {
  message_count: number;
  chunk: number;
}

/**
 * Plan retention state without writing the checkpoint.
 *
 * The caller must only commit the returned progress after the retain request
 * succeeds; otherwise a transient API failure would skip unsent messages on the
 * next hook run.
 */
export function planRetention(sessionId: string, messageCount: number): RetentionProgress {
  const data = readState<Record<string, RetentionEntry>>('retention_tracking.json', {});
  const entry = data[sessionId] ?? { message_count: 0, chunk: 0 };
  const lastCount = entry.message_count;
  let chunk = entry.chunk;
  let compacted = false;
  let startIndex = lastCount;

  if (messageCount < lastCount) {
    // Transcript shrank — compaction happened. The compacted transcript is new
    // canonical content, so send it as a fresh chunk rather than trying to diff
    // it against the pre-compaction transcript.
    chunk += 1;
    compacted = true;
    startIndex = 0;
  } else if (messageCount > lastCount && lastCount > 0) {
    // The transcript grew normally. Store only the new suffix in its own
    // document so repeated Stop hooks grow linearly instead of resending the
    // whole session under a replacement document_id.
    chunk += 1;
  } else if (messageCount === lastCount) {
    startIndex = messageCount;
  }

  return { chunkIndex: chunk, compacted, startIndex };
}

/** Persist the checkpoint for a successful retain. */
export function commitRetention(sessionId: string, messageCount: number, chunkIndex: number): void {
  lockedReadModifyWrite('retention_tracking.json', 'retention_tracking.lock', (data) => {
    data[sessionId] = { message_count: messageCount, chunk: chunkIndex };
    capTrackedKeys(data);
    return [data, undefined];
  });
}

/**
 * Track retention state, compaction, and the next unsent message offset.
 *
 * Full-session mode reads Claude Code's cumulative transcript, but each retain
 * should only send messages added since the previous successful hook run.
 * Reusing a document_id replaces that document on the server, so incremental
 * payloads use a monotonically increasing chunk id. When the transcript
 * shrinks, Claude Code compacted the session; the new compacted transcript
 * starts a fresh chunk.
 */
export function trackRetention(sessionId: string, messageCount: number): RetentionProgress {
  const progress = planRetention(sessionId, messageCount);
  commitRetention(sessionId, messageCount, progress.chunkIndex);
  return progress;
}
