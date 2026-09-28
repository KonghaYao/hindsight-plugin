/**
 * Validate the shipped manifests and the invariants that tie them together.
 *
 * Port of `tests/test_manifest.py`, which only checked that the JSON parsed.
 * The rest is new, and it exists because these files are the parts of a release
 * nobody exercises: a hook command naming the wrong package, a plugin version
 * that drifts from the published one, or a shipped default contradicting the
 * built-in one all fail silently at runtime — the first two only on a user's
 * machine, the third only as memories that never come back.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOOK_EVENTS, HOOK_NAMES } from '../src/hooks/names';
import { DEFAULTS } from '../src/lib/config';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Strict-parse a JSON file. `JSON.parse` rejects trailing commas and comments. */
function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, relativePath), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** One hook registration as it appears in `hooks.json`. */
interface HookRegistration {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  async?: unknown;
}

const pkg = readJson('package.json');
const pluginManifest = readJson('plugin/.claude-plugin/plugin.json');
const hooksJson = readJson('plugin/hooks/hooks.json');
const mcpJson = readJson('plugin/.mcp.json');
const marketplaceJson = readJson('.claude-plugin/marketplace.json');

const hooks = hooksJson.hooks as Record<string, unknown>;

/**
 * The package spec both manifests must pin, behind an `npm:` alias.
 *
 * The alias is load-bearing, not cosmetic. `npm exec` matches a
 * `<name>@<version>` spec against the local tree before it looks at the registry,
 * and when that match carries no `bin` links — which is exactly the case when the
 * current project *is* this package, i.e. in this repository — npm installs
 * nothing into its npx cache and puts no `hindsight` on `PATH`. The hook then dies
 * with `sh: hindsight: command not found` (exit 127), which Claude Code reports as
 * a hook error on session start and on every prompt. An aliased spec is not the
 * name npm matches against the tree, so it always resolves from the registry.
 * Reproduced on npm 10.9.2 and 11.19.1.
 */
const NPX_ALIAS = `npm:${String(pkg.name)}@${String(pkg.version)}`;

/** The command prefix every hook in `hooks.json` must share. */
const NPX_PREFIX = `npx -y -p ${NPX_ALIAS} hindsight`;

/** Pull the `{type, command}` entries registered for one Claude Code event. */
function registrationsFor(event: string): HookRegistration[] {
  const matchers = hooks[event];
  if (!Array.isArray(matchers)) {
    return [];
  }
  return matchers.flatMap((matcher: unknown) => {
    const inner = (matcher as { hooks?: unknown }).hooks;
    return Array.isArray(inner) ? (inner as HookRegistration[]) : [];
  });
}

describe('version consistency', () => {
  it('is a real semver version, not a placeholder', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('pins the plugin manifest to the published package version', () => {
    // The plugin is a thin wrapper around the CLI: it ships no code of its own,
    // so a version mismatch means the marketplace advertises a release that does
    // not exist on npm.
    expect(pluginManifest.version).toBe(pkg.version);
  });

  it('pins every hook command to that same version', () => {
    const commands = Object.values(hooks).flatMap((matchers) =>
      (matchers as Array<{ hooks?: HookRegistration[] }>).flatMap((matcher) =>
        (matcher.hooks ?? []).map((hook) => String(hook.command)),
      ),
    );

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.startsWith(NPX_PREFIX)).toBe(true);
    }
  });

  it('pins the MCP server registration to that same version', () => {
    // Unpinned, `npx` resolves `latest` on every session start, so a later
    // publish would silently change what this plugin runs. Aliased for the same
    // reason as the hooks: the server has to start in this repository too.
    const servers = mcpJson.mcpServers as Record<string, { command?: string; args?: string[] }>;

    expect(servers.hindsight?.command).toBe('npx');
    expect(servers.hindsight?.args?.[2]).toBe(NPX_ALIAS);
  });
});

describe('plugin/hooks/hooks.json', () => {
  it('is strict-valid JSON with a hooks object', () => {
    // Python's `isinstance(parsed["hooks"], dict)` — an array or null is not a dict.
    expect(hooksJson.hooks).toBeTypeOf('object');
    expect(Array.isArray(hooksJson.hooks)).toBe(false);
    expect(hooksJson.hooks).not.toBeNull();
  });

  it('registers exactly the hooks the CLI implements, each on its own event', () => {
    for (const name of HOOK_NAMES) {
      const registrations = registrationsFor(HOOK_EVENTS[name]);
      expect(registrations, `${name} is not registered for ${HOOK_EVENTS[name]}`).toHaveLength(1);
      expect(registrations[0]?.command).toBe(`${NPX_PREFIX} hook ${name}`);
    }

    // And nothing beyond them: an event left behind after a rename would fire a
    // command the CLI rejects, once per prompt.
    expect(Object.keys(hooks).sort()).toEqual([...new Set(Object.values(HOOK_EVENTS))].sort());
  });

  it('keeps the retain hook asynchronous', () => {
    // `Stop` runs on the critical path of every response. Synchronous, the
    // transcript upload would block the user's next prompt for as long as the
    // Hindsight server takes.
    expect(registrationsFor('Stop')[0]?.async).toBe(true);
  });
});

describe('plugin/.mcp.json', () => {
  it('is strict-valid JSON exposing the hindsight server', () => {
    expect(mcpJson.mcpServers).toBeTypeOf('object');
    expect(mcpJson.mcpServers).not.toBeNull();
    expect(Object.keys(mcpJson.mcpServers as Record<string, unknown>)).toEqual(['hindsight']);
  });
});

describe('plugin/settings.json', () => {
  const shipped = readJson('plugin/settings.json');

  it('is exactly the built-in defaults', () => {
    // Not "does not contradict": identical. This file is the reference users
    // read to find out what can be configured, and the built-in values are what
    // apply when it cannot be found — which is the normal case under npx, where
    // the CLI runs from a cache directory with no plugin beside it.
    //
    // The two drifting apart is not hypothetical: the file used to set
    // `recallTypes: ["observation"]` while the code defaulted to all three, and
    // every freshly retained memory was unreachable until consolidation
    // happened to synthesise an observation. `bankId` was worse — the file said
    // `claude_code` and the code's fallback said `claude-code`, so losing the
    // file would have looked exactly like the memories being deleted.
    expect(shipped).toEqual(DEFAULTS);
  });
});

describe('plugin/.claude-plugin/plugin.json', () => {
  it('declares the plugin name the marketplace installs', () => {
    expect(pluginManifest.name).toBe('hindsight-memory');
  });
});

describe('.claude-plugin/marketplace.json', () => {
  const entries = marketplaceJson.plugins as Array<{ name?: unknown; source?: unknown }>;

  /** The entry `claude plugin install hindsight-memory` resolves through. */
  const entry = entries.find((candidate) => candidate.name === pluginManifest.name);

  it('offers the plugin under the name plugin.json declares', () => {
    // `claude plugin install <name>` resolves against this list, so an entry
    // named anything else installs a plugin the README does not describe.
    expect(entry, `no marketplace entry named ${String(pluginManifest.name)}`).toBeDefined();
  });

  it('points that entry at the directory the plugin actually ships from', () => {
    // The repository root is the marketplace and the plugin is one directory
    // down, so this path is the whole link between the two: `./` would hand
    // Claude Code a directory with no plugin manifest in it.
    expect(entry?.source).toBe('./plugin');
    expect(existsSync(join(PACKAGE_ROOT, 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true);
  });
});
