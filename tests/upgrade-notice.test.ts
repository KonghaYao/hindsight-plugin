/**
 * The superseded-by-coding-agents notice.
 *
 * Migrated 1:1 from tests/test_upgrade_notice.py. The Python tests passed bare
 * dicts (`{}`, `{"upgradeNotice": False}`); `PluginConfig` is the same plain bag
 * at runtime, so `asConfig` keeps the call sites identical.
 */
import { describe, expect, it } from 'vitest';
import type { PluginConfig } from '../src/lib/config';
import { DOCS_URL, MIGRATION_URL, upgradeNotice } from '../src/lib/upgrade-notice';

/** Build the duck-typed config the Python suite handed to `upgrade_notice`. */
function asConfig(values: Record<string, unknown> = {}): PluginConfig {
  return values as unknown as PluginConfig;
}

/** Assert the notice is shown and return its text, mirroring Python's truthiness checks. */
function notice(values: Record<string, unknown> = {}): string {
  const text = upgradeNotice(asConfig(values));
  expect(text).not.toBeNull();
  return text as string;
}

describe('UpgradeNotice', () => {
  it('shown on every session', () => {
    // No cap and no interval — a notice shown once is a notice that gets missed.
    for (let i = 0; i < 5; i += 1) {
      expect(upgradeNotice(asConfig())).not.toBeNull();
    }
  });

  it('names this plugin', () => {
    // Whoever reads it must know WHICH plugin is deprecated — both are installed side by side.
    expect(notice()).toContain('Claude Code');
  });

  it('links the migration guide', () => {
    // Deep-links the section, not just the page — the reader wants the steps, not the pitch.
    expect(notice()).toContain(MIGRATION_URL);
    expect(DOCS_URL).toBe('https://hindsight.vectorize.io/sdks/integrations/coding-agents');
    expect(MIGRATION_URL.endsWith('#migrating-from-the-per-agent-plugins')).toBe(true);
  });

  it('says deprecated outright', () => {
    // "Superseded" is jargon; a user needs to read one word and know to act.
    expect(notice()).toContain('DEPRECATED');
  });

  it('opt out silences it', () => {
    // The only thing making an every-session notice acceptable — so it must work.
    expect(upgradeNotice(asConfig({ upgradeNotice: false }))).toBeNull();
  });

  it('opt out is discoverable from the message itself', () => {
    expect(notice()).toContain('upgradeNotice');
  });

  it('never raises', () => {
    // A promotional message must never be why someone's session breaks.
    const hostile = {
      get(): never {
        throw new Error('boom');
      },
    };

    expect(upgradeNotice(asConfig(hostile))).toBeNull();
  });
});
