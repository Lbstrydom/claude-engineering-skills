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
import { insertReturning, one, many, updateWhere, withTx } from '../db/query.mjs';
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
/**
 * Public entry point — always starts a FRESH ancestor-chain tracker.
 *
 * Cluster B fix-gate (R3, third time this was raised — the first two rounds
 * deferred it as pre-existing and independent of what shipped; a third
 * independent raise is worth acting on rather than deferring a fourth time).
 * The recursive walker below had no cycle guard at all: `const evidence = {};
 * evidence.self = evidence;` would recurse until the call stack was
 * exhausted, INSIDE the validation boundary whose whole job is to run
 * BEFORE a bad value reaches SQL assembly — an uncaught RangeError there is
 * itself the failure this seam exists to prevent, just moved one step
 * earlier than jsonb serialization would have hit it.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
function isJsonbSafeValue(v) {
  return isJsonbSafeValueInner(v, new Set());
}

/** Recursively reject function/undefined/Symbol/bigint values — a plain
 * try/catch around JSON.stringify is NOT sufficient here: JSON.stringify
 * silently DROPS function-valued keys (no throw) rather than rejecting
 * them, so a round-trip-equality check would let exactly the silent-data-
 * loss case this fix exists to catch pass right through.
 *
 * @param {unknown} v
 * @param {Set<object>} seen — every OBJECT/ARRAY currently on the path from
 *   the root to `v` (the ancestor chain, not "every value visited overall" —
 *   the same object reachable twice via two DIFFERENT, non-cyclic paths,
 *   e.g. `{a: shared, b: shared}`, is valid JSON and must not be rejected,
 *   so an entry is removed from `seen` once its own subtree finishes).
 */
function isJsonbSafeValueInner(v, seen) {
  if (v === null) return true;
  const t = typeof v;
  // r15h1jsonbfinite fix — `typeof NaN === 'number'` and `typeof Infinity ===
  // 'number'`, so both used to pass this check; JSON.stringify then emits
  // `null` for either WITHOUT throwing, so the value was silently CHANGED on
  // the way to a jsonb column rather than rejected here. That is the same
  // silent-data-loss failure this function's own docstring cites for
  // function-valued keys — jsonb simply has no NaN/Infinity representation, so
  // there is no honest way to store one. Reject at the boundary these comments
  // already claim enforces "a bad value must never reach SQL assembly."
  if (t === 'number') return Number.isFinite(v);
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'function' || t === 'symbol' || t === 'bigint' || t === 'undefined') return false;
  if (Array.isArray(v)) {
    // Cluster B fix-gate, round 2 — the first fix (`Object.keys(v).length !==
    // v.length`) closed the non-index-property gap but repeated the SAME two
    // mistakes the object branch below had already been fixed for, TWICE
    // (Audit R1 H1, R5 H3), because it did not reuse that branch's approach:
    //   (a) `Object.keys()` sees only ENUMERABLE own keys, so a NON-ENUMERABLE
    //       extra property (`Object.defineProperty(arr,'x',{enumerable:false})`)
    //       left BOTH sides of the length comparison equal — invisible, same
    //       as it would have been to `v.every()` before the R1 fix.
    //   (b) reading `v[i]` directly, like `v.every()` before it, INVOKES a
    //       getter rather than inspecting it — the exact two-invocations
    //       problem R5 H3 fixed for objects (`Object.values()` reads a getter
    //       once here, JSON.stringify reads it again at write time; nothing
    //       guarantees the two agree).
    // Both measured live before this fix (Cluster B R2): an array with a
    // non-enumerable extra property, and one with a getter at index 0, both
    // passed validation and both silently diverge from what they validated as.
    //
    // The array-specific property this function must additionally establish —
    // an array is not just "an object without extra keys", it also declares
    // NO index gaps — so this reimplements the object branch's own-property
    // rigor (getOwnPropertyNames count, symbol check, per-key descriptor walk
    // rejecting accessors) plus the R1 sparse-hole check, rather than
    // borrowing a shortcut that quietly dropped both guarantees again.
    if (Object.getOwnPropertySymbols(v).length > 0) return false;
    // Every own property name must be exactly one of the array's numeric
    // indices — anything else (a non-index property, enumerable or not) is
    // rejected here, closing gap (a) above. `getOwnPropertyNames` on an array
    // ALWAYS includes the own, non-enumerable `'length'` property itself
    // (`Object.getOwnPropertyNames([1,2,3])` → `['0','1','2','length']`) — the
    // one name every array legitimately carries beyond its indices, so it is
    // subtracted before comparing rather than counted as an extra.
    const names = Object.getOwnPropertyNames(v).filter((n) => n !== 'length');
    if (names.length !== v.length) return false;
    // Cluster B fix-gate (R3, third raise): `const a=[]; a.push(a);` recursed
    // into itself with no ancestor check — an uncaught RangeError from stack
    // exhaustion, inside the boundary meant to run BEFORE a bad value reaches
    // SQL, not instead of a controlled rejection. `v` is added to the
    // ancestor chain for the DURATION of walking its own children only, and
    // removed once they finish — a shared, non-cyclic reference to the same
    // array from two different branches is valid JSON and must still pass.
    if (seen.has(v)) return false;
    seen.add(v);
    for (let i = 0; i < v.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(v, i);
      // A hole (R1 H1) has no descriptor at all; an accessor index (gap (b))
      // has one with get/set instead of a plain value. Both are rejected the
      // same way the object branch already rejects them.
      if (!descriptor || typeof descriptor.get === 'function' || typeof descriptor.set === 'function') { seen.delete(v); return false; }
      if (!isJsonbSafeValueInner(descriptor.value, seen)) { seen.delete(v); return false; }
    }
    seen.delete(v);
    return true;
  }
  if (t === 'object') {
    // Audit R1 H1 / R2 H2+H3 — `Object.values()` sees ONLY own enumerable
    // string-keyed properties, which is the same blind spot JSON.stringify
    // has, so the guard agreed with the serializer about nothing being lost
    // while both were ignoring the data. Measured: Map, Set, WeakMap, RegExp,
    // Error and Promise every one stringify to `{}` with zero own values —
    // total, silent loss; a TypedArray re-shapes to {"0":…}; Symbol-keyed and
    // non-enumerable properties simply vanish.
    //
    // An R1 fix rejecting `Map`/`Set` by name was the wrong shape — a denylist
    // of the two kinds that had been named. The property that actually matters
    // is "does this round-trip predictably", so test for that instead: a PLAIN
    // object (Object.prototype or a null prototype) carrying only own
    // enumerable string keys. Anything declaring its own serialization via
    // toJSON (Date) is honoured as-is.
    // Audit R3 H1/H2 then R4 H1/H2 — this exemption went through
    // `typeof v.toJSON === 'function' -> true` (an unconditional bypass: `{
    // toJSON: () => undefined }` erases its own key) and then through calling
    // toJSON and validating the result, which R4 correctly flagged as
    // validating a DIFFERENT invocation than the one persistence will make: a
    // stateful serializer can return safe once and unsafe next.
    //
    // The fix is to stop invoking arbitrary serializers at all. Date is the
    // only reason this exemption ever existed, so allow exactly Date and let
    // everything else fall through to the plain-object test below — which
    // rejects a class instance on its prototype, and a plain `{toJSON: fn}` on
    // the function value itself. Nothing is called, so there is no
    // invocation to disagree with a later one.
    // Audit R5 H1 — `instanceof Date` alone is a claim about the CONSTRUCTOR,
    // not about how the value serializes: a Date carrying its own `toJSON`
    // (or a patched prototype) passes the instanceof test and then persists as
    // whatever that override returns. Require the stock serializer. An Invalid
    // Date is rejected too — its toJSON yields null, so the distinction
    // between "invalid date" and "no value" would be lost on the way in.
    // Audit R6 H2 — `v.toJSON === Date.prototype.toJSON` stops a REPLACED
    // serializer but not attached data: `d.extra = 1` leaves the stock toJSON
    // in place, which returns only the ISO string, so `extra` is silently
    // dropped on write. Require a stock, bare, valid Date — exact prototype
    // (so a Date subclass with accessors is out too), no own properties of any
    // kind, finite time. Anything else is not the one case this exemption was
    // opened for.
    if (v instanceof Date) {
      return Object.getPrototypeOf(v) === Date.prototype
        && v.toJSON === Date.prototype.toJSON
        && Object.getOwnPropertyNames(v).length === 0
        && Object.getOwnPropertySymbols(v).length === 0
        && Number.isFinite(v.getTime());
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    if (Object.getOwnPropertySymbols(v).length > 0) return false;
    if (Object.getOwnPropertyNames(v).length !== Object.keys(v).length) return false;
    // Cluster B fix-gate (R3, third raise) — same ancestor-chain guard as the
    // array branch above; see its comment for the full reasoning.
    if (seen.has(v)) return false;
    seen.add(v);
    // Audit R5 H3 — `Object.values()` INVOKES getters, so an accessor property
    // was being read here and read again by JSON.stringify at write time: two
    // invocations, two chances to differ. Walk descriptors instead, which
    // reads `.value` without calling anything, and reject accessors outright —
    // a computed property has no stable serialized form to validate.
    for (const key of Object.keys(v)) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') { seen.delete(v); return false; }
      if (!isJsonbSafeValueInner(descriptor.value, seen)) { seen.delete(v); return false; }
    }
    seen.delete(v);
    return true;
  }
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

/**
 * D3a's cohort-attempt collision — a DIFFERENT fact from
 * {@link EvalRunAlreadyActiveError}, and conflating the two is a real defect
 * that shipped and was caught only by a live-DB test, not by reading the code:
 * before D3a, `idx_model_eval_runs_active_pending_shadow` (role/repo-scoped)
 * was the only unique constraint a plain insert could hit, so a blanket
 * "any 23505 means EvalRunAlreadyActiveError" was correct. D3a's migration
 * added two MORE unique indexes on `(comparison_id, arm_id[, attempt])`, and a
 * caller retrying an arm without `supersedePrior` now hits one of THOSE — a
 * cohort-attempt collision, which needs a different remediation
 * (`supersedePrior: true`) than an active pending_shadow run does (finish or
 * cancel the other run). Reporting the wrong one as the other would send an
 * operator chasing a role-active-run problem that does not exist.
 *
 * A THIRD path reaches the same error (R5): the attempt-sequence trigger
 * (20260816110000) rejects a reused attempt number with its own RAISE
 * EXCEPTION (P0001) before the unique index above is ever checked. Same
 * caller-facing fact, different underlying constraint — see the P0001 branch
 * in `createEvalRun`'s catch block.
 */
export class ComparisonArmAttemptCollisionError extends Error {
  constructor(comparisonId, armId, attempt) {
    super(`ComparisonArmAttemptCollisionError: comparison ${comparisonId} arm "${armId}" already has a live/recorded attempt ${attempt} — pass supersedePrior:true to retry`);
    this.name = 'ComparisonArmAttemptCollisionError';
  }
}

/** The ONE unique constraint that means "an active pending_shadow run already
 * exists" — every other unique_violation on this table is a different fact
 * (see {@link ComparisonArmAttemptCollisionError}'s docstring). Named
 * explicitly rather than inferred, so a future index addition cannot
 * silently widen this class again the way D3a's migration did. */
const ACTIVE_PENDING_SHADOW_CONSTRAINT = 'idx_model_eval_runs_active_pending_shadow';

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
  // D3a cohort fields — all optional and all-or-nothing (a comparison run
  // must be identifiable by BOTH comparisonId and armId, or the cohort read
  // that "includes failed siblings" cannot attribute a row to an arm). A
  // single-candidate run (no --manifest) supplies none of these, and every
  // branch below that touches them is a no-op for that call — this schema
  // change must not alter behaviour for the path that predates D3a.
  comparisonId: z.string().min(1).nullable().optional(),
  armId: z.string().min(1).nullable().optional(),
  attempt: z.number().int().positive().optional(),
  // Mirrors campaign/store.mjs::recordArmRun — the supersede-then-insert
  // transaction, not a caller-visible field on the row itself.
  supersedePrior: z.boolean().optional(),
}).superRefine(refineVerdictPair).superRefine(refineRolePendingShadow)
  .superRefine((v, ctx) => {
    const hasComparison = v.comparisonId != null;
    const hasArm = v.armId != null;
    if (hasComparison !== hasArm) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'comparisonId and armId must be both set or both absent — a cohort row must be attributable to an arm' });
    }
    if (v.supersedePrior && !hasComparison) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'supersedePrior requires comparisonId/armId — there is no cohort row to supersede' });
    }
  });

/**
 * @param {object} rawBundle - {repoId, role, tier, candidateRef, baselineRef, judgeTier, status, evidence, ...}
 *   Cohort fields (comparisonId, armId, attempt, supersedePrior) are D3a's
 *   addition — omit all of them for a plain single-candidate run.
 */
export async function createEvalRun(rawBundle) {
  const bundle = CreateEvalRunBundleSchema.parse(rawBundle);
  if (!await isCloudEnabled()) return { ok: true, cloud: false, runId: null };
  const row = {
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
    ...(bundle.comparisonId != null ? { comparison_id: bundle.comparisonId, arm_id: bundle.armId, attempt: bundle.attempt ?? 1 } : {}),
  };
  try {
    // The supersede-then-insert is ONE transaction only when there is a prior
    // live cohort row to retire — the partial unique index
    // (comparison_id, arm_id) WHERE superseded_at IS NULL permits exactly one
    // live row, so doing the two apart would leave a window where the insert
    // fails against a row still marked live. A plain single-candidate call
    // (no comparisonId) never reaches this branch and is unaffected.
    const inserted = bundle.supersedePrior
      ? await withTx(async () => {
          await updateWhere('model_eval_runs', { superseded_at: new Date().toISOString() },
            { comparison_id: bundle.comparisonId, arm_id: bundle.armId, superseded_at: null });
          return insertReturning('model_eval_runs', row, { returning: ['run_id'] });
        })
      : await insertReturning('model_eval_runs', row, { returning: ['run_id'] });
    return { ok: true, cloud: true, runId: inserted.run_id };
  } catch (err) {
    if (err.code === '23505') {
      // The constraint NAME is the fact, not the bare 23505 code — two
      // different unique indexes on this table both raise it, for two
      // different reasons (see ComparisonArmAttemptCollisionError's
      // docstring). A caller telling them apart needs the right one.
      if (err.constraint === ACTIVE_PENDING_SHADOW_CONSTRAINT) {
        throw new EvalRunAlreadyActiveError(bundle.repoId, bundle.role);
      }
      if (bundle.comparisonId != null) {
        throw new ComparisonArmAttemptCollisionError(bundle.comparisonId, bundle.armId, bundle.attempt ?? 1);
      }
      // An unrecognised unique_violation on this table (a future index this
      // function does not yet know about) — fail with the real error rather
      // than guessing which of the two known classes it belongs to.
    }
    // Cluster B fix-gate (R5) — the attempt-sequence trigger
    // (20260816110000, BEFORE INSERT) fires ahead of any unique-index check,
    // so an attempt reused for the same arm now trips ITS RAISE EXCEPTION
    // (SQLSTATE P0001, no `.constraint`) before ever reaching the 23505 path
    // above — the exact caller-facing case ComparisonArmAttemptCollisionError
    // already exists to represent. A bare `err.code === 'P0001'` match would
    // ALSO catch the unrelated repo-scope trigger on this same table
    // (20260816090000), so this matches on the message prefix each trigger's
    // RAISE EXCEPTION is written with, the same "the name is the fact, not
    // the bare code" principle as the 23505 branch above.
    if (err.code === 'P0001' && typeof err.message === 'string'
      && err.message.startsWith('model_eval_runs.attempt must be exactly one more than the prior max')
      && bundle.comparisonId != null) {
      throw new ComparisonArmAttemptCollisionError(bundle.comparisonId, bundle.armId, bundle.attempt ?? 1);
    }
    throw err;
  }
}

const UpsertComparisonArgsSchema = z.object({
  repoId: z.string().min(1),
  comparisonKey: z.string().min(1),
  configDigest: z.string().min(1),
  lockSchemaVersion: z.number().int().positive().default(1),
  role: RoleSchema,
  subjectRef: jsonbSafeRecord().nullable().optional(),
});

/**
 * Idempotent on `(repo_id, comparison_key, config_digest, lock_schema_version)`
 * — re-running the SAME manifest (byte-identical digest) returns the SAME
 * cohort; a config change (new digest) or a `lock_schema_version` bump
 * creates a genuinely NEW row, never an update. That is D2a's whole point:
 * prior evidence under the old digest is orphaned into its own cohort, never
 * silently relabelled to look comparable with what came after it changed.
 *
 * Cluster B fix-gate (R5) — renamed from `ensureComparison`: the ON CONFLICT
 * ... DO UPDATE below IS an upsert, and this repo's writer-discovery gate
 * (`tests/audit-store-durability-call-site.test.mjs`'s `WRITER_NAME`)
 * DISCOVERS candidates by verb-prefixed export NAME — `ensure*` isn't a
 * recognised verb, so the old name made this write invisible to the very
 * mechanism meant to register or exempt it, not merely unregistered.
 *
 * @param {{repoId, comparisonKey, configDigest, lockSchemaVersion?, role, subjectRef?}} args
 */
export async function upsertComparison(rawArgs) {
  const args = UpsertComparisonArgsSchema.parse(rawArgs);
  if (!await isCloudEnabled()) return { ok: true, cloud: false, id: null };
  try {
    const hit = await one(
      `INSERT INTO model_eval_comparisons (repo_id, comparison_key, config_digest, lock_schema_version, role, subject_ref)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (repo_id, comparison_key, config_digest, lock_schema_version)
         DO UPDATE SET subject_ref = EXCLUDED.subject_ref
       RETURNING id`,
      [args.repoId, args.comparisonKey, args.configDigest, args.lockSchemaVersion, args.role,
        args.subjectRef == null ? null : JSON.stringify(args.subjectRef)],
    );
    return { ok: true, cloud: true, id: hit?.id ?? null };
  } catch (err) {
    process.stderr.write(`  [model-eval] upsertComparison failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message, id: null };
  }
}

/**
 * Highest attempt RECORDED for one (comparison, arm) — the resume-safety
 * read. D5a's reducer applied at the auditor role: a re-invocation of the
 * same manifest must know whether an arm already has a live success before
 * deciding to spawn it again.
 *
 * @param {{comparisonId: string, armId: string}} args
 * @returns {Promise<{ok: boolean, cloud: boolean, attempt: number, hasLiveSuccess: boolean}>}
 */
export async function maxComparisonArmAttempt({ comparisonId, armId }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, attempt: 0, hasLiveSuccess: false };
  try {
    const row = await one(
      `SELECT COALESCE(MAX(attempt), 0) AS attempt,
              BOOL_OR(status = 'completed' AND superseded_at IS NULL) AS has_live_success
         FROM model_eval_runs WHERE comparison_id = $1 AND arm_id = $2`,
      [comparisonId, armId],
    );
    return { ok: true, cloud: true, attempt: Number(row?.attempt ?? 0), hasLiveSuccess: row?.has_live_success === true };
  } catch (err) {
    return { ok: false, cloud: true, error: err.message, attempt: 0, hasLiveSuccess: false };
  }
}

/**
 * Every arm's LIVE row for one comparison, including `failed` siblings
 * (D3a). A read that hides failures would make a half-collected comparison
 * look complete — the exact false-green class the campaign role's own cohort
 * read was already written to avoid, applied here.
 *
 * @param {{comparisonId: string}} args
 */
export async function getComparisonCohort({ comparisonId }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: [] };
  try {
    const rows = await many(
      `SELECT run_id, arm_id, attempt, status, verdict, next_action, metrics, cost, evidence, created_at
         FROM model_eval_runs
        WHERE comparison_id = $1 AND superseded_at IS NULL
        ORDER BY arm_id, created_at DESC`,
      [comparisonId],
    );
    return { ok: true, cloud: true, rows };
  } catch (err) {
    return { ok: false, cloud: true, rows: [], error: err.message };
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
