/**
 * @fileoverview Store layer for the model-A/B/C experiment harness.
 *
 * Plan: docs/plans/model-ab-experiment-harness.md (Cluster B, Phase 4). Three
 * concerns, all graceful-no-op when cloud is off:
 *
 *  1. **Schema preflight** (decision 13) — with the shadow ENABLED, missing
 *     columns/tables/view is a HARD refusal (no spend without persistence). The
 *     shadow layer calls `modelAbSchemaReady()` and refuses to run if not ready.
 *  2. **Reserve-then-reconcile spend ledger** (decision 12 / R3-H2) — the euro
 *     cap is enforced in code. A reservation is created BEFORE a call, serialized
 *     across parallel arms via a pg advisory lock so they can't collectively
 *     overshoot; reconciled to actual after usage returns. Reservations carry a
 *     TTL so a killed run's orphans are released on startup (crash-safety).
 *  3. **Adjudication state machine** (R3-H3) — a blinded-queue action maps to
 *     `adjudication_outcome`; `duplicate` writes `finding_equivalence` collapsed
 *     to the union-find ROOT (a dup-of-a-dup resolves to one root, never a chain).
 *
 * @module scripts/lib/store/model-ab
 */

import { one, many, query, withTx, upsert, pgArray } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';
import { CANONICAL_ARMS, stagesForArm } from '../audit-arms.mjs';

// ── Schema preflight (decision 13) ───────────────────────────────────────────

/** Safe SQL identifier (defence — audit R1 M4; inputs are constants but the helper must be safe by construction). */
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/i;

/**
 * Probe a relation/column; true iff it exists. Only the definitive "absent"
 * codes (42703 undefined_column / 42P01 undefined_table) → false; a TRANSIENT
 * error (auth/timeout/connectivity) is logged and returns false too, which for
 * a SPEND preflight is the safe fail-closed direction (refuse, don't spend) —
 * but it is NOT conflated silently (audit R1 M7).
 */
async function relOrColExists(table, col) {
  if (!SAFE_IDENT.test(table) || (col != null && !SAFE_IDENT.test(col))) {
    throw new Error(`relOrColExists: unsafe identifier ${JSON.stringify(col ? `${table}.${col}` : table)}`);
  }
  try {
    await many(`SELECT ${col ? `"${col}"` : '1'} FROM "${table}" LIMIT 0`);
    return true;
  } catch (err) {
    if (err && (err.code === '42703' || err.code === '42P01')) return false; // definitively absent
    process.stderr.write(`  [model-ab] preflight probe ${table}${col ? `.${col}` : ''} inconclusive (${err.code || err.message}) — treating as not-ready\n`);
    return false;
  }
}

// Every column/relation a shadow, spend, or adjudication write TOUCHES — a
// hand-list is inherent to a preflight, but it must be COMPLETE (audit R4 H2):
// missing any of these while the shadow is enabled would let it spend and then
// fail to persist (the very thing decision 13 forbids).
//
// Coverage rationale (audit R5 — overrules "list EVERY column"): each table's
// columns are created by a SINGLE atomic CREATE TABLE in one migration, so a
// REPRESENTATIVE column per relation proves the whole table+its columns exist
// (they cannot partially exist). Listing all ~10 spend-ledger columns adds no
// coverage and is pure churn; a future ALTER-ADD-COLUMN migration that widens a
// table adds its new column to this list at that time.
const REQUIRED_SCHEMA = Object.freeze([
  // findings — attribution (shadow) + adjudication (queue writeback)
  ['audit_findings', 'stage'],
  ['audit_findings', 'source_model'],
  ['audit_findings', 'bucket'],
  ['audit_findings', 'adjudication_outcome'],
  ['audit_findings', 'user_action'],
  // pass stats — per-arm-execution cost/conformance
  ['audit_pass_stats', 'source_model'],
  ['audit_pass_stats', 'stage'],
  ['audit_pass_stats', 'structured_output_ok'],
  ['audit_pass_stats', 'cost_usd'],
  ['audit_pass_stats', 'usage_unmeterable'],
  // runs — arm-set snapshot
  ['audit_runs', 'arm_set_version'],
  // arm config + equivalence + spend ledger (specific load-bearing columns)
  ['audit_arms', 'stages'],
  ['finding_equivalence', 'canonical_finding_id'],
  ['finding_equivalence', 'duplicate_finding_id'],
  ['model_ab_spend_ledger', 'reserved_eur'],
  ['model_ab_spend_ledger', 'status'],
  ['model_ab_spend_ledger', 'reserved_at'],
  // the scorer view
  ['model_ab_effectiveness', null],
]);

/**
 * @returns {Promise<{ready:boolean, cloud:boolean, missing:string[]}>}
 * `ready` is true only when EVERY required column/table/view exists. When cloud
 * is off, `ready:false, cloud:false` — the shadow layer treats off-cloud as a
 * graceful skip (not a hard failure), decision 13's off→degrade path.
 */
export async function modelAbSchemaReady() {
  if (!await isCloudEnabled()) return { ready: false, cloud: false, missing: [] };
  const missing = [];
  for (const [table, col] of REQUIRED_SCHEMA) {
    if (!await relOrColExists(table, col)) missing.push(col ? `${table}.${col}` : table);
  }
  return { ready: missing.length === 0, cloud: true, missing };
}

// ── Arm-set seeding (code stays the source of truth) ─────────────────────────

/**
 * Upsert the canonical arm-set into audit_arms. NOTE (audit R1 H6/M2): the
 * scorer view derives arm membership from the finding `stage` (a CASE
 * expression), NOT from this table — so audit_arms is INFORMATIONAL in v1
 * (versioning / snapshot / human reference), and a row-seed failure does NOT
 * undermine the "no spend without persistence" invariant (that is guaranteed by
 * `modelAbSchemaReady`, which already verified the TABLE exists). Returns a
 * status so the caller can surface partial failures without treating them as
 * fatal.
 * @returns {Promise<{ok:boolean, failed:string[]}>}
 */
export async function ensureArmSet(version = 1) {
  if (!await isCloudEnabled()) return { ok: true, failed: [] };
  const failed = [];
  for (const arm of CANONICAL_ARMS) {
    try {
      // Uses the documented upsert seam (audit R3 M2); `pgArray` opts the
      // stages `text[]` column out of jsonb-serialization so it binds as a real
      // Postgres array (AGENTS.md jsonb-safe write seam).
      const res = await upsert('audit_arms', [{
        arm_set_version: version, arm_id: arm.id, stages: pgArray(stagesForArm(arm)),
        is_baseline: arm.isBaseline, label: arm.label,
      }], { onConflict: ['arm_set_version', 'arm_id'], update: ['stages', 'is_baseline', 'label'] });
      // A 0-row result means the write was silently suppressed (RLS/trigger) —
      // surface it (audit R2 H3), still non-fatal (informational table).
      if ((res.rowCount || 0) === 0) {
        failed.push(arm.id);
        process.stderr.write(`  [model-ab] ensureArmSet(${arm.id}) wrote 0 rows (RLS/trigger?) — informational table, non-fatal\n`);
      }
    } catch (err) {
      failed.push(arm.id);
      process.stderr.write(`  [model-ab] ensureArmSet(${arm.id}) failed (informational table — non-fatal): ${err.message}\n`);
    }
  }
  return { ok: failed.length === 0, failed };
}

// ── Reserve-then-reconcile spend ledger (decision 12) ────────────────────────

// One global advisory-lock key serializes reservation across ALL parallel arms
// so the cumulative cap can't be overshot beyond one in-flight reservation.
const SPEND_LOCK_KEY = 'model_ab_spend';

/** SQL fragment: sum of committed (reconciled) actuals + still-active (non-expired) reservations. */
function activeSpendSql(ttlParamIdx) {
  return `COALESCE(SUM(CASE
            WHEN status = 'reconciled' THEN actual_eur
            WHEN status = 'reserved' AND reserved_at > now() - ($${ttlParamIdx} * interval '1 millisecond') THEN reserved_eur
            ELSE 0 END), 0)`;
}

/**
 * Reserve `reservedEur` against the cumulative cap, atomically across parallel
 * arms. Returns `{ok:true, ledgerId, spentEur}` when admitted, or
 * `{ok:false, reason:'cap-exceeded', spentEur, capEur}` when the reservation
 * would breach the cap (the call must be refused — no spend).
 *
 * @param {{runId?:string, armId?:string, stage?:string, reservedEur:number,
 *          estimated?:boolean, capEur:number|null, activeTtlMs:number}} p
 */
export async function reserveSpend({ runId = null, armId = null, stage = null, reservedEur, estimated = false, capEur, activeTtlMs }) {
  // Fail-CLOSED on a missing/invalid cap (audit R2 H1): a null/NaN cap must NOT
  // read as "unlimited" — the whole point is a hard € ceiling. The caller
  // (audit-shadow) validates budget upstream; this is the reusable-seam backstop.
  if (!Number.isFinite(capEur)) throw new Error(`reserveSpend: capEur must be a finite number (the spend ceiling), got ${capEur}`);
  if (!await isCloudEnabled()) return { ok: true, ledgerId: null, cloud: false };
  if (!(reservedEur >= 0)) throw new Error(`reserveSpend: reservedEur must be ≥ 0, got ${reservedEur}`);
  return withTx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SPEND_LOCK_KEY]);
    const sumRes = await client.query(
      `SELECT ${activeSpendSql(1)} AS spent FROM model_ab_spend_ledger`, [activeTtlMs],
    );
    const spentEur = Number(sumRes.rows[0].spent) || 0;
    if (capEur != null && spentEur + reservedEur > capEur) {
      return { ok: false, reason: 'cap-exceeded', spentEur, capEur };
    }
    const ins = await client.query(
      `INSERT INTO model_ab_spend_ledger (run_id, arm_id, stage, reserved_eur, estimated, status)
       VALUES ($1, $2, $3, $4, $5, 'reserved') RETURNING id`,
      [runId, armId, stage, reservedEur, estimated],
    );
    return { ok: true, ledgerId: ins.rows[0].id, spentEur: spentEur + reservedEur };
  });
}

/**
 * Reconcile a reservation to actual cost. When `unmeterable` (usage was
 * absent/invalid — decision R5 H4), KEEP the reservation amount as actual rather
 * than reconciling DOWN to a possibly-zero measured cost, so an unmetered call
 * never zeroes the burn.
 */
export async function reconcileSpend({ ledgerId, actualEur, unmeterable = false }) {
  if (ledgerId == null || !await isCloudEnabled()) return;
  try {
    await query(
      `UPDATE model_ab_spend_ledger
         SET actual_eur = CASE WHEN $2 THEN reserved_eur ELSE $3 END,
             unmeterable = $2, status = 'reconciled', reconciled_at = now()
       WHERE id = $1 AND status = 'reserved'`,
      [ledgerId, unmeterable, actualEur],
    );
  } catch (err) {
    process.stderr.write(`  [model-ab] reconcileSpend(${ledgerId}) failed: ${err.message}\n`);
  }
}

/**
 * RELEASE a single reservation (audit R2 H2): the call never happened (egress
 * abort, error before spend) so the reservation must be FREED — set to
 * status='released' with actual_eur=0. This is distinct from `reconcileSpend`
 * with `unmeterable:true`, which KEEPS the reserved amount (used when a call DID
 * happen but its usage is unmeterable). Using the wrong one here would leak
 * budget against the € ceiling.
 */
export async function releaseSpend({ ledgerId }) {
  if (ledgerId == null || !await isCloudEnabled()) return;
  try {
    await query(
      `UPDATE model_ab_spend_ledger SET status = 'released', actual_eur = 0, reconciled_at = now()
       WHERE id = $1 AND status = 'reserved'`,
      [ledgerId],
    );
  } catch (err) {
    process.stderr.write(`  [model-ab] releaseSpend(${ledgerId}) failed: ${err.message}\n`);
  }
}

/** Release reservations still 'reserved' past the TTL (orphaned by a killed run). Returns count. */
export async function releaseOrphanedReservations({ ttlMs }) {
  if (!await isCloudEnabled()) return 0;
  try {
    const res = await query(
      `UPDATE model_ab_spend_ledger SET status = 'released'
       WHERE status = 'reserved' AND reserved_at < now() - ($1 * interval '1 millisecond')`,
      [ttlMs],
    );
    return res.rowCount || 0;
  } catch (err) {
    process.stderr.write(`  [model-ab] releaseOrphanedReservations failed: ${err.message}\n`);
    return 0;
  }
}

/** Cumulative euro spend (committed actuals + active reservations) for the cap + CLI. */
export async function cumulativeSpendEur({ activeTtlMs }) {
  if (!await isCloudEnabled()) return null;
  try {
    const row = await one(
      `SELECT ${activeSpendSql(1)} AS spent FROM model_ab_spend_ledger`, [activeTtlMs],
    );
    return Number(row?.spent) || 0;
  } catch {
    return null;
  }
}

// ── Adjudication state machine (R3-H3) ───────────────────────────────────────

/**
 * Follow finding_equivalence chains to the union-find ROOT (cycle-guarded).
 * finding_equivalence is keyed on `finding_fingerprint` GLOBALLY, not per-run
 * (audit R1 H4): a fingerprint is a SEMANTIC content hash, so "same issue" is
 * the same fingerprint across runs — a global canonical mapping is intentional
 * (the plan's `finding_equivalence(canonical, duplicate)` carries no run scope).
 * The disjoint-coverage metric still counts per-run in the view (each finding
 * row carries its own run_id; only the canonical LABEL is shared).
 */
async function resolveCanonicalRoot(fingerprint) {
  let cur = fingerprint;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const row = await one(
      'SELECT canonical_finding_id FROM finding_equivalence WHERE duplicate_finding_id = $1', [cur],
    );
    if (!row) break;
    cur = row.canonical_finding_id;
  }
  return cur;
}

async function setFindingOutcome(runId, fingerprint, outcome, userAction) {
  // Returns rowCount so the caller can detect a 0-row no-op (audit R1 M5) — a
  // fingerprint that matched nothing is a silent adjudication failure. A
  // fingerprint shared across stages legitimately updates >1 row (same issue).
  const res = await query(
    `UPDATE audit_findings SET adjudication_outcome = $3, user_action = $4
     WHERE run_id = $1 AND finding_fingerprint = $2`,
    [runId, fingerprint, outcome, userAction],
  );
  return res.rowCount || 0;
}

const ACTION_MAP = Object.freeze({
  accepted: { outcome: 'accepted', userAction: 'accepted-permanent' },
  dismissed: { outcome: 'dismissed', userAction: 'dismissed' },
  'not-actionable': { outcome: 'dismissed', userAction: 'dismissed' },
});

/**
 * Apply one blinded-queue adjudication action to an arm finding.
 *   accepted            → adjudication_outcome='accepted'
 *   dismissed / not-actionable → 'dismissed'
 *   duplicate           → write finding_equivalence(dup → canonical ROOT) and
 *                         inherit the canonical's outcome (idempotent).
 * @returns {Promise<{ok:boolean, mappedOutcome:string, canonicalRoot?:string}>}
 */
export async function applyModelAbAdjudication({ runId, fingerprint, action, canonicalFingerprint, actor = null }) {
  if (!runId || !fingerprint) throw new Error('applyModelAbAdjudication: runId + fingerprint required');
  if (!await isCloudEnabled()) return { ok: false, cloud: false, mappedOutcome: 'pending' };

  if (action === 'duplicate') {
    if (!canonicalFingerprint) throw new Error("action 'duplicate' requires canonicalFingerprint");
    // ATOMIC (audit R1 H5): resolve-root → write equivalence → inherit outcome →
    // set the dup's outcome must be all-or-nothing (query() joins the active tx
    // via AsyncLocalStorage, so these run on one client).
    return withTx(async () => {
      const root = await resolveCanonicalRoot(canonicalFingerprint);
      if (root === fingerprint) throw new Error('duplicate cannot point at itself (would form a cycle)');
      await query(
        `INSERT INTO finding_equivalence (duplicate_finding_id, canonical_finding_id, run_id, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (duplicate_finding_id)
         DO UPDATE SET canonical_finding_id = EXCLUDED.canonical_finding_id, created_by = EXCLUDED.created_by`,
        [fingerprint, root, runId, actor],
      );
      const canon = await one(
        'SELECT adjudication_outcome FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = $2 LIMIT 1',
        [runId, root],
      );
      const outcome = canon?.adjudication_outcome || 'pending';
      const rows = await setFindingOutcome(runId, fingerprint, outcome, 'dismissed');
      return { ok: true, mappedOutcome: outcome, canonicalRoot: root, rowsUpdated: rows };
    });
  }

  const m = ACTION_MAP[action];
  if (!m) throw new Error(`applyModelAbAdjudication: unknown action "${action}"`);
  const rows = await setFindingOutcome(runId, fingerprint, m.outcome, m.userAction);
  if (rows === 0) process.stderr.write(`  [model-ab] adjudication no-op — no finding for (run ${runId}, fp ${fingerprint})\n`);
  return { ok: true, mappedOutcome: m.outcome, rowsUpdated: rows };
}

/**
 * Blinded adjudication queue: not-yet-labelled ARM findings (stage IS NOT NULL),
 * source_model HIDDEN (blinding sidesteps the human's own model bias), ordered so
 * likely-equivalent findings sit adjacently (category, file) for the `duplicate`
 * action. Read by `cross-skill.mjs model-ab-adjudicate` (Cluster C).
 */
export async function getModelAbAdjudicationQueue({ runId = null, limit = 50 } = {}) {
  if (!await isCloudEnabled()) return { cloud: false, items: [] };
  const params = [Math.max(1, Math.min(500, limit | 0 || 50))];
  let where = "stage IS NOT NULL AND adjudication_outcome IS NULL";
  if (runId) { params.push(runId); where += ` AND run_id = $${params.length}`; }
  try {
    const rows = await many(
      `SELECT run_id, finding_fingerprint, severity, category, primary_file, detail_snapshot, stage
         FROM audit_findings
        WHERE ${where}
        ORDER BY category, primary_file, finding_fingerprint
        LIMIT $1`,
      params,
    );
    // source_model deliberately NOT selected — the queue is BLINDED.
    return { cloud: true, items: rows };
  } catch (err) {
    process.stderr.write(`  [model-ab] getModelAbAdjudicationQueue failed: ${err.message}\n`);
    return { cloud: true, items: [] };
  }
}

/** Read the scorer view rows for a run (or all runs). Cluster-C CLI consumer. */
export async function getModelAbEffectiveness({ runId = null } = {}) {
  if (!await isCloudEnabled()) return { cloud: false, rows: [] };
  try {
    const rows = runId
      ? await many('SELECT * FROM model_ab_effectiveness WHERE run_id = $1 ORDER BY arm, stage', [runId])
      : await many('SELECT * FROM model_ab_effectiveness ORDER BY run_id, arm, stage');
    return { cloud: true, rows };
  } catch (err) {
    process.stderr.write(`  [model-ab] getModelAbEffectiveness failed: ${err.message}\n`);
    return { cloud: true, rows: [] };
  }
}
