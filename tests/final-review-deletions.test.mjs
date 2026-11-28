/**
 * @fileoverview A deleted changed file is not a coverage gap (upstream aeaca1fd).
 *
 * Before the fix, a path neither rendered nor cut went to `changedMissing`, got no line count, was pushed to
 * `changedUnmeasured` and set `complete = false` — so any change that deleted a file read `Code: PARTIAL`, and a
 * deletion-only change read `NONE` and had its APPROVE mechanically downgraded. A deletion is confirmed only by git `D`
 * AND absence on disk: absence alone is a gap, and every test below that asserts the fix has a control that shows the
 * same input without the confirmation still reads as a gap.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { summariseCodeCoverage, applyCoverageGate, formatCodeCoverageSegment } from '../scripts/lib/final-review/code-coverage.mjs';
import { mergeBatchCoverage } from '../scripts/lib/final-review/batching.mjs';
import { resolveFinalReviewDeletions, resolveFinalReviewHunks } from '../scripts/lib/audit/final-review-hunks.mjs';

const stats = (full) => ({
  full, headTruncated: [], budgetOmitted: [], unreadable: [], sensitiveExcluded: [],
  lineCounts: Object.fromEntries(full.map((p) => [p, 3])), charsRendered: 10, charsOnDisk: 10,
});
const hunksFor = () => [{ startLine: 1, lineCount: 1 }];
const ON_DISK = new Set(['src/kept.mjs']);
const exists = (p) => ON_DISK.has(p);
const readText = () => null;
const gone = (p) => p === 'src/gone.mjs';

describe('summariseCodeCoverage — a confirmed deletion', () => {
  const changed = ['src/kept.mjs', 'src/gone.mjs'];

  it('a change that deletes a file reaches FULL, and the deletion is named', () => {
    const cov = summariseCodeCoverage(stats(['src/kept.mjs']), changed, { hunksFor, requested: ['src/kept.mjs'], readText, exists, isDeleted: gone });
    assert.equal(cov.state, 'full', cov.reason);
    assert.deepEqual(cov.changedDeleted, ['src/gone.mjs']);
    assert.deepEqual(cov.changedUnmeasured, []);
    assert.deepEqual(cov.changedMissing, []);
    assert.equal(cov.changedLinesUnmeasuredFiles, 0);
    assert.match(cov.reason, /1 deleted/);
    assert.match(formatCodeCoverageSegment(cov), /^Code: FULL; DELETED: src\/gone\.mjs$/);
  });

  it('negative control: the same input without deletion evidence stays PARTIAL and unmeasured (the pre-fix state)', () => {
    const cov = summariseCodeCoverage(stats(['src/kept.mjs']), changed, { hunksFor, requested: ['src/kept.mjs'], readText, exists });
    assert.equal(cov.state, 'partial');
    assert.deepEqual(cov.changedUnmeasured.map((u) => u.path), ['src/gone.mjs']);
    assert.deepEqual(cov.changedDeleted, []);
  });

  it('a missing-but-NOT-deleted file stays unmeasured: absence alone is a gap', () => {
    const cov = summariseCodeCoverage(stats(['src/kept.mjs']), ['src/kept.mjs', 'src/typo.mjs'],
      { hunksFor, requested: ['src/kept.mjs'], readText, exists, isDeleted: gone });
    assert.equal(cov.state, 'partial');
    assert.deepEqual(cov.changedUnmeasured.map((u) => u.path), ['src/typo.mjs']);
    assert.deepEqual(cov.changedDeleted, []);
  });

  it('a git-D path that is back on disk is judged on its render, never as deleted', () => {
    const cov = summariseCodeCoverage(stats(['src/kept.mjs']), ['src/kept.mjs'],
      { hunksFor, requested: ['src/kept.mjs'], readText, exists, isDeleted: () => true });
    assert.equal(cov.state, 'full');
    assert.deepEqual(cov.changedDeleted, [], 'a rendered file is never bucketed as deleted');
    const back = summariseCodeCoverage(stats([]), ['src/kept.mjs'], { hunksFor, requested: [], readText, exists, isDeleted: () => true });
    assert.deepEqual(back.changedDeleted, [], 'present on disk but not rendered: a gap, not a deletion');
    assert.notEqual(back.state, 'full');
  });

  it('a deletion-only change is UNKNOWN (nothing measured) and its APPROVE is not downgraded', () => {
    const cov = summariseCodeCoverage(stats([]), ['src/gone.mjs'], { hunksFor, requested: [], readText, exists, isDeleted: gone });
    assert.equal(cov.state, 'unknown');
    assert.match(cov.reason, /deleted — nothing on disk to measure/);
    const result = { verdict: 'APPROVE', overall_reasoning: '' };
    assert.equal(applyCoverageGate(result, cov).downgraded, false);
    assert.equal(result.verdict, 'APPROVE');
  });

  it('negative control: the deletion-only change without evidence is NONE and IS downgraded (the reported bug)', () => {
    const cov = summariseCodeCoverage(stats([]), ['src/gone.mjs'], { hunksFor, requested: [], readText, exists });
    assert.equal(cov.state, 'none');
    const result = { verdict: 'APPROVE', overall_reasoning: '' };
    assert.equal(applyCoverageGate(result, cov).downgraded, true);
  });

  it('wording is byte-identical when nothing was deleted', () => {
    const cov = summariseCodeCoverage(stats(['src/kept.mjs']), ['src/kept.mjs'], { hunksFor, requested: ['src/kept.mjs'], readText, exists });
    assert.equal(cov.reason, 'all 1 changed file(s) rendered whole');
  });
});

describe('mergeBatchCoverage — a deletion-only batch carries no state', () => {
  const full = summariseCodeCoverage(stats(['src/kept.mjs']), ['src/kept.mjs'], { hunksFor, requested: ['src/kept.mjs'], readText, exists });
  const delOnly = summariseCodeCoverage(stats([]), ['src/gone.mjs'], { hunksFor, requested: [], readText, exists, isDeleted: gone });

  it('full + deletion-only ⇒ full, deletions concatenated', () => {
    const m = mergeBatchCoverage([full, delOnly]);
    assert.equal(m.state, 'full');
    assert.deepEqual(m.changedDeleted, ['src/gone.mjs']);
  });

  it('every batch deletion-only ⇒ unknown; a genuinely unknown batch still sinks the fold', () => {
    assert.equal(mergeBatchCoverage([delOnly]).state, 'unknown');
    const realUnknown = summariseCodeCoverage(null, ['src/kept.mjs']);
    assert.equal(mergeBatchCoverage([full, realUnknown]).state, 'unknown');
  });
});

describe('resolveFinalReviewDeletions — git D, over a real repo', () => {
  const makeRepo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-deletions-'));
    const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    g(['init', '-q', '.']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    for (const f of ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs']) fs.writeFileSync(path.join(dir, f), `${f}\n`);
    g(['add', '-A']); g(['commit', '-qm', 'base']);
    const base = g(['rev-parse', 'HEAD']).trim();
    const run = (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir });
    return { dir, g, base, run };
  };
  const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

  it('committed since base, unstaged, and a rename\'s old path all read deleted; a modified file does not', () => {
    const { dir, g, base, run } = makeRepo();
    try {
      g(['rm', '-q', 'a.mjs']); g(['commit', '-qm', 'drop a']);          // committed since base
      fs.rmSync(path.join(dir, 'b.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });                                // unstaged
      g(['mv', 'c.mjs', 'c2.mjs']);                                      // rename: old path is D under --no-renames
      fs.appendFileSync(path.join(dir, 'd.mjs'), 'edit\n');              // modified, not deleted
      const r = resolveFinalReviewDeletions({ base, changedFiles: ['a.mjs', 'b.mjs', 'c.mjs', 'c2.mjs', 'd.mjs'], run });
      assert.equal(r.isDeleted('a.mjs'), true);
      assert.equal(r.isDeleted('b.mjs'), true);
      assert.equal(r.isDeleted('c.mjs'), true);
      assert.equal(r.isDeleted('c2.mjs'), false);
      assert.equal(r.isDeleted('d.mjs'), false);
    } finally { cleanup(dir); }
  });

  it('without a base, a committed deletion is NOT confirmed (only the working tree is read) — fails toward the gap', () => {
    const { dir, g, run } = makeRepo();
    try {
      g(['rm', '-q', 'a.mjs']); g(['commit', '-qm', 'drop a']);
      fs.rmSync(path.join(dir, 'b.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      const r = resolveFinalReviewDeletions({ base: null, changedFiles: ['a.mjs', 'b.mjs'], run });
      assert.equal(r.isDeleted('a.mjs'), false);
      assert.equal(r.isDeleted('b.mjs'), true);
    } finally { cleanup(dir); }
  });

  it('with a base, ONLY the base diff decides: a file added after the base and removed again is not a deletion', () => {
    const { dir, g, base, run } = makeRepo();
    try {
      fs.writeFileSync(path.join(dir, 'late.mjs'), 'x\n'); g(['add', 'late.mjs']); g(['commit', '-qm', 'add late']);
      fs.rmSync(path.join(dir, 'late.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      assert.equal(resolveFinalReviewDeletions({ base, changedFiles: ['late.mjs'], run }).isDeleted('late.mjs'), false);
      // Control: relative to HEAD it IS a D — which is exactly why HEAD is never unioned in when a base exists.
      assert.equal(resolveFinalReviewDeletions({ base: null, changedFiles: ['late.mjs'], run }).isDeleted('late.mjs'), true);
      // A failed BASE read confirms nothing, even though a HEAD read would have.
      const baseFails = (cmd, args, opts) => { if (args.includes(base)) throw new Error('bad base'); return run(cmd, args, opts); };
      fs.rmSync(path.join(dir, 'a.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      assert.equal(resolveFinalReviewDeletions({ base, changedFiles: ['a.mjs'], run: baseFails }).isDeleted('a.mjs'), false);
    } finally { cleanup(dir); }
  });

  it('matches git\'s exact path: a deleted a.mjs never confirms a missing A.mjs (code audit R1-H4/H7)', () => {
    const { dir, base, run } = makeRepo();
    try {
      fs.rmSync(path.join(dir, 'a.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      const r = resolveFinalReviewDeletions({ base, changedFiles: ['a.mjs', 'A.mjs'], run });
      assert.equal(r.isDeleted('a.mjs'), true, 'control: the exact path is confirmed');
      assert.equal(r.isDeleted('A.mjs'), false);
    } finally { cleanup(dir); }
  });

  it('a path outside the changed set is never reported; a failing git confirms nothing', () => {
    const { dir, base, run } = makeRepo();
    try {
      fs.rmSync(path.join(dir, 'a.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      assert.equal(resolveFinalReviewDeletions({ base, changedFiles: ['b.mjs'], run }).isDeleted('a.mjs'), false);
      const boom = () => { throw new Error('git unavailable'); };
      assert.equal(resolveFinalReviewDeletions({ base, changedFiles: ['a.mjs'], run: boom }).isDeleted('a.mjs'), false);
    } finally { cleanup(dir); }
  });

  it('wiring: resolveFinalReviewHunks hands an isDeleted that reaches the coverage summary (lazy: no call, no git)', () => {
    const { dir, g, base, run } = makeRepo();
    try {
      g(['rm', '-q', 'a.mjs']); g(['commit', '-qm', 'drop a']);
      let calls = 0;
      const counted = (...a) => { calls++; return run(...a); };
      const hunks = resolveFinalReviewHunks({ transcript: { rounds: [{ _diffBase: base }] }, changedFiles: ['a.mjs', 'b.mjs'], run: counted, warn: () => {} });
      const before = calls;
      assert.equal(typeof hunks.isDeleted, 'function');
      const cov = summariseCodeCoverage(stats(['b.mjs']), ['a.mjs', 'b.mjs'], {
        hunksFor: hunks.hunksFor, requested: ['b.mjs'], readText,
        exists: (p) => fs.existsSync(path.join(dir, p)), isDeleted: hunks.isDeleted,
      });
      assert.equal(cov.state, 'full', cov.reason);
      assert.deepEqual(cov.changedDeleted, ['a.mjs']);
      assert.ok(calls > before, 'the deletion read happens on first use, not at construction');
    } finally { cleanup(dir); }
  });
});
