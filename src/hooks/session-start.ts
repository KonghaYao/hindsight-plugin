/**
 * SessionStart hook: health check + daemon pre-start.
 *
 * Fires once when a Claude Code session begins and verifies the server is
 * reachable before the first prompt, so the first recall does not also pay for
 * discovering that nothing is listening yet. Writes nothing to stdout: there is no
 * context for it to add, and a hook that says nothing is one less thing between
 * the user and their session.
 *
 * This is the Claude Code equivalent of Openclaw's service.start().
 *
 * Not a program: `src/cli.ts` imports this module and calls `run()`, so there is
 * no entry guard here.
 */
import { debugLog, loadConfig } from '../lib/config';
import { getApiUrl, prestartDaemonBackground } from '../lib/daemon';

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
