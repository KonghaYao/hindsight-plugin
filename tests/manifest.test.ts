/**
 * Validate that JSON manifests are strict-valid JSON (no trailing commas, etc.).
 *
 * Port of `tests/test_manifest.py`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const INTEGRATION_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('hooks/hooks.json', () => {
  it('is strict-valid JSON with a hooks object', () => {
    const path = join(INTEGRATION_ROOT, 'hooks', 'hooks.json');
    const raw = readFileSync(path, 'utf8');

    // `JSON.parse` is the strict-superset check `json.loads` performs: it
    // rejects trailing commas, comments and single quotes.
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect('hooks' in parsed).toBe(true);
    // Python's `isinstance(parsed["hooks"], dict)` — an array or null is not a dict.
    expect(parsed.hooks).toBeTypeOf('object');
    expect(Array.isArray(parsed.hooks)).toBe(false);
    expect(parsed.hooks).not.toBeNull();
  });
});
