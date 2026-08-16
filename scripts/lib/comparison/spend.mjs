/**
 * @fileoverview Money, counted honestly — shared by every comparison role.
 *
 * Three facts this module exists to keep straight, each of which was measured
 * wrong before it existed:
 *
 * 1. **Spend reads ALL attempts; effectiveness reads live ones.** They are
 *    different questions and must never share a sum. On 2026-08-14 a real
 *    collection spent **$7.10** of which **$4.16 bought nothing**, and the
 *    progress line reported `$2.94` — because it summed only complete
 *    snapshots. 59% of the money was invisible.
 * 2. **An unpriced attempt is `null`, never `0`.** A missing price read as free
 *    is the original NULL-cost incident, and it flatters exactly the arm whose
 *    route nobody has priced.
 * 3. **A budget is a post-hoc stop, not a cap.** Token usage is known only
 *    after the provider responds, so nothing here can bound a call already in
 *    flight. Claiming otherwise is the INC-002 shape — treating a configured
 *    value as a safety property.
 *
 * @module scripts/lib/comparison/spend
 */

/** Cents-of-a-cent precision: enough for per-token pricing, short of float noise. */
function round6(n) { return Math.round(n * 1e6) / 1e6; }

/**
 * Per-arm spend over **every** attempt, on **every** snapshot — complete,
 * incomplete and superseded alike.
 *
 * A superseded attempt WAS PAID FOR. Summing only the final attempt means an
 * arm that failed once and was re-run reports less spend than it cost, while an
 * arm that succeeded first time reports all of its own — and since the cost
 * stage is a comparison *between* arms, that asymmetry systematically flatters
 * the flakier model. Not a null read as free, but a real charge read as never
 * having happened.
 *
 * `costStatus: 'unpriced'` on ANY attempt — live or superseded — forces
 * `costEvidence: 'unknown'` for that arm. So does `'unknown'`: a status saying
 * we never determined the price is not weaker evidence than one saying we could
 * not, it is the same absence.
 *
 * Moved from `campaign/verdict.mjs` (Phase 3, hardened further in the Cluster B
 * fix-gate): the auditor role needs the identical sum, and a second
 * implementation would be a second chance to re-introduce the 59%-invisible
 * bug. The summation LOGIC and its output for every real input are unchanged;
 * only the validity check on what counts as "priced" was tightened
 * (negative costUsd now degrades to unpriced, same as non-finite) — no real
 * provider bill is negative, so this affects no legitimate caller.
 *
 * @param {Array<{snapshotId?: string, armRuns?: Array<{armId: string, attempt?: number,
 *   costUsd?: number|null, costStatus?: string, supersededAt?: string|null}>}>} snapshots
 * @returns {Record<string, {spendUsd: number, attempts: number, unpricedAttempts: number, costEvidence: 'known'|'unknown'}>}
 */
export function armSpend(snapshots) {
  // Cluster B fix-gate (R2): a plain `{}` accumulator INHERITS Object.prototype,
  // so an arm literally named `constructor` (a valid id under ARM_ID_PATTERN —
  // `__proto__` is not, the pattern's charset excludes underscores, but
  // `constructor` matches) reads `perArm['constructor']` as the inherited
  // `Object` constructor FUNCTION before ever writing an entry — `?? (…)`
  // short-circuits on that truthy value, so no real entry is ever created,
  // and `entry.attempts += 1` silently attaches a bogus property to the
  // global `Object` constructor. Confirmed live: `armSpend([{armRuns:[{armId:
  // 'constructor', …}]}]).constructor` came back as a FUNCTION with
  // `.attempts === NaN`, not a spend record. Same class this codebase already
  // fixed once for `CONTROLS_BY_ROLE` ("a truthiness check would accept
  // `toString` as a role") — `Object.create(null)` is the same fix, applied
  // here to the accumulator this module builds instead of a lookup table.
  const perArm = Object.create(null);
  for (const snap of snapshots || []) {
    for (const run of snap.armRuns || []) {
      const entry = perArm[run.armId] ?? (perArm[run.armId] = { spendUsd: 0, attempts: 0, unpricedAttempts: 0, costEvidence: 'known' });
      entry.attempts += 1;
      // Cluster B fix-gate (R2): `Number.isFinite` alone still accepted a
      // NEGATIVE costUsd as "priced" — no real provider bill is negative, so
      // this can only be a corrupted or malformed upstream value, but a
      // finite negative number added into the running total silently
      // DECREASES aggregate spend, the exact wrong-direction failure a cost
      // accounting seam exists to prevent (a corrupted call reads as making
      // the arm cheaper, not as a measurement we cannot trust). Same bucket
      // as non-finite: degrade to unpriced rather than trust it.
      if (run.costStatus === 'priced' && Number.isFinite(run.costUsd) && run.costUsd >= 0) {
        entry.spendUsd += Number(run.costUsd);
      } else {
        entry.unpricedAttempts += 1;
        entry.costEvidence = 'unknown';
      }
    }
  }
  // Cluster B fix-gate (R6): each ATTEMPT's costUsd is validated finite before
  // it's summed, but the RUNNING TOTAL never was — enough finite-but-extreme
  // attempts (a corrupted upstream value, not a real provider bill) can still
  // overflow to Infinity, and `round6(Infinity)` is `Infinity`, not a caught
  // error. An overflowed total is a NEW invalid value the per-attempt guard
  // never saw, so it needs the same degrade-to-unpriced treatment a single bad
  // attempt already gets, rather than escaping this function as if it were a
  // real number a caller could safely display or compare.
  for (const entry of Object.values(perArm)) {
    if (!Number.isFinite(entry.spendUsd)) {
      entry.spendUsd = 0;
      entry.costEvidence = 'unknown';
    } else {
      entry.spendUsd = round6(entry.spendUsd);
    }
  }
  return perArm;
}

/**
 * The incomplete-snapshot spend view model (D5).
 *
 * A bare number is not reportable here — "spend" had four different meanings in
 * the readout, so every field below exists because its absence lets a reader
 * draw a confident wrong conclusion:
 *
 * | Field | Why it is its own field |
 * |---|---|
 * | `cohortDigest` | The figure is cohort-scoped; without it, it is unattributable across a lock change. |
 * | `incompleteSpendUsd` | `null` = not computable. **Never `0`** — that is the exact misread this line exists to prevent. |
 * | `monetaryStatus` | `partial` when some arm is unpriced; without it a partial total renders as a complete one. |
 * | `excludedArmIds` | Names WHICH arms are unpriced, so the reader sees what is missing rather than that something is. |
 * | `incompleteSnapshotCount` | A spend figure with no denominator cannot be sanity-checked. |
 * | `unrecordedSnapshotCount` | How many of those snapshots have no arm run at all — invisible to `excludedArmIds`, which can only name a known arm ID. |
 *
 * **The empty state is carried by the COUNT, and the money is `null` there on
 * purpose.** Zero incomplete snapshots must render "no incomplete snapshots",
 * not a `$0.00` row — an absent thing and a zero-valued thing must not look
 * identical. Returning `0` and trusting every renderer to check the count first
 * is the silent-strip shape; returning `null` means a renderer that prints the
 * number without looking prints "unknown", which is the safe direction to be
 * wrong in. So: `count === 0` ⇒ nothing was spent on incomplete work;
 * `count > 0 && incompleteSpendUsd === null` ⇒ we could not total it.
 *
 * @param {Array<{snapshotId?: string, complete?: boolean, armRuns?: Array<object>}>} snapshots
 * @param {{cohortDigest?: string|null}} [opts]
 * @returns {{cohortDigest: string|null, incompleteSpendUsd: number|null,
 *   monetaryStatus: 'complete'|'partial'|'unknown', excludedArmIds: string[],
 *   incompleteSnapshotCount: number, unrecordedSnapshotCount: number}}
 */
export function incompleteSpend(snapshots, { cohortDigest = null } = {}) {
  const incomplete = (snapshots || []).filter((s) => s && s.complete !== true);
  const perArm = armSpend(incomplete);
  const armIds = Object.keys(perArm).sort();
  const excludedArmIds = armIds.filter((id) => perArm[id].costEvidence !== 'known');

  if (incomplete.length === 0) {
    return {
      cohortDigest,
      incompleteSpendUsd: null,
      monetaryStatus: 'complete',
      excludedArmIds: [],
      incompleteSnapshotCount: 0,
      unrecordedSnapshotCount: 0,
    };
  }

  // Cluster B fix-gate (R4): a snapshot interrupted before ANY arm run was
  // even recorded (`armRuns: []`/absent — the process died before the first
  // attempt, not after an unpriced one) contributes NOTHING to `perArm`, so
  // it was invisible to `excludedArmIds` (which only names known ARM ids)
  // and, when it was the only incomplete snapshot, `armIds.length === 0`
  // made `everyArmUnpriced` read `false` — the exact opposite of what an
  // empty arm list means here. That collapsed to `incompleteSpendUsd: 0,
  // monetaryStatus: 'complete'`: a total wholly unrecorded execution
  // reporting as "we checked, it cost nothing" rather than "we have no data
  // at all". `unrecordedSnapshotCount` names the gap explicitly rather than
  // folding it into `excludedArmIds`, which is arm-ID-keyed and has no ID to
  // report for a snapshot that never reached its first arm.
  const unrecordedSnapshotCount = incomplete.filter((s) => !s || !Array.isArray(s.armRuns) || s.armRuns.length === 0).length;

  // Unpriced arms are excluded from the TOTAL but named beside it — the number
  // stays true for what it covers, and the reader can see its edge.
  const total = armIds
    .filter((id) => perArm[id].costEvidence === 'known')
    .reduce((sum, id) => sum + perArm[id].spendUsd, 0);

  const everyArmUnpriced = armIds.length > 0 && excludedArmIds.length === armIds.length;
  // Nothing recorded at all (either every incomplete snapshot had zero arm
  // runs, or none of the ones that did contributed a known price) is the
  // same "cannot total it" fact as everyArmUnpriced — no known arm to name
  // does not mean nothing is missing.
  const nothingRecorded = everyArmUnpriced || armIds.length === 0;
  return {
    cohortDigest,
    // Every arm unpriced (or no arm even recorded) means the total covers
    // nothing at all. Reporting $0.00 there would be the precise misread
    // this whole view model exists to stop.
    incompleteSpendUsd: nothingRecorded ? null : round6(total),
    monetaryStatus: nothingRecorded
      ? 'unknown'
      : (excludedArmIds.length > 0 || unrecordedSnapshotCount > 0 ? 'partial' : 'complete'),
    excludedArmIds,
    incompleteSnapshotCount: incomplete.length,
    unrecordedSnapshotCount,
  };
}

/**
 * D6 — has this arm exhausted its budget? A **between-units stop**, checked
 * after a billable unit completes.
 *
 * What it can promise: no FURTHER unit is attempted for this arm once its
 * recorded spend reaches the budget. What it cannot: preventing overshoot on
 * the unit already in flight. Worst case is one unit's worth of that arm —
 * bounded, stated, and not zero. A caller that advertises this as a hard cap is
 * repeating INC-002.
 *
 * **The unit is role-defined**, and that is load-bearing rather than pedantic:
 * an earlier draft checked "between snapshots", which is the passive
 * collector's loop — the auditor evaluates a whole corpus in one synchronous
 * execution, so that guard would never have fired for half the roles this core
 * covers. A guard that is structurally unreachable is worse than an absent one,
 * because it reads as protection.
 *
 *   | Role | Billable unit | Checked |
 *   |---|---|---|
 *   | `final_review_shadow` | one snapshot | between snapshots |
 *   | `auditor` | one corpus case | between cases |
 *
 * Budget-per-arm rather than per-campaign because the expensive arm otherwise
 * exhausts a shared budget before the cheap arms finish, biasing which arms
 * have evidence at all — `opus` was 77% of spend on the measured cohort.
 *
 * @param {{spendSoFarUsd: number|null, budgetUsdPerArm: number|null|undefined,
 *   costEvidence?: 'known'|'unknown'}} args
 * @returns {{stop: boolean, reason: string|null, remainingUsd: number|null}}
 */
export function armBudgetStop({ spendSoFarUsd, budgetUsdPerArm, costEvidence = 'known' }) {
  // No budget declared: nothing to enforce, and saying so is not a failure.
  if (budgetUsdPerArm == null) return { stop: false, reason: null, remainingUsd: null };

  // A malformed budget (NaN, Infinity, negative — a config/parse bug upstream)
  // is not "no budget declared", and must not be treated as one: `NaN == null`
  // is false, so this check does NOT fall into the branch above, and every
  // comparison against NaN is false — `spendSoFarUsd >= NaN` never fires — so
  // an un-caught NaN silently reached the fall-through "under budget" return
  // below, reporting an unenforceable ceiling as an enforced one still under
  // budget. Same failure shape as the unpriced-route case just below: a
  // configured value that cannot be measured must stop, not proceed
  // unconstrained.
  if (!Number.isFinite(budgetUsdPerArm) || budgetUsdPerArm < 0) {
    return { stop: true, reason: 'budget-unenforceable-invalid-budget', remainingUsd: null };
  }

  // An arm whose route has no price cannot be budget-governed at all.
  // `manifest.mjs` refuses this pairing at load, so reaching here means the
  // pricing table lost a route mid-run. Stop: continuing to spend under a
  // ceiling that cannot be measured is exactly the ceiling-configured-is-not-
  // ceiling-enforced failure, and the safe direction is to stop paying.
  if (costEvidence !== 'known' || !Number.isFinite(spendSoFarUsd)) {
    return { stop: true, reason: 'budget-unenforceable-unpriced', remainingUsd: null };
  }
  // A distinct fact from "unpriced": a NEGATIVE spend-so-far is not a real
  // cumulative cost (a corrupted or buggy upstream accumulator — armSpend's
  // own guard now prevents this from a well-behaved caller, but this
  // function must not trust that every caller went through it), and would
  // silently INFLATE the apparent remaining budget
  // (`budgetUsdPerArm - (-5)` reads as MORE headroom, not less) — the wrong
  // direction for a guard whose whole job is to stop spending sooner, not later.
  if (spendSoFarUsd < 0) {
    return { stop: true, reason: 'budget-unenforceable-invalid-spend', remainingUsd: null };
  }

  const remaining = round6(budgetUsdPerArm - spendSoFarUsd);
  // "At or over", not "over": a budget reached is a budget spent.
  if (spendSoFarUsd >= budgetUsdPerArm) {
    return { stop: true, reason: 'budget-exhausted', remainingUsd: 0 };
  }
  return { stop: false, reason: null, remainingUsd: remaining };
}
