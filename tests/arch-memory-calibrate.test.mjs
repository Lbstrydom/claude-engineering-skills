/**
 * Tier-1 tests for the arch-memory calibration harness (pure functions only).
 * Plan: docs/plans/arch-memory-band-recalibration.md §7c.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  median,
  percentile,
  validateProbeSet,
  matchesExpected,
  computeMetrics,
  deriveThresholds,
  probeSetHash,
  CALIBRATION_K,
  MIN_PROBES,
  MIN_HARD_NEGATIVES,
} from '../scripts/lib/arch-memory/calibrate.mjs';

const FIXTURE = path.resolve('tests/fixtures/arch-memory-probes.json');

describe('calibrate / k matches production', () => {
  it('calibrates at the k the UserPromptSubmit hook actually uses', () => {
    // Gemini G3: the hook hardcodes k:5. Calibrating at k=8 would tune against
    // a candidate set production never sees.
    assert.equal(CALIBRATION_K, 5);
    const hook = fs.readFileSync('.claude/hooks/arch-memory-check.sh', 'utf-8');
    const m = hook.match(/\bk:\s*(\d+)/);
    assert.ok(m, 'hook must declare a k');
    assert.equal(Number(m[1]), CALIBRATION_K, 'harness k and hook k must not drift');
  });
});

describe('calibrate / committed probe fixture is valid', () => {
  it('passes its own composition rules', () => {
    const probes = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')).probes;
    const r = validateProbeSet(probes);
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
  });

  it('carries enough hard negatives to constrain a threshold', () => {
    const probes = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')).probes;
    assert.ok(probes.length >= MIN_PROBES);
    assert.ok(probes.filter(p => p.relation === 'none').length >= MIN_HARD_NEGATIVES);
  });

  it('identifies symbols by (filePath, symbolName), never by UUID', () => {
    const probes = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')).probes;
    for (const p of probes.filter(x => x.relation !== 'none')) {
      assert.ok(p.expected.filePath && p.expected.symbolName);
      assert.equal('id' in p.expected, false, 'a UUID would rot on the next arch:refresh');
    }
  });
});

describe('calibrate / probe-set validation rejects weak sets', () => {
  it('rejects too few probes', () => {
    const r = validateProbeSet([{ id: 'a', intent: 'x', relation: 'none', stratum: 's' }]);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /≥30 probes/.test(e)));
  });

  it('rejects a set with no hard negatives', () => {
    const probes = Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`, intent: 'x', relation: 'reuse', stratum: `s${i % 4}`,
      expected: { filePath: 'a.mjs', symbolName: 'f' },
    }));
    const r = validateProbeSet(probes);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /hard negatives/.test(e)));
  });

  it('rejects a set concentrated in too few strata', () => {
    const probes = Array.from({ length: 40 }, (_, i) => ({
      id: `p${i}`, intent: 'x', relation: i < 12 ? 'none' : 'reuse', stratum: 'only-one',
      ...(i < 12 ? {} : { expected: { filePath: 'a.mjs', symbolName: 'f' } }),
    }));
    const r = validateProbeSet(probes);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /strata/.test(e)));
  });
});

describe('calibrate / success-path adversarialism (AGENTS.md)', () => {
  it('zero resolved probes reads `unverified`, NEVER a clean precision', () => {
    const m = computeMetrics([]);
    assert.equal(m.verdict, 'unverified');
    assert.equal(m.resolvedCount, 0);
    assert.equal('gates' in m, false, 'must not report gate results it never measured');
  });

  it('all-errored probes also read `unverified`', () => {
    const m = computeMetrics([
      { probe: { relation: 'reuse' }, error: 'rpc down' },
      { probe: { relation: 'none' }, error: 'rpc down' },
    ]);
    assert.equal(m.verdict, 'unverified');
  });

  it('median of an empty set is null, not 0', () => {
    assert.equal(median([]), null);
    assert.equal(percentile([], 0.95), null);
  });
});

describe('calibrate / metrics', () => {
  const probeP = (id) => ({ id, relation: 'reuse', intent: 'x', stratum: 's', expected: { filePath: 'a.mjs', symbolName: 'target' } });
  const probeN = (id) => ({ id, relation: 'none', intent: 'x', stratum: 'u' });
  const rec = (fp, sym, sim) => ({ filePath: fp, symbolName: sym, similarityScore: sim });

  it('separates retrieval failure from banding failure via recall', () => {
    const results = [
      { probe: probeP('p1'), records: [rec('a.mjs', 'target', 0.9)] },
      { probe: probeP('p2'), records: [rec('other.mjs', 'nope', 0.7)] }, // not retrieved
      { probe: probeN('n1'), records: [rec('z.mjs', 'zz', 0.5)] },
    ];
    const m = computeMetrics(results);
    assert.equal(m.gates.recallAtK.value, 0.5);
    assert.equal(m.gates.recallAtK.pass, false);
  });

  it('computes separation as median(positive) − median(hard-negative best)', () => {
    const results = [
      { probe: probeP('p1'), records: [rec('a.mjs', 'target', 0.90)] },
      { probe: probeN('n1'), records: [rec('z.mjs', 'zz', 0.50)] },
    ];
    const m = computeMetrics(results);
    assert.ok(Math.abs(m.gates.separation.value - 0.40) < 1e-9);
    assert.equal(m.gates.separation.pass, true);
  });

  it('fails the gate when positives and negatives are not separated', () => {
    const results = [
      { probe: probeP('p1'), records: [rec('a.mjs', 'target', 0.61)] },
      { probe: probeN('n1'), records: [rec('z.mjs', 'zz', 0.58)] },
    ];
    const m = computeMetrics(results);
    assert.equal(m.verdict, 'fail');
    assert.equal(m.gates.separation.pass, false);
  });

  it('matchesExpected accepts a declared alternate', () => {
    const probe = {
      expected: { filePath: 'a.mjs', symbolName: 'f' },
      alternates: [{ filePath: 'b.mjs', symbolName: 'g' }],
    };
    assert.equal(matchesExpected(rec('b.mjs', 'g', 0.8), probe), true);
    assert.equal(matchesExpected(rec('c.mjs', 'h', 0.8), probe), false);
  });

  it('matchesExpected is path-separator and case insensitive', () => {
    const probe = { expected: { filePath: 'scripts/lib/a.mjs', symbolName: 'Foo' } };
    assert.equal(matchesExpected(rec('scripts\\lib\\a.mjs', 'foo', 0.8), probe), true);
  });
});

describe('calibrate / threshold derivation', () => {
  const rec = (fp, sym, sim) => ({ filePath: fp, symbolName: sym, similarityScore: sim });
  const pos = (id, sim) => ({
    probe: { id, relation: 'reuse', intent: 'x', stratum: 's', expected: { filePath: 'a.mjs', symbolName: 'target' } },
    records: [rec('a.mjs', 'target', sim)],
  });
  const neg = (id, sim) => ({
    probe: { id, relation: 'none', intent: 'x', stratum: 'u' },
    records: [rec('z.mjs', 'noise', sim)],
  });
  const passingMetrics = { verdict: 'pass', distribution: { hardNegativeCeiling: 0.60 } };

  it('refuses to derive thresholds when gates did not pass', () => {
    const d = deriveThresholds([], { verdict: 'fail' });
    assert.equal(d.ok, false);
  });

  // ── audit HIGH: hard-negative FPs must enter the precision denominator ──
  it('counts a hard-negative false positive as a false positive in precision', () => {
    // Every positive banded correctly, but the threshold also fires on three
    // hard negatives. Precision must NOT read 1.0 — the earlier form skipped
    // negatives before the tp/fp tally, so a threshold that fired on all
    // garbage still scored perfectly.
    const results = [
      pos('p1', 0.95), pos('p2', 0.95),
      neg('n1', 0.95), neg('n2', 0.95), neg('n3', 0.95),
    ];
    const d = deriveThresholds(results, passingMetrics);
    const row = d.rows.find(r => Math.abs(r.t - 0.90) < 1e-9);
    assert.equal(row.hardFp, 3);
    assert.equal(row.fp, 3, 'hard-negative FPs must be in fp');
    assert.ok(row.precision < 1.0, `precision must reflect the garbage it banded, got ${row.precision}`);
    assert.ok(Math.abs(row.precision - 2 / 5) < 1e-9);
  });

  // ── audit HIGH: extend must be searched strictly below T_reuse ──
  it('never selects T_extend equal to T_reuse', () => {
    // Precision steps straight past 0.90, so an independent ascending scan for
    // >=0.75 returns the same row as the >=0.90 scan. That collision made the
    // C7 ordering invariant unsatisfiable and derivation could never succeed.
    const results = [pos('p1', 0.95), pos('p2', 0.95), neg('n1', 0.55)];
    const d = deriveThresholds(results, passingMetrics);
    if (d.ok && d.thresholds.T_reuse !== null && d.thresholds.T_extend !== null) {
      assert.ok(
        d.thresholds.T_reuse > d.thresholds.T_extend,
        `T_reuse (${d.thresholds.T_reuse}) must exceed T_extend (${d.thresholds.T_extend})`,
      );
    }
  });

  it('keeps the C7 ordering backstop even when the search range is constrained', () => {
    const results = [pos('p1', 0.95), neg('n1', 0.55)];
    const d = deriveThresholds(results, passingMetrics);
    if (d.ok) {
      const { T_reuse, T_extend, T_jd } = d.thresholds;
      if (T_reuse !== null && T_extend !== null && T_jd !== null) {
        assert.ok(T_reuse > T_extend && T_extend > T_jd);
      }
    }
  });

  it('probeSetHash is stable and array-order-sensitive', () => {
    const a = [{ id: 1 }, { id: 2 }];
    assert.equal(probeSetHash(a), probeSetHash([{ id: 1 }, { id: 2 }]));
    assert.notEqual(probeSetHash(a), probeSetHash([{ id: 2 }, { id: 1 }]));
  });

  it('probeSetHash ignores object KEY order — reformatting must not invalidate a calibration', () => {
    // JSON.stringify preserves insertion order, so the pre-canonicalisation
    // form changed hash when a probe object was merely rebuilt with its keys
    // in a different order, spuriously invalidating a still-valid calibration.
    const a = [{ id: 'p1', intent: 'x', relation: 'reuse' }];
    const b = [{ relation: 'reuse', id: 'p1', intent: 'x' }];
    assert.equal(probeSetHash(a), probeSetHash(b));
  });

  it('probeSetHash canonicalises nested objects too', () => {
    const a = [{ id: 'p', expected: { filePath: 'a.mjs', symbolName: 'f' } }];
    const b = [{ id: 'p', expected: { symbolName: 'f', filePath: 'a.mjs' } }];
    assert.equal(probeSetHash(a), probeSetHash(b));
  });

  it('probeSetHash still changes when a VALUE changes', () => {
    assert.notEqual(
      probeSetHash([{ id: 'p', relation: 'reuse' }]),
      probeSetHash([{ id: 'p', relation: 'extend' }]),
    );
  });
});
