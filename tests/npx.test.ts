/**
 * Run the CLI the way the plugin does: `npx -y -p <spec> hindsight …`.
 *
 * Every other suite spawns `dist/cli.js` through `process.execPath`, which skips
 * the parts that exist only in the published form: the spec resolving at all, npm
 * linking `bin.hindsight` to the file, and the exit code surviving npx intact. A
 * wrong package name, a `bin` key naming a file `files` excludes, or a missing
 * executable bit is invisible to all of them — and fails only on a user's machine.
 *
 * The spec is a locally packed tarball rather than `@peri-code/hindsight@<version>`,
 * so this runs without the registry and without the release having been published.
 *
 * It runs in a temporary directory, never in this repository's root: `npm exec`
 * matches a `<name>@<version>` spec against the local tree first, and this
 * repository's own `package.json` carries exactly that name and version, so from
 * here `npx -p @peri-code/hindsight … hindsight` links no `bin` at all and dies
 * with `sh: hindsight: command not found` instead of resolving the package.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE_NAME, VERSION } from '../src/lib/version';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(PACKAGE_ROOT, 'dist', 'cli.js');

/** Windows ships these as `.cmd` shims, which have to be named explicitly. */
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** How long one npx invocation may take: the first one installs the tarball. */
const TIMEOUT_MS = 120_000;

/**
 * Whether `npx` can be spawned at all — false, and both cases skip, on a machine
 * with no npm.
 *
 * Probed at module scope rather than in `beforeAll`, because `it.skipIf` is
 * resolved when the suite is collected, which happens before any hook runs.
 */
const NPX_AVAILABLE = spawnSync(NPX, ['--version'], { encoding: 'utf8' }).status === 0;

let workDir = '';
let tarball = '';

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(`${CLI} is missing — run \`bun run build\` before this suite.`);
  }
  if (!NPX_AVAILABLE) {
    return;
  }

  workDir = mkdtempSync(join(tmpdir(), 'hindsight-npx-'));
  // `--silent` leaves the tarball's filename as the only thing on stdout.
  const packed = spawnSync(NPM, ['pack', '--pack-destination', workDir, '--silent'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
  if (packed.status !== 0) {
    throw new Error(`npm pack failed: ${packed.stderr}`);
  }
  tarball = join(workDir, packed.stdout.trim());
});

afterAll(() => {
  if (workDir !== '') {
    rmSync(workDir, { recursive: true, force: true });
  }
});

/** `process.env` minus the `undefined` values, which `spawnSync` will not take. */
function stringEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * `npx -y -p <tarball> hindsight <args…>`, with an npm cache of its own.
 *
 * The private cache is what makes this a real test rather than a re-run of an
 * earlier install: with the developer's, a cached copy could satisfy the spec and
 * the tarball's `bin` link would never be exercised.
 */
function runViaNpx(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(NPX, ['-y', '-p', tarball, 'hindsight', ...args], {
    cwd: workDir,
    encoding: 'utf8',
    input: '',
    timeout: TIMEOUT_MS,
    env: {
      ...stringEnv(),
      npm_config_cache: join(workDir, 'npm-cache'),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_loglevel: 'error',
    },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('the published invocation form', () => {
  it.skipIf(!NPX_AVAILABLE)(
    'runs the packed tarball as `npx -p <spec> hindsight`',
    { timeout: TIMEOUT_MS },
    () => {
      const { status, stdout, stderr } = runViaNpx(['--version']);
      // npm's own failures are exit 1 with an empty stdout — the shape an
      // unpublished version produces — so this tells the two apart.
      expect(stderr).not.toContain('npm error');
      expect(status).toBe(0);
      expect(stdout.trim()).toBe(`${PACKAGE_NAME} ${VERSION}`);
    },
  );

  it.skipIf(!NPX_AVAILABLE)(
    'passes the CLI exit code through unchanged',
    { timeout: TIMEOUT_MS },
    () => {
      // Claude Code reads that code to decide whether a hook failed. Each layer
      // reporting its own status instead would make every hook look successful.
      expect(runViaNpx(['hook', 'bogus']).status).toBe(1);
    },
  );
});
