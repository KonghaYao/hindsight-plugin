/**
 * Shared helpers for the vitest suite.
 *
 * The Python suite leaned on pytest fixtures (`state_dir`, `plugin_root`,
 * `default_config`) plus a `monkeypatch`-based environment scrub. The equivalent
 * here is `createEnvSandbox()`, which gives each test its own HOME, plugin root
 * and plugin data directory so no test can read or write the developer's real
 * configuration.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Environment keys the plugin reads; all are restored by `sandbox.restore()`. */
const PLUGIN_ENV_PREFIX = 'HINDSIGHT_';

export interface EnvSandbox {
  /** Temp directory holding the three sandbox directories below. */
  root: string;
  /** Stands in for `$HOME`, so `~/.hindsight/claude-code.json` is isolated. */
  homeDir: string;
  /** Stands in for `CLAUDE_PLUGIN_ROOT` (put a `settings.json` here). */
  pluginRoot: string;
  /** Stands in for `CLAUDE_PLUGIN_DATA` (state lives in `<pluginData>/state`). */
  pluginData: string;
  /** Convenience path to `<pluginData>/state`. */
  stateDir: string;
  /** Absolute path of the per-workspace config read through `HINDSIGHT_CONFIG`. */
  workspaceConfigPath: string;
  /** Write `settings.json` into the sandboxed plugin root. */
  writePluginSettings(settings: Record<string, unknown>): void;
  /** Write the user config into the sandboxed home (`~/.hindsight/claude-code.json`). */
  writeUserConfig(config: Record<string, unknown>): void;
  /**
   * Write the per-workspace config and return its absolute path. The caller
   * points `HINDSIGHT_CONFIG` at the result; nothing else reads this file, so
   * writing it alone changes no layer.
   */
  writeWorkspaceConfig(config: Record<string, unknown>): string;
  /** Set an env var for the duration of the test. */
  setEnv(key: string, value: string): void;
  /** Restore every touched env var and delete the sandbox directory. */
  restore(): void;
}

/**
 * Create an isolated HOME / CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA sandbox and
 * scrub every `HINDSIGHT_*` variable, so ambient configuration cannot leak in.
 */
export function createEnvSandbox(): EnvSandbox {
  const root = mkdtempSync(join(tmpdir(), 'hindsight-test-'));
  const homeDir = join(root, 'home');
  const pluginRoot = join(root, 'plugin_root');
  const pluginData = join(root, 'plugin_data');
  for (const dir of [homeDir, pluginRoot, pluginData]) {
    mkdirSync(dir, { recursive: true });
  }

  // Original values, recorded once so repeated setEnv calls still restore fully.
  const saved = new Map<string, string | undefined>();
  const remember = (key: string): void => {
    if (!saved.has(key)) {
      saved.set(key, process.env[key]);
    }
  };

  for (const key of Object.keys(process.env)) {
    if (key.startsWith(PLUGIN_ENV_PREFIX)) {
      remember(key);
      delete process.env[key];
    }
  }

  const overrides: Array<[string, string]> = [
    ['HOME', homeDir],
    ['CLAUDE_PLUGIN_ROOT', pluginRoot],
    ['CLAUDE_PLUGIN_DATA', pluginData],
  ];
  for (const [key, value] of overrides) {
    remember(key);
    process.env[key] = value;
  }

  return {
    root,
    homeDir,
    pluginRoot,
    pluginData,
    stateDir: join(pluginData, 'state'),
    workspaceConfigPath: join(root, 'workspace.json'),

    writePluginSettings(settings: Record<string, unknown>): void {
      writeFileSync(join(pluginRoot, 'settings.json'), JSON.stringify(settings));
    },

    writeUserConfig(config: Record<string, unknown>): void {
      const dir = join(homeDir, '.hindsight');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'claude-code.json'), JSON.stringify(config));
    },

    writeWorkspaceConfig(config: Record<string, unknown>): string {
      const path = join(root, 'workspace.json');
      writeFileSync(path, JSON.stringify(config));
      return path;
    },

    setEnv(key: string, value: string): void {
      remember(key);
      process.env[key] = value;
    },

    restore(): void {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Hook input shaped like Claude Code's (`conftest.make_hook_input`). */
export function makeHookInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: 'What is the capital of France?',
    session_id: 'sess-abc123',
    cwd: '/home/user/myproject',
    transcript_path: '',
    ...overrides,
  };
}

/**
 * Write messages as a JSONL transcript file and return its path
 * (`conftest.make_transcript_file`).
 */
export function writeTranscriptFile(dir: string, messages: unknown[]): string {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, messages.map((message) => JSON.stringify(message)).join('\n'));
  return path;
}

/** One row for the Peri SQLite fixture. */
export interface PeriTestRow {
  role: string;
  content: unknown;
  /**
   * Stable row id. Defaults to an index-based id; tests that rewrite a thread
   * must set explicit ids so the surviving/rewritten tail is distinguishable.
   */
  messageId?: string;
  /** Insert a legacy unwrapped `BaseMessage` row instead of the V1 envelope. */
  legacy?: boolean;
  /** V1 envelope type; defaults to `message`, use `system_reminder` for UI rows. */
  type?: string;
  excluded?: boolean;
  truncated?: boolean;
}

/**
 * Create a Peri-shaped SQLite database and return its path.
 *
 * The schema mirrors Peri's `threads` / `messages` tables, and rows are inserted
 * in the given order because the reader relies on `rowid` ordering. The database
 * is recreated on every call so a test can model a thread growing between two
 * Stop hooks by writing the full row list again.
 */
export function writePeriDatabase(dir: string, sessionId: string, rows: PeriTestRow[]): string {
  const path = join(dir, 'peri-threads.db');
  rmSync(path, { force: true });

  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        message_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        truncated BOOLEAN NOT NULL DEFAULT 0,
        excluded BOOLEAN NOT NULL DEFAULT 0,
        projection TEXT
      );
    `);
    db.prepare('INSERT INTO threads (id, message_count) VALUES (?, ?)').run(sessionId, rows.length);

    const insert = db.prepare(`
      INSERT INTO messages (message_id, thread_id, role, content, truncated, excluded)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    rows.forEach((row, index) => {
      const messageId = row.messageId ?? `${sessionId}-msg-${index + 1}`;
      const body = { role: row.role, id: messageId, content: row.content };
      let payload: unknown;
      if (row.type === 'system_reminder') {
        // Peri's real reminder rows carry no `message` key at all.
        payload = {
          version: 1,
          type: 'system_reminder',
          id: messageId,
          reminder: { content: row.content },
        };
      } else if (row.legacy) {
        payload = body;
      } else {
        payload = { version: 1, type: row.type ?? 'message', message: body };
      }
      insert.run(
        messageId,
        sessionId,
        row.role,
        JSON.stringify(payload),
        row.truncated ? 1 : 0,
        row.excluded ? 1 : 0,
      );
    });
  } finally {
    db.close();
  }
  return path;
}

/** Build a fake `/memories/recall` response (`conftest.make_recall_response`). */
export function makeRecallResponse(memories: unknown[]): Record<string, unknown> {
  return { results: memories };
}

/** Build a fake recalled memory (`conftest.make_memory`). */
export function makeMemory(
  text: string,
  type = 'experience',
  mentionedAt = '2024-01-15',
): Record<string, unknown> {
  return { text, type, mentioned_at: mentionedAt };
}
