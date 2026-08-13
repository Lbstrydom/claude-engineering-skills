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
import { CANONICAL_ARMS, stagesForArm } from '../arm-vocabulary.mjs';

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
  // v2 hybrid attribution + quality input (migration 20260701140000)
  ['audit_findings', 'arm'],
  ['audit_findings', 'is_quick_fix'],
  // pass stats — per-arm-execution cost/conformance
  ['audit_pass_stats', 'source_model'],
  ['audit_pass_stats', 'stage'],
  ['audit_pass_stats', 'structured_output_ok'],
  ['audit_pass_stats', 'cost_usd'],
  ['audit_pass_stats', 'usage_unmeterable'],
  ['audit_pass_stats', 'arm'],           // v2 per-arm cost attribution
  // runs — arm-set snapshot + v2 assignment grain
  ['audit_runs', 'arm_set_version'],
  ['audit_runs', 'assignment_id'],
  ['audit_runs', 'stage_type'],
  // arm config + equivalence + spend ledger (specific load-bearing columns)
  ['audit_arms', 'stages'],
  ['finding_equivalence', 'canonical_finding_id'],
  ['finding_equivalence', 'duplicate_finding_id'],
  ['model_ab_spend_ledger', 'reserved_eur'],
  ['model_ab_spend_ledger', 'status'],
  ['model_ab_spend_ledger', 'reserved_at'],
  // the scorer views (aggregate + v2 finding-grain + cost frontier)
  ['model_ab_effectiveness', null],
  ['model_ab_finding_scores', null],
  ['model_ab_arm_cost', null],
]);

/**
 * The relations this module WRITES. Existence is not permission (audit H3).
 *
 * `relOrColExists` proves a relation is `SELECT`-able, and the invariant it
 * guards is *"no spend without persistence"* — i.e. that the writes will
 * SUCCEED. A role holding SELECT but not INSERT passes every existence probe
 * and then fails at the first write, which is the exact shape the preflight
 * exists to prevent: a green check that cannot fail on the operation it guards.
 *
 * Derived from REQUIRED_SCHEMA rather than hand-listed: a relation with a
 * column is a table this module writes; a `null` column marks a scorer VIEW,
 * which is read-only and must NOT be write-probed.
 */
const WRITTEN_TABLES = Object.freeze([...new Set(
  REQUIRED_SCHEMA.filter(([, col]) => col != null).map(([table]) => table),
)]);

/**
 * Can the runtime role actually write these relations?
 *
 * Uses `has_table_privilege`, which asks the catalog rather than attempting a
 * write — no test row, no transaction to roll back, and it answers for the
 * CURRENT role, which is the one that will do the writing. A privilege the role
 * lacks is definitive; an error here is inconclusive and, like `relOrColExists`,
 * fails CLOSED (refuse to spend).
 *
 * @param {string[]} tables
 * @returns {Promise<string[]>} `"table.PRIVILEGE"` for each missing grant
 */
async function missingWritePrivileges(tables) {
  const missing = [];
  for (const table of tables) {
    if (!SAFE_IDENT.test(table)) throw new Error(`missingWritePrivileges: unsafe identifier ${JSON.stringify(table)}`);
    try {
      const rows = await many(
        'SELECT has_table_privilege($1, \'INSERT\') AS ins, has_table_privilege($1, \'UPDATE\') AS upd',
        [table],
      );
      const r = rows?.[0];
      if (!r) { missing.push(`${table}.PRIVILEGE_UNKNOWN`); continue; }
      if (r.ins !== true) missing.push(`${table}.INSERT`);
      if (r.upd !== true) missing.push(`${table}.UPDATE`);
    } catch (err) {
      process.stderr.write(`  [model-ab] write-privilege probe ${table} inconclusive (${err.code || err.message}) — treating as not-ready\n`);
      missing.push(`${table}.PRIVILEGE_UNKNOWN`);
    }
  }
  return missing;
}

/**
 * @returns {Promise<{ready:boolean, cloud:boolean, missing:string[]}>}
 * `ready` is true only when EVERY required column/table/view exists **and the
 * runtime role can INSERT/UPDATE every relation this module writes** (audit H3
 * — existence is not permission). When cloud is off, `ready:false, cloud:false`
 * — the shadow layer treats off-cloud as a graceful skip (not a hard failure),
 * decision 13's off→degrade path.
 */
export async function modelAbSchemaReady() {
  if (!await isCloudEnabled()) return { ready: false, cloud: false, missing: [] };
  const missing = [];
  for (const [table, col] of REQUIRED_SCHEMA) {
    if (!await relOrColExists(table, col)) missing.push(col ? `${table}.${col}` : table);
  }
  // Only probe privileges on relations we established exist — a missing table
  // is already reported, and has_table_privilege would just error on it.
  const present = WRITTEN_TABLES.filter(t => !missing.includes(t) && !missing.some(m => m.startsWith(`${t}.`)));
  missing.push(...await missingWritePrivileges(present));
  return { ready: missing.length === 0, cloud: true, missing };
}

// ── Arm-set seeding (code stays the source of truth) ─────────────────────────

/**
 * Upsert the canonical arm-set into audit_arms. NOTE: the scorer views derive
 * arm membership via the hybrid `model_ab_attribute_arms(stage, arm)` SQL
 * function (v2 — explicit arm for arm-specific stages, else stage-derived), NOT
 * from this table — so audit_arms is INFORMATIONAL (versioning / snapshot /
 * human reference), and a row-seed failure does NOT undermine the "no spend
 * without persistence" invariant (guaranteed by `modelAbSchemaReady`, which
 * verified the TABLE exists). Defaults to arm-set version 2 (the v2 compositions,
 * mirroring CANONICAL_ARMS). Returns a status so the caller can surface partial
 * failures without treating them as fatal.
 * @returns {Promise<{ok:boolean, failed:string[]}>}
 */
export async function ensureArmSet(version = 2) {
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

/** SQL fragment: sum of committed (reconciled) actuals + still-active (non-expired) reservations.
 * Belt-and-suspenders on the SAFETY-critical spend cap (audit R3 a43db413): a
 * reconciled row ALWAYS has a non-null actual_eur via reconcileSpend's CASE, but
 * a NULL there would make SUM SKIP it → UNDER-count spend → allow over-budget.
 * COALESCE to reserved_eur so an (impossible-in-code) null reconciliation still
 * charges the reservation, never €0 — fail-closed toward the ceiling. */
function activeSpendSql(ttlParamIdx) {
  return `COALESCE(SUM(CASE
            WHEN status = 'reconciled' THEN COALESCE(actual_eur, reserved_eur)
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
  // Validate the TTL window at the boundary (audit R1 abb590b6/43be2c13): it is
  // interpolated into the active-spend SQL (`$ttl * interval '1 millisecond'`), so
  // a non-finite/negative/zero value would corrupt the budget-window accounting.
  // Fail-closed like capEur (before the cloud check → validated even off-cloud).
  if (!Number.isFinite(activeTtlMs) || activeTtlMs <= 0) {
    throw new Error(`reserveSpend: activeTtlMs must be a finite positive duration in ms, got ${activeTtlMs}`);
  }
  if (!await isCloudEnabled()) return { ok: true, ledgerId: null, cloud: false };
  if (!(reservedEur >= 0)) throw new Error(`reserveSpend: reservedEur must be ≥ 0, got ${reservedEur}`);
  return withTx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SPEND_LOCK_KEY]);
    // `activeSpendSql` counts a `reserved` row only while it is younger than the
    // TTL — so a reservation that outlives the window silently contributes ZERO
    // to the cap while its operation may still be running and still spending
    // (audit H2). The TTL is bound to no execution deadline: it defaults to 30
    // minutes while a single call may take `callTimeoutMs` (5 min) and a run
    // makes many, so a long run can drop out of its own ceiling.
    //
    // The system already has an EXPLICIT reclamation path
    // (`releaseOrphanedReservations`, run at shadow startup), which means a row
    // that is still `reserved` past the TTL is in an *undefined* state, not a
    // reclaimed one. Counting it as zero is the silent part, so: surface it and
    // fail CLOSED. This never blocks the healthy path — the next startup
    // releases orphans — and it makes an under-count impossible to hit quietly.
    const staleRes = await client.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(reserved_eur), 0) AS eur
         FROM model_ab_spend_ledger
        WHERE status = 'reserved'
          AND reserved_at <= now() - ($1 * interval '1 millisecond')`,
      [activeTtlMs],
    );
    const staleCount = Number(staleRes.rows[0].n) || 0;
    if (staleCount > 0) {
      const staleEur = Number(staleRes.rows[0].eur) || 0;
      return {
        ok: false,
        reason: 'stale-reservations',
        staleCount,
        staleEur,
        capEur,
        hint: `${staleCount} reservation(s) worth €${staleEur.toFixed(2)} are past the ${activeTtlMs}ms TTL but still 'reserved'. `
          + 'They contribute 0 to the cap, so admitting more spend now could breach it. '
          + 'Release them (releaseOrphanedReservations) or reconcile them, then retry.',
      };
    }
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
  // decided_at = NOW() (model-swap-eval-harness Phase 4 migration
  // 20260713110000) — this blinded-queue path is the PRIMARY way model-ab
  // findings get adjudicated; without stamping it here, getAdjudicatorGroundTruth's
  // sinceDecidedAt window would silently exclude nearly all real ground truth.
  const res = await query(
    `UPDATE audit_findings SET adjudication_outcome = $3, user_action = $4, decided_at = NOW()
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

/** Read the aggregate scorer view rows for a run (or all runs). CLI consumer. */
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

/**
 * Read the v2 FINDING-grain scorer input (one row per finding × attributed arm)
 * — the raw input the two-level decision rule folds into (assignment × canonical
 * cluster) units. Optionally scoped to a run. Cloud-off → graceful empty.
 */
export async function getModelAbFindingScores({ runId = null } = {}) {
  if (!await isCloudEnabled()) return { cloud: false, rows: [] };
  try {
    const rows = runId
      ? await many('SELECT * FROM model_ab_finding_scores WHERE run_id = $1', [runId])
      : await many('SELECT * FROM model_ab_finding_scores');
    return { cloud: true, rows };
  } catch (err) {
    process.stderr.write(`  [model-ab] getModelAbFindingScores failed: ${err.message}\n`);
    return { cloud: true, rows: [] };
  }
}

/**
 * Read the v2 per-(assignment × arm) STANDALONE cost + conformance rows (the
 * cost-frontier + conformance-gate input). Optionally scoped to an assignment.
 * Cloud-off → graceful empty.
 */
export async function getModelAbArmCost({ assignmentId = null } = {}) {
  if (!await isCloudEnabled()) return { cloud: false, rows: [] };
  try {
    const rows = assignmentId
      ? await many('SELECT * FROM model_ab_arm_cost WHERE assignment_id = $1', [assignmentId])
      : await many('SELECT * FROM model_ab_arm_cost');
    return { cloud: true, rows };
  } catch (err) {
    process.stderr.write(`  [model-ab] getModelAbArmCost failed: ${err.message}\n`);
    return { cloud: true, rows: [] };
  }
}

// ── Adjudicator ground truth (model-swap-eval-harness Phase 4) ─────────────
//
// Reads audit_findings JOIN audit_runs DIRECTLY — NOT the model_ab_finding_scores
// VIEW the plan originally proposed indexing/querying. Verified directly: that
// view is a plain CREATE OR REPLACE VIEW (not materialized, cannot carry an
// index) and its own SELECT list doesn't even expose decided_at/finding_id/
// repo_id. This queries the view's real underlying source instead, with the
// SAME repo-scoping join runs-findings.mjs's getRecentFindingsByRepo/
// getFinalReviewStats already establish (r.repo_id = $1).
//
// No ledger-file join — adjudication_outcome ('accepted'|'dismissed') is
// already a persistent SQL column on audit_findings; ledger.mjs is ephemeral
// per-session file-based scratch state, not a durable queryable corpus.

const DEFAULT_GROUND_TRUTH_WINDOW_DAYS = 180;
const GROUND_TRUTH_LIMIT_DEFAULT = 200;
const GROUND_TRUTH_LIMIT_MAX = 1000;

/**
 * Versioned, deduplicated, windowed adjudicator ground truth. Dedup happens
 * BEFORE pagination, at the SQL level (round-4 audit M4): DISTINCT ON
 * (finding_fingerprint) picks the most-recently-decided row per fingerprint
 * inside the CTE, THEN the outer query orders/paginates the already-deduped
 * set — never a page containing fewer logical rows than requested, never an
 * unstable result across duplicate fingerprints straddling a page boundary.
 *
 * `sinceDecidedAt` defaults to a 180-day window (an adjudicator's ground
 * truth should reflect its RECENT accuracy, not stale multi-year history);
 * pass `null` explicitly for the full unbounded history. Rows with a NULL
 * decided_at (adjudicated before this column existed, or never re-decided
 * since) are excluded unconditionally — they have no timestamp to prove
 * recency, and an undated row silently entering "recent ground truth" would
 * corrupt exactly the property this window exists to guarantee.
 *
 * `category`/`primaryFile`/`detailSnapshot` are included so a caller
 * (model-eval-adjudicator.mjs, Phase 4) can build a real `findingText` for
 * structured T/F extraction — the row alone (fingerprint/severity) isn't
 * enough context for a candidate to classify against.
 *
 * @param {{repoId: string, limit?: number, cursor?: {decidedAt: string, findingId: string}|null, sinceDecidedAt?: string|null}} args
 * @returns {Promise<{cloud: boolean, rows: Array<{repoId, runId, findingId, findingFingerprint, sourceModel, severity, category, primaryFile, detailSnapshot, humanLabel: 'true_positive'|'false_positive', adjudicationOutcome, decidedAt}>}>}
 */
export async function getAdjudicatorGroundTruth({ repoId, limit = GROUND_TRUTH_LIMIT_DEFAULT, cursor = null, sinceDecidedAt = 'default' } = {}) {
  if (!repoId) throw new Error('getAdjudicatorGroundTruth: repoId is required');
  if (!await isCloudEnabled()) return { cloud: false, rows: [] };
  const boundedLimit = Math.min(Math.max(1, limit), GROUND_TRUTH_LIMIT_MAX);

  // 'default' sentinel (not undefined) so an explicit null is distinguishable
  // from "caller didn't pass this option at all" — both are legal, but only
  // the former means "give me the full unbounded history."
  const windowClause = [];
  const params = [repoId];
  if (sinceDecidedAt !== null) {
    const since = sinceDecidedAt === 'default'
      ? new Date(Date.now() - DEFAULT_GROUND_TRUTH_WINDOW_DAYS * 24 * 60 * 60 * 1000)
      : new Date(sinceDecidedAt);
    params.push(since);
    windowClause.push(`AND f.decided_at >= $${params.length}`);
  }

  const cursorClause = [];
  if (cursor) {
    params.push(cursor.decidedAt, cursor.findingId);
    cursorClause.push(`AND (decided_at, finding_id) < ($${params.length - 1}, $${params.length})`);
  }

  params.push(boundedLimit);
  const limitParamIdx = params.length;

  try {
    const rows = await many(
      `WITH deduped AS (
         SELECT DISTINCT ON (f.finding_fingerprint)
           r.repo_id, f.run_id, f.id AS finding_id, f.finding_fingerprint,
           f.source_model, f.severity, f.category, f.primary_file, f.detail_snapshot,
           f.adjudication_outcome, f.decided_at
         FROM audit_findings f
         JOIN audit_runs r ON r.id = f.run_id
         WHERE r.repo_id = $1
           AND f.adjudication_outcome IN ('accepted', 'dismissed')
           AND f.decided_at IS NOT NULL
           ${windowClause.join(' ')}
         ORDER BY f.finding_fingerprint, f.decided_at DESC, f.id
       )
       SELECT * FROM deduped
       WHERE true ${cursorClause.join(' ')}
       ORDER BY decided_at DESC, finding_id
       LIMIT $${limitParamIdx}`,
      params,
    );
    return {
      cloud: true,
      rows: rows.map((r) => ({
        repoId: r.repo_id, runId: r.run_id, findingId: r.finding_id, findingFingerprint: r.finding_fingerprint,
        sourceModel: r.source_model, severity: r.severity,
        category: r.category, primaryFile: r.primary_file, detailSnapshot: r.detail_snapshot,
        humanLabel: r.adjudication_outcome === 'accepted' ? 'true_positive' : 'false_positive',
        adjudicationOutcome: r.adjudication_outcome, decidedAt: r.decided_at,
      })),
    };
  } catch (err) {
    process.stderr.write(`  [model-ab] getAdjudicatorGroundTruth failed: ${err.message}\n`);
    return { cloud: true, rows: [] };
  }
}
