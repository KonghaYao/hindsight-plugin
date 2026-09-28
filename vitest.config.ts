import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Mirrors the substitution `scripts/build.ts` performs. Tests import `src/`
// directly rather than the bundle, so without this the version identifier in
// lib/version.ts would resolve to the `0.0.0-dev` placeholder and every
// assertion about it would be vacuous.
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig({
  define: {
    __HINDSIGHT_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    restoreMocks: true,
  },
});
