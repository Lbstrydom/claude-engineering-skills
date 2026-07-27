/**
 * @fileoverview Tests for scripts/lib/persona/audit-correlator.mjs — the
 * WS1 deterministic persona<->audit correlator
 * (docs/plans/persona-nav-feedback-recovery.md) plus the v2 identity
 * contract from docs/plans/persona-finding-hash-versioning.md. Pure-function
 * tests only (Tier 1 — deterministic seam); the store/write side is
 * exercised by the empirical-verify doctrine on a real session, not mocked
 * here.
 */
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  personaFindingHash, personaFindingHashV1, matchFinding, decideCorrelations,
  isSeverityUnderstated, buildStepUrlLookup, isMalformedFinding, MATCHER_VERSION,
  PERSONA_FINDING_HASH_VERSION, FUZZY_THRESHOLD,
} from '../scripts/lib/persona/audit-correlator.mjs';

const noRoute = () => new Map();
const p0 = (over = {}) => ({ code: 'P0', step: 1, element: 'Checkout button', observed: 'Checkout page crashes on click.', ...over });
const p1 = (over = {}) => ({ code: 'P1', step: 1, element: 'Checkout button', observed: 'Checkout page crashes on click.', ...over });
const auditFinding = (over = {}) => ({
  id: 'audit-1', run_id: 'run-1', finding_fingerprint: 'ffffffff',
  severity: 'HIGH', category: 'crash', primary_file: 'src/pages/checkout.tsx',
  detail_snapshot: 'Checkout page throws on click event.',
  run_created_at: '2026-07-13T00:00:00Z',
  ...over,
});

describe('personaFindingHash (v2 identity — docs/plans/persona-finding-hash-versioning.md)', () => {
  it('is stable for identical findings', () => {
    assert.equal(personaFindingHash(p0(), noRoute()), personaFindingHash(p0(), noRoute()));
  });
  it('changes when element/severity/observed changes', () => {
    const base = personaFindingHash(p0(), noRoute());
    assert.notEqual(base, personaFindingHash(p0({ element: 'Other button' }), noRoute()));
    assert.notEqual(base, personaFindingHash(p1(), noRoute())); // severity feeds the hash via `code`
    assert.notEqual(base, personaFindingHash(p0({ observed: 'Different symptom.' }), noRoute()));
  });
  it('changes when the resolved route changes (the whole point of this plan)', () => {
    const same = p0();
    const routeA = new Map([[1, '/checkout']]);
    const routeB = new Map([[1, '/settings']]);
    assert.notEqual(personaFindingHash(same, routeA), personaFindingHash(same, routeB));
  });
  it('degrades gracefully on a malformed finding (missing fields) — never throws on the finding shape, since it also serves the manual-repair CLI path where a human supplies a known-good finding; malformed-finding REJECTION from the automatic flow is decideCorrelations\' job, tested below', () => {
    assert.doesNotThrow(() => personaFindingHash({}, noRoute()));
    assert.equal(typeof personaFindingHash({}, noRoute()), 'string');
  });
  it('returns a 64-char hex string — full untruncated SHA-256, NOT semanticId\'s 8-hex truncation (R1 finding H4)', () => {
    assert.match(personaFindingHash(p0(), noRoute()), /^[0-9a-f]{64}$/);
  });

  it('throws when called without a second argument (R2 finding M4 — required, not optional)', () => {
    assert.throws(() => personaFindingHash(p0()));
  });
  it('behaves correctly with an explicit empty Map() — the supported "no route context" value, distinct from omitting the argument', () => {
    assert.doesNotThrow(() => personaFindingHash(p0(), new Map()));
  });

  it('does NOT re-sanitize its route input — consumes stepUrlByNumber\'s value verbatim (R3 finding M7, tightened at code-audit R2 finding M3: the prior version of this test hashed the same literal value twice and asserted equality, which an idempotent re-sanitize would ALSO satisfy — it never actually proved non-re-sanitization). Uses a raw, sanitizeStepUrl-shaped input the sanitizer is NOT idempotent on, and asserts the hash matches a payload built from the VERBATIM value, not the sanitized one.', () => {
    // sanitizeStepUrl collapses an auth-keyword query value to the literal
    // string ":param" — so a raw value containing "token=<anything>" and
    // the ALREADY-sanitized "token=:param" are DIFFERENT strings, but
    // re-sanitizing the raw value converges to the same sanitized form.
    // If personaFindingHash re-sanitized internally, hashing the raw form
    // would produce the SAME hash as hashing the pre-sanitized form
    // (since sanitizeStepUrl(raw) === sanitizeStepUrl(sanitized) here).
    // Consuming the map value verbatim means the two must NOT match.
    const rawValue = 'https://example.com/checkout?token=abc123def456';
    const alreadySanitizedValue = '/checkout?token=:param';
    const finding = p0();

    const hashFromRaw = personaFindingHash(finding, new Map([[1, rawValue]]));
    const hashFromSanitized = personaFindingHash(finding, new Map([[1, alreadySanitizedValue]]));
    assert.notEqual(hashFromRaw, hashFromSanitized, 'a raw value and its already-sanitized form must hash DIFFERENTLY if personaFindingHash consumes the map verbatim');

    // Positive proof: the hash from the raw value matches a payload built
    // from that EXACT raw string (trimmed/lowercased, per the v2 contract)
    // — not from re-sanitizing it first.
    const expectedPayload = {
      element: 'checkout button', code: 'p0', route: rawValue.toLowerCase(),
      expected: '', observed: 'checkout page crashes on click.',
    };
    const expectedHash = crypto.createHash('sha256').update(JSON.stringify(expectedPayload)).digest('hex');
    assert.equal(hashFromRaw, expectedHash, 'the hash must be derivable from the RAW map value, proving no hidden re-sanitization step ran');
  });

  it('trims incidental whitespace before hashing — visually-identical findings differing only by leading/trailing whitespace hash the SAME (Gemini gate R3 finding G3)', () => {
    const clean = p0({ expected: 'Checkout succeeds', observed: 'Checkout crashes' });
    const padded = p0({ expected: '  Checkout succeeds  ', observed: '\tCheckout crashes\n' });
    assert.equal(personaFindingHash(clean, noRoute()), personaFindingHash(padded, noRoute()));
  });

  it('v2 payload/hash fixture regression-lock — fixed key order, trim-then-lowercase, full untruncated SHA-256 (R1 H4 + Gemini gate R3 G3). A future refactor that reorders the object literal, drops .trim(), or swaps JSON.stringify for something "equivalent" must fail this test.', () => {
    const finding = { element: 'Checkout Button', code: 'P0', step: 1, expected: ' Order confirms ', observed: ' Page crashes ' };
    const stepUrlByNumber = new Map([[1, '/checkout']]);
    const payload = {
      element: 'checkout button', code: 'p0', route: '/checkout',
      expected: 'order confirms', observed: 'page crashes',
    };
    const expected = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    assert.equal(personaFindingHash(finding, stepUrlByNumber), expected);
  });
});

describe('personaFindingHashV1 (frozen legacy formula, backfill-only)', () => {
  it('is byte-identical to the pre-fix formula — the backfill\'s correctness depends on this never drifting from what actually shipped as v1', () => {
    const finding = { element: 'Checkout button', code: 'P0', observed: 'Checkout page crashes on click.' };
    assert.equal(personaFindingHashV1(finding), '8cd7390f');
  });
  it('returns an 8-char hex string (semanticId contract, unchanged)', () => {
    assert.match(personaFindingHashV1(p0()), /^[0-9a-f]{8}$/);
  });
  it('is stable for identical findings, independent of route (v1 never had route context)', () => {
    assert.equal(personaFindingHashV1(p0()), personaFindingHashV1(p0()));
  });
});

describe('PERSONA_FINDING_HASH_VERSION / MATCHER_VERSION independence (R2 finding M3)', () => {
  it('PERSONA_FINDING_HASH_VERSION is 2', () => {
    assert.equal(PERSONA_FINDING_HASH_VERSION, 2);
  });
  it('MATCHER_VERSION is untouched by this plan — stays at 1, a genuinely separate concern (correlation/matching-algorithm provenance, not hash identity)', () => {
    assert.equal(MATCHER_VERSION, 1);
  });
  it('personaFindingHash\'s output does not depend on MATCHER_VERSION in any way (the two constants are truly decoupled, not just documented as such)', () => {
    // If personaFindingHash ever accidentally read MATCHER_VERSION, this
    // fixture would need updating in lockstep with a MATCHER_VERSION bump —
    // it does not, by construction (the source has no such reference).
    const finding = p0();
    const before = personaFindingHash(finding, noRoute());
    assert.equal(MATCHER_VERSION, 1); // sanity: still the value fixed at module load
    const after = personaFindingHash(finding, noRoute());
    assert.equal(before, after);
  });
});

describe('matchFinding — exact tier', () => {
  it('byte-equality against finding_fingerprint scores 1.0', () => {
    const finding = p0();
    const hash = personaFindingHash(finding, noRoute());
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
    const hash = personaFindingHash(finding, noRoute());
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
    const hash = personaFindingHash(finding, noRoute());
    const candidate = auditFinding({
      primary_file: 'src/routes/checkout/page.tsx',
      detail_snapshot: 'checkout xxx yyy zzz www vvv uuu',
    });
    const result = matchFinding(finding, hash, [candidate], new Map());
    assert.equal(result, null, 'a ~0.583 combined score must be rejected under FUZZY_THRESHOLD=0.6');
  });

  it('a single shared generic token (e.g. both sides mention only "Save") is NOT sufficient evidence — MIN_INFORMATIVE_TOKENS floor (audit-code H5/H8 fix)', () => {
    const finding = p0({ element: 'Save', observed: 'Save' });
    const hash = personaFindingHash(finding, noRoute());
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
    const hash = personaFindingHash(finding, noRoute());
    const candidate = auditFinding({ primary_file: 'src/api/payments.mjs', detail_snapshot: 'Payment webhook signature validation missing.' });
    const result = matchFinding(finding, hash, [candidate], new Map());
    assert.equal(result, null);
  });

  it('ties break by newest audit run, then highest severity', () => {
    const finding = p0();
    const hash = personaFindingHash(finding, noRoute());
    const older = auditFinding({ id: 'older', run_created_at: '2026-01-01T00:00:00Z', severity: 'LOW' });
    const newer = auditFinding({ id: 'newer', run_created_at: '2026-06-01T00:00:00Z', severity: 'LOW' });
    const result = matchFinding(finding, hash, [older, newer], new Map());
    assert.equal(result.auditFinding.id, 'newer');
  });

  it('token normalization drops short tokens and is case/punctuation-insensitive', () => {
    const finding = p0({ element: 'CHECKOUT-Button!!', observed: 'Checkout Page Crashes On Click.' });
    const hash = personaFindingHash(finding, noRoute());
    const candidate = auditFinding();
    const result = matchFinding(finding, hash, [candidate], new Map());
    assert.ok(result, 'normalization should still allow a match despite case/punctuation differences');
  });

  it('a pure single-signal match (perfect file-path containment, zero keyword overlap) is rejected even though the combined score would clear 0.5 (audit-code H5/M8 fix — dual-signal floor)', () => {
    const finding = p0({ element: 'Checkout', observed: 'zzzzunique symptom text' });
    const hash = personaFindingHash(finding, noRoute());
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

describe('isMalformedFinding (Gemini gate finding G1 — exported so read/write paths outside decideCorrelations can quarantine it too)', () => {
  it('flags a finding missing element', () => {
    assert.equal(isMalformedFinding(p0({ element: '' })), true);
  });
  it('flags a finding missing observed', () => {
    assert.equal(isMalformedFinding(p0({ observed: '   ' })), true);
  });
  it('does NOT flag a well-formed finding', () => {
    assert.equal(isMalformedFinding(p0()), false);
  });
  it('two UNRELATED malformed findings (different code/step, both missing element+observed) collapse onto the SAME personaFindingHash — confirms the wildcard-collision risk this export exists to let callers prevent is real, not hypothetical', () => {
    const findingA = { code: 'P0', step: 1, element: '', observed: '' };
    const findingB = { code: 'P0', step: 2, element: '', observed: '' };
    assert.ok(isMalformedFinding(findingA));
    assert.ok(isMalformedFinding(findingB));
    // Both resolve to route:'' too (neither step is in the empty map), so
    // EVERY component of the v2 payload is identical between the two.
    assert.equal(
      personaFindingHash(findingA, noRoute()),
      personaFindingHash(findingB, noRoute()),
      'malformed findings must collide onto the same hash when unquarantined — this is exactly why callers must filter isMalformedFinding before hashing',
    );
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
    const hash = personaFindingHash(finding, noRoute());
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

  it('threads clickPath\'s resolved route into the hash — two otherwise-identical findings observed on DIFFERENT steps/pages get DIFFERENT personaFindingHash values (docs/plans/persona-finding-hash-versioning.md, the last-mile wiring this plan closes)', () => {
    const onCheckout = p0({ step: 1 });
    const onSettings = p0({ step: 2 });
    const clickPath = [
      { step: 1, url: 'https://example.com/checkout' },
      { step: 2, url: 'https://example.com/settings' },
    ];
    // A non-empty but unrelated candidate set — audit_missed requires
    // >=1 candidate to be evidence of a miss at all (an empty candidate
    // set is not); this candidate doesn't match either finding, so both
    // are decided as audit_missed while still exercising the route-hash
    // threading this test targets.
    const unrelatedCandidate = auditFinding({ primary_file: 'src/api/payments.mjs', detail_snapshot: 'Payment webhook signature validation missing.' });
    const { emissions } = decideCorrelations({
      findings: [onCheckout, onSettings], clickPath, candidates: [unrelatedCandidate], alreadyCorrelatedHashes: new Set(),
    });
    assert.equal(emissions.length, 2);
    assert.notEqual(emissions[0].personaFindingHash, emissions[1].personaFindingHash);
  });
});
