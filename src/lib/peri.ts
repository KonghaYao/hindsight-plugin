/**
 * Read conversations from Peri's local SQLite session store.
 *
 * Peri runs the same Claude Code hooks but does not write a JSONL transcript:
 * when its hooks fire, `transcript_path` is an empty string and the session
 * lives in `~/.peri/threads/threads.db` (or `PERI_DB_PATH`). This module
 * recognises that input shape, reads the current thread's messages and returns
 * them in the same `{role, content}` form the transcript readers produce, so the
 * retain and recall pipelines need no second formatting path.
 *
 * The store is opened read-only. Peri owns the file, and a hook that runs on the
 * host's critical path must never write to it. Missing, locked, corrupt or
 * unreadable stores are diagnostics, not failures: the caller skips retention
 * without claiming anything was saved.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from './config';
import { debugLog } from './config';

/** Rows for one thread, in insertion order, excluding rows Peri has hidden. */
const MESSAGES_SQL =
  'SELECT message_id, role, content FROM messages ' +
  'WHERE thread_id = ?1 AND excluded = 0 ORDER BY rowid';

/** Upper bound on how long a read may wait for Peri's writer. */
const BUSY_TIMEOUT_MS = 2000;

/** Messages for one thread plus the id of the last one the reader accepted. */
export interface PeriMessageBatch {
  readonly messages: Record<string, unknown>[];
  /**
   * Fingerprint of the active thread. Peri physically deletes messages on
   * rewind, so a delete followed by appends can leave the count unchanged; the
   * last message id is what lets the retention checkpoint tell "nothing new"
   * from "the thread was rewritten".
   */
  readonly lastMessageId: string;
}

/** Minimal shape shared by `node:sqlite`'s StatementSync and `bun:sqlite`'s Statement. */
interface PeriStatement {
  all(...params: unknown[]): unknown[];
}

/** Minimal shape shared by `node:sqlite`'s DatabaseSync and `bun:sqlite`'s Database. */
interface PeriDatabase {
  exec?: (sql: string) => unknown;
  prepare?: (sql: string) => PeriStatement;
  query?: (sql: string) => PeriStatement;
  close(): void;
}

/** The two built-in SQLite modules, which expose different constructor names. */
interface PeriSqliteModule {
  Database?: new (path: string, options: Record<string, unknown>) => PeriDatabase;
  DatabaseSync?: new (path: string, options: Record<string, unknown>) => PeriDatabase;
}

/** Message text of an error, matching the hooks' `str(e)` formatting. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for JSON objects, matching the hooks' local helper. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True only when the error is "the store is not there" (expected in Claude Code). */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Default location of Peri's thread database. */
export function defaultPeriDbPath(): string {
  return join(homedir(), '.peri', 'threads', 'threads.db');
}

/**
 * Resolve the database path.
 *
 * `PERI_DB_PATH` overrides the default; an empty value counts as unset, because
 * an exported-but-empty variable is what shells and hook runners leave behind.
 */
export function resolvePeriDbPath(): string {
  const override = process.env.PERI_DB_PATH;
  return override !== undefined && override !== '' ? override : defaultPeriDbPath();
}

/**
 * True when the hook input describes a Peri session.
 *
 * Peri always supplies both fields, with an empty `transcript_path` because it
 * has no Claude Code JSONL file. A non-empty transcript keeps the original
 * Claude Code path, even if a session id happens to be present.
 */
export function isPeriSession(hookInput: Record<string, unknown>): boolean {
  const transcriptPath =
    typeof hookInput.transcript_path === 'string' ? hookInput.transcript_path : '';
  const sessionId = typeof hookInput.session_id === 'string' ? hookInput.session_id : '';
  return transcriptPath === '' && sessionId !== '';
}

/**
 * Parse one `messages.content` cell.
 *
 * Two shapes exist in the wild:
 *   V1:     {"version":1,"type":"message","message":{"role":"user","content":...}}
 *   legacy: {"role":"user","id":"...","content":...}
 *
 * Returns the message, the string `'skip'` for a known non-conversation row
 * (`system_reminder`), or null for anything unusable. `content` stays in its
 * stored form — a string or a block array — because the existing content
 * helpers already understand both.
 */
function parsePeriRow(row: unknown): Record<string, unknown> | 'skip' | null {
  if (!isRecord(row) || typeof row.content !== 'string') {
    return null;
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(row.content);
  } catch {
    return null;
  }
  if (!isRecord(envelope)) {
    return null;
  }

  // Reminders are UI/system rows that happen to share the messages table.
  if (envelope.type === 'system_reminder') {
    return 'skip';
  }
  if (envelope.type !== undefined && envelope.type !== 'message') {
    return null; // unknown envelope
  }
  if (envelope.version !== undefined && envelope.version !== 1) {
    return null; // unknown schema version
  }

  const message = isRecord(envelope.message) ? envelope.message : envelope;
  const role = message.role;
  const content = message.content;
  if (typeof role !== 'string' || role === '') {
    return null;
  }
  if (typeof content !== 'string' && !Array.isArray(content)) {
    return null;
  }
  return { role, content };
}

/** Open the database with the built-in driver for the current runtime. */
async function openPeriDatabase(dbPath: string): Promise<PeriDatabase> {
  // A computed specifier keeps Bun.build from trying to resolve either built-in
  // module: the bundle must run under both Bun and Node without npm packages.
  const specifier = process.versions.bun ? 'bun:sqlite' : 'node:sqlite';
  const module = (await import(specifier)) as PeriSqliteModule;

  const isBun = Boolean(process.versions.bun);
  const Constructor = isBun ? module.Database : module.DatabaseSync;
  if (Constructor === undefined) {
    throw new Error(`${specifier} did not export a database constructor`);
  }

  const options = isBun ? { readonly: true } : { readOnly: true, timeout: BUSY_TIMEOUT_MS };
  const db = new Constructor(dbPath, options);
  // Node honours `timeout` above; Bun takes the option only from the pragma.
  db.exec?.(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

/**
 * Read all conversation messages for `sessionId`.
 *
 * Returns null when the backend is unavailable (missing file, unsupported
 * runtime, unreadable/locked/corrupt database) or the thread has no retainable
 * messages; the callers treat null as "nothing to retain/recall" and have
 * already received the diagnostic. Never throws.
 */
export async function readPeriMessages(
  sessionId: string,
  config: PluginConfig,
): Promise<PeriMessageBatch | null> {
  let dbPath: string;
  try {
    dbPath = resolvePeriDbPath();
  } catch (error) {
    console.error(`[Hindsight] Peri session store unavailable: ${errorText(error)}; skipping`);
    return null;
  }

  try {
    if (!statSync(dbPath).isFile()) {
      console.error(
        `[Hindsight] Peri session store unavailable: ${dbPath} is not a file; skipping`,
      );
      return null;
    }
  } catch (error) {
    if (isNotFound(error)) {
      debugLog(config, `Peri session store not found at ${dbPath}; skipping`);
    } else {
      console.error(`[Hindsight] Peri session store unavailable: ${errorText(error)}; skipping`);
    }
    return null;
  }

  let db: PeriDatabase | null = null;
  try {
    db = await openPeriDatabase(dbPath);
    const statement = db.prepare?.(MESSAGES_SQL) ?? db.query?.(MESSAGES_SQL);
    if (statement === undefined) {
      throw new Error('SQLite driver exposes neither prepare() nor query()');
    }

    const messages: Record<string, unknown>[] = [];
    let lastMessageId: string | null = null;
    let skipped = 0;
    for (const row of statement.all(sessionId)) {
      const parsed = parsePeriRow(row);
      if (parsed === 'skip') {
        continue;
      }
      if (parsed === null) {
        skipped += 1;
        continue;
      }
      const messageId = isRecord(row) ? row.message_id : undefined;
      if (typeof messageId !== 'string' || messageId === '') {
        skipped += 1;
        continue;
      }
      messages.push(parsed);
      lastMessageId = messageId;
    }

    if (skipped > 0) {
      debugLog(config, `Peri session store: skipped ${skipped} unusable message row(s)`);
    }
    if (messages.length === 0 || lastMessageId === null) {
      debugLog(config, `Peri session store has no retainable messages for thread ${sessionId}`);
      return null;
    }
    return { messages, lastMessageId };
  } catch (error) {
    console.error(`[Hindsight] Peri session store unavailable: ${errorText(error)}; skipping`);
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Closing is best-effort; a failed close must not mask the read result.
    }
  }
}
