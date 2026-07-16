import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  matchPatterns,
  loadSkippedPatternSet,
  PATTERNS,
} from '../scripts/lib/quickfix-patterns.mjs';

// ── Synchronous-hot-path contract (Phase 2 audit-fix G2 from master plan) ──

describe('quickfix-patterns / synchronous hot-path contract', () => {
  it('matchPatterns is NOT async', () => {
    // Function.constructor.name should be 'Function', not 'AsyncFunction'.
    assert.equal(matchPatterns.constructor.name, 'Function',
      'matchPatterns must remain synchronous — async would block the editor hook');
  });

  it('loadSkippedPatternSet is NOT async', () => {
    assert.equal(loadSkippedPatternSet.constructor.name, 'Function',
      'loadSkippedPatternSet must remain synchronous');
  });
});

// ── skipPatterns integration ──────────────────────────────────────────────

describe('quickfix-patterns / skipPatterns integration', () => {
  it('omits skipped patterns from results', () => {
    // Pick any pattern from the matrix and craft an input that triggers it.
    const empty = PATTERNS.find(p => p.name === 'empty-catch');
    assert.ok(empty, 'empty-catch pattern should exist');
    const code = 'try { x() } catch (e) {}';
    const without = matchPatterns(code);
    assert.ok(without.some(m => m.name === 'empty-catch'));
    const withSkip = matchPatterns(code, { skipPatterns: new Set(['empty-catch']) });
    assert.ok(!withSkip.some(m => m.name === 'empty-catch'),
      'empty-catch must be skipped when in skipPatterns set');
  });

  it('non-Set skipPatterns is ignored (defensive)', () => {
    const code = 'try { x() } catch (e) {}';
    const r = matchPatterns(code, { skipPatterns: ['empty-catch'] }); // array, not Set
    assert.ok(r.some(m => m.name === 'empty-catch'),
      'array (not Set) should be ignored — pattern still fires');
  });
});

// ── loadSkippedPatternSet ────────────────────────────────────────────────

describe('quickfix-patterns / loadSkippedPatternSet', () => {
  let tmpDir;
  let prevCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfp-skip-'));
    prevCwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync('.audit', { recursive: true });
  });

  afterEach(() => {
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('returns empty Set when cache file is absent', () => {
    const r = loadSkippedPatternSet({ env: {} });
    assert.ok(r instanceof Set);
    assert.equal(r.size, 0);
  });

  it('LEARNING_DISABLE=1 short-circuits to empty Set', () => {
    fs.writeFileSync('.audit/quickfix-pattern-stats.json', JSON.stringify({
      patterns: { foo: { acceptanceRate: 0.0, totalHits: 100 } },
    }));
    const r = loadSkippedPatternSet({ env: { LEARNING_DISABLE: '1' } });
    assert.equal(r.size, 0);
  });

  it('LEARNING_QUICKFIX=off short-circuits to empty Set', () => {
    fs.writeFileSync('.audit/quickfix-pattern-stats.json', JSON.stringify({
      patterns: { foo: { acceptanceRate: 0.0, totalHits: 100 } },
    }));
    const r = loadSkippedPatternSet({ env: { LEARNING_QUICKFIX: 'off' } });
    assert.equal(r.size, 0);
  });

  it('returns set of patterns matching skip rule (acceptance < 0.20 AND hits >= 10)', () => {
    fs.writeFileSync('.audit/quickfix-pattern-stats.json', JSON.stringify({
      patterns: {
        skip_me:    { acceptanceRate: 0.10, totalHits: 50 },
        keep_low_n: { acceptanceRate: 0.10, totalHits: 5 },   // not enough hits
        keep_high_acc: { acceptanceRate: 0.50, totalHits: 50 }, // acceptance OK
      },
    }));
    const r = loadSkippedPatternSet({ env: {} });
    assert.equal(r.size, 1);
    assert.ok(r.has('skip_me'));
    assert.ok(!r.has('keep_low_n'));
    assert.ok(!r.has('keep_high_acc'));
  });

  it('handles malformed cache gracefully', () => {
    fs.writeFileSync('.audit/quickfix-pattern-stats.json', '{ broken json');
    const r = loadSkippedPatternSet({ env: {} });
    assert.equal(r.size, 0);
  });

  it('handles missing patterns key gracefully', () => {
    fs.writeFileSync('.audit/quickfix-pattern-stats.json', JSON.stringify({ noPatterns: 1 }));
    const r = loadSkippedPatternSet({ env: {} });
    assert.equal(r.size, 0);
  });

  it('skips entries with malformed acceptanceRate or totalHits', () => {
    fs.writeFileSync('.audit/quickfix-pattern-stats.json', JSON.stringify({
      patterns: {
        bad_rate: { acceptanceRate: 'low', totalHits: 50 },
        bad_hits: { acceptanceRate: 0.10 },
        ok:       { acceptanceRate: 0.10, totalHits: 50 },
      },
    }));
    const r = loadSkippedPatternSet({ env: {} });
    assert.ok(r.has('ok'));
    assert.ok(!r.has('bad_rate'));
    assert.ok(!r.has('bad_hits'));
  });
});
