/**
 * Tests for src/lib/client.ts — Hindsight REST API client.
 *
 * Migrated 1:1 from tests/test_client.py. The Python suite patched
 * `urllib.request.urlopen`; the TypeScript implementation uses the global
 * `fetch`, which is stubbed here with a mock returning real `Response` objects
 * (so `ok` / `status` / `text()` / `json()` keep their real semantics).
 * `HindsightClient` methods are async, so every call is awaited.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { HindsightClient, USER_AGENT, validateApiUrl } from '../src/lib/client';
import { createEnvSandbox, type EnvSandbox } from './helpers';

let sandbox: EnvSandbox;
let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  sandbox = createEnvSandbox();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  sandbox.restore();
  vi.unstubAllGlobals();
});

/** The parts of a `fetch` call the Python suite inspected on the request. */
interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  signal: AbortSignal | null;
}

/** Inspect the most recent `fetch` call (Python captured `req` in the mock). */
function lastRequest(): RecordedRequest {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) {
    throw new Error('fetch was not called');
  }
  const [input, init] = call;
  const rawBody = init?.body;
  return {
    url: String(input),
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: typeof rawBody === 'string' ? (JSON.parse(rawBody) as Record<string, unknown>) : null,
    signal: init?.signal ?? null,
  };
}

/** Reply to every fetch with a fresh JSON response (Python's `FakeResp`). */
function respondWith(body: unknown, status = 200): void {
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
}

/** Reply to every fetch with a raw (non-JSON) body, e.g. an error page. */
function respondWithText(text: string, status: number, statusText?: string): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response(text, { status, statusText: statusText ?? '' })),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('ValidateApiUrl', () => {
  it('accepts an http url', () => {
    expect(validateApiUrl('http://localhost:9077')).toBe('http://localhost:9077');
  });

  it('accepts an https url', () => {
    expect(validateApiUrl('https://api.example.com/')).toBe('https://api.example.com');
  });

  it('strips the trailing slash', () => {
    expect(validateApiUrl('http://host:8080/')).toBe('http://host:8080');
  });

  it('rejects a non-http scheme', () => {
    expect(() => validateApiUrl('ftp://host')).toThrow('http or https');
  });

  it('rejects a url without a hostname', () => {
    expect(() => validateApiUrl('http://')).toThrow();
  });
});

describe('HindsightClientInit', () => {
  it('rejects a non-http api url', () => {
    expect(() => new HindsightClient('ftp://bad')).toThrow();
  });

  it('stores the api token', () => {
    const client = new HindsightClient('http://localhost:9077', 'tok123');
    expect(client.apiToken).toBe('tok123');
  });

  it('defaults the api token to null', () => {
    const client = new HindsightClient('http://localhost:9077');
    expect(client.apiToken).toBeNull();
  });
});

describe('HindsightClientRecall', () => {
  it('posts to the bank recall endpoint', async () => {
    const client = new HindsightClient('http://localhost:9077');
    respondWith({ results: [{ text: 'Paris', type: 'world' }] });

    const response = await client.recall('my-bank', 'capital of France');

    const results = response.results as Array<{ text: string }>;
    expect(results[0]?.text).toBe('Paris');

    const request = lastRequest();
    expect(request.method).toBe('POST');
    expect(request.url).toBe('http://localhost:9077/v1/default/banks/my-bank/memories/recall');
  });

  it('url-encodes the bank id', async () => {
    const client = new HindsightClient('http://localhost:9077');
    respondWith({ results: [] });

    await client.recall('bank with spaces', 'query');

    expect(lastRequest().url).toContain('bank%20with%20spaces');
  });

  it('sends an Authorization header when a token is set', async () => {
    const client = new HindsightClient('http://localhost:9077', 'mytoken');
    respondWith({ results: [] });

    await client.recall('bank', 'query');

    expect(lastRequest().headers.Authorization).toBe('Bearer mytoken');
  });

  it('omits the Authorization header without a token', async () => {
    const client = new HindsightClient('http://localhost:9077');
    respondWith({ results: [] });

    await client.recall('bank', 'query');

    expect(lastRequest().headers).not.toHaveProperty('Authorization');
  });

  it('sends the plugin user agent header', async () => {
    // Regression test for #1041: a UA-based bot filter (Cloudflare error 1010)
    // rejected the Python stdlib default, so the client must always send ours.
    const client = new HindsightClient('http://localhost:9077');
    respondWith({ results: [] });

    await client.recall('bank', 'query');

    expect(lastRequest().headers['User-Agent']).toBe(USER_AGENT);
    expect(USER_AGENT.startsWith('hindsight-claude-code/')).toBe(true);
  });

  it('raises when the response status is an error', async () => {
    const client = new HindsightClient('http://localhost:9077');
    respondWithText('server exploded', 500, 'Internal Server Error');

    await expect(client.recall('b', 'query')).rejects.toThrow(/HTTP 500 .*server exploded/);
  });

  it('sends budget and types', async () => {
    const client = new HindsightClient('http://localhost:9077');
    respondWith({ results: [] });

    await client.recall('bank', 'query', 1024, 'high', ['world', 'experience']);

    const body = lastRequest().body;
    expect(body?.budget).toBe('high');
    expect(body?.types).toEqual(['world', 'experience']);
  });

  it('sends tag filters', async () => {
    const client = new HindsightClient('http://localhost:9077');
    respondWith({ results: [] });
    const tagGroups = [{ op: 'all', tags: ['memory_type:rule', 'tech_stack:supabase'] }];

    // recall(bankId, query, maxTokens, budget, types, tags, tagsMatch, tagGroups)
    await client.recall(
      'bank',
      'query',
      1024,
      'mid',
      null,
      ['memory_type:rule'],
      'any_strict',
      tagGroups,
    );

    const body = lastRequest().body;
    expect(body?.tags).toEqual(['memory_type:rule']);
    expect(body?.tags_match).toBe('any_strict');
    expect(body?.tag_groups).toEqual([
      { op: 'all', tags: ['memory_type:rule', 'tech_stack:supabase'] },
    ]);
  });
});

describe('HindsightClientRetain', () => {
  it('posts with async true', async () => {
    const client = new HindsightClient('http://localhost:9077');
    respondWith({ status: 'accepted' });

    await client.retain('bank', 'transcript content', 'doc-1', 'claude-code');

    const body = lastRequest().body;
    expect(body?.async).toBe(true);
    expect(body?.items).toMatchObject([{ content: 'transcript content', context: 'claude-code' }]);
  });

  it('url-encodes the bank id in the retain path', async () => {
    const client = new HindsightClient('http://localhost:9077');
    respondWith({});

    await client.retain('my::bank', 'content');

    expect(lastRequest().url).toContain('my%3A%3Abank');
  });
});

describe('RequestTimeoutOverride', () => {
  /**
   * The override (passed via the constructor) replaces the per-call timeout that
   * recall/retain/request would otherwise use; when unset the per-call default is
   * preserved (issue #1575). Python asserted the `timeout=` kwarg handed to
   * urlopen; the equivalent here is the millisecond delay given to the fetch
   * `AbortSignal`.
   */
  it('replaces the recall default', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const client = new HindsightClient('http://localhost:9077', null, 60);
    respondWith({ results: [] });

    await client.recall('bank', 'query');

    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(lastRequest().signal).toBeInstanceOf(AbortSignal);
  });

  it('replaces the retain default', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const client = new HindsightClient('http://localhost:9077', null, 60);
    respondWith({});

    await client.retain('bank', 'content');

    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
  });

  it('replaces an explicit request timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const client = new HindsightClient('http://localhost:9077', null, 60);
    respondWith({});

    await client.request('GET', '/v1/anything', null, 10);

    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
  });

  it('preserves the recall default when unset', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const client = new HindsightClient('http://localhost:9077');
    respondWith({ results: [] });

    await client.recall('bank', 'query');

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it('preserves the retain default when unset', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const client = new HindsightClient('http://localhost:9077');
    respondWith({});

    await client.retain('bank', 'content');

    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });
});

describe('HindsightClientSetBankMission', () => {
  it('patches the bank config endpoint', async () => {
    const client = new HindsightClient('http://localhost:9077');
    respondWith({});

    await client.setBankMission('my-bank', 'I am Claude', 'Extract facts');

    const request = lastRequest();
    expect(request.method).toBe('PATCH');
    expect(request.url).toContain('my-bank');
    expect(request.body?.updates).toMatchObject({
      reflect_mission: 'I am Claude',
      retain_mission: 'Extract facts',
    });
  });
});
