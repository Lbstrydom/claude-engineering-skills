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
import { captureV1Present, redactAndCapText } from './capture-identity.mjs';
import { isAdjudicatorKind, isDismissReasonClass, fixOrderFlag, isTerminalFixState, isRemediationState } from '../adjudication-vocab.mjs';

/**
 * The ledger row a final-review credit disposition leaves behind, as a pure
 * function of the finding's pre-state and the disposition. Exported so the
 * column-level contract (which NOT NULL columns are filled, and with what) is
 * testable without a database.
 *
 * **Why each field is what it is.**
 * - `remediation_state` is **NOT NULL with no default** on this table, so an
 *   omitted field is a `23502`, never a silent no-op. The honest value is the
 *   remediation axis AS IT STOOD when the disposition was taken — this route
 *   does not touch that axis — coerced to `'pending'` when the finding carries
 *   nothing valid, because `audit_findings.remediation_state` is unconstrained
 *   TEXT and this column is a closed 5-value CHECK.
 * - `round` is likewise NOT NULL with no default here, while
 *   `audit_findings.round_raised` is NOT NULL DEFAULT 1 — the finding's value
 *   always exists, so carry it.
 * - `ruling` stays NULL **deliberately**. `sustain`/`overrule` are rulings on an
 *   auditor's claim and are read by the R2+ rulings injection; a credit-queue
 *   disposition establishes who closed the finding, not that a claim was
 *   adjudicated on its merits, and writing one would silently widen suppression.
 * - `created_at` is NOT NULL **with** `DEFAULT NOW()` — the one column here
 *   where omission IS a silent no-op, and the wanted one: it takes the same
 *   server clock as the finding's `decided_at = NOW()` in the same transaction.
 *
 * @param {{remediation_state?: string|null, round_raised?: number|null}} pre
 * @param {{outcome: string, rationale?: string|null}} disposition
 * @returns {Record<string, unknown>}
 */
export function buildCreditLedgerRow(pre, { outcome, rationale }) {
  return {
    adjudication_outcome: outcome,
    remediation_state: isRemediationState(pre?.remediation_state) ? pre.remediation_state : 'pending',
    round: pre?.round_raised ?? 1,
    ruling: null,
    ruling_rationale: redactAndCapText(rationale || `final-review credit queue: ${outcome}`),
  };
}

/**
 * Apply a final-review credit disposition to one finding AND record its ledger
 * row, in ONE transaction.
 *
 * **Why this exists.** `adjudicateFinalReviewFinding` wrote the finding's
 * columns and nothing else, so a close left no trace outside the row it
 * changed. On 2026-09-14 that route closed 435 shadow-only findings in this
 * repo one at a time (435 distinct `decided_at` values over thirteen hours) and
 * `finding_adjudication_events` holds nothing for any of them — "who closed
 * these and on what grounds" was unanswerable from the ledger AGENTS.md
 * presents as the record (docs/plans/standing-queue-burndown.md §7.2).
 *
 * **`event_origin: 'audit'`, `adjudicator_kind: 'human'` — not a new origin.**
 * The origin names the WORKFLOW that owns the row, and there are two:
 * the audit-loop tooling's own path and the comparison campaigns' (campaign
 * rows always carry `method`). A credit disposition comes through the first.
 * What distinguishes it from a pipeline ruling is WHO decided, and the `kind`
 * axis already carries that — `'human'` is exactly an operator working the
 * worksheet. A third origin value would need a CHECK-widening migration plus a
 * constraint probe for consumer stores that have not run it, to express
 * something the existing `(origin, kind)` pair already expresses.
 *
 * **Failure mode: atomic, loud, not `durableWrite`.** Both writes are one
 * logical fact, so they share a transaction: a failed event INSERT rolls the
 * disposition back and the caller gets its existing `{ok:false, reason:
 * 'db-error: …'}`. The tradeoff is real — a store that can take the UPDATE but
 * not the INSERT now fails where it used to succeed. It is the right way round:
 * this is an explicit operator CLI action, retried in seconds, never a push
 * gate, so a loud refusal costs one retry while the old behaviour cost an
 * untraceable close. The spill/lost vocabulary is for the audit run's
 * fire-and-forget telemetry, where losing a write must not kill a long paid
 * run; there is no long run here and nothing to reconcile later.
 *
 * Idempotent: re-adjudicating replaces this workflow's own prior row
 * (`event_origin = 'audit'` AND `adjudicator_kind = 'human'`), leaving campaign
 * provenance and the pipeline's own rulings untouched.
 *
 * @param {string} findingId
 * @param {{userAction: string, outcome: string, rationale?: string|null}} disposition
 * @returns {Promise<number>} rows updated (0 = the finding vanished under us)
 */
export async function applyFinalReviewDisposition(findingId, { userAction, outcome, rationale = null }) {
  // Probed separately (cached): `adjudicator_kind` landed 20260811, `event_origin`
  // 20261026, so a store can legitimately have the first and not the second. On a
  // store with neither there is NO discriminator, and this route then appends
  // rather than replacing — a duplicate ledger row is ugly, where the delete-all
  // the legacy path would need is lossy, and lossy is the thing being fixed.
  const hasKind = await strictColumnExists('finding_adjudication_events', 'adjudicator_kind', many, isCloudEnabled);
  const hasOrigin = await strictColumnExists('finding_adjudication_events', 'event_origin', many, isCloudEnabled);
  return withTx(async () => {
    // audit_findings FIRST, then the event — the lock order every other writer
    // here takes (the reverse deadlocked against the remediation projection).
    const pre = await one(
      'SELECT remediation_state, round_raised FROM audit_findings WHERE id = $1 FOR UPDATE', [findingId]);
    if (!pre) return 0;
    const res = await query(
      `UPDATE audit_findings
          SET user_action = $2, adjudication_outcome = $3, decided_at = NOW()
        WHERE id = $1`,
      [findingId, userAction, outcome]
    );
    const updated = res.rowCount ?? 0;
    if (updated === 0) return 0;
    if (hasKind) {
      // Scoped to this workflow's own rows. The pipeline's rulings
      // (`adjudicator_kind` 'pipeline' or legacy NULL) and campaign provenance
      // (`event_origin = 'campaign'`) are separate records and survive.
      await query(`DELETE FROM finding_adjudication_events
                    WHERE finding_id = $1 AND adjudicator_kind = 'human'
                      AND (${hasOrigin ? "event_origin = 'audit'" : 'method IS NULL'})`, [findingId]);
    }
    await insertReturning('finding_adjudication_events', {
      finding_id: findingId,
      ...buildCreditLedgerRow(pre, { outcome, rationale }),
      ...(hasKind ? { adjudicator_kind: 'human' } : {}),
      ...(hasOrigin ? { event_origin: 'audit' } : {}),
    });
    return updated;
  });
}

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
    return `adjudicatorKind must be one of agent|human|pipeline|rule|reviewer (got ${JSON.stringify(event?.adjudicatorKind)})`;
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
  // The compatibility gate: `reviewer` rows (and the kind-scoped delete below) exist only where the capture-v1
  // migration widened the CHECK. An un-migrated store keeps today's behaviour; a reviewer event is skipped, not failed.
  const captureV1 = await captureV1Present();
  const isReviewer = event.adjudicatorKind === 'reviewer';
  if (isReviewer && !captureV1) return { ok: false, reason: 'unmigrated', detail: 'audit_runs.capture_epoch absent' };
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
      // A reviewer event is an observation about the ruling, not the ruling: it must not rewrite the finding's
      // denormalised outcome (the label every query reads). The row lock above is still taken, so reviewer and
      // pipeline writes on one finding serialise.
      if (!isReviewer) {
        const { rowCount } = await updateWhere('audit_findings', buildFindingAdjudicationPatch(event, new Date(), pre), { id: finding.id });
        if (rowCount !== 1) throw new Error(`audit_findings ${finding.id}: ${rowCount} row(s) updated, expected 1`);
      }
      // This workflow's rows: stamped 'audit', or unstamped by an OLDER tool version
      // mid-rollout (NULL origin and no campaign `method`). Campaign rows survive.
      if (migrated && captureV1) {
        // Scoped to the SAME adjudicator kind, so a reviewer row and a pipeline row on one finding coexist. Legacy
        // NULL-kind rows keep matching the pipeline path. A reviewer rewrite replaces only the SAME reviewing run's row:
        // a later review of the same source finding adds its own.
        const kind = event.adjudicatorKind;
        await query(`DELETE FROM finding_adjudication_events WHERE finding_id = $1
                       AND (event_origin = 'audit' OR (event_origin IS NULL AND method IS NULL))
                       AND (adjudicator_kind = $2 OR ($2 = 'pipeline' AND adjudicator_kind IS NULL))
                       AND ($2 <> 'reviewer' OR evidence ->> 'reviewing_run_id' IS NOT DISTINCT FROM $3)`,
        [finding.id, kind, isReviewer ? String(event.evidence?.reviewing_run_id ?? '') || null : null]);
      } else if (migrated) {
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
        // Free text goes through the secret redactor and a length cap at the store boundary (Decision 5).
        // Unconditional, un-migrated stores included: a secret in a rationale is worth redacting whatever the schema.
        ruling_rationale: redactAndCapText(event.rulingRationale),
        round: event.round,
        ...(migrated ? {
          event_origin: 'audit',
          adjudicator_kind: event.adjudicatorKind,
          adjudicator_model: event.adjudicatorModel ?? null,
          // jsonb: passed RAW, the write seam serialises it.
          ...(captureV1 && event.evidence ? { evidence: event.evidence } : {}),
        } : {}),
      });
    });
    return { ok: true };
  } catch (err) {
    process.stderr.write(`  [learning] recordAdjudicationEvent failed: ${err.message}\n`);
    return { ok: false, reason: 'db-error', detail: err.message };
  }
}
