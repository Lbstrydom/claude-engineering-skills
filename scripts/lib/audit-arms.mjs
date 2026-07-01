/**
 * @fileoverview Arm-config model for the model-A/B/C auditor experiment (v2).
 *
 * Plan: docs/plans/model-ab-harness-v2.md (D1 — arms are audit-pipeline
 * COMPOSITIONS; Claude is the constant coder + adjudicator, NOT an auditor arm).
 * An arm is a config row describing an audit + review STACK to compare; the 3
 * canonical arms A/B/C are data here. This module is PURE — no env side effects
 * beyond reading the env object passed to `resolveArms`, no LLM/network/FS. It
 * defines the shape, validates it (Zod), derives the produced-finding STAGES per
 * arm (the scorer view's arm-membership derivation must agree with this), and
 * parses `AUDIT_MODEL_SHADOW` into the selected observation-only arm set.
 *
 * v2 arm compositions (D1):
 *   A = GPT audit → Gemini review              (production control)
 *   B = OSS audit → 1 GPT round → Gemini review (does the GPT round earn its keep? — vs C)
 *   C = OSS audit → Gemini review              (can OSS+Gemini replace GPT+Gemini? — vs A)
 *
 * Stages a finding can be produced by:
 *   - `gpt-gen`   : a GPT 5-pass generation round (the production baseline, arm A)
 *   - `oss-gen`   : an OSS 5-pass generation round (arms B/C, SHARED compute)
 *   - `gpt-round` : one INDEPENDENT GPT 5-pass round (B only — the diversity probe)
 *   - `gemini`    : a per-arm Gemini review (A, B, and C each run their OWN)
 *
 * v2 HYBRID attribution, fail-CLOSED (plan H1 / §4 R2-H1) — the v1 "arm derived
 * from stage×provenance" rule BREAKS because `gemini` now runs THREE times on
 * DIFFERENT inputs (A reviews gpt-gen; B reviews oss-gen+gpt-round; C reviews
 * oss-gen), so a `gemini` finding is arm-SPECIFIC, not shared. Two classes:
 *   - SHARED stages (`oss-gen` → {B,C}; `gpt-gen` → {A}) — one execution serves
 *     its arm set; stored ONCE, membership DERIVED from stage. No `arm` tag.
 *   - ARM-SPECIFIC stages (`gpt-round`, `gemini`) — carry an EXPLICIT `arm` tag
 *     on the finding. A null `arm` on these is a DATA ERROR (throw — never
 *     silently derive), mirroring the v1 fail-closed guard.
 *
 * @module scripts/lib/audit-arms
 */

import { z } from 'zod';
import { isSentinel, SENTINEL_TO_TIER } from './model-resolver.mjs';

// ── Stage taxonomy (SSoT — the store, view, and shadow all reference these) ──
export const STAGES = Object.freeze(['gpt-gen', 'oss-gen', 'gpt-round', 'gemini']);

// Attribution class split (plan H1) — the hybrid rule's SSoT.
//   SHARED       : one execution serves ≥1 arm; membership DERIVED from stage.
//   ARM_SPECIFIC : each execution belongs to ONE arm; requires an explicit `arm`
//                  tag (null ⇒ hard error, fail-closed — §4 R2-H1).
export const SHARED_STAGES = Object.freeze(['gpt-gen', 'oss-gen']);
export const ARM_SPECIFIC_STAGES = Object.freeze(['gpt-round', 'gemini']);

// Valid arm ids (the CHECK domain mirrored in the migration).
export const ARM_IDS = Object.freeze(['A', 'B', 'C']);

// Stages a SHADOW execution can produce (arms B/C): oss-gen (shared), gpt-round
// (B only), gemini (B + C, arm-specific). The baseline arm A runs in the
// PRODUCTION pipeline (gpt-gen + its own gemini), never the shadow.
export const SHADOW_STAGES = Object.freeze(['oss-gen', 'gpt-round', 'gemini']);
export const BASELINE_STAGES = Object.freeze(['gpt-gen', 'gemini']);

// ── Arm schema ───────────────────────────────────────────────────────────────

export const ArmGenerationSchema = z.object({
  // A SENTINEL (latest-gpt / latest-oss-coder / …), never a concrete id — the
  // resolver picks the newest match at run time (plan decision 2, load-bearing).
  modelSentinel: z.string().min(1).max(60),
  provider: z.enum(['openai', 'oss']),
  // OSS role selects the OSS_POOL partition; required for provider:'oss', absent
  // otherwise (enforced by superRefine below).
  role: z.enum(['coder', 'reasoner']).optional(),
});

export const ArmSchema = z.object({
  id: z.string().regex(/^[A-Z][A-Za-z0-9_-]{0,15}$/, 'arm id must start uppercase, ≤16 chars'),
  label: z.string().min(1).max(120),
  generation: ArmGenerationSchema,
  // One INDEPENDENT GPT 5-pass round injected as the final round (decision 3 —
  // measures GPT's own diverse catches, NOT an arbiter over OSS findings).
  gptRound: z.boolean(),
  // The Gemini final gate (production role: may emit new_findings + flag
  // wrongly_dismissed — decision 10a).
  geminiGate: z.boolean(),
  // The production/control arm is run by the real audit pipeline, NOT the
  // observation-only shadow. It cannot be a shadow target.
  isBaseline: z.boolean().default(false),
}).superRefine((arm, ctx) => {
  if (arm.generation.provider === 'oss' && !arm.generation.role) {
    ctx.addIssue({ code: 'custom', path: ['generation', 'role'], message: 'provider:"oss" requires a role (coder|reasoner)' });
  }
  if (arm.generation.provider === 'openai' && arm.generation.role) {
    ctx.addIssue({ code: 'custom', path: ['generation', 'role'], message: 'provider:"openai" must not carry an OSS role' });
  }
  // modelSentinel MUST be a registered sentinel, never a concrete id (audit R4
  // M4 + plan decision 2 — the load-bearing "no pinned ids in arm code"
  // anti-pattern). A concrete OSS override lives in env (OSS_CODER_MODEL),
  // resolved by the resolver, NOT in the arm config. The sentinel's provider
  // must also match the arm's declared provider (catches latest-gpt on an OSS
  // arm — a silent mis-route of our source to the wrong provider).
  const sent = arm.generation.modelSentinel;
  if (!isSentinel(sent)) {
    ctx.addIssue({ code: 'custom', path: ['generation', 'modelSentinel'], message: `must be a model SENTINEL (latest-*), not a concrete id "${sent}" (plan decision 2 — concrete overrides live in env, e.g. OSS_CODER_MODEL)` });
  } else {
    const sentProvider = SENTINEL_TO_TIER[sent.toLowerCase()].provider;
    if (arm.generation.provider !== sentProvider) {
      ctx.addIssue({ code: 'custom', path: ['generation', 'modelSentinel'], message: `provider "${arm.generation.provider}" does not match sentinel provider "${sentProvider}" (sentinel "${sent}")` });
    }
  }
});

// ── Canonical arms (the experiment's 3 rows — plan §2 arms A/B/C) ────────────
//
// A 4th/5th candidate = one more row here (extension seam). Kept as literal data
// rather than a config file: only A/B/C are a CURRENT requirement, so an
// arms.json loader would be the over-engineering cliff (§ Right-sizing gate).

export const CANONICAL_ARMS = Object.freeze([
  Object.freeze({
    id: 'A',
    label: 'GPT audit → Gemini review (production control)',
    generation: Object.freeze({ modelSentinel: 'latest-gpt', provider: 'openai' }),
    gptRound: false,
    geminiGate: true,
    isBaseline: true,
  }),
  Object.freeze({
    id: 'B',
    label: 'OSS audit → 1 GPT round → Gemini review (does the GPT round earn its keep?)',
    generation: Object.freeze({ modelSentinel: 'latest-oss-reasoner', provider: 'oss', role: 'reasoner' }),
    gptRound: true,
    geminiGate: true,
    isBaseline: false,
  }),
  Object.freeze({
    id: 'C',
    label: 'OSS audit → Gemini review (can OSS+Gemini replace GPT+Gemini?)',
    generation: Object.freeze({ modelSentinel: 'latest-oss-reasoner', provider: 'oss', role: 'reasoner' }),
    gptRound: false,
    geminiGate: true,
    isBaseline: false,
  }),
]);

// Fail-fast: a bad edit to CANONICAL_ARMS surfaces at import, not at spend time.
for (const arm of CANONICAL_ARMS) {
  const r = ArmSchema.safeParse(arm);
  if (!r.success) {
    throw new Error(`[audit-arms] canonical arm "${arm.id}" is invalid: ${r.error.issues.map((i) => i.message).join('; ')}`);
  }
}

/**
 * Validate an arbitrary arm object. Returns {ok, arm} | {ok:false, error}.
 * @param {unknown} raw
 */
export function parseArm(raw) {
  const r = ArmSchema.safeParse(raw);
  if (r.success) return { ok: true, arm: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

/**
 * Derive the ordered set of stages an arm's config produces findings at.
 * The scorer view derives arm membership from the SAME rule (plan decision 10).
 * @param {z.infer<typeof ArmSchema>} arm
 * @returns {string[]}
 */
export function stagesForArm(arm) {
  const stages = [arm.generation.provider === 'oss' ? 'oss-gen' : 'gpt-gen'];
  if (arm.gptRound) stages.push('gpt-round');
  if (arm.geminiGate) stages.push('gemini');
  return stages;
}

/**
 * Attribute a produced finding to the arm id(s) it belongs to (v2 HYBRID rule —
 * plan H1 / §4 R2-H1). This is the canonical rule the scorer view mirrors:
 *   - SHARED stage (`oss-gen` → ['B','C']; `gpt-gen` → ['A']) — one execution
 *     serves its whole arm set; membership DERIVED from CANONICAL_ARMS (single
 *     source, no hardcoded A/B/C lists to drift). The `arm` tag MUST be null for
 *     shared stages; a non-null arm is conflicting metadata and is REJECTED
 *     (fail-closed), not silently ignored.
 *   - ARM-SPECIFIC stage (`gpt-round`, `gemini`) — each execution belongs to ONE
 *     arm, so an explicit `arm` tag is REQUIRED; it returns `[arm]`.
 *
 * Fail-CLOSED (§4 R2-H1 — the load-bearing invariant): a null/absent `arm` on an
 * arm-specific stage is a DATA ERROR and THROWS — it must NEVER be silently
 * derived (that would mis-attribute B's gemini to C, or drop it entirely). An
 * unknown `stage`, an out-of-domain `arm`, or an `arm` that does not actually
 * declare the stage all THROW too — silent attribution loss is the exact class
 * the store must never hit.
 *
 * @param {string} stage
 * @param {{arm?:string|null}} [opts] — explicit arm tag (required for arm-specific stages)
 * @returns {string[]} arm ids
 */
export function attributeStageToArms(stage, { arm = null } = {}) {
  if (!STAGES.includes(stage)) {
    throw new Error(`attributeStageToArms: unknown stage ${JSON.stringify(stage)}; valid: ${STAGES.join(', ')}`);
  }
  if (ARM_SPECIFIC_STAGES.includes(stage)) {
    // Fail-CLOSED: an arm-specific stage MUST carry an explicit arm; never derive.
    if (arm == null) {
      throw new Error(`attributeStageToArms: arm-specific stage ${JSON.stringify(stage)} requires an explicit arm (null is a DATA ERROR — never derived, plan §4 R2-H1)`);
    }
    if (!ARM_IDS.includes(arm)) {
      throw new Error(`attributeStageToArms: arm ${JSON.stringify(arm)} not in ${ARM_IDS.join('|')}`);
    }
    // Sanity: the named arm must actually declare this stage (catches a mis-tag
    // like arm='A' on gpt-round, which only B runs).
    const owner = CANONICAL_ARMS.find((a) => a.id === arm);
    if (!owner || !stagesForArm(owner).includes(stage)) {
      throw new Error(`attributeStageToArms: arm ${arm} does not declare stage ${stage}`);
    }
    return [arm];
  }
  // SHARED stage — membership is DERIVED from CANONICAL_ARMS (an arm owns this
  // stage iff its stagesForArm() includes it). Fail-CLOSED on a stray arm tag
  // (audit R1 388a236e): a shared stage MUST carry a null arm; a non-null arm is
  // conflicting attribution metadata (e.g. tagging oss-gen 'B' would silently
  // drop C), so reject it rather than ignore it.
  if (arm != null) {
    throw new Error(`attributeStageToArms: shared stage ${JSON.stringify(stage)} must have a null arm (got ${JSON.stringify(arm)}) — its membership is derived, not tagged`);
  }
  return CANONICAL_ARMS.filter((a) => stagesForArm(a).includes(stage)).map((a) => a.id);
}

/**
 * The UNION of execution stages the shadow must actually RUN across a selected
 * arm set, honouring compute-sharing (B and C share oss-gen + gpt-round; only C
 * adds gemini). Returns booleans the runner reads so it never executes a stage
 * twice. `geminiGate` is true iff ANY selected arm wants the gate.
 * @param {Array<z.infer<typeof ArmSchema>>} arms
 */
export function executionPlan(arms) {
  const wantsOssGen = arms.some((a) => a.generation.provider === 'oss');
  const wantsGptGen = arms.some((a) => a.generation.provider === 'openai' && !a.isBaseline);
  const wantsGptRound = arms.some((a) => a.gptRound);
  const wantsGemini = arms.some((a) => a.geminiGate);
  return { wantsOssGen, wantsGptGen, wantsGptRound, wantsGemini };
}

/**
 * Parse `AUDIT_MODEL_SHADOW` into the selected observation-only arm set.
 *
 * Contract:
 *   - unset/empty → `{enabled:false, arms:[]}` (byte-identical-to-today path).
 *   - unknown arm id → THROW (validation error — never silently drop; the
 *     operator asked to spend on an arm that doesn't exist).
 *   - the baseline arm (A) → THROW (it's the production audit, not a shadow
 *     target — shadowing it would double-run the real audit).
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {{enabled:boolean, requested:string[], arms:Array<z.infer<typeof ArmSchema>>, all:ReadonlyArray<object>}}
 */
export function resolveArms(env = process.env) {
  const raw = (env.AUDIT_MODEL_SHADOW || '').trim();
  if (!raw) return { enabled: false, requested: [], arms: [], all: CANONICAL_ARMS };

  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  // A delimiter-only value (`,` / `,,`) is neither a real enabled experiment nor
  // the documented disabled state — treat it as disabled (audit R1 M5).
  if (ids.length === 0) return { enabled: false, requested: [], arms: [], all: CANONICAL_ARMS };
  const byId = new Map(CANONICAL_ARMS.map((a) => [a.id, a]));

  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) {
    throw new Error(
      `AUDIT_MODEL_SHADOW: unknown arm id(s) [${unknown.join(', ')}]; valid: ${[...byId.keys()].join(', ')}`,
    );
  }
  // De-dup while preserving first-seen order.
  const uniqueIds = [...new Set(ids)];
  const selected = uniqueIds.map((id) => byId.get(id));

  const baselineReq = selected.filter((a) => a.isBaseline);
  if (baselineReq.length) {
    throw new Error(
      `AUDIT_MODEL_SHADOW: arm(s) [${baselineReq.map((a) => a.id).join(', ')}] are the production baseline and cannot be shadowed ` +
      `(they run in the real audit, not the observation-only shadow).`,
    );
  }
  return { enabled: true, requested: uniqueIds, arms: selected, all: CANONICAL_ARMS };
}
