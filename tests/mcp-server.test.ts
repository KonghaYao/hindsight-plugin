/**
 * End-to-end tests for the bundled MCP server.
 *
 * Port of `tests/test_mcp_server.py`, which reached its conclusions by grepping
 * `scripts/mcp_server.py`'s source text: that the server reads
 * `HINDSIGHT_MCP_PROJECT_CWD`, that `list_pages` pins `detail=metadata`, that
 * `get_page` pins `detail=content`, and that the disabled branch runs an empty
 * server instead of exiting. Every one of those is observable over the wire, and
 * `src/mcp/server.ts` exports no tool handlers (it connects on import), so this
 * port drives the real build artifact through a real stdio JSON-RPC session —
 * the same `initialize` / `tools/list` / `tools/call` exchange Claude Code
 * performs — and asserts on what the server actually does, including the HTTP
 * request it makes, which a source grep could never check.
 *
 * `HINDSIGHT_API_URL` points at a local stub server so no test touches the
 * network, and `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` / `HOME` point into a
 * per-test sandbox so no test reads or writes real configuration.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnvSandbox, type EnvSandbox } from './helpers';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The same build artifact `plugin/.mcp.json` reaches through `hindsight mcp`. */
const SERVER_ENTRY = join(PACKAGE_ROOT, 'dist', 'cli.js');
const SERVER_ARGS = [SERVER_ENTRY, 'mcp'];

/** `process.env` with every `undefined` dropped — `spawn` only takes strings. */
function stringEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

interface StubApi {
  url: string;
  requests: Array<{ method: string; path: string }>;
  /** Parsed JSON request bodies, in the order the requests arrived. */
  bodies: unknown[];
  close(): Promise<void>;
}

/** A local stand-in for the Hindsight API that records every request it receives. */
async function startStubApi(payload: unknown): Promise<StubApi> {
  const requests: Array<{ method: string; path: string }> = [];
  const bodies: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ method: request.method ?? '', path: request.url ?? '' });
      const raw = Buffer.concat(chunks).toString('utf8');
      // Requests such as DELETE carry no body; a bare `JSON.parse('')` would throw.
      bodies.push(raw === '' ? null : (JSON.parse(raw) as unknown));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface Harness {
  client: Client;
  /** Everything the server has written to stderr so far. */
  stderr(): string;
}

let sandbox: EnvSandbox;
let open: Array<{ client: Client; stub: StubApi | null }>;

beforeAll(() => {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`${SERVER_ENTRY} is missing — run \`bun run build\` before this suite.`);
  }
});

beforeEach(() => {
  sandbox = createEnvSandbox();
  open = [];
});

afterEach(async () => {
  for (const { client, stub } of open) {
    await client.close().catch(() => undefined);
    await stub?.close();
  }
  open = [];
  sandbox.restore();
});

/**
 * Spawn the bundled server over stdio and complete the MCP handshake.
 *
 * `stub`, when given, is closed together with the connection.
 */
async function connectServer(options: {
  env?: Record<string, string>;
  cwd?: string;
  stub?: StubApi;
}): Promise<Harness> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: SERVER_ARGS,
    cwd: options.cwd ?? PACKAGE_ROOT,
    stderr: 'pipe',
    env: {
      ...stringEnv(),
      HOME: sandbox.homeDir,
      CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot,
      CLAUDE_PLUGIN_DATA: sandbox.pluginData,
      ...options.env,
    },
  });

  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const client = new Client({ name: 'vitest', version: '1.0.0' });
  await client.connect(transport);
  open.push({ client, stub: options.stub ?? null });

  return { client, stderr: () => stderr };
}

/** Call a tool and decode the single text block it returns. */
async function callToolText(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; payload: unknown; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  // The SDK types the content of a result as `unknown` (the compatibility
  // overload has no content at all), so narrow it the way a client would.
  const content = result.content;
  expect(Array.isArray(content)).toBe(true);
  const blocks = content as Array<{ type?: string; text?: string }>;
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe('text');
  const text = blocks[0]?.text ?? '';
  return { text, payload: JSON.parse(text) as unknown, isError: result.isError === true };
}

interface ToolSchema {
  required: string[];
  /** Parameter name → JSON schema type. */
  properties: Record<string, string>;
  /** Parameter name → schema default, for the Python signatures that had one. */
  defaults?: Record<string, unknown>;
}

/**
 * The tool surface, in registration order.
 *
 * Mirrors the `@mcp.tool()` functions of `scripts/mcp_server.py`: the same nine
 * tools, the same required parameters, and the same defaults Claude Code used to
 * receive from FastMCP. `bank_id` is deliberately absent everywhere — the
 * PreToolUse hook resolves the bank from config, never the model.
 */
const TOOLS: Array<[string, ToolSchema]> = [
  ['agent_knowledge_get_current_bank', { required: [], properties: {} }],
  ['agent_knowledge_list_pages', { required: [], properties: {} }],
  ['agent_knowledge_get_page', { required: ['page_id'], properties: { page_id: 'string' } }],
  [
    'agent_knowledge_create_page',
    {
      required: ['page_id', 'name', 'source_query'],
      properties: { page_id: 'string', name: 'string', source_query: 'string' },
    },
  ],
  [
    'agent_knowledge_update_page',
    {
      required: ['page_id'],
      properties: { page_id: 'string', name: 'string', source_query: 'string' },
      defaults: { name: '', source_query: '' },
    },
  ],
  ['agent_knowledge_delete_page', { required: ['page_id'], properties: { page_id: 'string' } }],
  [
    'agent_knowledge_recall',
    {
      required: ['query'],
      properties: { query: 'string', max_tokens: 'integer' },
      defaults: { max_tokens: 1024 },
    },
  ],
  [
    'agent_knowledge_ingest',
    { required: ['title', 'content'], properties: { title: 'string', content: 'string' } },
  ],
  ['agent_knowledge_ingest_file', { required: ['file_path'], properties: { file_path: 'string' } }],
];

describe('MCP server tool surface', () => {
  it('advertises the nine knowledge tools with their parameter schemas', async () => {
    const { client } = await connectServer({ env: { HINDSIGHT_API_URL: 'http://127.0.0.1:1' } });

    expect(client.getServerVersion()?.name).toBe('hindsight');

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(TOOLS.map(([name]) => name));

    for (const [name, expected] of TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new Error(`tool ${name} was not advertised`);
      }

      expect([...(tool.inputSchema.required ?? [])].sort(), `${name}.required`).toEqual(
        [...expected.required].sort(),
      );

      const properties = tool.inputSchema.properties ?? {};
      expect(Object.keys(properties).sort(), `${name} parameters`).toEqual(
        Object.keys(expected.properties).sort(),
      );
      for (const [param, type] of Object.entries(expected.properties)) {
        const schema = properties[param] as { type?: string } | undefined;
        expect(schema?.type, `${name}.${param}`).toBe(type);
      }
      for (const [param, value] of Object.entries(expected.defaults ?? {})) {
        const schema = properties[param] as { default?: unknown } | undefined;
        expect(schema?.default, `${name}.${param} default`).toEqual(value);
      }
    }
  });

  it('keeps the server alive with no tools registered when knowledge tools are disabled', async () => {
    // `.mcp.json` registers this server unconditionally, so Claude Code expects a
    // live process. A server that exits at startup is treated as crashed and
    // surfaces a `-32000` reconnect error on every prompt (issue #1995).
    sandbox.writePluginSettings({ enableKnowledgeTools: false });
    const { client } = await connectServer({ env: { HINDSIGHT_API_URL: 'http://127.0.0.1:1' } });

    expect((await client.listTools()).tools).toEqual([]);

    // Still answering after the handshake, i.e. the process did not exit on the
    // disabled branch.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await client.listTools()).tools).toEqual([]);
  });
});

describe('MCP server default bank', () => {
  it('derives the bank from HINDSIGHT_MCP_PROJECT_CWD', async () => {
    sandbox.writePluginSettings({
      dynamicBankId: true,
      dynamicBankGranularity: ['project', 'session'],
      resolveWorktrees: false,
    });
    const project = join(sandbox.root, 'proj-alpha');

    const { client } = await connectServer({
      env: { HINDSIGHT_API_URL: 'http://127.0.0.1:1', HINDSIGHT_MCP_PROJECT_CWD: project },
    });

    const { payload } = await callToolText(client, 'agent_knowledge_get_current_bank');
    // The launcher captured Claude Code's project cwd before handing off; the
    // bank must be built from it, not from wherever the server happens to run.
    // There is no session at startup, so the `session` segment is "unknown" —
    // the hook input is `{cwd: <project>, session_id: ""}`.
    expect(payload).toEqual({ bank_id: 'proj-alpha::unknown' });
  });

  it('falls back to its own cwd when HINDSIGHT_MCP_PROJECT_CWD is unset', async () => {
    sandbox.writePluginSettings({
      dynamicBankId: true,
      dynamicBankGranularity: ['project'],
      resolveWorktrees: false,
    });
    const project = join(sandbox.root, 'proj-beta');
    mkdirSync(project, { recursive: true });

    // `createEnvSandbox` scrubs HINDSIGHT_*, so the variable really is unset here.
    const { client } = await connectServer({
      env: { HINDSIGHT_API_URL: 'http://127.0.0.1:1' },
      cwd: project,
    });

    const { payload } = await callToolText(client, 'agent_knowledge_get_current_bank');
    expect(payload).toEqual({ bank_id: 'proj-beta' });
  });
});

describe('MCP server tool calls', () => {
  it('lists pages through the metadata projection and returns the API payload', async () => {
    const stub = await startStubApi({ mental_models: [{ id: 'page-1', name: 'Deploys' }] });
    sandbox.writePluginSettings({ bankId: 'test-bank' });
    const { client } = await connectServer({ env: { HINDSIGHT_API_URL: stub.url }, stub });

    const { text, payload } = await callToolText(client, 'agent_knowledge_list_pages');

    // The API defaults to `detail=full`, which returns synthesized content +
    // reflect_response for every page in the bank — enough to blow past the MCP
    // client's 16 MB response ceiling and disconnect. The tool promises "IDs and
    // names only", so the request must pin the metadata projection.
    expect(stub.requests).toEqual([
      { method: 'GET', path: '/v1/default/banks/test-bank/mental-models?detail=metadata' },
    ]);
    expect(payload).toEqual({ mental_models: [{ id: 'page-1', name: 'Deploys' }] });
    // Python's `json.dumps(resp, indent=2)`.
    expect(text).toBe(
      JSON.stringify({ mental_models: [{ id: 'page-1', name: 'Deploys' }] }, null, 2),
    );
  });

  it('reads a page through the content projection', async () => {
    const stub = await startStubApi({ id: 'page-1', content: '# Deploys' });
    sandbox.writePluginSettings({ bankId: 'test-bank' });
    const { client } = await connectServer({ env: { HINDSIGHT_API_URL: stub.url }, stub });

    const { payload } = await callToolText(client, 'agent_knowledge_get_page', {
      page_id: 'page-1',
    });

    // `detail=full` would add reflect_response, 70-95% of the bytes, which pushes
    // the result past the host's token cap and forces it to spill to disk.
    expect(stub.requests).toEqual([
      { method: 'GET', path: '/v1/default/banks/test-bank/mental-models/page-1?detail=content' },
    ]);
    expect(payload).toEqual({ id: 'page-1', content: '# Deploys' });
  });

  it('forwards the configured recallTypes so one setting governs every recall', async () => {
    const stub = await startStubApi({ results: [] });
    sandbox.writePluginSettings({ bankId: 'test-bank' });
    const { client } = await connectServer({ env: { HINDSIGHT_API_URL: stub.url }, stub });

    await callToolText(client, 'agent_knowledge_recall', { query: 'anything' });

    // The tool used to send `types: null` unconditionally, so `recallTypes`
    // narrowed the auto-recall hook but not this tool.
    expect(stub.bodies).toEqual([
      expect.objectContaining({ types: ['world', 'experience', 'observation'] }),
    ]);
  });
});

describe('MCP server tool errors', () => {
  // A failure that never reaches the API still has to be reported as a failure.
  // Returning the payload through `textResult` alone leaves `isError` unset,
  // which tells the client the call succeeded — tools that hit an API error
  // (get_page on a missing page) already set it, so a caller cannot rely on
  // either. These pin the consistent behaviour.
  it('reports a missing file as a tool error', async () => {
    const stub = await startStubApi({});
    sandbox.writePluginSettings({ bankId: 'test-bank' });
    const { client } = await connectServer({ env: { HINDSIGHT_API_URL: stub.url }, stub });

    const { payload, isError } = await callToolText(client, 'agent_knowledge_ingest_file', {
      file_path: join(sandbox.root, 'does-not-exist.txt'),
    });

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: `File not found: ${join(sandbox.root, 'does-not-exist.txt')}`,
    });
    expect(stub.requests, 'no API call for an unreadable file').toEqual([]);
  });

  it('reports an empty file as a tool error', async () => {
    const emptyPath = join(sandbox.root, 'empty.txt');
    writeFileSync(emptyPath, '   \n');
    const stub = await startStubApi({});
    sandbox.writePluginSettings({ bankId: 'test-bank' });
    const { client } = await connectServer({ env: { HINDSIGHT_API_URL: stub.url }, stub });

    const { payload, isError } = await callToolText(client, 'agent_knowledge_ingest_file', {
      file_path: emptyPath,
    });

    expect(isError).toBe(true);
    expect(payload).toEqual({ error: `File is empty: ${emptyPath}` });
    expect(stub.requests, 'no API call for empty content').toEqual([]);
  });

  it('reports an update with neither field as a tool error', async () => {
    const stub = await startStubApi({});
    sandbox.writePluginSettings({ bankId: 'test-bank' });
    const { client } = await connectServer({ env: { HINDSIGHT_API_URL: stub.url }, stub });

    const { payload, isError } = await callToolText(client, 'agent_knowledge_update_page', {
      page_id: 'page-1',
    });

    expect(isError).toBe(true);
    expect(payload).toEqual({ error: 'Provide name or source_query to update' });
    expect(stub.requests, 'no API call without an update').toEqual([]);
  });

  it('still reports a successful call as a success', async () => {
    const stub = await startStubApi({ id: 'page-1', content: '# Deploys' });
    sandbox.writePluginSettings({ bankId: 'test-bank' });
    const { client } = await connectServer({ env: { HINDSIGHT_API_URL: stub.url }, stub });

    const { isError } = await callToolText(client, 'agent_knowledge_get_page', {
      page_id: 'page-1',
    });

    expect(isError).toBe(false);
  });
});
