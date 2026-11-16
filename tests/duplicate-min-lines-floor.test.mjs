/**
 * @fileoverview The duplicate-cluster size floor — everything around the SQL
 * predicate (the predicate itself is exercised on a real Postgres in
 * tests/symbol-index-drift-justification.test.mjs). Plan:
 * docs/plans/duplicate-min-lines-floor.md.
 *
 * Pins: one input contract (flag > env > default, malformed = hard error),
 * four distinguishable floor states (none renders an unknown as 0), the exit
 * rule for an unsupported store, the CLI's argument handling, and that the new
 * module ships to consumers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  DEFAULT_DUPLICATE_MIN_LINES,
  MAX_DUPLICATE_MIN_LINES,
  FloorArgError,
  resolveMinLines,
  readMinLinesFlag,
  buildFloorState,
  floorExitCode,
  renderFloorLines,
} from '../scripts/lib/symbol-index/duplicate-floor.mjs';
import { renderText } from '../scripts/symbol-index/duplicates.mjs';
import { getSyncClosure } from '../scripts/lib/sync-inventory.mjs';

const stats = { suppressed_clusters: 5, clusters_before: 9, clusters_after: 4, pairs_before: 7, pairs_after: 2, rows_suppressed: 10 };

describe('resolveMinLines — flag > env > default, one parser', () => {
  it('the floor is OPT-IN: the default is 0 (off), so no consumer population changes silently', () => {
    assert.equal(DEFAULT_DUPLICATE_MIN_LINES, 0);
    assert.deepEqual(resolveMinLines({ flag: undefined, env: '' }), { minLines: 0, source: 'default' });
    assert.equal(buildFloorState(resolveMinLines({ flag: undefined, env: '' })).enabled, false);
    assert.deepEqual(resolveMinLines({ flag: '6', env: '' }), { minLines: 6, source: 'flag' }, 'an explicit 6 opts in');
  });
  it('env overrides the default; the flag overrides env', () => {
    assert.deepEqual(resolveMinLines({ flag: undefined, env: '9' }), { minLines: 9, source: 'env' });
    assert.deepEqual(resolveMinLines({ flag: '3', env: '9' }), { minLines: 3, source: 'flag' });
  });
  it('an explicit 0 is honoured (floor off), not coerced to the default', () => {
    assert.deepEqual(resolveMinLines({ flag: '0', env: '9' }), { minLines: 0, source: 'flag' });
    assert.deepEqual(resolveMinLines({ flag: undefined, env: '0' }), { minLines: 0, source: 'env' });
  });
  it('an empty env var is unset, not an error', () => {
    assert.equal(resolveMinLines({ flag: undefined, env: '' }).source, 'default');
  });
  it('malformed values are HARD errors — never a silent fall back to the default', () => {
    for (const bad of ['1O', '-3', '2.5', 'abc', '', ' ', '0x10', '1e2']) {
      assert.throws(() => resolveMinLines({ flag: bad }), FloorArgError, `flag ${JSON.stringify(bad)}`);
    }
    assert.throws(() => resolveMinLines({ flag: undefined, env: 'banana' }), FloorArgError);
    assert.throws(() => resolveMinLines({ flag: null }), FloorArgError, 'a flag with no value is an error, not "unset"');
  });
  it('the upper bound is enforced, and the bound itself is legal', () => {
    assert.equal(resolveMinLines({ flag: String(MAX_DUPLICATE_MIN_LINES) }).minLines, MAX_DUPLICATE_MIN_LINES);
    assert.throws(() => resolveMinLines({ flag: String(MAX_DUPLICATE_MIN_LINES + 1) }), FloorArgError);
  });
});

describe('readMinLinesFlag', () => {
  it('reads both spellings, and distinguishes absent (undefined) from valueless (null)', () => {
    assert.equal(readMinLinesFlag(['--json']), undefined);
    assert.equal(readMinLinesFlag(['--min-lines', '8']), '8');
    assert.equal(readMinLinesFlag(['--min-lines=8']), '8');
    assert.equal(readMinLinesFlag(['--min-lines']), null);
    assert.equal(readMinLinesFlag(['--min-lines', '--json']), null, 'the next flag is not the value');
    assert.equal(readMinLinesFlag(['--', '--min-lines=0']), undefined, 'after the POSIX terminator a token is positional');
    assert.equal(readMinLinesFlag(['--min-lines', '4', '--', '--min-lines=0']), '4');
  });
});

describe('buildFloorState — four states, none renders an unknown as 0', () => {
  const r = { minLines: 6, source: 'default' };
  it('applied: carries the measured counts', () => {
    const s = buildFloorState(r, { stats });
    assert.equal(s.applied, true);
    assert.equal(s.suppressedClusters, 5);
    assert.equal(s.pairsBefore - s.pairsAfter, 5, 'pairs explain the score change');
  });
  it('count unavailable: suppressedClusters is null, never 0', () => {
    const s = buildFloorState(r, { stats: null });
    assert.equal(s.suppressedClusters, null);
    assert.equal(s.reason, 'count-unavailable');
    assert.equal(buildFloorState(r, { stats: { suppressed_clusters: null } }).suppressedClusters, null);
  });
  it('unsupported store: not applied, count null', () => {
    const s = buildFloorState(r, { unsupported: true });
    assert.deepEqual([s.applied, s.suppressedClusters, s.reason], [false, null, 'store-not-migrated']);
  });
  it('malformed counts are unavailable, never a measured zero ("", false, [], negative, fractional, numeric string)', () => {
    for (const bad of ['', false, [], -1, 1.5, '3', NaN, null, undefined]) {
      const s = buildFloorState(r, { stats: { ...stats, suppressed_clusters: bad } });
      assert.equal(s.suppressedClusters, null, JSON.stringify(bad));
      assert.equal(s.reason, 'count-unavailable');
    }
    const partial = buildFloorState(r, { stats: { ...stats, pairs_before: '' } });
    assert.equal(partial.pairsBefore, null);
    assert.equal(partial.suppressedClusters, 5, 'a bad auxiliary field does not discard the good primary one');
  });
  it('floor off: genuinely 0 suppressed, and says it is off', () => {
    const s = buildFloorState({ minLines: 0, source: 'flag' }, { stats: null });
    assert.deepEqual([s.enabled, s.applied, s.suppressedClusters], [false, false, 0]);
  });
});

describe('floorExitCode — an explicit floor the store cannot honour fails; an inherited one degrades visibly', () => {
  it('default-sourced + unsupported => no forced exit', () => {
    assert.equal(floorExitCode(buildFloorState({ minLines: 6, source: 'default' }, { unsupported: true })), null);
  });
  it('flag/env-sourced + unsupported => exit 2', () => {
    assert.equal(floorExitCode(buildFloorState({ minLines: 6, source: 'flag' }, { unsupported: true })), 2);
    assert.equal(floorExitCode(buildFloorState({ minLines: 6, source: 'env' }, { unsupported: true })), 2);
  });
  it('applied or off => no forced exit (direction that must NOT fire)', () => {
    assert.equal(floorExitCode(buildFloorState({ minLines: 6, source: 'flag' }, { stats })), null);
    assert.equal(floorExitCode(buildFloorState({ minLines: 0, source: 'flag' })), null);
  });
});

describe('renderFloorLines / renderText', () => {
  it('reports the suppressed count', () => {
    assert.match(renderFloorLines(buildFloorState({ minLines: 6, source: 'default' }, { stats })).join('\n'), /suppressed 5 cluster/);
  });
  it('an unknown count reads UNKNOWN, an unsupported store reads NOT APPLIED — neither reads 0', () => {
    const unknown = renderFloorLines(buildFloorState({ minLines: 6, source: 'default' }, { stats: null })).join('\n');
    assert.match(unknown, /UNKNOWN/);
    assert.doesNotMatch(unknown, /suppressed 0/);
    const unsupported = renderFloorLines(buildFloorState({ minLines: 6, source: 'default' }, { unsupported: true })).join('\n');
    assert.match(unsupported, /NOT APPLIED/);
    assert.doesNotMatch(unsupported, /suppressed 0/);
  });
  it('the zero-cluster text carries the floor line, so "clean" is never printed without it', () => {
    const out = renderText([], 'repo', { truncated: false, limit: 20, symbolCount: 10, store: null,
      floor: buildFloorState({ minLines: 6, source: 'default' }, { stats }) });
    assert.match(out, /no cross-file exact-duplicate clusters/);
    assert.match(out, /suppressed 5 cluster/);
  });
  it('the cluster-list text carries the floor line too', () => {
    const c = { kind: 'function', symbolNames: ['f'], fileCount: 2, filePaths: ['a', 'b'], examplePurpose: null };
    const out = renderText([c], 'repo', { truncated: false, limit: 20, floor: buildFloorState({ minLines: 6, source: 'flag' }, { unsupported: true }) });
    assert.match(out, /NOT APPLIED/);
  });
});

describe('arch:duplicates CLI — argument handling (no store needed: bad input exits before any I/O)', () => {
  const cli = path.join(process.cwd(), 'scripts', 'symbol-index', 'duplicates.mjs');
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', env: { ...process.env, AUDIT_DB_URL: '', ARCH_DUPLICATE_MIN_LINES: '', ...env },
  });
  it('--help documents the floor', () => {
    const r = run(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--min-lines/);
  });
  it('malformed --min-lines / env exit 2 with a diagnostic', () => {
    for (const args of [['--min-lines', '1O'], ['--min-lines'], ['--min-lines=-3'], ['--min-lines', '99999']]) {
      const r = run(args);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, /--min-lines/);
    }
    const e = run([], { ARCH_DUPLICATE_MIN_LINES: 'banana' });
    assert.equal(e.status, 2);
    assert.match(e.stderr, /ARCH_DUPLICATE_MIN_LINES/);
  });
  it('a valid floor with the cloud disabled keeps the existing contract (exit 2, no RPC)', () => {
    const r = run(['--min-lines', '8']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cloud disabled/);
  });
});

describe('consumer distribution — the new module ships with the CLI that imports it', () => {
  it('duplicates.mjs and duplicate-floor.mjs are both in the sync closure', () => {
    const { files } = getSyncClosure();
    assert.ok(files.includes('scripts/symbol-index/duplicates.mjs'));
    assert.ok(files.includes('scripts/lib/symbol-index/duplicate-floor.mjs'),
      'a consumer running scripts/.claude-skills/symbol-index/duplicates.mjs would crash on import without it');
  });
});
