/**
 * @fileoverview Arm-evaluation experiment configs + rubric + self-preference guard.
 *
 * Plan: docs/plans/arm-eval-framework.md (D1, D2, D8, §10.2). The unified
 * blinded-Claude-judge framework compares whether an OSS combination beats the
 * proprietary baseline, across THREE experiments. This module is the DATA layer:
 * per-experiment arm sets + the scoring rubric + validation. PURE — no I/O.
 *
 * Load-bearing invariant (D1 / self-preference guard): **Claude is the JUDGE,
 * never an arm.** An arm whose any model resolves to the Anthropic/Claude family
 * is a hard error — otherwise the judge would grade its own homework. The guard
 * runs at import over the canonical configs (fail-fast) and is re-exported for
 * the runner to re-assert on any operator-supplied arm.
 *
 * Model refs (D0 / §1a): GPT + Gemini legs use SENTINELS (`latest-gpt`,
 * `latest-pro`); the OSS candidates are named CONCRETELY as versioned experiment
 * DATA (e.g. `z-ai/glm-5.2`) — the "sentinels-only" anti-pin rule protects the
 * PRODUCTION auditor from staleness, but an experiment whose entire purpose is
 * "compare model X vs Y vs Z" must name X/Y/Z. resolveModel() passes concrete
 * ids through unchanged, so no resolver alias is required.
 *
 * @module scripts/lib/arm-eval/experiments
 */

import { z } from 'zod';
import { describeModel, resolveModel } from '../model-resolver.mjs';

// ── Rubric (D2 / §4) — shared core + per-experiment extensions ───────────────
// The two INTENT dimensions require the D8 repo-intent context pack; absent it
// the judge marks them `unscored` (never a fabricated score) — see judge.mjs.
export const RUBRIC_CORE = Object.freeze([
  'correctness', 'completeness', 'risk_handling', 'right_sizing', 'clarity',
  'architectural_coherence', 'repo_intent_fidelity',
]);
export const RUBRIC_INTENT_DIMS = Object.freeze(['architectural_coherence', 'repo_intent_fidelity']);
export const RUBRIC_EXT = Object.freeze({
  'plan-authoring': Object.freeze(['implementability', 'acceptance_criteria_quality', 'reuse']),
  brainstorm: Object.freeze(['insight', 'angle_diversity', 'actionability']),
  auditor: Object.freeze([]), // the auditor experiment scores via finding adjudication, not this rubric
});

/** Full ordered dimension list for an experiment (core + its extension). */
export function rubricFor(experimentType) {
  const ext = RUBRIC_EXT[experimentType];
  if (!ext) throw new Error(`rubricFor: unknown experiment "${experimentType}"`);
  return [...RUBRIC_CORE, ...ext];
}

// ── Schemas ──────────────────────────────────────────────────────────────────

export const ArmSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,23}$/, 'arm id: alphanumeric, ≤24 chars'),
  label: z.string().min(1).max(120),
  // One or more model refs (sentinel or concrete id). A single-model arm is the
  // simple author; a multi-model arm is a combination (e.g. brainstorm D=GPT+Gemini).
  models: z.array(z.string().min(1)).min(1).max(4),
  role: z.enum(['author', 'combination']).default('author'),
});

export const ExperimentSchema = z.object({
  experimentType: z.enum(['plan-authoring', 'brainstorm', 'auditor']),
  baselineArm: z.string().min(1),
  arms: z.array(ArmSchema).min(2),
  // Objective cross-checks (D8/§10.5) this experiment runs alongside the rubric.
  crossChecks: z.array(z.enum(['audit-proxy', 'arch-memory-reuse', 'requirements-invariant', 'security-incident'])).default([]),
}).superRefine((exp, ctx) => {
  const ids = exp.arms.map((a) => a.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', path: ['arms'], message: 'arm ids must be unique' });
  }
  if (!ids.includes(exp.baselineArm)) {
    ctx.addIssue({ code: 'custom', path: ['baselineArm'], message: `baselineArm "${exp.baselineArm}" is not one of the arms` });
  }
});

// ── Self-preference guard (D1 — load-bearing) ────────────────────────────────

/**
 * True iff a model ref resolves to the Anthropic/Claude family. The guard uses
 * this to REJECT any arm containing a Claude model (the judge must never grade a
 * sibling of its own family). Resolves sentinels first, then classifies.
 * @param {string} modelRef
 */
export function isClaudeFamily(modelRef) {
  let concrete;
  try { concrete = resolveModel(modelRef, { silent: true }); }
  catch { concrete = modelRef; }
  const d = describeModel(concrete);
  if (d && d.provider === 'anthropic') return true;
  // Defence-in-depth: describeModel returns null for unrecognised ids, so also
  // do a literal check for the family markers (covers ids the parser misses).
  return /(^|\/)(claude|anthropic)|(^|[-/])(opus|sonnet|haiku)([-/]|$)/i.test(String(concrete));
}

/**
 * Validate one arm. Returns {ok, arm} | {ok:false, error}. Enforces the schema
 * AND the self-preference guard (no Claude model in any arm).
 */
export function validateArm(raw) {
  const r = ArmSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const claude = r.data.models.filter(isClaudeFamily);
  if (claude.length) {
    return { ok: false, error: `arm "${r.data.id}" contains Claude-family model(s) [${claude.join(', ')}] — Claude is the JUDGE, never an arm (self-preference guard, D1)` };
  }
  return { ok: true, arm: r.data };
}

/** Validate a whole experiment config (schema + every arm's self-preference guard). */
export function validateExperiment(raw) {
  const r = ExperimentSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  for (const arm of r.data.arms) {
    const a = validateArm(arm);
    if (!a.ok) return { ok: false, error: a.error };
  }
  return { ok: true, experiment: r.data };
}

// ── Canonical experiments (DATA — the current comparison sets) ────────────────
//
// OSS candidates named concretely (versioned data, per the header note). GLM-5.2
// is the primary OSS (leads Intelligence Index + SWE-bench Pro, cheaper than the
// GPT baseline — plan D0); DeepSeek-v4-pro (cheapest) + Qwen3.7-max are rotation
// candidates the operator can enable. The `auditor` experiment is the already-
// shipped harness (findings-adjudication scored) — referenced here for the shared
// framework but NOT re-implemented; its arms live in audit-arms.mjs.

export const CANONICAL_EXPERIMENTS = Object.freeze({
  'plan-authoring': Object.freeze({
    experimentType: 'plan-authoring',
    baselineArm: 'GPT',
    arms: Object.freeze([
      Object.freeze({ id: 'GPT', label: 'GPT author (baseline)', models: Object.freeze(['latest-gpt']), role: 'author' }),
      Object.freeze({ id: 'OSS-GLM', label: 'GLM-5.2 author (primary OSS)', models: Object.freeze(['z-ai/glm-5.2']), role: 'author' }),
      Object.freeze({ id: 'OSS-DS', label: 'DeepSeek-v4-pro author (cost rotation)', models: Object.freeze(['deepseek/deepseek-v4-pro']), role: 'author' }),
    ]),
    crossChecks: Object.freeze(['audit-proxy', 'arch-memory-reuse', 'requirements-invariant', 'security-incident']),
  }),
  brainstorm: Object.freeze({
    experimentType: 'brainstorm',
    baselineArm: 'D',
    arms: Object.freeze([
      Object.freeze({ id: 'D', label: 'GPT + Gemini (baseline)', models: Object.freeze(['latest-gpt', 'latest-pro']), role: 'combination' }),
      Object.freeze({ id: 'E', label: 'GLM-5.2 + Gemini', models: Object.freeze(['z-ai/glm-5.2', 'latest-pro']), role: 'combination' }),
      Object.freeze({ id: 'F', label: 'GLM-5.2 + GPT', models: Object.freeze(['z-ai/glm-5.2', 'latest-gpt']), role: 'combination' }),
    ]),
    crossChecks: Object.freeze([]),
  }),
});

/** Optional OSS rotation candidates (concrete ids) an operator can swap into the
 * OSS arm slot to compare OSS models directly — never Claude (guarded). */
export const OSS_ROTATION = Object.freeze(['z-ai/glm-5.2', 'deepseek/deepseek-v4-pro', 'qwen/qwen3.7-max']);

// Fail-fast: a bad edit to a canonical experiment surfaces at import, not at spend.
for (const [key, exp] of Object.entries(CANONICAL_EXPERIMENTS)) {
  const v = validateExperiment(exp);
  if (!v.ok) throw new Error(`[arm-eval] canonical experiment "${key}" is invalid: ${v.error}`);
}

/** Look up a canonical experiment by type (throws on unknown). */
export function getExperiment(experimentType) {
  const exp = CANONICAL_EXPERIMENTS[experimentType];
  if (!exp) throw new Error(`getExperiment: unknown experiment "${experimentType}"; valid: ${Object.keys(CANONICAL_EXPERIMENTS).join(', ')}`);
  return exp;
}
