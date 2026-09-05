/**
 * @fileoverview Incremental→full mode-promotion logic for `refresh.mjs`.
 *
 * Touches code with a documented prior calibration-validity incident
 * (Gemini-r2-G3, docs/plans/arch-memory-band-recalibration.md
 * §"Round-2 findings") — the exact escalation order (provenance-change guard
 * checked BEFORE the no-anchor check, `else if`) is preserved verbatim; a
 * reordering would change which log line fires when both conditions are
 * true.
 *
 * Extracted from `refresh.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/symbol-index/refresh-mode
 */

import { getActiveSnapshot, getRefreshRun } from '../learning-store.mjs';

/**
 * D3/H4 promotion predicate — pure. An incremental refresh re-embeds only
 * touched files but publishes new provenance unconditionally, so when the
 * vector-space identity we're about to publish differs from the prior
 * active snapshot's, an incremental run would leave a MIXED index. Promote
 * to a full re-embed in that case. Only a REAL prior identity triggers it (a
 * first-ever refresh with no prior is handled by the existing anchor-less
 * promotion).
 *
 * @param {{activeEmbeddingModel?: string|null}|null|undefined} prior
 * @param {string} nextProvenanceId
 * @returns {boolean}
 */
export function provenanceRequiresFullReembed(prior, nextProvenanceId) {
  return Boolean(prior?.activeEmbeddingModel) && prior.activeEmbeddingModel !== nextProvenanceId;
}

/**
 * Ownership-epoch promotion predicate — pure.
 *
 * A copy-forward filter can DROP a carried row whose file is now disowned, but
 * it iterates rows already in the index and so can never re-admit a file the
 * index does not have. A rule change in the owning direction produces exactly
 * that, and no iteration over existing rows can express it — hence a full walk.
 *
 * **Unlike `provenanceRequiresFullReembed`, a NULL prior DOES promote.** Copying
 * that guard here would be wrong: a NULL epoch does not mean the snapshot is
 * compatible, it means nobody asked. A consumer can skip the release that
 * introduces the epoch and land on a later one whose rule has moved; the guard
 * would suppress promotion, the run would publish the CURRENT epoch, and every
 * file the old index never had would stay missing with no mismatch left for any
 * later run to notice — converting a one-time gap into a permanent one.
 *
 * @param {{ownershipRuleEpoch?: string|null}|null|undefined} prior
 * @param {string} currentEpoch
 * @returns {boolean}
 */
export function ownershipEpochRequiresFullWalk(prior, currentEpoch) {
  if (!prior) return false;   // no prior snapshot at all — the anchor path owns this
  return prior.ownershipRuleEpoch !== currentEpoch;
}

/**
 * The mode decision, as a PURE function — no store, no clock, no git.
 *
 * Split out because the defect this replaced was a REACHABILITY bug, and
 * reachability is invisible to a test of the predicates alone: an
 * `else if (epochChanged)` chained after anchor resolution never evaluates on an
 * ordinary `arch:refresh` (`sinceCommit` is undefined there, so anchor
 * resolution always claims the chain), yet every predicate test still passed.
 * The repo has the same lesson written down for SQLSTATE 42703 — split the
 * decision out AND put one assertion on a real Postgres. This is the first half;
 * `tests/refresh-ownership-epoch-db.test.mjs` is the second.
 *
 * Anchor resolution is deliberately NOT a promotion trigger. It decides HOW an
 * incremental runs; the triggers decide WHETHER it may run incrementally at all.
 * Any one trigger firing wins.
 *
 * ORDER IS LOAD-BEARING (Gemini-r2-G3, a documented calibration-validity
 * incident): when several conditions hold, provenance is reported first, then
 * the missing anchor, then the epoch. `reason` names which one fired.
 *
 * @param {{prior: object|null, sinceCommit: string|null, anchorMissing: boolean,
 *   provenanceId: string, ownershipRuleEpoch: string|null}} args
 * @returns {{mode: 'full'|'incremental', reason: string|null}}
 */
export function decideRefreshMode({ prior, anchorMissing, provenanceId, ownershipRuleEpoch }) {
  if (provenanceRequiresFullReembed(prior, provenanceId)) return { mode: 'full', reason: 'provenance' };
  if (anchorMissing) return { mode: 'full', reason: 'no-anchor' };
  if (ownershipRuleEpoch && ownershipEpochRequiresFullWalk(prior, ownershipRuleEpoch)) {
    return { mode: 'full', reason: 'ownership-epoch' };
  }
  return { mode: 'incremental', reason: null };
}

/**
 * Finalize scope UNDER the running lock (H4). `main()` calls this only after
 * `acquireRefreshLock` — `openRefreshRun` holds the per-repo running lock
 * (partial-unique on status='running'), so from here `getActiveSnapshot`
 * reflects the last COMPLETED publish and cannot be superseded by a
 * concurrent refresh mid-decision — closing the stale-read race. The
 * decision can only ESCALATE incremental→full (the safe direction); the
 * row's recorded mode stays the user's request, the log records escalation.
 *
 * Queries `prior.refreshId` — the prior PUBLISHED snapshot's id, obtained via
 * `getActiveSnapshot(repoId)` — never the current in-progress run's own id;
 * `repoId` alone is sufficient input (round-2 plan-audit finding, overruled
 * via rebuttal: `getRefreshRun` never needs the in-progress `refreshId`).
 *
 * @param {{mode: string, sinceCommit: string|null, repoId: string, embedProfile: {provenanceId: string}, logOk: (s: string) => void}} args
 * @returns {Promise<{mode: string, sinceCommit: string|null, prior: object|null}>}
 */
export async function finalizeRefreshMode({ mode, sinceCommit, repoId, embedProfile, logOk, ownershipRuleEpoch = null }) {
  let prior = null;
  if (mode === 'incremental') {
    prior = await getActiveSnapshot(repoId);

    // STEP 1 — provenance. Checked FIRST and short-circuiting, because it needs
    // no anchor and the anchor lookup is a database round-trip we should not pay
    // for a run that is going full anyway. `refresh-provenance-promotion.test.mjs`
    // pins exactly that ("promotes to full WITHOUT deriving sinceCommit"), and
    // the ordering itself is a documented calibration-validity incident
    // (Gemini-r2-G3): when several conditions hold, this is the message emitted.
    if (provenanceRequiresFullReembed(prior, embedProfile.provenanceId)) {
      logOk(
        `embedding provenance changed (${prior.activeEmbeddingModel} → ${embedProfile.provenanceId}) ` +
        `— promoting to --full to avoid a mixed vector space`,
      );
      return { mode: 'full', sinceCommit, prior };
    }

    // STEP 2 — resolve the anchor. This is HOW an incremental runs, not WHETHER
    // it may; it is deliberately a statement of its own rather than a link in an
    // if/else chain. As an `else if` it swallowed every later check: `refresh.mjs`
    // sets `sinceCommit = args.sinceCommit`, undefined on a plain `arch:refresh`,
    // so this branch always ran and terminated the chain — which is how the
    // epoch check below would have become dead code on precisely the path it
    // exists for, with every predicate unit test still passing.
    let anchorMissing = false;
    if (!sinceCommit) {
      if (prior?.refreshId) {
        try {
          const priorRun = await getRefreshRun(prior.refreshId, {
            repoId,
            select: ['walk_start_commit'],
          });
          // Anchor on the prior run's START commit (its HEAD-at-open), NOT a
          // HEAD-at-completion. This is deliberate: start-anchoring re-walks any
          // commits that landed DURING the prior run's execution, so no commit
          // can slip through the gap between two runs. End-anchoring would
          // silently miss exactly those mid-run commits — a data-loss bug. A
          // `walk_end_commit` column once existed for the end-anchor idea; it
          // was never written (there is no correct use) and was dropped
          // (migration 20260721150000). Do not reintroduce it.
          sinceCommit = priorRun?.walk_start_commit || null;
        } catch { /* fall through */ }
      }
      anchorMissing = !sinceCommit;
    }

    // STEP 3 — the remaining triggers, evaluated on their own merits. `reason`
    // preserves the documented precedence: anchor before epoch.
    const decision = decideRefreshMode({
      prior, anchorMissing, provenanceId: embedProfile.provenanceId, ownershipRuleEpoch,
    });
    if (decision.reason === 'no-anchor') {
      logOk(`no prior snapshot anchor — promoting to --full for this run`);
    } else if (decision.reason === 'ownership-epoch') {
      logOk(
        `ownership rule epoch changed (${prior.ownershipRuleEpoch ?? 'unrecorded'} → ${ownershipRuleEpoch}) ` +
        `— promoting to --full so files the old rule excluded are re-discovered`,
      );
    }
    mode = decision.mode;
  }
  return { mode, sinceCommit, prior };
}
