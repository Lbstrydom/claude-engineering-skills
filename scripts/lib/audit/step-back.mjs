/**
 * @fileoverview The STEP-BACK contract (docs/plans/verification-lessons.md §2.4):
 * the output schema of the fresh-context reviewer, the deterministic context
 * pack it reads, the state-machine record the card keeps, and a runner whose
 * provider is injected (nothing here makes a model call by itself).
 *
 * **No `continue`.** The schema is a discriminated union of `structural`, `stop`
 * and `defect`; a bare continue is unrepresentable, so a reviewer that has
 * nothing to say fails validation instead of silently admitting another round.
 *
 * **Egress (Tier 3).** `buildStepBackPack` is the one place repo content is
 * assembled for a model API. Every file goes through `resolveAndClassify`
 * (sensitive, escaped-repo or unresolvable => excluded and COUNTED via
 * `formatSkipLog`; fail closed) and every body — plus the plan, ledger and round
 * results — through `redactSecrets` before it can leave the machine. Importer
 * scanning classifies a file BEFORE reading it, so a sensitive file is never
 * opened for its imports either.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/step-back
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveAndClassify, formatSkipLog } from '../sensitive-paths.mjs';
import { redactSecrets } from '../secret-patterns.mjs';
import { parseImports, resolveSpecifier, RESOLVABLE_EXTENSIONS } from '../module-graph.mjs';
import { findingFiles } from '../concern-identity.mjs';
import { defaultTopicOf } from './round-signals.mjs';

export const STEP_BACK_VERSION = 1;

// ── (a) the output schema ────────────────────────────────────────────────────

const nonEmpty = z.string().trim().min(1);

export const StepBackSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('structural'), files: z.array(nonEmpty).min(1) }),
  z.strictObject({ action: z.literal('stop'), items: z.array(z.strictObject({ topicId: nonEmpty, premise: nonEmpty })).min(1) }),
  z.strictObject({ action: z.literal('defect'), topicId: nonEmpty, evidenceNeeded: nonEmpty }),
]);

export const STEP_BACK_ACTIONS = Object.freeze(['structural', 'stop', 'defect']);

export const STEP_BACK_SYSTEM_PROMPT = [
  'You are a fresh-context reviewer stepping back from an audit loop that has not converged.',
  'You are given the plan, the audit ledger and round results up to a checkpoint, and the files the findings cite with their one-hop neighbours.',
  'Decide ONE of: (1) structural - the findings are symptoms of a missing shared primitive or design; name the files; (2) stop - the remaining findings rest on a false premise or are marginal; list each topicId with the premise that fails; (3) defect - exactly one real defect remains; name its topicId and the evidence needed.',
  'There is NO "continue" option. If you cannot justify one of the three, pick defect for the single most credible topicId.',
  'Reply with ONLY a JSON object, one of:',
  '{"action":"structural","files":["path",...]}',
  '{"action":"stop","items":[{"topicId":"...","premise":"..."}]}',
  '{"action":"defect","topicId":"...","evidenceNeeded":"..."}',
].join('\n');

/**
 * Validate raw reviewer output. Accepts the object, or JSON text (optionally in a code fence).
 * @returns {{ok: true, output: object}|{ok: false, error: string}}
 */
export function parseStepBackOutput(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    const t = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { value = JSON.parse(t); } catch (err) { return { ok: false, error: `not JSON (${err.message})` }; }
  }
  const r = StepBackSchema.safeParse(value);
  return r.success ? { ok: true, output: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ').slice(0, 400) };
}

// ── (b) the context pack ─────────────────────────────────────────────────────

export const PACK_LIMITS = Object.freeze({ perFileChars: 60_000, totalChars: 600_000, maxImporterScan: 5000, maxArchNeighbours: 8 });

/** Import scanning is bound to what the module graph can resolve (its own extension list), not a list kept here; JSON is resolvable but has no imports. */
export const isImportScannable = (rel) => RESOLVABLE_EXTENSIONS.some((e) => e !== '.json' && rel.endsWith(e));
const looksLikePath = (s) => typeof s === 'string' && s.length < 260 && !/\s/.test(s) && /[\w-]\.[A-Za-z0-9]{1,6}$/.test(s);
const posix = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

/** Every file path the findings cite (normalised, sorted). */
export function citedFilesOf(rounds) {
  const out = new Set();
  for (const r of rounds || []) for (const f of r.findings || []) for (const x of findingFiles(f)) if (looksLikePath(x)) out.add(posix(x));
  return [...out].sort();
}

/** Classify one path; returns `{ok, canonical}` or `{ok: false, skip}` where skip fits `formatSkipLog`. Fails closed. */
function classifyForEgress(rel, { repoRoot, fsImpl }) {
  let res;
  try { res = resolveAndClassify(rel, { repoRoot, fs: fsImpl }); } catch (err) {
    return { ok: false, skip: { path: rel, category: 'sensitive', pattern: `classification-error:${err?.code || 'unknown'}`, action: 'excluded' } };
  }
  if (res.category === 'sensitive') {
    const pattern = res.resolutionFailed ? 'resolution-failed' : res.escapedRepo ? 'escaped-repo' : (res.lexical === 'sensitive' ? 'sensitive-path' : 'sensitive-symlink-target');
    return { ok: false, skip: { path: rel, category: 'sensitive', pattern, action: 'excluded' }, unreadable: res.resolutionFailed };
  }
  return { ok: true, canonical: res.canonical };
}

const redact = (s) => redactSecrets(String(s ?? '')).text;

/**
 * Build the deterministic context pack. Same inputs => byte-identical `text`.
 *
 * @param {object} a
 * @param {string} a.repoRoot - the revision's tree (a detached worktree in the replay)
 * @param {string|null} a.planFile - repo-relative or absolute plan path
 * @param {object[]} a.ledgerEntries - the checkpoint's ledger snapshot entries
 * @param {Array<{round: number, auditedSha?: string|null, verdict?: string, findings: object[]}>} a.rounds - results up to the checkpoint
 * @param {string[]} a.repoFiles - tracked repo-relative files of that revision (for import resolution)
 * @param {(args: {files: string[], intent: string}) => Promise<object[]>|object[]} [a.archNeighbours] - injectable
 * @param {object} [a.fsImpl] - injectable fs (tests)
 * @returns {Promise<{text: string, files: Array<{path: string, role: string, chars: number, truncated: boolean}>,
 *   skipped: object[], skipLog: string[], excluded: {sensitive: number, unreadable: number}, notes: string[]}>}
 */
export async function buildStepBackPack({ repoRoot, planFile = null, ledgerEntries = [], rounds = [], repoFiles = [], archNeighbours = null, fsImpl = fs, limits = PACK_LIMITS, topicOf = defaultTopicOf }) {
  const root = path.resolve(repoRoot);
  const notes = [];
  const skipped = [];
  const classified = new Map(); // rel -> {ok, canonical}|{ok:false}
  const classify = (rel) => {
    if (!classified.has(rel)) {
      const c = classifyForEgress(rel, { repoRoot: root, fsImpl });
      classified.set(rel, c);
      if (!c.ok) skipped.push({ ...c.skip, unreadable: !!c.unreadable });
    }
    return classified.get(rel);
  };
  const readBody = (rel) => {
    const c = classify(rel);
    if (!c.ok) return null;
    try { return redact(fsImpl.readFileSync(c.canonical, 'utf8')); } catch { skipped.push({ path: rel, category: 'sensitive', pattern: 'read-failed', action: 'excluded', unreadable: true }); return null; }
  };

  const cited = citedFilesOf(rounds);
  const repoSet = new Set(repoFiles.map(posix));
  const imports = new Map(); // file -> role
  const importersOf = new Map();
  for (const rel of cited) {
    const body = readBody(rel);
    if (body == null || !isImportScannable(rel)) continue;
    for (const spec of parseImports(body)) {
      const r = resolveSpecifier({ fromFile: rel, specifier: spec, repoFiles: repoSet });
      if (r.kind === 'repo' && r.resolved && !cited.includes(r.resolved)) imports.set(r.resolved, 'import-of-cited');
    }
  }
  // Importers: scan code files; each is classified BEFORE it is read.
  const citedSet = new Set(cited);
  const scan = [...repoSet].filter((f) => isImportScannable(f) && !citedSet.has(f)).sort();
  if (scan.length > limits.maxImporterScan) notes.push(`importer scan truncated to ${limits.maxImporterScan} of ${scan.length} code files`);
  for (const rel of scan.slice(0, limits.maxImporterScan)) {
    const c = classify(rel); if (!c.ok) continue;
    let body; try { body = fsImpl.readFileSync(c.canonical, 'utf8'); } catch { continue; }
    for (const spec of parseImports(body)) {
      const r = resolveSpecifier({ fromFile: rel, specifier: spec, repoFiles: repoSet });
      if (r.kind === 'repo' && citedSet.has(r.resolved)) importersOf.set(rel, 'importer-of-cited');
    }
  }

  const sections = [];
  const fileMeta = [];
  let budget = limits.totalChars;
  const addFile = (rel, role) => {
    const body = readBody(rel); if (body == null) return;
    const truncated = body.length > limits.perFileChars || body.length > budget;
    const shown = body.slice(0, Math.max(0, Math.min(limits.perFileChars, budget)));
    budget -= shown.length;
    fileMeta.push({ path: rel, role, chars: shown.length, truncated });
    sections.push(`<file path="${rel}" role="${role}"${truncated ? ' truncated="true"' : ''}>\n${shown}\n</file>`);
  };

  if (planFile) {
    const rel = posix(path.isAbsolute(planFile) ? path.relative(root, planFile) : planFile);
    const body = readBody(rel);
    if (body != null) sections.push(`<plan path="${rel}">\n${body}\n</plan>`); else notes.push('plan file was excluded or unreadable');
  }
  sections.push(`<ledger>\n${redact(JSON.stringify(ledgerEntries, null, 1))}\n</ledger>`);
  const roundView = (rounds || []).map((r) => ({
    round: r.round, auditedSha: r.auditedSha ?? null, verdict: r.verdict ?? null,
    findings: (r.findings || []).map((f) => ({ id: f.id, severity: f.severity, category: f.category, section: f.section, detail: f.detail, topicId: f.topicId ?? topicOf(f), files: [...findingFiles(f)] })),
  }));
  sections.push(`<rounds>\n${redact(JSON.stringify(roundView, null, 1))}\n</rounds>`);
  for (const rel of cited) addFile(rel, 'cited');
  for (const rel of [...imports.keys()].sort()) addFile(rel, imports.get(rel));
  for (const rel of [...importersOf.keys()].sort()) addFile(rel, importersOf.get(rel));

  if (typeof archNeighbours === 'function') {
    const allowed = fileMeta.filter((f) => f.role === 'cited').map((f) => f.path); // only files that passed the gate
    try {
      const items = (await archNeighbours({ files: allowed, intent: `Understand the design around: ${allowed.join(', ')}` })) || [];
      sections.push(`<arch-neighbours>\n${redact(JSON.stringify(items.slice(0, limits.maxArchNeighbours), null, 1))}\n</arch-neighbours>`);
    } catch (err) { notes.push(`arch-memory neighbours unavailable (${String(err?.message || err).slice(0, 80)})`); }
  } else notes.push('arch-memory neighbours: not queried');

  const skipLog = formatSkipLog(skipped, { logger: 'step-back-pack' });
  const excluded = { sensitive: skipped.filter((s) => !s.unreadable).length, unreadable: skipped.filter((s) => s.unreadable).length };
  return { text: sections.join('\n\n'), files: fileMeta, skipped, skipLog, excluded, notes };
}

// ── (d) the state machine record ─────────────────────────────────────────────

export const STEP_BACK_STATES = Object.freeze(['signals-quiet', 'signals-fired', 'step-back-valid', 'step-back-invalid', 'step-back-unavailable']);

/**
 * The record at a checkpoint, from the computed signals. `signals-quiet` with
 * `triggerMeasured: false` is NOT a clean bill: an unmeasured signal never reads as quiet.
 */
export function initialStepBackRecord({ round, signals }) {
  return {
    version: STEP_BACK_VERSION, round, state: signals.anyFires ? 'signals-fired' : 'signals-quiet',
    triggerMeasured: signals.unmeasured.length === 0, unmeasured: [...signals.unmeasured],
    next: signals.anyFires ? { roundAdmitted: false, decision: 'operator runs --step-back' } : { roundAdmitted: true, decision: 'next round as today' },
    debtWritten: false,
  };
}

/** Reduce a reviewer outcome onto the record. Pure; `stop` never writes debt, `invalid`/`unavailable` never admit a round. */
export function applyStepBackOutcome(record, outcome) {
  if (record.state !== 'signals-fired') throw new Error(`step-back outcome applied in state ${record.state} (only signals-fired accepts one)`);
  if (outcome.kind === 'valid') {
    const o = outcome.output;
    const next = o.action === 'structural' ? { roundAdmitted: false, decision: 'route files to /plan or a fleet proposal', files: o.files }
      : o.action === 'stop' ? { roundAdmitted: false, decision: 'stop proposed; debt only after human approval', items: o.items, debtWrite: 'pending-human-approval' }
        : { roundAdmitted: true, decision: 'round runs with a focus note', focusNote: { topicId: o.topicId, evidenceNeeded: o.evidenceNeeded } };
    return { ...record, state: 'step-back-valid', output: o, next, debtWritten: false };
  }
  if (outcome.kind === 'invalid') {
    return { ...record, state: 'step-back-invalid', raw: outcome.raw ?? null, error: outcome.error, next: { roundAdmitted: false, decision: 'the step-back did not happen; the human decides' } };
  }
  return { ...record, state: 'step-back-unavailable', reason: outcome.reason, next: { roundAdmitted: false, decision: 'the step-back did not happen; the human decides' } };
}

/** Human approval of a proposed stop. The only way debt intents appear. */
export function approveStop(record, { by }) {
  if (record.state !== 'step-back-valid' || record.output?.action !== 'stop') throw new Error('approveStop: record is not a valid stop proposal');
  if (!by || typeof by !== 'string') throw new Error('approveStop: an approver is required');
  return { ...record, stopApproval: { by } };
}

/** Debt-capture intents for an APPROVED stop; `[]` for anything else (a stop never writes debt by itself). */
export function stopDebtIntents(record) {
  if (!record?.stopApproval?.by || record.output?.action !== 'stop') return [];
  return record.output.items.map((i) => ({ topicId: i.topicId, deferredReason: `step-back stop: ${i.premise}`, approvedBy: record.stopApproval.by }));
}

/**
 * Run the reviewer through an INJECTED provider and reduce the result onto the record.
 * @param {{record: object, pack: {text: string}, provider: (a: {system: string, user: string, model: string|null}) => Promise<{text: string, usage?: object}>, model?: string|null}} a
 * @returns {Promise<{record: object, usage: object|null}>}
 */
export async function runStepBack({ record, pack, provider, model = null }) {
  if (typeof provider !== 'function') return { record: applyStepBackOutcome(record, { kind: 'unavailable', reason: 'no provider route' }), usage: null };
  let res;
  try { res = await provider({ system: STEP_BACK_SYSTEM_PROMPT, user: pack.text, model }); } catch (err) {
    return { record: applyStepBackOutcome(record, { kind: 'unavailable', reason: String(err?.message || err).slice(0, 200) }), usage: null };
  }
  const parsed = parseStepBackOutput(res?.text ?? res?.output);
  const outcome = parsed.ok ? { kind: 'valid', output: parsed.output } : { kind: 'invalid', raw: res?.text ?? null, error: parsed.error };
  return { record: applyStepBackOutcome(record, outcome), usage: res?.usage ?? null };
}
