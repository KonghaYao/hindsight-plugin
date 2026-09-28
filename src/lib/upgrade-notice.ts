/**
 * Deprecation notice for this plugin, shown at every session start.
 *
 * This plugin still works and is not going to stop working, but it is deprecated: development has
 * moved to `@vectorize-io/hindsight-coding-agents`. Someone who installed this a year ago has no way to
 * learn that — a changelog entry reaches nobody — so the session itself says it.
 *
 * Shown every session rather than a few times: a notice that appears once is missed, and this one has
 * a concrete action attached. `"upgradeNotice": false` in the user config turns it off permanently,
 * and the message says so, which is what keeps that acceptable.
 *
 * Any failure returns null rather than throwing. A promotional message must never be the reason
 * someone's session breaks.
 *
 * Deliberately duplicated in the codex plugin rather than shared: the two ship as independent
 * packages with no common module path.
 */
import type { PluginConfig } from './config';

export const DOCS_URL = 'https://hindsight.vectorize.io/sdks/integrations/coding-agents';
export const MIGRATION_URL = `${DOCS_URL}#migrating-from-the-per-agent-plugins`;

export const NOTICE =
  'The current Hindsight Claude Code plugin is DEPRECATED, replaced by the Coding Agents ' +
  'plugin.\n' +
  '\n' +
  'One install now covers Claude Code, Codex, Cursor, Copilot, opencode, Kilo, Grok, ' +
  'Antigravity,\n' +
  'Devin and Cline, and they all share a single memory per repository, leveraging the Hindsight ' +
  'Knowledge Page (v0.9.x and onwards).\n' +
  '\n' +
  `See the migration guide: ${MIGRATION_URL}\n` +
  'Your Hindsight server and token carry over automatically; past conversations are re-imported ' +
  'from\n' +
  'local transcripts. Silence this with "upgradeNotice": false in ' +
  '~/.hindsight/claude-code.json';

/**
 * Return the notice, or null when the user has turned it off.
 *
 * Reads a plain property, and also a dict-like `get()` when the caller hands
 * over parsed configuration — the Python original went through
 * `config.get("upgradeNotice", True)`.
 */
export function upgradeNotice(config: PluginConfig): string | null {
  try {
    const getter = config.get as ((key: string, fallback: unknown) => unknown) | undefined;
    const configured: unknown =
      typeof getter === 'function' ? getter('upgradeNotice', true) : config.upgradeNotice;
    // A missing flag means the notice is on, while any falsy value — an
    // explicit null included — opts out.
    const enabled = configured === undefined ? true : configured;
    return enabled ? NOTICE : null;
  } catch {
    // A promotional message must never be why someone's session breaks.
    return null;
  }
}
