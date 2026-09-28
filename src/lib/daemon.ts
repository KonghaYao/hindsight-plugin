/**
 * Hindsight-embed daemon lifecycle management.
 *
 * Port of: HindsightServer in @vectorize-io/hindsight-all, adapted for Node
 * subprocess calls from ephemeral hook processes.
 *
 * Manages three connection modes (same as Openclaw):
 *   1. External API — user provides hindsightApiUrl (skip daemon entirely)
 *   2. Existing local server — user already has hindsight running
 *   3. Auto-managed daemon — plugin starts/stops hindsight-embed
 *
 * In Claude Code's ephemeral model, daemon state is tracked via files in
 * $CLAUDE_PLUGIN_DATA/state/. The daemon itself is a background OS process
 * managed by hindsight-embed's built-in daemon command.
 */
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { USER_AGENT } from './client';
import type { PluginConfig } from './config';
import type { LlmConfig } from './llm';
import { detectLlmConfig, getLlmEnvVars } from './llm';
import { readState, writeState } from './state';

const DAEMON_STATE_FILE = 'daemon.json';
const PROFILE_NAME = 'claude-code';

/** Debug sink the hooks pass in (typically `debugLog` bound to the config). */
type DebugFn = (message: string) => void;

/**
 * Determine the API URL, optionally starting daemon if needed.
 *
 * Returns the API URL to use for recall/retain, handling all three modes.
 *
 * Connection mode priority:
 *   1. External API (hindsightApiUrl configured)
 *   2. Existing local server (check port health)
 *   3. Auto-managed daemon (only if allowDaemonStart=true)
 *
 * The allowDaemonStart flag prevents the recall hook (10s timeout) from
 * blocking on a 30s daemon startup. Only the retain hook (async, 15s) should
 * attempt daemon start.
 *
 * Async (unlike the Python original) because the health probe and the daemon
 * start await network I/O.
 */
export async function getApiUrl(
  config: PluginConfig,
  debugFn?: DebugFn | null,
  allowDaemonStart = false,
): Promise<string> {
  // Mode 1: External API
  const externalUrl = config.hindsightApiUrl;
  if (externalUrl) {
    debugFn?.(`Using external API: ${externalUrl}`);
    return externalUrl;
  }

  // Mode 2 & 3: Local server
  const port = config.apiPort ?? 9077;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Check if something is already running on this port
  if (await checkHealth(baseUrl)) {
    debugFn?.(`Existing server healthy on port ${port}`);
    return baseUrl;
  }

  // Mode 3: Auto-start daemon (only when allowed)
  if (!allowDaemonStart) {
    throw new Error(
      `No Hindsight server on port ${port}. Set hindsightApiUrl for external ` +
        'API, start hindsight-embed manually, or wait for the retain hook to ' +
        'auto-start the daemon.',
    );
  }

  debugFn?.(`No server on port ${port}, attempting daemon start`);

  try {
    await ensureDaemonRunning(config, port, debugFn);
  } catch (error) {
    debugFn?.(`Daemon start failed: ${errorText(error)}`);
    throw new Error(
      'No Hindsight server available. Set hindsightApiUrl for external API, ' +
        'or ensure hindsight-embed is installed for local daemon mode.',
      { cause: error },
    );
  }

  return baseUrl;
}

/**
 * Start the hindsight-embed daemon if not already running.
 *
 * Port of: HindsightServer.start() in @vectorize-io/hindsight-all
 */
async function ensureDaemonRunning(
  config: PluginConfig,
  port: number,
  debugFn?: DebugFn | null,
): Promise<void> {
  // Fast-fail if hindsight-embed toolchain is not available
  if (!isEmbedAvailable(config)) {
    throw new Error(
      'hindsight-embed not found (uvx not on PATH). ' +
        'Install with: pip install hindsight-embed, or set hindsightApiUrl.',
    );
  }

  const baseUrl = `http://127.0.0.1:${port}`;

  // Detect LLM config (needed for daemon's fact extraction)
  let llmConfig: LlmConfig;
  try {
    llmConfig = detectLlmConfig(config);
  } catch (error) {
    throw new Error(`Cannot start daemon: ${errorText(error)}`, { cause: error });
  }

  const llmEnv = getLlmEnvVars(llmConfig);

  // Build daemon environment
  const daemonEnv: NodeJS.ProcessEnv = { ...llmEnv };
  const idleTimeout = config.daemonIdleTimeout ?? 300;
  daemonEnv.HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT = String(idleTimeout);

  // On macOS, force CPU for embeddings/reranker (mirrors Openclaw)
  if (process.platform === 'darwin') {
    daemonEnv.HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU = '1';
    daemonEnv.HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU = '1';
  }

  // Step 1: Configure profile
  debugFn?.(`Configuring "${PROFILE_NAME}" profile...`);

  const profileArgs = ['profile', 'create', PROFILE_NAME, '--merge', '--port', String(port)];
  for (const [envName, envValue] of Object.entries(daemonEnv)) {
    if (envValue) {
      profileArgs.push('--env', `${envName}=${envValue}`);
    }
  }

  try {
    const result = runEmbed(config, profileArgs, daemonEnv, 10);
    if (result.returnCode !== 0) {
      debugFn?.(`Profile create stderr: ${result.stderr.trim()}`);
      throw new Error(`Profile create failed (exit ${result.returnCode}): ${result.stderr}`);
    }
    debugFn?.('Profile configured');
  } catch (error) {
    if (error instanceof EmbedTimeoutError) {
      throw new Error('Profile create timed out', { cause: error });
    }
    if (error instanceof EmbedNotFoundError) {
      throw new Error(
        'hindsight-embed not found. Install with: pip install hindsight-embed ' +
          'or set hindsightApiUrl for external API mode.',
        { cause: error },
      );
    }
    throw error;
  }

  // Step 2: Start daemon
  debugFn?.('Starting daemon...');

  try {
    const result = runEmbed(config, ['daemon', '--profile', PROFILE_NAME, 'start'], daemonEnv, 30);
    debugFn?.(`Daemon start exit=${result.returnCode} stdout=${result.stdout.trim()}`);
    if (result.returnCode !== 0 && !result.stderr.toLowerCase().includes('already running')) {
      throw new Error(`Daemon start failed (exit ${result.returnCode}): ${result.stderr}`);
    }
  } catch (error) {
    if (error instanceof EmbedTimeoutError) {
      throw new Error('Daemon start timed out', { cause: error });
    }
    throw error;
  }

  // Step 3: Wait for ready (poll health endpoint)
  debugFn?.('Waiting for daemon to be ready...');

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await checkHealth(baseUrl)) {
      debugFn?.(`Daemon ready after ${attempt + 1} attempts`);
      // Track that we started this daemon. Keys stay snake_case because the
      // state file is shared with installs previously written by the Python
      // plugin (stopDaemon reads the same field).
      writeState(DAEMON_STATE_FILE, {
        port,
        started_by_plugin: true,
        started_at: Date.now() / 1000,
        pid: process.pid,
      });
      return;
    }
    await sleep(1_000);
  }

  throw new Error('Daemon failed to become ready within 30 seconds');
}

/**
 * Fire off daemon startup in the background — non-blocking.
 *
 * Called from SessionStart hook to warm up the daemon before the first
 * recall or retain hook fires. Returns immediately; the daemon starts
 * asynchronously as a detached OS process.
 */
export async function prestartDaemonBackground(
  config: PluginConfig,
  debugFn?: DebugFn | null,
): Promise<void> {
  if (config.hindsightApiUrl) {
    return; // External API mode — no local daemon needed
  }

  const port = config.apiPort ?? 9077;
  if (await checkHealth(`http://127.0.0.1:${port}`)) {
    debugFn?.(`Daemon already running on port ${port}, skipping pre-start`);
    return;
  }

  if (!isEmbedAvailable(config)) {
    debugFn?.('hindsight-embed not available, skipping pre-start');
    return;
  }

  let llmConfig: LlmConfig;
  try {
    llmConfig = detectLlmConfig(config);
  } catch (error) {
    debugFn?.(`No LLM configured, skipping daemon pre-start: ${errorText(error)}`);
    return;
  }

  const llmEnv = getLlmEnvVars(llmConfig);
  const embedCommand = getEmbedCommand(config);
  const daemonEnv: NodeJS.ProcessEnv = { ...process.env, ...llmEnv };
  const idleTimeout = config.daemonIdleTimeout ?? 300;
  daemonEnv.HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT = String(idleTimeout);
  if (process.platform === 'darwin') {
    daemonEnv.HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU = '1';
    daemonEnv.HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU = '1';
  }

  // Note: pre-start bakes only the LLM env into the profile, unlike
  // ensureDaemonRunning(), which passes the idle timeout and force-CPU vars too.
  const profileArgs = ['profile', 'create', PROFILE_NAME, '--merge', '--port', String(port)];
  for (const [envName, envValue] of Object.entries(llmEnv)) {
    if (envValue) {
      profileArgs.push('--env', `${envName}=${envValue}`);
    }
  }

  // The original ran one shell command (`profile create ... && daemon ... start`)
  // in a new session so the warm-up survives this hook process.
  const command = [
    shellJoin([...embedCommand, ...profileArgs]),
    '&&',
    shellJoin([...embedCommand, 'daemon', '--profile', PROFILE_NAME, 'start']),
  ].join(' ');

  const child = spawn('/bin/sh', ['-c', command], {
    detached: true,
    stdio: 'ignore',
    env: daemonEnv,
  });
  // Fire-and-forget: a detached child must never surface an async 'error' event
  // that would take the hook down with it.
  child.on('error', () => {});
  child.unref();

  debugFn?.(`Daemon pre-start initiated in background (port ${port})`);
}

/**
 * Stop the daemon if it was started by this plugin.
 *
 * Called during cleanup. Only stops if we started it (tracked in state).
 */
export function stopDaemon(config: PluginConfig, debugFn?: DebugFn | null): void {
  const state = readState<Record<string, unknown>>(DAEMON_STATE_FILE, {});
  if (!state.started_by_plugin) {
    debugFn?.('Daemon not started by plugin, skipping stop');
    return;
  }

  debugFn?.('Stopping daemon...');

  try {
    const result = runEmbed(config, ['daemon', '--profile', PROFILE_NAME, 'stop'], null, 10);
    debugFn?.(`Daemon stop: ${result.stdout.trim()}`);
  } catch (error) {
    debugFn?.(`Daemon stop error: ${errorText(error)}`);
  }

  // Clear state
  writeState(DAEMON_STATE_FILE, {});
}

/**
 * Get the command to run hindsight-embed.
 *
 * Port of: getEmbedCommand() in @vectorize-io/hindsight-all
 */
function getEmbedCommand(config: PluginConfig): [string, ...string[]] {
  const embedPath = config.embedPackagePath;
  if (embedPath) {
    return ['uv', 'run', '--directory', embedPath, 'hindsight-embed'];
  }

  const version = config.embedVersion;
  const packageName = version ? `hindsight-embed@${version}` : 'hindsight-embed@latest';
  return ['uvx', packageName];
}

/** Result of a hindsight-embed invocation (the CompletedProcess fields we read). */
interface EmbedResult {
  returnCode: number;
  stdout: string;
  stderr: string;
}

/** Stands in for Python's `subprocess.TimeoutExpired` (Node reports `ETIMEDOUT`). */
class EmbedTimeoutError extends Error {}

/** Stands in for the `FileNotFoundError` a missing executable raises. */
class EmbedNotFoundError extends Error {}

/** Run a hindsight-embed command and return the result. */
function runEmbed(
  config: PluginConfig,
  args: readonly string[],
  env?: NodeJS.ProcessEnv | null,
  timeoutSeconds = 10,
): EmbedResult {
  const [executable, ...prefixArgs] = getEmbedCommand(config);
  const result = spawnSync(executable, [...prefixArgs, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: timeoutSeconds * 1_000,
    // Python's `subprocess.run` buffers output without a limit; Node's 1 MiB
    // default is small enough for `uvx` download progress to trip it.
    maxBuffer: 64 * 1024 * 1024,
  });

  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error) {
    if (error.code === 'ETIMEDOUT') {
      throw new EmbedTimeoutError(`hindsight-embed timed out after ${timeoutSeconds}s`);
    }
    if (error.code === 'ENOENT') {
      throw new EmbedNotFoundError(`Executable not found: ${executable}`);
    }
    throw error;
  }

  // Node leaves `status` null when the child died from a signal (Python reports
  // the negated signal number); -1 keeps "non-zero means failure" true.
  return {
    returnCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Quick check if hindsight-embed is available on PATH.
 *
 * Avoids the slow uvx download path when the tool isn't installed.
 */
function isEmbedAvailable(config: PluginConfig): boolean {
  const embedPath = config.embedPackagePath;
  if (embedPath) {
    return isDirectory(embedPath);
  }
  // Check for uvx or hindsight-embed on PATH
  return which('uvx') !== null || which('hindsight-embed') !== null;
}

/**
 * Quick health check against a Hindsight server.
 *
 * Default timeout is 10s (matching the recall hook budget): under load an
 * alive-but-busy daemon mid fact-extraction may not answer /health within a
 * couple of seconds. A too-short timeout yields a false negative, so
 * getApiUrl() falls through to ensureDaemonRunning() ->
 * `hindsight-embed daemon start`, whose _clear_port() then SIGTERMs the
 * live daemon -- a restart/kill loop. A 10s budget lets a busy daemon
 * respond before it is declared dead.
 */
async function checkHealth(baseUrl: string, timeoutSeconds = 10): Promise<boolean> {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/health`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutSeconds * 1_000),
    });
    return response.status === 200;
  } catch {
    // Refused, unreachable, timed out, or not HTTP — all mean "not healthy".
    return false;
  }
}

/** Python's `shlex.join()`: quote every argument for `/bin/sh`. */
function shellJoin(args: readonly string[]): string {
  return args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
}

/**
 * Python's `shutil.which()`: the first executable match on PATH, or null.
 * `PATHEXT` is not consulted — the plugin's hooks run under a POSIX shell.
 */
function which(command: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, command);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Not an executable here — keep looking.
    }
  }
  return null;
}

/** Python's `os.path.isdir()`. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Python's `str(exc)`: the bare message for Errors, a stringified value otherwise. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Python's `time.sleep()`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
