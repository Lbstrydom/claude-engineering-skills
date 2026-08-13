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
// Round-2 (Cluster B) audit M7 fix — imported from contracts.mjs (zod-only,
// no env/FS side effects), NOT route-catalog.mjs (which transitively pulls
// in config.mjs's azureConfig, a real purity violation of this file's own
// "no env side effects" header claim — audit-shadow.mjs's live shadow
// experiment relies on that guarantee).
import { CandidateSpecSchema } from './model-eval/contracts.mjs';
// Internal uses of the vocabulary (the re-export above is the PUBLIC surface;
// a re-export is not an in-scope binding, so the internal reads need this).
// `stagesForArm` is in this list because `attributeStageToArms` (:259, :272)
// CALLS it. A re-export creates no in-scope binding, so omitting it here throws
// `stagesForArm is not defined` at runtime while the module still type-checks
// and still exports the symbol correctly — caught by tests/audit-arms.test.mjs,
// which is why the moved-set contract is asserted on BEHAVIOUR and not on the
// export list alone.
import {
  CANONICAL_ARMS, ARM_IDS, SHARED_STAGES, ARM_SPECIFIC_STAGES, STAGES, stagesForArm,
} from './arm-vocabulary.mjs';

// ── Vocabulary: RE-EXPORTED from shared-lib ─────────────────────────────────
//
// The stage taxonomy, arm ids, CANONICAL_ARMS, `stagesForArm` and `resolveArms`
// moved to `scripts/lib/arm-vocabulary.mjs` (shared-lib) — see that module's
// header for why. They are re-exported here so this module's public surface is
// unchanged and its 13 importers need no edit; the DEFINITION lives there.
//
// Do not re-declare any of these below. A second definition of a vocabulary is
// the drift the single-oracle rule exists to prevent.
export {
  STAGES,
  SHARED_STAGES,
  ARM_SPECIFIC_STAGES,
  ARM_IDS,
  SHADOW_STAGES,
  BASELINE_STAGES,
  CANONICAL_ARMS,
  stagesForArm,
  resolveArms,
} from './arm-vocabulary.mjs';

// ── Arm schema ───────────────────────────────────────────────────────────────
//
// model-swap-eval-harness Phase 3 (round-2 audit H2) — ArmGenerationSchema
// evolved from a flat {modelSentinel, provider, role?} object to a
// discriminated union, so a candidate arm resolved through
// route-catalog.mjs (an Azure deployment, or any future non-sentinel
// route) has its own well-typed member instead of being bolted onto the
// sentinel-shaped enum. `kind:'sentinel'` and `kind:'oss-role'` keep
// EXACTLY the field names/semantics the old flat shape had — every
// existing reader of `arm.generation.provider`/`.modelSentinel` (e.g.
// audit-shadow.mjs) keeps working unchanged for CANONICAL_ARMS A/B/C,
// which never become `kind:'resolved-route'` in this plan (that kind is
// the extension point for a FUTURE candidate-arm slot — Sustainability
// Notes — not something this plan adds to CANONICAL_ARMS today).

// .strict() on every member (matching this repo's established route-catalog.mjs
// pattern — CandidateSpecSchema/AzureRouteEntrySchema) — a stray/misspelled key
// (e.g. a `role` field on a `kind:'sentinel'` arm) is REJECTED, not silently
// stripped by z.object()'s default unknown-key-drop behavior.
const SentinelGeneration = z.object({
  kind: z.literal('sentinel'),
  modelSentinel: z.string().min(1).max(60),
  provider: z.literal('openai'),
}).strict();

// OssRoleGeneration keeps BOTH modelSentinel and role (Gemini round-3 audit
// G2 field-completeness fix) — pickOssModel(role) is how role selects the
// sentinel in the first place, but modelSentinel is what arm-generation.mjs
// actually reads to resolve a client; dropping either breaks generation.
const OssRoleGeneration = z.object({
  kind: z.literal('oss-role'),
  modelSentinel: z.string().min(1).max(60),
  provider: z.literal('oss'),
  role: z.enum(['coder', 'reasoner']),
}).strict();

// The Azure/candidate case — carries route-catalog.mjs's already-resolved
// output directly (never smuggling a deployment id through the sentinel
// field). `candidateSpec` is the ORIGINAL spec that was resolved, kept for
// provenance; `resolvedModel`/`deploymentId` are route-catalog.mjs's output.
const ResolvedRouteGeneration = z.object({
  kind: z.literal('resolved-route'),
  candidateSpec: CandidateSpecSchema,
  resolvedModel: z.string().min(1),
  deploymentId: z.string().nullable(),
}).strict();

export const ArmGenerationSchema = z.discriminatedUnion('kind', [
  SentinelGeneration, OssRoleGeneration, ResolvedRouteGeneration,
]);

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
}).strict() // Round-2 (Cluster B) audit M2 fix — the top-level object was
  // not .strict() even though every generation union member is; a stale/
  // misspelled top-level arm field (e.g. a typo of gptRound) was silently
  // stripped instead of rejected, the same class of gap this file's own
  // generation-union .strict() calls already close one level down.
  .superRefine((arm, ctx) => {
  // The sentinel/role/provider pairing constraints the old superRefine
  // enforced by hand are now structural (the union member itself fixes
  // provider to a literal and requires/forbids role) — only the
  // sentinel-REGISTRY validity check still needs a runtime lookup, and only
  // applies to the two sentinel-carrying kinds. `resolved-route` arms carry
  // an already-resolved `resolvedModel` from route-catalog.mjs, not a
  // sentinel — nothing to validate against the sentinel registry here.
  if (arm.generation.kind === 'resolved-route') return;
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
 * Construct a `kind:'resolved-route'` arm from route-catalog.mjs's
 * `resolveCandidateRoute()` output — declarative only, no I/O. The
 * extension seam for a model-eval candidate/baseline arm (model-swap-eval-
 * harness Phase 3) — NOT wired into CANONICAL_ARMS by this plan (that
 * stays the 3-row A/B/C shadow-experiment data; a model-eval arm is
 * constructed on demand by arm-generation.mjs's callers, never persisted
 * as a 4th canonical row). `id`/`label` default to model-eval-appropriate
 * values rather than trying to fit CANONICAL_ARMS' single-uppercase-letter
 * id convention (`ArmSchema.id`'s regex), since this arm never appears
 * alongside A/B/C in the same scored set.
 * @param {{candidateSpec: object, resolvedModel: string, deploymentId: string|null}} routeCatalogResult
 * @param {{id?: string, label?: string}} [opts]
 * @returns {z.infer<typeof ArmSchema>}
 */
export function buildCandidateArm(routeCatalogResult, { id = 'CAND', label } = {}) {
  return ArmSchema.parse({
    id,
    label: label ?? `resolved-route candidate (${routeCatalogResult.resolvedModel})`,
    generation: {
      kind: 'resolved-route',
      candidateSpec: routeCatalogResult.candidateSpec,
      resolvedModel: routeCatalogResult.resolvedModel,
      deploymentId: routeCatalogResult.deploymentId ?? null,
    },
    gptRound: false,
    geminiGate: false,
    isBaseline: false,
  });
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

