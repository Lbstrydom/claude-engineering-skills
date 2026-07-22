#!/usr/bin/env node
/**
 * @fileoverview Phase 1 of the audit-effectiveness experiment — read-only
 * decomposition of the adjudicated `audit_findings` ledger: "where does accepted
 * value come from?" A FREE kill-criterion diagnostic that runs before any new LLM
 * spend and can shrink/skip the paid phases.
 *
 * Plan: docs/plans/audit-effectiveness-experiment.md (Phase 1, §12.2/§12.3/§12.6).
 *
 * SURVIVORSHIP CAVEAT (load-bearing, printed in the output): we only have labels
 * for findings the apparatus SURFACED. This decomposition is triage/ablation fuel
 * — it tells us where accepted value concentrates and whether a component looks
 * dead — NOT the causal answer to "could a solo model do as well" (that's Phase 3).
 *
 * `stage` semantics (R1-M1 correction): `stage` records the stage that RAISED a
 * finding, NOT a gate's accept/dismiss disposition of prior findings. So the gate
 * metric here is the GATE's MARGINAL VALUE = acceptance rate of the findings the
 * Gemini gate itself raised (`stage='gemini'`). We CANNOT measure "the gate deleted
 * a valid GPT finding" from this ledger — suppressions aren't recorded as rows
 * (a stated blind spot).
 *
 * @module scripts/ledger-decompose
 */

import 'dotenv/config';
import path from 'node:path';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { log, argOption, hasFlag } from './lib/cli-io.mjs';
// Severity weights — mirror model_ab SEV_WEIGHTS so accepted-VALUE here is directly
// comparable to the Phase 4 decision metric (plan §12.2). Imported from
// solo-control/scoring.mjs (the canonical re-export of DECISION_CONSTANTS'
// values) rather than re-declared — this file's local copy was byte-identical
// (flagged by `arch:duplicates`).
import { SEV_WEIGHTS, sevWeight } from './lib/solo-control/scoring.mjs';

/** Bucket a raw `round_raised` into `1` vs `2+` (the P1-gate lever). A null/absent
 * round is bucketed `unknown` — NOT silently folded into round 1 (which would
 * inflate the round-1 share the gate reads). */
const roundBucket = (r) => (r == null || Number.isNaN(Number(r)) ? 'unknown' : Number(r) <= 1 ? '1' : '2+');

/**
 * Decompose adjudicated findings. Pure over its injected `query` (M4 — tests pass
 * a fake). Returns counts AND severity-weighted value by round/stage (R2-M1), the
 * round-1 value share (the P1 gate reads this), and the gate marginal value.
 *
 * @param {{stageType?: string}} opts
 * @param {{query: (sql:string, params?:any[]) => Promise<{rows:any[]}>}} deps
 */
export async function decompose({ stageType = 'audit-code' } = {}, deps) {
  const { query } = deps;
  // One scan; decompose in-process (small: ~13k rows). `stage_type` lives on
  // audit_runs, so join. Only the columns we need.
  const { rows } = await query(
    `SELECT f.round_raised, f.stage, f.severity, f.adjudication_outcome
       FROM audit_findings f
       JOIN audit_runs r ON r.id = f.run_id
      WHERE r.stage_type = $1`,
    [stageType],
  );

  const total = rows.length;
  const accepted = rows.filter((r) => r.adjudication_outcome === 'accepted');
  const totalAcceptedValue = accepted.reduce((a, r) => a + sevWeight(r.severity), 0);

  const byRound = {}; const acceptedValueByRound = {};
  const byStage = {}; const acceptedValueByStage = {};
  const byRoundBySeverity = {};
  const acceptedHighByRound = {};

  for (const r of accepted) {
    const rb = roundBucket(r.round_raised);
    const st = r.stage == null ? 'baseline(gpt-gen/gemini-untagged)' : r.stage;
    const sv = String(r.severity || '?').toUpperCase();
    byRound[rb] = (byRound[rb] || 0) + 1;
    acceptedValueByRound[rb] = (acceptedValueByRound[rb] || 0) + sevWeight(r.severity);
    byStage[st] = (byStage[st] || 0) + 1;
    acceptedValueByStage[st] = (acceptedValueByStage[st] || 0) + sevWeight(r.severity);
    (byRoundBySeverity[rb] ||= {})[sv] = (byRoundBySeverity[rb]?.[sv] || 0) + 1;
    if (sv === 'HIGH' || sv === 'CRITICAL') acceptedHighByRound[rb] = (acceptedHighByRound[rb] || 0) + 1;
  }

  const acceptedValueRound1Share = totalAcceptedValue > 0
    ? +(((acceptedValueByRound['1'] || 0) / totalAcceptedValue).toFixed(3))
    : null;

  // Gate marginal value: of the findings the gate ITSELF raised (stage='gemini'),
  // what fraction were accepted? (NOT "did the gate delete valid findings".)
  const gateRaised = rows.filter((r) => r.stage === 'gemini');
  const gateAccepted = gateRaised.filter((r) => r.adjudication_outcome === 'accepted').length;
  const gateMarginalValue = gateRaised.length > 0
    ? { raised: gateRaised.length, accepted: gateAccepted, acceptanceRate: +(gateAccepted / gateRaised.length).toFixed(3) }
    : { raised: 0, accepted: 0, acceptanceRate: null };

  return {
    stageType, total, acceptedCount: accepted.length, totalAcceptedValue,
    byRound, acceptedValueByRound, acceptedHighByRound,
    byStage, acceptedValueByStage,
    byRoundBySeverity, acceptedValueRound1Share, gateMarginalValue,
    sevWeights: SEV_WEIGHTS,
  };
}

/** Render the decomposition as an operator-facing markdown writeup (Phase 1 out). */
export function renderMarkdown(d, { generatedForNote = '' } = {}) {
  const pct = (n) => (n == null ? 'n/a' : `${(n * 100).toFixed(1)}%`);
  const roundRows = ['1', '2+', ...(d.byRound.unknown ? ['unknown'] : [])];
  return `# Phase 1 — Ledger decomposition (where does accepted value come from?)

> **Point-in-time SNAPSHOT** — generated from the live ledger by \`npm run audit-exp:ledger\`.
> It is a dated decision-trail artifact (like the arm-eval session archives), NOT an
> auto-maintained living file; counts drift as audits accumulate. Regenerate to refresh.

> **Survivorship caveat (load-bearing).** These labels only exist for findings the
> apparatus SURFACED. This is a *kill-criterion / ablation* diagnostic, **not** the
> causal answer to "could a solo model do as well" — that is Phase 3. Read it to
> decide which apparatus components look dead and to shrink the paid phases.

- stage_type: \`${d.stageType}\` · findings: **${d.total}** · accepted: **${d.acceptedCount}** · accepted-value: **${d.totalAcceptedValue}** (weights ${JSON.stringify(d.sevWeights)})
${generatedForNote ? `- ${generatedForNote}\n` : ''}
## Accepted value by round (the P1 → P3 gate lever)

| round | accepted count | accepted value | accepted HIGH+ |
|---|---|---|---|
${roundRows.map((r) => `| ${r} | ${d.byRound[r] || 0} | ${d.acceptedValueByRound[r] || 0} | ${d.acceptedHighByRound[r] || 0} |`).join('\n')}

- **acceptedValueRound1Share = ${pct(d.acceptedValueRound1Share)}** — P1 gate: **≥ 80%** ⇒ round 2-3 look ablatable → compare the *lean* apparatus in Phase 3.

## Accepted by stage (raising stage)

| stage | accepted count | accepted value |
|---|---|---|
${Object.keys(d.byStage).map((k) => `| \`${k}\` | ${d.byStage[k]} | ${d.acceptedValueByStage[k]} |`).join('\n')}

## Gate marginal value

The Gemini gate's OWN net-new findings (\`stage='gemini'\`): **${d.gateMarginalValue.accepted}/${d.gateMarginalValue.raised}** accepted (**${pct(d.gateMarginalValue.acceptanceRate)}**).
P1 gate: acceptance **< 15%** ⇒ the gate's marginal contribution looks low → candidate to drop from the lean apparatus.
*Blind spot*: this does NOT measure findings the gate SUPPRESSED — suppressions aren't recorded as rows.
`;
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  const stageType = argOption('stage-type', 'audit-code');
  const jsonMode = hasFlag('json');
  const outPath = argOption('out');

  // main() RETURNS an exit code (never calls process.exit after a stdout write —
  // process.exit truncates buffered stdout on a pipe; the runner sets process.exitCode
  // and lets the event loop drain).
  let deps;
  try {
    const { query } = await import('./lib/db/query.mjs');
    deps = { query };
  } catch (err) {
    log(`FATAL: cannot load db layer: ${err.message}`); return 3;
  }

  let d;
  try {
    d = await decompose({ stageType }, deps);
  } catch (err) {
    // DB unreachable / query error → non-zero, explicit cause (never silent-clean).
    log(`FATAL: ledger query failed (DB unreachable?): ${err.message}`); return 3;
  }

  // 0 adjudicated rows → exit 0 but LOUD INSUFFICIENT_DATA (an empty ledger must
  // never read as "no value here"; §12.4).
  if (d.total === 0) {
    log(`INSUFFICIENT_DATA: no audit_findings rows for stage_type='${stageType}'. Run some audits first; nothing to decompose.`);
    if (jsonMode) process.stdout.write(JSON.stringify({ ...d, insufficientData: true }, null, 2) + '\n');
    return 0;
  }
  if (d.acceptedCount < 50) {
    log(`⚠ INSUFFICIENT_DATA for a strong P1 gate: only ${d.acceptedCount} accepted findings (< 50). Treat the round-share as directional; run the full apparatus config.`);
  }

  if (jsonMode) { process.stdout.write(JSON.stringify(d, null, 2) + '\n'); return 0; }
  const md = renderMarkdown(d);
  if (outPath) {
    atomicWriteFileSync(path.resolve(outPath), md);
    log(`Wrote ${path.relative(process.cwd(), path.resolve(outPath))}`);
  } else {
    process.stdout.write(md);
  }
  return 0;
}

// Only run main() when invoked directly (tests import decompose/renderMarkdown).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('ledger-decompose.mjs')) {
  main().then((code) => { process.exitCode = code || 0; }).catch((e) => { log(`FATAL: ${e?.stack || e}`); process.exitCode = 1; });
}
