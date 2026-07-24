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
export async function finalizeRefreshMode({ mode, sinceCommit, repoId, embedProfile, logOk }) {
  let prior = null;
  if (mode === 'incremental') {
    prior = await getActiveSnapshot(repoId);
    // Provenance-change guard (D3/H4): an incremental run re-embeds only touched
    // files but publishes new provenance unconditionally. If the identity we're
    // about to publish differs from the prior snapshot's, an incremental run
    // would leave a MIXED index — touched symbols in the new space, untouched in
    // the old — that the read-side guard can't catch (the published id would
    // "match"). Force a full re-embed whenever provenance changes.
    if (provenanceRequiresFullReembed(prior, embedProfile.provenanceId)) {
      logOk(
        `embedding provenance changed (${prior.activeEmbeddingModel} → ${embedProfile.provenanceId}) ` +
        `— promoting to --full to avoid a mixed vector space`,
      );
      mode = 'full';
    } else if (!sinceCommit) {
      // R1 audit M7: derive the incremental anchor from the prior snapshot; no
      // usable anchor ⇒ promote to full rather than walk the whole repo as a
      // "no diff" incremental.
      if (prior?.refreshId) {
        try {
          const priorRun = await getRefreshRun(prior.refreshId, {
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
      if (!sinceCommit) {
        logOk(`no prior snapshot anchor — promoting to --full for this run`);
        mode = 'full';
      }
    }
  }
  return { mode, sinceCommit, prior };
}
