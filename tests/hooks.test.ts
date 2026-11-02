/**
 * End-to-end tests for the recall and retain hooks — port of `tests/test_hooks.py`.
 *
 * The Claude Code hook runtime is faked by `runHook`, which mirrors the Python
 * `_run_hook` helper:
 *   - `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` / `HOME` → per-test sandbox dirs
 *   - settings.json            → the Python defaults plus `extra_settings`
 *   - `process.stdin`          → a Readable carrying the hook JSON input
 *   - `process.stdout`         → captured (returned as a string, like `stdout_capture.getvalue()`)
 *   - `globalThis.fetch`       → stub for `urllib.request.urlopen`
 *   - `process.exit`           → throws instead of tearing the test runner down
 *
 * Every `it(...)` mirrors one `test_hooks.py` case, one for one.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main as recallMain } from '../src/hooks/recall';
import { main as retainMain } from '../src/hooks/retain';
import { main as sessionEndMain } from '../src/hooks/session-end';
import { readState } from '../src/lib/state';
import {
  createEnvSandbox,
  type EnvSandbox,
  makeHookInput,
  makeMemory,
  makeRecallResponse,
  writePeriDatabase,
  writeTranscriptFile,
} from './helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HookName = 'recall' | 'retain' | 'session-end';

/** Stands in for `urlopen_side_effect`: URL plus request init in, response out. */
type FetchStub = (url: string, init: RequestInit) => Response | Promise<Response>;

interface RunHookOptions {
  /** Replaces `urllib.request.urlopen`'s side_effect. Defaults to `{"results": []}`. */
  fetchStub?: FetchStub;
  /** Extra environment variables (`monkeypatch.setenv` inside the tests). */
  extraEnv?: Record<string, string>;
  /** Overrides merged into the default settings.json. */
  extraSettings?: Record<string, unknown>;
}

const HOOK_MAINS: Record<HookName, () => Promise<void>> = {
  recall: recallMain,
  retain: retainMain,
  'session-end': sessionEndMain,
};

interface RecallHookOutput {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

interface RecallBody {
  query: string;
  max_tokens: number;
  budget?: string;
  tags?: string[];
  tags_match?: string;
  tag_groups?: unknown;
}

interface RetainItem {
  content: string;
  document_id: string;
  metadata: Record<string, string>;
  context?: string;
  tags?: string[];
}

interface RetainBody {
  items: RetainItem[];
  async?: boolean;
}

/** Build a fake HTTP response (`conftest.FakeHTTPResponse`). */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

/** The decoded request body a hook posted (`json.loads(req.data.decode())`). */
function requestBody<T>(init: RequestInit): T {
  return JSON.parse(init.body as string) as T;
}

/** True for the retain endpoint — `/memories`, but not `/memories/recall`. */
function isRetainEndpoint(url: string): boolean {
  return url.includes('/memories') && !url.includes('/recall');
}

/**
 * Import and run a hook's `main()` with mocked stdin/stdout/HTTP.
 *
 * Unlike Python (which re-executes the module so it picks up the patched env),
 * the hooks read configuration inside `main()`, so a plain import suffices.
 */
async function runHook(
  hookName: HookName,
  hookInput: Record<string, unknown>,
  sandbox: EnvSandbox,
  options: RunHookOptions = {},
): Promise<string> {
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    sandbox.setEnv(key, value);
  }
  sandbox.writePluginSettings({
    autoRecall: true,
    autoRetain: true,
    retainEveryNTurns: 1,
    hindsightApiUrl: 'http://fake:9077',
    ...options.extraSettings,
  });

  const stdout: string[] = [];
  const fetchStub = options.fetchStub ?? (() => jsonResponse(makeRecallResponse([])));

  const stdinSpy = vi
    .spyOn(process, 'stdin', 'get')
    .mockReturnValue(Readable.from([JSON.stringify(hookInput)]) as typeof process.stdin);
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as never);
  // Without this, a hook that calls process.exit(0) would kill the test runner.
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(fetchStub(url, init ?? {}));
  });

  try {
    await HOOK_MAINS[hookName]();
  } finally {
    stdinSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    fetchSpy.mockRestore();
  }

  return stdout.join('');
}

/** `capture_and_respond` for recall calls: records bodies/URLs, replies `{"results": []}`. */
function captureRecallRequests(): { bodies: RecallBody[]; urls: string[]; stub: FetchStub } {
  const bodies: RecallBody[] = [];
  const urls: string[] = [];
  const stub: FetchStub = (url, init) => {
    if (url.includes('/recall')) {
      urls.push(url);
      bodies.push(requestBody<RecallBody>(init));
    }
    return jsonResponse(makeRecallResponse([]));
  };
  return { bodies, urls, stub };
}

/** `capture` for retain calls: records bodies/URLs, replies `{}`. */
function captureRetainRequests(): { bodies: RetainBody[]; urls: string[]; stub: FetchStub } {
  const bodies: RetainBody[] = [];
  const urls: string[] = [];
  const stub: FetchStub = (url, init) => {
    if (isRetainEndpoint(url)) {
      urls.push(url);
      bodies.push(requestBody<RetainBody>(init));
    }
    return jsonResponse({});
  };
  return { bodies, urls, stub };
}

let sandbox: EnvSandbox;

beforeEach(() => {
  sandbox = createEnvSandbox();
});

afterEach(() => {
  sandbox.restore();
});

// ---------------------------------------------------------------------------
// recall hook
// ---------------------------------------------------------------------------

describe('RecallHook', () => {
  it('outputs additional context when memories are found', async () => {
    const memory = makeMemory('Paris is the capital of France', 'world');

    const hookInput = makeHookInput({ prompt: 'What is the capital of France?' });
    const output = await runHook('recall', hookInput, sandbox, {
      fetchStub: () => jsonResponse(makeRecallResponse([memory])),
    });

    const data = JSON.parse(output) as RecallHookOutput;
    const context = data.hookSpecificOutput.additionalContext;
    expect(context).toContain('Paris is the capital of France');
    expect(context).toContain('<hindsight_memories>');
  });

  it('recall min scores filters low scoring memories', async () => {
    const lowSemantic = makeMemory('Marginal match');
    lowSemantic.scores = { semantic: 0.42, reranker: 0.8 };
    const lowReranker = makeMemory('Junk reranker match');
    lowReranker.scores = { semantic: 0.9, reranker: 0.03 };
    const noScores = makeMemory('BM25-only match');
    const good = makeMemory('Relevant match');
    good.scores = { semantic: 0.91, reranker: 0.45 };

    const hookInput = makeHookInput({ prompt: 'What deployment rule applies?' });
    const output = await runHook('recall', hookInput, sandbox, {
      fetchStub: () => jsonResponse(makeRecallResponse([lowSemantic, lowReranker, noScores, good])),
      extraSettings: { recallMinScores: { semantic: 0.65, reranker: 0.2 } },
    });

    const context = (JSON.parse(output) as RecallHookOutput).hookSpecificOutput.additionalContext;
    expect(context).not.toContain('Marginal match');
    expect(context).not.toContain('Junk reranker match');
    expect(context).toContain('BM25-only match');
    expect(context).toContain('Relevant match');
  });

  it('recall min scores ignores invalid floor', async () => {
    const memory = makeMemory('Relevant match');
    memory.scores = { semantic: 0.91 };

    const hookInput = makeHookInput({ prompt: 'What deployment rule applies?' });
    const output = await runHook('recall', hookInput, sandbox, {
      fetchStub: () => jsonResponse(makeRecallResponse([memory])),
      extraSettings: { recallMinScores: { semantic: null } },
    });

    const context = (JSON.parse(output) as RecallHookOutput).hookSpecificOutput.additionalContext;
    expect(context).toContain('Relevant match');
  });

  it('no output when no memories', async () => {
    const hookInput = makeHookInput({ prompt: 'hello there world' });
    const output = await runHook('recall', hookInput, sandbox);
    // Empty stdout = no memories injected
    expect(output.trim()).toBe('');
  });

  it('no output for short prompt', async () => {
    const captured = captureRecallRequests();

    const hookInput = makeHookInput({ prompt: 'hi' });
    const output = await runHook('recall', hookInput, sandbox, { fetchStub: captured.stub });

    expect(output.trim()).toBe('');
    // The prompt is dropped before any HTTP call — an empty-stub assertion alone
    // would also pass if the hook had queried the API and simply found nothing.
    expect(captured.urls).toHaveLength(0);
  });

  it('graceful on api error', async () => {
    const failingStub: FetchStub = () => {
      throw new Error('connection refused');
    };

    const hookInput = makeHookInput({ prompt: 'What is my project about?' });
    // Should not raise — graceful degradation
    const output = await runHook('recall', hookInput, sandbox, { fetchStub: failingStub });
    expect(output.trim()).toBe('');
  });

  it('output format matches claude code spec', async () => {
    const memory = makeMemory('User prefers Python');

    const hookInput = makeHookInput({ prompt: 'What language should I use?' });
    const output = await runHook('recall', hookInput, sandbox, {
      fetchStub: () => jsonResponse(makeRecallResponse([memory])),
    });

    const data = JSON.parse(output) as RecallHookOutput;
    expect(data.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(data.hookSpecificOutput).toHaveProperty('additionalContext');
  });

  it('multi turn context from transcript', async () => {
    // When recallContextTurns > 1, prior transcript is included in query.
    const messages = [
      { role: 'user', content: 'I use Python for all my scripts' },
      { role: 'assistant', content: 'Noted!' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);

    const captured = captureRecallRequests();

    const hookInput = makeHookInput({
      prompt: 'What language should I use?',
      transcript_path: transcript,
    });
    await runHook('recall', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraSettings: { recallContextTurns: 2 },
    });

    // The query should contain prior context from the transcript
    expect(captured.bodies).toHaveLength(1);
    expect(captured.bodies[0]?.query).toContain('Python');
  });

  it('passes tag filters to recall api', async () => {
    const captured = captureRecallRequests();

    const hookInput = makeHookInput({ prompt: 'What project rules apply here?' });
    await runHook('recall', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraSettings: {
        recallTags: ['memory_type:rule'],
        recallTagsMatch: 'any_strict',
        recallTagGroups: [{ op: 'all', tags: ['memory_type:rule', 'tech_stack:supabase'] }],
      },
    });

    expect(captured.bodies).toHaveLength(1);
    const body = captured.bodies[0];
    expect(body?.tags).toEqual(['memory_type:rule']);
    expect(body?.tags_match).toBe('any_strict');
    expect(body?.tag_groups).toEqual([
      { op: 'all', tags: ['memory_type:rule', 'tech_stack:supabase'] },
    ]);
  });

  it('additional bank filters override global tags', async () => {
    const captured = captureRecallRequests();

    const hookInput = makeHookInput({ prompt: 'What project rules apply here?' });
    await runHook('recall', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraSettings: {
        bankId: 'project-bank',
        recallAdditionalBanks: ['normative-bank'],
        recallTags: ['tech_stack:supabase'],
        recallTagsMatch: 'any',
        recallAdditionalBankFilters: {
          'normative-bank': {
            recallTags: ['memory_type:rule'],
            recallTagsMatch: 'all_strict',
          },
        },
      },
    });

    expect(captured.bodies[0]?.tags).toEqual(['tech_stack:supabase']);
    expect(captured.bodies[0]?.tags_match).toBe('any');
    expect(captured.bodies[1]?.tags).toEqual(['memory_type:rule']);
    expect(captured.bodies[1]?.tags_match).toBe('all_strict');
  });

  it('additional banks skip primary and duplicates', async () => {
    // The primary bank (and repeated entries) must not be re-recalled.
    const captured = captureRecallRequests();

    const hookInput = makeHookInput({ prompt: 'anything' });
    await runHook('recall', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraSettings: {
        bankId: 'shared-bank',
        // primary listed for bidirectional visibility, plus a dup + a real extra
        recallAdditionalBanks: ['shared-bank', 'other-bank', 'other-bank'],
      },
    });

    // shared-bank recalled once (primary), other-bank once — 2 calls, not 4.
    expect(captured.urls.filter((url) => url.includes('shared-bank'))).toHaveLength(1);
    expect(captured.urls.filter((url) => url.includes('other-bank'))).toHaveLength(1);
    expect(captured.urls).toHaveLength(2);
  });

  it('disabled auto recall produces no output', async () => {
    const captured = captureRecallRequests();

    const hookInput = makeHookInput({ prompt: 'What is the capital of France?' });
    const output = await runHook('recall', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraSettings: { autoRecall: false, autoRetain: false },
    });

    expect(output.trim()).toBe('');
    // The hook bails out before reading stdin or calling the API.
    expect(captured.urls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// retain hook
// ---------------------------------------------------------------------------

describe('RetainHook', () => {
  it('posts transcript to hindsight', async () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);

    const captured = captureRetainRequests();

    const hookInput = makeHookInput({ transcript_path: transcript });
    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub });

    expect(captured.bodies, 'retain API was not called').toHaveLength(1);
    expect(captured.bodies[0]?.items[0]?.content).toContain('hello');
  });

  it('no retain on empty transcript', async () => {
    const hookInput = makeHookInput({ transcript_path: '/nonexistent/transcript.jsonl' });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub });
    expect(captured.bodies).toHaveLength(0);
  });

  it('strips memory tags before retaining', async () => {
    const messages = [
      {
        role: 'user',
        content: '<hindsight_memories>old memories</hindsight_memories> actual question',
      },
      { role: 'assistant', content: 'sure!' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const captured = captureRetainRequests();

    const hookInput = makeHookInput({ transcript_path: transcript });
    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub });

    expect(captured.bodies, 'retain API was not called').toHaveLength(1);
    const content = captured.bodies[0]?.items[0]?.content ?? '';
    expect(content).not.toContain('old memories');
    expect(content).toContain('actual question');
  });

  it('retain tags with template variables', async () => {
    // retainTags config should resolve template variables like {session_id}.
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript, session_id: 'sess-tag-test' });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraSettings: { retainTags: ['{session_id}', 'claude-code', 'custom-tag'] },
    });

    expect(captured.bodies, 'retain API was not called').toHaveLength(1);
    expect(captured.bodies[0]?.items[0]?.tags).toEqual([
      'sess-tag-test',
      'claude-code',
      'custom-tag',
    ]);
  });

  it('retain tag resolves user id when env set', async () => {
    // retainTags with {user_id} resolves from HINDSIGHT_USER_ID env var.
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript, session_id: 'sess-user-test' });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { HINDSIGHT_USER_ID: 'alice' },
      extraSettings: { retainTags: ['user:{user_id}', 'session:{session_id}'] },
    });

    expect(captured.bodies, 'retain API was not called').toHaveLength(1);
    expect(captured.bodies[0]?.items[0]?.tags).toEqual(['user:alice', 'session:sess-user-test']);
  });

  it('retain tag dropped when user id env unset', async () => {
    // user:{user_id} resolves to 'user:' and is dropped when env is unset; other tags survive.
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript, session_id: 'sess-drop-test' });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraSettings: { retainTags: ['user:{user_id}', 'session:{session_id}'] },
    });

    expect(captured.bodies, 'retain API was not called').toHaveLength(1);
    const tags = captured.bodies[0]?.items[0]?.tags ?? [];
    expect(tags).toEqual(['session:sess-drop-test']);
    expect(tags.filter((tag) => tag.startsWith('user:'))).toHaveLength(0);
  });

  it('retain tag without colon preserved', async () => {
    // Tags without ':' are never dropped, regardless of env state.
    // The sandbox strips all HINDSIGHT_* env vars, so unset state is the default.
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript, session_id: 'sess-plain' });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraSettings: { retainTags: ['plain-tag', 'another'] },
    });

    expect(captured.bodies, 'retain API was not called').toHaveLength(1);
    expect(captured.bodies[0]?.items[0]?.tags).toEqual(['plain-tag', 'another']);
  });

  it('retain tag all dropped yields no tags field', async () => {
    // If all tags resolve to dangling, the outgoing request omits the tags field.
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript, session_id: 'sess-none' });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraSettings: { retainTags: ['user:{user_id}'] },
    });

    expect(captured.bodies, 'retain API was not called').toHaveLength(1);
    // HindsightClient.retain only sets item["tags"] if tags is truthy (client.ts).
    // With all tags dropped, retain.ts passes tags=null, so "tags" is absent from item.
    expect(captured.bodies[0]?.items[0]).not.toHaveProperty('tags');
  });

  it('retain custom metadata', async () => {
    // retainMetadata config should be merged with built-in metadata.
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript, session_id: 'sess-meta-test' });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraSettings: { retainMetadata: { project: 'my-project', session: '{session_id}' } },
    });

    expect(captured.bodies, 'retain API was not called').toHaveLength(1);
    const meta = captured.bodies[0]?.items[0]?.metadata ?? {};
    // Built-in metadata
    expect(meta.session_id).toBe('sess-meta-test');
    expect(meta).toHaveProperty('retained_at');
    // Custom metadata with template resolution
    expect(meta.project).toBe('my-project');
    expect(meta.session).toBe('sess-meta-test');
  });

  it('full session uses session id as document id', async () => {
    // In full-session mode, document_id should be the session_id (for upsert).
    const messages = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript, session_id: 'sess-full-123' });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub });

    expect(captured.bodies, 'retain API was not called').toHaveLength(1);
    const item = captured.bodies[0]?.items[0];
    // document_id should be just the session_id, no timestamp suffix
    expect(item?.document_id).toBe('sess-full-123');
    // Should contain ALL messages, not just the last turn
    expect(item?.content).toContain('first question');
    expect(item?.content).toContain('second question');
  });

  it('full session new document after compaction', async () => {
    // After compaction shrinks the transcript, retain should use a new document_id
    // to avoid overwriting the pre-compaction document.
    // First retain: 4 messages
    const messagesFull = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ];
    let transcript = writeTranscriptFile(sandbox.root, messagesFull);
    let hookInput = makeHookInput({
      transcript_path: transcript,
      session_id: 'sess-compact-test',
    });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub });

    expect(captured.bodies).toHaveLength(1);
    expect(captured.bodies[0]?.items[0]?.document_id).toBe('sess-compact-test');
    expect(captured.bodies[0]?.items[0]?.content).toContain('first question');

    // Second retain: compaction happened — transcript now has only 2 messages
    const messagesCompacted = [
      { role: 'user', content: 'third question' },
      { role: 'assistant', content: 'third answer' },
    ];
    transcript = writeTranscriptFile(sandbox.root, messagesCompacted);
    hookInput = makeHookInput({ transcript_path: transcript, session_id: 'sess-compact-test' });

    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub });

    expect(captured.bodies).toHaveLength(2);
    // Should use a new document_id with chunk suffix
    expect(captured.bodies[1]?.items[0]?.document_id).toBe('sess-compact-test-c1');
    expect(captured.bodies[1]?.items[0]?.content).toContain('third question');
  });

  it('full session uses delta document when growing', async () => {
    // When transcript grows, retain should send only new messages in a new document chunk.
    const messages2 = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    let transcript = writeTranscriptFile(sandbox.root, messages2);
    let hookInput = makeHookInput({ transcript_path: transcript, session_id: 'sess-grow-test' });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub });

    // Second retain: transcript grew to 4 messages
    const messages4 = [
      ...messages2,
      { role: 'user', content: 'more stuff' },
      { role: 'assistant', content: 'more response' },
    ];
    transcript = writeTranscriptFile(sandbox.root, messages4);
    hookInput = makeHookInput({ transcript_path: transcript, session_id: 'sess-grow-test' });

    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub });

    expect(captured.bodies).toHaveLength(2);
    expect(captured.bodies[0]?.items[0]?.document_id).toBe('sess-grow-test');
    expect(captured.bodies[1]?.items[0]?.document_id).toBe('sess-grow-test-c1');
    expect(captured.bodies[0]?.items[0]?.content).toContain('hello');
    expect(captured.bodies[1]?.items[0]?.content).toContain('more stuff');
    expect(captured.bodies[1]?.items[0]?.content).not.toContain('hello');
  });

  it('full session skips when transcript has no new messages', async () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript, session_id: 'sess-no-new' });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub });
    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub });

    expect(captured.bodies).toHaveLength(1);
    expect(captured.bodies[0]?.items[0]?.document_id).toBe('sess-no-new');
  });

  it('full session retry keeps checkpoint on retain failure', async () => {
    const messages = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript, session_id: 'sess-retry-test' });
    const bodies: RetainBody[] = [];
    let attempts = 0;

    const failFirstThenCapture: FetchStub = (url, init) => {
      if (isRetainEndpoint(url)) {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('temporary retain failure');
        }
        bodies.push(requestBody<RetainBody>(init));
      }
      return jsonResponse({});
    };

    await runHook('retain', hookInput, sandbox, { fetchStub: failFirstThenCapture });
    await runHook('retain', hookInput, sandbox, { fetchStub: failFirstThenCapture });

    expect(attempts).toBe(2);
    expect(bodies).toHaveLength(1);
    const item = bodies[0]?.items[0];
    expect(item?.document_id).toBe('sess-retry-test');
    expect(item?.content).toContain('first question');
  });

  it('full session respects retain every n turns', async () => {
    // In full-session mode, retainEveryNTurns should still gate when retain fires.
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript, session_id: 'sess-throttle' });
    const captured = captureRetainRequests();

    // retainEveryNTurns=3 in full-session mode — first 2 calls should be skipped
    const extraSettings = { retainEveryNTurns: 3 };
    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub, extraSettings });
    // Turn 1 of 3 — should NOT retain
    expect(captured.bodies).toHaveLength(0);

    // Turn 2 — still skip
    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub, extraSettings });
    expect(captured.bodies).toHaveLength(0);

    // Turn 3 — should fire, with full session content and session_id as doc ID
    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub, extraSettings });
    expect(captured.bodies, 'retain should fire on turn 3').toHaveLength(1);
    const item = captured.bodies[0]?.items[0];
    expect(item?.document_id).toBe('sess-throttle'); // full-session uses session_id
    expect(item?.content).toContain('hello');
  });

  it('chunked retain skips below threshold', async () => {
    // With retainEveryNTurns=5 and retainMode=chunked, first call should be skipped.
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { HINDSIGHT_RETAIN_MODE: 'chunked' },
      extraSettings: { retainMode: 'chunked', retainEveryNTurns: 5 },
    });

    // Turn 1 of 5 — should NOT retain
    expect(captured.bodies).toHaveLength(0);
  });

  it('graceful on retain api error', async () => {
    const messages = [
      { role: 'user', content: 'test message' },
      { role: 'assistant', content: 'response' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript });

    const raiseError: FetchStub = (url) => {
      if (url.includes('/memories')) {
        throw new Error('connection refused');
      }
      return jsonResponse({});
    };

    // Should not raise — an escaping rejection would fail the test.
    await runHook('retain', hookInput, sandbox, { fetchStub: raiseError });
  });

  it('retain posts async true', async () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub });

    expect(captured.bodies).toHaveLength(1);
    expect(captured.bodies[0]?.async).toBe(true);
  });

  it('retain includes context label', async () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript });
    const captured = captureRetainRequests();

    await runHook('retain', hookInput, sandbox, { fetchStub: captured.stub });

    expect(captured.bodies).toHaveLength(1);
    expect(captured.bodies[0]?.items[0]?.context).toBe('claude-code');
  });

  it('disabled auto retain does not call api', async () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const transcript = writeTranscriptFile(sandbox.root, messages);
    const hookInput = makeHookInput({ transcript_path: transcript });

    const urls: string[] = [];
    const capture: FetchStub = (url) => {
      urls.push(url);
      return jsonResponse({});
    };

    await runHook('retain', hookInput, sandbox, {
      fetchStub: capture,
      extraSettings: { autoRetain: false, autoRecall: false },
    });

    expect(urls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Peri sessions (local SQLite session store)
// ---------------------------------------------------------------------------

describe('PeriSession', () => {
  it('retains user and assistant messages from the local store', async () => {
    const sessionId = 'sess-peri-basic';
    const dbPath = writePeriDatabase(sandbox.root, sessionId, [
      { role: 'user', content: 'Peri user question' },
      { role: 'assistant', content: 'Peri assistant answer' },
      { role: 'user', content: 'SYSTEM REMINDER SHOULD NOT APPEAR', type: 'system_reminder' },
      { role: 'assistant', content: 'EXCLUDED ROW SHOULD NOT APPEAR', excluded: true },
    ]);
    const captured = captureRetainRequests();
    const hookInput = makeHookInput({ session_id: sessionId, transcript_path: '' });

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { PERI_DB_PATH: dbPath },
    });

    expect(captured.bodies, 'retain API was not called').toHaveLength(1);
    const item = captured.bodies[0]?.items[0];
    expect(item?.content).toContain('Peri user question');
    expect(item?.content).toContain('Peri assistant answer');
    expect(item?.content).not.toContain('SYSTEM REMINDER');
    expect(item?.content).not.toContain('EXCLUDED ROW');
    expect(item?.metadata.session_id).toBe(sessionId);
  });

  it('retains only the new suffix on a second Stop', async () => {
    const sessionId = 'sess-peri-grow';
    const firstRows = [
      { role: 'user', content: 'first Peri question' },
      { role: 'assistant', content: 'first Peri answer' },
    ];
    let dbPath = writePeriDatabase(sandbox.root, sessionId, firstRows);
    const captured = captureRetainRequests();
    const hookInput = makeHookInput({ session_id: sessionId, transcript_path: '' });

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { PERI_DB_PATH: dbPath },
    });

    expect(captured.bodies).toHaveLength(1);
    expect(captured.bodies[0]?.items[0]?.document_id).toBe(sessionId);

    dbPath = writePeriDatabase(sandbox.root, sessionId, [
      ...firstRows,
      { role: 'user', content: 'second Peri question' },
      { role: 'assistant', content: 'second Peri answer' },
    ]);

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { PERI_DB_PATH: dbPath },
    });

    expect(captured.bodies).toHaveLength(2);
    const item = captured.bodies[1]?.items[0];
    expect(item?.document_id).toBe(`${sessionId}-c1`);
    expect(item?.content).toContain('second Peri question');
    expect(item?.content).not.toContain('first Peri question');
  });

  it('re-retains a rewritten Peri thread when the count is unchanged', async () => {
    const sessionId = 'sess-peri-rewind';
    const firstRows = [
      { messageId: 'old-1', role: 'user', content: 'rewound old question' },
      { messageId: 'old-2', role: 'assistant', content: 'rewound old answer' },
      { messageId: 'old-3', role: 'user', content: 'surviving old question' },
      { messageId: 'old-4', role: 'assistant', content: 'surviving old answer' },
    ];
    let dbPath = writePeriDatabase(sandbox.root, sessionId, firstRows);
    const captured = captureRetainRequests();
    const hookInput = makeHookInput({ session_id: sessionId, transcript_path: '' });

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { PERI_DB_PATH: dbPath },
    });

    expect(captured.bodies).toHaveLength(1);
    expect(captured.bodies[0]?.items[0]?.document_id).toBe(sessionId);

    // Peri rewind deletes old-1, then a new message (new-5) is appended. The
    // total stays 4, so only the last-message-id fingerprint can see the rewrite.
    dbPath = writePeriDatabase(sandbox.root, sessionId, [
      ...firstRows.slice(1),
      { messageId: 'new-5', role: 'user', content: 'rewritten Peri question' },
    ]);

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { PERI_DB_PATH: dbPath },
    });

    expect(captured.bodies, 'rewritten thread was not retained').toHaveLength(2);
    const item = captured.bodies[1]?.items[0];
    expect(item?.document_id).toBe(`${sessionId}-c1`);
    expect(item?.content).toContain('rewritten Peri question');
    expect(item?.content).toContain('surviving old question');
    expect(item?.content.trim().length).toBeGreaterThan(0);
  });

  it('retains only the newest bounded window of a large Peri thread', async () => {
    const sessionId = 'sess-peri-large';
    const bulkRows = Array.from({ length: 2500 }, (_, index) => ({
      messageId: `bulk-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `bulk message ${index}`,
    }));
    let dbPath = writePeriDatabase(sandbox.root, sessionId, bulkRows);
    const captured = captureRetainRequests();
    const hookInput = makeHookInput({ session_id: sessionId, transcript_path: '' });

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { PERI_DB_PATH: dbPath },
    });

    expect(captured.bodies).toHaveLength(1);
    const first = captured.bodies[0]?.items[0];
    expect(first?.content).toContain('bulk message 2499');
    expect(first?.content).not.toContain('bulk message 0');
    const firstState = readState<Record<string, { message_count: number }>>(
      'retention_tracking.json',
      {},
    );
    expect(firstState[sessionId]?.message_count).toBe(2500);

    // Two new messages push the total to 2502; only that suffix is retained.
    dbPath = writePeriDatabase(sandbox.root, sessionId, [
      ...bulkRows,
      { messageId: 'new-1', role: 'user', content: 'newest large question' },
      { messageId: 'new-2', role: 'assistant', content: 'newest large answer' },
    ]);

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { PERI_DB_PATH: dbPath },
    });

    expect(captured.bodies).toHaveLength(2);
    const second = captured.bodies[1]?.items[0];
    expect(second?.document_id).toBe(`${sessionId}-c1`);
    expect(second?.content).toContain('newest large question');
    expect(second?.content).not.toContain('bulk message 2499');
    expect(second?.content.trim().length).toBeGreaterThan(0);
    const secondState = readState<Record<string, { message_count: number }>>(
      'retention_tracking.json',
      {},
    );
    expect(secondState[sessionId]?.message_count).toBe(2502);
  });

  it('SessionEnd retains without a transcript_path', async () => {
    const sessionId = 'sess-peri-end';
    const dbPath = writePeriDatabase(sandbox.root, sessionId, [
      { role: 'user', content: 'final Peri question' },
      { role: 'assistant', content: 'final Peri answer' },
    ]);
    const captured = captureRetainRequests();
    const hookInput = makeHookInput({ session_id: sessionId, transcript_path: '' });

    await runHook('session-end', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { PERI_DB_PATH: dbPath },
    });

    expect(captured.bodies, 'SessionEnd did not retain').toHaveLength(1);
    expect(captured.bodies[0]?.items[0]?.content).toContain('final Peri question');
  });

  it('skips a missing Peri database without failing', async () => {
    const captured = captureRetainRequests();
    const hookInput = makeHookInput({ session_id: 'sess-peri-missing', transcript_path: '' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { PERI_DB_PATH: join(sandbox.root, 'missing', 'threads.db') },
      extraSettings: { debug: true },
    });

    expect(captured.bodies).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledWith(
      '[Hindsight]',
      expect.stringContaining('Peri session store not found'),
    );
  });

  it('skips a non-SQLite Peri database without failing', async () => {
    const dbPath = join(sandbox.root, 'not-a-database.db');
    writeFileSync(dbPath, 'this is not a SQLite database');
    const captured = captureRetainRequests();
    const hookInput = makeHookInput({ session_id: 'sess-peri-corrupt', transcript_path: '' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { PERI_DB_PATH: dbPath },
    });

    expect(captured.bodies).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Peri session store unavailable'),
    );
  });

  it('multi turn recall reads context from the Peri store', async () => {
    const sessionId = 'sess-peri-recall';
    const dbPath = writePeriDatabase(sandbox.root, sessionId, [
      { role: 'user', content: 'I use Python for all my scripts' },
      { role: 'assistant', content: 'Noted!' },
    ]);
    const captured = captureRecallRequests();
    const hookInput = makeHookInput({
      session_id: sessionId,
      transcript_path: '',
      prompt: 'What language should I use?',
    });

    await runHook('recall', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { PERI_DB_PATH: dbPath },
      extraSettings: { recallContextTurns: 2 },
    });

    expect(captured.bodies).toHaveLength(1);
    expect(captured.bodies[0]?.query).toContain('Python');
  });

  it('reads legacy unwrapped BaseMessage rows', async () => {
    const sessionId = 'sess-peri-legacy';
    const dbPath = writePeriDatabase(sandbox.root, sessionId, [
      { role: 'user', content: 'legacy Peri question', legacy: true },
      { role: 'assistant', content: 'legacy Peri answer', legacy: true },
    ]);
    const captured = captureRetainRequests();
    const hookInput = makeHookInput({ session_id: sessionId, transcript_path: '' });

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { PERI_DB_PATH: dbPath },
    });

    expect(captured.bodies, 'retain API was not called').toHaveLength(1);
    expect(captured.bodies[0]?.items[0]?.content).toContain('legacy Peri question');
  });

  it('includes Peri tool rows when retainToolCalls is enabled', async () => {
    const sessionId = 'sess-peri-tools';
    const dbPath = writePeriDatabase(sandbox.root, sessionId, [
      { role: 'user', content: 'run the tool' },
      { role: 'assistant', content: 'tool call issued' },
      { role: 'tool', content: 'tool output from Peri' },
    ]);
    const captured = captureRetainRequests();
    const hookInput = makeHookInput({ session_id: sessionId, transcript_path: '' });

    await runHook('retain', hookInput, sandbox, {
      fetchStub: captured.stub,
      extraEnv: { PERI_DB_PATH: dbPath },
      extraSettings: { retainToolCalls: true },
    });

    expect(captured.bodies, 'retain API was not called').toHaveLength(1);
    expect(captured.bodies[0]?.items[0]?.content).toContain('tool output from Peri');
  });
});
