/**
 * Auto-recall hook for UserPromptSubmit.
 *
 * Port of: before_prompt_build handler in Openclaw index.js
 * Adapted for Claude Code hooks (ephemeral process, JSON stdin/stdout).
 *
 * Flow:
 *   1. Read hook input from stdin (prompt, session_id, transcript_path, cwd)
 *   2. Resolve API URL (external, existing local, or auto-start daemon)
 *   3. Derive bank ID (static or dynamic from project context)
 *   4. Ensure bank mission is set (first use only)
 *   5. Compose multi-turn query if recallContextTurns > 1
 *   6. Truncate to recallMaxQueryChars
 *   7. Call Hindsight recall API
 *   8. Format memories and output hookSpecificOutput.additionalContext
 *   9. Save last recall to state (for PostCompact re-injection)
 *
 * Exit codes:
 *   0 — always (graceful degradation on any error)
 *
 * Not a program: `src/cli.ts` imports this module and calls `run()`, so there is
 * no entry guard here.
 */
import { readFileSync, statSync } from 'node:fs';
import { deriveBankId, ensureBankMission } from '../lib/bank';
import { HindsightClient } from '../lib/client';
import type { PluginConfig } from '../lib/config';
import { debugLog, loadConfig } from '../lib/config';
import {
  composeRecallQuery,
  formatCurrentTime,
  formatMemories,
  truncateRecallQuery,
} from '../lib/content';
import { getApiUrl } from '../lib/daemon';
import { writeState } from '../lib/state';

const LAST_RECALL_STATE = 'last_recall.json';

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
    // A failed read must not take the hook down with it — the unreadable text
    // falls through to the same "bad hook input" path as malformed JSON.
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
  return isRecord(parsed) ? parsed : {};
}

/** True for JSON objects (Python's `isinstance(x, dict)`). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Python truthiness for JSON values.
 *
 * Empty containers and strings are falsy in Python but truthy in JS, and the API
 * client decides on `if (x)` whether a field goes into the request body — so an
 * empty list must reach it as null, not as `[]`.
 */
function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  if (typeof value === 'string') {
    return value.length > 0;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return value !== null && value !== undefined && value !== false;
}

/** A non-empty list of strings, or null (Python's `value or None`). */
function stringListOrNull(value: unknown): string[] | null {
  return Array.isArray(value) && value.length > 0 ? (value as string[]) : null;
}

/**
 * Render a value the way Python's `repr()` would.
 *
 * Debug output is compared verbatim against the Python original, and `repr()`
 * quotes strings while `str()` does not.
 */
function pythonRepr(value: unknown): string {
  if (typeof value === 'string') {
    return `'${value}'`;
  }
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonRepr(item)).join(', ')}]`;
  }
  if (isRecord(value)) {
    const pairs = Object.entries(value).map(
      ([key, item]) => `${pythonRepr(key)}: ${pythonRepr(item)}`,
    );
    return `{${pairs.join(', ')}}`;
  }
  return String(value);
}

/**
 * Mirror Python's `float()` for the values a config file can hold.
 *
 * Returns null where Python would raise (None, lists, dicts, non-numeric text);
 * `float('')` raises too, which is why the empty string is rejected explicitly.
 */
function toFloat(value: unknown): number | null {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') {
      return null;
    }
    const parsed = Number(text);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** `os.path.isfile` — false for directories and missing paths. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** UTC timestamp in the exact shape of Python's `time.strftime("%Y-%m-%dT%H:%M:%SZ")`. */
function utcTimestamp(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

/**
 * Drop recall results whose numeric scores are below configured floors.
 */
function filterByMinScores(
  results: unknown[],
  minScores: Record<string, unknown>,
  config: PluginConfig,
): unknown[] {
  if (!pyTruthy(minScores)) {
    return results;
  }

  const floors = new Map<string, number>();
  for (const [field, floor] of Object.entries(minScores)) {
    const parsed = toFloat(floor);
    if (parsed === null) {
      debugLog(
        config,
        `Ignoring invalid recallMinScores floor for '${field}': ${pythonRepr(floor)}`,
      );
    } else {
      floors.set(field, parsed);
    }
  }
  if (floors.size === 0) {
    return results;
  }

  const passesFloors = (result: unknown): boolean => {
    const scores = isRecord(result) ? result.scores : undefined;
    const scoreMap = isRecord(scores) ? scores : {};
    for (const [field, floor] of floors) {
      const value = scoreMap[field];
      // Missing/None scores pass (fail-open): BM25-only hits lack semantic
      // scores, and passthrough rerankers report null.
      if (typeof value === 'number' && value < floor) {
        return false;
      }
    }
    return true;
  };

  const beforeCount = results.length;
  const filtered = results.filter((result) => passesFloors(result));
  const droppedCount = beforeCount - filtered.length;
  debugLog(config, `Score floors dropped ${droppedCount}/${beforeCount} results`);
  return filtered;
}

/**
 * Read messages from a JSONL transcript file for multi-turn context.
 *
 * Claude Code transcript format nests messages:
 *   {type: "user", message: {role: "user", content: "..."}, uuid: "...", ...}
 * Also supports flat format for testing:
 *   {role: "user", content: "..."}
 */
function readTranscriptMessages(transcriptPath: string): Record<string, unknown>[] {
  if (!transcriptPath || !isFile(transcriptPath)) {
    return [];
  }

  let contents: string;
  try {
    contents = readFileSync(transcriptPath, 'utf8');
  } catch {
    return []; // `except OSError: pass`
  }

  const messages: Record<string, unknown>[] = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // `except json.JSONDecodeError: continue`
    }
    if (!isRecord(entry)) {
      continue;
    }

    // Claude Code nested format: {type: "user", message: {role, content}}
    if (entry.type === 'user' || entry.type === 'assistant') {
      const message = entry.message;
      if (isRecord(message) && pyTruthy(message.role)) {
        messages.push(message);
      }
    } else if ('role' in entry && 'content' in entry) {
      // Flat format (testing / future compatibility)
      messages.push(entry);
    }
  }
  return messages;
}

export async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.autoRecall) {
    debugLog(config, 'Auto-recall disabled, exiting');
    return;
  }

  // Read hook input from stdin
  const hookInput = parseHookInput(await readStdin());
  if (hookInput === null) {
    console.error('[Hindsight] Failed to read hook input');
    return;
  }

  debugLog(config, `Hook input keys: ${pythonRepr(Object.keys(hookInput))}`);

  // Extract user query — hooks-reference.md documents "prompt", but some
  // Claude Code sources reference "user_prompt". Accept both defensively.
  const promptSource = hookInput.prompt || hookInput.user_prompt || '';
  const prompt = typeof promptSource === 'string' ? promptSource.trim() : '';
  if (!prompt || prompt.length < 5) {
    debugLog(config, 'Prompt too short for recall, skipping');
    return;
  }

  // Resolve API URL (handles all three connection modes)
  const debugFn = (message: string): void => debugLog(config, message);

  let apiUrl: string;
  try {
    apiUrl = await getApiUrl(config, debugFn, false);
  } catch (error) {
    console.error(`[Hindsight] ${errorText(error)}`);
    return;
  }

  let client: HindsightClient;
  try {
    client = new HindsightClient(apiUrl, config.hindsightApiToken, config.requestTimeoutSeconds);
  } catch (error) {
    console.error(`[Hindsight] Invalid API URL: ${errorText(error)}`);
    return;
  }

  // Derive bank ID (static or dynamic from project context)
  const bankId = deriveBankId(hookInput, config);

  // Set bank mission on first use
  await ensureBankMission(client, bankId, config, debugFn);

  // Multi-turn query composition
  const recallContextTurns = config.recallContextTurns;
  const recallMaxQueryChars = config.recallMaxQueryChars;
  const recallRoles = config.recallRoles;

  let query: string;
  if (recallContextTurns > 1) {
    const transcriptPath =
      typeof hookInput.transcript_path === 'string' ? hookInput.transcript_path : '';
    const messages = readTranscriptMessages(transcriptPath);
    debugLog(
      config,
      `Multi-turn context: ${recallContextTurns} turns, ${messages.length} messages from transcript`,
    );
    query = composeRecallQuery(prompt, messages, recallContextTurns, recallRoles);
  } else {
    query = prompt;
  }

  query = truncateRecallQuery(query, prompt, recallMaxQueryChars);

  // Final defensive cap (mirrors Openclaw)
  if (query.length > recallMaxQueryChars) {
    query = query.slice(0, recallMaxQueryChars);
  }

  debugLog(config, `Recalling from bank '${bankId}', query length: ${query.length}`);

  const recallTags = stringListOrNull(config.recallTags);
  const tagGroups = pyTruthy(config.recallTagGroups) ? config.recallTagGroups : null;
  const tagsMatch = recallTags || tagGroups ? config.recallTagsMatch : null;
  const additionalBankFilters = config.recallAdditionalBankFilters;
  const recallTypes = stringListOrNull(config.recallTypes);

  // Call Hindsight recall API
  let response: Record<string, unknown>;
  try {
    response = await client.recall(
      bankId,
      query,
      config.recallMaxTokens,
      config.recallBudget,
      recallTypes,
      recallTags,
      tagsMatch,
      tagGroups,
      10,
    );
  } catch (error) {
    console.error(`[Hindsight] Recall failed: ${errorText(error)}`);
    return;
  }

  let results: unknown[] = Array.isArray(response.results) ? [...response.results] : [];

  // Also recall from any additional banks (e.g. shared user profile bank).
  // Skip the primary (already recalled above) and any repeated entry so
  // bidirectional cross-bank setups don't re-recall a bank they already hit.
  const additionalBanks = config.recallAdditionalBanks;
  const seenBanks = new Set<string>([bankId]);
  for (const extraBankId of additionalBanks) {
    if (seenBanks.has(extraBankId)) {
      continue;
    }
    seenBanks.add(extraBankId);

    const rawFilter = additionalBankFilters[extraBankId];
    const extraFilter = isRecord(rawFilter) ? rawFilter : {};
    const extraTagsValue = 'recallTags' in extraFilter ? extraFilter.recallTags : recallTags;
    const extraTagGroupsValue =
      'recallTagGroups' in extraFilter ? extraFilter.recallTagGroups : tagGroups;
    const extraTags = stringListOrNull(extraTagsValue);
    const extraTagGroups = pyTruthy(extraTagGroupsValue) ? extraTagGroupsValue : null;
    let extraTagsMatchValue: unknown = null;
    if ('recallTagsMatch' in extraFilter) {
      extraTagsMatchValue = extraFilter.recallTagsMatch;
    } else if (extraTags || extraTagGroups) {
      extraTagsMatchValue = tagsMatch;
    }
    const extraTagsMatch = typeof extraTagsMatchValue === 'string' ? extraTagsMatchValue : null;

    try {
      const extraResponse = await client.recall(
        extraBankId,
        query,
        config.recallMaxTokens,
        config.recallBudget,
        recallTypes,
        extraTags,
        extraTagsMatch,
        extraTagGroups,
        10,
      );
      const extraResults = Array.isArray(extraResponse.results) ? extraResponse.results : [];
      if (extraResults.length > 0) {
        debugLog(
          config,
          `Got ${extraResults.length} memories from additional bank '${extraBankId}'`,
        );
        results = [...results, ...extraResults];
      }
    } catch (error) {
      debugLog(config, `Recall from additional bank '${extraBankId}' failed: ${errorText(error)}`);
    }
  }

  results = filterByMinScores(results, config.recallMinScores, config);

  if (results.length === 0) {
    debugLog(config, 'No memories found');
    return;
  }

  debugLog(config, `Injecting ${results.length} memories`);

  // Format context message — exact match of Openclaw's format
  const memoriesFormatted = formatMemories(results);
  const preamble = config.recallPromptPreamble;
  const currentTime = formatCurrentTime();

  const contextMessage = `<hindsight_memories>\n${preamble}\nCurrent time - ${currentTime}\n\n${memoriesFormatted}\n</hindsight_memories>`;

  // Save last recall to state for diagnostics
  writeState(LAST_RECALL_STATE, {
    context: contextMessage,
    saved_at: utcTimestamp(),
    bank_id: bankId,
    result_count: results.length,
  });

  // Output JSON for Claude Code hook system
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: contextMessage,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

/** Mirrors Python's top-level `try: main() except Exception: ...` block. */
export async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(`[Hindsight] Unexpected error in recall: ${errorText(error)}`);
    // Debug mode keeps the failure visible by exiting 1 — a non-blocking error,
    // whose stderr Claude Code shows. Never 2: that is the blocking code, and on
    // `UserPromptSubmit` it rejects the prompt, so a bug in recall would cost the
    // user the message they just typed.
    try {
      process.exit(loadConfig().debug ? 1 : 0);
    } catch {
      process.exit(0);
    }
  }
}
