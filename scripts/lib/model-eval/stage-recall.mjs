/**
 * @fileoverview Per-stage recall on the known-defect corpus (docs/plans/verification-lessons.md §2.3).
 *
 * The deterministic scorer measures ONE stage: the auditor's raw output. This module measures the three places a defect can be
 * lost between the auditor and the author: `raw` (auditor output), `post-verification` (after dedup / suppression / the
 * existence gate), `final-gate` (after the final reviewer). Each stage's findings are captured as a `stage-findings/v1`
 * artifact; the three artifacts of one run share `runId` + `entryId`, so the join is exact.
 *
 * Matching is `scoreDefectLocalization`, UNCHANGED (same file rule, same jaccard threshold). Because that contract compares a
 * finding's DESCRIPTION with the corpus rubric, a finding with no description is a vacuous non-match; a stage whose findings
 * carry NO description at all is therefore `unmeasured`, never a fabricated 0.
 *
 * Capture is opt-in: `AUDIT_STAGE_CAPTURE_DIR` unset means no write and byte-identical behaviour. `final-gate` runs in a
 * separate process (gemini-review) whose findings are not in the assembling process's memory: it is `not captured` here.
 *
 * @module scripts/lib/model-eval/stage-recall
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { scoreDefectLocalization } from './deterministic-scorer.mjs';

export const STAGE_FINDINGS_VERSION = 'stage-findings/v1';
export const STAGES = Object.freeze(['raw', 'post-verification', 'final-gate']);
export const KNOWN_DEFECTS_PATH = 'docs/experiments/audit-effectiveness/known-defects.json';

const StageFindingSchema = z.object({
  topicId: z.string(),
  file: z.string(),
  line: z.number().int().nullable(),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  // null = the finding predates the tag (legacy / non-LLM): unmeasured, never `nit`.
  importance: z.enum(['important', 'nit']).nullable(),
  // Optional by design: a stage that cannot supply it reports `unmeasuredReason`, not a 0.
  description: z.string().optional(),
}).strict();

export const StageFindingsArtifactSchema = z.object({
  version: z.literal(STAGE_FINDINGS_VERSION),
  runId: z.string().min(1),
  corpusRev: z.string().min(1),
  entryId: z.string().min(1),
  stage: z.enum(STAGES),
  findings: z.array(StageFindingSchema),
}).strict();

/** `file:line` out of a legacy `section`, or the anchor's `newFile:startLine`. */
function locate(f) {
  const anchor = f.anchor ?? f.triggerAnchor;
  if (anchor?.newFile) return { file: anchor.newFile, line: Number.isInteger(anchor.startLine) ? anchor.startLine : null };
  const m = /^(.*?):(\d+)(?:-\d+)?$/.exec(String(f.section ?? ''));
  return m ? { file: m[1], line: Number(m[2]) } : { file: String(f.section ?? ''), line: null };
}

/** Project in-memory pipeline findings onto the artifact's finding shape. */
export function projectStageFindings(findings) {
  return (findings ?? []).map((f) => {
    const out = {
      topicId: String(f.id ?? ''), ...locate(f), severity: f.severity, importance: f.importance ?? null,
    };
    if (typeof f.detail === 'string' && f.detail.length > 0) out.description = f.detail;
    return out;
  });
}

/** Validate and return a `stage-findings/v1` artifact (throws on a malformed one). */
export function buildStageFindingsArtifact({ runId, corpusRev, entryId, stage, findings }) {
  return StageFindingsArtifactSchema.parse({ version: STAGE_FINDINGS_VERSION, runId, corpusRev, entryId, stage, findings: projectStageFindings(findings) });
}

/**
 * The capture point: writes one artifact behind `AUDIT_STAGE_CAPTURE_DIR`. Unset => returns without touching the disk.
 * Binding to a corpus entry comes from `AUDIT_STAGE_CAPTURE_ENTRY_ID` + `AUDIT_STAGE_CAPTURE_CORPUS_REV`; an unbound capture is
 * skipped loudly rather than guessed. NEVER throws: capture must not be able to fail an audit.
 * @returns {{written: boolean, reason: string, file?: string}}
 */
export function captureStageFindings({ stage, runId, findings, env = process.env }) {
  const dir = env.AUDIT_STAGE_CAPTURE_DIR;
  if (!dir) return { written: false, reason: 'capture-off' };
  const entryId = env.AUDIT_STAGE_CAPTURE_ENTRY_ID;
  const corpusRev = env.AUDIT_STAGE_CAPTURE_CORPUS_REV;
  if (!entryId || !corpusRev || !runId) {
    process.stderr.write(`  [stage-capture] ${stage} skipped: AUDIT_STAGE_CAPTURE_ENTRY_ID / AUDIT_STAGE_CAPTURE_CORPUS_REV / run id missing\n`);
    return { written: false, reason: 'unbound' };
  }
  try {
    const artifact = buildStageFindingsArtifact({ runId, corpusRev, entryId, stage, findings });
    fs.mkdirSync(dir, { recursive: true });
    const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
    const file = path.join(dir, `${safe(runId)}.${safe(entryId)}.${stage}.json`);
    atomicWriteFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
    return { written: true, reason: 'written', file };
  } catch (err) {
    process.stderr.write(`  [stage-capture] ${stage} write failed (non-blocking): ${err.message}\n`);
    return { written: false, reason: 'write-failed' };
  }
}

/**
 * The eligible corpus: non-invalidated entries, read at `corpusRev` via `git show` (not the working tree, so a later edit to
 * the corpus cannot change what an old run is scored against).
 */
export function loadEligibleEntries(corpusRev, { cwd = process.cwd(), exec = execFileSync } = {}) {
  const raw = exec('git', ['-C', cwd, 'show', `${corpusRev}:${KNOWN_DEFECTS_PATH}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const corpus = JSON.parse(raw);
  return (corpus.defects ?? []).filter((e) => !e.invalidated);
}

/**
 * @param {{artifacts: object[], entries: object[]}} input `entries` MUST be the eligible set at the artifacts' `corpusRev`.
 * @returns {{corpusRev: string|null, ignoredEntryIds: string[], stages: Record<string, {numerator: number, denominator: number, recall: number|null, unmeasuredReason: string|null}>}}
 */
export function computeStageRecall({ artifacts, entries }) {
  const parsed = artifacts.map((a) => StageFindingsArtifactSchema.parse(a));
  const revs = new Set(parsed.map((a) => a.corpusRev));
  if (revs.size > 1) throw new Error(`computeStageRecall: artifacts disagree on corpusRev (${[...revs].join(', ')})`);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const seen = new Set();
  const ignored = new Set();
  const perStage = Object.fromEntries(STAGES.map((s) => [s, []]));
  for (const a of parsed) {
    const key = `${a.runId}\u0000${a.entryId}\u0000${a.stage}`;
    if (seen.has(key)) throw new Error(`computeStageRecall: duplicate artifact for run ${a.runId}, entry ${a.entryId}, stage ${a.stage}`);
    seen.add(key);
    if (!byId.has(a.entryId)) { ignored.add(a.entryId); continue; }
    perStage[a.stage].push(a);
  }
  const stages = {};
  for (const stage of STAGES) {
    const units = perStage[stage];
    if (units.length === 0) {
      stages[stage] = { numerator: 0, denominator: 0, recall: null, unmeasuredReason: 'stage not captured' };
      continue;
    }
    const all = units.flatMap((u) => u.findings);
    if (all.length > 0 && !all.some((f) => typeof f.description === 'string' && f.description.length > 0)) {
      stages[stage] = { numerator: 0, denominator: units.length, recall: null, unmeasuredReason: 'findings carry no description' };
      continue;
    }
    let numerator = 0;
    for (const u of units) {
      const e = byId.get(u.entryId);
      const candidates = u.findings.map((f) => ({ file: f.file, description: f.description ?? '' }));
      const r = scoreDefectLocalization(candidates, [{ files: e.files ?? [], expectedFindingRubric: e.expectedFindingRubric }]);
      numerator += r.correct;
    }
    stages[stage] = { numerator, denominator: units.length, recall: numerator / units.length, unmeasuredReason: null };
  }
  return { corpusRev: parsed[0]?.corpusRev ?? null, ignoredEntryIds: [...ignored].sort(), stages };
}
