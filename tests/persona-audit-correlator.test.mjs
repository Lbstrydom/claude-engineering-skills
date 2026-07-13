/**
 * @fileoverview Tests for scripts/lib/persona/audit-correlator.mjs — the
 * WS1 deterministic persona<->audit correlator
 * (docs/completed/persona-nav-feedback-recovery.md). Pure-function tests
 * only (Tier 1 — deterministic seam); the store/write side is exercised
 * by the empirical-verify doctrine on a real session, not mocked here.
 */
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  personaFindingHash, matchFinding, decideCorrelations,
  isSeverityUnderstated, buildStepUrlLookup, MATCHER_VERSION, FUZZY_THRESHOLD,
} from '../scripts/lib/persona/audit-correlator.mjs';

const p0 = (over = {}) => ({ code: 'P0', step: 1, element: 'Checkout button', observed: 'Checkout page crashes on click.', ...over });
const p1 = (over = {}) => ({ code: 'P1', step: 1, element: 'Checkout button', observed: 'Checkout page crashes on click.', ...over });
const auditFinding = (over = {}) => ({
  id: 'audit-1', run_id: 'run-1', finding_fingerprint: 'ffffffff',
  severity: 'HIGH', category: 'crash', primary_file: 'src/pages/checkout.tsx',
  detail_snapshot: 'Checkout page throws on click event.',
  run_created_at: '2026-07-13T00:00:00Z',
  ...over,
});

describe('personaFindingHash', () => {
  it('is stable for identical findings', () => {
    assert.equal(personaFindingHash(p0()), personaFindingHash(p0()));
  });
  it('changes when element/severity/observed changes', () => {
    const base = personaFindingHash(p0());
    assert.notEqual(base, personaFindingHash(p0({ element: 'Other button' })));
    assert.notEqual(base, personaFindingHash(p1())); // severity feeds the hash via `code`
    assert.notEqual(base, personaFindingHash(p0({ observed: 'Different symptom.' })));
  });
  it('degrades gracefully on a malformed finding (missing fields) — the raw hash function never throws, since it also serves the manual-repair CLI path where a human supplies a known-good finding; malformed-finding REJECTION from the automatic flow is decideCorrelations\' job, tested below', () => {
    assert.doesNotThrow(() => personaFindingHash({}));
    assert.equal(typeof personaFindingHash({}), 'string');
  });
  it('returns an 8-char hex string (semanticId contract)', () => {
    assert.match(personaFindingHash(p0()), /^[0-9a-f]{8}$/);
  });
});

describe('matchFinding — exact tier', () => {
  it('byte-equality against finding_fingerprint scores 1.0', () => {
    const finding = p0();
    const hash = personaFindingHash(finding);
    const exactCandidate = auditFinding({ finding_fingerprint: hash, primary_file: 'unrelated.mjs', detail_snapshot: 'unrelated' });
    const result = matchFinding(finding, hash, [exactCandidate], new Map());
    assert.equal(result.tier, 'exact');
    assert.equal(result.matchScore, 1.0);
  });
});

describe('matchFinding — fuzzy tier (Overlap Coefficient, Gemini gate round-2 fix)', () => {
  it('a short UI-element token set fully contained in a longer code-path token set scores high (the exact G1 regression case)', () => {
    // [checkout] fully contained in [src, pages, checkout, tsx] — Jaccard
    // would score this 0.25 (union-inflated by the longer path); Overlap
    // Coefficient correctly scores containment near 1.0 for the file-path
    // component. Combined with keyword overlap, total score clears 0.5.
    const finding = p0();
    const hash = personaFindingHash(finding);
    const candidate = auditFinding();
    const result = matchFinding(finding, hash, [candidate], new Map());
    assert.ok(result, 'expected a fuzzy match, got null — Jaccard-class regression');
    assert.equal(result.tier, 'fuzzy');
    assert.ok(result.matchScore >= FUZZY_THRESHOLD, `matchScore ${result.matchScore} must clear the PRODUCTION threshold, not a stale literal`);
  });

  it('a score between 0.5 and FUZZY_THRESHOLD (0.6) is rejected — pins the exact production boundary, would have wrongly matched under the old 0.5 threshold (audit-code M6/M7 fix)', () => {
    // fileScore: {checkout,page} (persona, size 2) fully contained in the
    // audit path's tokens → 2/2 = 1.0.
    // keywordScore: persona observed has 6 tokens, only "checkout" overlaps
    // the audit side's 7-token detail → 1/6 ≈ 0.167.
    // combined = 0.5*1.0 + 0.5*0.167 ≈ 0.583 — inside [0.5, 0.6): would
    // ACCEPT under a regressed 0.5 threshold, must REJECT under 0.6.
    const finding = p0({ element: 'Checkout Page', observed: 'checkout aaa bbb ccc ddd eee' });
    const hash = personaFindingHash(finding);
    const candidate = auditFinding({
      primary_file: 'src/routes/checkout/page.tsx',
      detail_snapshot: 'checkout xxx yyy zzz www vvv uuu',
    });
    const result = matchFinding(finding, hash, [candidate], new Map());
    assert.equal(result, null, 'a ~0.583 combined score must be rejected under FUZZY_THRESHOLD=0.6');
  });

  it('a single shared generic token (e.g. both sides mention only "Save") is NOT sufficient evidence — MIN_INFORMATIVE_TOKENS floor (audit-code H5/H8 fix)', () => {
    const finding = p0({ element: 'Save', observed: 'Save' });
    const hash = personaFindingHash(finding);
    // Both persona token sets are single-token ({save}) — degenerate
    // containment would score 1.0 on both axes pre-fix. The audit side is
    // deliberately UNRELATED beyond sharing the single "save" token.
    const candidate = auditFinding({
      primary_file: 'src/lib/unrelated-subsystem.mjs',
      detail_snapshot: 'save',
    });
    const result = matchFinding(finding, hash, [candidate], new Map());
    assert.equal(result, null, 'a single generic shared token must not independently confirm a match');
  });

  it('sub-threshold (genuinely unrelated finding + candidate) returns null, not a forced match', () => {
    const finding = p0({ element: 'Settings panel', observed: 'Theme toggle does not persist across reloads.' });
    const hash = personaFindingHash(finding);
    const candidate = auditFinding({ primary_file: 'src/api/payments.mjs', detail_snapshot: 'Payment webhook signature validation missing.' });
    const result = matchFinding(finding, hash, [candidate], new Map());
    assert.equal(result, null);
  });

  it('ties break by newest audit run, then highest severity', () => {
    const finding = p0();
    const hash = personaFindingHash(finding);
    const older = auditFinding({ id: 'older', run_created_at: '2026-01-01T00:00:00Z', severity: 'LOW' });
    const newer = auditFinding({ id: 'newer', run_created_at: '2026-06-01T00:00:00Z', severity: 'LOW' });
    const result = matchFinding(finding, hash, [older, newer], new Map());
    assert.equal(result.auditFinding.id, 'newer');
  });

  it('token normalization drops short tokens and is case/punctuation-insensitive', () => {
    const finding = p0({ element: 'CHECKOUT-Button!!', observed: 'Checkout Page Crashes On Click.' });
    const hash = personaFindingHash(finding);
    const candidate = auditFinding();
    const result = matchFinding(finding, hash, [candidate], new Map());
    assert.ok(result, 'normalization should still allow a match despite case/punctuation differences');
  });

  it('a pure single-signal match (perfect file-path containment, zero keyword overlap) is rejected even though the combined score would clear 0.5 (audit-code H5/M8 fix — dual-signal floor)', () => {
    const finding = p0({ element: 'Checkout', observed: 'zzzzunique symptom text' });
    const hash = personaFindingHash(finding);
    const candidate = auditFinding({ primary_file: 'src/pages/checkout.tsx', detail_snapshot: 'totally different wording entirely' });
    const result = matchFinding(finding, hash, [candidate], new Map());
    assert.equal(result, null, 'file-path-only containment must not clear the bar without keyword corroboration');
  });
});

describe('isSeverityUnderstated', () => {
  it('P0 persona finding + LOW/MEDIUM audit severity is understated', () => {
    assert.equal(isSeverityUnderstated(p0(), auditFinding({ severity: 'LOW' })), true);
    assert.equal(isSeverityUnderstated(p0(), auditFinding({ severity: 'MEDIUM' })), true);
  });
  it('P0 + HIGH audit severity is NOT understated', () => {
    assert.equal(isSeverityUnderstated(p0(), auditFinding({ severity: 'HIGH' })), false);
  });
  it('P1 persona finding is never understated (rule is P0-only)', () => {
    assert.equal(isSeverityUnderstated(p1(), auditFinding({ severity: 'LOW' })), false);
  });
});

describe('buildStepUrlLookup', () => {
  it('maps step number to sanitized url', () => {
    const map = buildStepUrlLookup([{ step: 1, url: 'https://example.com/checkout?token=secret123456' }]);
    assert.equal(map.size, 1);
    assert.ok(map.get(1));
  });
  it('degrades to an empty map on non-array input', () => {
    assert.equal(buildStepUrlLookup(undefined).size, 0);
    assert.equal(buildStepUrlLookup(null).size, 0);
  });
});

describe('decideCorrelations', () => {
  it('filters to P0/P1 only — P2/P3 findings are never emitted', () => {
    const { emissions } = decideCorrelations({
      findings: [p0(), { code: 'P2', element: 'x', observed: 'y' }, { code: 'P3', element: 'x', observed: 'y' }],
      clickPath: [], candidates: [auditFinding()], alreadyCorrelatedHashes: new Set(),
    });
    assert.equal(emissions.length, 1);
  });

  it('a match emits confirmed_hit (or severity_understated) with matcherVersion attached', () => {
    const { emissions } = decideCorrelations({
      findings: [p0()], clickPath: [], candidates: [auditFinding({ severity: 'LOW' })],
      alreadyCorrelatedHashes: new Set(),
    });
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].correlationType, 'severity_understated'); // P0 vs LOW
    assert.equal(emissions[0].matcherVersion, MATCHER_VERSION);
  });

  it('no match with a NON-EMPTY candidate set emits audit_missed with a non-null audit_run_id', () => {
    const finding = p0({ element: 'Settings panel', observed: 'Theme toggle does not persist.' });
    const { emissions } = decideCorrelations({
      findings: [finding], clickPath: [],
      candidates: [auditFinding({ primary_file: 'src/api/payments.mjs', detail_snapshot: 'unrelated' })],
      alreadyCorrelatedHashes: new Set(),
    });
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].correlationType, 'audit_missed');
    assert.equal(emissions[0].auditFindingId, null);
    assert.ok(emissions[0].auditRunId, 'audit_missed must carry a non-null audit_run_id on the auto path');
  });

  it('already-correlated findings are skipped (first-hit-wins, enforced by the caller-supplied set) — skippedExisting counts them', () => {
    const finding = p0();
    const hash = personaFindingHash(finding);
    const { emissions, skippedExisting } = decideCorrelations({
      findings: [finding], clickPath: [], candidates: [auditFinding()],
      alreadyCorrelatedHashes: new Set([hash]),
    });
    assert.equal(emissions.length, 0);
    assert.equal(skippedExisting, 1);
  });

  it('empty findings array emits nothing, zero skipped', () => {
    const { emissions, skippedExisting } = decideCorrelations({
      findings: [], clickPath: [], candidates: [auditFinding()], alreadyCorrelatedHashes: new Set(),
    });
    assert.equal(emissions.length, 0);
    assert.equal(skippedExisting, 0);
  });

  it('idempotency: re-running decideCorrelations with the previous run\'s hashes as alreadyCorrelatedHashes produces zero new emissions for BOTH matched and missed shapes', () => {
    const matched = p0();
    const missed = p0({ element: 'Settings panel', observed: 'Theme toggle does not persist.' });
    const candidates = [auditFinding()];
    const first = decideCorrelations({ findings: [matched, missed], clickPath: [], candidates, alreadyCorrelatedHashes: new Set() });
    assert.equal(first.emissions.length, 2);
    const seenHashes = new Set(first.emissions.map((e) => e.personaFindingHash));
    const second = decideCorrelations({ findings: [matched, missed], clickPath: [], candidates, alreadyCorrelatedHashes: seenHashes });
    assert.equal(second.emissions.length, 0);
    assert.equal(second.skippedExisting, 2);
  });

  it('intra-session dedup: two findings with the SAME identity hash in one call emit exactly once (audit-code M3 fix)', () => {
    const { emissions, skippedExisting } = decideCorrelations({
      findings: [p0(), p0()], clickPath: [], candidates: [auditFinding()],
      alreadyCorrelatedHashes: new Set(),
    });
    assert.equal(emissions.length, 1);
    assert.equal(skippedExisting, 1);
  });

  it('quarantines a P0/P1 finding missing element/observed — never hashed, matched, or emitted (audit-code H4 fix)', () => {
    const { emissions, malformed } = decideCorrelations({
      findings: [p0({ element: '' }), p0({ observed: '   ' }), { code: 'P1' }],
      clickPath: [], candidates: [auditFinding()], alreadyCorrelatedHashes: new Set(),
    });
    assert.equal(emissions.length, 0);
    assert.equal(malformed, 3);
  });

  it('two DIFFERENT malformed findings never collapse onto the same emitted identity — quarantine prevents the collision entirely', () => {
    const missingElement = p0({ element: '' });
    const missingObserved = p0({ observed: '' });
    const { emissions, malformed } = decideCorrelations({
      findings: [missingElement, missingObserved], clickPath: [],
      candidates: [auditFinding()], alreadyCorrelatedHashes: new Set(),
    });
    // Both are malformed and neither is emitted — the shared-empty-string
    // hash they WOULD have produced never reaches the seen-set or a write.
    assert.equal(emissions.length, 0);
    assert.equal(malformed, 2);
  });

  it('a well-formed finding alongside a malformed one in the same batch: only the well-formed one is decided', () => {
    const { emissions, malformed } = decideCorrelations({
      findings: [p0(), p0({ element: '' })], clickPath: [],
      candidates: [auditFinding({ severity: 'LOW' })], alreadyCorrelatedHashes: new Set(),
    });
    assert.equal(emissions.length, 1);
    assert.equal(malformed, 1);
  });
});
