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
    // Null values in the file should not override defaults.
    expect(cfg.bankId).toBeNull(); // default is null, so ok
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
