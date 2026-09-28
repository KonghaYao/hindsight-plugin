/**
 * Content processing utilities.
 *
 * Faithful port of the Openclaw plugin's content processing: memory tag
 * stripping, query composition/truncation, transcript formatting, and memory
 * formatting.
 *
 * Source: reference/openclaw-source/index.js — stripMemoryTags, composeRecallQuery,
 * truncateRecallQuery, sliceLastTurnsByUserBoundary, prepareRetentionTranscript,
 * formatMemories.
 */

/** A transcript message as read from Claude Code's JSONL (`{ role, content }` and friends). */
export type TranscriptMessage = Record<string, unknown>;

/** One structured content block of a retained message (JSON retention mode). */
type ContentBlock = Record<string, unknown>;

/**
 * A retention payload plus the number of messages it covers, or `[null, 0]`
 * when there is nothing to retain (Python returns a `(None, 0)` tuple).
 */
export type RetentionTranscript = [transcript: string | null, messageCount: number];

// Fields in tool_use input that carry the outgoing message text.
// Ordered by likelihood — first match wins.
const MESSAGE_TEXT_FIELDS = ['text', 'body', 'message', 'content'] as const;

// MCP tool name suffixes that are operational, not conversational.
// Checked against the last segment of the tool name (after the last __).
const OPERATIONAL_TOOL_PATTERN =
  /(?:recall|retain|reflect|search|extract|create_|delete_|update_|get_|list_)/i;

// ---------------------------------------------------------------------------
// Memory tag stripping (anti-feedback-loop)
// ---------------------------------------------------------------------------

/**
 * Strip Claude Code channel XML wrappers from user messages.
 *
 * Claude Code wraps incoming channel messages in XML:
 *   <channel source="plugin:telegram:telegram" chat_id="..." ...>
 *   actual message text
 *   </channel>
 *
 * This is the Claude Code equivalent of Openclaw's stripMetadataEnvelopes().
 * Extracts the inner text, preserving the actual user message while removing
 * transport metadata that Hindsight doesn't need.
 */
export function stripChannelEnvelope(content: string): string {
  // Match <channel ...>content</channel> — extract inner text
  const match = /<channel\b[^>]*>([\s\S]*?)<\/channel>/.exec(content);
  if (match) {
    return (match[1] ?? '').trim();
  }
  return content;
}

/**
 * Remove `<hindsight_memories>` and `<relevant_memories>` blocks.
 *
 * Prevents retain feedback loop — these were injected during recall and
 * should not be re-stored.
 *
 * Port of: stripMemoryTags() in index.js
 */
export function stripMemoryTags(content: string): string {
  return content
    .replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, '')
    .replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/g, '');
}

// ---------------------------------------------------------------------------
// Recall: query composition and truncation
// ---------------------------------------------------------------------------

/**
 * Compose a multi-turn recall query from conversation history.
 *
 * Port of: composeRecallQuery() in index.js
 *
 * When recallContextTurns > 1, includes prior context from the transcript
 * above the latest user query. Format:
 *
 *     Prior context:
 *
 *     user: ...
 *     assistant: ...
 *
 *     <latest query>
 */
export function composeRecallQuery(
  latestQuery: string,
  messages: unknown,
  recallContextTurns: number,
  recallRoles?: readonly string[] | null,
): string {
  const latest = latestQuery.trim();
  if (recallContextTurns <= 1 || !isList(messages) || messages.length === 0) {
    return latest;
  }

  // An empty list means "no explicit roles" in Python (`recall_roles or [...]`).
  const allowedRoles = new Set<string>(
    recallRoles && recallRoles.length > 0 ? recallRoles : ['user', 'assistant'],
  );
  const contextualMessages = sliceLastTurnsByUserBoundary(messages, recallContextTurns);

  const contextLines: string[] = [];
  for (const message of contextualMessages) {
    const role = message.role;
    if (typeof role !== 'string' || !allowedRoles.has(role)) {
      continue;
    }

    let content = extractTextContent(message.content ?? '', role);
    content = stripChannelEnvelope(content);
    content = stripMemoryTags(content).trim();
    if (!content) {
      continue;
    }

    // Skip if this is the same as the latest query (avoid duplication)
    if (role === 'user' && content === latest) {
      continue;
    }

    contextLines.push(`${role}: ${content}`);
  }

  if (contextLines.length === 0) {
    return latest;
  }

  return ['Prior context:', contextLines.join('\n'), latest].join('\n\n');
}

/**
 * Truncate a composed recall query to maxChars.
 *
 * Port of: truncateRecallQuery() in index.js
 *
 * Preserves the latest user message. When the query contains "Prior context:",
 * drops oldest context lines first (from the top) to fit within the limit.
 */
export function truncateRecallQuery(query: string, latestQuery: string, maxChars: number): string {
  if (maxChars <= 0) {
    return query;
  }

  const latest = latestQuery.trim();
  if (query.length <= maxChars) {
    return query;
  }

  // If even the latest alone is too long, hard-truncate it
  const latestOnly = latest.length > maxChars ? latest.slice(0, maxChars) : latest;

  if (!query.includes('Prior context:')) {
    return latestOnly;
  }

  const contextMarker = 'Prior context:\n\n';
  const markerIndex = query.indexOf(contextMarker);
  if (markerIndex === -1) {
    return latestOnly;
  }

  const suffixMarker = `\n\n${latest}`;
  const suffixIndex = query.lastIndexOf(suffixMarker);
  if (suffixIndex === -1) {
    return latestOnly;
  }

  const suffix = query.slice(suffixIndex); // \n\n<latest>
  if (suffix.length >= maxChars) {
    return latestOnly;
  }

  const contextBody = query.slice(markerIndex + contextMarker.length, suffixIndex);
  const contextLines = contextBody.split('\n').filter((line) => line.length > 0);

  // Add context lines from newest (bottom) to oldest (top), stop when exceeding
  const kept: string[] = [];
  for (const line of [...contextLines].reverse()) {
    kept.unshift(line);
    const candidate = `${contextMarker}${kept.join('\n')}${suffix}`;
    if (candidate.length > maxChars) {
      kept.shift();
      break;
    }
  }

  if (kept.length > 0) {
    return `${contextMarker}${kept.join('\n')}${suffix}`;
  }
  return latestOnly;
}

// ---------------------------------------------------------------------------
// Turn slicing
// ---------------------------------------------------------------------------

/**
 * Slice messages to the last N turns, where a turn starts at a user message.
 *
 * Port of: sliceLastTurnsByUserBoundary() in index.js
 *
 * Walks backward counting user messages as turn boundaries. Returns
 * messages from the Nth user boundary to the end.
 */
export function sliceLastTurnsByUserBoundary(
  messages: unknown,
  turns: number,
): TranscriptMessage[] {
  if (!isList(messages) || messages.length === 0 || turns <= 0) {
    return [];
  }

  let userTurnsSeen = 0;
  let startIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === 'user') {
      userTurnsSeen += 1;
      if (userTurnsSeen >= turns) {
        startIndex = index;
        break;
      }
    }
  }

  if (startIndex === -1) {
    // Fewer turns than requested — the whole transcript is the context.
    return [...messages].filter(isRecord);
  }

  return messages.slice(startIndex).filter(isRecord);
}

// ---------------------------------------------------------------------------
// Memory formatting (recall results → context string)
// ---------------------------------------------------------------------------

/**
 * Format recall results into human-readable text.
 *
 * Port of: formatMemories() in index.js
 * Format: `- <text> [<type>] (<mentioned_at>)`
 */
export function formatMemories(results: unknown): string {
  if (!isList(results) || results.length === 0) {
    return '';
  }
  const lines: string[] = [];
  for (const result of results) {
    if (!isRecord(result)) {
      continue;
    }
    const text = asString(result.text);
    const memoryType = asString(result.type);
    const mentionedAt = asString(result.mentioned_at);
    const typeStr = memoryType ? ` [${memoryType}]` : '';
    const dateStr = mentionedAt ? ` (${mentionedAt})` : '';
    lines.push(`- ${text}${typeStr}${dateStr}`);
  }
  return lines.join('\n\n');
}

/**
 * Format current UTC time for recall context.
 *
 * The "UTC" suffix is explicit so client LLMs do not misread the
 * value as local time when reasoning about wall-clock context.
 *
 * Port of: formatCurrentTimeForRecall() in index.js
 */
export function formatCurrentTime(): string {
  // toISOString() is always UTC and zero-padded: 2026-01-31T09:05:00.000Z
  const iso = new Date().toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// ---------------------------------------------------------------------------
// Retention transcript formatting
// ---------------------------------------------------------------------------

/**
 * Extract structured content blocks from a message for JSON retention.
 *
 * Returns a list of dicts, each representing a content block:
 *   - `{type: "text", text: "..."}` for text blocks
 *   - `{type: "tool_use", name: "...", input: {...}}` for tool calls
 *   - Channel message tool_use blocks get their text extracted inline.
 */
function extractMessageBlocks(content: unknown, role = ''): ContentBlock[] {
  if (typeof content === 'string') {
    const cleaned = stripChannelEnvelope(stripMemoryTags(content)).trim();
    return cleaned ? [{ type: 'text', text: cleaned }] : [];
  }

  if (!isList(content)) {
    return [];
  }

  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    const blockType = asString(block.type);

    if (blockType === 'text') {
      const text = stripChannelEnvelope(stripMemoryTags(asString(block.text))).trim();
      if (text) {
        blocks.push({ type: 'text', text });
      }
    } else if (blockType === 'tool_use' && role === 'assistant') {
      if (isChannelMessageTool(block)) {
        // Channel messages: extract the outgoing text
        const toolInput = block.input;
        const input = isRecord(toolInput) ? toolInput : {};
        for (const field of MESSAGE_TEXT_FIELDS) {
          const value = input[field];
          if (typeof value === 'string' && value.trim()) {
            blocks.push({ type: 'text', text: value.trim() });
            break;
          }
        }
      } else {
        const name = typeof block.name === 'string' ? block.name : 'unknown';
        const input = block.input ?? {};
        // Skip Hindsight MCP tools to avoid feedback loops
        if (name.startsWith('mcp__') && OPERATIONAL_TOOL_PATTERN.test(toolSuffix(name))) {
          continue;
        }
        blocks.push({ type: 'tool_use', name, input });
      }
    } else if (blockType === 'tool_result') {
      // Include tool results for context.
      // content can be a plain string or a list of content blocks
      // (e.g. [{"type": "text", "text": "..."}] for Agent results).
      let resultContent: unknown = block.content ?? '';
      if (isList(resultContent)) {
        // Extract text from content blocks
        const parts: string[] = [];
        for (const item of resultContent) {
          if (isRecord(item) && item.type === 'text') {
            const text = asString(item.text).trim();
            if (text) {
              parts.push(text);
            }
          }
        }
        resultContent = parts.join('\n');
      }
      if (typeof resultContent === 'string' && resultContent.trim()) {
        let text = resultContent.trim();
        // Truncate very long results
        if (text.length > 2000) {
          text = `${text.slice(0, 2000)}... (truncated)`;
        }
        blocks.push({
          type: 'tool_result',
          tool_use_id: block.tool_use_id ?? '',
          content: text,
        });
      }
    }
  }

  return blocks;
}

/**
 * Format messages into a retention transcript.
 *
 * When includeToolCalls is true, outputs JSON with full message structure
 * including tool calls and their inputs. Otherwise outputs the legacy
 * text format with [role: ...]...[role:end] markers.
 *
 * - messages: List of message dicts with 'role' and 'content'.
 * - retainRoles: Roles to include (default: ['user', 'assistant']).
 * - retainFullWindow: If true, retain all messages (chunked mode).
 *   If false, retain only the last turn (last user msg + responses).
 * - includeToolCalls: If true, output JSON format with full tool call data.
 *
 * Returns `[transcript, messageCount]`, or `[null, 0]` if nothing to retain.
 */
export function prepareRetentionTranscript(
  messages: unknown,
  retainRoles?: readonly string[] | null,
  retainFullWindow = false,
  includeToolCalls = false,
): RetentionTranscript {
  if (!isList(messages) || messages.length === 0) {
    return [null, 0];
  }

  let targetMessages: unknown[];
  if (retainFullWindow) {
    targetMessages = messages;
  } else {
    // Default: retain only the last turn
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (isRecord(message) && message.role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex === -1) {
      return [null, 0];
    }
    targetMessages = messages.slice(lastUserIndex);
  }

  // An empty list means "no explicit roles" in Python (`retain_roles or [...]`).
  const allowedRoles = new Set<string>(
    retainRoles && retainRoles.length > 0 ? retainRoles : ['user', 'assistant'],
  );

  if (includeToolCalls) {
    return prepareJsonTranscript(targetMessages, allowedRoles);
  }
  return prepareTextTranscript(targetMessages, allowedRoles);
}

/** Format messages as JSON with full tool call data. */
function prepareJsonTranscript(
  messages: readonly unknown[],
  allowedRoles: Set<string>,
): RetentionTranscript {
  const structuredMessages: ContentBlock[] = [];
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    if (!allowedRoles.has(role)) {
      continue;
    }

    const blocks = extractMessageBlocks(message.content ?? '', role);
    if (blocks.length === 0) {
      continue;
    }

    structuredMessages.push({ role, content: blocks });
  }

  if (structuredMessages.length === 0) {
    return [null, 0];
  }

  const transcript = JSON.stringify(structuredMessages);
  if (transcript.trim().length < 10) {
    return [null, 0];
  }

  return [transcript, structuredMessages.length];
}

/** Format messages as legacy text with `[role:]...[role:end]` markers. */
function prepareTextTranscript(
  messages: readonly unknown[],
  allowedRoles: Set<string>,
): RetentionTranscript {
  const parts: string[] = [];

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    if (!allowedRoles.has(role)) {
      continue;
    }

    let content = extractTextContent(message.content ?? '', role);
    content = stripChannelEnvelope(content);
    content = stripMemoryTags(content).trim();

    if (!content) {
      continue;
    }

    parts.push(`[role: ${role}]\n${content}\n[${role}:end]`);
  }

  if (parts.length === 0) {
    return [null, 0];
  }

  const transcript = parts.join('\n\n');
  if (transcript.trim().length < 10) {
    return [null, 0];
  }

  return [transcript, parts.length];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect if a tool_use block is a channel message (reply/send).
 *
 * Uses a structural approach rather than name-matching for robustness:
 *   1. Must be an MCP tool (name starts with "mcp__")
 *   2. Must NOT match known operational patterns (recall, search, CRUD)
 *   3. Must have a text-like field in input (text, body, message, content)
 *
 * This catches any channel plugin (Telegram, Slack, Discord, Matrix,
 * future channels) without hardcoding tool names. Built-in tools (Bash,
 * Read, Write) don't start with mcp__. MCP tools for non-messaging
 * purposes (hindsight recall, search) are excluded by pattern and by
 * lacking text/body fields.
 */
export function isChannelMessageTool(block: TranscriptMessage): boolean {
  const name = asString(block.name);
  if (!name.startsWith('mcp__')) {
    return false;
  }

  // Exclude operational MCP tools (check only the tool suffix, not server name)
  if (OPERATIONAL_TOOL_PATTERN.test(toolSuffix(name))) {
    return false;
  }

  const toolInput = block.input;
  if (!isRecord(toolInput)) {
    return false;
  }

  // Must have a text-carrying field with actual content
  return MESSAGE_TEXT_FIELDS.some((field) => {
    const value = toolInput[field];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/**
 * Extract text from message content (string or content blocks array).
 *
 * For user messages: extracts from plain strings (channel XML wrappers
 * are stripped separately by stripChannelEnvelope).
 *
 * For assistant messages: extracts from:
 *   - `{type: "text"}` blocks — terminal output/narration
 *   - `{type: "tool_use"}` blocks detected as channel messages — the agent's
 *     actual responses to the user. Detection is structural (MCP tool with
 *     text-like input field), not name-based, for channel-agnosticism.
 *
 * Excludes:
 *   - `{type: "thinking"}` — internal reasoning
 *   - `{type: "tool_use"}` for operational tools — Bash, Read, Write, recall, etc.
 *   - `{type: "tool_result"}` — operational results, not conversation
 */
export function extractTextContent(content: unknown, role = ''): string {
  if (typeof content === 'string') {
    return content;
  }
  if (isList(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      const blockType = asString(block.type);

      // Text blocks: terminal output / narration
      if (blockType === 'text') {
        const text = asString(block.text).trim();
        if (text) {
          texts.push(text);
        }
      } else if (blockType === 'tool_use' && role === 'assistant') {
        // Tool use blocks: extract channel messages
        if (isChannelMessageTool(block)) {
          const toolInput = block.input;
          const input = isRecord(toolInput) ? toolInput : {};
          for (const field of MESSAGE_TEXT_FIELDS) {
            const value = input[field];
            if (typeof value === 'string' && value.trim()) {
              texts.push(value.trim());
              break;
            }
          }
        }
      }
    }
    return texts.join('\n');
  }
  return '';
}

/** Python's `isinstance(value, dict)` — a plain JSON object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Python's `isinstance(value, list)`. */
function isList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Read a JSON field as a string; anything that is not a string becomes "". */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The last `__`-separated segment of an MCP tool name (`name.split("__")[-1]`). */
function toolSuffix(name: string): string {
  return name.split('__').at(-1) ?? '';
}
