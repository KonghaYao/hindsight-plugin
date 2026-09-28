#!/usr/bin/env node
/**
 * `hindsight` — the CLI the Claude Code plugin (and anyone else) drives.
 *
 * Everything the plugin does at runtime goes through here: the plugin itself is
 * a directory of JSON that shells out to `npx @peri-code/hindsight …`, so this
 * file is the entire executable surface between Claude Code and the package.
 *
 *     hindsight hook <session-start|recall|retain|session-end>
 *     hindsight mcp
 *     hindsight setup
 *
 * Startup cost is why the subcommands are imported lazily: `hook recall` fires
 * on every user prompt, and it has no reason to parse the MCP SDK.
 */
import { HOOK_NAMES, type HookName } from './hooks/names';
import { PACKAGE_NAME, VERSION } from './lib/version';

const USAGE = `Usage: hindsight <command> [options]

Long-term memory for Claude Code, backed by Hindsight.

Commands:
  hook <name>   Run a Claude Code hook. One of: ${HOOK_NAMES.join(', ')}
  mcp           Run the MCP stdio server exposing the agent_knowledge_* tools
  setup         Register this plugin's hooks in ~/.claude/settings.json

Options:
  -h, --help     Show this help
  -V, --version  Print the version

The Claude Code plugin calls this CLI through npx; you only need to run it by
hand for the one-off setup step, or to use the knowledge tools yourself.`;

/**
 * True for the strings this CLI accepts as a hook name.
 *
 * A plain `includes` over a literal tuple, so an unknown name is rejected here
 * rather than surfacing as a module-resolution error from the dynamic import.
 */
function isHookName(value: string): value is HookName {
  return (HOOK_NAMES as readonly string[]).includes(value);
}

/** Load and run one hook bundle. The hook owns its own error handling. */
async function runHook(name: HookName): Promise<void> {
  switch (name) {
    case 'session-start': {
      const mod = await import('./hooks/session-start');
      await mod.run();
      return;
    }
    case 'recall': {
      const mod = await import('./hooks/recall');
      await mod.run();
      return;
    }
    case 'retain': {
      const mod = await import('./hooks/retain');
      await mod.run();
      return;
    }
    case 'session-end': {
      const mod = await import('./hooks/session-end');
      await mod.run();
      return;
    }
  }
}

/**
 * Message text of an error, matching Python's `str(e)` rather than JS's
 * `String(error)` — the hooks' own `[Hindsight] …` lines use the same form.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    // No arguments is a request for help, not a failure: the user is looking at
    // this because they ran `npx @peri-code/hindsight` with nothing after it.
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (command === 'version' || command === '--version' || command === '-V') {
    process.stdout.write(`${PACKAGE_NAME} ${VERSION}\n`);
    return 0;
  }

  if (command === 'hook') {
    const name = rest[0];
    if (name === undefined || !isHookName(name)) {
      process.stderr.write(
        `hindsight: unknown hook ${name === undefined ? '(missing)' : `"${name}"`}. ` +
          `Expected one of: ${HOOK_NAMES.join(', ')}\n`,
      );
      // Not exit 2: Claude Code treats that as a blocking hook failure, and a
      // typo in a hook command must not stop the user's prompt from going through.
      return 1;
    }
    await runHook(name);
    return 0;
  }

  if (command === 'mcp') {
    const mod = await import('./mcp/server');
    await mod.run();
    return 0;
  }

  if (command === 'setup') {
    const mod = await import('./setup/setup-hooks');
    return await mod.run();
  }

  process.stderr.write(`hindsight: unknown command "${command}"\n\n${USAGE}\n`);
  return 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  // Reaching here means a subcommand threw where it promised not to. Report it
  // and fail, rather than letting Node print a bare unhandled-rejection stack.
  process.stderr.write(`hindsight: ${errorText(error)}\n`);
  process.exitCode = 1;
}
