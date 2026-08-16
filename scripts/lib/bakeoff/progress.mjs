/**
 * @fileoverview `printProgress` and its rendering (D2).
 *
 * Moved from `scripts/bakeoff-collect.mjs` (plan: comparison-tooling-
 * consolidation.md, Phase 2). Per D2a: may import `bakeoff/summary.mjs`,
 * `bakeoff/log.mjs`; must NOT import any `scripts/*.mjs` entry point,
 * `bakeoff/arms.mjs`, or `bakeoff/spawn.mjs`.
 *
 * **Two necessary deviations from verbatim, both required by the D2a
 * import boundary itself (discovered during Phase 2 implementation).**
 *
 * 1. The original `printProgress(logPath, target, campaignId)` called
 *    `resolveArms({campaignId})` internally — `bakeoff/arms.mjs`, an import
 *    this module is forbidden. Resolution now happens in the CALLER (the
 *    entry point, which already imports `arms.mjs` for its own collection
 *    flow) — `printProgress(logPath, target, scopeResult)` takes the
 *    ALREADY-resolved outcome: `{ok:true, scope}` or `{ok:false, message}`.
 *    This is a strict improvement for the post-collection call site, which
 *    used to discard an already-resolved `scope` and re-derive it from a
 *    bare campaign id string for no reason.
 * 2. The zero-finding-arms readout called `isCompleteForEntry(e)` — same
 *    forbidden import, one layer down. `entries` here is always pre-filtered
 *    to one campaign (`e.campaignId === scope.campaignId`), so
 *    `isCompleteForEntry(e)` and `isComplete(e, scope)` resolve identically;
 *    swapped in directly, no behaviour change.
 *
 * @module scripts/lib/bakeoff/progress
 */
import { readLog } from './log.mjs';
import { summarise, entriesToSpendSnapshots, isComplete, zeroFindingArms } from './summary.mjs';
import { incompleteSpend } from '../comparison/spend.mjs';

/**
 * @param {string} logPath
 * @param {number} target
 * @param {{ok: true, scope: import('./scope.mjs').ResolvedScope} | {ok: false, message: string}} scopeResult
 *   Already-resolved by the caller (see the module-level note on why).
 */
export function printProgress(logPath, target, scopeResult) {
  const all = readLog(logPath);
  if (!scopeResult.ok) {
    process.stdout.write(`\nBake-off progress — cannot resolve a campaign scope: ${scopeResult.message}\n`);
    process.stdout.write(`  ${all.length} total logged entrie(s) across all campaigns — pass --campaign <id> to select one.\n\n`);
    return;
  }
  const scope = scopeResult.scope;
  const entries = all.filter((e) => e.campaignId === scope.campaignId);
  const s = summarise(entries, target, scope);
  process.stdout.write(`\nBake-off progress — ${s.complete}/${s.target} complete snapshot(s)\n`);
  if (s.incomplete > 0) process.stdout.write(`  ${s.incomplete} incomplete (an arm skipped or errored) — not counted\n`);
  // `AggregateResult`-aware (D6): an arm that never ran in any complete
  // snapshot renders `—`, never a fabricated `0`.
  const fmtAgg = (r) => (r.status === 'measured' ? String(r.value) : '—');
  const uniqueLine = Object.entries(s.totals.uniqueByArm).map(([id, r]) => `${id}=${fmtAgg(r)}`).join(' ');
  const soloLine = Object.entries(s.totals.soloFindingsByArm).map(([id, r]) => `${id} findings=${fmtAgg(r)}`).join(' ');
  if (uniqueLine) process.stdout.write(`  raw uniques so far: ${uniqueLine}\n`);
  if (soloLine) process.stdout.write(`  ${soloLine} (not a "unique" — no shadow to diff against)\n`);
  // Two self-divergence readouts, and they answer the SAME question about
  // different models: how much of an arm's apparent edge is just variance?
  // Reporting only Gemini's — as this did while the solo arm was already being
  // paid for — leaves the Opus number collected but unread.
  const spread = (xs) => `mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}, max ${Math.max(...xs)}`;
  const div = s.totals.primaryDivergence;
  if (div.status === 'measured') {
    process.stdout.write(`  Gemini self-divergence (P1 vs P2): mean ${div.value.toFixed(1)}, max ${div.max} findings`
      + ' — same model, same transcript, two runs. High => buy a retry, not a model.\n');
  } else if (div.unpairedCount > 0) {
    // Zero observations, never fabricated as "mean 0.0" (D6) — an explicit
    // `—` plus WHY (unpaired count), the same honesty `opusDivergence` already
    // gives below.
    process.stdout.write(`  Gemini self-divergence (P1 vs P2): — (${div.unpairedCount} snapshot(s) had fewer than 2`
      + ' non-solo arms report a primary finding count — nothing measured, not a claim of agreement)\n');
  }
  const odiv = s.totals.opusDivergence;
  if (odiv.length > 0) {
    process.stdout.write(`  Opus self-divergence (shadow vs solo): ${spread(odiv)} findings over ${odiv.length} snapshot(s)`
      + ' — a byte-identical request run twice. Compare against opus unique before crediting the role.\n');
  }
  if (s.totals.opusDivergenceUnpaired > 0) {
    process.stdout.write(`    (${s.totals.opusDivergenceUnpaired} snapshot(s) unpaired — one Opus sample missing;`
      + ' excluded rather than scored as zero divergence)\n');
  }

  // Spend. The campaign's binding constraint, and until now the only thing it
  // measured nowhere — "why is this arm expensive?" needed a throwaway script.
  const costed = Object.entries(s.totals.costByArm);
  if (costed.length > 0) {
    const known = costed.filter(([, v]) => typeof v === 'number');
    const total = known.reduce((a, [, v]) => a + v, 0);
    const parts = costed.map(([id, v]) => `${id}=${v == null ? 'unpriced' : `$${v.toFixed(2)}`}`);
    process.stdout.write(`  spend: ${parts.join(' ')} | total $${total.toFixed(2)}`
      + (s.complete ? ` ($${(total / s.complete).toFixed(2)}/snapshot)` : '') + '\n');
    // Cost per unique finding is a FLOOR on cost-effectiveness, not the verdict:
    // §6.3 scores ACCEPTED HIGH/MED clusters, which only exist after blind
    // adjudication. Printing it unlabelled would let a cheap-and-noisy arm read
    // as a win. Uniques come from the shadow buckets, so the solo arm has none.
    for (const [id, r] of Object.entries(s.totals.uniqueByArm)) {
      const v = s.totals.costByArm[id];
      if (typeof v === 'number' && r.status === 'measured' && r.value > 0) {
        process.stdout.write(`    ${id}: $${(v / r.value).toFixed(2)} per raw unique — a FLOOR, not the verdict`
          + ' (the rule scores accepted HIGH/MED after adjudication)\n');
      }
    }
    if (s.totals.costUncostedSnapshots > 0) {
      process.stdout.write(`    (${s.totals.costUncostedSnapshots} snapshot(s) had an unpriced call —`
        + ' those arms show `unpriced` rather than a partial sum that reads complete)\n');
    }
  }

  // Incomplete-snapshot spend (D5) — a DIFFERENT question from the "spend:"
  // line above, and deliberately not summed together: that line reads
  // complete snapshots only (effectiveness), this one reads every snapshot
  // that did NOT count toward N. On 2026-08-14 that second number was $4.16
  // and nowhere in this output — 59% of a $7.10 spend, invisible because
  // nothing asked the question. A `$0.00` here must never be silently
  // conflated with "nothing incomplete"; the count is what disambiguates it.
  const inc = incompleteSpend(entriesToSpendSnapshots(entries, scope), { cohortDigest: scope.campaignId });
  if (inc.incompleteSnapshotCount === 0) {
    process.stdout.write('  incomplete-snapshot spend: none — no incomplete snapshots\n');
  } else if (inc.incompleteSpendUsd == null) {
    const why = inc.unrecordedSnapshotCount > 0
      ? `${inc.unrecordedSnapshotCount} of ${inc.incompleteSnapshotCount} recorded no arm run at all`
      : 'every arm unpriced';
    process.stdout.write(`  incomplete-snapshot spend: unknown (${inc.incompleteSnapshotCount} incomplete snapshot(s), ${why})\n`);
  } else {
    const parts = [];
    if (inc.excludedArmIds.length) parts.push(`excludes unpriced: ${inc.excludedArmIds.join(', ')}`);
    if (inc.unrecordedSnapshotCount > 0) parts.push(`${inc.unrecordedSnapshotCount} snapshot(s) recorded no arm run`);
    const excl = parts.length ? ` (${parts.join('; ')})` : '';
    process.stdout.write(`  incomplete-snapshot spend: $${inc.incompleteSpendUsd.toFixed(2)} (bought no ${inc.incompleteSnapshotCount})${excl}\n`);
  }

  // The MATCHED view, beside the strict one. The strict `opus unique` above is
  // the pre-registered metric and counts VOLUME (cross-model exact-hash never
  // matches); this is the one that can distinguish "Opus added something" from
  // "Opus said N things".
  if (s.totals.matchedRows > 0) {
    const t = s.totals.matchedTotals;
    const cov = s.totals.matchedCoverage;
    process.stdout.write(`  matched view [cohort ${s.totals.matchedCohort}, ${s.totals.matchedRows} arm-run(s)]:`
      + ` both=${t.both} shadowOnly=${t.shadowOnly} unmatchable=${t.unmatchable}`
      + ` | coverage ${cov === null ? 'n/a' : (cov * 100).toFixed(0) + '%'}\n`);
    if (t.unknownVerdicts > 0) {
      process.stdout.write(`    ${t.unknownVerdicts} run(s) below the coverage floor — read as UNKNOWN, not as a number\n`);
    }
    if (t.notApplicable > 0) {
      process.stdout.write(`    ${t.notApplicable} run(s) had no findings on either side — not-applicable, excluded from the coverage mean\n`);
    }
    for (const x of s.totals.matchedExcluded) {
      process.stdout.write(`    EXCLUDED cohort ${x.cohort} (${x.rows} run(s)) — different match config; re-run or read separately, never averaged in\n`);
    }
  }
  if (s.totals.matchedNotComputed > 0) {
    process.stdout.write(`    ${s.totals.matchedNotComputed} arm-run(s) have no matched view (disabled, or collected before the field existed)\n`);
  }

  // Two arms that sent the same request are not two configurations.
  const rerolls = [...new Set(s.totals.rerollPairs)];
  if (rerolls.length > 0) {
    process.stdout.write(`  IDENTICAL REQUESTS: ${rerolls.join(', ')} — same prompt, same model, same effort.\n`
      + '    Any gap between these arms is sampling noise plus a reporting convention, NOT a role difference.\n');
  }
  // A zero is only informative once you know the arm actually reviewed. Print the
  // verdict beside it so "lenient reviewer" and "broken arm" are never conflated
  // in the one number the stopping rule reads.
  const LABEL = { unrecorded: 'verdict not recorded (pre-dates the field)', 'no-verdict': 'NO VERDICT — suspect a BROKEN arm' };
  const zeros = entries.filter((e) => isComplete(e, scope)).flatMap((e) => zeroFindingArms(e, scope)
    .map((z) => `${z.arm}: ${LABEL[z.evidence] ?? `reviewed, verdict ${z.verdict}`}`));
  if (zeros.length > 0) {
    const tally = {};
    for (const z of zeros) tally[z] = (tally[z] || 0) + 1;
    process.stdout.write('  zero-finding arms — a zero means nothing until you know the arm reviewed:\n');
    for (const [k, n] of Object.entries(tally)) process.stdout.write(`    ${k} x${n}\n`);
  }
  process.stdout.write(s.met
    ? '  TARGET MET — adjudicate, then write the verdict to docs/research/ and STOP.\n'
    : `  ${s.remaining} more to go. Raw uniques are NOT the verdict — the rule scores ACCEPTED HIGH/MED clusters.\n`);
  process.stdout.write(`  log: ${logPath}\n\n`);
}
