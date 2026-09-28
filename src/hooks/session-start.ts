/**
 * SessionStart hook: health check + session logging.
 *
 * Fires once when a Claude Code session begins. Uses additionalContext
 * (supported on SessionStart) to inject an initial system note if
 * Hindsight is available.
 *
 * This is the Claude Code equivalent of Openclaw's service.start() —
 * verify the server is reachable early, before the first prompt.
 */
import { basename } from 'node:path';
import { debugLog, loadConfig } from '../lib/config';
import { getApiUrl, prestartDaemonBackground } from '../lib/daemon';
import { upgradeNotice } from '../lib/upgrade-notice';

/** The hook script Claude Code executes — see the entry guard below. */
const ENTRY_FILE = /^session-start\.[cm]?[jt]s$/;

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

  // Emitted BEFORE any of the early returns below: whether memory is enabled, or the server is
  // even reachable, has no bearing on whether this plugin has been superseded. `systemMessage` is
  // the channel Claude Code shows to the USER (additionalContext would only reach the model).
  const notice = upgradeNotice(config);
  if (notice) {
    const payload = {
      systemMessage: notice,
      hookSpecificOutput: { hookEventName: 'SessionStart' },
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  if (!config.autoRecall && !config.autoRetain) {
    debugLog(config, 'Both autoRecall and autoRetain disabled, skipping session start');
    return;
  }

  // Consume stdin
  const hookInput = parseHookInput(await readStdin()) ?? {};

  debugLog(config, `SessionStart hook, source: ${hookField(hookInput, 'source', 'unknown')}`);

  // Try to resolve API URL (health check). Don't start daemon here —
  // that's too slow for session start. Just check if server is reachable.
  const debugFn = (message: string): void => debugLog(config, message);

  try {
    const apiUrl = await getApiUrl(config, debugFn, false);
    debugLog(config, `Hindsight server reachable at ${apiUrl}`);
  } catch (error) {
    // Server not running — kick off background pre-start so it's ready
    // by the time the first recall or retain hook fires.
    debugLog(config, `Hindsight not running, initiating background pre-start: ${errorText(error)}`);
    await prestartDaemonBackground(config, debugFn);
  }
}

/** Mirrors Python's top-level `try: main() except Exception: ...; sys.exit(0)`. */
export async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(`[Hindsight] SessionStart error: ${errorText(error)}`);
    process.exit(0);
  }
}

if (isEntryModule()) {
  run().catch((error: unknown) => {
    // Defence in depth — `run` already handles every throw path.
    console.error(`[Hindsight] SessionStart error: ${errorText(error)}`);
  });
}
