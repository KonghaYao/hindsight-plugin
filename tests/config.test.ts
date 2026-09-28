/**
 * Tests for src/lib/config.ts — configuration loading and env overrides.
 *
 * Migrated 1:1 from tests/test_config.py. The Python file's class-level autouse
 * fixture (HOME pointed at tmp_path, every HINDSIGHT_* var deleted) is the
 * `createEnvSandbox()` helper here.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { castEnv, loadConfig } from '../src/lib/config';
import { createEnvSandbox, type EnvSandbox } from './helpers';

describe('CastEnv', () => {
  it('bool true values', () => {
    for (const value of ['true', 'True', 'TRUE', '1', 'yes', 'YES']) {
      expect(castEnv(value, 'bool')).toBe(true);
    }
  });

  it('bool false values', () => {
    for (const value of ['false', 'False', '0', 'no']) {
      expect(castEnv(value, 'bool')).toBe(false);
    }
  });

  it('int cast', () => {
    expect(castEnv('42', 'int')).toBe(42);
  });

  it('int invalid returns null', () => {
    expect(castEnv('notanint', 'int')).toBeNull();
  });

  it('int rejects floats and trailing junk', () => {
    // Python's int() refuses these, so the override must be skipped.
    expect(castEnv('3.5', 'int')).toBeNull();
    expect(castEnv('3.5.5', 'int')).toBeNull();
  });

  it('str passthrough', () => {
    expect(castEnv('hello', 'string')).toBe('hello');
  });
});

describe('LoadConfig', () => {
  let sandbox: EnvSandbox;

  beforeEach(() => {
    sandbox = createEnvSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('defaults applied when no settings file', () => {
    // No settings.json in the sandboxed plugin root.
    const cfg = loadConfig();
    expect(cfg.autoRecall).toBe(true);
    expect(cfg.autoRetain).toBe(true);
    expect(cfg.recallBudget).toBe('mid');
    expect(cfg.retainEveryNTurns).toBe(10);
  });

  it('recall covers every fact type by default', () => {
    // The default was `['observation']` alone. The API knows three fact types,
    // and an observation only exists once consolidation has synthesised one —
    // which it sometimes never does. Asking for all three is also what the API
    // returns when no filter is sent at all.
    expect(loadConfig().recallTypes).toEqual(['world', 'experience', 'observation']);
  });

  it('settings json overrides defaults', () => {
    sandbox.writePluginSettings({ recallBudget: 'high', bankId: 'my-bank' });
    const cfg = loadConfig();
    expect(cfg.recallBudget).toBe('high');
    expect(cfg.bankId).toBe('my-bank');
  });

  it('env var overrides settings json', () => {
    sandbox.writePluginSettings({ recallBudget: 'low' });
    sandbox.setEnv('HINDSIGHT_RECALL_BUDGET', 'high');
    const cfg = loadConfig();
    expect(cfg.recallBudget).toBe('high');
  });

  it('bool env var override', () => {
    sandbox.setEnv('HINDSIGHT_AUTO_RECALL', 'false');
    const cfg = loadConfig();
    expect(cfg.autoRecall).toBe(false);
  });

  it('int env var override', () => {
    sandbox.setEnv('HINDSIGHT_API_PORT', '9999');
    const cfg = loadConfig();
    expect(cfg.apiPort).toBe(9999);
  });

  it('request timeout default none', () => {
    const cfg = loadConfig();
    expect(cfg.requestTimeoutSeconds).toBeNull();
  });

  it('request timeout env override', () => {
    sandbox.setEnv('HINDSIGHT_REQUEST_TIMEOUT_SECONDS', '60');
    const cfg = loadConfig();
    expect(cfg.requestTimeoutSeconds).toBe(60);
  });

  it('recall tags env override accepts comma list', () => {
    sandbox.setEnv('HINDSIGHT_RECALL_TAGS', 'memory_type:rule, tech_stack:supabase');
    const cfg = loadConfig();
    expect(cfg.recallTags).toEqual(['memory_type:rule', 'tech_stack:supabase']);
  });

  it('recall tag groups env override accepts json', () => {
    sandbox.setEnv(
      'HINDSIGHT_RECALL_TAG_GROUPS',
      '[{"op":"all","tags":["memory_type:rule","tech_stack:supabase"]}]',
    );
    const cfg = loadConfig();
    expect(cfg.recallTagGroups).toEqual([
      { op: 'all', tags: ['memory_type:rule', 'tech_stack:supabase'] },
    ]);
  });

  it('recall additional bank filters env override accepts json', () => {
    sandbox.setEnv(
      'HINDSIGHT_RECALL_ADDITIONAL_BANK_FILTERS',
      '{"normative":{"recallTags":["memory_type:rule"],"recallTagsMatch":"all"}}',
    );
    const cfg = loadConfig();
    expect(cfg.recallAdditionalBankFilters).toEqual({
      normative: { recallTags: ['memory_type:rule'], recallTagsMatch: 'all' },
    });
  });

  it('invalid settings json falls back to defaults', () => {
    writeFileSync(join(sandbox.pluginRoot, 'settings.json'), 'not valid json{{');
    const cfg = loadConfig();
    expect(cfg.recallBudget).toBe('mid'); // default still applies
  });

  it('null values in settings json not applied', () => {
    sandbox.writePluginSettings({ bankId: null, recallBudget: 'high' });
    const cfg = loadConfig();
    // Null values in the file should not override defaults — the built-in
    // default for `bankId` is the bank the plugin has always shipped.
    expect(cfg.bankId).toBe('claude_code');
    expect(cfg.recallBudget).toBe('high');
  });

  it('api url env override', () => {
    sandbox.setEnv('HINDSIGHT_API_URL', 'http://myserver:8080');
    const cfg = loadConfig();
    expect(cfg.hindsightApiUrl).toBe('http://myserver:8080');
  });

  it('user config overrides plugin settings', () => {
    // Plugin default ships with "low".
    sandbox.writePluginSettings({ recallBudget: 'low' });
    // User overrides to "high" via ~/.hindsight/claude-code.json.
    sandbox.writeUserConfig({ recallBudget: 'high' });

    const cfg = loadConfig();
    expect(cfg.recallBudget).toBe('high');
  });

  it('user config missing falls back gracefully', () => {
    // No ~/.hindsight/claude-code.json exists in the sandboxed home.
    const cfg = loadConfig();
    expect(cfg.recallBudget).toBe('mid'); // default
  });

  it('env var wins over user config', () => {
    sandbox.writeUserConfig({ recallBudget: 'low' });
    sandbox.setEnv('HINDSIGHT_RECALL_BUDGET', 'high');

    const cfg = loadConfig();
    expect(cfg.recallBudget).toBe('high');
  });
});

/**
 * The per-workspace layer (`HINDSIGHT_CONFIG`), which a platform populates so
 * that one workspace's settings override everything else.
 */
describe('WorkspaceConfig', () => {
  let sandbox: EnvSandbox;

  beforeEach(() => {
    sandbox = createEnvSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  /** Point `HINDSIGHT_CONFIG` at a file holding `raw` verbatim (not necessarily JSON). */
  function pointAtRawFile(raw: string): string {
    writeFileSync(sandbox.workspaceConfigPath, raw);
    sandbox.setEnv('HINDSIGHT_CONFIG', sandbox.workspaceConfigPath);
    return sandbox.workspaceConfigPath;
  }

  it('is skipped entirely when HINDSIGHT_CONFIG is unset', () => {
    // A workspace file on disk is not read unless the variable names it, so an
    // installation that sets nothing behaves exactly as it did before this layer
    // existed.
    sandbox.writePluginSettings({ recallBudget: 'low' });
    sandbox.writeUserConfig({ recallBudget: 'high' });
    sandbox.writeWorkspaceConfig({ recallBudget: 'workspace' });

    expect(loadConfig().recallBudget).toBe('high');
  });

  it('is skipped when HINDSIGHT_CONFIG is empty', () => {
    sandbox.writeUserConfig({ recallBudget: 'high' });
    sandbox.setEnv('HINDSIGHT_CONFIG', '');

    expect(loadConfig().recallBudget).toBe('high');
  });

  it('a relative path is treated as unset', () => {
    // A relative pointer would be resolved against the process cwd, and for a
    // hook or the MCP server that is not the workspace — so the layers below
    // stand rather than a file be read from wherever the process happens to run.
    sandbox.writeUserConfig({ recallBudget: 'usercfg' });
    sandbox.setEnv('HINDSIGHT_RECALL_BUDGET', 'env');
    sandbox.writeWorkspaceConfig({ recallBudget: 'workspace' });
    sandbox.setEnv('HINDSIGHT_CONFIG', '.hindsight/workspace.json');

    expect(loadConfig().recallBudget).toBe('env');
  });

  it('a relative path that happens to resolve is still not read', () => {
    // `./package.json` exists relative to whatever process runs the suite, so a
    // reader that trusted the cwd would merge it; the layer has to stay off.
    sandbox.writeUserConfig({ recallBudget: 'high' });
    sandbox.setEnv('HINDSIGHT_CONFIG', './package.json');

    const cfg = loadConfig();
    expect(cfg.recallBudget).toBe('high');
    expect('name' in cfg).toBe(false);
  });

  it('an absolute path to the same kind of file is still read', () => {
    // The control for the two cases above: absolute, the layer applies.
    sandbox.writeUserConfig({ recallBudget: 'high' });
    sandbox.setEnv('HINDSIGHT_CONFIG', sandbox.writeWorkspaceConfig({ recallBudget: 'workspace' }));

    expect(loadConfig().recallBudget).toBe('workspace');
  });

  it('overrides the user config', () => {
    sandbox.writeUserConfig({ recallBudget: 'high', bankId: 'user-bank' });
    sandbox.setEnv('HINDSIGHT_CONFIG', sandbox.writeWorkspaceConfig({ recallBudget: 'workspace' }));

    const cfg = loadConfig();
    expect(cfg.recallBudget).toBe('workspace');
    // Keys the file omits keep the value the lower layers gave them.
    expect(cfg.bankId).toBe('user-bank');
  });

  it('overrides environment variables', () => {
    sandbox.setEnv('HINDSIGHT_RECALL_BUDGET', 'high');
    sandbox.setEnv('HINDSIGHT_API_PORT', '9999');
    sandbox.setEnv(
      'HINDSIGHT_CONFIG',
      sandbox.writeWorkspaceConfig({ recallBudget: 'workspace', apiPort: 9078 }),
    );

    const cfg = loadConfig();
    expect(cfg.recallBudget).toBe('workspace');
    expect(cfg.apiPort).toBe(9078);
  });

  it('overrides the plugin settings.json and the built-in defaults', () => {
    sandbox.writePluginSettings({ recallBudget: 'low' });
    sandbox.setEnv(
      'HINDSIGHT_CONFIG',
      sandbox.writeWorkspaceConfig({ recallBudget: 'workspace', retainEveryNTurns: 3 }),
    );

    const cfg = loadConfig();
    expect(cfg.recallBudget).toBe('workspace');
    expect(cfg.retainEveryNTurns).toBe(3);
  });

  it('a missing file is ignored', () => {
    sandbox.setEnv('HINDSIGHT_CONFIG', join(sandbox.root, 'no-such-file.json'));

    expect(loadConfig().recallBudget).toBe('mid');
  });

  it('an unreadable path is ignored', () => {
    // A directory cannot be read as a file; the hook must survive it all the same.
    sandbox.setEnv('HINDSIGHT_CONFIG', sandbox.root);

    expect(loadConfig().recallBudget).toBe('mid');
  });

  it('invalid json is ignored', () => {
    pointAtRawFile('not valid json{{');

    expect(loadConfig().recallBudget).toBe('mid');
  });

  it('a non-object top level is ignored', () => {
    for (const raw of ['[]', '"recallBudget"', '42', 'null']) {
      pointAtRawFile(raw);
      expect(loadConfig().recallBudget, `top level: ${raw}`).toBe('mid');
    }
  });

  it('null values never override a lower layer', () => {
    sandbox.writeUserConfig({ bankId: 'user-bank' });
    sandbox.setEnv('HINDSIGHT_RECALL_CONTEXT_TURNS', '7');
    sandbox.setEnv(
      'HINDSIGHT_CONFIG',
      sandbox.writeWorkspaceConfig({
        bankId: null,
        recallContextTurns: null,
        recallBudget: 'workspace',
      }),
    );

    const cfg = loadConfig();
    // Null means "unset" here too: the user config and the env layer stand.
    expect(cfg.bankId).toBe('user-bank');
    expect(cfg.recallContextTurns).toBe(7);
    expect(cfg.recallBudget).toBe('workspace');
  });

  it('the managed block never reaches the config', () => {
    // Written alongside the settings by whoever generated the file; it is
    // metadata about the file, not a setting of the plugin.
    sandbox.setEnv(
      'HINDSIGHT_CONFIG',
      sandbox.writeWorkspaceConfig({
        managed: {
          writer: 'fenix-agent',
          workspaceRoot: '/home/user/myproject',
          writtenAt: '2024-01-15T00:00:00.000Z',
        },
        recallBudget: 'workspace',
      }),
    );

    const cfg = loadConfig();
    expect(cfg.recallBudget).toBe('workspace');
    expect('managed' in cfg).toBe(false);
  });
});
