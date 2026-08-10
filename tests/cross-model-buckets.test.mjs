/**
 * @fileoverview Cluster B — both bucket views coexist, and the aggregate refuses
 * to lie about what it measured.
 *
 * Reads the COMMITTED fixture (`tests/fixtures/cross-model-pairs.json`), never
 * `.audit/bakeoff/**`. Those artifacts are Category A — gitignored, absent from
 * a fresh clone and from the pre-push sandbox — so a test reading them would
 * pass in CI having checked nothing, which is the sandbox-honesty failure
 * AGENTS.md names.
 *
 * **What the fixture is FOR, since this is the file that reads it: a regression
 * guard, not a validation.** Its own `status` says
 * "PROVISIONAL — labels are model-generated ... Not a validated calibration",
 * and that has not changed. What these assertions establish is that the
 * threshold still separates the 9 known pairs — so a tokenizer change, a
 * signature-format change or a careless retune fails loudly instead of silently
 * re-bucketing history. They do NOT establish that 0.14 is the right number.
 *
 * Nothing load-bearing rests on it any more, which is why leaving it provisional
 * is honest rather than lazy. Measured 2026-08-10: the campaign's floor metric
 * is invariant to this threshold (§2.5c-i credits each arm on its OWN member, so
 * a cross-arm merge moves no arm's count, and the denominator is complete
 * snapshots), and `campaign.mjs verdict` now sweeps a band of thresholds and
 * REFUSES if a verdict ever does depend on one. A number whose wrongness is
 * detected per decision does not need validating in advance.
 *
 * @module tests/cross-model-buckets
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matchFindings } from '../scripts/lib/finding-match.mjs';
import { cohortDigest, aggregateMatched } from '../scripts/bakeoff-collect.mjs';

const FIXTURE = JSON.parse(fs.readFileSync('tests/fixtures/cross-model-pairs.json', 'utf8'));
const CALIBRATED = FIXTURE.calibratedThreshold;

describe('the committed calibration corpus', () => {
  it('carries all 48 real pairs, every one labelled', () => {
    assert.equal(FIXTURE.pairs.length, 48);
    assert.equal(FIXTURE.pairs.filter((p) => !p.label).length, 0);
  });

  it('records that the labels are MODEL-generated — provenance is not optional', () => {
    // The plan called for an independent operator. It did not get one. A future
    // reader must not mistake these for independent ground truth.
    assert.match(FIXTURE.labelProvenance.by, /model/i);
    assert.match(FIXTURE.labelProvenance.caveat, /self-agreement|bias/i);
  });

  it('holds ORDERED hash lists per strict bucket, not just counts', () => {
    // Counts cannot validate hash membership or order, so a counts-only fixture
    // would leave D3's guarantee permanently unassertable in a clean checkout.
    for (const s of FIXTURE.snapshots) {
      assert.ok(Array.isArray(s.strict.shadowOnly), `${s.snapshotId} missing ordered shadowOnly`);
      assert.ok(Array.isArray(s.strict.primaryOnly));
      assert.ok(Array.isArray(s.strict.both));
    }
    assert.equal(FIXTURE.snapshots.length, 5);
  });

  it('contains NO high-confidence secret — re-asserted on every run', async () => {
    // A one-time clean scan says nothing about the next regeneration.
    // Low-confidence `proper-name` hits are expected and tolerated: they fire on
    // capitalised technical prose ("Incorrect String Parsing"), and blanket-
    // redacting those would destroy the corpus the calibration reads.
    const { classifySecrets } = await import('../scripts/lib/security/secret-classifier.mjs');
    const c = classifySecrets(fs.readFileSync('tests/fixtures/cross-model-pairs.json', 'utf8'));
    assert.equal(c.highConfidence.length, 0);
  });
});

describe('the fixture cannot be mistaken for a validated calibration (audit H3/M2)', () => {
  it('is marked PROVISIONAL, and carries a checkable input manifest', () => {
    // The audit's point stands and is not "fixed" by asserting harder: these
    // labels came from the same author as the matcher, so the suite below can
    // only prove CONSISTENCY with them — never correctness. What the tests can
    // enforce is that nobody reads them as more than that.
    assert.match(FIXTURE.status, /PROVISIONAL/);
    assert.ok(FIXTURE.sourceManifest.inputs.length > 0, 'a prose regeneration note is not a manifest');
    assert.match(FIXTURE.sourceManifest.inputSetDigest, /^[0-9a-f]{16}$/);
  });

  it('every recorded input digest is well-formed, so regeneration is checkable', () => {
    for (const i of FIXTURE.sourceManifest.inputs) {
      assert.match(i.sha256, /^[0-9a-f]{16}$/, `${i.path} has no usable digest`);
      assert.match(i.path, /^\.audit\/bakeoff\//);
    }
  });
});

// NOTE ON WHAT FOLLOWS. These assert the threshold is CONSISTENT with the
// recorded labels — that it merges everything they call same-defect and nothing
// they call different-defect. They do NOT establish that the labels are right.
// Independent re-labelling, or the 7 held-out snapshots, is what would.
describe('the calibrated threshold is consistent with the recorded labels', () => {
  const cands = FIXTURE.pairs.filter((p) => p.sharedFiles.length > 0);

  it('merges every same-defect pair (recall 3/3)', () => {
    const missed = cands.filter((p) => p.label === 'same-defect' && p.similarity < CALIBRATED);
    assert.deepEqual(missed.map((p) => p.id), [], 'a same-defect pair fell below the threshold');
  });

  it('merges NO different-defect pair — the hard constraint', () => {
    // A false merge silently erases a genuine unique finding, which is the
    // failure this whole plan exists to fix. This is the assertion that must
    // never be relaxed to make a future threshold fit.
    const wrong = cands.filter((p) => p.label === 'different-defect' && p.similarity >= CALIBRATED);
    assert.deepEqual(wrong.map((p) => p.id), [], 'threshold admits a false merge');
  });

  it('sits strictly INSIDE the separating gap, not pinned to a data point', () => {
    const hiDiff = Math.max(...cands.filter((p) => p.label === 'different-defect').map((p) => p.similarity));
    const loSame = Math.min(...cands.filter((p) => p.label === 'same-defect').map((p) => p.similarity));
    assert.ok(CALIBRATED > hiDiff, `threshold ${CALIBRATED} must clear the highest different-defect ${hiDiff}`);
    assert.ok(CALIBRATED < loSame, `threshold ${CALIBRATED} must sit below the lowest same-defect ${loSame} (margin, not a knife edge)`);
  });

  it('the shipped config default IS the calibrated value', async () => {
    // Cluster A shipped 0.3 as a placeholder, which would merge NOTHING.
    const { findingMatchConfig } = await import('../scripts/lib/config.mjs');
    assert.equal(findingMatchConfig.threshold, CALIBRATED);
  });
});

describe('matchFindings on the real corpus', () => {
  it('runs the matcher at the PRODUCTION threshold and reproduces the labels', () => {
    // Audit M2: an earlier version called matchFindings with `threshold: 0`,
    // which makes every shared-file pair a candidate and asserts nothing about
    // the calibrated rule — the merge counting was done on the recorded number
    // instead of on the matcher. This exercises the real path: file gate,
    // threshold, one-to-one resolution, bucketing.
    //
    // The similarity function is INJECTED to return the recorded score, because
    // the committed signatures are REDACTED and Jaccard is a function of tokens
    // — re-scoring redacted text would measure a different quantity than the
    // one calibrated (R3/M1). The score is honest (raw-text, extraction-time);
    // only its delivery is injected.
    let merges = 0, falseMerges = 0, missed = 0;
    for (const p of FIXTURE.pairs.filter((x) => x.sharedFiles.length > 0)) {
      const mk = (hash) => ({ _hash: hash, category: '', section: p.sharedFiles.join(' '), detail: '', affectedFiles: p.sharedFiles });
      const r = matchFindings([mk(p.primaryHash)], [mk(p.shadowHash)], {
        threshold: CALIBRATED, coverageFloor: 0, similarity: () => p.similarity,
      });
      assert.ok(r.both === 0 || r.both === 1);
      if (r.both === 1) { merges++; if (p.label === 'different-defect') falseMerges++; }
      else if (p.label === 'same-defect') missed++;
    }
    assert.equal(falseMerges, 0, 'the matcher merged a pair the labels call distinct');
    assert.equal(missed, 0, 'the matcher missed a pair the labels call the same defect');
    assert.equal(merges, 3);
  });

  it('a pair below the threshold is bucketed as two uniques, not dropped', () => {
    // Conservation at the production threshold — a non-merge must still account
    // for both findings, or the matched view would under-report.
    const p = FIXTURE.pairs.find((x) => x.sharedFiles.length > 0 && x.label === 'different-defect');
    const mk = (h) => ({ _hash: h, category: '', section: p.sharedFiles.join(' '), detail: '', affectedFiles: p.sharedFiles });
    const r = matchFindings([mk('p1')], [mk('s1')], { threshold: CALIBRATED, coverageFloor: 0, similarity: () => p.similarity });
    assert.equal(r.both, 0);
    assert.equal(r.primaryOnly, 1);
    assert.equal(r.shadowOnly, 1);
  });
});

describe('cohortDigest — configuration identity', () => {
  const cfg = { threshold: 0.14, coverageFloor: 0.6, enabled: true };

  it('is stable across equal configs', () => {
    assert.equal(cohortDigest(1, cfg), cohortDigest(1, { ...cfg }));
  });

  it('changes when the THRESHOLD changes', () => {
    assert.notEqual(cohortDigest(1, cfg), cohortDigest(1, { ...cfg, threshold: 0.2 }));
  });

  it('changes when the SCHEMA VERSION changes at an identical threshold', () => {
    // A schema change with an unchanged threshold still changes what the
    // buckets mean; without this they would be averaged together silently.
    assert.notEqual(cohortDigest(1, cfg), cohortDigest(2, cfg));
  });

  it('an unstamped record gets its own cohort, never a real one', () => {
    assert.equal(cohortDigest(null, cfg), 'v0-unstamped');
    assert.equal(cohortDigest(1, null), 'v0-unstamped');
  });
});

describe('aggregateMatched — the arithmetic cannot invent a measurement', () => {
  const arm = (cohort, m) => ({ shadowState: 'ran', bucketsMatched: m, matchCohort: cohort });
  const bm = (over = {}) => ({ both: 1, primaryOnly: 0, shadowOnly: 2, unmatchablePrimary: 0, unmatchableShadow: 0, coverage: 0.9, verdict: 'ok', pairs: [], ...over });
  const snap = (arms) => ({ arms });

  it('a null coverage is EXCLUDED from the mean, not coerced to 0', () => {
    // `0.9 + null === 0.9` in JS, so a naive sum/N would report 0.45 here.
    const out = aggregateMatched([
      snap({ opus: arm('c1', bm()), kimi: arm('c1', bm({ coverage: null, verdict: 'not-applicable' })) }),
    ]);
    assert.equal(out.matchedCoverage, 0.9, 'the not-applicable row must not drag the mean');
    assert.equal(out.matchedTotals.notApplicable, 1);
  });

  it('all-null coverage reports null, never 0', () => {
    const out = aggregateMatched([
      snap({ opus: arm('c1', bm({ coverage: null, verdict: 'not-applicable' })) }),
    ]);
    assert.equal(out.matchedCoverage, null);
  });

  it('aggregates only the LARGEST cohort and names the excluded one', () => {
    const out = aggregateMatched([
      snap({ opus: arm('c1', bm()), kimi: arm('c1', bm()) }),
      snap({ opus: arm('c2', bm()), kimi: arm('c1', bm()) }),
    ]);
    assert.equal(out.matchedCohort, 'c1');
    assert.equal(out.matchedRows, 3);
    assert.deepEqual(out.matchedExcluded, [{ cohort: 'c2', rows: 1 }]);
  });

  it('a cohort tie breaks on the lowest digest, never input order', () => {
    const a = aggregateMatched([snap({ opus: arm('bbb', bm()), kimi: arm('aaa', bm()) })]);
    const b = aggregateMatched([snap({ opus: arm('aaa', bm()), kimi: arm('bbb', bm()) })]);
    assert.equal(a.matchedCohort, 'aaa');
    assert.equal(b.matchedCohort, 'aaa', 'same log, same answer regardless of order');
  });

  it('a null bucketsMatched is DROPPED before grouping — never dereferenced', () => {
    // The Gemini-gate finding: a disabled run shares a digest with an enabled
    // one, so filtering after grouping would read `.both` off null.
    const out = aggregateMatched([snap({ opus: arm('c1', null), kimi: arm('c1', bm()) })]);
    assert.equal(out.matchedRows, 1);
    assert.equal(out.matchedNotComputed, 1);
  });

  it('no matched rows at all yields nulls, not zeros', () => {
    const out = aggregateMatched([snap({ opus: arm('c1', null) })]);
    assert.equal(out.matchedCohort, null);
    assert.equal(out.matchedCoverage, null);
    assert.equal(out.matchedTotals, null);
  });
});
