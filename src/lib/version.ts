/**
 * The package version, injected at build time.
 *
 * Read from `package.json` by `scripts/build.ts` (and by `vitest.config.ts` for
 * the test run) and substituted for the `__HINDSIGHT_VERSION__` identifier.
 * Inlining it beats reading a file at runtime: the CLI runs from three
 * different layouts — a source checkout, this repo's `dist/`, and an npx cache
 * under `node_modules/@peri-code/hindsight/` — and only one of them has a
 * `.claude-plugin/plugin.json` next to it.
 *
 * The `typeof` guard is what makes a missing substitution survivable: it is the
 * one operator that accepts an undeclared identifier, so a stray `tsc`-only run
 * reports a placeholder instead of a `ReferenceError`.
 */
declare const __HINDSIGHT_VERSION__: string | undefined;

/** Package version, or `0.0.0-dev` when the build did not inject one. */
export const VERSION: string =
  typeof __HINDSIGHT_VERSION__ === 'string' ? __HINDSIGHT_VERSION__ : '0.0.0-dev';

/** npm package name, as published and as the plugin's `npx` spec refers to it. */
export const PACKAGE_NAME = '@peri-code/hindsight';

/**
 * `User-Agent` sent to the Hindsight API.
 *
 * Deliberately *not* the npm package name: this string identifies the client on
 * the wire and is what the server's own request logs and metrics key on, so it
 * stays put across the rename.
 */
export const USER_AGENT = `hindsight-claude-code/${VERSION}`;
