import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  loadStats,
  shouldSkipPattern,
  aggregateDecisions,
  rebuildFromBootstrap,
  rebuildFromCloud,
  _internals,
} from '../scripts/lib/learning/quickfix-stats.mjs';

function fakeStore(overrides = {}) {
  return {
    isCloudEnabled: async () => true,
    initLearningStore: async () => {},
    ...overrides,
  };
}

// ── aggregateDecisions ────────────────────────────────────────────────────

describe('quickfix-stats / aggregateDecisions', () => {
  it('counts accept → alpha, suppress/ignore → beta, no_action → not counted', () => {
    const decisions = [
      { context: { pattern: 'p1' }, outcome: { action: 'accept' } },
      { context: { pattern: 'p1' }, outcome: { action: 'accept' } },
      { context: { pattern: 'p1' }, outcome: { action: 'suppress' } },
      { context: { pattern: 'p1' }, outcome: { action: 'ignore' } },
      { context: { pattern: 'p1' }, outcome: { action: 'no_action' } },
    ];
    const stats = aggregateDecisions(decisions);
    assert.equal(stats.p1.alpha, 2);
    assert.equal(stats.p1.beta, 2);
    assert.equal(stats.p1.totalHits, 5);
    assert.ok(stats.p1.acceptanceRate > 0.4 && stats.p1.acceptanceRate < 0.6);
  });

  it('groups multiple patterns independently', () => {
    const decisions = [
      { context: { pattern: 'p1' }, outcome: { action: 'accept' } },
      { context: { pattern: 'p2' }, outcome: { action: 'suppress' } },
    ];
    const stats = aggregateDecisions(decisions);
    assert.equal(stats.p1.alpha, 1);
    assert.equal(stats.p2.beta, 1);
  });

  it('skips entries with missing pattern', () => {
    const decisions = [
      { context: {}, outcome: { action: 'accept' } },
      { context: { pattern: 'p1' }, outcome: { action: 'accept' } },
    ];
    const stats = aggregateDecisions(decisions);
    assert.equal(Object.keys(stats).length, 1);
    assert.ok(stats.p1);
  });

  it('skips entries with no outcome', () => {
    const decisions = [
      { context: { pattern: 'p1' }, outcome: null },
      { context: { pattern: 'p1' }, outcome: { action: 'accept' } },
    ];
    const stats = aggregateDecisions(decisions);
    // totalHits counts all (2), but alpha/beta only counts the resolved one.
    assert.equal(stats.p1.totalHits, 2);
    assert.equal(stats.p1.alpha, 1);
    assert.equal(stats.p1.beta, 0);
  });

  it('rejects a truthy-but-non-string pattern identifier (round-1 code-audit finding 0e342a58, sustained) — object/array/boolean/number all skipped, mixed with a valid record stays tolerant', () => {
    const decisions = [
      { context: { pattern: {} }, outcome: { action: 'accept' } },
      { context: { pattern: [] }, outcome: { action: 'accept' } },
      { context: { pattern: true }, outcome: { action: 'accept' } },
      { context: { pattern: 123 }, outcome: { action: 'accept' } },
      { context: { pattern: 'p1' }, outcome: { action: 'accept' } },
    ];
    const stats = aggregateDecisions(decisions);
    assert.equal(Object.keys(stats).length, 1, 'only the one well-formed string pattern is aggregated');
    assert.ok(stats.p1);
    assert.equal(stats.p1.totalHits, 1);
  });

  it('rejects a blank/whitespace-only string pattern identifier', () => {
    const decisions = [
      { context: { pattern: '' }, outcome: { action: 'accept' } },
      { context: { pattern: '   ' }, outcome: { action: 'accept' } },
      { context: { pattern: 'p1' }, outcome: { action: 'accept' } },
    ];
    const stats = aggregateDecisions(decisions);
    assert.equal(Object.keys(stats).length, 1);
  });

  it('an all-malformed-pattern array (no valid string patterns at all) aggregates to empty stats, not a crash', () => {
    const decisions = [{ context: { pattern: {} } }, { context: { pattern: 42 } }];
    const stats = aggregateDecisions(decisions);
    assert.equal(Object.keys(stats).length, 0);
  });

  it('a "__proto__"-named pattern is a safe own property, not a prototype reassignment (null-prototype result container)', () => {
    const decisions = [{ context: { pattern: '__proto__' }, outcome: { action: 'accept' } }];
    const stats = aggregateDecisions(decisions);
    assert.equal(Object.getPrototypeOf({}), Object.prototype, 'sanity: a normal object literal still has the real prototype');
    assert.ok(Object.prototype.hasOwnProperty.call(stats, '__proto__'), '__proto__ must be a real OWN property of the result, not have silently reassigned the prototype');
    assert.equal(stats.__proto__.alpha, 1);
    // If this had polluted a plain {} instead of Object.create(null), the
    // stats object's OWN prototype would have been reassigned to
    // {alpha:1,...} and stats.__proto__ would read back Object.prototype
    // instead (or throw), not the aggregated record.
    assert.equal(Object.getPrototypeOf(stats), null);
  });
});

// ── shouldSkipPattern ─────────────────────────────────────────────────────

describe('quickfix-stats / shouldSkipPattern', () => {
  it('skips when acceptance < 0.20 AND total_hits >= 10', () => {
    const stats = {
      patterns: {
        bad: { acceptanceRate: 0.10, totalHits: 15, alpha: 1, beta: 9 },
      },
    };
    assert.equal(shouldSkipPattern('bad', stats), true);
  });

  it('does NOT skip when acceptance < 0.20 BUT total_hits < 10', () => {
    const stats = {
      patterns: {
        small: { acceptanceRate: 0.10, totalHits: 5, alpha: 0, beta: 4 },
      },
    };
    assert.equal(shouldSkipPattern('small', stats), false);
  });

  it('does NOT skip when total_hits >= 10 BUT acceptance >= 0.20', () => {
    const stats = {
      patterns: {
        good: { acceptanceRate: 0.50, totalHits: 50, alpha: 25, beta: 25 },
      },
    };
    assert.equal(shouldSkipPattern('good', stats), false);
  });

  it('returns false for unknown pattern', () => {
    assert.equal(shouldSkipPattern('not-here', { patterns: {} }), false);
  });

  it('returns false for null/missing stats', () => {
    assert.equal(shouldSkipPattern('p', null), false);
    assert.equal(shouldSkipPattern('p', {}), false);
  });
});

// ── loadStats ─────────────────────────────────────────────────────────────

describe('quickfix-stats / loadStats', () => {
  it('returns empty patterns when cache file missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-'));
    const r = loadStats(path.join(tmp, 'nope.json'));
    assert.deepEqual(r, { patterns: {} });
  });

  it('returns empty patterns on JSON parse failure', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-'));
    const f = path.join(tmp, 'broken.json');
    fs.writeFileSync(f, '{not valid json');
    const r = loadStats(f);
    assert.deepEqual(r, { patterns: {} });
  });

  it('returns parsed body on valid cache', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-'));
    const f = path.join(tmp, 'cache.json');
    fs.writeFileSync(f, JSON.stringify({
      _version: 1,
      _generatedAt: '2026-05-08T12:00:00Z',
      _watermark: { maxOutcomeAt: null, totalRowCount: 0 },
      patterns: { p1: { alpha: 1, beta: 0, acceptanceRate: 0.5, totalHits: 1 } },
    }));
    const r = loadStats(f);
    assert.equal(r._version, 1);
    assert.ok(r.patterns.p1);
  });
});

// ── rebuildFromBootstrap — RETIRED ────────────────────────────────────────
//
// The bootstrap path is retired (plan §2 items 2+3): it re-implemented a
// second, divergeable copy of the outcome detector that
// `backfill-outcomes.mjs --rebuild-stats` already owns, and its worst
// behaviour was overwriting a cloud-built cache with inert `no_action`
// weights. These three tests previously asserted the `{ok:true}` contract;
// per R1-M4 they are rewritten rather than deleted, because "the retired
// path does not write" is the regression that matters most.

describe('quickfix-stats / rebuildFromBootstrap (retired)', () => {
  let tmpDir;
  let prevCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-bootstrap-'));
    prevCwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync('.audit', { recursive: true });
  });

  afterEach(() => {
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('refuses with a stable typed error naming the replacement command', async () => {
    const r = await rebuildFromBootstrap();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'bootstrap-retired');
    assert.equal(r.totalHits, 0);
    assert.equal(r.patternCount, 0);
    assert.match(
      r.hint, /backfill-outcomes/,
      'the refusal must name the working command, not just decline',
    );
  });

  it('refuses even when the JSONL it used to read is present', async () => {
    fs.writeFileSync('.audit/quickfix-hits.jsonl', [
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', tool: 'Edit', file: 'a.js',
        matches: [{ name: 'p1', severity: 'medium', snippet: 'x', hit_id: 'h1' }] }),
      JSON.stringify({ ts: '2026-01-01T00:01:00Z', tool: 'Edit', file: 'b.js',
        matches: [{ name: 'p1', severity: 'medium', snippet: 'y', hit_id: 'h2' }] }),
    ].join('\n') + '\n');

    const r = await rebuildFromBootstrap();
    assert.equal(r.ok, false, 'presence of input must not resurrect the retired path');
    assert.equal(r.error, 'bootstrap-retired');
    assert.equal(
      fs.existsSync('.audit/quickfix-pattern-stats.json'), false,
      'the retired path must not create a cache file',
    );
  });

  // The regression that matters most: the old path clobbered a good,
  // cloud-built cache with inert bootstrap weights.
  it('leaves an existing populated cache byte-identical', async () => {
    const cachePath = '.audit/quickfix-pattern-stats.json';
    const original = JSON.stringify({
      _version: 1,
      _generatedAt: '2026-01-01T00:00:00.000Z',
      _repoScope: 'owner/repo',
      patterns: { p1: { alpha: 9, beta: 2, acceptanceRate: 0.818, totalHits: 11 } },
    }, null, 2);
    fs.writeFileSync(cachePath, original);
    fs.writeFileSync('.audit/quickfix-hits.jsonl',
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', tool: 'Edit', file: 'a.js',
        matches: [{ name: 'p1', severity: 'medium', snippet: 'x', hit_id: 'h1' }] }) + '\n');

    const r = await rebuildFromBootstrap();
    assert.equal(r.ok, false);
    assert.equal(
      fs.readFileSync(cachePath, 'utf-8'), original,
      'a retired path must not overwrite a cloud-built cache with inert weights',
    );
  });

  it('no longer exposes the JSONL path it used to read', () => {
    assert.equal(
      _internals.HITS_JSONL_PATH, undefined,
      'HITS_JSONL_PATH is deleted with the parse body it served',
    );
  });
});

// R1-M4 retirement migration contract: an automation consumer must fail
// LOUDLY rather than believe a rebuild happened. Driving the real CLI is the
// point — a unit test on rebuildFromBootstrap cannot prove the bridge
// propagates the refusal or that the process exits non-zero.
describe('quickfix-stats / retired bootstrap — end-to-end via cross-skill CLI', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-e2e-'));
    fs.mkdirSync(path.join(tmpDir, '.audit'), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('exits non-zero, reports ok:false, names the replacement, and leaves the cache byte-identical', () => {
    const cachePath = path.join(tmpDir, '.audit', 'quickfix-pattern-stats.json');
    const original = JSON.stringify({
      _version: 1,
      _generatedAt: '2026-01-01T00:00:00.000Z',
      patterns: { p1: { alpha: 9, beta: 2, acceptanceRate: 0.818, totalHits: 11 } },
    }, null, 2);
    fs.writeFileSync(cachePath, original);

    const cli = path.resolve(
      path.dirname(url.fileURLToPath(import.meta.url)), '..', 'scripts', 'cross-skill.mjs',
    );
    const res = spawnSync(
      process.execPath,
      [cli, 'learning-quickfix-stats', '--action', 'rebuild', '--bootstrap'],
      { cwd: tmpDir, encoding: 'utf-8' },
    );

    assert.notEqual(res.status, 0, 'a retired path must exit non-zero so automation fails loudly');

    const payload = JSON.parse(
      res.stdout.trim().split('\n').filter(Boolean).pop(),
    );
    assert.equal(payload.ok, false);
    assert.match(
      JSON.stringify(payload), /backfill-outcomes/,
      'the CLI response must carry the replacement command through the bridge',
    );
    assert.equal(
      fs.readFileSync(cachePath, 'utf-8'), original,
      'the CLI path must not write the cache either',
    );
  });
});

// ── rebuildFromCloud (failure-contract refactor, Defect 2 + Round 1/3 fixes) ─

describe('quickfix-stats / rebuildFromCloud — failure vs empty vs malformed', () => {
  let tmpDir, cachePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-rebuild-'));
    cachePath = path.join(tmpDir, 'quickfix-pattern-stats.json');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('a thrown read exception returns {ok:false} and leaves an existing cache byte-identical (Defect 2)', async () => {
    const preExisting = JSON.stringify({ _version: 1, patterns: { good: { alpha: 1, beta: 0, acceptanceRate: 0.9, totalHits: 1, ci_low: 0.1 } } }, null, 2);
    fs.writeFileSync(cachePath, preExisting);

    const store = fakeStore({ readDecisionsPaginated: async () => { throw new Error('connection reset'); } });
    const r = await rebuildFromCloud({ cachePath, store, allRepos: true });

    assert.equal(r.ok, false);
    assert.match(r.error, /connection reset/);
    assert.equal(fs.readFileSync(cachePath, 'utf-8'), preExisting, 'a transient read failure must never clobber a good existing cache');
  });

  it('a genuinely empty cloud response is not a failure — the cache IS written with patterns:{}', async () => {
    const store = fakeStore({ readDecisionsPaginated: async () => [] });
    const r = await rebuildFromCloud({ cachePath, store, allRepos: true });

    assert.equal(r.ok, true);
    assert.equal(r.totalDecisions, 0);
    assert.equal(r.patternCount, 0);
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    assert.deepEqual(cache.patterns, {});
  });

  it('a store missing readDecisionsPaginated is treated as a failure, not silent empty', async () => {
    const store = fakeStore(); // no readDecisionsPaginated
    const r = await rebuildFromCloud({ cachePath, store, allRepos: true });
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.equal(fs.existsSync(cachePath), false, 'no cache should be written on this failure path');
  });

  it('a non-array success payload is a protocol violation, not an empty result (round-1 finding M1)', async () => {
    const store = fakeStore({ readDecisionsPaginated: async () => ({ not: 'an array' }) });
    const r = await rebuildFromCloud({ cachePath, store, allRepos: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /non-array payload/);
    assert.equal(fs.existsSync(cachePath), false);
  });

  it('an all-malformed non-empty array is treated as a protocol regression, not empty (round-3 fix M4) — pre-existing cache untouched', async () => {
    const preExisting = JSON.stringify({ _version: 1, patterns: { good: { alpha: 1, beta: 0, acceptanceRate: 0.9, totalHits: 1, ci_low: 0.1 } } }, null, 2);
    fs.writeFileSync(cachePath, preExisting);

    const store = fakeStore({ readDecisionsPaginated: async () => [{}, { foo: 'bar' }] });
    const r = await rebuildFromCloud({ cachePath, store, allRepos: true });

    assert.equal(r.ok, false);
    assert.equal(r.totalDecisions, 2);
    assert.equal(r.patternCount, 0);
    assert.match(r.error, /lacked a recognizable pattern field/);
    assert.equal(fs.readFileSync(cachePath, 'utf-8'), preExisting, 'the all-malformed case must not clobber an existing good cache either');
  });

  it('a MIX of one good and one malformed record does NOT regress aggregateDecisions\'s existing tolerance — cache IS written', async () => {
    const store = fakeStore({
      readDecisionsPaginated: async () => [
        { context: { pattern: 'p1' }, outcome: { action: 'accept' } },
        { foo: 'bar' },
      ],
    });
    const r = await rebuildFromCloud({ cachePath, store, allRepos: true });

    assert.equal(r.ok, true);
    assert.equal(r.totalDecisions, 2);
    assert.equal(r.patternCount, 1);
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    assert.ok(cache.patterns.p1);
  });
});

// ── Constants ─────────────────────────────────────────────────────────────

describe('quickfix-stats / internals', () => {
  it('skip threshold + min hits match plan defaults', () => {
    assert.equal(_internals.SKIP_THRESHOLD, 0.20);
    assert.equal(_internals.MIN_HITS, 10);
  });

  it('cache version is set', () => {
    assert.ok(Number.isFinite(_internals.CACHE_VERSION));
  });
});

/**
 * Audit finding "Tenant/owner scoping": `rebuildFromCloud` defaulted `repoId` to
 * `null`, documented that value as meaning "all", and passed it straight to
 * `readQuickfixDecisions` — so the ordinary no-argument public call performed an
 * unscoped cross-repo cloud read. Same rule the unlocked-fixes and
 * unremediated-acceptances readers already enforce: global access is ASKED for,
 * never inherited from an omitted argument.
 *
 * Both production call sites (`cross-skill.mjs learning-quickfix-stats` and
 * `learning/backfill-outcomes.mjs`) already pass an explicit repoId, so this
 * narrows nothing they do — it closes the default.
 */
describe('quickfix-stats / rebuildFromCloud — global access is asked for', () => {
  let tmpDir, cachePath;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-scope-'));
    cachePath = path.join(tmpDir, 'quickfix-pattern-stats.json');
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  const emptyStore = () => fakeStore({ readDecisionsPaginated: async () => [] });

  it('refuses a no-argument call rather than reading every repo', async () => {
    const r = await rebuildFromCloud({ cachePath, store: emptyStore() });
    assert.equal(r.ok, false);
    assert.match(r.error, /repo-scope-required/);
    assert.equal(r.totalDecisions, 0);
  });

  it('names allRepos in the refusal, so the deliberate path is discoverable', async () => {
    const r = await rebuildFromCloud({ cachePath, store: emptyStore() });
    assert.match(r.error, /allRepos/);
  });

  // Vacuous-pass guards: a function refusing everything would satisfy both above.
  it('an explicit repoId proceeds (negative control)', async () => {
    const r = await rebuildFromCloud({ cachePath, store: emptyStore(), repoId: 'repo-1' });
    assert.ok(!/repo-scope-required/.test(r.error ?? ''), 'a scoped call must clear the fence');
    assert.equal(r.ok, true);
  });

  it('an explicit allRepos:true proceeds (negative control)', async () => {
    const r = await rebuildFromCloud({ cachePath, store: emptyStore(), allRepos: true });
    assert.ok(!/repo-scope-required/.test(r.error ?? ''), 'the deliberate global path must still work');
    assert.equal(r.ok, true);
  });
});
