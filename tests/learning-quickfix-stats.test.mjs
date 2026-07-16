import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  loadStats,
  shouldSkipPattern,
  aggregateDecisions,
  rebuildFromBootstrap,
  _internals,
} from '../scripts/lib/learning/quickfix-stats.mjs';

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

// ── rebuildFromBootstrap ──────────────────────────────────────────────────

describe('quickfix-stats / rebuildFromBootstrap', () => {
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

  it('returns error when JSONL is missing', async () => {
    const r = await rebuildFromBootstrap();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'jsonl-missing');
  });

  it('builds stats from synthetic JSONL', async () => {
    fs.writeFileSync('.audit/quickfix-hits.jsonl', [
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', tool: 'Edit', file: 'a.js',
        matches: [{ name: 'p1', severity: 'medium', snippet: 'x', hit_id: 'h1' }] }),
      JSON.stringify({ ts: '2026-01-01T00:01:00Z', tool: 'Edit', file: 'b.js',
        matches: [{ name: 'p1', severity: 'medium', snippet: 'y', hit_id: 'h2' }] }),
      JSON.stringify({ ts: '2026-01-01T00:02:00Z', tool: 'Edit', file: 'c.js',
        matches: [{ name: 'p2', severity: 'low', snippet: 'z', hit_id: 'h3' }] }),
    ].join('\n') + '\n');

    const r = await rebuildFromBootstrap();
    assert.equal(r.ok, true);
    assert.equal(r.totalHits, 3);
    assert.equal(r.patternCount, 2);

    const cache = JSON.parse(fs.readFileSync('.audit/quickfix-pattern-stats.json', 'utf-8'));
    assert.equal(cache._bootstrap, true);
    assert.ok(cache.patterns.p1);
    assert.equal(cache.patterns.p1.totalHits, 2);
  });

  it('skips malformed lines gracefully', async () => {
    fs.writeFileSync('.audit/quickfix-hits.jsonl', [
      '{not json',
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', tool: 'Edit', file: 'a.js',
        matches: [{ name: 'p1', severity: 'medium', snippet: 'x', hit_id: 'h1' }] }),
    ].join('\n') + '\n');
    const r = await rebuildFromBootstrap();
    assert.equal(r.ok, true);
    assert.equal(r.totalHits, 1);
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
