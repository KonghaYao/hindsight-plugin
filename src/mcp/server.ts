/**
 * Hindsight MCP server for the Claude Code plugin.
 *
 * Runs as a stdio subprocess managed by the plugin system.
 * Exposes knowledge tools (list/get/create/update/delete pages, recall, ingest).
 * Reuses the existing plugin config chain and client.
 *
 * Each tool accepts an optional bank_id parameter. When omitted, falls back to
 * the default bank derived from config at startup. The PreToolUse hook injects
 * bank_id from session context (cwd, agentName) before calls reach here.
 *
 * Unlike the Python original there is no sys.path/venv bootstrap: the build
 * inlines every dependency into a single ESM file that plain `node` executes.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { deriveBankId } from '../lib/bank';
import { HindsightClient } from '../lib/client';
import { debugLog, loadConfig } from '../lib/config';
import { getApiUrl } from '../lib/daemon';
import { VERSION } from '../lib/version';

// ── Server setup ────────────────────────────────────────

const server = new McpServer({ name: 'hindsight', version: VERSION });

// Resolve config at startup
const config = loadConfig();

function dbg(...args: unknown[]): void {
  debugLog(config, ...args);
}

/**
 * Wrap a tool's return value as a text result.
 *
 * Python's FastMCP converted a plain `str` return into text content
 * automatically; nothing does that here, so every tool returns the envelope
 * explicitly.
 */
function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Wrap a failure so the MCP client can tell it apart from a success.
 *
 * `textResult` leaves `isError` unset, which reads as "the call worked" — the
 * model only finds out otherwise by parsing the JSON itself, and a programmatic
 * client cannot tell at all. The payload stays the same `{"error": ...}` object
 * the Python original returned through FastMCP; only the protocol-level signal
 * is added. Tools that hit an API failure (e.g. get_page on a missing page)
 * already surface an error this way, so this is what makes the tool surface
 * consistent.
 */
function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Python's `str(e)` — the message alone, without the `Error: ` prefix. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Non-throwing `os.path.isfile`. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // Missing, unreadable, or traverses a non-directory — `os.path.isfile`
    // answers False for every OS error as well.
    return false;
  }
}

/** URL-encode a bank ID for a path segment: Python's `urllib.parse.quote(bank_id, safe="")`. */
function encodeBank(bankId: string): string {
  return encodeURIComponent(bankId);
}

// ── Mental model defaults ───────────────────────────────

const PAGE_DEFAULTS = {
  mode: 'delta',
  refresh_after_consolidation: true,
  fact_types: ['observation'],
  exclude_mental_models: true,
};

// ── Tools ───────────────────────────────────────────────
// bank_id is NEVER exposed as a parameter — it's always resolved by the
// PreToolUse hook from plugin config at runtime.

function registerTools(client: HindsightClient, defaultBankId: string): void {
  server.registerTool(
    'agent_knowledge_get_current_bank',
    {
      description:
        'Get the current memory bank ID. This is the bank where conversations are retained and ' +
        'pages are stored. Use this to tell the user which bank their agent will be bound to.',
    },
    async () => textResult(JSON.stringify({ bank_id: defaultBankId })),
  );

  server.registerTool(
    'agent_knowledge_list_pages',
    {
      description:
        'List all your knowledge pages (IDs and names only). Use agent_knowledge_get_page to ' +
        'read the full content of a specific page.',
    },
    // The API defaults to detail=full, which returns synthesized content +
    // reflect_response for every page. The description above promises "IDs and
    // names only", so request the metadata projection explicitly. This keeps
    // list_pages payloads small at realistic agent scales (tens of pages,
    // each up to ~100 KB content).
    async () => {
      const resp = await client.request(
        'GET',
        `/v1/default/banks/${encodeBank(defaultBankId)}/mental-models?detail=metadata`,
        null,
        10,
      );
      return textResult(JSON.stringify(resp, null, 2));
    },
  );

  server.registerTool(
    'agent_knowledge_get_page',
    {
      description:
        'Read a specific knowledge page by its ID. Returns the full synthesized content.',
      inputSchema: { page_id: z.string() },
    },
    // detail=content returns the synthesized `content` plus metadata; detail=full
    // additionally includes `reflect_response`, the internal trace metadata used
    // to build the page. Empirically reflect_response is 70-95% of the response
    // bytes and the description above promises only "synthesized content" — full
    // payloads at this scale (200+ KB per page) blow past the MCP host's
    // per-tool-result token cap and force the result to spill to disk, where the
    // agent can't consume it inline.
    async ({ page_id: pageId }) => {
      const resp = await client.request(
        'GET',
        `/v1/default/banks/${encodeBank(defaultBankId)}/mental-models/${pageId}?detail=content`,
        null,
        10,
      );
      return textResult(JSON.stringify(resp, null, 2));
    },
  );

  server.registerTool(
    'agent_knowledge_create_page',
    {
      description:
        'Create a new knowledge page. The source_query is a question the system re-asks after ' +
        'each consolidation to rebuild the page from conversation observations. Pages ' +
        'auto-update as you have more conversations.',
      inputSchema: {
        page_id: z.string(),
        name: z.string(),
        source_query: z.string(),
      },
    },
    async ({ page_id: pageId, name, source_query: sourceQuery }) => {
      const resp = await client.request(
        'POST',
        `/v1/default/banks/${encodeBank(defaultBankId)}/mental-models`,
        {
          id: pageId,
          name,
          source_query: sourceQuery,
          max_tokens: 4096,
          trigger: PAGE_DEFAULTS,
        },
        15,
      );
      return textResult(JSON.stringify(resp, null, 2));
    },
  );

  server.registerTool(
    'agent_knowledge_update_page',
    {
      description:
        "Update a page's name or source query. The content will re-synthesize on next " +
        'consolidation.',
      inputSchema: {
        page_id: z.string(),
        name: z.string().optional().default(''),
        source_query: z.string().optional().default(''),
      },
    },
    async ({ page_id: pageId, name, source_query: sourceQuery }) => {
      const body: Record<string, unknown> = {};
      if (name) {
        body.name = name;
      }
      if (sourceQuery) {
        body.source_query = sourceQuery;
      }
      if (Object.keys(body).length === 0) {
        return errorResult(JSON.stringify({ error: 'Provide name or source_query to update' }));
      }
      const resp = await client.request(
        'PATCH',
        `/v1/default/banks/${encodeBank(defaultBankId)}/mental-models/${pageId}`,
        body,
        10,
      );
      return textResult(JSON.stringify(resp, null, 2));
    },
  );

  server.registerTool(
    'agent_knowledge_delete_page',
    {
      description: 'Permanently delete a knowledge page.',
      inputSchema: { page_id: z.string() },
    },
    async ({ page_id: pageId }) => {
      const resp = await client.request(
        'DELETE',
        `/v1/default/banks/${encodeBank(defaultBankId)}/mental-models/${pageId}`,
        null,
        10,
      );
      return textResult(JSON.stringify(resp, null, 2));
    },
  );

  server.registerTool(
    'agent_knowledge_recall',
    {
      description:
        'Search across all retained conversations and documents for specific facts, numbers, or ' +
        'details not covered by your knowledge pages. max_tokens is the result token budget ' +
        '(server returns whatever fits).',
      inputSchema: {
        query: z.string(),
        max_tokens: z.number().int().optional().default(1024),
      },
    },
    async ({ query, max_tokens: maxTokens }) => {
      // The same knob the auto-recall hook reads, so `recallTypes` governs every
      // recall the plugin performs instead of only half of them. An empty list
      // means "no filter", matching the hook's `stringListOrNull` semantics.
      const recallTypes =
        Array.isArray(config.recallTypes) && config.recallTypes.length > 0
          ? config.recallTypes
          : null;
      const resp = await client.recall(
        defaultBankId,
        query,
        maxTokens,
        'mid',
        recallTypes,
        null,
        null,
        null,
        10,
      );
      return textResult(JSON.stringify(resp, null, 2));
    },
  );

  server.registerTool(
    'agent_knowledge_ingest',
    {
      description:
        'Upload text content into your memory bank. Pass the full raw content — never summarize ' +
        'before ingesting. The title becomes the document ID (re-ingesting replaces it).',
      inputSchema: { title: z.string(), content: z.string() },
    },
    async ({ title, content }) => {
      const docId = title.toLowerCase().replaceAll(' ', '-');
      const resp = await client.retain(defaultBankId, content, docId, null, null, null, 15);
      return textResult(JSON.stringify(resp, null, 2));
    },
  );

  server.registerTool(
    'agent_knowledge_ingest_file',
    {
      description:
        'Ingest a file from disk into your memory bank. Reads the file and uploads its full ' +
        'content. The filename becomes the document ID.',
      inputSchema: { file_path: z.string() },
    },
    async ({ file_path: filePath }) => {
      if (!isFile(filePath)) {
        return errorResult(JSON.stringify({ error: `File not found: ${filePath}` }));
      }

      const content = readFileSync(filePath, 'utf8');
      if (content.trim() === '') {
        return errorResult(JSON.stringify({ error: `File is empty: ${filePath}` }));
      }

      const docId = stripLastExtension(filePath).toLowerCase().replaceAll(' ', '-');
      const resp = await client.retain(defaultBankId, content, docId, null, null, null, 15);
      return textResult(JSON.stringify(resp, null, 2));
    },
  );
}

/**
 * Python's `os.path.basename(path).rsplit(".", 1)[0]` — drop everything from the
 * last dot on. `extname` is not equivalent: it keeps a leading-dot filename
 * (".env") whole, while `rsplit` yields an empty stem.
 */
function stripLastExtension(filePath: string): string {
  const base = basename(filePath);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? base : base.slice(0, dot);
}

// ── Entry point ─────────────────────────────────────────

async function main(): Promise<void> {
  if (!config.enableKnowledgeTools) {
    // Knowledge tools are opt-out. When disabled we must NOT exit: the plugin
    // registers this server unconditionally in .mcp.json, and Claude Code treats
    // a process that exits at startup as a crashed server — retrying it and
    // surfacing a `-32000` reconnect error on every prompt. Instead, stay alive
    // as an empty MCP server that advertises no tools. The tool definitions
    // above are skipped entirely because this branch returns before they are
    // registered.
    dbg('Knowledge tools disabled (enableKnowledgeTools=false) — running empty MCP server');
    // FastMCP declared the `tools` capability and answered `tools/list` with an
    // empty array even with nothing registered; the SDK only installs that
    // handler on the first registerTool call, so declare both here to keep the
    // disabled server indistinguishable from the Python one.
    server.server.registerCapabilities({ tools: { listChanged: true } });
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    await server.connect(new StdioServerTransport());
    return;
  }

  let apiUrl: string;
  try {
    apiUrl = await getApiUrl(config, dbg, true);
  } catch (error) {
    console.error(`[Hindsight MCP] Failed to resolve API URL: ${errorMessage(error)}`);
    process.exit(1);
  }

  const projectCwd = process.env.HINDSIGHT_MCP_PROJECT_CWD ?? process.cwd();
  const hookInput: Record<string, unknown> = { cwd: projectCwd, session_id: '' };
  const defaultBankId = deriveBankId(hookInput, config);
  const client = new HindsightClient(
    apiUrl,
    config.hindsightApiToken,
    config.requestTimeoutSeconds,
  );

  dbg(`MCP server starting — API: ${apiUrl}, bank: ${defaultBankId}`);

  registerTools(client, defaultBankId);

  await server.connect(new StdioServerTransport());
}

/**
 * Serve stdio until the client disconnects.
 *
 * Called by `src/cli.ts` (`hindsight mcp`). The MCP SDK owns the process from
 * here: it keeps stdin open and exits when the transport closes.
 */
export async function run(): Promise<void> {
  await main();
}
