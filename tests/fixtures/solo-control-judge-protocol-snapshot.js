/**
 * @fileoverview Frozen snapshot of the cross-family blind-judge protocol as
 * it existed in scripts/solo-control-audit.mjs at fork time — captured
 * VERBATIM (round-6 plan-audit M1 fix: a marker-comment approach would have
 * required editing the frozen file itself, contradicting "must not appear in
 * the implementation diff"). This file is the parity target for
 * tests/blind-judge-fork-parity.test.mjs, which compares
 * scripts/lib/model-eval/blind-judge.mjs's own copies against THIS fixture —
 * never against scripts/solo-control-audit.mjs directly. No import, read, or
 * edit of the frozen file occurs anywhere in this fork.
 *
 * Provenance: scripts/solo-control-audit.mjs lines 1043-1082, as of the
 * Phase 2 redesign fork date (2026-07-11) — the same commit range cited in
 * docs/plans/model-swap-eval-harness.md's Phase 2 File-Level Plan entry.
 * `solo-control-audit.mjs` remains untouched and out of scope for this plan
 * (Audit Trail) — see docs/solo-control-experiment.md for the live
 * experiment this protocol was forked from.
 *
 * Any future drift between this snapshot and blind-judge.mjs's own copies is
 * a deliberate, tested decision (bump this file + the parity test together),
 * never silent divergence — solo-control's historical labels and this
 * harness's labels stay comparable only as long as the taxonomy matches.
 *
 * @module tests/fixtures/solo-control-judge-protocol-snapshot
 */

export const GRADING_LABELS = Object.freeze(['proven', 'actionable', 'plausible', 'false']);

/** Verbatim JSON-Schema-shape mirror of solo-control-audit.mjs's Zod
 * GradingSchema (lines 1043-1052) — kept as a plain shape descriptor here
 * (not a Zod schema) so this fixture has zero runtime dependencies; the
 * parity test re-wraps this into a Zod schema for structural comparison. */
export const GRADING_SCHEMA_SHAPE = Object.freeze({
  gradings: {
    type: 'array',
    item: {
      blind_id: { type: 'string' },
      label: { type: 'enum', values: GRADING_LABELS },
      proof: { type: 'string', optional: true, default: '' },
      cluster: { type: 'string', optional: true, default: '' },
      matches: { type: 'string', optional: true, default: '' },
      pattern: { type: 'string', optional: true, default: '' },
    },
  },
});

// Verbatim from scripts/solo-control-audit.mjs lines 1054-1082.
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

// Verbatim from scripts/solo-control-audit.mjs (JUDGE_SYSTEM's own comment block).
export const SEV_WEIGHTS = Object.freeze({ LOW: 1, MEDIUM: 3, HIGH: 8 });

// Verbatim from scripts/solo-control-audit.mjs (label -> credit factor, JUDGE_SYSTEM's taxonomy).
export const LABEL_FACTORS = Object.freeze({ proven: 1.0, actionable: 0.6, plausible: 0, false: 0 });
