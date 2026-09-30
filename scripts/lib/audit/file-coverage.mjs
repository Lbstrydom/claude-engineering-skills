/**
 * @fileoverview The file-coverage ledger — every changed file ends an audit with exactly
 * one recorded outcome, and an outcome that means "not examined" is never reported as
 * "examined and clean".
 *
 * ## The defect this closes (storyline field report, 2026-09-30)
 *
 * A 68-file diff held 12 `.cs` files. Two audit rounds and the final review returned
 * APPROVE; not one C# file had been read, and nothing in any output said so. The tool had
 * no concept of per-file coverage: each stage decided silently whether to look at a file,
 * and "did not look" and "looked and found nothing" printed identically.
 *
 * ## Shape of the contract (docs/plans/file-coverage-contract-and-csharp.md §2)
 *
 * `buildCoverageReport` is PURE. Its inputs are measurements taken elsewhere — the VCS
 * change record, admission decisions, per-pass render stats, tool and wave results — and
 * its output is one versioned, strict `_coverage` object:
 *
 *   - `files[]`   the canonical ledger, one record per changed path (uncapped)
 *   - `counts`    RECOMPUTED from `files[]`, never accumulated separately
 *   - `status`    complete | partial | none | incomplete   (derived)
 *   - `gate`      pass | warn | fail                        (derived)
 *
 * Classification (`class`: what kind of file) and outcome (`outcome`: what happened to it)
 * are separate fields, because a profiled file can still be unreadable.
 *
 * ## Read evidence is render evidence, not examination
 *
 * `read.*` says how much of a file a COMPLETED pass was handed. A pass that failed or timed
 * out contributes nothing: rendering a file into a request that never produced a result
 * examined nothing.
 *
 * ## The invariant validator
 *
 * A violated invariant (duplicate identity, an impossible class/outcome pair, `audited`
 * with nothing read, a count that does not match the ledger) sets `status: 'incomplete'`
 * and lists the reason. The builder NEVER emits optimistic totals over a ledger it cannot
 * vouch for.
 *
 * @module scripts/lib/audit/file-coverage
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { normalizePath } from '../file-io.mjs';
import { classifyFileCoverage } from '../language-profiles.mjs';
import { classifyPath } from '../sensitive-paths.mjs';
import { formatCoverageSuffix, shortCoverageFiles } from '../coverage-format.mjs';
import { toolRunConfig } from '../tool-run-config.mjs';
import { TOOL_STATE_PRECEDENCE, TOOL_STATES, worstToolState } from '../tool-states.mjs';

export const COVERAGE_SCHEMA_VERSION = 1;

export const COVERAGE_CLASSES = Object.freeze(['profiled', 'model-only', 'declarative', 'non-code', 'uncovered']);
export const COVERAGE_OUTCOMES = Object.freeze([
  'audited', 'not-admitted', 'excluded-infra', 'excluded-user', 'sensitive', 'deleted', 'unreadable', 'budget-omitted',
]);
export const READ_STATES = Object.freeze(['full', 'head-cut', 'none', 'unknown']);
export const CHANGE_KINDS = Object.freeze(['added', 'modified', 'deleted', 'renamed', 'untracked']);
export const COVERAGE_STATUSES = Object.freeze(['complete', 'partial', 'none', 'incomplete']);
export const COVERAGE_GATES = Object.freeze(['pass', 'warn', 'fail']);

/** Capability states (chunking etc). `degraded` = the analysis bailed out and a coarser fallback was used. */
export const CAP_STATES = Object.freeze(['completed', 'unsupported', 'not_run', 'failed', 'degraded']);

// The tool-state vocabulary lives in shared-lib (tool-states.mjs): the runner speaks it too and must not import this layer.
export { TOOL_STATE_PRECEDENCE, TOOL_STATES, worstToolState };

/** Cross-wave projection of a wave's own richer state (kept in `reason`). */
export const WAVE_STATES = Object.freeze(['completed', 'ineligible', 'partial', 'errored', 'unavailable']);

const PathSchema = z.string().min(1);
const enumOf = (values) => z.enum([...values]);

const PassReadSchema = z.object({
  charsRendered: z.number().int().nonnegative(),
  headCut: z.boolean(),
  passCompleted: z.boolean(),
}).strict();

export const FileRecordSchema = z.object({
  path: PathSchema,
  class: enumOf(COVERAGE_CLASSES),
  language: z.string().nullable(),
  outcome: enumOf(COVERAGE_OUTCOMES),
  reason: z.string().nullable(),
  changeKind: enumOf(CHANGE_KINDS),
  renamedFrom: z.string().nullable(),
  read: z.object({
    state: enumOf(READ_STATES),
    charsOnDisk: z.number().int().nonnegative().nullable(),
    bestCharsRendered: z.number().int().nonnegative().nullable(),
    byPass: z.record(z.string(), PassReadSchema),
  }).strict(),
  changedLinesUnread: z.number().int().nonnegative().nullable(),
  analysis: z.object({
    chunking: enumOf(CAP_STATES).nullable(),
    tools: z.array(z.object({ id: z.string(), status: enumOf(TOOL_STATES) }).strict()),
  }).strict(),
}).strict();

const ToolProjectSchema = z.object({
  path: z.string().nullable(),
  kind: z.string().nullable(),
  status: enumOf(TOOL_STATES),
  reason: z.string().nullable(),
}).strict();

export const CoverageSchema = z.object({
  schemaVersion: z.literal(COVERAGE_SCHEMA_VERSION),
  status: enumOf(COVERAGE_STATUSES),
  gate: enumOf(COVERAGE_GATES),
  changedTotal: z.number().int().nonnegative(),
  counts: z.object({
    byClass: z.record(z.string(), z.number().int().nonnegative()),
    byOutcome: z.record(z.string(), z.number().int().nonnegative()),
    required: z.number().int().nonnegative(),
    examined: z.number().int().nonnegative(),
    short: z.number().int().nonnegative(),
    excludedRequired: z.number().int().nonnegative(),
  }).strict(),
  uncoveredByExtension: z.record(z.string(), z.number().int().nonnegative()),
  files: z.array(FileRecordSchema),
  tools: z.array(z.object({
    id: z.string(),
    profile: z.string().nullable(),
    status: enumOf(TOOL_STATES),
    projects: z.array(ToolProjectSchema),
    filesCovered: z.number().int().nonnegative(),
  }).strict()),
  toolPolicy: z.object({
    disabled: z.boolean(),
    restore: z.boolean().nullable(),
    deadlineMs: z.number().int().nonnegative().nullable(),
    maxProjects: z.number().int().nonnegative().nullable(),
  }).strict(),
  waves: z.array(z.object({
    id: z.string(),
    state: enumOf(WAVE_STATES),
    eligible: z.number().int().nonnegative().nullable(),
    changed: z.number().int().nonnegative().nullable(),
    reason: z.string().nullable(),
  }).strict()),
  invariantViolations: z.array(z.string()),
}).strict();

// ── The recorder: what the passes measure while they run ────────────────────

/**
 * Accumulates per-pass render stats and per-file chunking states DURING an audit. The passes
 * call `recordRead` at every reader call site and `markPass` when the pass ends; the builder
 * reads the result. A pass that never calls `markPass(name, true)` is NOT completed, so a
 * crashed pass cannot vouch for anything it rendered.
 *
 * @returns {{recordRead: Function, markPass: Function, recordChunking: Function,
 *   passes: Map<string, {completed: boolean, stats: object[]}>, chunking: Map<string, string>}}
 */
export function createCoverageRecorder() {
  const passes = new Map();
  const chunking = new Map();
  const entry = (name) => {
    if (!passes.has(name)) passes.set(name, { completed: false, stats: [] });
    return passes.get(name);
  };
  return {
    passes,
    chunking,
    /** @param {string} pass @param {object|null} stats readFilesAs*Detailed().stats */
    recordRead(pass, stats) { if (stats) entry(pass).stats.push(stats); },
    /** @param {string} pass @param {boolean} completed */
    markPass(pass, completed) { entry(pass).completed = !!completed; },
    /** @param {string} filePath @param {string} state one of CAP_STATES */
    recordChunking(filePath, state) { chunking.set(normalizePath(filePath), state); },
  };
}

/**
 * The measured reader a pass calls instead of `readFilesAs*Context`: byte-identical output (the string readers wrap the same
 * code), plus the render stats recorded under the pass's name. `getDiffMap` is read at call time (the diff is parsed after this
 * is created); `annotated` selects the diff-annotated reader.
 *
 * @param {{recordRead: Function}} recorder
 * @param {() => Map|null} getDiffMap
 * @param {{plain: Function, annotated: Function}} readers the two *Detailed readers, injected to keep this module import-light
 * @returns {(pass: string, files: string[], opts: object, annotated?: boolean) => string}
 */
export function makeRenderFor(recorder, getDiffMap, { plain, annotated }) {
  return (pass, files, opts, useAnnotated = false) => {
    const { context, stats } = useAnnotated ? annotated(files, getDiffMap(), opts) : plain(files, opts);
    recorder.recordRead(pass, stats);
    return context;
  };
}

/**
 * Start measuring an audit: the recorder, the measured reader, and the chunking observer wired together. One call so the
 * orchestrator (over the size limit) carries one line, not three.
 *
 * @returns {{recorder: object, renderFor: Function}}
 */
export function startCoverage({ getDiffMap, plain, annotated, setChunkingObserver }) {
  const recorder = createCoverageRecorder();
  setChunkingObserver((filePath, state) => recorder.recordChunking(filePath, state));
  return { recorder, renderFor: makeRenderFor(recorder, getDiffMap, { plain, annotated }) };
}

/** The ledger's inputs as `finding-assembly` takes them (`data.coverageInput`). `changed`: VCS record, else the explicit list. */
export function makeCoverageInput({ recorder, coverageChanged, changedFiles, fileFilter, coverageExcluded, diffMap, toolCapability, noTools }) {
  return {
    recorder,
    changed: coverageChanged ?? (changedFiles.length > 0 ? changedFiles : (fileFilter ?? [])),
    excludedInfra: coverageExcluded?.infra ?? [],
    excludedUser: coverageExcluded?.user ?? [],
    hunks: diffMap ? new Map([...diffMap].map(([k, v]) => [k, v.hunks])) : null,
    tools: toolCapability.coverageTools ?? [],
    // the policy the tools ran under, recorded beside their results (`_coverage.toolPolicy`)
    toolPolicy: { disabled: !!noTools, restore: toolRunConfig.restore, deadlineMs: toolRunConfig.deadlineMs, maxProjects: 6 },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function ext(filePath) {
  const base = String(filePath).replace(/\\/g, '/').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '(no extension)';
}

/** Lines of `text` covered by its first `chars` characters. */
function linesInPrefix(text, chars) {
  let n = 0;
  const end = Math.min(chars, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) n++;
  return n + 1;
}

/**
 * Best render evidence for one path across all recorded passes.
 * Only COMPLETED passes count toward `state` and `bestCharsRendered`; every pass that
 * requested the path is kept in `byPass` as evidence.
 */
function readEvidence(key, passes) {
  const byPass = {};
  let charsOnDisk = null;
  let bestFull = false;
  let bestChars = null;
  let requestedByAny = false;
  let unreadableIn = false;
  let budgetOmittedIn = false;
  let anyStats = false;
  for (const [name, p] of passes) {
    for (const st of p.stats) {
      anyStats = true;
      const inFull = (st.full || []).some((f) => normalizePath(f) === key);
      const cut = (st.headTruncated || []).find((h) => normalizePath(h.path) === key);
      const inUnreadable = (st.unreadable || []).some((f) => normalizePath(f) === key);
      const inBudget = (st.budgetOmitted || []).some((f) => normalizePath(f) === key);
      if (inUnreadable) { unreadableIn = true; requestedByAny = true; }
      if (inBudget) { budgetOmittedIn = true; requestedByAny = true; }
      if (!inFull && !cut) continue;
      requestedByAny = true;
      if (cut && (charsOnDisk === null || cut.charsOnDisk > charsOnDisk)) charsOnDisk = cut.charsOnDisk;
      // One entry per pass, best render wins: a full render supersedes a head-cut one within the same pass.
      const prev = byPass[name];
      byPass[name] = {
        charsRendered: Math.max(prev?.charsRendered ?? 0, cut ? cut.charsRendered : 0),
        headCut: (prev ? prev.headCut : true) && !!cut,
        passCompleted: p.completed,
      };
      if (p.completed) {
        if (inFull) bestFull = true;
        if (cut) bestChars = Math.max(bestChars ?? 0, cut.charsRendered);
      }
    }
  }
  // A full render's `charsRendered` is the file's size when we know it, else 0 (the reader reports full files by path only).
  for (const v of Object.values(byPass)) if (!v.headCut) v.charsRendered = charsOnDisk ?? 0;
  let state;
  if (!anyStats) state = 'unknown';
  else if (bestFull) state = 'full';
  else if (bestChars !== null) state = 'head-cut';
  else state = 'none';
  return {
    state, charsOnDisk, bestCharsRendered: bestFull ? (charsOnDisk ?? null) : bestChars,
    byPass, requestedByAny, unreadableIn, budgetOmittedIn,
  };
}

// ── The builder ─────────────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {Array<string|{path: string, changeKind?: string, renamedFrom?: string|null}>} input.changed
 *   the VCS change record (git --name-status -z), in order
 * @param {Iterable<string>} [input.excludedInfra] paths refused as audit infrastructure
 * @param {Iterable<string>} [input.excludedUser] paths excluded by --exclude-paths / .auditignore
 * @param {{passes: Map, chunking: Map}|null} [input.recorder] measured render evidence
 * @param {Array<object>} [input.tools] `{id, profile, status, projects:[{path,kind,status,reason,files}], filesCovered}`
 * @param {Array<object>} [input.waves] `{id, state, eligible, changed, reason}`
 * @param {object|null} [input.toolPolicy]
 * @param {Map<string, Array<{startLine:number, lineCount:number}>>|null} [input.hunks] new-side hunks by path
 * @param {(p: string) => boolean} [input.existsOnDisk]
 * @param {(p: string) => string|null} [input.readText] for measuring unread changed lines
 * @returns {object} a CoverageSchema-valid `_coverage`
 */
export function buildCoverageReport(input) {
  const {
    changed = [], excludedInfra = [], excludedUser = [], recorder = null, tools = [], waves = [],
    toolPolicy = null, hunks = null,
    existsOnDisk = (p) => fs.existsSync(p),
    readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
  } = input || {};

  const infra = new Set([...excludedInfra].map((p) => normalizePath(p)));
  const user = new Set([...excludedUser].map((p) => normalizePath(p)));
  const passes = recorder?.passes ?? new Map();
  const chunking = recorder?.chunking ?? new Map();
  const violations = [];

  // Normalised identity → first record wins; a duplicate input is reported, not silently merged.
  const seen = new Map();
  for (const raw of changed) {
    const rec = typeof raw === 'string' ? { path: raw } : raw;
    if (!rec || typeof rec.path !== 'string' || rec.path === '') continue;
    const key = normalizePath(rec.path);
    if (seen.has(key)) { violations.push(`duplicate changed path (identity ${key})`); continue; }
    seen.set(key, rec);
  }

  const files = [];
  for (const [key, rec] of seen) {
    const cls = classifyFileCoverage(rec.path);
    const changeKind = CHANGE_KINDS.includes(rec.changeKind) ? rec.changeKind : 'modified';
    const ev = readEvidence(key, passes);
    let outcome;
    let reason = null;
    if (changeKind === 'deleted') outcome = 'deleted';
    else if (infra.has(key)) outcome = 'excluded-infra';
    else if (user.has(key)) outcome = 'excluded-user';
    else if (classifyPath(rec.path) === 'sensitive') outcome = 'sensitive';
    else if (cls.class === 'non-code' || cls.class === 'uncovered') outcome = 'not-admitted';
    else if (!existsOnDisk(rec.path)) { outcome = 'unreadable'; reason = 'not on disk'; }
    else if (ev.state === 'full' || ev.state === 'head-cut') outcome = 'audited';
    // No render evidence at all is NOT "audited": nothing here can vouch that a pass ever saw the file.
    else if (ev.state === 'unknown') { outcome = 'unreadable'; reason = 'no render evidence recorded'; }
    else if (ev.unreadableIn) { outcome = 'unreadable'; reason = 'the reader could not read it'; }
    else if (ev.budgetOmittedIn) { outcome = 'budget-omitted'; reason = 'context budget spent before it was rendered'; }
    else { outcome = 'unreadable'; reason = ev.requestedByAny ? 'no completed pass rendered it' : 'no pass requested it'; }

    // Changed lines beyond the best completed render — null unless we can actually measure it.
    let changedLinesUnread = null;
    const fileHunks = hunks?.get?.(key) ?? hunks?.get?.(rec.path) ?? null;
    if (outcome === 'audited' && ev.state === 'full') changedLinesUnread = 0;
    else if (outcome === 'audited' && ev.state === 'head-cut' && Array.isArray(fileHunks) && fileHunks.length > 0) {
      const text = readText(rec.path);
      if (typeof text === 'string') {
        const rendered = linesInPrefix(text, ev.bestCharsRendered ?? 0);
        let unread = 0;
        for (const h of fileHunks) {
          const end = h.startLine + Math.max(1, h.lineCount) - 1;
          if (end > rendered) unread += end - Math.max(h.startLine, rendered + 1) + 1;
        }
        changedLinesUnread = Math.max(0, unread);
      }
    }

    const fileTools = [];
    for (const t of tools) {
      for (const proj of t.projects || []) {
        if ((proj.files || []).some((f) => normalizePath(f) === key)) fileTools.push({ id: t.id, status: proj.status });
      }
    }

    files.push({
      path: rec.path.replace(/\\/g, '/'),
      class: cls.class,
      language: cls.language,
      outcome,
      reason,
      changeKind,
      renamedFrom: rec.renamedFrom ?? null,
      read: {
        state: ev.state,
        charsOnDisk: ev.charsOnDisk,
        bestCharsRendered: ev.bestCharsRendered,
        byPass: ev.byPass,
      },
      changedLinesUnread,
      analysis: { chunking: chunking.get(key) ?? null, tools: fileTools },
    });
  }

  // ── denominator matrix (plan §2) ────────────────────────────────────────
  const byClass = Object.fromEntries(COVERAGE_CLASSES.map((c) => [c, 0]));
  const byOutcome = Object.fromEntries(COVERAGE_OUTCOMES.map((o) => [o, 0]));
  const uncoveredByExtension = {};
  let required = 0;
  let examined = 0;
  let auditedRequired = 0;
  let presentRequired = 0;
  let excludedRequired = 0;
  const reviewable = new Set(['profiled', 'model-only', 'declarative']);

  for (const f of files) {
    byClass[f.class]++;
    byOutcome[f.outcome]++;
    if (f.class === 'uncovered') { const e = ext(f.path); uncoveredByExtension[e] = (uncoveredByExtension[e] || 0) + 1; }

    // impossible cells
    const excluded = f.outcome === 'excluded-infra' || f.outcome === 'excluded-user';
    if (f.outcome === 'audited' && f.read.state === 'none') violations.push(`${f.path}: audited with nothing read`);
    if ((f.class === 'non-code' || f.class === 'uncovered') && f.outcome === 'audited') violations.push(`${f.path}: ${f.class} file recorded as audited`);
    if (reviewable.has(f.class) && f.outcome === 'not-admitted') violations.push(`${f.path}: ${f.class} file recorded as not-admitted`);
    if (f.class === 'uncovered' && !['not-admitted', 'deleted', 'sensitive'].includes(f.outcome) && !excluded) violations.push(`${f.path}: uncovered file with outcome ${f.outcome}`);

    if (reviewable.has(f.class)) {
      if (excluded) { excludedRequired++; continue; }
      if (f.outcome === 'sensitive') { required++; presentRequired++; continue; }
      required++;
      if (f.outcome !== 'deleted') presentRequired++;
      if (f.outcome === 'audited') auditedRequired++;
      const wholly = f.outcome === 'audited'
        && (f.read.state === 'full' || (f.read.state === 'head-cut' && f.changedLinesUnread === 0));
      if (wholly) examined++;
    } else if (f.class === 'uncovered' && f.outcome === 'not-admitted') {
      required++;
      presentRequired++;
    }
  }
  const short = required - examined;

  // ── derivations ─────────────────────────────────────────────────────────
  let status;
  if (violations.length > 0) status = 'incomplete';
  // `none` = the change was not MEASURED at all: no present required file was audited. A file that was audited
  // but head-cut is `partial` (short, visible in the suffix), not `none` — failing a round because a large file
  // exceeds the per-file read window would make every repo with a big file unable to converge.
  else if (presentRequired > 0 && auditedRequired === 0) status = 'none';
  else if (short > 0) status = 'partial';
  else status = 'complete';
  let gate;
  if (status === 'none' || status === 'incomplete') gate = 'fail';
  else if (status === 'partial' || excludedRequired > 0) gate = 'warn';
  else gate = 'pass';

  const report = {
    schemaVersion: COVERAGE_SCHEMA_VERSION,
    status,
    gate,
    changedTotal: files.length,
    counts: { byClass, byOutcome, required, examined, short, excludedRequired },
    uncoveredByExtension,
    files,
    tools: tools.map((t) => ({
      id: t.id,
      profile: t.profile ?? null,
      status: t.status ?? worstToolState((t.projects || []).map((p) => p.status)),
      projects: (t.projects || []).map((p) => ({ path: p.path ?? null, kind: p.kind ?? null, status: p.status, reason: p.reason ?? null })),
      filesCovered: t.filesCovered ?? 0,
    })),
    toolPolicy: {
      disabled: !!toolPolicy?.disabled,
      restore: toolPolicy?.restore ?? null,
      deadlineMs: toolPolicy?.deadlineMs ?? null,
      maxProjects: toolPolicy?.maxProjects ?? null,
    },
    waves: waves.map((w) => ({
      id: w.id, state: w.state, eligible: w.eligible ?? null, changed: w.changed ?? null, reason: w.reason ?? null,
    })),
    invariantViolations: violations,
  };
  return report;
}

/**
 * Validate a `_coverage` value against the strict schema AND re-derive its counts from `files[]`.
 * Returns `{ok:true}` or `{ok:false, problems}` — used by consumers (audit-loop, the transcript
 * projection, tests) that must not trust a ledger they did not build.
 */
export function validateCoverage(cov) {
  const parsed = CoverageSchema.safeParse(cov);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  const problems = [];
  const c = parsed.data;
  if (c.changedTotal !== c.files.length) problems.push(`changedTotal ${c.changedTotal} != files.length ${c.files.length}`);
  const ids = new Set();
  for (const f of c.files) {
    const k = normalizePath(f.path);
    if (ids.has(k)) problems.push(`duplicate identity ${k}`);
    ids.add(k);
  }
  const recount = {};
  for (const f of c.files) recount[f.outcome] = (recount[f.outcome] || 0) + 1;
  for (const [o, n] of Object.entries(c.counts.byOutcome)) {
    if ((recount[o] || 0) !== n) problems.push(`counts.byOutcome.${o} ${n} != recount ${recount[o] || 0}`);
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

// ── The VCS change record ───────────────────────────────────────────────────

const STATUS_KIND = { A: 'added', M: 'modified', D: 'deleted', T: 'modified', U: 'modified' };

/**
 * Parse `git diff --name-status -z` output into change records. NUL-delimited, so a path with spaces, quotes or
 * a newline survives (a newline-split parse of `--name-only` does not). A rename or copy (`R100` / `C075`) carries
 * TWO paths — old then new; the record is the NEW path with `renamedFrom` set, because that is the file present
 * in the working tree. Change kind comes from git, never from filesystem presence.
 *
 * @param {string} output raw stdout
 * @throws {Error} on a truncated or structurally invalid stream — a caller must not read a short list as a complete one
 * @returns {Array<{path: string, changeKind: string, renamedFrom: string|null}>}
 */
export function parseNameStatusZ(output) {
  const text = String(output || '');
  if (text === '') return [];
  // Every field is NUL-TERMINATED: a stream that does not end in NUL was cut off mid-record.
  if (!text.endsWith('\0')) throw new Error('name-status output is not NUL-terminated (truncated)');
  const tokens = text.slice(0, -1).split('\0');
  const records = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i];
    const code = status[0];
    if (!status || !/^[A-Z]/.test(status)) throw new Error('name-status record has no status code');
    const arity = code === 'R' || code === 'C' ? 3 : 2;
    if (i + arity > tokens.length) throw new Error(`name-status record "${status}" is missing path field(s)`);
    const paths = tokens.slice(i + 1, i + arity);
    if (paths.some((p) => !p)) throw new Error(`name-status record "${status}" has an empty path`);
    if (arity === 3) records.push({ path: paths[1], changeKind: code === 'R' ? 'renamed' : 'added', renamedFrom: paths[0] });
    else records.push({ path: paths[0], changeKind: STATUS_KIND[code] || 'modified', renamedFrom: null });
    i += arity;
  }
  return records;
}

// ── Presentation ────────────────────────────────────────────────────────────
// The wording lives in coverage-format.mjs (dependency-free, so the pure final-review envelope can import it);
// re-exported here so callers have one import for the ledger.
export { formatCoverageSuffix, shortCoverageFiles };


/**
 * The reviewer-facing projection of `_coverage` (audit-plan R2-H1): counts, status and gate are the
 * canonical ones, computed before projection; only `files[]` is cut, to every record that is short
 * of full coverage (capped), plus a digest of the FULL ledger so the projection is checkable.
 *
 * @param {object} cov a validated `_coverage`
 * @param {{maxShown?: number, digest?: (s: string) => string}} [opts]
 */
export function projectCoverageForReview(cov, { maxShown = 200, digest } = {}) {
  if (!cov || !Array.isArray(cov.files)) return cov;
  const hash = digest ?? ((text) => crypto.createHash('sha256').update(text).digest('hex'));
  const shortFiles = shortCoverageFiles(cov);
  const shown = shortFiles.slice(0, maxShown);
  return {
    ...cov,
    files: undefined,
    filesProjection: {
      projection: true,
      fullCount: cov.files.length,
      digest: hash(JSON.stringify(cov.files)),
      shortTotal: shortFiles.length,
      shown,
      shownTruncated: Math.max(0, shortFiles.length - shown.length),
    },
  };
}
