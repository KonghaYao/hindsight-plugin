# Changelog

## [0.10.0]

### Added

- **Peri session backend.** Peri runs the same hooks but stores conversations in
  `~/.peri/threads/threads.db` instead of a Claude Code JSONL transcript, so
  `transcript_path` arrives empty. Retain, SessionEnd and multi-turn recall now
  read the active thread from that local store (override with `PERI_DB_PATH`),
  read-only, using Node's built-in `node:sqlite` (Node ≥ 22.13) or Bun's
  `bun:sqlite`. Rows are role-filtered in SQL (`excluded=1` and
  `system_reminder` skipped) and each hook reads at most the newest 2000 messages
  for retain (500 for multi-turn recall), while the checkpoint still advances by
  the full thread count. Missing, locked or corrupt stores are logged and
  skipped. Remote Peri session stores are out of scope.

### Compatibility

- The Peri backend requires Node.js ≥ 22.13 (built-in `node:sqlite`) or Bun. On
  older Node.js the Claude Code path is unchanged and the Peri source is skipped
  with a diagnostic.

## [0.9.0]

### Added

- **A per-workspace configuration layer.** `HINDSIGHT_CONFIG` names a JSON file
  whose keys are the settings above, and it sits on top of every other layer: it
  overrides the built-in defaults, both `settings.json` files and every
  `HINDSIGHT_*` environment variable. It exists for platforms that manage a
  workspace's configuration on the user's behalf — the file is written per
  workspace and the variable points at it — and it borrows upstream Hindsight's
  own variable name rather than inventing a second convention such a platform
  would have to learn. The variable holds an **absolute** path, because
  `loadConfig()` runs at module top level, before any cwd is known: a path needs
  no cwd, so a hook and the MCP server of one host, inheriting one environment,
  read the same file. A value that is not an absolute path is treated as unset
  rather than resolved against the process's working directory, which is not the
  workspace — skipping the layer beats reading an arbitrary file. A missing or
  unreadable file, invalid JSON and a top level that is not an object are
  likewise ignored and the layers below stand; a `null` value means "unset" and
  overrides nothing.
- The `managed` block such a file carries — `writer`, `workspaceRoot`,
  `writtenAt` — is metadata about the file rather than a setting, and is dropped
  at the merge. `PluginConfig` has an index signature, so without that it would
  spread into everything downstream that reads arbitrary keys.

## [0.8.0]

### Added

- **`@peri-code/hindsight`, a standalone CLI.** The hooks and the MCP server are
  now subcommands of one executable — `hindsight hook <name>`, `hindsight mcp` —
  published to npm as a single self-contained ESM file with **no runtime
  dependencies**. The packaged tarball is `dist/cli.js` plus the README, licence
  and changelog.
- `plugin/` holds the Claude Code plugin: `.claude-plugin/plugin.json`,
  `hooks/hooks.json`, `.mcp.json` and `settings.json`, and nothing else. It ships
  no code and needs no build step, so installing it is enough to start using it.
- `.claude-plugin/marketplace.json`, which makes the repository installable —
  `claude plugin marketplace add <repo>` reads that file from the root and
  resolves the one plugin entry it lists to `plugin/`. There was no marketplace
  manifest before, so the repository could not be added as one at all.
- **The invocation form the plugin actually uses is now exercised, in the suite
  and after every publish.** `tests/npx.test.ts` packs the package and runs
  `npx -y -p <tarball> hindsight …` from a temporary directory with an npm cache of
  its own, so the package name, the `bin` link, the executable bit and the exit
  code are checked the way a user's machine checks them rather than through
  `node dist/cli.js`. `publish.yml` then resolves
  `@peri-code/hindsight@<version>` from outside the checkout and fails the release
  if it does not: the registry is the one part of this no local test can see, and
  a plugin pinning a version that never arrived fails on every hook with E404.
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
  `.mcp.json` invoke `npx -y -p npm:@peri-code/hindsight@<version> hindsight …`
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
- **The built-in defaults are now the values `plugin/settings.json` ships.** Which
  of the two a hook reads depends on how the CLI was started — `npx` resolves it
  from a cache directory with no plugin beside it, while a source checkout and a
  `CLAUDE_PLUGIN_ROOT` launch find the file — so the same setting could resolve two
  ways depending on nothing the user did. The two had drifted: `retainTags` was
  `["{session_id}"]` in the file and `[]` in code, both
  missions were set in the file and empty in code, and `bankId` was `claude_code`
  in the file but `claude-code` in the code's fallback — so whether a memory
  carried the tag recall filters on, and which bank it landed in, depended on
  which copy of the defaults you got. A test now asserts the two are identical
  rather than merely compatible.
- An empty `bankId` resolves to the shipped default instead of to a second
  constant with a different spelling.
- The `session-start` hook's timeout is 30s rather than 5s. The health check it
  runs is still capped at 5s; the budget is now sized for the cold path, because
  the first invocation of that hook is also the first `npx`, which has to download
  and unpack the package. At 5s it was killed mid-install, handing the same
  download to the first prompt.
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
- `bun run verify` ran the tests before the build, but the CLI and MCP suites
  spawn `dist/cli.js` and throw when it is absent, so the script failed on a clean
  checkout. It now builds first, matching CI.
- `hindsight hook recall` and `hindsight hook retain` no longer exit 2 when an
  unexpected error escapes with `debug` on. Exit 2 is Claude Code's blocking code:
  on `UserPromptSubmit` it rejects the prompt, so the setting the README
  recommends for troubleshooting turned any bug in the hook into the user losing
  the message they had just typed. Debug mode still surfaces the failure — as exit
  1, a non-blocking error whose stderr is shown.
- The published tarball no longer carries `dist/cli.js.map`. `files` listed the
  whole `dist/` directory, so a 2 MB source map went to every `npx` user; the
  packed tarball drops from 557 kB to 174 kB. The first entry above has described
  the tarball as `dist/cli.js` plus docs since it was written — the file list now
  matches it.
- **The plugin's hooks now work inside this repository.** `hooks.json` and
  `.mcp.json` pinned the plain spec `@peri-code/hindsight@<version>`, and `npm
  exec` matches a `<name>@<version>` spec against the local tree before it looks
  at the registry. In this repository the local tree *is* that package, with no
  `bin` links, so npm installed nothing into its npx cache and ran a `hindsight`
  that was not on `PATH`: `sh: hindsight: command not found`, exit 127, which
  Claude Code reports as a hook error on session start and on every prompt — no
  recall, no retain, for anyone working on the plugin. Both files now pin
  `npm:@peri-code/hindsight@<version>`. An aliased spec is not the name npm
  matches against the tree, so it always resolves from the registry. Reproduced
  on npm 10.9.2 and 11.19.1. This is a plugin-manifest change: the npm package is
  unchanged, so no new version was published for it.

### Removed

- **The deprecation notice printed at every session start.** It announced that the
  plugin was superseded by the Coding Agents plugin and linked the migration guide.
  This package is published under its own name and continues the plugin, so a
  message at startup telling every user to move elsewhere was the opposite of what
  the release is for. The `upgradeNotice` setting is gone with it, and
  `hindsight hook session-start` no longer writes to stdout at all — it verifies
  the server is reachable before the first prompt and pre-starts the local daemon.
- **`hindsight setup`** — and `scripts/setup_hooks.py` before it. It wrote the four
  hooks into `~/.claude/settings.json`. The plugin declares the same four in its own
  `hooks/hooks.json`, which Claude Code reads the way it reads the plugin's
  `.mcp.json` — the MCP server declared there is launched for an installed plugin —
  so the command's only possible effect was to register every hook twice, once per
  source. `hindsight setup` now exits 1 as an unknown command.

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
