/**
 * @fileoverview `scoreAgainstGroundTruth` + `toRawContext` — the adjudicator
 * role's ground-truth scoring mechanism (D7a/D7c, plan:
 * comparison-tooling-consolidation.md, Cluster D).
 *
 * Moved verbatim from `scripts/model-eval-adjudicator.mjs` (D7a's layering
 * fix, round-3 gate H2) — a lib module (`executors.mjs`) must not import a
 * top-level `scripts/*.mjs` entry point, so the function moves here instead;
 * `model-eval-adjudicator.mjs` imports it back for its existing 1-vs-1 CLI
 * path (unchanged behaviour) and `EXECUTORS.adjudicator` (D7c) imports the
 * SAME function — neither entry point imports the other.
 *
 * **Extended to bubble up `usage` (D7c, Gemini gate G2) — a bounded extension
 * of the same edit, not new unplanned scope.** `extractStructured` already
 * returns raw provider `usage` per call; this function now sums it across
 * every internal call and returns it alongside the existing metrics, because
 * an `ExecutorAttempt`'s `'ok'` branch requires `usage` unconditionally and
 * none of these per-row calls' cost previously escaped the function.
 *
 * **Null-propagation rule (Cluster B round-2 finding H7/H8's deferred
 * concern, resolved here): `costUsd` is the sum of every row's cost ONLY
 * when every row priced — if any row is unpriced/unmeterable, the summed
 * `costUsd` is `null`, never a partial sum silently treated as the whole.**
 * A hardcoded/derived 0 or partial total reads as "measured and free/cheap"
 * when it is really "some of this is unknown" — the same false-zero class
 * `model-pricing.mjs`'s own null-cost policy exists to prevent, applied here
 * to a SUM rather than a single call. `inputTokens`/`outputTokens` are always
 * summed (never null — `sanitizeTokens` clamps absent/garbage to 0, and a
 * token count observed as 0 is a real, meaningful measurement even when the
 * dollar cost is not).
 *
 * @module scripts/lib/model-eval/adjudicator-executor
 */

import { extractStructured } from './structured-extractor.mjs';
import { scoreBinaryClassification } from './deterministic-scorer.mjs';
import { costFromUsage } from '../model-pricing.mjs';

/** Ground-truth row -> a rawContext {findingText, severity} extractStructured accepts. */
export function toRawContext(row) {
  const findingText = [row.category, row.primaryFile, row.detailSnapshot].filter(Boolean).join(' — ') || '(no detail captured)';
  return { findingText, severity: row.severity || 'UNKNOWN' };
}

/**
 * @param {{route: object, rows: Array<object>}} args
 * @returns {Promise<{recall: number, falsePositiveRate: number, f1: number,
 *   usage: {inputTokens: number, outputTokens: number, costUsd: number|null}}>}
 */
export async function scoreAgainstGroundTruth({ route, rows }) {
  const candidatePredictions = [];
  const groundTruthLabels = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let allPriced = true;
  for (const row of rows) {
    const { data, usage: rawUsage } = await extractStructured({ role: 'adjudicator', route, rawContext: toRawContext(row) });
    candidatePredictions.push(data.verdict);
    groundTruthLabels.push(row.humanLabel);
    const cost = costFromUsage(rawUsage, route.pricingModel);
    inputTokens += cost.inputTokens;
    outputTokens += cost.outputTokens;
    if (cost.totalUsd == null) {
      allPriced = false;
    } else {
      costUsd += cost.totalUsd;
    }
  }
  const scored = scoreBinaryClassification(candidatePredictions, groundTruthLabels);
  return {
    recall: scored.recall, falsePositiveRate: scored.falsePositiveRate, f1: scored.f1,
    usage: { inputTokens, outputTokens, costUsd: allPriced ? costUsd : null },
  };
}
