/**
 * @fileoverview Cross-skill data-loop domain — plans, regression specs,
 * persona↔audit correlations, plan verification, ship events.
 *
 * Part of the postgres-parity M3 split. 13 functions covering the
 * plans / ux-lock / persona-correlation / ship feedback loop (migration
 * 20260419120000_cross_skill_data_loop.sql + 20260419130000_plan_verify.sql).
 *
 * @module scripts/lib/store/plans-ship
 */

import path from 'node:path';
import { many, one, insertReturning, upsert, updateWhere, deleteWhere, withTx } from '../db/query.mjs';
import { getPool } from '../db/client.mjs';
import { isCloudEnabled } from './repo.mjs';
// Imported, never re-declared — `plan-status.mjs` is the single source of
// truth for the vocabulary and for the markdown↔store spelling reconciliation.
// Not re-exported: the `learning-store.mjs` barrel is a functions-only surface.
// Import the status vocabulary from shared-lib, NOT from plan-status.mjs (plan
// domain) — a `stores → plan` edge is not in allowedDeps. status-vocabulary.mjs
// is the single definition; both this store and the plan-domain parser import
// it. See status-vocabulary.mjs for why the shared contract lives there.
import { DB_PLAN_STATUSES, toDbPlanStatus } from '../status-vocabulary.mjs';
import { PERSONA_FINDING_HASH_VERSION, PERSONA_FINDING_HASH_SHAPE } from '../persona/audit-correlator.mjs';

// ── plans ──────────────────────────────────────────────────────────────────

/**
 * Validate + normalise a plan path before it becomes a durable identifier.
 *
 * Added 2026-07-20 after an audit of the live store found three non-plans
 * registered in `plans`: the literal string `--help` (an unconsumed CLI flag
 * that `upsert-plan` accepted as a path) and two absolute session-scratchpad
 * paths under AppData/Temp that no longer exist. Nothing read them, but
 * `plans` is the join target for `audit_runs.plan_id`, so junk rows quietly
 * degrade every effectiveness query built over it.
 *
 * Lexical only — deliberately no `realpathSync`. Registering a path is not
 * egress (no content is read or sent), so the symlink-resolution that
 * `requirements/extract.mjs` needs for `--files` would be cost without a
 * threat here. Containment is still enforced, which is what rejects the
 * scratchpad paths.
 *
 * Normalising to a repo-relative POSIX path also closes a latent idempotence
 * hole: `plans` is unique on `(repo_id, path)`, so the same plan referenced
 * once absolutely and once relatively used to INSERT two rows rather than
 * update one.
 *
 * @param {string} rawPath
 * @param {{repoRoot?: string}} [opts]
 * @returns {{ok:true, path:string}
 *          |{ok:false, reason:'empty'|'flag-like'|'not-markdown'|'escapes-repo', message:string}}
 */
export function validatePlanPath(rawPath, opts = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { ok: false, reason: 'empty', message: 'plan path is empty' };
  }
  const raw = rawPath.trim();

  // A leading `-` is an unconsumed CLI flag, never a path. This is precisely
  // how `--help` became a plan row.
  if (raw.startsWith('-')) {
    return {
      ok: false, reason: 'flag-like',
      message: `refusing a flag-like plan path (unconsumed CLI argument?): ${raw}`,
    };
  }
  if (!/\.md$/i.test(raw)) {
    return {
      ok: false, reason: 'not-markdown',
      message: `refusing a plan path that is not a .md document: ${raw}`,
    };
  }

  const root = path.resolve(opts.repoRoot ?? process.cwd());
  const abs = path.resolve(root, raw);
  // Windows drive-letter and path casing vary between callers (`C:/GIT/...`
  // vs `c:/git/...`), so containment compares case-insensitively there. The
  // RETURNED path is still derived from the real resolve, never the lowered
  // copy — we normalise the comparison, not the data.
  const ci = process.platform === 'win32';
  const cmp = (s) => (ci ? s.toLowerCase() : s);
  if (cmp(abs) !== cmp(root) && !cmp(abs).startsWith(cmp(root) + path.sep)) {
    return {
      ok: false, reason: 'escapes-repo',
      message: `refusing a plan path outside the repo root (scratchpad or temp file?): ${raw}`,
    };
  }

  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (!rel) {
    return { ok: false, reason: 'escapes-repo', message: `plan path resolves to the repo root itself: ${raw}` };
  }
  return { ok: true, path: rel };
}

/**
 * Upsert a plan artefact. Returns the plan UUID so audit_runs can link.
 * Idempotent on `(repo_id, path)`.
 */
export async function upsertPlan(repoId, plan) {
  if (!plan?.path || !plan?.skill) return null;
  if (!await isCloudEnabled()) return null;
  // Validated HERE rather than at the CLI boundary because `upsertPlan` is the
  // real chokepoint — three callers reach it (cross-skill.mjs, the code-audit
  // path in legacy-production-audit.mjs, and plan-audit-cloud.mjs), and two of
  // those pass a user-supplied `--plan` argument straight through. Guarding
  // only the CLI would have left the audit paths open, which is where the
  // scratchpad rows most likely entered.
  //
  // Returns null rather than throwing: every caller already treats a null plan
  // id as "no plan linkage" and continues, so a bad path costs the link, never
  // the audit. The warning is what makes it non-silent.
  const validated = validatePlanPath(plan.path);
  if (!validated.ok) {
    process.stderr.write(`  [learning] upsertPlan: ${validated.message}\n`);
    return null;
  }
  if (!repoId) {
    // Idempotence is claimed on (repo_id, path), a FULL unique index. A NULL
    // repo_id is distinct from every other NULL in Postgres, so a null here
    // INSERTs a duplicate plan row on every call instead of updating — same
    // defect class as recordRegressionSpec's repoId guard. Refuse.
    process.stderr.write('  [learning] upsertPlan: requires a resolved repoId (NULL would duplicate on the (repo_id, path) unique index)\n');
    return null;
  }
  try {
    // The `|| null` below is defensive residue that reads as nullable to the lint;
    // the early return above makes it unreachable. Left in place rather than dropped
    // so the column's real DB nullability stays honest at the call site.
    // @on-conflict-ok: repoId is provably non-null — the early return above rejects a falsy repoId, naming this exact defect class; detecting that needs flow analysis.
    const rows = await upsert('plans', [{
      repo_id: repoId || null,
      path: validated.path,   // repo-relative POSIX — see validatePlanPath
      skill: plan.skill,
      status: plan.status || 'draft',
      principles_cited: plan.principlesCited || [],   // jsonb — serialized by the db-layer seam
      focus_areas: plan.focusAreas || [],
      commit_sha: plan.commitSha || null,
      checksum: plan.checksum || null,
      updated_at: new Date().toISOString(),
    }], { onConflict: ['repo_id', 'path'], update: 'all', returning: ['id'] });
    return rows[0]?.id ?? null;
  } catch (err) {
    process.stderr.write(`  [learning] upsertPlan failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Resolve a plan UUID from its path, so a human can mark a plan terminal by
 * the name they actually know it by rather than by hunting a UUID.
 *
 * Applies the same normalisation `upsertPlan` writes through, so a lookup by
 * `docs/plans/<name>.md` matches a row registered from an absolute path.
 *
 * @returns {Promise<{ok:true, planId:string, path:string}
 *                  |{ok:false, reason:'invalid-path'|'not-found'|'cloud-off', message:string}>}
 */
export async function getPlanIdByPath(repoId, rawPath) {
  const validated = validatePlanPath(rawPath);
  if (!validated.ok) return { ok: false, reason: 'invalid-path', message: validated.message };
  if (!await isCloudEnabled()) return { ok: false, reason: 'cloud-off', message: 'cloud store is disabled' };
  if (!repoId) return { ok: false, reason: 'not-found', message: 'no resolved repoId — cannot scope a plan lookup' };
  try {
    const row = await one(
      'SELECT id, path FROM plans WHERE repo_id = $1 AND path = $2',
      [repoId, validated.path],
    );
    if (!row) {
      return {
        ok: false, reason: 'not-found',
        message: `no plan registered at ${validated.path} for this repo — run the /plan flow first, or check the path`,
      };
    }
    return { ok: true, planId: row.id, path: row.path };
  } catch (err) {
    return { ok: false, reason: 'not-found', message: `plan lookup failed: ${err.message}` };
  }
}

/** Update a plan's status. Returns { ok, rowCount }. */
export async function updatePlanStatus(planId, status) {
  if (!planId || !await isCloudEnabled()) return { ok: false, rowCount: 0 };
  // Accept the MARKDOWN spelling of the same token, not just the DB one.
  // `skills/plan/SKILL.md` instructs `Draft | Approved | In Progress |
  // Complete` while the CHECK constraint stores `in_progress` etc., so a human
  // following our own docs types `Complete` and would otherwise be rejected for
  // a difference in casing convention between two surfaces — not a real
  // disagreement about the value. Same vocabulary, one spelling normaliser.
  const normalised = toDbPlanStatus(status);

  // Reject an out-of-vocabulary status BEFORE the write. The CHECK constraint
  // would catch it anyway, but as an opaque `23514` the caller cannot act on —
  // and the whole point of this path is that a human types the status by hand.
  if (!DB_PLAN_STATUSES.includes(normalised)) {
    process.stderr.write(
      `  [learning] updatePlanStatus: '${status}' is not a valid status (expected one of: ${DB_PLAN_STATUSES.join(', ')})\n`,
    );
    return { ok: false, rowCount: 0 };
  }
  try {
    const { rowCount } = await updateWhere('plans',
      { status: normalised, updated_at: new Date().toISOString() },
      { id: planId }
    );
    // A 0-row update means the planId matched nothing (stale id, or an RLS
    // policy silently filtered the row) — surface it rather than reporting a
    // phantom success the caller can't distinguish from a real write.
    if (rowCount === 0) {
      process.stderr.write(`  [learning] updatePlanStatus: no row updated for planId=${planId} (stale id or RLS)\n`);
    }
    return { ok: rowCount > 0, rowCount };
  } catch (err) {
    process.stderr.write(`  [learning] updatePlanStatus failed: ${err.message}\n`);
    return { ok: false, rowCount: 0 };
  }
}

// ── regression_specs ───────────────────────────────────────────────────────

/**
 * Record a regression spec authored by /ux-lock. Handles three source-kinds:
 *   - 'persona-consistency-candidate' — upserts by (repo_id, candidate_fingerprint)
 *   - 'persona-consistency-locked'    — upserts by (repo_id, spec_path)
 *   - everything else                  — upserts by (repo_id, spec_path)
 *
 * Pre-egress redaction applies to the three JSONB columns (witness_snapshot,
 * contradiction_payload, journey_context) for both candidate + locked rows
 * (Gemini-R6-G3).
 */
export async function recordRegressionSpec(repoId, spec) {
  if (!await isCloudEnabled()) return null;
  if (!spec?.sourceKind) return null;
  const isCandidate = spec.sourceKind === 'persona-consistency-candidate';
  const isLocked    = spec.sourceKind === 'persona-consistency-locked';

  if (isCandidate) {
    if (!spec.candidateFingerprint || !spec.witnessSnapshot || !spec.contradictionPayload || !spec.journeyContext) {
      process.stderr.write('  [learning] recordRegressionSpec: candidate rows require candidateFingerprint, witnessSnapshot, contradictionPayload, journeyContext\n');
      return null;
    }
    if (!repoId) {
      process.stderr.write('  [learning] recordRegressionSpec: candidate rows require resolved repoId (NULL would silently allow duplicates through the partial unique index)\n');
      return null;
    }
  } else {
    if (!spec.specPath) {
      process.stderr.write('  [learning] recordRegressionSpec: spec_path is required for non-candidate source_kind\n');
      return null;
    }
    if (!repoId) {
      // The (repo_id, spec_path) unique constraint is a FULL index; a NULL
      // repo_id is distinct from every other NULL in Postgres, so the upsert
      // would silently INSERT a duplicate on every re-run instead of updating.
      // Mirror the candidate branch: refuse rather than accrue dupes.
      process.stderr.write('  [learning] recordRegressionSpec: non-candidate rows require a resolved repoId (NULL would duplicate on the (repo_id, spec_path) unique index)\n');
      return null;
    }
  }
  if (!spec.description) return null;

  let redactionCount = 0;
  let witnessSnapshot      = null;
  let contradictionPayload = null;
  let journeyContext       = null;
  if (isCandidate || isLocked) {
    try {
      const { redactObject } = await import('../redact.mjs');
      const w = redactObject(spec.witnessSnapshot ?? null);
      const c = redactObject(spec.contradictionPayload ?? null);
      const j = redactObject(spec.journeyContext ?? null);
      witnessSnapshot      = w.redacted;
      contradictionPayload = c.redacted;
      journeyContext       = j.redacted;
      redactionCount = w.count + c.count + j.count;
    } catch (err) {
      process.stderr.write(`  [learning] recordRegressionSpec: redact failed (${err.message})\n`);
      return null;
    }
  }

  const row = {
    repo_id: repoId || null,
    spec_path: spec.specPath ?? null,
    description: spec.description,
    commit_sha: spec.commitSha || null,
    assertion_count: spec.assertionCount || 0,
    dom_contract_types: spec.domContractTypes || [], // jsonb — serialized by the db-layer seam
    source_kind: spec.sourceKind,
    source_finding_id: spec.sourceFindingId || null,
    source_finding_type: spec.sourceFindingType || null,
    candidate_fingerprint: spec.candidateFingerprint || null,
    witness_snapshot: witnessSnapshot,
    contradiction_payload: contradictionPayload,
    journey_context: journeyContext,
    redaction_count: redactionCount,
    updated_at: new Date().toISOString(),
  };
  // WS-C3 manual review (2026-07-19) — the lint reports this target as
  // `unresolved-conflict-target` because the ternary is not statically
  // readable. Reviewed by hand and CORRECT on both branches:
  //   - candidate     → (repo_id, candidate_fingerprint), arbitrated by the
  //     partial index via the `conflictWhere` below;
  //   - non-candidate → (repo_id, spec_path), a full unique constraint.
  // `repo_id` is provably non-null on BOTH paths — each branch above returns
  // early on a falsy repoId, naming the duplicate-row consequence. No scope
  // column is stored-but-omitted. Left dynamic: collapsing it to a literal
  // would need two upsert call sites for one logical write.
  const onConflict = isCandidate ? ['repo_id', 'candidate_fingerprint'] : ['repo_id', 'spec_path'];
  // The candidate arbiter is a PARTIAL unique index
  // (idx_regression_specs_candidate_fingerprint, migration 20260520120000);
  // Postgres can only infer it as the ON CONFLICT arbiter when the statement
  // carries a WHERE matching the index predicate. Without this the upsert
  // raises 42P10 on every candidate write. The (repo_id, spec_path) arbiter
  // for non-candidate rows is a full constraint and needs no predicate.
  const conflictWhere = isCandidate
    ? "candidate_fingerprint IS NOT NULL AND source_kind = 'persona-consistency-candidate' AND repo_id IS NOT NULL"
    : undefined;
  try {
    const rows = await upsert('regression_specs', [row], {
      onConflict, conflictWhere, update: 'all', returning: ['id'],
    });
    return rows[0]?.id ?? null;
  } catch (err) {
    process.stderr.write(`  [learning] recordRegressionSpec failed: ${err.message}\n`);
    return null;
  }
}

/**
 * List pending consistency candidates for a repo. Used by /ship at promotion.
 */
export async function listConsistencyCandidates(repoId, opts = {}) {
  if (!repoId || !await isCloudEnabled()) return [];
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 100;
  try {
    if (opts.sinceTs) {
      return await many(
        `SELECT id, candidate_fingerprint, witness_snapshot, contradiction_payload,
                journey_context, redaction_count, description, commit_sha, created_at
           FROM regression_specs
          WHERE repo_id = $1
            AND source_kind = 'persona-consistency-candidate'
            AND created_at >= $2
          ORDER BY created_at DESC
          LIMIT $3`,
        [repoId, opts.sinceTs, limit]
      );
    }
    return await many(
      `SELECT id, candidate_fingerprint, witness_snapshot, contradiction_payload,
              journey_context, redaction_count, description, commit_sha, created_at
         FROM regression_specs
        WHERE repo_id = $1
          AND source_kind = 'persona-consistency-candidate'
        ORDER BY created_at DESC
        LIMIT $2`,
      [repoId, limit]
    );
  } catch (err) {
    process.stderr.write(`  [learning] listConsistencyCandidates failed: ${err.message}\n`);
    return [];
  }
}

/**
 * Promote a candidate spec row to locked. Atomic update + records
 * spec_path + promoter identity. Optional belt-and-braces re-check on
 * candidate_fingerprint.
 */
export async function promoteRegressionSpec(specId, args) {
  if (!await isCloudEnabled()) return { ok: false, rowsAffected: 0 };
  if (!specId || !args?.specPath || !args?.promotedBy) {
    return { ok: false, rowsAffected: 0 };
  }
  try {
    const pool = await getPool();
    if (!pool) return { ok: false, rowsAffected: 0 };
    const params = [
      args.specPath,
      new Date().toISOString(),
      args.promotedBy,
      specId,
    ];
    let whereExtra = '';
    if (args.candidateFingerprint) {
      params.push(args.candidateFingerprint);
      whereExtra = ` AND candidate_fingerprint = $${params.length}`;
    }
    const res = await pool.query(
      `UPDATE regression_specs
          SET source_kind = 'persona-consistency-locked',
              spec_path = $1,
              promoted_at = $2,
              promoted_by = $3,
              updated_at = $2
        WHERE id = $4
          AND source_kind = 'persona-consistency-candidate'
          ${whereExtra}`,
      params
    );
    return { ok: (res.rowCount || 0) > 0, rowsAffected: res.rowCount || 0 };
  } catch (err) {
    process.stderr.write(`  [learning] promoteRegressionSpec failed: ${err.message}\n`);
    return { ok: false, rowsAffected: 0 };
  }
}

/**
 * Insert a run row that may carry the optional `selector_policy_violations`
 * column (migration 20260703200000). EXACTLY undefined_column (42703) on a row
 * that carries the column → the consumer DB predates the migration: retry ONCE
 * without the field so the run row itself isn't lost, with a single warning
 * naming the pending migration. Any OTHER error propagates to the caller's
 * existing handling — never a broader swallow (db-write-seam rule).
 *
 * `insertFn` is injectable for tests (defaults to the real insertReturning).
 */
export async function insertRunRowWithPolicyFallback(table, row, opts = undefined, insertFn = insertReturning) {
  try {
    return await insertFn(table, row, opts);
  } catch (err) {
    if (err?.code === '42703' && 'selector_policy_violations' in row) {
      process.stderr.write(`  [learning] ${table}.selector_policy_violations missing — run setup-postgres --migrate; recording without it\n`);
      const { selector_policy_violations: _dropped, ...rest } = row;
      return await insertFn(table, rest, opts);
    }
    throw err;
  }
}

/** Append a run outcome for a regression spec. */
export async function recordRegressionSpecRun(specId, run) {
  if (!specId || !await isCloudEnabled()) return;
  const row = {
    spec_id: specId,
    commit_sha: run.commitSha || null,
    passed: !!run.passed,
    captured_regression: !!run.capturedRegression,
    duration_ms: run.durationMs || null,
    error_message: run.errorMessage || null,
    run_context: run.runContext || null,
  };
  // Optional selector-policy telemetry (plan: ux-lock-selector-policy).
  if (run.selectorPolicyViolations != null) row.selector_policy_violations = run.selectorPolicyViolations;
  try {
    await insertRunRowWithPolicyFallback('regression_spec_runs', row);
  } catch (err) {
    process.stderr.write(`  [learning] recordRegressionSpecRun failed: ${err.message}\n`);
  }
}

/**
 * Recent fixes lacking a regression spec (from the `unlocked_fixes` view).
 * Optionally scoped to a repo.
 */
export async function getUnlockedFixes(repoId) {
  if (!await isCloudEnabled()) return [];
  try {
    if (repoId) {
      return await many(
        `SELECT * FROM unlocked_fixes WHERE repo_id = $1 LIMIT 20`,
        [repoId]
      );
    }
    return await many(`SELECT * FROM unlocked_fixes LIMIT 20`);
  } catch (err) {
    process.stderr.write(`  [learning] getUnlockedFixes failed: ${err.message}\n`);
    return [];
  }
}

/**
 * How many unlocked fixes exist, split by run mode — the denominator
 * `getUnlockedFixes` cannot report.
 *
 * That function caps at `LIMIT 20`, so a caller counting its rows cannot tell
 * 20 obligations from 232. On 2026-07-29 the real total WAS 232 and /ship had
 * been reporting "20" — an undercount by an order of magnitude, in a nudge
 * whose entire job is to convey scale.
 *
 * `plan` rows are counted separately rather than hidden: a plan finding can
 * never have a `regression_specs` row (there is no code artifact to lock), so
 * it is a permanent non-obligation. Reporting one number that silently mixes
 * the two is how half a backlog reads as real work.
 *
 * Same failure contract as its sibling — cloud-off and query failure both
 * return zeroed counts, because this feeds a non-blocking nudge and must never
 * break a push.
 *
 * @param {string|null} [repoId]
 * @returns {Promise<{total:number, code:number, plan:number}>}
 */
export async function countUnlockedFixes(repoId) {
  const empty = { total: 0, code: 0, plan: 0 };
  if (!await isCloudEnabled()) return empty;
  try {
    const rows = repoId
      ? await many(`SELECT audit_mode, count(*)::int AS n FROM unlocked_fixes WHERE repo_id = $1 GROUP BY audit_mode`, [repoId])
      : await many(`SELECT audit_mode, count(*)::int AS n FROM unlocked_fixes GROUP BY audit_mode`);
    return rows.reduce((acc, r) => {
      const n = Number(r.n) || 0;
      acc.total += n;
      if (r.audit_mode === 'code') acc.code += n;
      else if (r.audit_mode === 'plan') acc.plan += n;
      return acc;
    }, { ...empty });
  } catch (err) {
    process.stderr.write(`  [learning] countUnlockedFixes failed: ${err.message}
`);
    return empty;
  }
}

/**
 * Accepted findings that never got a remediation transition (from the
 * `unremediated_acceptances` view). Optionally scoped to a repo.
 *
 * Companion to `getUnlockedFixes`, one step earlier in the lifecycle:
 * `unlocked_fixes` asks "this was fixed — is the fix locked?", this asks
 * "this was accepted — was it ever fixed at all?". Measured 2026-07-27, only
 * 3 of 10 accepted final-review-shadow findings had a confirmed code fix, so
 * `adjudication_outcome = 'accepted'` is NOT evidence of remediation.
 *
 * Same failure contract as getUnlockedFixes: cloud-off and query failure both
 * return `[]` — this is a non-blocking /ship nudge and must never break a push.
 */
export async function getUnremediatedAcceptances(repoId) {
  if (!await isCloudEnabled()) return [];
  try {
    if (repoId) {
      return await many(
        `SELECT * FROM unremediated_acceptances WHERE repo_id = $1 LIMIT 20`,
        [repoId]
      );
    }
    return await many(`SELECT * FROM unremediated_acceptances LIMIT 20`);
  } catch (err) {
    process.stderr.write(`  [learning] getUnremediatedAcceptances failed: ${err.message}\n`);
    return [];
  }
}

// ── persona_audit_correlations ─────────────────────────────────────────────

/**
 * Record a correlation between a persona finding and an audit finding —
 * the highest-leverage ground-truth labelling for the bandit reward.
 * Discriminated result so the auto-correlator (WS1) can count
 * `writeFailed` in its `correlationSummary` — cloud-off / invalid-input
 * are `ok: true` (nothing to write, not a failure); a real write failure
 * is `ok: false`.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function recordPersonaAuditCorrelation(personaSessionId, correlation) {
  if (!personaSessionId || !await isCloudEnabled()) return { ok: true };
  if (!correlation?.personaFindingHash || !correlation?.correlationType || !correlation?.personaSeverity) {
    return { ok: true };
  }
  // Gemini gate R2 shadow finding 6277c9df: this function stamps
  // `hash_version: PERSONA_FINDING_HASH_VERSION` unconditionally below, but
  // until now applied no shape check on `personaFindingHash` itself — unlike
  // `upsertPersonaFindingOutcome`'s write-schema regex, the manual
  // `record-correlation` CLI repair path could supply an arbitrary or
  // v1-shaped (8-hex) value and have it persisted confidently mislabeled v2.
  // Loud rejection (not a silent `{ok:true}` no-op like the field-presence
  // guard above) — both callers already handle `ok:false` (the CLI surfaces
  // it via WRITE_FAILED; the automatic decideCorrelations loop logs and
  // continues), so failing loud here costs nothing and catches a real bug
  // class instead of persisting it.
  if (!PERSONA_FINDING_HASH_SHAPE.test(correlation.personaFindingHash)) {
    return {
      ok: false,
      error: `personaFindingHash must be a 64-hex (v2) hash — got ${JSON.stringify(correlation.personaFindingHash)}`,
    };
  }
  try {
    await withTx(async () => {
      // Retire any auto-emitted `audit_missed` (NULL audit_finding_id) row
      // for this exact (session, hash) pair FIRST — a manual repair that
      // corrects a false miss into a real match must not leave BOTH rows
      // in place (the ground truth would then simultaneously say "missed"
      // AND "confirmed" for the same finding, double-counting in the
      // bandit reward / audit_effectiveness). Harmless no-op when no such
      // row exists (a fresh manual correlation, or one repairing a
      // manual-only row). Plan: docs/plans/persona-nav-feedback-recovery.md
      // WS1 (Gemini gate round-2 finding).
      const row = {
        persona_session_id: personaSessionId,
        persona_finding_hash: correlation.personaFindingHash,
        persona_severity: correlation.personaSeverity,
        audit_finding_id: correlation.auditFindingId || null,
        audit_run_id: correlation.auditRunId || null,
        correlation_type: correlation.correlationType,
        match_score: correlation.matchScore ?? null,
        match_rationale: correlation.matchRationale || null,
        matcher_version: correlation.matcherVersion ?? null,
        // Stamped unconditionally, not threaded through `correlation` — this
        // function is the SOLE writer to persona_audit_correlations (both
        // the automatic decideCorrelations path and the manual
        // `record-correlation` CLI repair path), and there is no scenario
        // where a row written today should carry anything other than the
        // CURRENT hash-identity version (unlike matcher_version, which is a
        // genuinely call-site-varying value).
        // docs/plans/persona-finding-hash-versioning.md, Gemini gate R3 G2.
        hash_version: PERSONA_FINDING_HASH_VERSION,
      };
      if (correlation.auditFindingId) {
        // Retiring the stale NULL row first — see the function doc above.
        await deleteWhere('persona_audit_correlations', {
          persona_session_id: personaSessionId,
          persona_finding_hash: correlation.personaFindingHash,
          audit_finding_id: null,
        });
        // Real match: the 3-column unique constraint is the correct
        // conflict target (audit_finding_id is non-null here, so
        // Postgres's normal NOT-DISTINCT equality applies).
        // The lint reads the row builder's `audit_finding_id: null` DEFAULT, which this
        // branch overwrites. The null shape is handled by the else branch's partial index
        // (`conflictWhere: audit_finding_id IS NULL`) — the correct Postgres remedy for
        // NULL-distinct, not an instance of the 403k-row bug.
        // @on-conflict-ok: audit_finding_id is provably non-null on this branch — it is the `if (correlation.auditFindingId)` guard condition; detecting that needs flow analysis.
        await upsert('persona_audit_correlations', [row],
          { onConflict: ['persona_session_id', 'persona_finding_hash', 'audit_finding_id'], update: 'all' });
      } else {
        // audit_missed: audit_finding_id IS NULL is never equal to itself
        // under a plain column-list constraint (Postgres NULLs are
        // distinct), so ON CONFLICT (a,b,c) can never fire here — the
        // partial 2-column unique index (uq_correlations_missed) is the
        // ONLY conflict target that can dedupe this shape.
        await upsert('persona_audit_correlations', [row], {
          onConflict: ['persona_session_id', 'persona_finding_hash'],
          conflictWhere: 'audit_finding_id IS NULL',
          update: 'all',
        });
      }
    });
    return { ok: true };
  } catch (err) {
    process.stderr.write(`  [learning] recordPersonaAuditCorrelation failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

/**
 * Retire the auto-emitted `audit_missed` correlation(s) for a
 * `persona_finding_hash` when a human dismisses/wont-fixes it via WS4's
 * outcome labels — a dismissal is a durable, repo-wide judgment that the
 * finding was never a real audit miss (e.g. an LLM hallucination), so its
 * ground-truth row must be retired the same way a manual repair retires
 * one (Gemini gate round-3 finding). Scoped ACROSS ALL SESSIONS **FOR THE
 * SAME REPO** — code-audit H5 fix (Cluster 3): the original version's
 * DELETE predicate had NO repo scope at all despite this docstring's own
 * claim, so two different repos coincidentally producing the same
 * `persona_finding_hash` (the hash has no repo/session context baked in —
 * WS1's design) could cross-contaminate each other's ground truth. Joins
 * through `persona_test_sessions.repo_id` since `persona_audit_correlations`
 * itself carries no repo column (only `persona_session_id`) —
 * `deleteWhere`'s flat-equality builder can't express a JOIN, so this uses
 * a raw parameterized statement via the same `many()` primitive every
 * other read in this module uses. `confirmed_hit`/`severity_understated`
 * rows are untouched (a status label doesn't contest a correlation's
 * truth). Best-effort: never throws.
 * @returns {Promise<number>} rows deleted
 */
export async function retireMissedCorrelationsForHash(repoId, personaFindingHash) {
  if (!repoId || !personaFindingHash || !await isCloudEnabled()) return 0;
  try {
    const rows = await many(
      `DELETE FROM persona_audit_correlations pac
        USING persona_test_sessions pts
        WHERE pac.persona_session_id = pts.id
          AND pts.repo_id = $1
          AND pac.persona_finding_hash = $2
          AND pac.audit_finding_id IS NULL
        RETURNING pac.id`,
      [repoId, personaFindingHash],
    );
    return rows.length;
  } catch (err) {
    process.stderr.write(`  [learning] retireMissedCorrelationsForHash failed: ${err.message}\n`);
    return 0;
  }
}

/**
 * Candidate audit_findings for the auto-correlator — timestamp-ordered
 * AND temporally bounded (WS1: a stale audit run must never stand in as a
 * comparison candidate for a fresh persona session — Gemini gate round-3
 * finding). Returns the last `limit` audit_runs' findings within
 * `sinceDays`, PLUS (regardless of age) the findings of the run whose
 * commit_sha exactly matches `exactCommitSha`, when given. One query, no
 * N+1. Each row carries `run_created_at` (for tie-breaking) and `run_id`.
 *
 * Discriminated result — `ok: false` (a real query failure) is distinct
 * from `ok: true, rows: []` (genuinely zero candidates in window): the
 * auto-correlator's `correlationSummary.reason` needs to tell
 * `candidate-read-failed` apart from `no-candidate-runs`, and a bare
 * empty-array-on-error return would collapse that distinction (WS1).
 * @param {{ repoId: string, sinceDays?: number, limit?: number, exactCommitSha?: string|null }} args
 * @returns {Promise<{ok: boolean, rows: object[], error?: string}>}
 */
export async function getCandidateAuditFindings({ repoId, sinceDays = 14, limit = 5, exactCommitSha = null }) {
  if (!repoId || !await isCloudEnabled()) return { ok: true, rows: [] };
  try {
    const runs = await many(
      `SELECT id, created_at FROM audit_runs
        WHERE repo_id = $1
          AND (created_at >= now() - ($2 || ' days')::interval
               OR commit_sha = $3)
        ORDER BY created_at DESC
        LIMIT $4`,
      [repoId, String(sinceDays), exactCommitSha, limit],
    );
    if (runs.length === 0) return { ok: true, rows: [] };
    const runIds = runs.map((r) => r.id);
    const runCreatedAt = new Map(runs.map((r) => [r.id, r.created_at]));
    const findings = await many(
      `SELECT id, run_id, finding_fingerprint, severity, category,
              primary_file, detail_snapshot
         FROM audit_findings
        WHERE run_id = ANY($1)`,
      [runIds],
    );
    return { ok: true, rows: findings.map((f) => ({ ...f, run_created_at: runCreatedAt.get(f.run_id) })) };
  } catch (err) {
    process.stderr.write(`  [learning] getCandidateAuditFindings failed: ${err.message}\n`);
    return { ok: false, rows: [], error: err.message };
  }
}

/**
 * Existing correlation hashes for ONE session — the batched existence
 * read the auto-correlator uses to enforce "first hit wins per finding"
 * without a per-finding query (WS1). Discriminated result for the same
 * reason as `getCandidateAuditFindings` — a read failure must map to
 * `correlationSummary.reason = 'existence-check-failed'`, not silently
 * behave as "nothing exists yet" (which would double-emit on a retry).
 * @param {string} personaSessionId
 * @returns {Promise<{ok: boolean, hashes: Set<string>, error?: string}>}
 */
export async function getExistingCorrelationHashesForSession(personaSessionId) {
  if (!personaSessionId || !await isCloudEnabled()) return { ok: true, hashes: new Set() };
  try {
    const rows = await many(
      `SELECT DISTINCT persona_finding_hash FROM persona_audit_correlations WHERE persona_session_id = $1`,
      [personaSessionId],
    );
    return { ok: true, hashes: new Set(rows.map((r) => r.persona_finding_hash)) };
  } catch (err) {
    process.stderr.write(`  [learning] getExistingCorrelationHashesForSession failed: ${err.message}\n`);
    return { ok: false, hashes: new Set(), error: err.message };
  }
}

/** Read correlations for a specific audit_run. */
export async function readCorrelationsForRun(auditRunId) {
  if (!auditRunId || !await isCloudEnabled()) return [];
  try {
    return await many(`SELECT * FROM persona_audit_correlations WHERE audit_run_id = $1`, [auditRunId]);
  } catch (err) {
    process.stderr.write(`  [learning] readCorrelationsForRun failed: ${err.message}\n`);
    return [];
  }
}

/** Read correlations for a specific audit finding. */
export async function readCorrelationsForFinding(auditFindingId) {
  if (!auditFindingId || !await isCloudEnabled()) return [];
  try {
    return await many(`SELECT * FROM persona_audit_correlations WHERE audit_finding_id = $1`, [auditFindingId]);
  } catch (err) {
    process.stderr.write(`  [learning] readCorrelationsForFinding failed: ${err.message}\n`);
    return [];
  }
}

/** Read the audit_effectiveness view rollup for a repo. */
export async function readAuditEffectiveness(repoId) {
  if (!await isCloudEnabled()) return null;
  try {
    return await one(`SELECT * FROM audit_effectiveness WHERE repo_id = $1 LIMIT 1`, [repoId]);
  } catch (err) {
    process.stderr.write(`  [learning] readAuditEffectiveness failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Per-repo correlation counts by type — WS4 the dashboard tab needs to
 * turn WS1's correlator output into a visible surface ("the correlation
 * loop health line"). `persona_audit_correlations` carries no `repo_id`
 * column (only `persona_session_id`, same as the code-audit H5 fix
 * `retireMissedCorrelationsForHash` closed), so this joins through
 * `persona_test_sessions.repo_id`.
 * @returns {Promise<{ok: boolean, byType: Array<{type: string, count: number}>, total: number, error?: string}>}
 */
export async function readCorrelationCountsByType(repoId) {
  if (!repoId) return { ok: false, byType: [], total: 0, error: 'repoId is required' };
  if (!await isCloudEnabled()) return { ok: true, byType: [], total: 0 };
  try {
    const rows = await many(
      `SELECT pac.correlation_type, count(*) AS n
         FROM persona_audit_correlations pac
         JOIN persona_test_sessions pts ON pts.id = pac.persona_session_id
        WHERE pts.repo_id = $1
        GROUP BY pac.correlation_type`,
      [repoId],
    );
    const byType = rows.map((r) => ({ type: r.correlation_type, count: Number(r.n) || 0 }));
    const total = byType.reduce((sum, r) => sum + r.count, 0);
    return { ok: true, byType, total };
  } catch (err) {
    process.stderr.write(`  [learning] readCorrelationCountsByType failed: ${err.message}\n`);
    return { ok: false, byType: [], total: 0, error: err.message };
  }
}

// ── plan_verification_runs / plan_verification_items ───────────────────────

/**
 * Record one /ux-lock-verify run; returns the run UUID.
 */
export async function recordPlanVerificationRun(run) {
  if (!run?.planId || !await isCloudEnabled()) return null;
  const row = {
    plan_id: run.planId,
    spec_id: run.specId || null,
    commit_sha: run.commitSha || null,
    url: run.url || null,
    total_criteria: run.totalCriteria || 0,
    passed_count: run.passedCount || 0,
    failed_count: run.failedCount || 0,
    skipped_count: run.skippedCount || 0,
    duration_ms: run.durationMs || null,
    run_context: run.runContext || 'ux-lock-verify',
  };
  // Optional selector-policy telemetry (plan: ux-lock-selector-policy).
  if (run.selectorPolicyViolations != null) row.selector_policy_violations = run.selectorPolicyViolations;
  try {
    const out = await insertRunRowWithPolicyFallback('plan_verification_runs', row, { returning: ['id'] });
    return out?.id ?? null;
  } catch (err) {
    process.stderr.write(`  [learning] recordPlanVerificationRun failed: ${err.message}\n`);
    return null;
  }
}

/** Record per-criterion outcomes for a verification run. */
export async function recordPlanVerificationItems(runId, planId, items) {
  if (!runId || !planId || !Array.isArray(items) || items.length === 0) return;
  if (!await isCloudEnabled()) return;
  const rows = items.map((item) => ({
    run_id: runId,
    plan_id: planId,
    criterion_hash: item.criterionHash,
    criterion_index: item.criterionIndex,
    severity: item.severity,
    category: item.category,
    description: item.description,
    setup_text: item.setupText || null,
    assert_text: item.assertText || null,
    passed: !!item.passed,
    skipped: !!item.skipped,
    error_message: item.errorMessage || null,
    duration_ms: item.durationMs || null,
  }));
  const pool = await getPool();
  if (!pool) return;
  const insertItems = async (omitSkipped) => {
    const cols = Object.keys(rows[0]).filter((c) => !(omitSkipped && c === 'skipped'));
    const params = [];
    const valueGroups = rows.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(row[c]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await pool.query(
      `INSERT INTO plan_verification_items (${cols.map((c) => `"${c}"`).join(', ')})
       VALUES ${valueGroups.join(', ')}`,
      params
    );
  };
  try {
    await insertItems(false);
  } catch (err) {
    // 42703-only: consumer DB predates the `skipped` column (migration
    // 20260704…) — retry once without it so the per-criterion rows aren't lost.
    if (err?.code === '42703' && 'skipped' in rows[0]) {
      process.stderr.write('  [learning] plan_verification_items.skipped missing — run setup-postgres --migrate; recording without it\n');
      try { await insertItems(true); return; }
      catch (retryErr) { process.stderr.write(`  [learning] recordPlanVerificationItems failed: ${retryErr.message}\n`); return; }
    }
    process.stderr.write(`  [learning] recordPlanVerificationItems failed: ${err.message}\n`);
  }
}

/** Read the plan_satisfaction view (latest run + failing P0/P1). */
export async function readPlanSatisfaction(planId) {
  if (!planId || !await isCloudEnabled()) return null;
  try {
    return await one(`SELECT * FROM plan_satisfaction WHERE plan_id = $1 LIMIT 1`, [planId]);
  } catch (err) {
    process.stderr.write(`  [learning] readPlanSatisfaction failed: ${err.message}\n`);
    return null;
  }
}

/** Read criteria failing across recent verification runs. */
export async function readPersistentPlanFailures(planId) {
  if (!planId || !await isCloudEnabled()) return [];
  try {
    return await many(`SELECT * FROM persistent_plan_failures WHERE plan_id = $1`, [planId]);
  } catch (err) {
    process.stderr.write(`  [learning] readPersistentPlanFailures failed: ${err.message}\n`);
    return [];
  }
}

// ── ship_events ────────────────────────────────────────────────────────────

/**
 * Record a /ship outcome.
 */
export async function recordShipEvent(repoId, event) {
  if (!event?.outcome || !await isCloudEnabled()) return;
  try {
    await insertReturning('ship_events', {
      repo_id: repoId || null,
      commit_sha: event.commitSha || null,
      branch: event.branch || null,
      outcome: event.outcome,
      block_reasons: event.blockReasons || [], // jsonb — serialized by the db-layer seam
      open_p0_count: event.openP0Count || 0,
      open_p1_count: event.openP1Count || 0,
      missing_spec_count: event.missingSpecCount || 0,
      overridden_by_user: !!event.overriddenByUser,
      override_flag: event.overrideFlag || null,
      stack_detected: event.stackDetected || null,
      framework: event.framework || null,
      duration_ms: event.durationMs || null,
    });
  } catch (err) {
    process.stderr.write(`  [learning] recordShipEvent failed: ${err.message}\n`);
  }
}

/**
 * Read ship-event health for a repo (Cluster D / Phase 7 dashboard).
 * Returns per-outcome counts + the most recent events, or null when cloud is
 * off / the query fails. Repo-scoped (the caller resolves the canonical id).
 *
 * @param {string} repoId
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{byOutcome: Array<{outcome:string,count:number}>, recent: object[]}|null>}
 */
export async function readShipEvents(repoId, { limit = 10 } = {}) {
  if (!repoId || !await isCloudEnabled()) return null;
  try {
    const byOutcome = await many(
      `SELECT outcome, count(*)::int AS count FROM ship_events
        WHERE repo_id = $1 GROUP BY outcome ORDER BY count DESC`,
      [repoId],
    );
    const recent = await many(
      `SELECT outcome, branch, commit_sha, overridden_by_user, created_at
         FROM ship_events WHERE repo_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [repoId, limit],
    );
    return { byOutcome, recent };
  } catch (err) {
    process.stderr.write(`  [learning] readShipEvents failed: ${err.message}\n`);
    return null;
  }
}
