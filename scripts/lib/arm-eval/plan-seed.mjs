/**
 * @fileoverview Shared plan-generation seed for the plan-authoring experiment.
 *
 * Plan: docs/plans/arm-eval-framework.md §10.2 (Producer contract). Factored so
 * the headless producer (producers/plan.mjs) and the interactive `/plan-*` skill
 * share ONE prompt source — they can't drift, and every arm authors from the
 * IDENTICAL prompt so only the model varies (the experiment's controlled input).
 *
 * The prompt REQUIRES the machine-readable intent block (§10.10 plan-artifact
 * contract) — target paths + a "Section 9 — Acceptance Criteria" stanza — so the
 * objective cross-checks (arch-memory reuse, requirements-invariant) can parse
 * the plan's intent + paths deterministically; a plan lacking it makes those
 * cross-checks return `unavailable`, never a fabricated pass.
 *
 * @module scripts/lib/arm-eval/plan-seed
 */

export const PLAN_SEED_VERSION = '1';

export const PLAN_SYSTEM = [
  'You are a senior software architect writing an implementation PLAN (not code) for the task below.',
  'Apply sound engineering principles: right-sizing (reject both the band-aid and the over-engineered version — the smallest solution that is a true function of the problem), explicit failure modes, data/contract correctness, security + persistence safety, and testability.',
  'Structure the plan with: an overview, design decisions (with rationale), a file-level plan (each file + create/modify + purpose), and risks.',
  'MANDATORY machine-readable blocks (a downstream tool parses them):',
  '  • "## Target Paths" — a bullet list of the concrete file paths the plan will create/modify.',
  '  • "## Section 9 — Acceptance Criteria" — a numbered list of verifiable criteria.',
  'Do NOT identify yourself or your model/provider anywhere in the output (the plan is judged blind).',
].join('\n');

/** Build the plan-generation user prompt from a task (+ optional repo-intent pack). */
export function buildPlanGenPrompt(task, contextPack = null) {
  return [
    `## Task\n${task}`,
    contextPack ? `## Repository context (respect the existing architecture + invariants; reuse existing symbols where possible)\n${contextPack}` : '',
    'Write the plan now.',
  ].filter(Boolean).join('\n\n');
}

/** Parse the machine-readable intent from a generated plan (for cross-checks).
 * Returns { targetPaths:string[], acceptanceCriteria:string[], parseable:boolean }. */
export function parsePlanIntent(planText) {
  if (typeof planText !== 'string') return { targetPaths: [], acceptanceCriteria: [], parseable: false };
  const section = (heading) => {
    const re = new RegExp(`##\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?:\\n##\\s|$)`, 'i');
    const m = re.exec(planText);
    return m ? m[1] : '';
  };
  const bullets = (block) => block.split('\n').map((l) => l.replace(/^\s*[-*\d.]+\s*/, '').trim()).filter(Boolean);
  // Robust path extraction (Gemini gate): LLMs wrap paths in backticks and append
  // annotations (` (create)`, ` — purpose`). The old `/[`(].*$/` stripped at the
  // FIRST backtick → empty for a backtick-wrapped path. Instead: remove backticks,
  // then cut a trailing " (…" / " — …" / ": …" annotation, keep the path token.
  const targetPaths = bullets(section('Target Paths'))
    .map((l) => l.replace(/`/g, '').replace(/\s+[(—].*$/, '').replace(/:\s.*$/, '').trim())
    .filter(Boolean);
  const acceptanceCriteria = bullets(section('Section 9'));
  // BOTH blocks required (Gemini gate fix): the producer mandates Target Paths AND
  // Section 9; an OR would mark a plan missing paths as conformant, then the
  // path-dependent cross-checks (arch-memory/security) degrade to 'unavailable'.
  return { targetPaths, acceptanceCriteria, parseable: targetPaths.length > 0 && acceptanceCriteria.length > 0 };
}
