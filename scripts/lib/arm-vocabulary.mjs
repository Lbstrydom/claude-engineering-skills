/**
 * @fileoverview The audit-arm vocabulary — the single definition, in shared-lib.
 *
 * ## Why it lives here and not in `audit-arms.mjs`
 *
 * `audit-arms.mjs` is a **mixed** module: a domain-neutral *vocabulary* (the
 * stage taxonomy, the arm ids, the three canonical arm rows) welded to
 * audit-orchestration *coordination* (Zod schemas, `buildCandidateArm`,
 * `executionPlan`, `attributeStageToArms`). `d5e66d35` (2026-08-10) retagged the
 * whole file to `audit-orchestration`, which is right about the coordination
 * half and wrong about the vocabulary half — four modules in three other
 * domains reach in here for nothing but frozen data:
 *
 * | Importer | Domain | Wanted |
 * |---|---|---|
 * | `store/model-ab.mjs` | `stores` | `CANONICAL_ARMS`, `stagesForArm` |
 * | `arm-eval/toggle.mjs` | `arm-eval` | `resolveArms` |
 * | `model-ab-decision.mjs` | `model-eval` | `ARM_IDS` |
 *
 * Each of those read as a feature domain depending on audit-orchestration. The
 * retag did not create the coupling — it *revealed* it, by giving the vocabulary
 * a domain of its own for the first time.
 *
 * This is the same move, for the same reason, as
 * [`status-vocabulary.mjs`](./status-vocabulary.mjs) (a `stores -> plan` edge)
 * and [`preview-gate-vocabulary.mjs`](./preview-gate-vocabulary.mjs) (a
 * `shared-lib -> audit-orchestration` edge, extracted by `d5e66d35` itself).
 * Both headers record the rule this follows:
 *
 * > **A vocabulary shared across a layer boundary belongs to neither side.**
 *
 * The repo's stated preference order is **refactor > retag > declare**, and
 * `d5e66d35` put it plainly: *"when the primitive is innocent, refactor beats
 * retag."* The primitive is innocent here.
 *
 * ## What is in here, and what deliberately is not
 *
 * Everything below is **Zod-free at runtime** — the `z.infer` annotations in
 * `audit-arms.mjs` are JSDoc only, so lifting these drags in no schema and no
 * `model-eval/contracts.mjs` dependency. That property is what makes the split
 * possible at all, and it is asserted rather than assumed: this module has
 * **no imports**, by design.
 *
 * Left in `audit-arms.mjs`: `ArmSchema`, `ArmGenerationSchema`, `parseArm`
 * (validates at runtime), `buildCandidateArm`, `executionPlan`,
 * `attributeStageToArms` — everything needing Zod or reasoning about an arm
 * *set* rather than the vocabulary itself. `audit-arms.mjs` re-exports this
 * module's surface, so its existing importers are unaffected.
 *
 * Plan: [god-module-and-layering-debt.md](../../docs/plans/god-module-and-layering-debt.md)
 * decision 2.
 *
 * @module scripts/lib/arm-vocabulary
 */

// ── Stage taxonomy (SSoT — the store, view, and shadow all reference these) ──
export const STAGES = Object.freeze(['gpt-gen', 'oss-gen', 'gpt-round', 'gemini']);

// Attribution class split (model-ab-harness-v2 plan H1) — the hybrid rule's SSoT.
//   SHARED       : one execution serves >=1 arm; membership DERIVED from stage.
//   ARM_SPECIFIC : each execution belongs to ONE arm; requires an explicit `arm`
//                  tag (null => hard error, fail-closed).
export const SHARED_STAGES = Object.freeze(['gpt-gen', 'oss-gen']);
export const ARM_SPECIFIC_STAGES = Object.freeze(['gpt-round', 'gemini']);

// Valid arm ids (the CHECK domain mirrored in the migration).
export const ARM_IDS = Object.freeze(['A', 'B', 'C']);

// Stages a SHADOW execution can produce (arms B/C): oss-gen (shared), gpt-round
// (B only), gemini (B + C, arm-specific). The baseline arm A runs in the
// PRODUCTION pipeline (gpt-gen + its own gemini), never the shadow.
export const SHADOW_STAGES = Object.freeze(['oss-gen', 'gpt-round', 'gemini']);
export const BASELINE_STAGES = Object.freeze(['gpt-gen', 'gemini']);

/**
 * The three canonical arms — data, not behaviour.
 *
 *   A = GPT audit -> Gemini review               (production control)
 *   B = OSS audit -> 1 GPT round -> Gemini review (does the GPT round earn its keep? — vs C)
 *   C = OSS audit -> Gemini review               (can OSS+Gemini replace GPT+Gemini? — vs A)
 */
export const CANONICAL_ARMS = Object.freeze([
  Object.freeze({
    id: 'A',
    label: 'GPT audit → Gemini review (production control)',
    generation: Object.freeze({ kind: 'sentinel', modelSentinel: 'latest-gpt', provider: 'openai' }),
    gptRound: false,
    geminiGate: true,
    isBaseline: true,
  }),
  Object.freeze({
    id: 'B',
    label: 'OSS audit → 1 GPT round → Gemini review (does the GPT round earn its keep?)',
    generation: Object.freeze({ kind: 'oss-role', modelSentinel: 'latest-oss-reasoner', provider: 'oss', role: 'reasoner' }),
    gptRound: true,
    geminiGate: true,
    isBaseline: false,
  }),
  Object.freeze({
    id: 'C',
    label: 'OSS audit → Gemini review (can OSS+Gemini replace GPT+Gemini?)',
    generation: Object.freeze({ kind: 'oss-role', modelSentinel: 'latest-oss-reasoner', provider: 'oss', role: 'reasoner' }),
    gptRound: false,
    geminiGate: true,
    isBaseline: false,
  }),
]);

/**
 * Derive the ordered set of stages an arm's config produces findings at.
 * The scorer view derives arm membership from the SAME rule (model-ab-harness-v2
 * decision 10). Branches on `generation.kind` (model-swap-eval-harness Phase 3),
 * not `generation.provider` — `resolved-route` arms carry no `provider` field.
 * A `resolved-route` arm is treated as `gpt-gen`-shaped: like `sentinel`, it is
 * driven through an OpenAI-SDK-shaped client (`createOpenAIClient`,
 * arm-generation.mjs), unlike `oss-role`'s distinct OSS-pool call path — only
 * `oss-role` is a genuinely different generation stage.
 *
 * @param {{generation: {kind: string}, gptRound: boolean, geminiGate: boolean}} arm
 * @returns {string[]}
 */
export function stagesForArm(arm) {
  const stages = [arm.generation.kind === 'oss-role' ? 'oss-gen' : 'gpt-gen'];
  if (arm.gptRound) stages.push('gpt-round');
  if (arm.geminiGate) stages.push('gemini');
  return stages;
}

/**
 * Parse `AUDIT_MODEL_SHADOW` into the selected observation-only arm set.
 *
 * Pure over `CANONICAL_ARMS` + the env object it is handed — no ambient
 * `process.env` read beyond the default parameter, no I/O. Carried here rather
 * than left behind because a vocabulary module owning its own pure predicates is
 * the established shape (`preview-gate-vocabulary.mjs::isPreviewGateMode`).
 *
 * Contract:
 *   - unset/empty → `{enabled:false, arms:[]}` (byte-identical-to-today path).
 *   - unknown arm id → THROW (validation error — never silently drop; the
 *     operator asked to spend on an arm that doesn't exist).
 *   - the baseline arm (A) → THROW (it's the production audit, not a shadow
 *     target — shadowing it would double-run the real audit).
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {{enabled:boolean, requested:string[], arms:Array<object>, all:ReadonlyArray<object>}}
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
