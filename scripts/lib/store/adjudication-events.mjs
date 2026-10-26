/**
 * @fileoverview `finding_adjudication_events` writer — extracted from
 * `runs-findings.mjs` (a file over the size-ratchet limit may not grow) and
 * extended for own-model telemetry slice 1
 * (docs/plans/own-model-telemetry-slice-1.md): who decided, which workflow owns
 * the event, the dismissal class, and first-transition chronology. Re-exported
 * verbatim by `runs-findings.mjs`, so every existing importer is unchanged.
 *
 * @module scripts/lib/store/adjudication-events
 */
import { many, one, query, updateWhere, deleteWhere, insertReturning, withTx } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';
import { selectFindingRow } from './finding-identity.mjs';
import { strictColumnExists } from './column-probes.mjs';
import { isAdjudicatorKind, isDismissReasonClass, fixOrderFlag, isTerminalFixState } from '../adjudication-vocab.mjs';

/**
 * Build the denormalised `audit_findings` patch for an adjudication event.
 * Pure + exported so the propagation contract is unit-testable without a DB.
 *
 * `remediation_state` (fix-lifecycle plan, gap #2): the `unlocked_fixes` view
 * reads `audit_findings.remediation_state`, but this UPDATE historically set
 * only `adjudication_outcome`, so the column was write-never and the view was
 * permanently empty. It is now propagated here — **only when the event carries a
 * value** (`!= null`), so an adjudication event lacking `remediationState` can
 * never null an existing state (monotonic-safe).
 *
 * `pre` (own-model telemetry) is the finding's state BEFORE this write, supplied
 * only against a migrated store, so an unmigrated store gets exactly the legacy
 * patch. "Not yet occurred" is told apart from "occurred before we recorded it"
 * by the pre-migration columns themselves: the FIRST decision is provable only
 * when decided_at was still NULL, the first fix only when remediation_state was
 * not yet terminal. A legacy finding already decided/fixed keeps a NULL stamp, so
 * its flag stays NULL (unknown) instead of inheriting a re-adjudication's time.
 *
 * @param {{adjudicationOutcome: string, remediationState?: string|null, dismissReasonClass?: string}} event
 * @param {Date} decidedAt
 * @param {object|null} [pre]
 * @returns {Record<string, unknown>}
 */
export function buildFindingAdjudicationPatch(event, decidedAt, pre = null) {
  // decided_at (model-swap-eval-harness Phase 4 migration 20260713110000) — the
  // only column recording WHEN a finding was adjudicated; created_at is when it
  // was RAISED, not decided.
  const patch = { adjudication_outcome: event.adjudicationOutcome, decided_at: decidedAt };
  if (event.remediationState != null) patch.remediation_state = event.remediationState;
  if (!pre) return patch;
  if (event.adjudicationOutcome === 'dismissed' && event.dismissReasonClass) {
    patch.dismiss_reason_class = event.dismissReasonClass;
  }
  if (pre.decided_at == null && pre.first_decided_at == null) {
    patch.first_decided_at = decidedAt;
    const ms = decidedAt.getTime() - new Date(pre.created_at).getTime();
    if (Number.isFinite(ms) && ms >= 0) patch.time_to_resolution_ms = ms;
  }
  // First fix only from NULL/pending/planned: a regressed row implies an earlier fix.
  if (isTerminalFixState(event.remediationState) && pre.fix_recorded_at == null
      && [null, undefined, 'pending', 'planned'].includes(pre.remediation_state)) {
    patch.fix_recorded_at = decidedAt;
  }
  if (pre.fixed_before_adjudication == null) {
    const flag = fixOrderFlag({
      fixRecordedAt: patch.fix_recorded_at ?? pre.fix_recorded_at,
      firstDecidedAt: patch.first_decided_at ?? pre.first_decided_at,
    });
    if (flag !== null) patch.fixed_before_adjudication = flag;
  }
  return patch;
}

/**
 * PURE. Refusal for an adjudication event the store must not accept, or null.
 * Who decided is required (the H1 gap this closes: 97% of events had none), and
 * a dismissal must carry a vocabulary-valid class at this common boundary rather
 * than in each producer.
 * @param {{adjudicatorKind?: string, adjudicationOutcome?: string, dismissReasonClass?: string}} event
 * @returns {string|null}
 */
export function adjudicationEventRefusal(event) {
  if (!isAdjudicatorKind(event?.adjudicatorKind)) {
    return `adjudicatorKind must be one of agent|human|pipeline|rule (got ${JSON.stringify(event?.adjudicatorKind)})`;
  }
  if (event.adjudicationOutcome === 'dismissed' && !isDismissReasonClass(event.dismissReasonClass)) {
    return `a dismissed event needs a vocabulary-valid dismissReasonClass (got ${JSON.stringify(event.dismissReasonClass)})`;
  }
  return null;
}

/**
 * Record an adjudication event for a finding. Two-step:
 *   1. Resolve the audit_findings.id from the finding fingerprint
 *      (+ optional pass_name / round_raised disambiguation), via the shared
 *      `selectFindingRow` oracle (write-boundary-hardening plan Phase 4,
 *      debt 28d5f3d2fde7/8dbc3a738ff8) — never a bare `LIMIT 1` with no
 *      `ORDER BY`, and a missing/ambiguous/db-error outcome is now
 *      distinguishable to the caller instead of a uniform `undefined`.
 *   2. Inside a transaction:
 *        - UPDATE audit_findings.adjudication_outcome + remediation_state (denormalised),
 *          asserting exactly one row
 *        - DELETE this workflow's prior events on the finding (idempotent re-record);
 *          campaign-origin events are separate provenance and survive
 *        - INSERT the new event
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: 'no-match'|'ambiguous'|'bad-input'|'db-error', detail?: string}>}
 */
export async function recordAdjudicationEvent(runId, findingFingerprint, event) {
  if (!runId || !await isCloudEnabled()) return { ok: false, reason: 'no-match' };
  const refusal = adjudicationEventRefusal(event);
  if (refusal) return { ok: false, reason: 'bad-input', detail: refusal };
  try {
    const resolved = await selectFindingRow({
      runId,
      fingerprint: findingFingerprint,
      passName: event.passName || undefined,
      roundRaised: event.round || undefined,
    });
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason === 'ambiguous' ? 'ambiguous' : 'no-match' };
    }
    const finding = { id: resolved.id };
    // Probed once per process (cached): a consumer store migrated later must not
    // fail an adjudication on an unknown column.
    const migrated = await strictColumnExists('finding_adjudication_events', 'event_origin', many, isCloudEnabled)
      && await strictColumnExists('audit_findings', 'first_decided_at', many, isCloudEnabled);

    await withTx(async () => {
      // audit_findings FIRST, then the event: the lock order projectRemediationState
      // takes. The reverse order deadlocked against a concurrent projection (40P01).
      // FOR UPDATE makes the pre-state read the same row version the UPDATE sees.
      const pre = migrated
        ? await one(
            `SELECT decided_at, first_decided_at, remediation_state, fix_recorded_at,
                    fixed_before_adjudication, created_at
               FROM audit_findings WHERE id = $1 FOR UPDATE`, [finding.id])
        : null;
      const { rowCount } = await updateWhere('audit_findings', buildFindingAdjudicationPatch(event, new Date(), pre), { id: finding.id });
      if (rowCount !== 1) throw new Error(`audit_findings ${finding.id}: ${rowCount} row(s) updated, expected 1`);
      // This workflow's rows: stamped 'audit', or unstamped by an OLDER tool version
      // mid-rollout (NULL origin and no campaign `method`). Campaign rows survive.
      if (migrated) {
        await query(`DELETE FROM finding_adjudication_events WHERE finding_id = $1
                       AND (event_origin = 'audit' OR (event_origin IS NULL AND method IS NULL))`, [finding.id]);
      } else {
        await deleteWhere('finding_adjudication_events', { finding_id: finding.id });
      }
      await insertReturning('finding_adjudication_events', {
        finding_id: finding.id,
        adjudication_outcome: event.adjudicationOutcome,
        remediation_state: event.remediationState,
        ruling: event.ruling,
        ruling_rationale: event.rulingRationale,
        round: event.round,
        ...(migrated ? {
          event_origin: 'audit',
          adjudicator_kind: event.adjudicatorKind,
          adjudicator_model: event.adjudicatorModel ?? null,
        } : {}),
      });
    });
    return { ok: true };
  } catch (err) {
    process.stderr.write(`  [learning] recordAdjudicationEvent failed: ${err.message}\n`);
    return { ok: false, reason: 'db-error', detail: err.message };
  }
}
