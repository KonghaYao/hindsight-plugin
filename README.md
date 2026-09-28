# Hindsight Memory Plugin for Claude Code

Biomimetic long-term memory for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) using [Hindsight](https://vectorize.io/hindsight). Automatically captures conversations and intelligently recalls relevant context.

Two artifacts ship from this repository:

| Artifact | Where | What it is |
|----------|-------|------------|
| [`@peri-code/hindsight`](https://www.npmjs.com/package/@peri-code/hindsight) | npm | The CLI that does the work: the four hooks and the MCP server |
| `hindsight-memory` | [`plugin/`](plugin) | The Claude Code plugin — a directory of JSON that calls that CLI through `npx` |

The plugin ships no code of its own, so there is nothing to build after
installing it: `npx` fetches the pinned CLI release on first use and runs it from
its cache afterwards.

## Quick Start

```bash
# 1. Add the marketplace and install the plugin
#    The repository is the marketplace; `.claude-plugin/marketplace.json` points
#    the plugin entry at plugin/, so what installs is the JSON directory, not the
#    package source. If you also have the upstream `hindsight` marketplace added,
#    spell the install as `hindsight-memory@hindsight-plugin` — both offer a
#    plugin by that name.
claude plugin marketplace add KonghaYao/hindsight-plugin
claude plugin install hindsight-memory

# 2. Configure your LLM provider for memory extraction
# Option A: OpenAI (auto-detected)
export OPENAI_API_KEY="sk-your-key"

# Option B: Anthropic (auto-detected)
export ANTHROPIC_API_KEY="your-key"

# Option C: No API key needed (uses Claude Code's own model — personal/local use only)
# See: https://vectorize.io/hindsight/developer/models#claude-code-setup-claude-promax
export HINDSIGHT_LLM_PROVIDER=claude-code

# Option D: Connect to an external Hindsight server instead of running locally
mkdir -p ~/.hindsight
echo '{"hindsightApiUrl": "https://your-hindsight-server.com"}' > ~/.hindsight/claude-code.json

# 3. Start Claude Code — the plugin activates automatically
claude
```

That's it! The plugin will automatically start capturing and recalling memories.

> **Requirements:** Node.js 20+ — the same runtime Claude Code uses, and the one
> `npx` needs. Nothing else: the CLI has no runtime dependencies, and the plugin
> has no build step.

> **First run:** the plugin ships no code of its own, so the first hook to fire
> downloads the CLI (~175 kB) into npm's cache. It happens once; every run after
> that is local. The session-start hook is given 30 seconds for exactly this,
> rather than the 5 its health check needs.

### Using the CLI on its own

The plugin is one consumer of the CLI; you can drive it directly, without Claude
Code:

```bash
npx -y -p @peri-code/hindsight hindsight hook recall   # run a hook once
npx -y -p @peri-code/hindsight hindsight mcp           # start the MCP server
npx -y -p @peri-code/hindsight hindsight --help        # everything else
```

The `-p <spec>` form names the package explicitly; plain `npx @peri-code/hindsight …`
works too, but is ambiguous when the argument happens to look like a path.

## Features

- **Auto-recall** — on every user prompt, queries Hindsight for relevant memories and injects them as context (invisible to the chat transcript, visible to Claude)
- **Auto-retain** — after every response (or every N turns), extracts and retains conversation content to Hindsight for long-term storage
- **Knowledge tools** — MCP server exposing `agent_knowledge_*` tools for managing knowledge pages (list, get, create, update, delete), searching memories, and ingesting documents
- **Subagents with memory** — any subagent that declares the `hindsight` MCP server in its frontmatter gains the knowledge tools and builds memory across sessions
- **Daemon management** — can auto-start/stop `hindsight-embed` locally or connect to an external Hindsight server
- **Dynamic bank IDs** — supports per-agent, per-project, or per-session memory isolation
- **Channel-agnostic** — works with Claude Code Channels (Telegram, Discord, Slack) or interactive sessions
- **Zero runtime dependencies** — the published package is one bundled ESM file that plain Node.js runs, so `npx` needs no install step and nothing is resolved from `node_modules`


## Subagents with Memory

Create specialized subagents that learn and build knowledge across sessions.

### Creating an agent

Write a subagent file to `~/.claude/agents/<name>.md` and list `hindsight` under
`mcpServers` in its frontmatter. That is the whole wiring step — it gives the
agent the `agent_knowledge_*` tools described below, so the agent can load its
knowledge pages at startup and retain what it learns as it works.

The agent appears in `/agents` and Claude auto-delegates to it based on its description, or you can mention `@agent-name` directly.

### Knowledge Tools (MCP)

When `enableKnowledgeTools` is `true`, the plugin starts a local MCP server exposing these tools:

| Tool | Description |
|------|-------------|
| `agent_knowledge_list_pages` | List all knowledge pages |
| `agent_knowledge_get_page` | Read a specific page |
| `agent_knowledge_create_page` | Create a new page with a source query |
| `agent_knowledge_update_page` | Update a page's name or source query |
| `agent_knowledge_delete_page` | Delete a page |
| `agent_knowledge_recall` | Search memories |
| `agent_knowledge_ingest` | Ingest text content |
| `agent_knowledge_ingest_file` | Ingest a file from disk |
| `agent_knowledge_get_current_bank` | Get the current bank ID |

The bank ID is resolved automatically from the plugin config — tools never expose a `bank_id` parameter.

## Architecture

The plugin registers four Claude Code hooks and one MCP server. All five are
subcommands of the same CLI, which the plugin reaches through `npx`:

| CLI subcommand | Event/Transport | Purpose |
|----------------|-----------------|---------|
| `hindsight hook session-start` | `SessionStart` hook | Health check — verify Hindsight is reachable |
| `hindsight hook recall` | `UserPromptSubmit` hook | **Auto-recall** — query memories, inject as `additionalContext` |
| `hindsight hook retain` | `Stop` hook (async) | **Auto-retain** — extract transcript, POST to Hindsight |
| `hindsight hook session-end` | `SessionEnd` hook | Cleanup — stop auto-managed daemon if started |
| `hindsight mcp` | MCP stdio server | **Knowledge tools** — `agent_knowledge_*` tools for pages, recall, ingest |

`plugin/hooks/hooks.json` and `plugin/.mcp.json` are the only places those
commands are wired up, and both pin an exact version — `npx -y -p
npm:@peri-code/hindsight@<version> hindsight …`. Pinning is deliberate: an
unpinned spec resolves `latest` on every invocation, so a later publish would
change what an installed plugin runs without anyone reinstalling anything. A test
asserts that both files, `package.json` and `plugin/.claude-plugin/plugin.json`
all agree on the version, because the failure mode is a plugin that advertises a
release that does not exist.

The `npm:` in front of the name is an alias spec, and it is load-bearing. `npm
exec` matches a `<name>@<version>` spec against the local tree before it looks at
the registry; where that match has no `bin` links — which is exactly the case
when the project you are in *is* this package, as in this repository — npm
installs nothing into its npx cache and puts no `hindsight` on `PATH`, so the
hook dies with `sh: hindsight: command not found`. An aliased spec is not the
name npm matches against the tree, so it resolves from the registry wherever it
runs. Reproduced on npm 10.9.2 and 11.19.1.

There is no build step on the plugin side. `dist/` is a build artifact of the
*npm package* and is not committed; the plugin never reads it.

### Source Modules

Everything under `src/` is bundled by `scripts/build.ts` into a single
`dist/cli.js`.

| Module | Purpose |
|--------|---------|
| `src/cli.ts` | Argument parsing and subcommand dispatch |
| `src/hooks/names.ts` | The hook names the CLI accepts, and the Claude Code event each belongs to |
| `src/lib/client.ts` | Hindsight REST API client (`fetch`) |
| `src/lib/config.ts` | Configuration loader (settings.json + env overrides) |
| `src/lib/daemon.ts` | `hindsight-embed` daemon lifecycle (start/stop/health) |
| `src/lib/bank.ts` | Bank ID derivation + mission management |
| `src/lib/content.ts` | Content processing (transcript parsing, memory formatting, tag stripping) |
| `src/lib/state.ts` | File-based state persistence with `O_EXCL` lock files |
| `src/lib/llm.ts` | LLM provider auto-detection for daemon mode |
| `src/lib/paths.ts` | Config directory resolution |
| `src/lib/version.ts` | Package version, inlined at build time |

### How Recall Works

1. User sends a prompt → `UserPromptSubmit` hook fires
2. Plugin resolves Hindsight API URL (external, local, or auto-start daemon)
3. Derives bank ID (static or dynamic from project context)
4. Composes query from current prompt + optional prior turns
5. Calls Hindsight recall API
6. Formats memories into `<hindsight_memories>` block
7. Outputs via `hookSpecificOutput.additionalContext` — Claude sees it, user doesn't

### How Retain Works

1. Claude responds → `Stop` hook fires (async, non-blocking)
2. Reads conversation transcript from Claude Code's JSONL file
3. Applies chunked retention logic (every N turns with sliding window)
4. Strips `<hindsight_memories>` tags to prevent feedback loops
5. Extracts text from channel messages (Telegram reply tool calls, etc.)
6. POSTs formatted transcript to Hindsight retain API

## Connection Modes

The plugin supports three connection modes, matching the Openclaw plugin:

### 1. External API (recommended for production)

Connect to a running Hindsight server (cloud or self-hosted). No local LLM needed — the server handles fact extraction.

```json
{
  "hindsightApiUrl": "https://your-hindsight-server.com",
  "hindsightApiToken": "your-token"
}
```

### 2. Local Daemon (auto-managed)

The plugin automatically starts and stops `hindsight-embed` via `uvx`. Requires an LLM provider API key for local fact extraction.

```json
{
  "hindsightApiUrl": "",
  "apiPort": 9077
}
```

Set an LLM provider:
```bash
export OPENAI_API_KEY="sk-your-key"      # Auto-detected, uses gpt-4o-mini
# or
export ANTHROPIC_API_KEY="your-key"       # Auto-detected, uses claude-3-5-haiku
```

### 3. Existing Local Server

If you already have `hindsight-embed` running, leave `hindsightApiUrl` empty and set `apiPort` to match your server's port. The plugin will detect it automatically.

## Configuration

All settings live in `~/.hindsight/claude-code.json`. Every setting can also be overridden via environment variables. The plugin ships with sensible defaults — you only need to configure what you want to change.

**Loading order** (later entries win):
1. Built-in defaults (hardcoded in the plugin)
2. Plugin `settings.json` (ships with the plugin, at `CLAUDE_PLUGIN_ROOT/settings.json`)
3. User config (`~/.hindsight/claude-code.json` — recommended for your overrides)
4. Environment variables

Whether layer 2 applies depends on how the CLI was launched. Started from a
source checkout, from the plugin directory, or with `CLAUDE_PLUGIN_ROOT` pointing
at it — Claude Code sets that variable for the MCP server it launches, and whether
it does so for the hooks it spawns is not something this package can observe —
`settings.json` is found beside the plugin; resolved by `npx` out of its cache, it
is not. The built-in defaults and that file hold identical values, asserted by a
test rather than assumed, so whichever of the two applies, the only layer that
changes anything is your own config.

---

### Connection & Daemon

These settings control how the plugin connects to the Hindsight API.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `hindsightApiUrl` | `HINDSIGHT_API_URL` | `null` | URL of an external Hindsight API server. When unset or empty, the plugin uses a local daemon instead. |
| `hindsightApiToken` | `HINDSIGHT_API_TOKEN` | `null` | Authentication token for the external API. Only needed when `hindsightApiUrl` is set. |
| `apiPort` | `HINDSIGHT_API_PORT` | `9077` | Port used by the local `hindsight-embed` daemon. Change this if you run multiple instances or have a port conflict. |
| `embedVersion` | `HINDSIGHT_EMBED_VERSION` | `"latest"` | Which version of `hindsight-embed` to install via `uvx`. Pin to a specific version (e.g. `"0.5.2"`) for reproducibility. |
| `embedPackagePath` | `HINDSIGHT_EMBED_PACKAGE_PATH` | `null` | Local filesystem path to a `hindsight-embed` checkout. When set, the plugin runs from this path instead of installing via `uvx`. Useful for development. |
| `requestTimeoutSeconds` | `HINDSIGHT_REQUEST_TIMEOUT_SECONDS` | `null` | Overrides the per-call request timeout for recall (default `10s`), retain (default `15s`) and knowledge tool calls (`10–15s`). When unset, the per-call defaults are preserved. Bump this when self-hosted Hindsight legitimately takes longer than 10s under contention (e.g. parallel recalls), to avoid client-side `read operation timed out` errors on requests the server completes successfully. Does not affect the health check, which intentionally stays fast (5s). |

---

### LLM Provider (local daemon only)

These settings configure which LLM the local daemon uses for fact extraction. They are **ignored** when connecting to an external API (the server uses its own LLM configuration).

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `llmProvider` | `HINDSIGHT_LLM_PROVIDER` | auto-detect | Which LLM provider to use. Supported values: `openai`, `anthropic`, `gemini`, `groq`, `ollama`, `openai-codex`, `claude-code`. When omitted, the plugin auto-detects by checking for API key env vars in order: `OPENAI_API_KEY` → `ANTHROPIC_API_KEY` → `GEMINI_API_KEY` → `GROQ_API_KEY`. |
| `llmModel` | `HINDSIGHT_LLM_MODEL` | provider default | Override the default model for the chosen provider (e.g. `"gpt-4o"`, `"claude-sonnet-4-20250514"`). When omitted, the Hindsight API picks a sensible default for each provider. |
| `llmApiKeyEnv` | — | provider standard | Name of the environment variable that holds the API key. Normally auto-detected (e.g. `OPENAI_API_KEY` for the `openai` provider). Set this only if your key is in a non-standard env var. |

---

### Memory Bank

A **bank** is an isolated memory store — like a separate "brain." These settings control which bank the plugin reads from and writes to.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `bankId` | `HINDSIGHT_BANK_ID` | `"claude_code"` | The bank ID to use when `dynamicBankId` is `false`. All sessions share this single bank. |
| `bankMission` | `HINDSIGHT_BANK_MISSION` | generic assistant prompt | A short description of the agent's identity and purpose. Sent to Hindsight when creating or updating the bank, and used during recall to contextualize results. |
| `retainMission` | — | extraction prompt | Instructions for the fact extraction LLM — tells it *what* to extract from conversations (e.g. "Extract technical decisions and user preferences"). |
| `dynamicBankId` | `HINDSIGHT_DYNAMIC_BANK_ID` | `false` | When `true`, the plugin derives a unique bank ID from context fields (see `dynamicBankGranularity`), giving each combination its own isolated memory. |
| `dynamicBankGranularity` | — | `["agent", "project"]` | Which context fields to combine when building a dynamic bank ID. Available fields: `agent` (agent name), `project` (working directory), `session` (session ID), `channel` (channel ID), `user` (user ID). |
| `bankIdPrefix` | — | `""` | A string prepended to all bank IDs — both static and dynamic. Useful for namespacing (e.g. `"prod"` or `"staging"`). |
| `agentName` | `HINDSIGHT_AGENT_NAME` | `"claude-code"` | Name used for the `agent` field in dynamic bank ID derivation. |

---

### Auto-Recall

Auto-recall runs on every user prompt. It queries Hindsight for relevant memories and injects them into Claude's context as invisible `additionalContext` (the user doesn't see them in the chat transcript).

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `autoRecall` | `HINDSIGHT_AUTO_RECALL` | `true` | Master switch for auto-recall. Set to `false` to disable memory retrieval entirely. |
| `recallBudget` | `HINDSIGHT_RECALL_BUDGET` | `"mid"` | Controls how hard Hindsight searches for memories. `"low"` = fast, fewer strategies; `"mid"` = balanced; `"high"` = thorough, slower. Affects latency directly. |
| `recallMaxTokens` | `HINDSIGHT_RECALL_MAX_TOKENS` | `1024` | Maximum number of tokens in the recalled memory block. Lower values reduce context usage but may truncate relevant memories. |
| `recallMinScores` | — | `{}` | Optional score floors applied after recall from the main and additional banks, keyed by score field (for example `{"semantic": 0.65, "reranker": 0.2}`). Missing or `null` scores pass so BM25-only and passthrough-reranker hits are not accidentally suppressed. When a cross-encoder reranker is active, the `reranker` floor is the main precision gate; treat reranker scores as query-local and not calibrated across queries. |
| `recallTypes` | — | `["world", "experience", "observation"]` | Which memory types to retrieve. `"world"` = general facts; `"experience"` = personal experiences; `"observation"` = consolidated, deduplicated beliefs built from multiple facts. Defaults to all three, which is also what the API returns when no filter is sent. Narrowing this to `["observation"]` gives deduplicated answers, but note that observations only exist once consolidation has synthesised them — until then (and permanently, if it synthesises none) recall returns nothing for that content. |
| `recallContextTurns` | `HINDSIGHT_RECALL_CONTEXT_TURNS` | `1` | How many prior conversation turns to include when composing the recall query. `1` = only the latest user message; higher values give more context but may dilute the query. |
| `recallMaxQueryChars` | `HINDSIGHT_RECALL_MAX_QUERY_CHARS` | `800` | Maximum character length of the query sent to Hindsight. Longer queries are truncated. |
| `recallRoles` | — | `["user", "assistant"]` | Which message roles to include when building the recall query from prior turns. |
| `recallTags` | `HINDSIGHT_RECALL_TAGS` | `[]` | Optional tags to pass to the recall API, such as `["memory_type:rule"]`. The env var accepts JSON or a comma-separated list. |
| `recallTagsMatch` | `HINDSIGHT_RECALL_TAGS_MATCH` | `"any"` | Tag matching mode used with `recallTags` or `recallTagGroups`: `"any"`, `"all"`, `"any_strict"`, or `"all_strict"`. |
| `recallTagGroups` | `HINDSIGHT_RECALL_TAG_GROUPS` | `null` | Optional compound tag filter passed through to the recall API. The env var must be JSON. |
| `recallAdditionalBankFilters` | `HINDSIGHT_RECALL_ADDITIONAL_BANK_FILTERS` | `{}` | Optional per-bank tag filter overrides for banks listed in `recallAdditionalBanks`, keyed by bank ID. Each value may set `recallTags`, `recallTagsMatch`, and `recallTagGroups`. The env var must be JSON. |
| `recallPromptPreamble` | — | built-in string | Text placed above the recalled memories in the injected context block. Customize this to change how Claude interprets the memories. |

---

### Auto-Retain

Auto-retain runs after Claude responds. It extracts the conversation transcript and sends it to Hindsight for long-term storage and fact extraction.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `autoRetain` | `HINDSIGHT_AUTO_RETAIN` | `true` | Master switch for auto-retain. Set to `false` to disable memory storage entirely. |
| `retainMode` | `HINDSIGHT_RETAIN_MODE` | `"full-session"` | Retention strategy. `"full-session"` sends the initial transcript once, then only new messages in chunk documents; compaction starts a fresh chunk. |
| `retainEveryNTurns` | — | `10` | How often to retain. `1` = every turn; `10` = every 10th turn. Higher values reduce API calls but delay memory capture. Values > 1 enable **chunked retention** with a sliding window. |
| `retainOverlapTurns` | — | `2` | When chunked retention fires, this many extra turns from the previous chunk are included for continuity. Total window size = `retainEveryNTurns + retainOverlapTurns`. |
| `retainRoles` | — | `["user", "assistant"]` | Which message roles to include in the retained transcript. |
| `retainToolCalls` | — | `true` | Whether to include tool calls (function invocations and results) in the retained transcript. Captures structured actions like file reads, searches, and code edits. |
| `retainTags` | — | `["{session_id}"]` | Tags attached to the retained document. Supports template placeholders: `{session_id}`, `{bank_id}`, `{timestamp}`, and `{user_id}` (resolved from `HINDSIGHT_USER_ID` env var; empty string if unset). Tags whose resolved form ends in an empty namespace part (e.g. `"user:"` when `HINDSIGHT_USER_ID` is unset) are dropped from the outgoing request. See [Template variables](#template-variables-for-retaintags-and-retainmetadata) below. |
| `retainMetadata` | — | `{}` | Arbitrary key-value metadata attached to the retained document. Same template placeholders as `retainTags`. |
| `retainContext` | — | `"claude-code"` | A label attached to retained memories identifying their source. Useful when multiple integrations write to the same bank. |

#### Template variables for `retainTags` and `retainMetadata`

| Variable | Source |
|----------|--------|
| `{session_id}` | Current Claude Code session ID |
| `{bank_id}` | Resolved bank ID (per `bankGranularity`) |
| `{timestamp}` | ISO 8601 UTC at retain time |
| `{user_id}` | Value of `HINDSIGHT_USER_ID` env var (empty string if unset) |

##### Example: per-user memory scoping

```json
{
  "retainTags": ["user:{user_id}", "session:{session_id}"]
}
```

Set `HINDSIGHT_USER_ID=<opaque-user-id>` in your shell profile (`.zshrc`,
`.bashrc`, etc.). If the env var is unset, the `user:` tag is dropped from the
outgoing retain request and the rest of the tags are sent as-is — so the same
`settings.json` works across machines whether you've set the env var or not.

Downstream, `recall` can filter by `tags=["user:alice"]` to isolate memories
authored by a specific user from a shared bank.

---

### Knowledge Tools

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `enableKnowledgeTools` | `HINDSIGHT_ENABLE_KNOWLEDGE_TOOLS` | `true` | Enable the MCP server with `agent_knowledge_*` tools (knowledge page management, memory search, document ingestion). Set to `false` to register no tools — the MCP server stays alive as an empty server (it does not exit, which would otherwise trigger a `-32000` reconnect error). |

---

### Debug

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `debug` | `HINDSIGHT_DEBUG` | `false` | Enable verbose logging to stderr. All log lines are prefixed with `[Hindsight]`. Useful for diagnosing connection issues, recall/retain behavior, and bank ID derivation. |

## Claude Code Channels

With [Claude Code Channels](https://docs.anthropic.com/en/docs/claude-code), Claude Code can operate as a persistent background agent connected to Telegram, Discord, Slack, and other messaging platforms. This plugin gives Channel-based agents the same long-term memory that `hindsight-openclaw` provides for Openclaw agents.

For Channel agents, set these environment variables in your Channel configuration:

```bash
# Per-channel/per-user memory isolation
export HINDSIGHT_CHANNEL_ID="telegram-group-12345"
export HINDSIGHT_USER_ID="user-67890"
```

And enable dynamic bank IDs:

```json
{
  "dynamicBankId": true,
  "dynamicBankGranularity": ["agent", "channel", "user"]
}
```

## Troubleshooting

### Plugin not activating

- Verify installation: check that `.claude-plugin/plugin.json` exists in the installed plugin directory
- Check that `npx --version` works: every hook and the MCP server shell out to it
- Check Claude Code logs for `[Hindsight]` messages (enable `"debug": true` in `~/.hindsight/claude-code.json`)

### Hooks fail with "command not found"

The plugin runs `npx -y -p npm:@peri-code/hindsight@<version> …`, so `npx`
must be on the `PATH` of whatever process Claude Code was started from. GUI
launches (especially on macOS) often inherit a `PATH` that omits a version
manager's shims. Run `npx --version` in the same environment to confirm.

If the machine has no network access the first time a hook runs, `npx` cannot
download the pinned release and that hook fails: nothing is recalled or retained
until one download succeeds, after which the package is in the npx cache and the
plugin works offline.

### Recall returning no memories

- Verify the Hindsight server is reachable: `curl http://localhost:9077/health`
- Check that the bank has retained content: memories need at least one retain cycle
- Try increasing `recallBudget` to `"mid"` or `"high"`

### Daemon not starting

- Ensure `uvx` is installed: `pip install uv` or `brew install uv`
- Check that an LLM API key is set (required for local daemon)
- Review daemon logs: `tail -f ~/.hindsight/profiles/claude-code.log`
- Try starting manually: `uvx hindsight-embed@latest daemon --profile claude-code start`

### High latency on recall

- The recall hook has a 45-second timeout. If Hindsight is slow:
  - Use `recallBudget: "low"` (fewer retrieval strategies)
  - Reduce `recallMaxTokens`
  - Consider using an external API with a faster server
- Remember that every hook pays `npx`'s startup cost on top of the request
  itself. It is small once the package is cached, but it is not zero.

### State file issues

- State is stored in `$CLAUDE_PLUGIN_DATA/state/`
- To reset: delete the `state/` directory
- Turn counts, bank missions, and daemon state are tracked here

## Development

The CLI is TypeScript, bundled with [Bun](https://bun.sh) and run on Node.js 20+.
The plugin in `plugin/` is plain JSON — no build, no dependencies — so a change
there takes effect on the next session.

```bash
bun install        # Install tooling (Bun, TypeScript, Vitest, Biome)
bun run build      # Bundle src/ → dist/cli.js  (required: dist/ is not committed)
bun run typecheck  # tsc --noEmit
bun run lint       # Biome lint + format check
bun run test       # Vitest
bun run verify     # All of the above, in order
```

`scripts/build.ts` bundles every module into **one self-contained file** at
`dist/cli.js` — no `node_modules` resolution at runtime, because npx runs that
file directly out of its cache. The build also inlines the version from
`package.json` and refuses to finish if the shebang went missing. `bun run build`
must be re-run after any source change.

Try a change without publishing:

```bash
bun run build
node dist/cli.js hook recall < hook-input.json
node dist/cli.js --help

# Or exercise the npx path the plugin actually uses, against the change you just
# built. The tarball, not the registry spec: an unaliased `<name>@<version>` spec
# is matched against the local tree first, and this repository's package.json
# carries exactly the name and version the plugin pins — so from here that spec
# resolves to the working tree, links no `bin`, and fails with `command not found`
# rather than proving anything. This is why `hooks.json` and `.mcp.json` pin the
# package behind an `npm:` alias instead.
npm pack --pack-destination /tmp
npx -y -p /tmp/peri-code-hindsight-*.tgz hindsight --version
```

`tests/npx.test.ts` does the same thing on every test run, against a tarball it
packs itself, which is why the recipe above is only for poking at a change by hand.

The test suite lives in `tests/` and runs on Vitest. It was ported 1:1 from the
plugin's original pytest suite (see the git history for the pre-migration
sources), including the end-to-end hook tests that drive stdin/stdout and a
mocked `fetch`. `tests/cli.test.ts` and `tests/mcp-server.test.ts` run the real
build artifact, so `bun run build` has to happen first — which is why `verify`
builds before it tests.

### Releasing

`package.json` and `plugin/.claude-plugin/plugin.json` must carry the same
version, and both `plugin/hooks/hooks.json` and `plugin/.mcp.json` must pin it.
`tests/manifest.test.ts` enforces every one of those, so a bumped version that was
not propagated fails CI rather than publishing a plugin that installs nothing.

```bash
# after bumping both manifests and the two npx pins
git tag v0.8.0 && git push origin v0.8.0
```

`.github/workflows/publish.yml` then verifies, packages and publishes to npm.
It needs an `NPM_TOKEN` repository secret with publish rights on the
`@peri-code` scope.

To test local changes to `hindsight-embed`:

```json
{
  "embedPackagePath": "/path/to/hindsight-embed"
}
```

The plugin will use `uv run --directory <path> hindsight-embed` instead of `uvx hindsight-embed@latest`.

To view daemon logs:

```bash
# Check daemon status
uvx hindsight-embed@latest daemon --profile claude-code status

# View logs
tail -f ~/.hindsight/profiles/claude-code.log

# List profiles
uvx hindsight-embed@latest profile list
```

## Links

- [Hindsight Documentation](https://vectorize.io/hindsight)
- [Claude Code Documentation](https://docs.anthropic.com/en/docs/claude-code)
- [GitHub Repository](https://github.com/KonghaYao/hindsight-plugin)

## License

MIT
