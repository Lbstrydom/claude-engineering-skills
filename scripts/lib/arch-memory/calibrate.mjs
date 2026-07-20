#!/usr/bin/env node
/**
 * @fileoverview Arch-memory band calibration harness.
 *
 * MEASUREMENT BEFORE TUNING. The bands (`reuse` ≥0.90, `extend` ≥0.85) never
 * fired once in 1,763 consultations because the query and index embed different
 * GENRES of text, capping real similarity around 0.60–0.83. The fix is to close
 * that gap, not to lower the cutoffs — the noise floor is high (an unrelated
 * sentence scores 0.43; a metadata-only vector scores 0.54), so a cutoff chosen
 * from the raw distribution would sit barely above garbage and manufacture
 * false `reuse` calls.
 *
 * This harness measures against a HAND-LABELLED probe set including hard
 * negatives, so thresholds are chosen on precision rather than percentiles.
 *
 * Plan: docs/plans/arch-memory-band-recalibration.md §7c.
 *
 * Exit codes (§7c CLI contract):
 *   0 — all gates pass
 *   1 — harness error
 *   2 — gates failed (Phase 4 blocked; do NOT move thresholds)
 *   3 — insufficient probes resolved (cannot report a verdict)
 *
 * @module scripts/lib/arch-memory/calibrate
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** k MUST match production. The UserPromptSubmit hook hardcodes k:5, and that
 *  is the consultation that actually fires on most prompts — calibrating at
 *  k=8 would tune against a candidate set production never sees. */
export const CALIBRATION_K = 5;

/** §7c gate thresholds. Separation is the load-bearing one: it is what makes a
 *  `reuse` cutoff meaningfully above noise rather than nominally above it. */
export const GATES = Object.freeze({
  medianPositive: 0.80,
  separation: 0.15,
  recallAtK: 0.90,
});

export const MIN_PROBES = 30;
export const MIN_HARD_NEGATIVES = 10;

/** Pure: median of a numeric array. Returns null on empty (never 0 — a
 *  fabricated 0 would read as a real measurement). */
export function median(xs) {
  const a = (xs || []).filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Pure: p-th percentile (0..1), nearest-rank. Null on empty. */
export function percentile(xs, p) {
  const a = (xs || []).filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (a.length === 0) return null;
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
  return a[idx];
}

/**
 * Stable hash of the probe set — feeds `calibrationProvenance` (C4).
 *
 * Hashes a CANONICAL form: object keys sorted recursively, so a hash change
 * always means the probe SEMANTICS changed. `JSON.stringify` alone preserves
 * insertion order, so merely reformatting the fixture — or rebuilding a probe
 * object with its keys in a different order — produced a different hash and
 * spuriously invalidated a still-valid calibration. Array order is preserved
 * deliberately: probe ORDER is not semantically meaningful, but reordering is
 * rare and treating it as a change is the safe direction.
 */
function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(k => [k, canonicalise(value[k])]),
    );
  }
  return value;
}

export function probeSetHash(probes) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalise(probes)))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Validate the probe fixture. Composition rules are load-bearing: without hard
 * negatives, a threshold chosen only on positives will happily fire on garbage.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateProbeSet(probes) {
  const errors = [];
  if (!Array.isArray(probes)) return { ok: false, errors: ['probe set is not an array'] };
  if (probes.length < MIN_PROBES) errors.push(`need ≥${MIN_PROBES} probes, got ${probes.length}`);

  const negatives = probes.filter(p => p.relation === 'none');
  if (negatives.length < MIN_HARD_NEGATIVES) {
    errors.push(`need ≥${MIN_HARD_NEGATIVES} hard negatives (relation:"none"), got ${negatives.length}`);
  }
  const strata = new Set(probes.map(p => p.stratum).filter(Boolean));
  if (strata.size < 4) errors.push(`need ≥4 strata so cutoffs aren't overfit to one domain, got ${strata.size}`);

  for (const [i, p] of probes.entries()) {
    if (!p.id) errors.push(`probe[${i}] missing id`);
    if (!p.intent) errors.push(`probe[${p.id || i}] missing intent`);
    if (!['reuse', 'extend', 'none'].includes(p.relation)) {
      errors.push(`probe[${p.id || i}] relation must be reuse|extend|none`);
    }
    // Identity is (filePath, symbolName) — NOT the symbol_index UUID, which is
    // re-minted by every arch:refresh and would rot the fixture immediately.
    if (p.relation !== 'none') {
      if (!p.expected?.filePath || !p.expected?.symbolName) {
        errors.push(`probe[${p.id || i}] positive probe needs expected.{filePath,symbolName}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Does a returned record match the probe's expected symbol (or an alternate)? */
export function matchesExpected(record, probe) {
  const norm = s => String(s || '').replace(/\\/g, '/').toLowerCase();
  const targets = [probe.expected, ...(probe.alternates || [])].filter(Boolean);
  return targets.some(t =>
    norm(record.filePath) === norm(t.filePath) &&
    String(record.symbolName || '').toLowerCase() === String(t.symbolName || '').toLowerCase()
  );
}

/**
 * Compute metrics over resolved probe results.
 *
 * SUCCESS-PATH ADVERSARIALISM (AGENTS.md): with zero resolved probes this
 * returns `verdict: 'unverified'` and never a clean precision. A harness that
 * can report 100% precision having checked nothing is exactly the false-green
 * this repo's doctrine names.
 *
 * @param {Array<{probe: object, records: Array, error?: string}>} results
 */
export function computeMetrics(results) {
  const resolved = (results || []).filter(r => r && !r.error && Array.isArray(r.records));
  if (resolved.length === 0) {
    return {
      verdict: 'unverified',
      reason: 'no probes resolved — cannot report precision or recall',
      resolvedCount: 0,
    };
  }

  const positives = resolved.filter(r => r.probe.relation !== 'none');
  const negatives = resolved.filter(r => r.probe.relation === 'none');

  // Similarity of the EXPECTED symbol, per positive probe (null when absent
  // from the top-k at all — that is a retrieval failure, not a banding one).
  const positiveSims = [];
  let retrieved = 0;
  for (const r of positives) {
    const hit = r.records.find(rec => matchesExpected(rec, r.probe));
    if (hit) {
      retrieved++;
      if (Number.isFinite(hit.similarityScore)) positiveSims.push(hit.similarityScore);
    }
  }

  // Best-hit similarity per hard negative — the noise ceiling.
  const negativeBest = negatives
    .map(r => Math.max(...r.records.map(x => (Number.isFinite(x.similarityScore) ? x.similarityScore : -1)), -1))
    .filter(x => x >= 0);

  const medPos = median(positiveSims);
  const medNeg = median(negativeBest);
  const recall = positives.length > 0 ? retrieved / positives.length : null;
  const separation = medPos !== null && medNeg !== null ? medPos - medNeg : null;

  const gates = {
    medianPositive: { value: medPos, threshold: GATES.medianPositive, pass: medPos !== null && medPos >= GATES.medianPositive },
    separation: { value: separation, threshold: GATES.separation, pass: separation !== null && separation >= GATES.separation },
    recallAtK: { value: recall, threshold: GATES.recallAtK, pass: recall !== null && recall >= GATES.recallAtK },
  };
  const allPass = Object.values(gates).every(g => g.pass);

  return {
    verdict: allPass ? 'pass' : 'fail',
    resolvedCount: resolved.length,
    positiveCount: positives.length,
    negativeCount: negatives.length,
    k: CALIBRATION_K,
    gates,
    distribution: {
      positiveSims: positiveSims.slice().sort((a, b) => a - b),
      negativeBest: negativeBest.slice().sort((a, b) => a - b),
      hardNegativeCeiling: percentile(negativeBest, 0.95),
    },
  };
}

/**
 * Derive band cutoffs from the measured probe results (§7c selection rule).
 * Returns `null` cutoffs rather than an unachievable band — shipping a band
 * that cannot be reached honestly beats shipping one that is wrong.
 */
export function deriveThresholds(results, metrics) {
  if (!metrics || metrics.verdict !== 'pass') return { ok: false, reason: 'gates did not pass' };

  const resolved = results.filter(r => r && !r.error);
  const candidates = [];
  for (let t = 0.50; t <= 0.99; t += 0.01) candidates.push(Number(t.toFixed(2)));

  const evaluate = (t) => {
    let tp = 0, fp = 0, hardFp = 0;
    for (const r of resolved) {
      const banded = r.records.filter(rec => Number.isFinite(rec.similarityScore) && rec.similarityScore >= t);
      if (r.probe.relation === 'none') {
        // A hard negative that emits ANY band at this threshold is a false
        // positive, and it MUST enter the precision denominator. Counting it
        // only in `hardFp` and `continue`-ing (the original form) let a
        // threshold that fires on every hard negative still report
        // precision 1.0, so long as the positives it banded were right —
        // precisely the "confidently wrong" outcome the whole plan exists to
        // avoid. The separate `hardFp` counter is retained because the
        // selection rule bounds it directly.
        if (banded.length > 0) { hardFp++; fp++; }
        continue;
      }
      if (banded.length === 0) continue;
      if (banded.some(rec => matchesExpected(rec, r.probe))) tp++;
      else fp++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    return { t, tp, fp, hardFp, precision };
  };

  const rows = candidates.map(evaluate);
  const jd = metrics.distribution.hardNegativeCeiling;

  // `reuse` is the lowest threshold meeting the strict bar.
  const reuse = rows.find(r => r.precision !== null && r.precision >= 0.90 && r.hardFp <= 1) || null;

  // `extend` MUST be selected from thresholds strictly BELOW T_reuse. Scanning
  // the same ascending list independently with a weaker bar (≥0.75) commonly
  // returns the SAME row as `reuse` — whenever precision steps straight past
  // 0.90, the first row satisfying ≥0.75 is that same row. That yields
  // T_reuse === T_extend, which the C7 ordering invariant then rejects, so
  // derivation could never succeed: a latent "no thresholds, ever" bug rather
  // than a wrong-thresholds one. Constraining the search range is the fix;
  // the ordering check below stays as the backstop, not the mechanism.
  const extend = reuse
    ? (rows.filter(r => r.t < reuse.t).reverse()
        .find(r => r.precision !== null && r.precision >= 0.75 && r.hardFp <= 1) || null)
    : (rows.find(r => r.precision !== null && r.precision >= 0.75 && r.hardFp <= 1) || null);

  // Ordering invariant (C7): T_reuse > T_extend > T_jd, else no thresholds.
  if (reuse && extend && jd !== null && !(reuse.t > extend.t && extend.t > jd)) {
    return { ok: false, reason: 'ordering invariant T_reuse > T_extend > T_jd unsatisfiable', rows };
  }

  return {
    ok: true,
    thresholds: {
      T_reuse: reuse ? reuse.t : null,
      T_extend: extend ? extend.t : null,
      T_jd: jd,
      T_review_near: jd !== null ? Number((jd - 0.05).toFixed(2)) : null,
    },
    evidence: { reuse, extend, hardNegativeCeiling: jd },
    rows,
  };
}

/** Provenance the calibration is bound to (C4/C6). Deliberately excludes
 *  refreshId — that is minted fresh by every arch:refresh, so binding validity
 *  to it would invalidate the calibration on the next routine cron run. */
export async function buildProvenance(probes) {
  const { symbolIndexConfig } = await import('../config.mjs');
  const { NORMALIZE_PROMPT_VERSION } = await import('./normalize-intent.mjs');
  // COMPOSE_VERSION is introduced by Phase 4 (Cluster C). Until it exists the
  // provenance records it as null rather than reaching across a cluster
  // boundary to define it early — an absent field is honest, and the
  // stale-calibration guard treats null ≠ a real hash, so a calibration taken
  // before Phase 4 correctly fails to validate afterwards.
  let composeVersion = null;
  try {
    ({ COMPOSE_VERSION: composeVersion = null } = await import('../symbol-index.mjs'));
  } catch { /* module always exists; the export may not yet */ }

  return {
    embedModel: symbolIndexConfig.embedModel,
    embedDim: symbolIndexConfig.embedDim,
    COMPOSE_VERSION: composeVersion,
    normalizerId: symbolIndexConfig.summariseModel,
    NORMALIZE_PROMPT_VERSION,
    probeSetHash: probeSetHash(probes),
  };
}

export function loadProbes(probesPath) {
  const raw = fs.readFileSync(probesPath, 'utf-8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.probes;
}

/** CLI. Kept thin — everything above is pure and unit-tested. */
async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const asJson = argv.includes('--json');
  const probesPath = arg('--probes', path.resolve('tests/fixtures/arch-memory-probes.json'));
  const outPath = arg('--out', path.resolve('.audit-loop/arch-memory-calibration.json'));

  let probes;
  try {
    probes = loadProbes(probesPath);
  } catch (err) {
    process.stderr.write(`[calibrate] cannot read probe set: ${err.message}\n`);
    process.exit(1);
  }

  const valid = validateProbeSet(probes);
  if (!valid.ok) {
    process.stderr.write(`[calibrate] invalid probe set:\n${valid.errors.map(e => '  - ' + e).join('\n')}\n`);
    process.exit(3);
  }

  // Drive the REAL production entry point (`cross-skill.mjs get-neighbourhood`)
  // rather than re-wiring the store adapters here. Two reasons: a
  // reimplementation can drift from what production actually does — which is
  // precisely the class of bug this whole plan exists to fix — and the
  // consultation the hook fires IS this CLI, so measuring it measures the
  // thing that matters. Cost is one subprocess per probe (~2-3s), which is
  // irrelevant for an on-demand calibration run.
  const { execFileSync } = await import('node:child_process');
  const cliPath = path.resolve(new URL('../../cross-skill.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

  const results = [];
  for (const [i, probe] of probes.entries()) {
    process.stderr.write(`[calibrate] probe ${i + 1}/${probes.length}: ${probe.id}\n`);
    try {
      const stdout = execFileSync(
        process.execPath,
        [cliPath, 'get-neighbourhood', '--json', JSON.stringify({
          targetPaths: [],
          intentDescription: probe.intent,
          k: CALIBRATION_K,
        })],
        { encoding: 'utf-8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      );
      // The CLI prefixes progress lines on stderr but may also emit config
      // banners on stdout; take the last JSON object line.
      const jsonLine = stdout.split('\n').filter(l => l.trim().startsWith('{')).pop();
      if (!jsonLine) throw new Error('no JSON in CLI output');
      const parsed = JSON.parse(jsonLine);
      if (parsed.ok === false) throw new Error(parsed.error?.message || 'CLI returned ok:false');
      results.push({ probe, records: parsed.records || [] });
    } catch (err) {
      results.push({ probe, records: [], error: err.message });
    }
  }

  const metrics = computeMetrics(results);
  const derived = deriveThresholds(results, metrics);
  const provenance = await buildProvenance(probes);

  // Per-probe detail. A gate verdict that says "recall 0.57" without showing
  // WHICH probes missed and what came back instead cannot be acted on — the
  // first real failure had to be diagnosed by re-running probes by hand.
  // Retrieval failures are the ones that need eyes, so they carry the full
  // candidate list; hits only need their rank and score.
  const perProbe = results.map(r => {
    const base = {
      id: r.probe.id,
      relation: r.probe.relation,
      stratum: r.probe.stratum,
      intent: r.probe.intent,
      error: r.error || null,
    };
    if (r.error) return { ...base, outcome: 'error' };
    if (r.probe.relation === 'none') {
      const best = r.records[0];
      return {
        ...base,
        outcome: 'hard-negative',
        bestSimilarity: best ? best.similarityScore : null,
        bestSymbol: best ? `${best.filePath}:${best.symbolName}` : null,
      };
    }
    const idx = r.records.findIndex(rec => matchesExpected(rec, r.probe));
    if (idx >= 0) {
      return {
        ...base,
        outcome: 'retrieved',
        rank: idx + 1,
        similarity: r.records[idx].similarityScore,
      };
    }
    return {
      ...base,
      outcome: 'missed',
      expected: `${r.probe.expected?.filePath}:${r.probe.expected?.symbolName}`,
      // Everything that beat the expected symbol — the material needed to judge
      // whether this is a real retrieval weakness or an under-specified probe.
      returned: r.records.map(rec => ({
        symbol: `${rec.filePath}:${rec.symbolName}`,
        similarity: rec.similarityScore,
      })),
    };
  });

  const missed = perProbe.filter(p => p.outcome === 'missed');
  const report = {
    metrics,
    derived,
    provenance,
    probeCount: probes.length,
    perProbe,
    missedCount: missed.length,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(`[calibrate] verdict=${metrics.verdict} resolved=${metrics.resolvedCount}\n`);
    if (metrics.gates) {
      for (const [name, g] of Object.entries(metrics.gates)) {
        const v = g.value === null ? 'n/a' : g.value.toFixed(4);
        process.stdout.write(`  ${g.pass ? 'PASS' : 'FAIL'} ${name}: ${v} (need ≥${g.threshold})\n`);
      }
    }
    if (missed.length > 0) {
      process.stdout.write(`\n[calibrate] ${missed.length} positive probe(s) missed — expected symbol absent from top-${CALIBRATION_K}:\n`);
      for (const m of missed) {
        process.stdout.write(`  ${m.id}\n    wanted: ${m.expected}\n    got:    ${m.returned.map(x => `${x.symbol} (${x.similarity.toFixed(3)})`).join('\n            ')}\n`);
      }
    }
    process.stdout.write(`[calibrate] report → ${outPath}\n`);
  }

  if (metrics.verdict === 'unverified') process.exit(3);
  process.exit(metrics.verdict === 'pass' ? 0 : 2);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\//, ''));
if (isDirect || process.argv[1]?.endsWith('calibrate.mjs')) {
  main().catch(err => { process.stderr.write(`[calibrate] ${err.stack || err.message}\n`); process.exit(1); });
}
