/**
 * @fileoverview Persistence for the model swap-in evaluation harness.
 * `status` is process-state-only (round-6 audit M1/L1) — `running` is the
 * generic non-terminal state for any checkpointed run (round-6 audit H2);
 * `pending_shadow` is the adjudicator-specific sub-state entered FROM
 * `running`. Every function is repo-scoped (round-5 audit H2) — never an
 * ambient assumption on a shared database.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 1.
 *
 * @module scripts/lib/store/model-eval
 */

import { z } from 'zod';
import { insertReturning, one, many, updateWhere } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';
import { RoleSchema, TierSchema, JudgeTierSchema, RunStatusSchema, TerminalRunStatusSchema, NonTerminalRunStatusSchema, VerdictSchema, NextActionSchema } from '../model-eval/contracts.mjs';
import { ALL_VALID_VERDICT_NEXT_ACTION_PAIRS } from '../model-eval/verdict.mjs';

// Round-8 audit M5 fix — reject a (verdict, nextAction) pair that's
// impossible under EVERY DECISION_TABLE row (e.g. switch+reject). Coarser
// than full mode/tier/role-aware legality (this schema doesn't carry
// `mode`), but real defense-in-depth without duplicating DECISION_TABLE's
// actual rule — that stays solely in verdict.mjs.
//
// Round-9 audit H7/H10 fix — the original check `return`ed early whenever
// EITHER side was null, so a half-populated record (verdict set, nextAction
// null, or vice versa) skipped validation entirely; a failed/empty run could
// also persist a success-shaped nextAction despite status saying otherwise.
// Now: (1) verdict/nextAction must be both-null or both-non-null, always;
// (2) status:'completed' requires both non-null; any other status (a
// non-terminal running/pending_shadow, or a failed_* terminal status)
// requires both null — a failed or in-flight run has no decision yet.
function refineVerdictPair(v, ctx) {
  const verdictSet = v.verdict != null;
  const nextActionSet = v.nextAction != null;
  if (verdictSet !== nextActionSet) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'verdict and nextAction must be both null or both non-null — a half-populated decision is not a valid state' });
    return;
  }
  if (v.status === 'completed' && !verdictSet) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'status:"completed" requires a non-null verdict/nextAction' });
  }
  if (v.status !== 'completed' && verdictSet) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `status:"${v.status}" (not "completed") must not carry a verdict/nextAction — a non-terminal or failed run has no decision yet` });
  }
  if (verdictSet && !ALL_VALID_VERDICT_NEXT_ACTION_PAIRS.includes(`${v.verdict}:${v.nextAction}`)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `verdict:"${v.verdict}" + nextAction:"${v.nextAction}" is not a pair any DECISION_TABLE row (or fallback) ever produces` });
  }
}

// Round-14 audit M1 fix — this file's own header comment documents
// pending_shadow as "the ADJUDICATOR-SPECIFIC sub-state," but nothing
// enforced that a run created with status:'pending_shadow' actually has
// role:'adjudicator' — an auditor run could be created in that state,
// violating the documented state machine.
function refineRolePendingShadow(v, ctx) {
  if (v.status === 'pending_shadow' && v.role !== 'adjudicator') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `status:"pending_shadow" is adjudicator-specific — role:"${v.role}" is not allowed in this status` });
  }
}

// Round-14 audit H1/M10 fix — candidateRef/baselineRef/metrics/cost/evidence
// are bound to jsonb columns (per this repo's own documented jsonb-safe
// write-seam invariant — AGENTS.md), but z.record(string, unknown()) accepts
// values that are NOT safely JSON-round-trippable: undefined-valued keys
// silently vanish, functions/Symbols silently vanish, a circular reference
// THROWS at serialization time — well after this validation boundary passed.
// Fail here instead, at the API boundary these comments already claim
// enforces "a bad value must never reach SQL assembly."
/** Recursively reject function/undefined/Symbol/bigint values — a plain
 * try/catch around JSON.stringify is NOT sufficient here: JSON.stringify
 * silently DROPS function-valued keys (no throw) rather than rejecting
 * them, so a round-trip-equality check would let exactly the silent-data-
 * loss case this fix exists to catch pass right through. */
function isJsonbSafeValue(v) {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  if (t === 'function' || t === 'symbol' || t === 'bigint' || t === 'undefined') return false;
  if (Array.isArray(v)) return v.every(isJsonbSafeValue);
  if (t === 'object') return Object.values(v).every(isJsonbSafeValue);
  return false;
}

function jsonbSafeRecord() {
  return z.record(z.string(), z.unknown()).refine((v) => {
    try { JSON.stringify(v); } catch { return false; } // catches circular references
    return isJsonbSafeValue(v);
  }, { message: 'must be JSON-serializable (no circular references, functions, Symbols, bigints, or undefined values)' });
}

// Exported for direct schema-boundary testing (no live DB needed) — mirrors
// the _internals export pattern used elsewhere in scripts/lib/model-eval/.
export const _internals = { get CreateEvalRunBundleSchema() { return CreateEvalRunBundleSchema; }, get UpdateEvalRunTerminalArgsSchema() { return UpdateEvalRunTerminalArgsSchema; } };

export class EvalRunAlreadyActiveError extends Error {
  constructor(repoId, role) {
    super(`EvalRunAlreadyActiveError: repo ${repoId} already has an active ${role} run`);
    this.name = 'EvalRunAlreadyActiveError';
  }
}

// Implementation M4 fix — validate at the API boundary even though callers
// (store/model-eval.mjs consumers in Phase 3/4) also validate; a bad status/
// missing repoId must never reach SQL assembly.
const CreateEvalRunBundleSchema = z.object({
  repoId: z.string().min(1),
  role: RoleSchema,
  tier: TierSchema,
  candidateRef: jsonbSafeRecord(),
  baselineRef: jsonbSafeRecord().nullable().optional(),
  judgeTier: JudgeTierSchema.nullable().optional(),
  // Round-12 audit M9 fix — this file's own header comment documents
  // updateEvalRunTerminal as "the ONLY way a run transitions OUT of a
  // non-terminal status," but this schema accepted any RunStatusSchema
  // value at CREATE time (including completed/failed_*), letting a caller
  // create-and-immediately-terminal-ize a run in one call, bypassing that
  // documented transition model at the one boundary meant to enforce it.
  status: NonTerminalRunStatusSchema,
  // Round-7 audit M3 fix — verdict/nextAction were unrestricted nullable
  // strings, so this persistence boundary could store a value
  // verdict.mjs::DECISION_TABLE can never produce. The pair-LEGALITY rule
  // still lives solely in DECISION_TABLE (verdict.mjs); this only bounds the
  // vocabulary to values that are members of SOME pair.
  verdict: VerdictSchema.nullable().optional(),
  nextAction: NextActionSchema.nullable().optional(),
  metrics: jsonbSafeRecord().nullable().optional(),
  thresholdsVersion: z.number().int().nullable().optional(),
  cost: jsonbSafeRecord().nullable().optional(),
  evidence: jsonbSafeRecord().nullable().optional(),
  harnessSha: z.string().nullable().optional(),
  corpusVersion: z.string().nullable().optional(),
}).superRefine(refineVerdictPair).superRefine(refineRolePendingShadow);

/**
 * @param {object} rawBundle - {repoId, role, tier, candidateRef, baselineRef, judgeTier, status, evidence, ...}
 */
export async function createEvalRun(rawBundle) {
  const bundle = CreateEvalRunBundleSchema.parse(rawBundle);
  if (!await isCloudEnabled()) return { ok: true, cloud: false, runId: null };
  try {
    const row = await insertReturning('model_eval_runs', {
      repo_id: bundle.repoId,
      role: bundle.role,
      tier: bundle.tier,
      candidate_ref: bundle.candidateRef,
      baseline_ref: bundle.baselineRef ?? null,
      judge_tier: bundle.judgeTier ?? null,
      status: bundle.status,
      verdict: bundle.verdict ?? null,
      next_action: bundle.nextAction ?? null,
      metrics: bundle.metrics ?? null,
      thresholds_version: bundle.thresholdsVersion ?? null,
      cost: bundle.cost ?? null,
      evidence: bundle.evidence ?? null,
      harness_sha: bundle.harnessSha ?? null,
      corpus_version: bundle.corpusVersion ?? null,
    }, { returning: ['run_id'] });
    return { ok: true, cloud: true, runId: row.run_id };
  } catch (err) {
    if (String(err.message).includes('duplicate key') || err.code === '23505') {
      throw new EvalRunAlreadyActiveError(bundle.repoId, bundle.role);
    }
    throw err;
  }
}

const UpdateEvalRunTerminalArgsSchema = z.object({
  repoId: z.string().min(1),
  runId: z.string().min(1),
  expectedStatus: NonTerminalRunStatusSchema,
  terminalBundle: z.object({
    status: TerminalRunStatusSchema,
    verdict: VerdictSchema.nullable().optional(),
    nextAction: NextActionSchema.nullable().optional(),
    metrics: jsonbSafeRecord().nullable().optional(),
    cost: jsonbSafeRecord().nullable().optional(),
    evidence: jsonbSafeRecord().nullable().optional(),
  }).superRefine(refineVerdictPair),
});

/**
 * The ONLY way a run transitions out of a non-terminal status.
 * @param {{repoId, runId, expectedStatus: 'running'|'pending_shadow', terminalBundle: object}} args
 */
export async function updateEvalRunTerminal(rawArgs) {
  const { repoId, runId, expectedStatus, terminalBundle } = UpdateEvalRunTerminalArgsSchema.parse(rawArgs);
  if (!await isCloudEnabled()) return { ok: true, cloud: false, updated: false };
  const res = await updateWhere(
    'model_eval_runs',
    {
      status: terminalBundle.status,
      verdict: terminalBundle.verdict ?? null,
      next_action: terminalBundle.nextAction ?? null,
      metrics: terminalBundle.metrics ?? null,
      cost: terminalBundle.cost ?? null,
      evidence: terminalBundle.evidence ?? null,
    },
    { run_id: runId, repo_id: repoId, status: expectedStatus },
  );
  if ((res.rowCount ?? 0) > 0) return { ok: true, cloud: true, updated: true };
  // A zero-row UPDATE is ambiguous until disambiguated with a status read
  // (round-5 H1 refinement of the round-3 H2 fix): three distinct outcomes,
  // never collapsed —
  //   run_not_found      → no row for this (runId, repoId): real caller error.
  //   status_mismatch    → row exists in a DIFFERENT non-terminal state than
  //                        expectedStatus (e.g. expected pending_shadow, found
  //                        running): the caller's precondition is violated —
  //                        a state-machine bug, NOT a benign race. ok:false.
  //   already_finalized  → row reached a terminal status (another process won
  //                        the finalize race): benign idempotent no-op. ok:true.
  const existing = await one('SELECT run_id, status FROM model_eval_runs WHERE run_id = $1 AND repo_id = $2', [runId, repoId]);
  if (!existing) {
    return { ok: false, cloud: true, updated: false, reason: 'run_not_found' };
  }
  if (existing.status === 'running' || existing.status === 'pending_shadow') {
    return { ok: false, cloud: true, updated: false, reason: 'status_mismatch', currentStatus: existing.status };
  }
  return { ok: true, cloud: true, updated: false, reason: 'already_finalized', currentStatus: existing.status };
}

const GetEvalRunsArgsSchema = z.object({
  repoId: z.string().min(1),
  role: RoleSchema.optional(),
  limit: z.number().int().positive().max(500).default(50),
  cursor: z.object({ createdAt: z.string(), runId: z.string() }).optional(),
});

/**
 * @param {{repoId: string, role?: string, limit?: number, cursor?: {createdAt: string, runId: string}}} args
 */
export async function getEvalRuns(rawArgs) {
  const { repoId, role, limit: cappedLimit, cursor } = GetEvalRunsArgsSchema.parse(rawArgs);
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: [] };
  const params = [repoId];
  let where = `repo_id = $1 AND status NOT IN ('running', 'pending_shadow')`;
  if (role) { params.push(role); where += ` AND role = $${params.length}`; }
  if (cursor) {
    params.push(cursor.createdAt, cursor.runId);
    where += ` AND (created_at, run_id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(cappedLimit);
  const rows = await many(
    `SELECT * FROM model_eval_runs WHERE ${where} ORDER BY created_at DESC, run_id DESC LIMIT $${params.length}`,
    params,
  );
  return { ok: true, cloud: true, rows };
}

const GetActiveEvalRunIdArgsSchema = z.object({
  repoId: z.string().min(1),
  role: RoleSchema,
});

/**
 * Discovery API (Gemini round-1 G1, repo-scoped round-5 H2). Called
 * unconditionally at gemini-review.mjs startup (round-6 H4) — never gated
 * behind FINAL_REVIEW_SHADOW.
 * @param {{repoId: string, role: 'auditor'|'adjudicator'}} args
 */
export async function getActiveEvalRunId(rawArgs) {
  const { repoId, role } = GetActiveEvalRunIdArgsSchema.parse(rawArgs);
  if (!await isCloudEnabled()) return null;
  const row = await one(
    `SELECT run_id, candidate_ref FROM model_eval_runs WHERE repo_id = $1 AND role = $2 AND status = 'pending_shadow' LIMIT 1`,
    [repoId, role],
  );
  return row ? { runId: row.run_id, candidateRef: row.candidate_ref } : null;
}
