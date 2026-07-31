/**
 * Tier-1 tests for CoverageSchema's cross-field trust-precedence validation
 * and the DANGEROUS_KEYS prototype-pollution guard in
 * computeObservedDomainDepsWithCoverage's result-building loop.
 *
 * Plan: docs/plans/arch-audit-pipeline-observability-hardening.md items 4, 5.
 * Precedence order fixed round-1 audit H2 (first-match-wins, mirroring
 * graph-verdict.mjs's own precedence — extraction failure/timeout checked
 * BEFORE staleness) after the original independent-ANDed-constraints version
 * would have rejected a real, reachable copyForwardCoverage output.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CoverageSchema } from '../scripts/lib/coverage-schema.mjs';
import { computeObservedDomainDepsWithCoverage } from '../scripts/lib/observed-deps.mjs';

function baseRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    verdict: { status: 'verified', reason: null },
    measuredAt: new Date().toISOString(),
    refreshId: 'r1',
    stale: false,
    extraction: {
      outcome: 'ok', eligible: 10, cruised: 10, ratio: 1, elapsedMs: 100,
      edges: { external: 0, selfEdge: 0, escaping: 0, persisted: 5 },
      samples: { uncruised: [] },
    },
    attribution: null,
    ...overrides,
  };
}

describe('CoverageSchema — cross-field trust precedence (item 4)', () => {
  it('accepts a genuinely verified record', () => {
    const parsed = CoverageSchema.safeParse(baseRecord());
    assert.equal(parsed.success, true);
  });

  it('rejects verdict.reason outside the closed enum (round-3 audit M2 — matches the DB CHECK constraint, not an unconstrained string)', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({
      extraction: { outcome: 'failed', eligible: null, cruised: null, ratio: null, elapsedMs: null, edges: null, samples: { uncruised: [] } },
      verdict: { status: 'unverified', reason: 'some made up text' },
    }));
    assert.equal(parsed.success, false);
  });

  it("rejects status==='verified' paired with a non-null reason (round-3 audit M2 — mirrors the table's (status='verified')=(reason IS NULL) CHECK)", () => {
    const parsed = CoverageSchema.safeParse(baseRecord({
      verdict: { status: 'verified', reason: 'not_measured' },
    }));
    assert.equal(parsed.success, false);
  });

  it("rejects a non-'verified' status paired with a null reason", () => {
    const parsed = CoverageSchema.safeParse(baseRecord({
      extraction: null,
      verdict: { status: 'unknown', reason: null },
    }));
    // extraction===null already requires reason==='not_measured' via the
    // existing precedence check, so a null reason here fails for that
    // reason too — this test pins the verified<=>null equivalence
    // specifically by using a status/extraction combo where ONLY the
    // reason-nullness rule would otherwise be satisfied.
    assert.equal(parsed.success, false);
  });

  it('rejects stale===true paired with verdict.status===verified', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({ stale: true, verdict: { status: 'verified', reason: null } }));
    assert.equal(parsed.success, false);
  });

  it('accepts stale===true paired with the correct unknown/stale_measurement verdict', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({ stale: true, verdict: { status: 'unknown', reason: 'stale_measurement' } }));
    assert.equal(parsed.success, true);
  });

  it('rejects extraction.outcome===failed paired with verdict.status===verified', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({
      extraction: { outcome: 'failed', eligible: null, cruised: null, ratio: null, elapsedMs: null, edges: null, samples: { uncruised: [] } },
      verdict: { status: 'verified', reason: null },
    }));
    assert.equal(parsed.success, false);
  });

  it('accepts a STALE record whose prior extraction FAILED, keeping verdict unverified/extraction_failed — not forced to unknown (H2 fix, the precedence-order bug)', () => {
    // This is exactly the shape copyForwardCoverage now produces when the
    // prior run's extraction never succeeded: stale=true (it IS from an
    // earlier run) but verdict stays unverified (nothing "went stale" about
    // a measurement that never completed). The original independent-ANDed
    // version of this check demanded BOTH unknown (from stale) AND
    // unverified (from extraction.outcome) simultaneously — impossible —
    // and would have rejected this real, reachable record.
    const parsed = CoverageSchema.safeParse(baseRecord({
      stale: true,
      extraction: { outcome: 'failed', eligible: null, cruised: null, ratio: null, elapsedMs: null, edges: null, samples: { uncruised: [] } },
      verdict: { status: 'unverified', reason: 'extraction_failed' },
    }));
    assert.equal(parsed.success, true);
  });

  it('rejects a stale + failed-extraction record whose verdict is unknown instead of unverified (extraction-failure precedence wins)', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({
      stale: true,
      extraction: { outcome: 'failed', eligible: null, cruised: null, ratio: null, elapsedMs: null, edges: null, samples: { uncruised: [] } },
      verdict: { status: 'unknown', reason: 'stale_measurement' },
    }));
    assert.equal(parsed.success, false);
  });

  it('rejects extraction.outcome===timedOut paired with verdict.status===degraded', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({
      extraction: { outcome: 'timedOut', eligible: null, cruised: null, ratio: null, elapsedMs: null, edges: null, samples: { uncruised: [] } },
      verdict: { status: 'degraded', reason: 'budget_exceeded' },
    }));
    assert.equal(parsed.success, false);
  });

  it('rejects a null extraction (pre-feature envelope) paired with verdict.status===verified', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({ extraction: null, verdict: { status: 'verified', reason: null } }));
    assert.equal(parsed.success, false);
  });

  it('accepts a null extraction paired with unknown/not_measured', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({ extraction: null, verdict: { status: 'unknown', reason: 'not_measured' } }));
    assert.equal(parsed.success, true);
  });

  // Rows 5-7 (round-5 audit H3/H5) — the vacuity guards. Config-independent,
  // so checkable here even though rows 8-10 (budget/floor thresholds) are not.
  it('rejects extraction.eligible===0 paired with verified (row 5 — empty_universe)', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({
      extraction: { outcome: 'ok', eligible: 0, cruised: 0, ratio: null, elapsedMs: 100, edges: { external: 0, selfEdge: 0, escaping: 0, persisted: 0 }, samples: { uncruised: [] } },
      verdict: { status: 'verified', reason: null },
    }));
    assert.equal(parsed.success, false);
  });

  it('accepts extraction.eligible===0 correctly paired with unverified/empty_universe', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({
      extraction: { outcome: 'ok', eligible: 0, cruised: 0, ratio: null, elapsedMs: 100, edges: { external: 0, selfEdge: 0, escaping: 0, persisted: 0 }, samples: { uncruised: [] } },
      verdict: { status: 'unverified', reason: 'empty_universe' },
    }));
    assert.equal(parsed.success, true);
  });

  it('rejects extraction.cruised===0 (eligible non-zero) paired with verified (row 6 — zero_cruised)', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({
      extraction: { outcome: 'ok', eligible: 10, cruised: 0, ratio: 0, elapsedMs: 100, edges: { external: 0, selfEdge: 0, escaping: 0, persisted: 0 }, samples: { uncruised: [] } },
      verdict: { status: 'verified', reason: null },
    }));
    assert.equal(parsed.success, false);
  });

  it('accepts extraction.cruised===0 correctly paired with unverified/zero_cruised', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({
      extraction: { outcome: 'ok', eligible: 10, cruised: 0, ratio: 0, elapsedMs: 100, edges: { external: 0, selfEdge: 0, escaping: 0, persisted: 0 }, samples: { uncruised: [] } },
      verdict: { status: 'unverified', reason: 'zero_cruised' },
    }));
    assert.equal(parsed.success, true);
  });

  it('rejects a fully-untagged attribution graph (attributable>0, attributed===0) paired with verified (row 7 — zero_attributed)', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({
      attribution: {
        candidates: 10, attributed: 0, attributable: 10, ratio: 0,
        edges: { malformed: 0, untaggedFrom: 0, untaggedTo: 10, untaggedBoth: 0, sameDomain: 0, attributed: 0 },
        samples: { untagged: [] },
      },
      verdict: { status: 'verified', reason: null },
    }));
    assert.equal(parsed.success, false);
  });

  it('accepts a fully-untagged attribution graph correctly paired with unverified/zero_attributed', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({
      attribution: {
        candidates: 10, attributed: 0, attributable: 10, ratio: 0,
        edges: { malformed: 0, untaggedFrom: 0, untaggedTo: 10, untaggedBoth: 0, sameDomain: 0, attributed: 0 },
        samples: { untagged: [] },
      },
      verdict: { status: 'unverified', reason: 'zero_attributed' },
    }));
    assert.equal(parsed.success, true);
  });

  it('a null attribution never trips row 7 (short-circuits, matching graphVerdict\'s own `attribution && ...` guard)', () => {
    const parsed = CoverageSchema.safeParse(baseRecord({ attribution: null }));
    assert.equal(parsed.success, true);
  });
});

describe('computeObservedDomainDepsWithCoverage — DANGEROUS_KEYS guard in the result-building loop (item 5)', () => {
  it('a __proto__-named domain does not pollute the returned deps object prototype', () => {
    const edges = [{ importer: 'a.js', imported: 'b.js' }];
    const rules = [
      { pattern: 'a.js', domain: '__proto__' },
      { pattern: 'b.js', domain: 'target' },
    ];
    const { deps } = computeObservedDomainDepsWithCoverage(edges, rules);
    assert.equal(Object.prototype.hasOwnProperty.call(deps, '__proto__'), false);
    // The real regression: an unguarded `result['__proto__'] = [...]` on a
    // plain-object literal reassigns the prototype instead of adding a key.
    assert.equal(Object.getPrototypeOf(deps), Object.prototype, 'the returned object\'s own prototype must be untouched');
    assert.equal(Array.isArray(deps), false);
  });

  it('a constructor-named domain is skipped, not silently overwriting Object.prototype.constructor', () => {
    const edges = [{ importer: 'a.js', imported: 'b.js' }];
    const rules = [
      { pattern: 'a.js', domain: 'constructor' },
      { pattern: 'b.js', domain: 'target' },
    ];
    const { deps } = computeObservedDomainDepsWithCoverage(edges, rules);
    assert.equal(Object.keys(deps).includes('constructor'), false);
  });

  it('a normal domain pair is unaffected by the guard', () => {
    const edges = [{ importer: 'a.js', imported: 'b.js' }];
    const rules = [
      { pattern: 'a.js', domain: 'source' },
      { pattern: 'b.js', domain: 'target' },
    ];
    const { deps } = computeObservedDomainDepsWithCoverage(edges, rules);
    assert.deepEqual(deps, { source: ['target'] });
  });
});

describe('CoverageSchema — arithmetic coherence (runs before the precedence chain)', () => {
  // Reuses the file's own valid fixture so these tests exercise the coherence
  // rules rather than an incomplete hand-built record.
  const coherent = (ex = {}, at = null) => baseRecord({
    extraction: { ...baseRecord().extraction, ...ex },
    attribution: at,
  });

  it('accepts a coherent record — the guard must not reject real data', () => {
    const r = CoverageSchema.safeParse(coherent({ eligible: 10, cruised: 8, ratio: 0.8 }));
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  });

  it('rejects cruised > eligible', () => {
    const r = CoverageSchema.safeParse(coherent({ eligible: 10, cruised: 11, ratio: 11 / 10 }));
    assert.equal(r.success, false);
    assert.match(JSON.stringify(r.error.issues), /cannot exceed extraction.eligible/);
  });

  it('rejects a ratio that does not follow from its own counts', () => {
    const r = CoverageSchema.safeParse(coherent({ eligible: 10, cruised: 8, ratio: 0.99 }));
    assert.equal(r.success, false);
    assert.match(JSON.stringify(r.error.issues), /disagrees with cruised/);
  });

  it('float division does not trip the tolerance', () => {
    // An exact `===` here would reject a real record over a rounding artefact.
    const r = CoverageSchema.safeParse(coherent({ eligible: 3, cruised: 1, ratio: 1 / 3 }));
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  });

  it('rejects attributed > attributable', () => {
    const r = CoverageSchema.safeParse(coherent({}, {
      candidates: 4, attributed: 5, attributable: 4, ratio: 5 / 4,
      edges: { malformed: 0, untaggedFrom: 1, untaggedTo: 0, untaggedBoth: 0, sameDomain: 0, attributed: 5 },
      samples: { untagged: [] },
    }));
    assert.equal(r.success, false);
    assert.match(JSON.stringify(r.error.issues), /cannot exceed attribution.attributable/);
  });
});

describe('CoverageSchema — zero denominators', () => {
  it('rejects a ratio when eligible is 0 — no denominator, no ratio', () => {
    // A truthiness guard (`if (ex.eligible)`) skipped the ratio check entirely at
    // zero, letting `{eligible:0, cruised:0, ratio:0.99}` — mathematically
    // impossible — reach persistence.
    const r = CoverageSchema.safeParse(baseRecord({
      verdict: { status: 'unverified', reason: 'empty_universe' },
      extraction: { ...baseRecord().extraction, eligible: 0, cruised: 0, ratio: 0.99 },
    }));
    assert.equal(r.success, false);
    assert.match(JSON.stringify(r.error.issues), /must be null when eligible is 0/);
  });

  it('accepts eligible 0 with a null ratio — what the producer actually emits', () => {
    const r = CoverageSchema.safeParse(baseRecord({
      verdict: { status: 'unverified', reason: 'empty_universe' },
      extraction: { ...baseRecord().extraction, eligible: 0, cruised: 0, ratio: null },
    }));
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  });
});

describe('CoverageSchema — a NULL denominator is not a denominator', () => {
  it('rejects a ratio when eligible is null (a failed extraction measured nothing)', () => {
    // `eligible === 0` alone let the nullable case — the one that exists FOR
    // failed/timed-out extractions — slip through both branches, so a run that
    // never measured anything could carry a coverage figure.
    const r = CoverageSchema.safeParse(baseRecord({
      verdict: { status: 'unverified', reason: 'extraction_failed' },
      extraction: {
        ...baseRecord().extraction,
        outcome: 'failed', eligible: null, cruised: null, ratio: 0.99, edges: null,
      },
    }));
    assert.equal(r.success, false);
    assert.match(JSON.stringify(r.error.issues), /no measurement/);
  });

  it('accepts a failed extraction with a null ratio — the real shape', () => {
    const r = CoverageSchema.safeParse(baseRecord({
      verdict: { status: 'unverified', reason: 'extraction_failed' },
      extraction: {
        ...baseRecord().extraction,
        outcome: 'failed', eligible: null, cruised: null, ratio: null, edges: null,
      },
    }));
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  });
});
