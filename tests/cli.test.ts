/**
 * Tests for the published CLI (`dist/cli.js`) and the `bin` entry that exposes it.
 *
 * Supersedes `tests/launchers.test.ts`, which tested the two committed Node
 * launchers that used to sit between Claude Code and the bundles in `dist/`.
 * Those existed to turn "you forgot to build" into an actionable message; the
 * CLI is now the only entry point, so what is left to check is that it
 * dispatches, reports usage errors without blocking a session, and that the
 * file npm publishes is the file the tests exercise.
 *
 * Every case runs the real build artifact through `process.execPath`, because
 * the shebang, the executable bit and the dependency inlining only exist there.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_NAMES } from '../src/hooks/names';
import { PACKAGE_NAME, VERSION } from '../src/lib/version';
import { createEnvSandbox, type EnvSandbox } from './helpers';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(PACKAGE_ROOT, 'dist', 'cli.js');

const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  bin: Record<string, string>;
};

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

/** Run the CLI the way the plugin does: `node dist/cli.js <args…>`. */
function runCli(
  args: string[],
  options: { env?: Record<string, string>; input?: string; cwd?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd,
    input: options.input,
    env: { ...stringEnv(), ...options.env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let sandbox: EnvSandbox;

beforeEach(() => {
  if (!existsSync(CLI)) {
    throw new Error(`${CLI} is missing — run \`bun run build\` before this suite.`);
  }
  sandbox = createEnvSandbox();
});

afterEach(() => {
  sandbox.restore();
});

describe('bin entry', () => {
  it('points at a file the build produced', () => {
    // npm links `bin` by path; a stale path publishes a package that installs
    // and then cannot be run.
    expect(Object.keys(pkg.bin)).toEqual(['hindsight']);
    expect(existsSync(join(PACKAGE_ROOT, pkg.bin.hindsight ?? ''))).toBe(true);
  });

  it('starts with a shebang and is executable', () => {
    const source = readFileSync(CLI, 'utf8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
    // npm's Windows shim and `./dist/cli.js` both rely on the bit the build sets.
    expect(statSync(CLI).mode & 0o111).not.toBe(0);
  });

  it('resolves nothing from node_modules at runtime', () => {
    // The package publishes `dist/cli.js` and nothing else, so a bare specifier
    // left in the bundle would only fail on a user's machine, at first prompt.
    //
    // Scanned for `require(…)` and `import(…)` as well as static `from`, because a
    // dependency emitting one of those inside a string is invisible to a regex
    // anchored on line-starting imports — and that is how the five specifiers
    // below got in.
    const source = readFileSync(CLI, 'utf8');
    const specifiers = [
      ...source.matchAll(/\bfrom\s*"([^"]+)"/g),
      ...source.matchAll(/\brequire\(\s*"([^"]+)"\s*\)/g),
      ...source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
    ]
      .map((match) => match[1] ?? '')
      .filter((specifier) => !specifier.startsWith('node:'));
    expect([...new Set(specifiers)].sort()).toEqual([
      // ajv's code generator writes `require` calls for its own runtime helpers
      // into the validators it emits; they execute only if a schema is compiled at
      // runtime, and the one such call site in the bundled SDK is elicitation form
      // validation, which no tool here reaches (the MCP end-to-end suite covers
      // every tool). Listed rather than tolerated so that a second dependency
      // arriving the same way is a failing test instead of a broken session.
      'ajv-formats/dist/formats',
      'ajv/dist/runtime/equal',
      'ajv/dist/runtime/ucs2length',
      'ajv/dist/runtime/uri',
      'ajv/dist/runtime/validation_error',
    ]);
  });
});

describe('hindsight --version', () => {
  it('reports the version the build inlined', () => {
    const { status, stdout } = runCli(['--version']);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(`${PACKAGE_NAME} ${VERSION}`);
  });

  it('matches package.json', () => {
    // `VERSION` comes from the build-time substitution of package.json, so this
    // fails if the two ever diverge rather than reporting a stale string.
    expect(VERSION).toBe(pkg.version);
  });
});

describe('hindsight --help', () => {
  it('prints usage and succeeds with no arguments', () => {
    const { status, stdout } = runCli([]);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: hindsight <command>');
  });

  it('names every hook the CLI dispatches', () => {
    const { stdout } = runCli(['--help']);
    for (const name of HOOK_NAMES) {
      expect(stdout).toContain(name);
    }
  });
});

describe('argument errors', () => {
  it('rejects an unknown command without exiting 2', () => {
    // Exit 2 is Claude Code's "blocking error" code. A typo must not stop the
    // user's prompt from going through.
    const { status, stderr } = runCli(['bogus']);
    expect(status).toBe(1);
    expect(stderr).toContain('unknown command "bogus"');
  });

  it('rejects a missing hook name', () => {
    const { status, stderr } = runCli(['hook']);
    expect(status).toBe(1);
    expect(stderr).toContain('unknown hook');
  });

  it('rejects an unknown hook name and lists the valid ones', () => {
    const { status, stderr } = runCli(['hook', 'bogus']);
    expect(status).toBe(1);
    expect(stderr).toContain('unknown hook "bogus"');
    for (const name of HOOK_NAMES) {
      expect(stderr).toContain(name);
    }
  });
});

describe('hindsight hook <name>', () => {
  it('exits 0 on empty stdin', () => {
    // Claude Code starts hooks with no input in some paths. A hook that failed
    // here would surface an error on every prompt.
    for (const name of HOOK_NAMES) {
      const { status, stderr } = runCli(['hook', name], {
        input: '',
        env: { CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot, HINDSIGHT_API_URL: 'http://127.0.0.1:1' },
      });
      expect(status, `${name}: ${stderr}`).toBe(0);
    }
  });

  it('exits 0 on non-JSON stdin', () => {
    const { status } = runCli(['hook', 'retain'], { input: 'not json{{' });
    expect(status).toBe(0);
  });
});

describe('removed subcommands', () => {
  it('rejects `setup`, which the plugin no longer needs', () => {
    // `setup` wrote this plugin's four hooks into ~/.claude/settings.json. The
    // plugin declares them itself in `hooks/hooks.json` — Claude Code launches the
    // MCP server it declares, and the hooks are the same mechanism — so the only
    // thing the command could still do is register them twice, once per source.
    const { status, stderr } = runCli(['setup']);
    expect(status).toBe(1);
    expect(stderr).toContain('unknown command "setup"');
  });
});
