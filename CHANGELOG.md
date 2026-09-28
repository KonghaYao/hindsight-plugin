# Changelog

## [Unreleased]

### Added

- `{user_id}` template variable for `retainTags` and `retainMetadata`, resolved
  from the `HINDSIGHT_USER_ID` env var (empty string if unset). Enables
  machine-independent per-user memory scoping without hardcoding user ids in
  `settings.json`.
- `requestTimeoutSeconds` config (env: `HINDSIGHT_REQUEST_TIMEOUT_SECONDS`) to
  override the per-call HTTP timeout used by recall (10s), retain (15s) and the
  knowledge MCP tools. Defaults to `null`, which preserves current per-call
  behavior. Set this when self-hosted Hindsight legitimately takes longer than
  10s under contention (e.g. parallel recalls) so the client doesn't surface
  `read operation timed out` on requests the server completes successfully.
  Does not affect the health check, which stays at 5s. Fixes #1575.

### Changed

- **Rewritten in TypeScript.** The plugin was Python; it is now a TypeScript
  project built with Bun and run on Node.js 20+. `bun run build` bundles every
  entry point into a self-contained ESM file under `dist/`, which is **not
  committed** — build the checkout once after installing (see the README).
  Behaviour is unchanged: the hooks, the MCP tool surface (`agent_knowledge_*`,
  same nine tools and parameter names), configuration keys, state file formats
  and on-disk layouts are identical, and the 228-case Vitest suite was ported
  1:1 from the pytest suite. Hooks and the MCP server now run via
  `node dist/...` instead of `python3 scripts/...`; `hooks/hooks.json` and
  `.mcp.json` invoke the committed launchers `scripts/run-hook.mjs` and
  `scripts/run-mcp.mjs`, which report an actionable message when the plugin has
  not been built yet. Python is no longer required (the local daemon still uses
  `uvx hindsight-embed`, an external tool).
- Tags that resolve to an empty namespace content (e.g. `"user:"` when
  `HINDSIGHT_USER_ID` is unset) are now dropped from retain requests. Previously
  such tags were sent as-is. Tags without `:` are unaffected.

### Fixed

- **Recall no longer misses most of what was retained.** `recallTypes` defaulted
  to `["observation"]` alone, excluding `world` and `experience` — the two types
  the API returns when no filter is sent, and the only ones that exist right
  after a retain. Measured against a live server, a retain followed by a recall
  returned 0 of the 3 stored memories until consolidation synthesised
  observations (17–62s in practice), and on one run consolidation completed
  having produced none at all, leaving that content unreachable through
  auto-recall for good. The default is now all three types, which returns the
  same set as sending no filter. Set `recallTypes` explicitly to narrow it.
- `agent_knowledge_recall` now honours `recallTypes` instead of always sending
  no filter, so one setting governs every recall the plugin performs and the
  auto-recall hook can no longer be narrowed without the MCP tool following.
  With the new default this changes nothing; it only bites when `recallTypes` is
  set.
- `agent_knowledge_ingest_file` and `agent_knowledge_update_page` returned
  failures ("file not found", "file is empty", "provide name or source_query")
  as ordinary tool results with no `isError`, so an MCP client could not tell
  the call had failed — while other tools such as `agent_knowledge_get_page`
  already reported failures as tool errors. Both now set `isError`; the JSON
  payload is unchanged.
- `bun run verify` ran the tests before the build, but `mcp-server.test.ts`
  spawns `dist/mcp/server.js` and throws when it is absent, so the script failed
  on a clean checkout. It now builds first, matching CI.

## [0.1.0] - 2025-03-23

### Added
- Initial release: Claude Code plugin for Hindsight long-term memory
- Auto-recall on every user prompt via `UserPromptSubmit` hook — injects relevant memories as `additionalContext`
- Auto-retain after every response via async `Stop` hook — extracts and stores conversation transcript
- Session lifecycle hooks (`SessionStart` health check, `SessionEnd` daemon cleanup)
- Three connection modes: external API, auto-managed local daemon (`uvx hindsight-embed`), existing local server
- Dynamic bank IDs with configurable granularity (`agent`, `project`, `session`, `channel`, `user`)
- Channel-agnostic: works with Claude Code Channels (Telegram, Discord, Slack) and interactive sessions
- Zero pip dependencies — pure Python stdlib (`urllib`, `fcntl`, `subprocess`)
- 34 configuration options via `settings.json` with env var overrides
- LLM auto-detection from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`
- Chunked retention with sliding window (`retainEveryNTurns` + `retainOverlapTurns`)
- Memory tag stripping to prevent retain feedback loops
