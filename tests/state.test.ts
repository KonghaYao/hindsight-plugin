/**
 * Tests for src/lib/state.ts — retention tracking, compaction detection and the
 * read/write helpers.
 *
 * Migrated 1:1 from tests/test_state.py. The Python `_isolated_state` fixture
 * (CLAUDE_PLUGIN_DATA pointed at tmp_path) is `createEnvSandbox()`, whose
 * `stateDir` is `<pluginData>/state` — the same layout the Python fixture used.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitRetention,
  incrementTurnCount,
  planRetention,
  readState,
  safeFilename,
  stateFile,
  trackRetention,
  writeState,
} from '../src/lib/state';
import { createEnvSandbox, type EnvSandbox } from './helpers';

describe('TrackRetention', () => {
  let sandbox: EnvSandbox;

  beforeEach(() => {
    sandbox = createEnvSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('first call returns chunk zero', () => {
    const progress = trackRetention('sess-1', 10);
    expect(progress.chunkIndex).toBe(0);
    expect(progress.compacted).toBe(false);
    expect(progress.startIndex).toBe(0);
  });

  it('growing transcript advances chunk and starts at last count', () => {
    trackRetention('sess-1', 4);
    const progress = trackRetention('sess-1', 8);
    expect(progress.chunkIndex).toBe(1);
    expect(progress.compacted).toBe(false);
    expect(progress.startIndex).toBe(4);
  });

  it('equal count keeps same chunk and skips all messages', () => {
    trackRetention('sess-1', 5);
    const progress = trackRetention('sess-1', 5);
    expect(progress.chunkIndex).toBe(0);
    expect(progress.compacted).toBe(false);
    expect(progress.startIndex).toBe(5);
  });

  it('shrinking transcript triggers compaction', () => {
    trackRetention('sess-1', 10);
    const progress = trackRetention('sess-1', 3);
    expect(progress.chunkIndex).toBe(1);
    expect(progress.compacted).toBe(true);
    expect(progress.startIndex).toBe(0);
  });

  it('multiple compactions increment chunk', () => {
    trackRetention('sess-1', 10);

    const first = trackRetention('sess-1', 3);
    expect(first.chunkIndex).toBe(1);
    expect(first.compacted).toBe(true);
    expect(first.startIndex).toBe(0);

    // Grow again after compaction.
    trackRetention('sess-1', 8);

    // Second compaction.
    const second = trackRetention('sess-1', 2);
    expect(second.chunkIndex).toBe(3);
    expect(second.compacted).toBe(true);
    expect(second.startIndex).toBe(0);
  });

  it('growth after compaction advances to next delta chunk', () => {
    trackRetention('sess-1', 10);
    trackRetention('sess-1', 3); // compaction -> chunk 1

    const progress = trackRetention('sess-1', 6);
    expect(progress.chunkIndex).toBe(2);
    expect(progress.compacted).toBe(false);
    expect(progress.startIndex).toBe(3);
  });

  it('sessions are independent', () => {
    trackRetention('sess-a', 10);
    trackRetention('sess-b', 20);

    // Compaction on sess-a only.
    const progressA = trackRetention('sess-a', 3);
    const progressB = trackRetention('sess-b', 25);

    expect(progressA.chunkIndex).toBe(1);
    expect(progressA.compacted).toBe(true);
    expect(progressA.startIndex).toBe(0);
    expect(progressB.chunkIndex).toBe(1);
    expect(progressB.compacted).toBe(false);
    expect(progressB.startIndex).toBe(20);
  });

  it('persists across calls', () => {
    // State file is written to disk and survives between calls.
    trackRetention('sess-1', 10);

    const path = join(sandbox.stateDir, 'retention_tracking.json');
    expect(existsSync(path)).toBe(true);

    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(data['sess-1'].message_count).toBe(10);
    expect(data['sess-1'].chunk).toBe(0);
  });

  it('compaction from one message', () => {
    // Edge case: transcript shrinks to a single message.
    trackRetention('sess-1', 50);
    const progress = trackRetention('sess-1', 1);
    expect(progress.chunkIndex).toBe(1);
    expect(progress.compacted).toBe(true);
    expect(progress.startIndex).toBe(0);
  });

  it('shrink by one triggers compaction', () => {
    // Even shrinking by a single message counts as compaction.
    trackRetention('sess-1', 10);
    const progress = trackRetention('sess-1', 9);
    expect(progress.chunkIndex).toBe(1);
    expect(progress.compacted).toBe(true);
    expect(progress.startIndex).toBe(0);
  });
});

describe('PlanCommitRetention', () => {
  let sandbox: EnvSandbox;

  beforeEach(() => {
    sandbox = createEnvSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('plan does not persist checkpoint', () => {
    const progress = planRetention('sess-1', 4);
    expect(progress.chunkIndex).toBe(0);
    expect(progress.compacted).toBe(false);
    expect(progress.startIndex).toBe(0);
    expect(readState('retention_tracking.json', {})).toEqual({});
  });

  it('commit advances next plan', () => {
    commitRetention('sess-1', 4, 0);
    const progress = planRetention('sess-1', 7);
    expect(progress.chunkIndex).toBe(1);
    expect(progress.compacted).toBe(false);
    expect(progress.startIndex).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// read_state / write_state basics
// ---------------------------------------------------------------------------

describe('ReadWriteState', () => {
  let sandbox: EnvSandbox;

  beforeEach(() => {
    sandbox = createEnvSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('read nonexistent returns default', () => {
    expect(readState<Record<string, unknown> | null>('does_not_exist.json', null)).toBeNull();
    expect(readState('does_not_exist.json', { key: 'val' })).toEqual({ key: 'val' });
  });

  it('write then read roundtrips', () => {
    writeState('test_roundtrip.json', { foo: 42 });
    expect(readState('test_roundtrip.json', {})).toEqual({ foo: 42 });
  });

  it('write overwrites previous', () => {
    writeState('test_overwrite.json', { v: 1 });
    writeState('test_overwrite.json', { v: 2 });
    expect(readState('test_overwrite.json', {})).toEqual({ v: 2 });
  });
});

// ---------------------------------------------------------------------------
// Filename sanitizing, the traversal guard and the turn counter.
//
// The Python suite has no equivalent of these three blocks (its
// `test_state.py` only covers retention and read/write); they are added here
// because `safeFilename` / `stateFile` are the security-relevant surface of the
// port and `incrementTurnCount` was previously untested.
// ---------------------------------------------------------------------------

describe('SafeFilename', () => {
  it('replaces path separators and reserved characters', () => {
    expect(safeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('neutralises .. sequences', () => {
    expect(safeFilename('../etc/passwd')).toBe('__etc_passwd');
  });

  it('falls back to "state" for an empty name', () => {
    expect(safeFilename('')).toBe('state');
  });

  it('truncates to 200 characters', () => {
    expect(safeFilename('a'.repeat(250))).toHaveLength(200);
  });
});

describe('StateFile', () => {
  let sandbox: EnvSandbox;

  beforeEach(() => {
    sandbox = createEnvSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('keeps a traversal-shaped name inside the state directory', () => {
    const path = stateFile('../../outside.json');
    expect(path.startsWith(`${sandbox.stateDir}/`)).toBe(true);
  });

  it('places a plain name directly in the state directory', () => {
    expect(stateFile('turns.json')).toBe(join(sandbox.stateDir, 'turns.json'));
  });
});

describe('WriteStateAtomic', () => {
  let sandbox: EnvSandbox;

  beforeEach(() => {
    sandbox = createEnvSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('leaves no temp file behind', () => {
    writeState('atomic.json', { ok: true });
    expect(existsSync(join(sandbox.stateDir, 'atomic.json'))).toBe(true);
    expect(existsSync(join(sandbox.stateDir, 'atomic.json.tmp'))).toBe(false);
    expect(readState('atomic.json', {})).toEqual({ ok: true });
  });
});

describe('IncrementTurnCount', () => {
  let sandbox: EnvSandbox;

  beforeEach(() => {
    sandbox = createEnvSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('counts turns per session and persists them', () => {
    expect(incrementTurnCount('sess-1')).toBe(1);
    expect(incrementTurnCount('sess-1')).toBe(2);
    expect(readState('turns.json', {})).toEqual({ 'sess-1': 2 });
  });

  it('tracks sessions separately', () => {
    incrementTurnCount('sess-a');
    expect(incrementTurnCount('sess-b')).toBe(1);
    expect(incrementTurnCount('sess-a')).toBe(2);
    expect(readState('turns.json', {})).toEqual({ 'sess-a': 2, 'sess-b': 1 });
  });

  it('releases the lock file it took', () => {
    incrementTurnCount('sess-1');
    expect(existsSync(join(sandbox.stateDir, 'turns.lock'))).toBe(false);
  });
});
