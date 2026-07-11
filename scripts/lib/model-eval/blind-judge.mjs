/**
 * @fileoverview Cross-family blind-judge primitive (Phase 2). Forked from
 * scripts/solo-control-audit.mjs's judge protocol, NOT extracted from it —
 * that file is the live, active solo author-model control experiment
 * (stateful CSV/JSON pipeline, a real experiment mid-run per project
 * memory), untouched and out of scope for this plan (Audit Trail,
 * docs/plans/model-swap-eval-harness.md). This module owns a clean,
 * DB-backed reimplementation of the reusable PROTOCOL (cross-family blind
 * judging): the JUDGE_SYSTEM prompt + grading schema below are VERBATIM
 * copies of solo-control-audit.mjs's own constants as of the fork date —
 * tests/blind-judge-fork-parity.test.mjs pins both this file's copies AND
 * tests/fixtures/solo-control-judge-protocol-snapshot.js (the frozen
 * snapshot) against each other, so future drift is a deliberate, tested
 * decision, never silent divergence that would make solo-control's
 * historical labels and this harness's labels incomparable.
 *
 * `unit` parameterizes the grading payload SHAPE: 'findings-vs-diff'
 * (auditor role — the only unit implemented here) grades a POOLED, BLINDED
 * set of candidate+baseline findings against the full commit diff + a
 * known-defect rubric. 'verdict-vs-finding' (adjudicator role) is reserved,
 * unimplemented future work — not a current dependency of this plan.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 2.
 *
 * @module scripts/lib/model-eval/blind-judge
 */

import { z } from 'zod';
import crypto from 'node:crypto';
import { insertReturning, many } from '../db/query.mjs';
import { isCloudEnabled } from '../store/repo.mjs';
import { resolveEvaluationTier } from './route-catalog.mjs';
import { invokeStructured, MalformedProviderOutputError } from './provider-adapter.mjs';
import { assertEgressSafe } from '../sensitive-egress-gate.mjs';
import { findSensitivePathMentions, EgressGateError } from './egress-path-scan.mjs';
import { classifyLlmError } from '../robustness.mjs';

export { EgressGateError };

export class MalformedJudgeOutputError extends Error {
  constructor(message, { cause } = {}) { super(message, { cause }); this.name = 'MalformedJudgeOutputError'; }
}

// ── Verbatim fork of solo-control-audit.mjs (lines 1043-1082 as of the fork
// date) — see tests/fixtures/solo-control-judge-protocol-snapshot.js for the
// frozen parity target these constants are pinned against. ──────────────────

export const GRADING_LABELS = Object.freeze(['proven', 'actionable', 'plausible', 'false']);

export const GradingSchema = z.object({
  gradings: z.array(z.object({
    blind_id: z.string(),
    label: z.enum(GRADING_LABELS),
    proof: z.string().optional().default(''),
    cluster: z.string().optional().default(''),
    matches: z.string().optional().default(''),
    pattern: z.string().optional().default(''),
  })),
});

export const JUDGE_SYSTEM = [
  'You are a blind code-review adjudicator. You grade a list of findings against',
  'the ACTUAL diff provided below. You do NOT know which of several AI reviewers',
  'produced each finding — grade purely on whether the code supports the claim,',
  'never on writing style or confidence.',
  '',
  'CRITICAL: if the diff below was assembled from multiple chunks, a fragment with',
  'no visible `diff --git` header for a hunk is a CONTINUATION of a file shown',
  'elsewhere in this SAME diff, not evidence the file was deleted or is absent.',
  'Only grade a "file is missing/deleted" claim as proven/actionable if the file',
  'genuinely does not appear ANYWHERE in the diff shown to you.',
  '',
  'Label taxonomy (severity weights LOW=1, MEDIUM=3, HIGH=8):',
  '  proven     (factor 1.0) — direct code evidence confirms the claim exactly; cite file:line in `proof`.',
  '  actionable (factor 0.6) — real, worth-fixing issue, but not a slam-dunk proof; some inference involved.',
  '  plausible  (factor 0)   — could be true, unverifiable from the diff shown.',
  '  false      (factor 0)   — factually wrong against the diff shown.',
  '',
  '`proof` is REQUIRED (file:line or a short repro) whenever severity=HIGH and label is proven or actionable;',
  'otherwise leave it empty. If you cannot produce proof for a HIGH accept, grade it `plausible` instead.',
  '`cluster` — a short tag you choose so that findings describing the SAME underlying defect within this',
  'commit share one value (e.g. "c1", "c2"); reuse a tag across findings you judge to be the same defect.',
  '`matches` — a KD-NNN id from the known-defects rubric below, ONLY if label is proven/actionable AND the',
  'file is in that KD\'s file list AND the finding actually describes that KD\'s defect (not just same file).',
  '`pattern` — optional short tag, ONLY if this finding shares a file/module or violated invariant with',
  'another finding you are ALSO grading in this same batch; otherwise leave empty.',
  '',
  'Grade EVERY blind_id given. Return structured JSON per the schema — nothing else.',
].join('\n');

export const SEV_WEIGHTS = Object.freeze({ LOW: 1, MEDIUM: 3, HIGH: 8 });
export const LABEL_FACTORS = Object.freeze({ proven: 1.0, actionable: 0.6, plausible: 0, false: 0 });

// ── Identity-blinding ────────────────────────────────────────────────────

/**
 * Strips arm/model identity from findings and assigns opaque blind_ids —
 * the judge never sees which side (candidate vs baseline) or which model
 * produced a finding. Shuffled (not candidate-then-baseline order) so batch
 * position itself can't leak identity.
 */
function blindFindings(candidateFindings, baselineFindings) {
  const tagged = [
    ...candidateFindings.map((f) => ({ ...f, _bucket: 'candidate' })),
    ...baselineFindings.map((f) => ({ ...f, _bucket: 'baseline' })),
  ];
  // Deterministic-but-unpredictable shuffle isn't required here — this is
  // identity blinding (removing labels), not a statistical randomization
  // that needs a seed; a stable index-based shuffle is sufficient and keeps
  // the function pure/no-Math.random dependency.
  const shuffled = tagged
    .map((f, i) => ({ f, key: crypto.createHash('sha256').update(`${i}:${f.file || ''}:${f.detail || ''}`).digest('hex') }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.f);
  const blindMap = new Map();
  const blinded = shuffled.map((f, i) => {
    const blindId = `b${i}`;
    blindMap.set(blindId, { bucket: f._bucket, sourceRef: f._sourceRef ?? null });
    return { blind_id: blindId, severity: f.severity, category: f.category, file: f.file, detail: f.detail };
  });
  return { blinded, blindMap };
}

// ── Egress gating (same fail-closed pattern as structured-extractor.mjs) ──

function assertJudgePayloadSafe(userPrompt, label) {
  assertEgressSafe(userPrompt, { label });
  const sensitivePaths = findSensitivePathMentions(userPrompt);
  if (sensitivePaths.length > 0) {
    throw new EgressGateError(`runBlindJudgeProtocol: payload blocked — sensitive path mention(s): ${sensitivePaths.join(', ')}`);
  }
}

// ── DB checkpointing (model_eval_judge_batches — owned exclusively here,
// no other module queries this table directly) ─────────────────────────

/**
 * Round-2 (Cluster B) audit H3 fix — corrected JSDoc: `gradings` here is the
 * `{gradings: object[]}` WRAPPER object (matching GradingSchema's own
 * top-level shape and this file's `resumeExisting.gradings?.gradings`
 * read), never a raw array — the prior annotation (`gradings: object[]`)
 * was misleading (the auditor's own H3 finding cited this exact mismatch,
 * though the runtime binding was already correct: a plain object passes
 * through db/query.mjs's serializeWriteParam unchanged and node-pg
 * natively serializes it to jsonb — only a raw ARRAY needs that seam's
 * JSON.stringify path).
 * @param {{repoId: string, runId: string, commitSha: string|null, unit: string, gradings: {gradings: object[]}, judgeRoute: object}} args
 * @returns {Promise<{ok: boolean, cloud: boolean, batchId: string|null}>}
 */
async function appendJudgeBatch({ repoId, runId, commitSha, unit, gradings, judgeRoute }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, batchId: null };
  try {
    const row = await insertReturning('model_eval_judge_batches', {
      repo_id: repoId,
      run_id: runId,
      commit_sha: commitSha ?? null,
      unit,
      gradings,
      judge_route: judgeRoute,
    }, { returning: ['batch_id'] });
    return { ok: true, cloud: true, batchId: row.batch_id };
  } catch (err) {
    // A concurrent/duplicate grading call for the same (run_id, commit_sha)
    // is a benign race under resume, not a hard failure — the unique index
    // exists exactly to catch this; fetch the row someone else already wrote.
    if (String(err.message).includes('duplicate key') || err.code === '23505') {
      const existing = await getJudgeBatchesForRun({ runId, repoId });
      const match = existing.batches.find((b) => b.commit_sha === commitSha);
      if (match) return { ok: true, cloud: true, batchId: match.batch_id };
    }
    throw err;
  }
}

/**
 * Existing batches for this run — DB-backed resume: a killed/restarted
 * evaluation skips commits already graded instead of re-grading (no CSVs,
 * no .blind-map.json). Scoped by BOTH run_id and repo_id — run_id alone is
 * already a strong scope (a UUID tied to one run), but repo_id is checked
 * too as defense-in-depth, matching this table's own repo-scoping stance.
 * @param {{runId: string, repoId: string}} args
 */
export async function getJudgeBatchesForRun({ runId, repoId }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, batches: [] };
  const rows = await many(
    'SELECT batch_id, commit_sha, unit, gradings, judge_route, created_at FROM model_eval_judge_batches WHERE run_id = $1 AND repo_id = $2 ORDER BY created_at',
    [runId, repoId],
  );
  return { ok: true, cloud: true, batches: rows };
}

// ── Core protocol ────────────────────────────────────────────────────────

/**
 * @param {{runId: string, repoId: string, role: 'auditor'|'adjudicator',
 *   unit: 'findings-vs-diff', candidateFindings: object[], baselineFindings: object[],
 *   knownDefectsRubric: string|null, commitSha: string|null, diff: string,
 *   candidateRoute: object, baselineRoute: object, judgeRoute: object,
 *   signal?: AbortSignal}} args
 * @returns {Promise<{gradings: object[], usage: object|null, batchId: string|null, computedJudgeTier: 'A'|'B'|'C'}>}
 */
export async function runBlindJudgeProtocol({
  runId, repoId, role, unit, candidateFindings, baselineFindings, knownDefectsRubric,
  commitSha = null, diff, candidateRoute, baselineRoute, judgeRoute, signal,
}) {
  if (unit !== 'findings-vs-diff') {
    throw new Error(`runBlindJudgeProtocol: unit "${unit}" is not implemented — only "findings-vs-diff" (auditor role) exists today; "verdict-vs-finding" is reserved future work`);
  }
  // Judge independence — built on route-catalog.mjs's own fail-closed
  // pairwise check, never a second implementation of the same rule. A
  // non-independent judge (same lineage as candidate or baseline, or
  // unknown lineage) degrades computedJudgeTier to 'C' — the caller
  // (model-eval-auditor.mjs) reads this from the return value; this
  // function never silently treats a same-family judge as independent.
  const { computedJudgeTier } = resolveEvaluationTier({ mode: 'comparative', candidateRoute, baselineRoute, judgeRoute });

  const resumeExisting = commitSha ? (await getJudgeBatchesForRun({ runId, repoId })).batches.find((b) => b.commit_sha === commitSha) : null;
  if (resumeExisting) {
    return { gradings: resumeExisting.gradings?.gradings ?? [], usage: null, batchId: resumeExisting.batch_id, computedJudgeTier, resumed: true };
  }

  const { blinded, blindMap } = blindFindings(candidateFindings, baselineFindings);
  const rowsJson = JSON.stringify(blinded, null, 2);
  const userPrompt = [
    commitSha ? `## Commit ${commitSha} — full diff` : '## Diff',
    diff,
    knownDefectsRubric ? `## Known-defect rubric for this commit\n${knownDefectsRubric}` : '## Known-defect rubric for this commit\n(none)',
    `## Findings to grade (blind — ${blinded.length} row(s))`,
    rowsJson,
  ].join('\n\n');
  assertJudgePayloadSafe(userPrompt, `blind-judge:${runId}`);

  const messages = [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: userPrompt },
  ];

  // Two error classes need different handling: a malformed-shape failure
  // (the model didn't follow the schema) is worth ONE retry — a fresh call
  // often self-corrects. A transient infra failure (network/HTTP/timeout)
  // is NOT a judge-output problem and must propagate as-is (classifyLlmError
  // gives the caller's own retry/backoff logic the real category), never be
  // mislabeled as MalformedJudgeOutputError.
  let lastErr;
  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = await invokeStructured({ route: judgeRoute, messages, schema: GradingSchema, signal });
      break;
    } catch (err) {
      lastErr = err;
      const malformedShape = err instanceof z.ZodError || err instanceof SyntaxError || err instanceof MalformedProviderOutputError;
      if (!malformedShape) {
        const { retryable } = classifyLlmError(err);
        if (retryable) throw err;
        throw new MalformedJudgeOutputError(`runBlindJudgeProtocol: non-retryable invocation failure — ${err.message}`, { cause: err });
      }
    }
  }
  if (!result) {
    throw new MalformedJudgeOutputError(`runBlindJudgeProtocol: malformed judge output after retry — ${lastErr?.message}`, { cause: lastErr });
  }

  // Re-attach bucket/sourceRef identity (blinded FROM the judge, not from
  // the caller) so the caller can score candidate-vs-baseline separately.
  const gradingsWithIdentity = result.data.gradings.map((g) => ({
    ...g,
    ...(blindMap.get(g.blind_id) || { bucket: null, sourceRef: null }),
  }));

  const { batchId } = await appendJudgeBatch({
    repoId, runId, commitSha, unit,
    gradings: { gradings: gradingsWithIdentity },
    judgeRoute: { provider: judgeRoute.provider, resolvedModel: judgeRoute.resolvedModel, modelLineage: judgeRoute.modelLineage, lineageSource: judgeRoute.lineageSource },
  });

  return { gradings: gradingsWithIdentity, usage: result.usage, batchId, computedJudgeTier, resumed: false };
}
