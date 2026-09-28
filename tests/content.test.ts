/**
 * Tests for `src/lib/content.ts` — pure content-processing functions.
 *
 * Ported 1:1 from the pytest suite (`tests/test_content.py`). Every case from
 * the Python file has a counterpart here, with the same assertions; JSON
 * transcript output is compared by parsing it back into structures.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  composeRecallQuery,
  extractTextContent,
  formatCurrentTime,
  formatMemories,
  isChannelMessageTool,
  prepareRetentionTranscript,
  sliceLastTurnsByUserBoundary,
  stripChannelEnvelope,
  stripMemoryTags,
  truncateRecallQuery,
} from '../src/lib/content';
import { createEnvSandbox } from './helpers';

let sandbox: ReturnType<typeof createEnvSandbox>;

// The functions under test are pure, but the sandbox keeps them from ever
// reading (or writing) the developer's real HOME / plugin configuration.
beforeEach(() => {
  sandbox = createEnvSandbox();
});

afterEach(() => {
  sandbox.restore();
});

/** Build a message list from (role, content) pairs (Python `_msgs`). */
function msgs(...pairs: Array<[string, unknown]>): Array<Record<string, unknown>> {
  return pairs.map(([role, content]) => ({ role, content }));
}

// ---------------------------------------------------------------------------
// stripChannelEnvelope
// ---------------------------------------------------------------------------

describe('stripChannelEnvelope', () => {
  it('strips the channel XML wrapper', () => {
    const raw = '<channel source="plugin:telegram:telegram" chat_id="123">Hello world</channel>';
    expect(stripChannelEnvelope(raw)).toBe('Hello world');
  });

  it('passes plain text through untouched', () => {
    expect(stripChannelEnvelope('just plain text')).toBe('just plain text');
  });

  it('strips a multiline channel wrapper', () => {
    const raw = "<channel source='s'>\nline1\nline2\n</channel>";
    expect(stripChannelEnvelope(raw)).toBe('line1\nline2');
  });

  it('passes content through when there is no channel tag', () => {
    const raw = '<other>stuff</other>';
    expect(stripChannelEnvelope(raw)).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// stripMemoryTags
// ---------------------------------------------------------------------------

describe('stripMemoryTags', () => {
  it('strips a hindsight_memories block', () => {
    const raw = 'before\n<hindsight_memories>secret</hindsight_memories>\nafter';
    expect(stripMemoryTags(raw)).not.toContain('hindsight_memories');
    expect(stripMemoryTags(raw)).toContain('before');
    expect(stripMemoryTags(raw)).toContain('after');
  });

  it('strips a relevant_memories block', () => {
    const raw = 'text <relevant_memories>old stuff</relevant_memories> text';
    const result = stripMemoryTags(raw);
    expect(result).not.toContain('relevant_memories');
    expect(result).not.toContain('old stuff');
  });

  it('passes clean text through', () => {
    const raw = 'no memory tags here';
    expect(stripMemoryTags(raw)).toBe(raw);
  });

  it('strips a multiline block', () => {
    const raw = '<hindsight_memories>\n- mem1\n- mem2\n</hindsight_memories>';
    expect(stripMemoryTags(raw).trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// sliceLastTurnsByUserBoundary
// ---------------------------------------------------------------------------

describe('sliceLastTurnsByUserBoundary', () => {
  it('returns all messages when there are fewer turns than requested', () => {
    const messages = msgs(['user', 'hi'], ['assistant', 'hello']);
    expect(sliceLastTurnsByUserBoundary(messages, 5)).toEqual(messages);
  });

  it('slices to the last one turn', () => {
    const messages = msgs(
      ['user', 'first'],
      ['assistant', 'a1'],
      ['user', 'second'],
      ['assistant', 'a2'],
    );
    const result = sliceLastTurnsByUserBoundary(messages, 1);
    expect(result[0]?.content).toBe('second');
    expect(result).toHaveLength(2);
  });

  it('slices to the last two turns', () => {
    const messages = msgs(
      ['user', 'u1'],
      ['assistant', 'a1'],
      ['user', 'u2'],
      ['assistant', 'a2'],
      ['user', 'u3'],
      ['assistant', 'a3'],
    );
    const result = sliceLastTurnsByUserBoundary(messages, 2);
    expect(result[0]?.content).toBe('u2');
    expect(result).toHaveLength(4);
  });

  it('returns empty for an empty list', () => {
    expect(sliceLastTurnsByUserBoundary([], 3)).toEqual([]);
  });

  it('returns empty for zero turns', () => {
    const messages = msgs(['user', 'hi']);
    expect(sliceLastTurnsByUserBoundary(messages, 0)).toEqual([]);
  });

  it('returns empty for a non-list input', () => {
    expect(sliceLastTurnsByUserBoundary(null, 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// composeRecallQuery
// ---------------------------------------------------------------------------

describe('composeRecallQuery', () => {
  it('returns the latest query only for a single turn', () => {
    const messages = msgs(['user', 'previous'], ['assistant', 'reply']);
    const result = composeRecallQuery('new query', messages, 1);
    expect(result).toBe('new query');
  });

  it('includes prior context for multiple turns', () => {
    const messages = msgs(['user', 'prior question'], ['assistant', 'prior answer']);
    const result = composeRecallQuery('current question', messages, 2);
    expect(result).toContain('Prior context:');
    expect(result).toContain('prior question');
    expect(result).toContain('current question');
  });

  it('skips a context message duplicating the latest query', () => {
    const messages = msgs(['user', 'same question'], ['assistant', 'answer']);
    const result = composeRecallQuery('same question', messages, 2);
    // duplicate user msg should be dropped from context
    const occurrences = result.split('same question').length - 1;
    expect(occurrences).toBe(1);
  });

  it('returns the latest query for empty messages', () => {
    const result = composeRecallQuery('query', [], 3);
    expect(result).toBe('query');
  });

  it('strips memory tags from the context', () => {
    const messages = msgs([
      'user',
      '<hindsight_memories>secret</hindsight_memories> actual question',
    ]);
    const result = composeRecallQuery('now', messages, 2);
    expect(result).not.toContain('hindsight_memories');
    expect(result).not.toContain('secret');
  });

  it('filters context by recall roles', () => {
    const messages = msgs(['user', 'user msg'], ['assistant', 'assistant msg']);
    const result = composeRecallQuery('query', messages, 2, ['user']);
    expect(result).toContain('user msg');
    expect(result).not.toContain('assistant msg');
  });
});

// ---------------------------------------------------------------------------
// truncateRecallQuery
// ---------------------------------------------------------------------------

describe('truncateRecallQuery', () => {
  it('leaves a short query unchanged', () => {
    const query = 'short';
    expect(truncateRecallQuery(query, query, 100)).toBe(query);
  });

  it('truncates a plain query to maxChars', () => {
    const query = 'x'.repeat(50);
    const result = truncateRecallQuery(query, query, 20);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('preserves the latest query when context is dropped', () => {
    const latest = 'final question';
    const query = `Prior context:\n\nuser: old stuff\nassistant: old reply\n\n${latest}`;
    const result = truncateRecallQuery(query, latest, 30);
    expect(result).toContain(latest);
  });

  it('drops the oldest context lines first', () => {
    const latest = 'latest';
    const query = `Prior context:\n\nuser: oldest\nassistant: old\nuser: newer\n\n${latest}`;
    // Allow only the newest context line + latest
    const maxChars = `Prior context:\n\nnewer\n\n${latest}`.length + 5;
    const result = truncateRecallQuery(query, latest, maxChars);
    if (result.includes('Prior context:')) {
      expect(result).not.toContain('oldest');
    }
  });

  it('returns the query unchanged when maxChars is zero', () => {
    const query = 'anything';
    expect(truncateRecallQuery(query, query, 0)).toBe(query);
  });
});

// ---------------------------------------------------------------------------
// formatMemories
// ---------------------------------------------------------------------------

describe('formatMemories', () => {
  it('formats a single memory', () => {
    const memories = [{ text: 'Paris is the capital', type: 'world', mentioned_at: '2024-01-01' }];
    const result = formatMemories(memories);
    expect(result).toContain('Paris is the capital');
    expect(result).toContain('[world]');
    expect(result).toContain('(2024-01-01)');
  });

  it('formats multiple memories with a separator', () => {
    const memories = [
      { text: 'mem1', type: 'experience', mentioned_at: '2024-01-01' },
      { text: 'mem2', type: 'world', mentioned_at: '2024-02-01' },
    ];
    const result = formatMemories(memories);
    expect(result).toContain('mem1');
    expect(result).toContain('mem2');
  });

  it('returns an empty string for an empty list', () => {
    expect(formatMemories([])).toBe('');
  });

  it('handles missing optional fields gracefully', () => {
    const memories = [{ text: 'bare memory' }];
    const result = formatMemories(memories);
    expect(result).toContain('bare memory');
  });
});

// ---------------------------------------------------------------------------
// isChannelMessageTool
// ---------------------------------------------------------------------------

describe('isChannelMessageTool', () => {
  it('recognizes a telegram send message tool', () => {
    const block = {
      type: 'tool_use',
      name: 'mcp__telegram__sendMessage',
      input: { text: 'hello' },
    };
    expect(isChannelMessageTool(block)).toBe(true);
  });

  it('recognizes a slack reply tool', () => {
    const block = { type: 'tool_use', name: 'mcp__slack__reply', input: { body: 'hi there' } };
    expect(isChannelMessageTool(block)).toBe(true);
  });

  it('excludes an operational recall tool', () => {
    const block = { type: 'tool_use', name: 'mcp__hindsight__recall', input: { query: 'test' } };
    expect(isChannelMessageTool(block)).toBe(false);
  });

  it('excludes a built-in bash tool', () => {
    const block = { type: 'tool_use', name: 'Bash', input: { command: 'ls' } };
    expect(isChannelMessageTool(block)).toBe(false);
  });

  it('excludes an MCP tool without a text field', () => {
    const block = { type: 'tool_use', name: 'mcp__something__action', input: { id: 123 } };
    expect(isChannelMessageTool(block)).toBe(false);
  });

  it('excludes an MCP tool with empty text', () => {
    const block = { type: 'tool_use', name: 'mcp__telegram__send', input: { text: '   ' } };
    expect(isChannelMessageTool(block)).toBe(false);
  });

  it('excludes an MCP create action', () => {
    const block = {
      type: 'tool_use',
      name: 'mcp__notion__create_page',
      input: { content: 'hello' },
    };
    expect(isChannelMessageTool(block)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractTextContent
// ---------------------------------------------------------------------------

describe('extractTextContent', () => {
  it('returns a plain string as is', () => {
    expect(extractTextContent('hello', 'user')).toBe('hello');
  });

  it('extracts a text block', () => {
    const content = [{ type: 'text', text: 'response text' }];
    expect(extractTextContent(content, 'assistant')).toBe('response text');
  });

  it('excludes thinking blocks', () => {
    const content = [
      { type: 'thinking', thinking: 'private' },
      { type: 'text', text: 'public' },
    ];
    const result = extractTextContent(content, 'assistant');
    expect(result).not.toContain('private');
    expect(result).toContain('public');
  });

  it('extracts a channel tool_use for assistant messages', () => {
    const content = [
      { type: 'tool_use', name: 'mcp__telegram__send', input: { text: 'hello user' } },
    ];
    const result = extractTextContent(content, 'assistant');
    expect(result).toContain('hello user');
  });

  it('does not extract a tool_use for user messages', () => {
    const content = [
      { type: 'tool_use', name: 'mcp__telegram__send', input: { text: 'hello user' } },
    ];
    const result = extractTextContent(content, 'user');
    expect(result).not.toContain('hello user');
  });

  it('returns an empty string for an empty list', () => {
    expect(extractTextContent([], 'assistant')).toBe('');
  });

  it('returns an empty string for non-string, non-list content', () => {
    expect(extractTextContent(null, 'user')).toBe('');
    expect(extractTextContent(42, 'user')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// prepareRetentionTranscript
// ---------------------------------------------------------------------------

/** A content block of a JSON retention transcript message. */
interface TranscriptBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  tool_use_id?: string;
}

/** A message of a JSON retention transcript. */
interface TranscriptMessage {
  role: string;
  content: TranscriptBlock[];
}

/** Parse a JSON transcript, failing loudly when there is nothing to parse. */
function parseTranscript(raw: string | null): TranscriptMessage[] {
  if (raw === null) {
    throw new Error('expected a transcript, got null');
  }
  return JSON.parse(raw) as TranscriptMessage[];
}

/** The first block of the given type (`next(b for b in ... if ...)`). */
function blockOfType(message: TranscriptMessage | undefined, type: string): TranscriptBlock {
  const block = message?.content.find((candidate) => candidate.type === type);
  if (!block) {
    throw new Error(`expected a ${type} block`);
  }
  return block;
}

/** The first message holding a block of the given type. */
function messageWithBlock(
  transcript: TranscriptMessage[],
  type: string,
): TranscriptMessage | undefined {
  return transcript.find((message) => message.content.some((block) => block.type === type));
}

describe('prepareRetentionTranscript', () => {
  it('formats the last turn by default', () => {
    const messages = msgs(
      ['user', 'old'],
      ['assistant', 'old reply'],
      ['user', 'new'],
      ['assistant', 'new reply'],
    );
    const [transcript, count] = prepareRetentionTranscript(messages, null, false);
    expect(transcript).toContain('new');
    expect(transcript).toContain('new reply');
    expect(count).toBe(2);
  });

  it('retains every message in full-window mode', () => {
    const messages = msgs(
      ['user', 'msg1'],
      ['assistant', 'reply1'],
      ['user', 'msg2'],
      ['assistant', 'reply2'],
    );
    const [transcript, count] = prepareRetentionTranscript(messages, null, true);
    expect(transcript).toContain('msg1');
    expect(transcript).toContain('msg2');
    expect(count).toBe(4);
  });

  it('strips memory tags', () => {
    const messages = msgs([
      'user',
      '<hindsight_memories>leaked</hindsight_memories> actual question',
    ]);
    const [transcript] = prepareRetentionTranscript(messages, null, true);
    expect(transcript).not.toContain('leaked');
    expect(transcript).toContain('actual question');
  });

  it('filters by retain roles', () => {
    const messages = msgs(['user', 'user msg'], ['assistant', 'assistant msg']);
    const [transcript] = prepareRetentionTranscript(messages, ['user'], true);
    expect(transcript).toContain('user msg');
    expect(transcript).not.toContain('assistant msg');
  });

  it('returns null and zero for empty messages', () => {
    const [transcript, count] = prepareRetentionTranscript([]);
    expect(transcript).toBeNull();
    expect(count).toBe(0);
  });

  it('includes role markers in the text format', () => {
    const messages = msgs(['user', 'hello']);
    const [transcript] = prepareRetentionTranscript(messages, null, true);
    expect(transcript).toContain('[role: user]');
    expect(transcript).toContain('[user:end]');
  });

  it('returns null when there is no user message', () => {
    const messages = [{ role: 'assistant', content: 'only assistant' }];
    const [transcript] = prepareRetentionTranscript(messages, null, false);
    expect(transcript).toBeNull();
  });

  it('formats tool calls as JSON when includeToolCalls is set', () => {
    const messages = [
      { role: 'user', content: 'edit the file' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll edit that file." },
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: '/tmp/foo.py', old_string: 'old', new_string: 'new' },
          },
        ],
      },
    ];
    const [transcript, count] = prepareRetentionTranscript(messages, null, true, true);
    expect(transcript).not.toBeNull();
    const data = parseTranscript(transcript);
    expect(data).toHaveLength(2);
    expect(data[0]?.role).toBe('user');
    expect(data[1]?.role).toBe('assistant');
    // Should have both text and tool_use blocks
    const blockTypes = data[1]?.content.map((block) => block.type) ?? [];
    expect(blockTypes).toContain('text');
    expect(blockTypes).toContain('tool_use');
    // Tool input should be preserved
    const toolBlock = blockOfType(data[1], 'tool_use');
    expect(toolBlock.name).toBe('Edit');
    expect(toolBlock.input?.file_path).toBe('/tmp/foo.py');
    expect(count).toBe(2);
  });

  it('excludes hindsight MCP tools in JSON mode', () => {
    const messages = [
      { role: 'user', content: 'recall something' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', name: 'mcp__hindsight__recall', input: { query: 'test' } },
        ],
      },
    ];
    const [transcript] = prepareRetentionTranscript(messages, null, true, true);
    const data = parseTranscript(transcript);
    const assistantBlocks = data[1]?.content ?? [];
    expect(assistantBlocks).toHaveLength(1);
    expect(assistantBlocks[0]?.type).toBe('text');
  });

  it('includes tool results in JSON mode', () => {
    const messages = [
      { role: 'user', content: 'run ls' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running ls.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_result', tool_use_id: '123', content: 'file1.py\nfile2.py' },
          { type: 'text', text: 'Here are the files.' },
        ],
      },
    ];
    const [transcript] = prepareRetentionTranscript(messages, null, true, true);
    const data = parseTranscript(transcript);
    const resultBlock = blockOfType(messageWithBlock(data, 'tool_result'), 'tool_result');
    expect(resultBlock.content).toContain('file1.py');
  });

  it('handles list-content tool results in JSON mode', () => {
    const messages = [
      { role: 'user', content: 'analyze the code' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Agent', input: { prompt: 'check code' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_abc',
            content: [
              { type: 'text', text: 'Found 3 issues in the codebase.' },
              { type: 'text', text: '1. Missing error handling in auth module' },
            ],
          },
        ],
      },
    ];
    const [transcript] = prepareRetentionTranscript(messages, null, true, true);
    const data = parseTranscript(transcript);
    const resultBlock = blockOfType(messageWithBlock(data, 'tool_result'), 'tool_result');
    expect(resultBlock.content).toContain('Found 3 issues');
    expect(resultBlock.content).toContain('Missing error handling');
  });

  it('uses the text format when includeToolCalls is false', () => {
    const messages = msgs(['user', 'hello'], ['assistant', 'world']);
    const [transcript] = prepareRetentionTranscript(messages, null, true, false);
    expect(transcript).toContain('[role: user]');
    expect(transcript).toContain('[user:end]');
  });
});

// ---------------------------------------------------------------------------
// formatCurrentTime
// ---------------------------------------------------------------------------

describe('formatCurrentTime', () => {
  it('includes the UTC suffix', () => {
    // The "UTC" suffix prevents client LLMs from misreading the
    // timestamp as local time.
    expect(formatCurrentTime().endsWith(' UTC')).toBe(true);
  });

  it('matches the expected format shape', () => {
    expect(formatCurrentTime()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  });
});
