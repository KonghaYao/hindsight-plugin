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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
    // The package publishes `dist/` and nothing else, so any bare import left in
    // the bundle would only fail on a user's machine, at first prompt.
    const imports = [...readFileSync(CLI, 'utf8').matchAll(/^\s*import\s[^;]*?from\s*"([^"]+)"/gm)]
      .map((match) => match[1] ?? '')
      .filter((specifier) => !specifier.startsWith('node:'));
    expect(imports).toEqual([]);
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

describe('hindsight setup', () => {
  /** Create the plugin cache layout `findPluginRoot` looks for, plus a settings file. */
  function prepareClaudeDir(version: string): string {
    const claudeDir = join(sandbox.homeDir, '.claude');
    const pluginDir = join(claudeDir, 'plugins', 'cache', 'hindsight', 'hindsight-memory', version);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({}));
    return join(claudeDir, 'settings.json');
  }

  it('registers hooks that call the pinned published CLI', () => {
    const settingsPath = prepareClaudeDir(VERSION);

    const { status, stdout } = runCli(['setup'], { env: { HOME: sandbox.homeDir } });
    expect(status).toBe(0);
    expect(stdout).toContain('registered successfully');

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commands = Object.values(settings.hooks).flatMap((matchers) =>
      matchers.flatMap((matcher) => matcher.hooks.map((hook) => hook.command)),
    );

    expect(commands).toContain(`npx -y -p ${PACKAGE_NAME}@${VERSION} hindsight hook recall`);
    expect(commands).toHaveLength(HOOK_NAMES.length);
  });

  it('fails with a message when the plugin is not installed', () => {
    const claudeDir = join(sandbox.homeDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({}));

    const { status, stderr } = runCli(['setup'], { env: { HOME: sandbox.homeDir } });
    expect(status).toBe(1);
    expect(stderr).toContain('plugin not found');
  });
});
