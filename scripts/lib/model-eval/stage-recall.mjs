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
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { scoreDefectLocalization } from './deterministic-scorer.mjs';

export const STAGE_FINDINGS_VERSION = 'stage-findings/v1';
export const STAGES = Object.freeze(['raw', 'post-verification', 'final-gate']);
export const KNOWN_DEFECTS_PATH = 'docs/experiments/audit-effectiveness/known-defects.json';

/** A corpus revision is a FULL commit sha, never a ref: a branch name moves and would re-score an old run against a new corpus. */
export const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
  corpusRev: z.string().regex(FULL_SHA_RE, 'corpusRev must be a full 40/64-hex commit sha, resolved at capture time'),
  entryId: z.string().min(1),
  stage: z.enum(STAGES),
  findings: z.array(StageFindingSchema),
}).strict();

/** `file:line` out of a legacy `section`, or the anchor's file on the side it cites (base => `oldFile`, head => `newFile`). */
function locate(f) {
  const anchor = f.anchor ?? f.triggerAnchor;
  const anchored = anchor?.side === 'base' ? (anchor.oldFile ?? anchor.newFile) : (anchor?.newFile ?? anchor?.oldFile);
  if (anchored) return { file: anchored, line: Number.isInteger(anchor.startLine) ? anchor.startLine : null };
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

const resolvedRevs = new Map();
/**
 * Resolve a corpus revision to a full commit sha ONCE (cached per process), via `git rev-parse --verify <rev>^{commit}`.
 * Throws on anything git cannot resolve to a commit.
 */
export function resolveCorpusRev(rev, { cwd = process.cwd(), exec = execFileSync } = {}) {
  const key = `${cwd}\u0000${rev}`;
  if (resolvedRevs.has(key)) return resolvedRevs.get(key);
  const sha = String(exec('git', ['-C', cwd, 'rev-parse', '--verify', `${rev}^{commit}`], { encoding: 'utf8' })).trim();
  if (!FULL_SHA_RE.test(sha)) throw new Error(`resolveCorpusRev: ${rev} did not resolve to a full commit sha`);
  resolvedRevs.set(key, sha);
  return sha;
}

/** Collision-free artifact name: ids are free text (`run/1` and `run_1` must not share a file), so name by hash. */
export function artifactFileName({ runId, entryId, stage }) {
  return `${crypto.createHash('sha256').update(JSON.stringify([runId, entryId, stage])).digest('hex')}.json`;
}

/**
 * The capture point: writes one artifact behind `AUDIT_STAGE_CAPTURE_DIR`. Unset => returns without touching the disk.
 * Binding to a corpus entry comes from `AUDIT_STAGE_CAPTURE_ENTRY_ID` + `AUDIT_STAGE_CAPTURE_CORPUS_REV`; an unbound capture is
 * skipped loudly rather than guessed. NEVER throws: capture must not be able to fail an audit.
 * @returns {{written: boolean, reason: string, file?: string}}
 */
export function captureStageFindings({ stage, runId, findings, env = process.env, resolveRev = resolveCorpusRev }) {
  const dir = env.AUDIT_STAGE_CAPTURE_DIR;
  if (!dir) return { written: false, reason: 'capture-off' };
  const entryId = env.AUDIT_STAGE_CAPTURE_ENTRY_ID;
  const corpusRevRef = env.AUDIT_STAGE_CAPTURE_CORPUS_REV;
  if (!entryId || !corpusRevRef || !runId) {
    process.stderr.write(`  [stage-capture] ${stage} skipped: AUDIT_STAGE_CAPTURE_ENTRY_ID / AUDIT_STAGE_CAPTURE_CORPUS_REV / run id missing\n`);
    return { written: false, reason: 'unbound' };
  }
  try {
    const corpusRev = resolveRev(corpusRevRef);   // a ref is resolved HERE, once; the artifact stores the sha
    const artifact = buildStageFindingsArtifact({ runId, corpusRev, entryId, stage, findings });
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, artifactFileName({ runId, entryId, stage }));
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
  if (!FULL_SHA_RE.test(String(corpusRev))) throw new Error(`loadEligibleEntries: corpusRev must be a full commit sha, got "${corpusRev}" (a ref is mutable)`);
  const raw = exec('git', ['-C', cwd, 'show', `${corpusRev}:${KNOWN_DEFECTS_PATH}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const corpus = JSON.parse(raw);
  if (!Array.isArray(corpus?.defects)) throw new Error(`loadEligibleEntries: ${KNOWN_DEFECTS_PATH} at ${corpusRev} has no \`defects\` array - refusing to treat an unknown shape as an empty corpus`);
  return corpus.defects.filter((e) => !e.invalidated);
}

const hasDescription = (f) => typeof f.description === 'string' && f.description.length > 0;
/** A unit is scorable in a stage when it found nothing (a real zero) or at least one finding carries a description. */
const describable = (a) => a.findings.length === 0 || a.findings.some(hasDescription);

/**
 * Stages are compared on the SAME units only: a unit is `(runId, entryId)`, and a stage's recall covers only units that are
 * captured AND describable in EVERY captured stage. Everything else is named in `droppedUnits` with its reason.
 * @param {{artifacts: object[], entries: object[]}} input `entries` MUST be the eligible set at the artifacts' `corpusRev`.
 * @returns {{corpusRev: string|null, ignoredEntryIds: string[], droppedUnits: Array<{runId: string, entryId: string, reason: string}>, stages: Record<string, {numerator: number, denominator: number, recall: number|null, unmeasuredReason: string|null}>}}
 */
export function computeStageRecall({ artifacts, entries }) {
  const parsed = artifacts.map((a) => StageFindingsArtifactSchema.parse(a));
  const revs = new Set(parsed.map((a) => a.corpusRev));
  if (revs.size > 1) throw new Error(`computeStageRecall: artifacts disagree on corpusRev (${[...revs].join(', ')})`);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const seen = new Set();
  const ignored = new Set();
  const unitKey = (a) => JSON.stringify([a.runId, a.entryId]);
  const perStage = Object.fromEntries(STAGES.map((st) => [st, new Map()]));   // stage -> unitKey -> artifact
  for (const a of parsed) {
    const key = JSON.stringify([a.runId, a.entryId, a.stage]);
    if (seen.has(key)) throw new Error(`computeStageRecall: duplicate artifact for run ${a.runId}, entry ${a.entryId}, stage ${a.stage}`);
    seen.add(key);
    if (!byId.has(a.entryId)) { ignored.add(a.entryId); continue; }
    perStage[a.stage].set(unitKey(a), a);
  }
  const compared = STAGES.filter((st) => perStage[st].size > 0);
  const allUnits = new Map();
  for (const st of compared) for (const [k, a] of perStage[st]) allUnits.set(k, { runId: a.runId, entryId: a.entryId });
  const droppedUnits = [];
  const joined = [];
  for (const [k, u] of allUnits) {
    const missing = compared.find((st) => !perStage[st].has(k));
    if (missing) { droppedUnits.push({ ...u, reason: `not captured in stage ${missing}` }); continue; }
    const blind = compared.find((st) => !describable(perStage[st].get(k)));
    if (blind) { droppedUnits.push({ ...u, reason: `findings carry no description in stage ${blind}` }); continue; }
    joined.push(k);
  }
  const stages = {};
  for (const stage of STAGES) {
    if (!compared.includes(stage)) {
      stages[stage] = { numerator: 0, denominator: 0, recall: null, unmeasuredReason: 'stage not captured' };
      continue;
    }
    if (joined.length === 0) {
      const blind = droppedUnits.some((d) => d.reason.startsWith('findings carry no description'));
      stages[stage] = { numerator: 0, denominator: 0, recall: null, unmeasuredReason: blind ? 'findings carry no description' : 'no unit captured in every compared stage' };
      continue;
    }
    let numerator = 0;
    for (const k of joined) {
      const u = perStage[stage].get(k);
      const e = byId.get(u.entryId);
      const candidates = u.findings.map((f) => ({ file: f.file, description: f.description ?? '' }));
      numerator += scoreDefectLocalization(candidates, [{ files: e.files ?? [], expectedFindingRubric: e.expectedFindingRubric }]).correct;
    }
    stages[stage] = { numerator, denominator: joined.length, recall: numerator / joined.length, unmeasuredReason: null };
  }
  droppedUnits.sort((a, b) => (a.runId + a.entryId).localeCompare(b.runId + b.entryId));
  return { corpusRev: parsed[0]?.corpusRev ?? null, ignoredEntryIds: [...ignored].sort(), droppedUnits, stages };
}
