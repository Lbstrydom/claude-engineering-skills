/**
 * Tests for scripts/lib/requirements/ledger.mjs
 * Plan: docs/plans/requirements-layer.md — Plan-Phase A.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLedger, writeLedger, reconcile, deriveIndex, statusFor, inferAmbiguousFromStatus } from '../scripts/lib/requirements/ledger.mjs';

function cand(over = {}) {
  return {
    id: 'REQ-correctness-aaaaaaaa', assertion: 'The reconcile step is idempotent.',
    kind: 'correctness', checkable: true,
    provenance: [{ file: 'scripts/lib/requirements/ledger.mjs', anchor: 'reconcile' }],
    appliesTo: [], evidence: { code: [], tests: [] }, seenInRuns: 2, confidence: 'high', ...over,
  };
}
const gap = (id, g = 'none') => ({ requirementId: id, gap: g, conflictsWith: [], rationale: 't' });
const COVERED = ['scripts/lib/requirements/ledger.mjs'];

describe('reconcile — status lifecycle', () => {
  it('a seenInRuns:2, gap-none candidate → active', () => {
    const l = reconcile({ candidates: [cand()], coveredFiles: COVERED, gapAssessments: [gap('REQ-correctness-aaaaaaaa')] });
    assert.equal(l.requirements[0].status, 'active');
  });
  it('a contradictory gap → needs-review (audit H4)', () => {
    const l = reconcile({ candidates: [cand()], coveredFiles: COVERED, gapAssessments: [gap('REQ-correctness-aaaaaaaa', 'contradictory')] });
    assert.equal(l.requirements[0].status, 'needs-review');
  });
  it('an observed-but-unintended gap → needs-review, kept out of the rubric (audit G1)', () => {
    const l = reconcile({ candidates: [cand()], coveredFiles: COVERED, gapAssessments: [gap('REQ-correctness-aaaaaaaa', 'observed-but-unintended')] });
    assert.equal(l.requirements[0].status, 'needs-review');
  });
  it('a seenInRuns:1 candidate → inferred-only', () => {
    const l = reconcile({ candidates: [cand({ seenInRuns: 1, confidence: 'low' })], coveredFiles: COVERED, gapAssessments: [] });
    assert.equal(l.requirements[0].status, 'inferred-only');
  });
  it('an override accept forces active even for seenInRuns:1', () => {
    const l = reconcile({
      candidates: [cand({ seenInRuns: 1, confidence: 'low' })], coveredFiles: COVERED,
      gapAssessments: [], overrides: { 'REQ-correctness-aaaaaaaa': { decision: 'accept' } },
    });
    assert.equal(l.requirements[0].status, 'active');
  });
  it('an override reject drops the requirement', () => {
    const l = reconcile({
      candidates: [cand()], coveredFiles: COVERED, gapAssessments: [],
      overrides: { 'REQ-correctness-aaaaaaaa': { decision: 'reject' } },
    });
    assert.equal(l.requirements.length, 0);
  });
});

describe('reconcile — idempotency + identity', () => {
  it('reconcile is idempotent — re-run yields identical requirements', () => {
    const args = { candidates: [cand()], coveredFiles: COVERED, gapAssessments: [gap('REQ-correctness-aaaaaaaa')] };
    const first = reconcile(args);
    const second = reconcile({ ...args, priorLedger: first });
    assert.deepEqual(second.requirements, first.requirements);
  });
  it('an override-edited assertion is applied but the frozen id is kept (audit R2-M1)', () => {
    const l = reconcile({
      candidates: [cand()], coveredFiles: COVERED, gapAssessments: [],
      overrides: { 'REQ-correctness-aaaaaaaa': { assertion: 'A human-reworded assertion of the same invariant.' } },
    });
    assert.equal(l.requirements[0].id, 'REQ-correctness-aaaaaaaa');
    assert.match(l.requirements[0].assertion, /human-reworded/);
  });
  it('seenInRuns is a high-water mark — a degraded 1-run re-run does not downgrade (audit G2)', () => {
    const prior = reconcile({ candidates: [cand({ seenInRuns: 2 })], coveredFiles: COVERED, gapAssessments: [] });
    const degraded = reconcile({
      candidates: [cand({ seenInRuns: 1, confidence: 'low' })], coveredFiles: COVERED,
      gapAssessments: [], priorLedger: prior,
    });
    assert.equal(degraded.requirements[0].seenInRuns, 2);
    assert.equal(degraded.requirements[0].status, 'active', 'not downgraded to inferred-only');
  });
});

describe('reconcile — scoped partial merge (audit G1)', () => {
  it('a prior requirement outside the new coveredFiles is retained untouched', () => {
    const priorReq = { ...cand({ id: 'REQ-safety-bbbbbbbb', assertion: 'An invariant about another file.' }),
      provenance: [{ file: 'scripts/other.mjs', anchor: 'x' }], status: 'active', gap: null };
    const prior = { requirements: [priorReq], coveredFiles: ['scripts/other.mjs'], identityAliases: {} };
    const l = reconcile({ candidates: [cand()], coveredFiles: COVERED, gapAssessments: [], priorLedger: prior });
    assert.ok(l.requirements.find((r) => r.id === 'REQ-safety-bbbbbbbb'), 'b-file requirement retained');
    assert.ok(l.requirements.find((r) => r.id === 'REQ-correctness-aaaaaaaa'), 'new requirement added');
    assert.deepEqual(l.coveredFiles, ['scripts/lib/requirements/ledger.mjs', 'scripts/other.mjs']);
  });
});

describe('loadLedger / writeLedger / deriveIndex', () => {
  it('round-trips through an atomic write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-ledger-'));
    const l = reconcile({ candidates: [cand()], coveredFiles: COVERED, gapAssessments: [], commitSha: 'abc' });
    writeLedger(l, { baseDir: dir });
    const loaded = loadLedger({ baseDir: dir });
    assert.equal(loaded.requirements.length, 1);
    assert.equal(loaded.commitSha, 'abc');
  });
  it('loadLedger returns an empty ledger when absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-ledger-'));
    assert.deepEqual(loadLedger({ baseDir: dir }).requirements, []);
  });
  it('deriveIndex projects id/assertion/kind/status only', () => {
    const l = reconcile({ candidates: [cand()], coveredFiles: COVERED, gapAssessments: [] });
    const idx = deriveIndex(l);
    assert.deepEqual(Object.keys(idx[0]).sort(), ['assertion', 'id', 'kind', 'status']);
  });
});

describe('statusFor — exported for reassess-gaps to reuse, not re-derive', () => {
  // Newly exported (2026-08-12) so a standalone gap-reassessment pass can
  // recompute status through the SAME precedence `reconcile` uses. These pin
  // that precedence directly, independent of the full reconcile() pipeline.
  const req = (over = {}) => ({ seenInRuns: 2, ...over });

  it('an override accept wins over everything, even a contradictory gap', () => {
    assert.equal(statusFor({
      req: req(), override: { decision: 'accept' },
      gap: { gap: 'contradictory' }, ambiguous: true,
    }), 'active');
  });

  it('ambiguous identity forces needs-review, even with a clean gap', () => {
    assert.equal(statusFor({ req: req(), gap: { gap: 'none' }, ambiguous: true }), 'needs-review');
  });

  it('contradictory or observed-but-unintended forces needs-review', () => {
    assert.equal(statusFor({ req: req(), gap: { gap: 'contradictory' }, ambiguous: false }), 'needs-review');
    assert.equal(statusFor({ req: req(), gap: { gap: 'observed-but-unintended' }, ambiguous: false }), 'needs-review');
  });

  it('"untested" does NOT force needs-review — a real invariant with no linked test still activates', () => {
    // Documented precedence, not an oversight: `untested` is advisory-visible
    // in the map but does not gate status the way the other two gap classes
    // do.
    assert.equal(statusFor({ req: req(), gap: { gap: 'untested' }, ambiguous: false }), 'active');
  });

  it('seenInRuns < 2 is inferred-only, once gap/ambiguous/override are all clear', () => {
    assert.equal(statusFor({ req: req({ seenInRuns: 1 }), gap: { gap: 'none' }, ambiguous: false }), 'inferred-only');
  });

  it('a clean gap seen twice is active', () => {
    assert.equal(statusFor({ req: req(), gap: { gap: 'none' }, ambiguous: false }), 'active');
  });

  it('a MISSING gap (never assessed) behaves like a clean one for status purposes', () => {
    // statusFor only demotes on an EXPLICIT contradictory/observed-but-unintended
    // verdict — `gap: null` (never assessed) must not itself demote a
    // requirement, or every degraded-placeholder entry would read as
    // needs-review, masking the real signal with noise.
    assert.equal(statusFor({ req: req(), gap: null, ambiguous: false }), 'active');
  });
});

describe('inferAmbiguousFromStatus — reconstructing a dropped signal', () => {
  // `ambiguous` is never persisted — only its effect (status) survives past
  // the reconcile() call that computed it. This is the inference a standalone
  // gap-reassessment pass needs to avoid silently demoting an
  // ambiguity-driven needs-review entry the moment its UNRELATED gap gets
  // reassessed. Found live: 7 of 14 real needs-review entries had this exact
  // shape (gap:'none', a degraded-placeholder rationale).
  it('needs-review + a non-severity gap ⇒ must have been ambiguity', () => {
    assert.equal(inferAmbiguousFromStatus({ status: 'needs-review', gap: { gap: 'none' } }), true);
    assert.equal(inferAmbiguousFromStatus({ status: 'needs-review', gap: null }), true);
    assert.equal(inferAmbiguousFromStatus({ status: 'needs-review', gap: { gap: 'untested' } }), true);
  });

  it('needs-review + a SEVERITY gap ⇒ the gap explains it, not ambiguity', () => {
    assert.equal(inferAmbiguousFromStatus({ status: 'needs-review', gap: { gap: 'contradictory' } }), false);
    assert.equal(inferAmbiguousFromStatus({ status: 'needs-review', gap: { gap: 'observed-but-unintended' } }), false);
  });

  it('any other status is never ambiguity-driven', () => {
    assert.equal(inferAmbiguousFromStatus({ status: 'active', gap: { gap: 'none' } }), false);
    assert.equal(inferAmbiguousFromStatus({ status: 'inferred-only', gap: null }), false);
  });

  it('END-TO-END: an entry survives a gap reassessment without losing its needs-review status', () => {
    // The regression this whole function exists to prevent, driven through
    // the ACTUAL statusFor call a reassessment performs — not just the
    // inference helper in isolation.
    const req = { status: 'needs-review', gap: { gap: 'none', rationale: 'not assessed' }, seenInRuns: 2 };
    const wasAmbiguous = inferAmbiguousFromStatus(req);
    // Simulate the reassessment landing a genuinely CLEAN verdict.
    req.gap = { gap: 'none', rationale: 'A sound, intentional invariant.' };
    req.status = statusFor({ req, gap: req.gap, override: undefined, ambiguous: wasAmbiguous });
    assert.equal(req.status, 'needs-review',
      'a hardcoded ambiguous:false here would have demoted this entry — the exact bug this test pins');
  });
});
