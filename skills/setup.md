---
name: hindsight:setup
description: Register hindsight-memory hooks into Claude Code settings. Run this once after installing the plugin.
---

Register the hindsight-memory hooks into `~/.claude/settings.json` by running the setup script.

The setup script is part of the plugin's build output (`dist/`), which is **not**
committed to the repository — build it first:

```bash
cd "$CLAUDE_PLUGIN_ROOT" && bun install && bun run build
```

Then run:

```bash
node "$CLAUDE_PLUGIN_ROOT/dist/setup/setup-hooks.js"
```

If `CLAUDE_PLUGIN_ROOT` is not set, find the path manually:

```bash
ls ~/.claude/plugins/cache/hindsight/hindsight-memory/
```

Then build and run:

```bash
cd ~/.claude/plugins/cache/hindsight/hindsight-memory/<version>
bun install && bun run build && node dist/setup/setup-hooks.js
```

After the script completes, restart Claude Code for the hooks to take effect. You should see `[Hindsight]` log lines on the next session start.
