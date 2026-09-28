#!/usr/bin/env node
/**
 * MCP server launcher.
 *
 * Claude Code starts MCP servers from the session's project directory, and the
 * server needs that directory to derive the memory bank ID. Capture it here,
 * before anything else can change the working directory, then hand off to the
 * bundled server.
 *
 * The build check fails the process on purpose: an MCP server that starts and
 * then never answers `initialize` leaves the client waiting, so exiting non-zero
 * is the only way to surface "you forgot to build" to the user.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || dirname(scriptsDir);

async function main() {
  // Only an *unset* variable falls back to the cwd, matching the Python
  // original's `os.environ.get("HINDSIGHT_MCP_PROJECT_CWD", os.getcwd())`.
  process.env.HINDSIGHT_MCP_PROJECT_CWD ??= process.cwd();

  const entry = join(pluginRoot, 'dist', 'mcp', 'server.js');
  if (!existsSync(entry)) {
    // No `process.exit()`: stderr is asynchronous on a pipe and exiting now can
    // truncate the message. The exit code carries the failure instead.
    process.exitCode = 1;
    console.error(
      `[Hindsight MCP] ${entry} not found — the plugin has not been built.\n` +
        `[Hindsight MCP] Build it once: cd "${pluginRoot}" && bun install && bun run build`,
    );
    return;
  }

  await import(pathToFileURL(entry).href);
}

await main();
