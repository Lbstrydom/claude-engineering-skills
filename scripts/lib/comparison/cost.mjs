/**
 * @fileoverview Cost comparison — and ONLY cost comparison.
 *
 * **The floor is deliberately not here, and that is the most important thing
 * about this module.** Two earlier drafts extracted a shared `evaluateFloor`
 * over a normalized scalar per arm (`scorePerUnit: Record<armId, number>`).
 * That abstraction is *mathematically incapable* of expressing the auditor
 * role's floor: `model-eval/contracts.mjs` declares
 * `ORACLE_FLOOR_KEYS = ['minRecall', 'maxFalsePositiveRate', 'minF1']`, and
 * recall and F1 are functions of true positives, false positives and false
 * negatives — one scalar per arm cannot encode three counts. A scalar floor
 * would have forced the auditor either to lose its floor semantics or to
 * smuggle them past the contract.
 *
 * So each role keeps its own floor, where its domain is:
 *
 *   | Role | Floor lives in | Shape |
 *   |---|---|---|
 *   | `final_review_shadow` | `campaign/verdict.mjs` | scalar accepted-per-snapshot vs incumbent − margin |
 *   | `auditor` | `model-eval/verdict.mjs` | multi-dimensional classification |
 *
 * Cost *can* be shared, and can only be shared, because it consumes the
 * **boolean outcome** of whichever floor applied rather than the floor's
 * internals. That is also what preserves floor-before-cost ordering: cost never
 * sees enough to reorder the stages.
 *
 * @module scripts/lib/comparison/cost
 */

function round6(n) { return Math.round(n * 1e6) / 1e6; }

/**
 * Cost per accepted unit, over the arms their own floor already cleared.
 *
 * Three rules, each load-bearing and each already paid for elsewhere:
 *
 * - **`clearedFloor: false` is never `selectable`.** Floor before cost. An arm
 *   that failed its floor cannot be rescued by being cheap — that is the
 *   perverse arithmetic the whole two-stage design exists to kill.
 * - **`spendUsd: null` (unpriced) is never `selectable`**, and yields
 *   `costPerAccepted: null`. Unknown cost must not select a winner; a missing
 *   price is not a low price.
 * - **Zero accepted units yields `null`, never `Infinity`** and never a large
 *   number. "Infinitely expensive" is a rendering of a division by zero, not a
 *   measurement, and a computable-looking number invites comparison. Such an
 *   arm should not reach here anyway — an absolute floor excludes it upstream —
 *   but the arithmetic is written honestly rather than relying on that guard.
 *
 * `evidence` describes the money column as a whole: `complete` when every
 * considered arm is priced, `partial` when some are not, `unknown` when none
 * are.
 *
 * **`selectable` is STRICT BY DEFAULT (revised in a Cluster B fix-gate, raised
 * independently in two review rounds).** An earlier version left the whole-
 * comparison refusal to the caller — an unpriced arm alone never won, but a
 * COMPARISON with a gap in its evidence could still resolve a winner from
 * whichever arms happened to be priced, which technically honours "unknown
 * cost must not select a winner" (D2b) while missing its spirit: a decision
 * made from partial evidence is a weaker claim than the shape of the return
 * value suggests. Now `evidence !== 'complete'` yields an EMPTY `selectable`,
 * full stop — pass `allowPartialEvidence: true` to opt into the old per-arm
 * behavior when a caller genuinely wants to decide among just the arms that
 * happen to be priced. (Verified safe to flip the default: the one existing
 * consumer, `campaign/verdict.mjs`'s wrapper, never reads `selectable` at
 * all — it computes its own affordable/winner logic from `perArm` directly,
 * with an even stricter whole-stage refusal of its own.)
 *
 * **The arm universe is the UNION of every argument's keys, not just
 * `clearedFloor`'s.** An arm named only in `spendUsd`/`acceptedUnits` (a
 * caller bug — every scored arm should appear in all three) is still
 * reported, with `clearedFloor: false` (a name absent from `clearedFloor`
 * cannot have cleared it), rather than silently vanishing from the result.
 * Comparison evidence a caller supplied must never disappear without a trace.
 *
 * @param {{
 *   clearedFloor: Record<string, boolean>,
 *   spendUsd: Record<string, number|null>,
 *   acceptedUnits: Record<string, number>,
 *   ceilingUsdPerAccepted?: number|null,
 *   allowPartialEvidence?: boolean,
 * }} args
 * @returns {{perArm: Record<string, {spendUsd: number|null, acceptedUnits: number,
 *   costPerAccepted: number|null, withinCeiling: boolean|null, clearedFloor: boolean}>,
 *   evidence: 'complete'|'partial'|'unknown', selectable: string[]}}
 */
export function evaluateCost({ clearedFloor, spendUsd, acceptedUnits, ceilingUsdPerAccepted = null, allowPartialEvidence = false }) {
  const armIds = [...new Set([
    ...Object.keys(clearedFloor || {}),
    ...Object.keys(spendUsd || {}),
    ...Object.keys(acceptedUnits || {}),
  ])].sort();
  // Cluster B fix-gate (R3): a non-finite or negative declared ceiling
  // (Infinity, NaN, -5) is not a real limit. `costPerAccepted <=
  // ceilingUsdPerAccepted` with `ceilingUsdPerAccepted: Infinity` is true for
  // every finite cost, so `withinCeiling` reports `true` — CLAIMING the arm
  // was checked and confirmed within a real limit, when no limit actually
  // constrained anything. `null` (the existing "no ceiling declared" case)
  // already means exactly what a malformed ceiling should ALSO mean —
  // unconstrained — so normalize here rather than let a bad ceiling value
  // masquerade as a passed check.
  const effectiveCeiling = Number.isFinite(ceilingUsdPerAccepted) && ceilingUsdPerAccepted >= 0
    ? ceilingUsdPerAccepted
    : null;
  // Cluster B fix-gate (R3): `perArm[armId] = {...}` is a direct assignment,
  // which (unlike armSpend's read-then-assign accumulator) safely SHADOWS an
  // inherited data property like `constructor` — verified empirically. But
  // `__proto__` is not an ordinary inherited property; it is a SETTER on
  // Object.prototype, and bracket-notation assignment invokes it exactly like
  // dot notation does: `perArm['__proto__'] = {...}` changes `perArm`'s own
  // prototype rather than creating an entry, silently dropping that arm's
  // data from every subsequent `Object.keys(perArm)`/lookup. `armIds` is
  // theoretically bounded by ARM_ID_PATTERN in every real caller today (its
  // charset excludes underscores, so `__proto__` cannot reach here through
  // any current path) — but this function is exported and standalone, with
  // no way to enforce that a future caller validated first. Same defensive
  // posture as armSpend's own fix, applied here too.
  const perArm = Object.create(null);
  let priced = 0;

  for (const armId of armIds) {
    const cleared = clearedFloor?.[armId] === true;
    const spend = spendUsd?.[armId];
    // A negative spend is not a real cost (no provider bill is negative — a
    // corrupted or malformed value) and must not be treated as "priced": a
    // negative costPerAccepted is ALWAYS <= any positive ceiling, so it would
    // make the corrupted arm read as the CHEAPEST, most attractive option in
    // the comparison rather than an unusable measurement — the wrong
    // direction for a cost-selection function to fail in.
    const isPriced = Number.isFinite(spend) && spend >= 0;
    // A non-finite accepted-unit count (Infinity, NaN — a caller bug or a
    // corrupted upstream count) must not enter arithmetic: `spend / Infinity`
    // silently prices the arm at ~$0/unit, which is a wrong-direction failure
    // for a cost COMPARISON — it would make a corrupted count look like the
    // cheapest, most attractive arm rather than an unusable one. Treat it as
    // absent (0), the same "no measurement" reading `spendUsd: null` gets.
    const rawAccepted = acceptedUnits?.[armId];
    const accepted = Number.isFinite(rawAccepted) && rawAccepted >= 0 ? rawAccepted : 0;
    if (isPriced) priced += 1;

    // Cluster B fix-gate (R5): compare the ceiling against the RAW division,
    // not the rounded display figure. `costPerAccepted` is round6'd for
    // reporting; checking `<=` against the rounded value instead of the raw
    // one lets a cost up to $0.0000005 over the ceiling round DOWN to exactly
    // the ceiling and read as within it — a real, if narrow, threshold-
    // correctness bug, not merely a display concern. The two only ever
    // disagree inside that half-a-millionth-of-a-dollar band; every other
    // comparison is unaffected.
    const rawCostPerAccepted = (isPriced && accepted > 0) ? spend / accepted : null;
    const costPerAccepted = rawCostPerAccepted == null ? null : round6(rawCostPerAccepted);
    perArm[armId] = {
      spendUsd: isPriced ? round6(spend) : null,
      acceptedUnits: accepted,
      costPerAccepted,
      // `null`, not `false`: "we cannot say" and "it is over the ceiling" are
      // different facts, and collapsing them lets an unpriced arm read as
      // merely expensive. No ceiling declared is also `null` — unconstrained is
      // not the same as verified-within.
      withinCeiling: (rawCostPerAccepted == null || effectiveCeiling == null)
        ? null
        : rawCostPerAccepted <= effectiveCeiling,
      clearedFloor: cleared,
    };
  }

  const evidence = armIds.length === 0 || priced === 0
    ? (armIds.length === 0 ? 'complete' : 'unknown')
    : (priced === armIds.length ? 'complete' : 'partial');

  // Cluster B fix-gate, raised independently in two rounds: `selectable` is
  // STRICT BY DEFAULT — evidence !== 'complete' returns no candidates at all,
  // not a subset filtered to the priced arms. "Unknown cost must not select a
  // winner" (D2b) was implemented per-arm only, which technically satisfies
  // the letter (an unpriced arm itself never wins) while leaving the DECISION
  // AS A WHOLE resolvable from partial evidence — a caller reading
  // `selectable` without separately checking `evidence` would get a real
  // winner back from a comparison that never saw every arm's cost. Verified
  // safe: the one existing consumer (campaign/verdict.mjs's wrapper) never
  // reads this field at all — it computes its own affordable/winner logic
  // from `perArm` directly, with its OWN stricter whole-stage refusal, so
  // this default was already redundant with what the sole caller does.
  //
  // `allowPartialEvidence: true` is the escape hatch for a caller that
  // genuinely wants the old per-arm behavior (decide among whichever arms
  // ARE priced, ignoring the ones that are not) — an explicit request, never
  // a silent default.
  const selectable = (evidence === 'complete' || allowPartialEvidence)
    ? armIds.filter((id) => {
        const a = perArm[id];
        if (!a.clearedFloor) return false;
        if (a.costPerAccepted == null) return false;
        return effectiveCeiling == null ? true : a.withinCeiling === true;
      })
    : [];

  return { perArm, evidence, selectable };
}
