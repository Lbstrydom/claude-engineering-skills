/**
 * @fileoverview Arm-config model for the model-A/B/C auditor experiment.
 *
 * Plan: docs/plans/model-ab-experiment-harness.md (decision 2 — "arms are DATA,
 * not code; models are SENTINELS, not concrete IDs"). An arm is a config row
 * describing an auditor configuration to compare; the 3 canonical arms A/B/C
 * are data here. This module is PURE — no env side effects beyond reading the
 * env object passed to `resolveArms`, no LLM/network/FS. It defines the shape,
 * validates it (Zod), derives the produced-finding STAGES per arm (the scorer
 * view's arm-membership derivation must agree with this), and parses
 * `AUDIT_MODEL_SHADOW` into the selected observation-only arm set.
 *
 * Stages a finding can be produced by (attribution — plan decision 10):
 *   - `gpt-gen`   : a GPT 5-pass generation round (the production baseline, arm A)
 *   - `oss-gen`   : an OSS 5-pass generation round (arms B/C, shared compute)
 *   - `gpt-round` : one INDEPENDENT GPT 5-pass round injected as the final round (B/C)
 *   - `gemini`    : the Gemini final gate (A and C)
 *
 * Arm membership is DERIVED from stages, never stored per finding:
 *   A = {gpt-gen, gemini}   B = {oss-gen, gpt-round}   C = B ∪ {gemini}
 * B and C share the same oss-gen + gpt-round execution (C only ADDS gemini) —
 * this is why a produced finding is stored once and the view expands it to the
 * arms whose config includes its stage (no B/C double-count).
 *
 * @module scripts/lib/audit-arms
 */

import { z } from 'zod';
import { isSentinel, SENTINEL_TO_TIER } from './model-resolver.mjs';

// ── Stage taxonomy (SSoT — the store, view, and shadow all reference these) ──
export const STAGES = Object.freeze(['gpt-gen', 'oss-gen', 'gpt-round', 'gemini']);

// Stages a SHADOW execution can produce (arms B/C). The baseline arm A's
// findings come from the PRODUCTION pipeline (a separate provenance), NOT the
// shadow — this split is what disambiguates the `gemini` stage, which both A
// and C nominally include (audit R1 H3/H6): a `gemini` row from the baseline
// belongs to A only; a `gemini` row from the shadow belongs to C only. See
// attributeStageToArms — the view MUST attribute via (stage × provenance),
// never stage alone.
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
    label: 'GPT ×5 + Gemini gate (production control)',
    generation: Object.freeze({ modelSentinel: 'latest-gpt', provider: 'openai' }),
    gptRound: false,
    geminiGate: true,
    isBaseline: true,
  }),
  Object.freeze({
    id: 'B',
    label: 'OSS ×5 + 1 independent GPT round (no Gemini)',
    generation: Object.freeze({ modelSentinel: 'latest-oss-coder', provider: 'oss', role: 'coder' }),
    gptRound: true,
    geminiGate: false,
    isBaseline: false,
  }),
  Object.freeze({
    id: 'C',
    label: 'OSS ×5 + 1 GPT round + Gemini gate (reuses B)',
    generation: Object.freeze({ modelSentinel: 'latest-oss-coder', provider: 'oss', role: 'coder' }),
    gptRound: true,
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
 * Attribute a produced finding to the arm id(s) it belongs to, using BOTH the
 * producing stage AND its provenance (baseline pipeline vs shadow) — never
 * stage alone (audit R1 H3/H6). This is the canonical rule the scorer view
 * derives arm membership from:
 *   - provenance 'baseline' : gpt-gen/gemini → ['A']       (production A only)
 *   - provenance 'shadow'   : oss-gen/gpt-round → ['B','C'], gemini → ['C']
 * So a `gemini` row is A when produced by the baseline final review and C when
 * produced by the shadow's arm-C gate — the shared stage name is disambiguated
 * by where the row came from, so no finding is double-attributed.
 *
 * Fail-CLOSED (audit R3 H5): an unknown `stage` or `provenance` (omitted, typo,
 * or an impossible pair) THROWS rather than silently returning `[]` — a mis-call
 * that dropped a finding from every arm would be silent attribution loss (the
 * exact class the store must never hit). A VALID stage that legitimately maps to
 * no arm for that provenance (e.g. shadow `gpt-gen`) still returns `[]`.
 *
 * @param {string} stage
 * @param {{provenance:'baseline'|'shadow'}} opts
 * @returns {string[]} arm ids
 */
export function attributeStageToArms(stage, { provenance } = {}) {
  if (provenance !== 'baseline' && provenance !== 'shadow') {
    throw new Error(`attributeStageToArms: provenance must be 'baseline' | 'shadow', got ${JSON.stringify(provenance)}`);
  }
  if (!STAGES.includes(stage)) {
    throw new Error(`attributeStageToArms: unknown stage ${JSON.stringify(stage)}; valid: ${STAGES.join(', ')}`);
  }
  // DERIVE membership from CANONICAL_ARMS (single source — audit R4 M3/M6): an
  // arm owns this stage iff its baseline-ness matches the provenance AND the
  // stage is in its stagesForArm(). No hardcoded A/B/C lists to drift.
  const wantBaseline = provenance === 'baseline';
  return CANONICAL_ARMS
    .filter((arm) => arm.isBaseline === wantBaseline && stagesForArm(arm).includes(stage))
    .map((arm) => arm.id);
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
