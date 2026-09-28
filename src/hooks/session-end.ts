/**
 * SessionEnd hook: daemon cleanup.
 *
 * Fires once when a Claude Code session terminates. If the plugin
 * auto-started a hindsight-embed daemon, this is where we stop it.
 *
 * Port of: Openclaw's service.stop() in index.js
 */
import { basename } from 'node:path';
import { debugLog, loadConfig } from '../lib/config';
import { stopDaemon } from '../lib/daemon';

/** The hook script Claude Code executes — see the entry guard below. */
const ENTRY_FILE = /^session-end\.[cm]?[jt]s$/;

/**
 * Stand-in for Python's `if __name__ == "__main__":` guard.
 *
 * ESM has no main-module concept, and `import.meta.url` cannot stand in for one:
 * the bundler inlines every module a hook imports into its own single file, so
 * `import.meta.url` collapses to the output file's path inside *all* of them.
 * The entry script's own name is the one signal that survives bundling — and it
 * is also what keeps importing this module from a sibling hook or a test from
 * executing the hook as a side effect.
 */
function isEntryModule(): boolean {
  return ENTRY_FILE.test(basename(process.argv[1] ?? ''));
}

/** Message text of an error, matching Python's `str(e)` rather than JS's `String(error)`. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read all of stdin (`sys.stdin.read()`). Resolves with '' when stdin is empty or unreadable. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    // A failed read must not take the hook down with it — the unparseable text
    // falls through to the same "no hook input" path as empty stdin.
    process.stdin.on('error', () => resolve(data));
  });
}

/**
 * Parse hook input.
 *
 * Returns null when the text is not JSON at all (`json.JSONDecodeError` /
 * `EOFError`), and an empty object for JSON that is not a dict.
 */
function parseHookInput(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** Render `hook_input.get(key, fallback)` the way Python's f-string would. */
function hookField(input: Record<string, unknown>, key: string, fallback: string): string {
  const value = key in input ? input[key] : fallback;
  if (value === null || value === undefined) {
    return 'None';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export async function main(): Promise<void> {
  const config = loadConfig();

  // Consume stdin
  const hookInput = parseHookInput(await readStdin()) ?? {};

  debugLog(config, `SessionEnd hook, reason: ${hookField(hookInput, 'reason', 'unknown')}`);

  // Force a final retain before stopping the daemon — guarantees short sessions
  // (fewer turns than retainEveryNTurns) still land on disk.
  if (config.autoRetain && hookInput.transcript_path) {
    try {
      // Imported here rather than at the top, mirroring the original's in-function
      // `from retain import run_retain` — a failure to load it is caught below.
      const { runRetain } = await import('./retain');
      await runRetain(hookInput, true);
    } catch (error) {
      console.error(`[Hindsight] SessionEnd final retain error: ${errorText(error)}`);
    }
  }

  // Stop daemon if we started it
  const debugFn = (message: string): void => debugLog(config, message);
  stopDaemon(config, debugFn);
}

/** Mirrors Python's top-level `try: main() except Exception: ...; sys.exit(0)`. */
export async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(`[Hindsight] SessionEnd error: ${errorText(error)}`);
    process.exit(0);
  }
}

if (isEntryModule()) {
  run().catch((error: unknown) => {
    // Defence in depth — `run` already handles every throw path.
    console.error(`[Hindsight] SessionEnd error: ${errorText(error)}`);
  });
}
