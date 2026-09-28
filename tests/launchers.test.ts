/**
 * Tests for the Node launchers that replaced `scripts/run_mcp.sh`.
 *
 * The Python suite (`tests/test_run_mcp.py`) tested the bash launcher that
 * created a venv, pip-installed the dependencies and then `exec`'d the MCP
 * server. It guaranteed three things:
 *
 *   1. the interpreter is found in every venv layout the plugin can run on,
 *   2. a venv missing the API the server imports is repaired (re-pip) while a
 *      healthy venv is exec'd as-is,
 *   3. the server never runs from Claude Code's project cwd.
 *
 * The venv is gone — the plugin now ships self-contained ESM bundles that plain
 * `node` executes — so (1) and (2) have no successor code, and the "missing
 * dependency" case is now "`dist/` was never built", which
 * `scripts/run-mcp.mjs` / `scripts/run-hook.mjs` turn into an actionable
 * message. (3) survives in a new shape: the launcher no longer chdirs anywhere,
 * it captures the project cwd into `HINDSIGHT_MCP_PROJECT_CWD` before handing
 * off, and the MCP server derives its default bank from it.
 *
 * Both launchers are standalone scripts, not importable modules, so every case
 * below runs the real file with `spawnSync` against a fabricated plugin root
 * and asserts on exit status, stderr and the side effects of the entry point the
 * launcher picked.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnvSandbox, type EnvSandbox } from './helpers';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_MCP = join(PACKAGE_ROOT, 'scripts', 'run-mcp.mjs');
const RUN_HOOK = join(PACKAGE_ROOT, 'scripts', 'run-hook.mjs');

/** `process.env` with every `undefined` dropped — `spawnSync` only takes strings. */
function stringEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/** Run a launcher the way Claude Code does: `process.execPath <script> [hook]`. */
function runLauncher(
  script: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...stringEnv(), ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let sandbox: EnvSandbox;

beforeEach(() => {
  sandbox = createEnvSandbox();
});

afterEach(() => {
  sandbox.restore();
});

/**
 * Create a throwaway plugin root whose `dist/` this test controls.
 *
 * The real bundle can't be used to observe the hand-off (it starts a server and
 * speaks stdio), so each case writes a tiny entry that records what it was
 * given.
 */
function makePluginRoot(): string {
  const root = join(sandbox.root, 'fake-plugin');
  mkdirSync(root, { recursive: true });
  // The shipping plugin root is `"type": "module"`; the bundled `dist/**/*.js`
  // entries rely on that to load as ESM.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  return root;
}

/** Write `<root>/dist/<relative>` as ESM and return its absolute path. */
function writeEntry(root: string, relative: string, source: string): string {
  const path = join(root, 'dist', relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

describe('scripts/run-mcp.mjs', () => {
  it('exits 1 with the build instructions when dist/mcp/server.js is missing', () => {
    const result = runLauncher(RUN_MCP, [], { CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot });

    // Silence here would hang the MCP client forever: a server that starts and
    // never answers `initialize` is worse than one that refuses to start.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(sandbox.pluginRoot, 'dist', 'mcp', 'server.js'));
    expect(result.stderr).toContain('has not been built');
    expect(result.stderr).toContain('bun run build');
  });

  it('loads the bundled server and passes it the launcher project cwd', () => {
    const root = makePluginRoot();
    const log = join(sandbox.root, 'mcp-entry.json');
    writeEntry(
      root,
      join('mcp', 'server.js'),
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(log)}, JSON.stringify({`,
        '  projectCwd: process.env.HINDSIGHT_MCP_PROJECT_CWD ?? null,',
        '  serverCwd: process.cwd(),',
        '}));',
      ].join('\n'),
    );

    const project = join(sandbox.root, 'project');
    mkdirSync(project, { recursive: true });

    const result = runLauncher(RUN_MCP, [], { CLAUDE_PLUGIN_ROOT: root }, project);

    expect(result.status).toBe(0);
    const recorded = JSON.parse(readFileSync(log, 'utf8')) as {
      projectCwd: string | null;
      serverCwd: string;
    };
    // `HINDSIGHT_MCP_PROJECT_CWD` was unset, so the launcher captures the cwd it
    // was started from — the session's project directory — before anything else
    // can change it. The server derives its default bank from it.
    expect(recorded.projectCwd).toBe(realpathSync(project));
    // Nothing chdirs any more: the old launcher ran the server from the plugin
    // data dir to keep FastMCP from probing the project's `.env`.
    expect(recorded.serverCwd).toBe(realpathSync(project));
  });

  it('does not overwrite an existing HINDSIGHT_MCP_PROJECT_CWD', () => {
    const root = makePluginRoot();
    const log = join(sandbox.root, 'mcp-entry.json');
    writeEntry(
      root,
      join('mcp', 'server.js'),
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(log)}, process.env.HINDSIGHT_MCP_PROJECT_CWD ?? 'unset');`,
      ].join('\n'),
    );

    const project = join(sandbox.root, 'project');
    mkdirSync(project, { recursive: true });

    // An inherited value is the user's explicit choice (e.g. a wrapper script or
    // an agent that runs several projects from one process).
    const result = runLauncher(
      RUN_MCP,
      [],
      { CLAUDE_PLUGIN_ROOT: root, HINDSIGHT_MCP_PROJECT_CWD: '/srv/pinned-project' },
      project,
    );

    expect(result.status).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('/srv/pinned-project');
  });
});

/** An ESM entry that appends one line to `log` for each exported hook name. */
function hookEntrySource(log: string, exported: string[]): string {
  const lines = ["import { appendFileSync } from 'node:fs';"];
  for (const name of exported) {
    lines.push(
      `export async function ${name}() { appendFileSync(${JSON.stringify(log)}, '${name}\\n'); }`,
    );
  }
  if (exported.length === 0) {
    lines.push('export const notAHook = true;');
  }
  return lines.join('\n');
}

describe('scripts/run-hook.mjs', () => {
  it('exits 0 with a usage message when the hook name is missing', () => {
    const result = runLauncher(RUN_HOOK, [], { CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('missing hook name');
  });

  it('exits 0 with the build instructions when the hook entry is missing', () => {
    const result = runLauncher(RUN_HOOK, ['recall'], { CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot });

    // Hooks must never block the user's session, so a stale checkout degrades to
    // a message and a zero exit rather than a module-resolution stack trace.
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(join(sandbox.pluginRoot, 'dist', 'hooks', 'recall.js'));
    expect(result.stderr).toContain('has not been built');
    expect(result.stderr).toContain('bun run build');
  });

  it('calls the run() exported by the hook entry', () => {
    const root = makePluginRoot();
    const log = join(sandbox.root, 'hook.log');
    writeEntry(root, join('hooks', 'echo.js'), hookEntrySource(log, ['run']));

    const result = runLauncher(RUN_HOOK, ['echo'], { CLAUDE_PLUGIN_ROOT: root });

    expect(result.status).toBe(0);
    // Importing a hook bundle deliberately does not start it, so the recorded
    // line proves the launcher invoked `run()` rather than relying on the import.
    expect(readFileSync(log, 'utf8')).toBe('run\n');
  });

  it('prefers run() over main()', () => {
    const root = makePluginRoot();
    const log = join(sandbox.root, 'hook.log');
    writeEntry(root, join('hooks', 'echo.js'), hookEntrySource(log, ['run', 'main']));

    const result = runLauncher(RUN_HOOK, ['echo'], { CLAUDE_PLUGIN_ROOT: root });

    expect(result.status).toBe(0);
    // `run` carries the hook's own error handling and exit-code semantics;
    // `main` is the raw body other hooks import.
    expect(readFileSync(log, 'utf8')).toBe('run\n');
  });

  it('falls back to main() when run() is not exported', () => {
    const root = makePluginRoot();
    const log = join(sandbox.root, 'hook.log');
    writeEntry(root, join('hooks', 'echo.js'), hookEntrySource(log, ['main']));

    const result = runLauncher(RUN_HOOK, ['echo'], { CLAUDE_PLUGIN_ROOT: root });

    expect(result.status).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('main\n');
  });

  it('exits 0 with a message when the entry exports neither run() nor main()', () => {
    const root = makePluginRoot();
    const log = join(sandbox.root, 'hook.log');
    writeEntry(root, join('hooks', 'echo.js'), hookEntrySource(log, []));

    const result = runLauncher(RUN_HOOK, ['echo'], { CLAUDE_PLUGIN_ROOT: root });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('exports neither run() nor main()');
  });
});
