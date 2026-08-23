/**
 * @fileoverview Store-backed outcome source for meta-assess.mjs
 * (docs/plans/meta-assess-store-backed-source.md). Locks the validity rules,
 * provenance state table, and the D2a/D4 "must not fabricate" guards each
 * finding in that plan's 4 GPT rounds + 3 Gemini rounds shaped.
 *
 * No database — `resolveOutcomeSource`'s tests inject `deps` (D1c); the one
 * DB-gated contract test lives separately in
 * tests/audit-metrics-findings-contract.test.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptFindingsToOutcomes, passRatesFromPassStats, resolveOutcomeSource,
} from '../scripts/lib/assessment-source.mjs';

// ── adaptFindingsToOutcomes ─────────────────────────────────────────────────

describe('adaptFindingsToOutcomes — validity rules (R1/M2)', () => {
  const base = { severity: 'HIGH', created_at: '2026-08-01T00:00:00Z', round_raised: 1 };

  it('maps accepted/severity_adjusted to accepted:true, dismissed to false', () => {
    const { records } = adaptFindingsToOutcomes([
      { ...base, adjudication_outcome: 'accepted' },
      { ...base, adjudication_outcome: 'severity_adjusted' },
      { ...base, adjudication_outcome: 'dismissed' },
    ]);
    assert.deepEqual(records.map((r) => r.accepted), [true, true, false]);
  });

  it('excludes a NULL adjudication_outcome without counting it (not a false positive)', () => {
    const { records, excluded } = adaptFindingsToOutcomes([{ ...base, adjudication_outcome: null }]);
    assert.equal(records.length, 0);
    assert.equal(excluded.unrecognisedOutcomeCount, 0, 'null is an absence, not an unrecognised value');
  });

  it('excludes and counts a non-null unrecognised adjudication_outcome', () => {
    const { records, excluded } = adaptFindingsToOutcomes([{ ...base, adjudication_outcome: 'made_up' }]);
    assert.equal(records.length, 0);
    assert.equal(excluded.unrecognisedOutcomeCount, 1);
  });

  it('excludes and counts an invalid severity', () => {
    const { records, excluded } = adaptFindingsToOutcomes([
      { ...base, severity: 'CRITICAL', adjudication_outcome: 'accepted' },
    ]);
    assert.equal(records.length, 0);
    assert.equal(excluded.invalidSeverityCount, 1);
  });

  it('excludes and counts an unparseable created_at, never defaulting to Date.now()', () => {
    const { records, excluded } = adaptFindingsToOutcomes([
      { ...base, created_at: 'not-a-date', adjudication_outcome: 'accepted' },
    ]);
    assert.equal(records.length, 0);
    assert.equal(excluded.invalidDateCount, 1);
  });

  it('excludes and counts a missing round_raised, never defaulting to 0', () => {
    const { records, excluded } = adaptFindingsToOutcomes([
      { ...base, round_raised: null, adjudication_outcome: 'accepted' },
    ]);
    assert.equal(records.length, 0);
    assert.equal(excluded.missingRoundCount, 1);
  });

  it('carries promptVariantId straight through, never a sentinel default', () => {
    const { records } = adaptFindingsToOutcomes([
      { ...base, adjudication_outcome: 'accepted', prompt_variant_id: 'v1' },
      { ...base, adjudication_outcome: 'accepted', prompt_variant_id: null },
    ]);
    assert.deepEqual(records.map((r) => r.promptVariantId), ['v1', null]);
  });

  it('never sets repoFingerprint — that is the resolver caller\'s job (M1/G1)', () => {
    const { records } = adaptFindingsToOutcomes([{ ...base, adjudication_outcome: 'accepted' }]);
    assert.equal('repoFingerprint' in records[0], false);
  });
});

// ── passRatesFromPassStats ──────────────────────────────────────────────────

describe('passRatesFromPassStats — D2a shape + validity rules', () => {
  it('sums across multiple rounds for one pass_name', () => {
    const { byPass } = passRatesFromPassStats([
      { pass_name: 'structure', findings_raised: 5, findings_accepted: 1, findings_dismissed: 2 },
      { pass_name: 'structure', findings_raised: 3, findings_accepted: 0, findings_dismissed: 1 },
    ]);
    assert.deepEqual(byPass.structure, {
      raised: 8, accepted: 1, dismissed: 3, decided: 4, coverage: 4 / 8, dismissRate: 3 / 4, measured: true,
    });
  });

  it('reports measured:false, dismissRate:null for an unlabelled pass (raised>0, 0 decided)', () => {
    const { byPass } = passRatesFromPassStats([
      { pass_name: 'quickfix', findings_raised: 10, findings_accepted: 0, findings_dismissed: 0 },
    ]);
    assert.equal(byPass.quickfix.measured, false);
    assert.equal(byPass.quickfix.dismissRate, null);
    assert.equal(byPass.quickfix.coverage, 0, 'coverage=0/10=0 IS measured — coverage differs from dismissRate');
  });

  it('dismissRate denominator is decided (accepted+dismissed), NOT raised (R2/H3)', () => {
    // The exact regression case: 100 raised, 1 accepted, 1 dismissed. Under
    // the R1 formula (raised denominator) this read as 1%; the real
    // adjudicated-outcome FP rate is 50% over the 2 decided.
    const { byPass } = passRatesFromPassStats([
      { pass_name: 'sustainability', findings_raised: 100, findings_accepted: 1, findings_dismissed: 1 },
    ]);
    assert.equal(byPass.sustainability.dismissRate, 0.5);
    assert.notEqual(byPass.sustainability.dismissRate, 0.01);
  });

  it('excludes a non-finite/negative/non-integer/unsafe count (never clamps)', () => {
    for (const bad of [NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const { byPass, invalidRowCount } = passRatesFromPassStats([
        { pass_name: 'p', findings_raised: bad, findings_accepted: 0, findings_dismissed: 0 },
      ]);
      assert.equal(byPass.p, undefined, `raised=${bad} must be excluded, not clamped`);
      assert.equal(invalidRowCount, 1);
    }
  });

  it('excludes an impossible state (accepted+dismissed > raised)', () => {
    const { byPass, invalidRowCount } = passRatesFromPassStats([
      { pass_name: 'p', findings_raised: 2, findings_accepted: 2, findings_dismissed: 2 },
    ]);
    assert.equal(byPass.p, undefined);
    assert.equal(invalidRowCount, 1);
  });

  it('excludes a missing/empty pass_name', () => {
    const { invalidRowCount } = passRatesFromPassStats([
      { pass_name: '', findings_raised: 1, findings_accepted: 1, findings_dismissed: 0 },
      { findings_raised: 1, findings_accepted: 1, findings_dismissed: 0 },
    ]);
    assert.equal(invalidRowCount, 2);
  });

  it('reports top-level measured:false when there are no pass-stat rows at all', () => {
    const result = passRatesFromPassStats([]);
    assert.deepEqual(result, { byPass: {}, measured: false, reason: 'no pass-stat rows in window', invalidRowCount: 0 });
  });

  it('keys come from the data, not from PASS_NAMES (locks D3)', () => {
    // "be-services" is a real pass this repo runs; it is NOT in config.mjs's
    // stale PASS_NAMES list — proving the roster is derived, not consulted.
    const { byPass } = passRatesFromPassStats([
      { pass_name: 'be-services', findings_raised: 1, findings_accepted: 0, findings_dismissed: 1 },
    ]);
    assert.ok('be-services' in byPass);
  });
});

// ── resolveOutcomeSource ─────────────────────────────────────────────────────

const FINDING = (over = {}) => ({
  severity: 'HIGH', adjudication_outcome: 'accepted',
  created_at: '2026-08-01T00:00:00Z', round_raised: 1, prompt_variant_id: null,
  ...over,
});
const PASS_STAT = (over = {}) => ({
  pass_name: 'structure', findings_raised: 1, findings_accepted: 1, findings_dismissed: 0,
  ...over,
});

function makeDeps({ findings = [], passStats = [], throwsAs = null, poolAbsent = false } = {}) {
  return {
    fetchCloudMetrics: async () => {
      if (throwsAs) throw throwsAs;
      if (poolAbsent) return null;
      return { runs: [], passStats, findings, labeled: [] };
    },
    loadOutcomes: () => [{ accepted: true, severity: 'HIGH', pass: 'local-pass', timestamp: Date.now(), round: 1 }],
  };
}

describe('resolveOutcomeSource — provenance state table (D1/R2H2)', () => {
  it('non-empty store rows -> provenance:store', async () => {
    const deps = makeDeps({ findings: [FINDING()], passStats: [PASS_STAT()] });
    const r = await resolveOutcomeSource({ days: 30, repoId: 'r1', source: 'auto', deps });
    assert.equal(r.provenance, 'store');
    assert.equal(r.records.length, 1);
  });

  it('a SUCCESSFUL empty store query -> provenance:store, records:[] — not none, not a local fallback', async () => {
    const deps = makeDeps({ findings: [], passStats: [] });
    const r = await resolveOutcomeSource({ days: 30, repoId: 'r1', source: 'auto', deps });
    assert.equal(r.provenance, 'store', 'this is the R2/H2 regression case');
    assert.deepEqual(r.records, []);
  });

  it('pool absent (fetchCloudMetrics returns null) -> falls back, provenance:local, no queryError', async () => {
    const deps = makeDeps({ poolAbsent: true });
    const r = await resolveOutcomeSource({ days: 30, repoId: 'r1', source: 'auto', deps });
    assert.equal(r.provenance, 'local');
    assert.equal(r.queryError, undefined);
  });

  it('a classified connection error falls back silently, no queryError (D1d)', async () => {
    const deps = makeDeps({ throwsAs: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    const r = await resolveOutcomeSource({ days: 30, repoId: 'r1', source: 'auto', deps });
    assert.equal(r.provenance, 'local');
    assert.equal(r.queryError, undefined, 'genuine unavailability must not be flagged as a masked bug');
  });

  it('an UNCLASSIFIED error still falls back, but WITH queryError (D1d — R3/M1 regression case)', async () => {
    // 42703 undefined_column is exactly what Gemini G1 caught in this plan's
    // own draft SQL — a real code bug, not unavailability.
    const deps = makeDeps({ throwsAs: Object.assign(new Error('column "repo_id" does not exist'), { code: '42703' }) });
    const r = await resolveOutcomeSource({ days: 30, repoId: 'r1', source: 'auto', deps });
    assert.equal(r.provenance, 'local');
    assert.equal(r.queryError.cause, '42703');
    assert.match(r.queryError.message, /repo_id/);
  });

  it('a bare error with NO .code still surfaces queryError (the classifier\'s literal "unknown" fallback)', async () => {
    const deps = makeDeps({ throwsAs: new TypeError('cannot read x of undefined') });
    const r = await resolveOutcomeSource({ days: 30, repoId: 'r1', source: 'auto', deps });
    assert.equal(r.provenance, 'local');
    assert.equal(r.queryError.cause, 'unknown');
  });

  it('source:local + repoId unresolvable -> provenance:local anyway, no identity check, no fetchCloudMetrics call', async () => {
    let cloudCalled = false;
    const deps = {
      fetchCloudMetrics: async () => { cloudCalled = true; return null; },
      loadOutcomes: () => [{ accepted: true, severity: 'HIGH', timestamp: Date.now(), round: 1 }],
    };
    const r = await resolveOutcomeSource({ repoId: null, source: 'local', deps });
    assert.equal(r.provenance, 'local');
    assert.equal(cloudCalled, false, 'source:local must never touch the pool');
  });

  it('source:local with a genuinely empty local result -> provenance:none (R4/L1)', async () => {
    const deps = { fetchCloudMetrics: async () => null, loadOutcomes: () => [] };
    const r = await resolveOutcomeSource({ source: 'local', deps });
    assert.equal(r.provenance, 'none');
  });

  it('source:local with ANY valid line -> provenance:local, even amid malformed ones (L1 "other valid lines still contribute")', async () => {
    const deps = { fetchCloudMetrics: async () => null, loadOutcomes: () => [{ accepted: true, severity: 'HIGH', timestamp: 1, round: 1 }] };
    const r = await resolveOutcomeSource({ source: 'local', deps });
    assert.equal(r.provenance, 'local');
  });

  it('source:store + cloud unavailable -> provenance:store-unavailable, never a local read', async () => {
    let localCalled = false;
    const deps = {
      fetchCloudMetrics: async () => null,
      loadOutcomes: () => { localCalled = true; return []; },
    };
    const r = await resolveOutcomeSource({ days: 30, repoId: 'r1', source: 'store', deps });
    assert.equal(r.provenance, 'store-unavailable');
    assert.equal(localCalled, false, 'store mode promises no fallback');
    assert.deepEqual(r.records, []);
  });
});

describe('resolveOutcomeSource — byPass, coverage, window, promptVariantMeasured', () => {
  it('byPass is the per-pass MAP, not passRatesFromPassStats\'s whole wrapper (regression guard for a real bug found during implementation)', async () => {
    const deps = makeDeps({ findings: [FINDING()], passStats: [PASS_STAT()] });
    const r = await resolveOutcomeSource({ days: 30, repoId: 'r1', source: 'auto', deps });
    assert.ok(r.byPass.structure, 'byPass.structure must exist — the map, not a nested byPass.byPass.structure');
    assert.equal('measured' in r.byPass && typeof r.byPass.measured === 'boolean' && r.byPass.structure === undefined, false);
    assert.equal(r.byPass.measured, undefined, 'the wrapper\'s own measured/reason must not leak into the returned map');
  });

  it('byPass is null for provenance:local (D2a — the presence-not-policy signal)', async () => {
    const deps = makeDeps({ poolAbsent: true });
    const r = await resolveOutcomeSource({ days: 30, repoId: 'r1', source: 'auto', deps });
    assert.equal(r.byPass, null);
  });

  it('coverage reflects raw total vs adapter-excluded counts (R4/M4 formula)', async () => {
    const deps = makeDeps({
      findings: [FINDING(), FINDING({ severity: 'BOGUS' })], // 1 valid, 1 excluded
      passStats: [PASS_STAT(), { pass_name: '', findings_raised: 1, findings_accepted: 0, findings_dismissed: 0 }], // 1 valid, 1 excluded
    });
    const r = await resolveOutcomeSource({ days: 30, repoId: 'r1', source: 'auto', deps });
    assert.deepEqual(r.coverage, {
      recordsTotal: 2, recordsExcluded: 1, passStatRowsTotal: 2, passStatRowsExcluded: 1,
    });
  });

  it('window.mode is "time" for store, "count" for local — never a mixed object', async () => {
    const storeR = await resolveOutcomeSource({ days: 30, repoId: 'r1', source: 'auto', deps: makeDeps({ findings: [FINDING()] }) });
    assert.equal(storeR.window.mode, 'time');
    assert.equal(storeR.window.windowSize, null);
    assert.ok(storeR.window.sinceIso);

    const localR = await resolveOutcomeSource({ source: 'local', deps: makeDeps({ poolAbsent: true }) });
    assert.equal(localR.window.mode, 'count');
    assert.equal(localR.window.days, null);
    assert.equal(localR.window.sinceIso, null);
  });

  it('promptVariantMeasured is a live measurement over the actual records, not a hardcoded constant (D5)', async () => {
    const withVariant = await resolveOutcomeSource({
      days: 30, repoId: 'r1', source: 'auto',
      deps: makeDeps({ findings: [FINDING({ prompt_variant_id: 'v1' })] }),
    });
    assert.equal(withVariant.promptVariantMeasured, true);

    const withoutVariant = await resolveOutcomeSource({
      days: 30, repoId: 'r1', source: 'auto',
      deps: makeDeps({ findings: [FINDING({ prompt_variant_id: null })] }),
    });
    assert.equal(withoutVariant.promptVariantMeasured, false);
  });

  it('repoFingerprint is set from the resolver\'s OWN repoId param, never read off a row (M1/G1 — repo_id is not a real column)', async () => {
    const deps = makeDeps({ findings: [FINDING()] });
    const r = await resolveOutcomeSource({ days: 30, repoId: 'repo-xyz', source: 'auto', deps });
    assert.equal(r.records[0].repoFingerprint, 'repo-xyz');
  });
});
