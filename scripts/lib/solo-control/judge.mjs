/**
 * @fileoverview The GPT blind-judge call (schema, system prompt, one batch). Extracted from scripts/solo-control-audit.mjs,
 * an over-1000-line file that may not grow. Reads the UNLABELED blind sheet only — never the private map.
 * @module scripts/lib/solo-control/judge
 */
import { z } from 'zod';
import { assertEgressSafe } from '../sensitive-egress-gate.mjs';

export const GradingSchema = z.object({
  gradings: z.array(z.object({
    blind_id: z.string(),
    label: z.enum(['proven', 'actionable', 'plausible', 'false']),
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

/** One GPT grading call over a sub-batch of rows for ONE commit's full diff. */
export async function runGptJudgeBatch(client, zodTextFormat, gptModel, { shortSha, diff, kdBlock, rowsBatch, reasoning }) {
  const rowsJson = JSON.stringify(rowsBatch.map((r) => ({ blind_id: r.blindId, severity: r.severity, category: r.category, file: r.file, detail: r.detail })), null, 2);
  const userPrompt = [
    `## Commit ${shortSha} — full diff`,
    diff,
    kdBlock ? `## Known-defect rubric for this commit\n${kdBlock}` : '## Known-defect rubric for this commit\n(none)',
    `## Findings to grade (blind — ${rowsBatch.length} row(s))`,
    rowsJson,
  ].join('\n\n');
  assertEgressSafe(userPrompt, { label: `judge-gpt:${shortSha}` });
  const params = {
    model: gptModel,
    input: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: userPrompt }],
    text: { format: zodTextFormat(GradingSchema, 'grading') },
    max_output_tokens: 16000,
  };
  if (reasoning) params.reasoning = { effort: reasoning };
  const resp = await client.responses.parse(params);
  // no structured reply is a FAILED batch (the caller logs it and leaves the rows ungraded), never an empty grading list
  if (!resp.output_parsed) throw new Error('judge returned no structured output');
  return { gradings: resp.output_parsed.gradings || [], usage: resp.usage || null };
}
