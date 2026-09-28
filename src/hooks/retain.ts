/**
 * Auto-retain hook for Stop event.
 *
 * Port of: agent_end handler in Openclaw index.js
 * Adapted for Claude Code hooks (ephemeral process, JSON stdin/stdout).
 *
 * Flow:
 *   1. Read hook input from stdin (session_id, transcript_path, cwd)
 *   2. Read conversation transcript from transcript_path
 *   3. Apply chunked retention logic (retainEveryNTurns + overlap window)
 *   4. Resolve API URL (external, existing local, or auto-start daemon)
 *   5. Derive bank ID and ensure mission
 *   6. Format transcript (strip memory tags, filter roles)
 *   7. POST to Hindsight retain API (async)
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
import { debugLog, loadConfig } from '../lib/config';
import { prepareRetentionTranscript, sliceLastTurnsByUserBoundary } from '../lib/content';
import { getApiUrl } from '../lib/daemon';
import type { RetentionProgress } from '../lib/state';
import { commitRetention, incrementTurnCount, planRetention } from '../lib/state';

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

/** Render a metadata value the way Python's `str()` would (unlike `repr`, no quotes). */
function pythonStr(value: unknown): string {
  return typeof value === 'string' ? value : pythonRepr(value);
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
 * Read a JSONL transcript file and return list of message dicts.
 *
 * Claude Code transcript format nests messages:
 *   {type: "user", message: {role: "user", content: "..."}, uuid: "...", ...}
 * Also supports flat format for testing:
 *   {role: "user", content: "..."}
 */
function readTranscript(transcriptPath: string): Record<string, unknown>[] {
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
      if (isRecord(message) && message.role) {
        messages.push(message);
      }
    } else if ('role' in entry && 'content' in entry) {
      // Flat format (testing / future compatibility)
      messages.push(entry);
    }
  }
  return messages;
}

export async function runRetain(hookInput: Record<string, unknown>, force = false): Promise<void> {
  const config = loadConfig();

  if (!config.autoRetain) {
    debugLog(config, 'Auto-retain disabled, exiting');
    return;
  }

  debugLog(
    config,
    `Retain hook_input keys: ${pythonRepr(Object.keys(hookInput))} force=${force ? 'True' : 'False'}`,
  );

  const sessionId = typeof hookInput.session_id === 'string' ? hookInput.session_id : 'unknown';
  const transcriptPath =
    typeof hookInput.transcript_path === 'string' ? hookInput.transcript_path : '';

  // Read full transcript
  const allMessages = readTranscript(transcriptPath);
  if (allMessages.length === 0) {
    debugLog(config, 'No messages in transcript, skipping retain');
    return;
  }

  debugLog(config, `Read ${allMessages.length} messages from transcript`);

  // Retention mode: full session (default) or chunked (legacy)
  const retainMode = config.retainMode;
  const retainEveryN = Math.max(1, config.retainEveryNTurns);
  let retainFullWindow = false;
  let messagesToRetain: Record<string, unknown>[] = allMessages;
  let documentId = sessionId;
  let retentionProgress: RetentionProgress | null = null;

  // Respect retainEveryNTurns in both modes, unless force=True (SessionEnd final retain)
  if (retainEveryN > 1 && !force) {
    const turnCount = incrementTurnCount(sessionId);
    if (turnCount % retainEveryN !== 0) {
      const nextAt = (Math.floor(turnCount / retainEveryN) + 1) * retainEveryN;
      debugLog(
        config,
        `Turn ${turnCount}/${retainEveryN}, skipping retain (next at turn ${nextAt})`,
      );
      return;
    }
  }

  // Document ID strategy:
  // - Chunked mode: each sliding-window chunk gets a timestamped document_id.
  // - Full-session mode: the transcript file is cumulative, but each retain only
  //   sends messages not retained by a previous Stop hook. Each suffix uses a new
  //   chunk document_id because reusing a document_id replaces the server-side
  //   document instead of appending to it. Chunk 0 keeps the plain session_id for
  //   backwards compatibility; later chunks use session_id-cN. If Claude Code
  //   compacts the transcript, the compacted transcript starts a fresh chunk.
  if (retainMode === 'chunked' && retainEveryN > 1) {
    // Sliding window: N turns + configured overlap
    const overlapTurns = config.retainOverlapTurns;
    const windowTurns = retainEveryN + overlapTurns;
    messagesToRetain = sliceLastTurnsByUserBoundary(allMessages, windowTurns);
    retainFullWindow = true;
    documentId = `${sessionId}-${Date.now()}`;
    debugLog(
      config,
      `Chunked retain firing (window: ${windowTurns} turns, ${messagesToRetain.length} messages)`,
    );
  } else {
    retentionProgress = planRetention(sessionId, allMessages.length);
    if (retentionProgress.startIndex >= allMessages.length) {
      debugLog(config, `No new messages for session ${sessionId}, skipping retain`);
      return;
    }
    messagesToRetain = allMessages.slice(retentionProgress.startIndex);
    retainFullWindow = retentionProgress.startIndex === 0;
    if (retentionProgress.compacted) {
      debugLog(
        config,
        `Compaction detected for session ${sessionId}: transcript shrank, ` +
          `retaining compacted transcript as chunk ${retentionProgress.chunkIndex}`,
      );
    }
    documentId =
      retentionProgress.chunkIndex === 0
        ? sessionId
        : `${sessionId}-c${retentionProgress.chunkIndex}`;
    debugLog(
      config,
      `Full session retain: ${messagesToRetain.length} new messages ` +
        `from ${allMessages.length} total into chunk ${retentionProgress.chunkIndex}`,
    );
  }

  // Format transcript
  const retainRoles = config.retainRoles;
  const includeToolCalls = config.retainToolCalls;
  const [transcript, messageCount] = prepareRetentionTranscript(
    messagesToRetain,
    retainRoles,
    retainFullWindow,
    includeToolCalls,
  );

  if (!transcript) {
    if (retentionProgress !== null) {
      commitRetention(sessionId, allMessages.length, retentionProgress.chunkIndex);
    }
    debugLog(config, 'Empty transcript after formatting, skipping retain');
    return;
  }

  // Resolve API URL
  const debugFn = (message: string): void => debugLog(config, message);

  let apiUrl: string;
  try {
    apiUrl = await getApiUrl(config, debugFn, true);
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

  // Derive bank ID and ensure mission
  const bankId = deriveBankId(hookInput, config);
  await ensureBankMission(client, bankId, config, debugFn);

  // Resolve template variables in tags and metadata.
  // Supported variables: {session_id}, {bank_id}, {timestamp}, {user_id}
  const timestamp = utcTimestamp();
  const templateVars: Record<string, string> = {
    session_id: sessionId,
    bank_id: bankId,
    timestamp,
    user_id: process.env.HINDSIGHT_USER_ID ?? '',
  };

  const resolveTemplate = (value: string): string => {
    let resolved = value;
    for (const [key, replacement] of Object.entries(templateVars)) {
      resolved = resolved.replaceAll(`{${key}}`, replacement);
    }
    return resolved;
  };

  // Tags from config with template resolution.
  // Drop tags whose resolved form ends in an empty namespace part (e.g. "user:"
  // when HINDSIGHT_USER_ID is unset). Tags without ':' are preserved as-is.
  const rawTags = config.retainTags;
  let tags: string[] | null;
  if (rawTags.length > 0) {
    const resolvedTags: string[] = [];
    for (const original of rawTags) {
      const resolved = resolveTemplate(original);
      const colonIndex = resolved.indexOf(':');
      if (colonIndex !== -1 && resolved.slice(colonIndex + 1) === '') {
        debugLog(config, `Dropping tag '${original}' -> '${resolved}' (empty content after ':')`);
        continue;
      }
      resolvedTags.push(resolved);
    }
    tags = resolvedTags.length > 0 ? resolvedTags : null;
  } else {
    tags = null;
  }

  // Metadata: merge built-in defaults with user-configured extras
  const metadata: Record<string, string> = {
    retained_at: timestamp,
    message_count: String(messageCount),
    session_id: sessionId,
  };
  for (const [key, value] of Object.entries(config.retainMetadata)) {
    metadata[key] = resolveTemplate(pythonStr(value));
  }

  debugLog(
    config,
    `Retaining to bank '${bankId}', doc '${documentId}', ${messageCount} messages, ${transcript.length} chars`,
  );
  if (tags) {
    debugLog(config, `Tags: ${pythonRepr(tags)}`);
  }

  // POST to Hindsight retain API
  try {
    const response = await client.retain(
      bankId,
      transcript,
      documentId,
      config.retainContext,
      metadata,
      tags,
      15,
    );
    if (retentionProgress !== null) {
      commitRetention(sessionId, allMessages.length, retentionProgress.chunkIndex);
    }
    debugLog(config, `Retain response: ${JSON.stringify(response).slice(0, 200)}`);
  } catch (error) {
    console.error(`[Hindsight] Retain failed: ${errorText(error)}`);
  }
}

export async function main(): Promise<void> {
  const hookInput = parseHookInput(await readStdin());
  if (hookInput === null) {
    console.error('[Hindsight] Failed to read hook input');
    return;
  }
  await runRetain(hookInput, false);
}

/** Mirrors Python's top-level `try: main() except Exception: ...` block. */
export async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(`[Hindsight] Unexpected error in retain: ${errorText(error)}`);
    // Debug mode keeps the failure visible by exiting 1 — a non-blocking error,
    // whose stderr Claude Code shows. Never 2: that is the blocking code, and
    // this hook runs on the critical path of every response.
    try {
      process.exit(loadConfig().debug ? 1 : 0);
    } catch {
      process.exit(0);
    }
  }
}
