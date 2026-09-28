/**
 * Tests for src/lib/bank.ts — bank ID derivation and mission management.
 *
 * Migrated 1:1 from tests/test_bank.py. The Python suite patched
 * `subprocess.run` to fake `git rev-parse` output; the TypeScript implementation
 * shells out through `node:child_process.spawnSync`, so that is what gets mocked
 * here. `createEnvSandbox()` stands in for the Python `state_dir` fixture (env
 * isolation plus `$CLAUDE_PLUGIN_DATA/state`).
 */
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { BankMissionClient } from '../src/lib/bank';
import { deriveBankId, ensureBankMission, resolveProjectName } from '../src/lib/bank';
import type { PluginConfig } from '../src/lib/config';
import { DEFAULTS } from '../src/lib/config';
import { createEnvSandbox, type EnvSandbox } from './helpers';

/**
 * Stand-in for `spawnSync`. Hoisted so the `vi.mock` factory below can close
 * over it; every test sets the git output it wants (or that spawn failed).
 */
const spawnSyncMock = vi.hoisted(() =>
  vi.fn<
    (command: string, args: readonly string[], options?: unknown) => SpawnSyncReturns<string>
  >(),
);

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

let sandbox: EnvSandbox;

beforeEach(() => {
  sandbox = createEnvSandbox();
  spawnSyncMock.mockReset();
});

afterEach(() => {
  sandbox.restore();
});

/** Base config mirroring the Python suite's `_cfg()` helper. */
function cfg(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return { ...DEFAULTS, ...overrides };
}

/** Hook input mirroring the Python suite's `_hook()` helper. */
function hook(sessionId = 'sess-1', cwd = '/home/user/myproject'): Record<string, unknown> {
  return { session_id: sessionId, cwd };
}

/** Fake `spawnSync` result for a git call that ran and exited (`_mock_git`). */
function gitResult(stdout: string, status: number | null = 0): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout, stderr: '', status, signal: null };
}

/** Fake `spawnSync` result for a call that never produced a process. */
function spawnFailure(error: Error, status: number | null = null): SpawnSyncReturns<string> {
  return { pid: 0, output: [], stdout: '', stderr: '', status, signal: null, error };
}

type MissionSetter = (
  bankId: string,
  mission: string,
  retainMission?: string | null,
  timeout?: number,
) => Promise<unknown>;

/** Fake client: `ensureBankMission` only needs `setBankMission` (a MagicMock). */
function fakeClient(): BankMissionClient & { setBankMission: Mock<MissionSetter> } {
  return { setBankMission: vi.fn<MissionSetter>().mockResolvedValue({}) };
}

/** Read a state file straight out of the sandbox's state directory. */
function stateFileContents(name: string): Record<string, unknown> | null {
  const path = join(sandbox.stateDir, name);
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('DeriveBankIdStatic', () => {
  it('uses the default bank in static mode', () => {
    expect(deriveBankId(hook(), cfg())).toBe('claude_code');
  });

  it('honours a custom bankId', () => {
    expect(deriveBankId(hook(), cfg({ bankId: 'my-agent' }))).toBe('my-agent');
  });

  it('prefixes the bank id', () => {
    expect(deriveBankId(hook(), cfg({ bankId: 'bot', bankIdPrefix: 'prod' }))).toBe('prod-bot');
  });

  it('falls back to the default bank when bankId is null', () => {
    // Same bank as an unset `bankId` — the fallback is the shipped default, not
    // a constant of its own.
    expect(deriveBankId(hook(), cfg({ bankId: null, bankIdPrefix: 'dev' }))).toBe(
      'dev-claude_code',
    );
  });
});

describe('DeriveBankIdDynamic', () => {
  it('composes the agent and project fields', () => {
    const config = cfg({
      dynamicBankId: true,
      agentName: 'mybot',
      dynamicBankGranularity: ['agent', 'project'],
    });
    expect(deriveBankId(hook('sess-1', '/home/user/hindsight'), config)).toBe('mybot::hindsight');
  });

  it('leaves special characters in the project name raw', () => {
    const config = cfg({ dynamicBankId: true, dynamicBankGranularity: ['project'] });
    const result = deriveBankId(hook('sess-1', '/home/user/my project'), config);
    expect(result).toContain('my project');
    expect(result).not.toContain('%');
  });

  it('leaves UTF-8 project names raw', () => {
    const config = cfg({ dynamicBankId: true, dynamicBankGranularity: ['project'] });
    const result = deriveBankId(hook('sess-1', '/home/user/мой проект'), config);
    expect(result).toContain('мой проект');
    expect(result).not.toContain('%');
  });

  it('includes the session id', () => {
    const config = cfg({ dynamicBankId: true, dynamicBankGranularity: ['session'] });
    expect(deriveBankId(hook('abc-123'), config)).toContain('abc-123');
  });

  it('prefixes the composed bank id', () => {
    const config = cfg({
      dynamicBankId: true,
      dynamicBankGranularity: ['agent'],
      bankIdPrefix: 'v2',
    });
    expect(deriveBankId(hook(), config).startsWith('v2-')).toBe(true);
  });

  it('reads the channel from the environment', () => {
    sandbox.setEnv('HINDSIGHT_CHANNEL_ID', 'telegram-123');
    const config = cfg({ dynamicBankId: true, dynamicBankGranularity: ['channel'] });
    expect(deriveBankId(hook(), config)).toContain('telegram-123');
  });

  it('reads the user from the environment', () => {
    sandbox.setEnv('HINDSIGHT_USER_ID', 'user-456');
    const config = cfg({ dynamicBankId: true, dynamicBankGranularity: ['user'] });
    expect(deriveBankId(hook(), config)).toContain('user-456');
  });

  it('falls back to default and anonymous when the env vars are unset', () => {
    const config = cfg({ dynamicBankId: true, dynamicBankGranularity: ['channel', 'user'] });
    const result = deriveBankId(hook(), config);
    expect(result).toContain('default');
    expect(result).toContain('anonymous');
  });

  it('uses "unknown" for an empty cwd', () => {
    const config = cfg({ dynamicBankId: true, dynamicBankGranularity: ['project'] });
    expect(deriveBankId({ session_id: 's', cwd: '' }, config)).toContain('unknown');
  });

  it('warns about a granularity field Claude Code does not support', () => {
    // Not covered by the Python suite, but the warning is the only signal a
    // misspelled setting produces, so its text is pinned here.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = cfg({ dynamicBankId: true, dynamicBankGranularity: ['agent', 'bogus'] });

    const result = deriveBankId(hook(), config);

    expect(errorSpy).toHaveBeenCalledWith(
      '[Hindsight] Unknown dynamicBankGranularity field "bogus" — valid for Claude Code: ' +
        'agent, channel, project, session, user',
    );
    // The unknown field still occupies a segment, resolved to "unknown".
    expect(result).toBe('claude-code::unknown');
  });

  it('resolves a worktree to the main repository', () => {
    spawnSyncMock.mockReturnValue(gitResult('/home/user/myproject/.git\n'));

    const config = cfg({
      dynamicBankId: true,
      agentName: 'bot',
      dynamicBankGranularity: ['agent', 'project'],
    });
    // Working in a worktree, but should resolve to the main repo name.
    expect(deriveBankId(hook('sess-1', '/home/user/myproject-wt1'), config)).toBe('bot::myproject');
  });
});

describe('ResolveProjectName', () => {
  it('uses the repo directory name for a regular repo', () => {
    spawnSyncMock.mockReturnValue(gitResult('/home/user/myproject/.git\n'));
    expect(resolveProjectName('/home/user/myproject', cfg())).toBe('myproject');
  });

  it('resolves a worktree to the main repo', () => {
    // Worktree at /home/user/myproject-wt1, main repo at /home/user/myproject.
    spawnSyncMock.mockReturnValue(gitResult('/home/user/myproject/.git\n'));
    expect(resolveProjectName('/home/user/myproject-wt1', cfg())).toBe('myproject');
  });

  it('resolves a worktree that lives elsewhere', () => {
    // Worktree at /tmp/worktrees/feature-x, main repo at /home/user/hindsight.
    spawnSyncMock.mockReturnValue(gitResult('/home/user/hindsight/.git\n'));
    expect(resolveProjectName('/tmp/worktrees/feature-x', cfg())).toBe('hindsight');
  });

  it('resolves a bare hub to its hidden directory parent', () => {
    spawnSyncMock
      .mockReturnValueOnce(gitResult('/home/user/myrepo/.bare\n'))
      .mockReturnValueOnce(gitResult('true\n'));
    expect(resolveProjectName('/home/user/myrepo/main', cfg())).toBe('myrepo');
  });

  it('keeps the directory name of a standalone bare clone', () => {
    spawnSyncMock.mockReturnValue(gitResult('/srv/repos/myproject.git\n'));
    expect(resolveProjectName('/srv/repos/myproject.git', cfg())).toBe('myproject.git');
  });

  it('falls back to the basename when worktree resolution is disabled', () => {
    expect(resolveProjectName('/home/user/myproject-wt1', cfg({ resolveWorktrees: false }))).toBe(
      'myproject-wt1',
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('falls back to the basename when git throws', () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error('git not found');
    });
    expect(resolveProjectName('/home/user/myproject', cfg())).toBe('myproject');
  });

  it('falls back to the basename when spawnSync reports ENOENT', () => {
    // Node's real shape for a missing binary: a result carrying `error`, not a
    // thrown exception (Python's OSError equivalent).
    spawnSyncMock.mockReturnValue(spawnFailure(new Error('spawnSync git ENOENT')));
    expect(resolveProjectName('/home/user/myproject', cfg())).toBe('myproject');
  });

  it('falls back to the basename when the directory is not a git repo', () => {
    spawnSyncMock.mockReturnValue(gitResult('', 128));
    expect(resolveProjectName('/home/user/plaindir', cfg())).toBe('plaindir');
  });

  it('falls back to the basename when git times out', () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error('Command timed out');
    });
    expect(resolveProjectName('/home/user/myproject', cfg())).toBe('myproject');
  });

  it('falls back to the basename when spawnSync reports a timeout', () => {
    // Same real-shape check as ENOENT: the timeout surfaces as `error` + a null
    // status rather than as an exception.
    spawnSyncMock.mockReturnValue(spawnFailure(new Error('spawnSync git ETIMEDOUT')));
    expect(resolveProjectName('/home/user/myproject', cfg())).toBe('myproject');
  });

  it('returns "unknown" for an empty cwd', () => {
    expect(resolveProjectName('', cfg())).toBe('unknown');
  });
});

describe('DirectoryBankMap', () => {
  it('matches an exact directory', () => {
    const config = cfg({ directoryBankMap: { '/home/user/myproject': 'custom-bank' } });
    expect(deriveBankId(hook('sess-1', '/home/user/myproject'), config)).toBe('custom-bank');
  });

  it('matches a directory with a trailing slash', () => {
    const config = cfg({ directoryBankMap: { '/home/user/myproject/': 'custom-bank' } });
    expect(deriveBankId(hook('sess-1', '/home/user/myproject'), config)).toBe('custom-bank');
  });

  it.skipIf(process.platform !== 'win32')(
    'matches a Windows drive-letter path case-insensitively',
    () => {
      // On Windows the cwd's case depends on the launcher: PowerShell and git-bash
      // hand children an UPPERCASE drive while the VS Code extension spawn reports
      // lowercase. The map must not depend on the launcher. normcase is a no-op on
      // POSIX, so this only runs on Windows; the POSIX test below pins the
      // complementary guarantee.
      const config = cfg({ directoryBankMap: { 'c:\\Users\\dev\\proj': 'custom-bank' } });
      expect(deriveBankId(hook('sess-1', 'C:\\Users\\dev\\proj'), config)).toBe('custom-bank');
    },
  );

  it.skipIf(process.platform === 'win32')('keeps POSIX paths case-sensitive', () => {
    const config = cfg({
      directoryBankMap: { '/home/User/myproject': 'custom-bank' },
      bankId: 'default-bank',
    });
    expect(deriveBankId(hook('sess-1', '/home/user/myproject'), config)).toBe('default-bank');
  });

  it('falls through to the static bank when nothing matches', () => {
    const config = cfg({
      directoryBankMap: { '/home/user/other': 'other-bank' },
      bankId: 'default-bank',
    });
    expect(deriveBankId(hook('sess-1', '/home/user/myproject'), config)).toBe('default-bank');
  });

  it('falls through to dynamic mode when nothing matches', () => {
    const config = cfg({
      directoryBankMap: { '/home/user/other': 'other-bank' },
      dynamicBankId: true,
      agentName: 'bot',
      dynamicBankGranularity: ['agent'],
      resolveWorktrees: false,
    });
    expect(deriveBankId(hook('sess-1', '/home/user/myproject'), config)).toBe('bot');
  });

  it('applies the bank id prefix to the mapped bank', () => {
    const config = cfg({
      directoryBankMap: { '/home/user/myproject': 'custom-bank' },
      bankIdPrefix: 'prod',
    });
    expect(deriveBankId(hook('sess-1', '/home/user/myproject'), config)).toBe('prod-custom-bank');
  });

  it('takes precedence over dynamic mode', () => {
    const config = cfg({
      directoryBankMap: { '/home/user/myproject': 'explicit-bank' },
      dynamicBankId: true,
      agentName: 'bot',
      dynamicBankGranularity: ['agent', 'project'],
    });
    expect(deriveBankId(hook('sess-1', '/home/user/myproject'), config)).toBe('explicit-bank');
  });

  it('ignores an empty map', () => {
    const config = cfg({ directoryBankMap: {}, bankId: 'default-bank' });
    expect(deriveBankId(hook(), config)).toBe('default-bank');
  });

  it('skips the map for an empty cwd', () => {
    const config = cfg({
      directoryBankMap: { '/some/path': 'mapped-bank' },
      bankId: 'fallback',
    });
    expect(deriveBankId({ session_id: 's', cwd: '' }, config)).toBe('fallback');
  });

  it('matches each entry of a multi-entry map', () => {
    const config = cfg({
      directoryBankMap: {
        '/home/user/project-a': 'bank-a',
        '/home/user/project-b': 'bank-b',
      },
    });
    expect(deriveBankId(hook('sess-1', '/home/user/project-a'), config)).toBe('bank-a');
    expect(deriveBankId(hook('sess-1', '/home/user/project-b'), config)).toBe('bank-b');
  });
});

describe('EnsureBankMission', () => {
  it('sets the mission on the first call', async () => {
    const client = fakeClient();
    // `retainMission` is pinned rather than inherited: the built-in default is
    // a real retention prompt, and this case is about the mission being sent at
    // all, not about what the retain mission happens to default to.
    const config = cfg({
      bankMission: 'You are a helpful assistant.',
      retainMission: null,
      bankId: 'test-bank',
    });
    await ensureBankMission(client, 'test-bank', config);
    expect(client.setBankMission).toHaveBeenCalledOnce();
    expect(client.setBankMission).toHaveBeenCalledWith(
      'test-bank',
      'You are a helpful assistant.',
      null,
      10,
    );
  });

  it('skips if the mission was already set', async () => {
    const client = fakeClient();
    const config = cfg({ bankMission: 'mission text' });
    await ensureBankMission(client, 'bank-a', config);
    await ensureBankMission(client, 'bank-a', config); // second call
    expect(client.setBankMission).toHaveBeenCalledTimes(1);
    expect(stateFileContents('bank_missions.json')).toEqual({ 'bank-a': true });
  });

  it('skips if the mission is empty', async () => {
    const client = fakeClient();
    await ensureBankMission(client, 'bank-b', cfg({ bankMission: '' }));
    expect(client.setBankMission).not.toHaveBeenCalled();
  });

  it('includes the retain mission if set', async () => {
    const client = fakeClient();
    const config = cfg({ bankMission: 'reflect mission', retainMission: 'retain mission' });
    await ensureBankMission(client, 'bank-c', config);
    expect(client.setBankMission).toHaveBeenCalledWith(
      'bank-c',
      'reflect mission',
      'retain mission',
      10,
    );
  });

  it('does not raise on an API error', async () => {
    const client = fakeClient();
    client.setBankMission.mockRejectedValue(new Error('server down'));
    const debug = vi.fn();
    const config = cfg({ bankMission: 'mission' });

    await expect(ensureBankMission(client, 'bank-d', config, debug)).resolves.toBeUndefined();

    // Best-effort only: the failure is logged, and the bank is left unmarked so
    // a later hook invocation retries instead of skipping the mission forever.
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('bank-d'));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('server down'));
    expect(stateFileContents('bank_missions.json')).toBeNull();
  });

  it('sets different banks each once', async () => {
    const client = fakeClient();
    const config = cfg({ bankMission: 'mission' });
    await ensureBankMission(client, 'bank-x', config);
    await ensureBankMission(client, 'bank-y', config);
    expect(client.setBankMission).toHaveBeenCalledTimes(2);
  });

  // The Python file filed this case under TestEnsureBankMission too (it does not
  // touch `ensure_bank_mission`); kept here to preserve the 1:1 mapping.
  it('matches a symlinked cwd in directoryBankMap', () => {
    const real = join(sandbox.root, 'proj');
    mkdirSync(real);
    const link = join(sandbox.root, 'proj-link');
    symlinkSync(real, link);

    const config = cfg({
      directoryBankMap: { [realpathSync(real)]: 'myproj' },
      bankId: 'fallback',
    });
    expect(deriveBankId({ cwd: realpathSync(real), session_id: 's' }, config)).toBe('myproj');
    expect(deriveBankId({ cwd: link, session_id: 's' }, config)).toBe('myproj');
  });
});
