# Changelog

## [0.8.0]

### Added

- **`@peri-code/hindsight`, a standalone CLI.** The hooks, the MCP server and the
  hook-registration step are now subcommands of one executable —
  `hindsight hook <name>`, `hindsight mcp`, `hindsight setup` — published to npm
  as a single self-contained ESM file with **no runtime dependencies**. The
  packaged tarball is `dist/cli.js` plus the README, licence and changelog.
- `plugin/` holds the Claude Code plugin: `.claude-plugin/plugin.json`,
  `hooks/hooks.json`, `.mcp.json` and `settings.json`, and nothing else. It ships
  no code and needs no build step, so installing it is enough to start using it.
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

- **The plugin now drives the CLI through `npx`.** `hooks/hooks.json` and
  `.mcp.json` invoke `npx -y -p @peri-code/hindsight@<version> hindsight …`
  instead of `node "${CLAUDE_PLUGIN_ROOT}/dist/…"`, and the two committed
  launchers (`scripts/run-hook.mjs`, `scripts/run-mcp.mjs`) are gone along with
  the build-the-checkout step they existed to diagnose. The version is pinned in
  both files rather than resolved as `latest`, so a later publish cannot change
  what an installed plugin runs; `tests/manifest.test.ts` asserts both pins,
  `package.json` and `plugin/.claude-plugin/plugin.json` all carry the same
  version.
- **Rewritten in TypeScript.** The plugin was Python; it is now a TypeScript
  project built with Bun and run on Node.js 20+. Behaviour is unchanged: the
  hooks, the MCP tool surface (`agent_knowledge_*`, same nine tools and parameter
  names), configuration keys, state file formats and on-disk layouts are
  identical, and the Vitest suite was ported 1:1 from the pytest suite. Python is
  no longer required (the local daemon still uses `uvx hindsight-embed`, an
  external tool).
- The package version is inlined at build time instead of read from
  `.claude-plugin/plugin.json`. That manifest does not exist next to the code
  when npx runs it from its cache, so the MCP server used to report `0.0.0` there
  and the `User-Agent` carried it on every request. The string sent to the
  Hindsight API is unchanged (`hindsight-claude-code/<version>`).
- `plugin/settings.json` now lists every configuration key. Three —
  `recallAdditionalBanks`, `requestTimeoutSeconds`, `agentName` — were settable
  but absent from the file, which doubles as the reference for what can be
  configured. A test fails if a key is added to one and not the other.
- **The built-in defaults are now the values `plugin/settings.json` ships.** Under
  npx the CLI runs from npm's cache, where no `settings.json` sits next to it, so
  the built-ins are the entire configuration for an npx-run hook; the shipped file
  is what a source checkout and the `CLAUDE_PLUGIN_ROOT` layout read. The two had
  drifted: `retainTags` was `["{session_id}"]` in the file and `[]` in code, both
  missions were set in the file and empty in code, and `bankId` was `claude_code`
  in the file but `claude-code` in the code's fallback — so whether a memory
  carried the tag recall filters on, and which bank it landed in, depended on
  which copy of the defaults you got. A test now asserts the two are identical
  rather than merely compatible.
- An empty `bankId` resolves to the shipped default instead of to a second
  constant with a different spelling.
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
