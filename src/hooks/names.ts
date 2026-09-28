/**
 * The hooks Claude Code can ask the CLI to run.
 *
 * Shared rather than private to `src/cli.ts` so the manifest test can assert
 * that `plugin/hooks/hooks.json` wires up exactly this set — a hook added to the
 * CLI but never registered, or a command left pointing at a hook that no longer
 * exists, is otherwise invisible until a session silently stops retaining.
 */
export const HOOK_NAMES = ['session-start', 'recall', 'retain', 'session-end'] as const;

export type HookName = (typeof HOOK_NAMES)[number];

/**
 * Which Claude Code event each hook is registered for.
 *
 * Not a detail the CLI needs; it is what `plugin/hooks/hooks.json` must match.
 */
export const HOOK_EVENTS: Record<HookName, string> = {
  'session-start': 'SessionStart',
  recall: 'UserPromptSubmit',
  retain: 'Stop',
  'session-end': 'SessionEnd',
};
