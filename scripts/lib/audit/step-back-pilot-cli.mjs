/**
 * @fileoverview The `step-back-replay.mjs` Pilot 1 command bodies (docs/plans/seeded-defect-benchmark.md §1.4, §2, §6):
 * `freeze --pilot meta-ab`, `continue`, `reconcile`, `calibrate-draw`, `calibrate-score`, `novelty`, `worksheet`, `score --pilot meta-ab`.
 * Kept out of the CLI file so `step-back-replay.mjs` stays a thin dispatcher.
 *
 * Every spend goes through the provider-call seams under ONE budget ledger (`AUDIT_BUDGET_LEDGER`, `llm-budget.mjs`): the
 * hard `--max-usd` is enforced per call from provider usage, never from a preflight estimate, and a run that hits its cap
 * stops (exit 5). A paid `continue` refuses to run outside a `npm run fixture:create` worktree (a spend-bearing run pins its revision).
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/step-back-pilot-cli
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ArgvError } from '../cli-io.mjs';
import { atomicWriteFileSync } from '../file-io.mjs';
import { withCaseTree } from '../model-eval/case-tree.mjs';
import { resolveMainRoot, defaultFixtureRoot } from '../pinned-worktree/paths.mjs';
import { initLedger, readLedgerSummary, reconcileCall, BUDGET_LEDGER_ENV } from '../llm-budget.mjs';
import { createJudge, judgePairs, classifyNovelty, stampMismatch } from '../model-eval/concern-matcher.mjs';
import { drawCalibrationSets, renderWorksheet, joinWorksheetLabels, scoreCalibration } from '../model-eval/matcher-calibration.mjs';
import { freezeMetaPilot, assertPartition, pointsFor, verifySnapshots, seededShuffle } from './step-back-pilot-freeze.mjs';
import { runContinuation, ledgerTargets, restorePointFiles, validateTrigger, resolveScopeBase, sidFor, EXIT_BUDGET_STOP } from './step-back-continuation.mjs';
import { decideMetaPilotBothJudges, scoreMetaRuns, SEEDED_BENCH_EPOCH } from './meta-pilot-decision.mjs';

export const PILOT = 'meta-ab';
export const LABELS = Object.freeze(['REAL', 'WRONG', 'NOT_A_DEFECT', 'RIGOUR_CHASING', 'UNDETERMINED']);
const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); atomicWriteFileSync(p, `${JSON.stringify(o, null, 2)}\n`); };
export const snapshotsPathFor = (datasetPath) => datasetPath.replace(/\.json$/, '') + '.snapshots.json';

/** Append + fsync: once this returns the record is on the device. */
export function appendDurably(file, text) {
  const fd = fs.openSync(file, 'a');
  try { const buf = Buffer.from(text); let off = 0; while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function loadDataset(datasetPath) {
  const dataset = readJson(datasetPath);
  if (dataset.kind !== 'meta-ab') throw new ArgvError(`${datasetPath} is not a meta-ab pilot dataset`);
  const snapshots = readJson(snapshotsPathFor(datasetPath));
  verifySnapshots({ dataset, snapshots }); assertPartition(dataset);
  return { dataset, snapshots };
}

/** A spend-bearing run pins its revision: the process must run inside a fixture (a sibling `<repo>-pinned/<name>`), never the shared tree. */
export function assertPinnedFixture(cwd = process.cwd()) {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  const root = defaultFixtureRoot(resolveMainRoot(cwd));
  const rel = path.relative(root, path.resolve(top));
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') throw new ArgvError(`a paid run must run from a pinned fixture under ${root} (npm run fixture:create); this tree is ${top}`);
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8' }).trim();
  if (dirty) throw new ArgvError(`the fixture has uncommitted changes to tracked files; a pinned run must be at its recorded revision:\n${dirty.slice(0, 300)}`);
  return { top, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() };
}

/** The mapped name must be the clone's own origin (`owner/name`): authorisation binds to the repository, not to a typed label. */
export function verifyRepoIdentity(r, { git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } = {}) {
  let url;
  try { url = git(r.localPath, ['remote', 'get-url', 'origin']); } catch { return { ok: false, reason: `its local clone ${r.localPath} has no readable origin remote` }; }
  // Host AND owner/name: a same-named repository on another host is not the authorised one.
  const m = /^(?:https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|(?:ssh:\/\/)?[^@/]+@([^/:]+)[:/])([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  const host = (m?.[1] ?? m?.[2] ?? '').toLowerCase();
  if (host !== 'github.com') return { ok: false, reason: `its clone's origin host is ${host || '(unparseable)'}, not github.com` };
  const slug = m?.[3];
  return slug && slug.toLowerCase() === String(r.name).toLowerCase() ? { ok: true } : { ok: false, reason: `its clone's origin is ${slug ?? url}` };
}

// ── freeze ───────────────────────────────────────────────────────────────────────────────────────────

export function runFreeze({ exports, reposFile, seed, out, targets, verifyRepo = verifyRepoIdentity }) {
  if (!exports.length || !reposFile || !seed || !out) throw new ArgvError('step-back-replay freeze --pilot meta-ab: --export <csv>, --repos-file, --seed and --out are required.');
  const merged = { runs: [], findings: [], events: [], exportedAt: null };
  const hashes = [];
  for (const p of exports) {
    const bytes = fs.readFileSync(p); hashes.push(sha256Hex(bytes));
    const e = JSON.parse(bytes);
    merged.runs.push(...e.runs); merged.findings.push(...e.findings); merged.events.push(...e.events);
    merged.exportedAt = [merged.exportedAt, e.exportedAt].filter(Boolean).sort().pop();
  }
  merged.exportSha256 = sha256Hex(hashes.sort().join('|'));
  const { dataset, snapshots } = freezeMetaPilot({ exp: merged, repos: readJson(reposFile), seed, verifyRepo, ...(targets ? { targets } : {}) });
  writeJson(out, dataset); writeJson(snapshotsPathFor(out), snapshots);
  return dataset;
}

// ── continue ─────────────────────────────────────────────────────────────────────────────────────────

/** Validate one point with NO provider call: tree, plan file, trigger and diff scope. */
export async function validatePoint({ point, snapshot, repoRoot, deps = {} }) {
  const withTree = deps.withTree || withCaseTree;
  try {
    return await withTree({ repoRoot, sha: point.treeSha }, async (dir) => {
      if (!fs.existsSync(path.join(dir, point.planFile))) return { ok: false, reason: 'plan file absent from the tree' };
      const t = validateTrigger({ point, snapshot, dir });
      if (!t.ok) return t;
      if (point.mode === 'code') { const b = resolveScopeBase({ repoRoot, treeSha: point.treeSha, firstSha: point.firstSha }); if (!b.ok) return b; }
      restorePointFiles({ dir, point, snapshot, sid: sidFor({ pointId: point.pointId, arm: 'META', rep: 0 }) });
      return { ok: true };
    });
  } catch (err) { return { ok: false, reason: String(err?.message || err).slice(0, 300) }; }
}

function repoRootFor(dataset, point) {
  const p = dataset.repoPaths?.[point.repo];
  if (!p || !fs.existsSync(p)) throw new ArgvError(`no local clone for ${point.repo} (dataset.repoPaths); the pilot cannot restore its points`);
  return p;
}

export async function runContinue({ datasetPath, set, replicates, maxUsd, confirmSpend, resultsPath, dryRun, only = null, auditScript, deps = {} }) {
  if (!['rehearsal', 'pilot', 'repeat'].includes(set)) throw new ArgvError('step-back-replay continue: --set must be rehearsal, pilot or repeat (calibration points are never run).');
  const { dataset, snapshots } = loadDataset(datasetPath);
  let points = pointsFor({ dataset, set, purpose: set });
  if (only) {
    const missing = only.filter((id) => !points.some((p) => p.pointId === id));
    if (missing.length) throw new ArgvError(`--point names ${missing.join(', ')}, not in the ${set} set`);
    points = points.filter((p) => only.includes(p.pointId));
  }
  if (dryRun) {
    const rows = [];
    for (const p of points) rows.push({ pointId: p.pointId, repo: p.repo, mode: p.mode, trigger: p.trigger, ...(await validatePoint({ point: p, snapshot: snapshots[p.pointId], repoRoot: repoRootFor(dataset, p), deps })) });
    return { dryRun: true, set, planned: points.length * 2 * replicates, points: rows, datasetHash: dataset.datasetHash };
  }
  if (!(maxUsd > 0) || !confirmSpend || !resultsPath) throw new ArgvError('step-back-replay continue: a paid run needs --max-usd <n>, --confirm-spend and --results <file.jsonl> (--dry-run validates and plans without a call).');
  const pin = deps.pin ?? assertPinnedFixture();
  if (fs.existsSync(resultsPath)) throw new ArgvError(`--results ${resultsPath} already exists; a paid run never overwrites or appends to it.`);
  fs.mkdirSync(path.dirname(path.resolve(resultsPath)), { recursive: true });
  fs.closeSync(fs.openSync(resultsPath, 'wx'));
  const ledgerFile = path.resolve(`${resultsPath}.budget.jsonl`); // absolute: children run with another cwd
  initLedger({ file: ledgerFile, capUsd: maxUsd });
  const spentUsd = () => readLedgerSummary(ledgerFile).spentUsd;
  const append = (rec) => appendDurably(resultsPath, `${JSON.stringify(rec)}\n`);
  append({ type: 'header', epoch: SEEDED_BENCH_EPOCH, pilot: PILOT, set, replicates, plannedPairs: points.length * replicates, maxUsd, datasetHash: dataset.datasetHash, revision: pin.head, ledger: ledgerFile, points: points.map((p) => p.pointId), startedAt: new Date().toISOString() });
  const rows = []; let stopped = null;
  outer: for (let rep = 0; rep < replicates; rep++) {
    for (const point of points) {
      for (const arm of ['META', 'CONTINUE']) {
        const s = readLedgerSummary(ledgerFile);
        if (s.indeterminate.length) { stopped = { reason: 'indeterminate-call', detail: `unreconciled calls: ${s.indeterminate.join(', ')}; run reconcile` }; break outer; }
        if (s.remainingUsd <= 0) { stopped = { reason: 'max-usd', detail: `spent $${s.spentUsd.toFixed(4)} of $${maxUsd}` }; break outer; }
        const row = await (deps.runContinuation || runContinuation)({ point, snapshot: snapshots[point.pointId], arm, rep, repoRoot: repoRootFor(dataset, point), auditScript, ledgerFile, runId: `${set}-${point.pointId}-${arm}-${rep}`, deps: { spentUsd, ...(deps.continuationDeps || {}) } });
        row.set = set; rows.push(row); append(row);
        if (row.invalidReason === 'budget-stop') { stopped = { reason: 'max-usd', detail: `a call was refused at the cap during ${row.runId}` }; break outer; }
      }
    }
  }
  const summary = readLedgerSummary(ledgerFile);
  if (stopped) append({ type: 'stopped', ...stopped, spentUsd: summary.spentUsd });
  append({ type: 'summary', spentUsd: summary.spentUsd, settledUsd: summary.settledUsd, outstandingUsd: summary.outstandingUsd, flagged: summary.flagged, runs: rows.length, valid: rows.filter((r) => r.valid).length });
  return { set, rows, stopped, spentUsd: summary.spentUsd, exitCode: stopped ? EXIT_BUDGET_STOP : 0, ledgerFile };
}

export async function runReconcile({ ledger, callId, evidence, costUsd }) {
  if (!ledger || !callId || !evidence || costUsd == null) throw new ArgvError('step-back-replay reconcile: --ledger, --call-id, --evidence and --cost-usd are required.');
  return reconcileCall({ file: ledger, callId, evidence, costUsd: Number(costUsd) });
}

export const readHeader = (resultsPath) => JSON.parse(fs.readFileSync(resultsPath, 'utf8').split('\n').find(Boolean));
export const readRunRows = (resultsPath) => fs.readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'run');

// ── matcher calibration (§1.4) ───────────────────────────────────────────────────────────────────────

const mediumPlus = (f) => ['HIGH', 'MEDIUM'].includes(String(f.severity).toUpperCase());

/** Calibration pairs come ONLY from calibration-set sessions: findings of round r against the ledger entries first seen before r. */
export function calibrationMaterial({ dataset, snapshots }) {
  const findings = []; const ledger = [];
  const done = new Set(); // (session, store finding id): a T2 and a later T1 point of one session share early rounds; count each once
  for (const p of dataset.points.filter((x) => x.status === 'recoverable' && x.set === 'calibration')) {
    const snap = snapshots[p.pointId];
    for (const r of snap.rounds) {
      if (r.round < 2) continue;
      // Targets are built from rounds BEFORE this one only: their text cannot come from a later re-raise of the concern.
      const xs = ledgerTargets(snap, { upToRound: r.round - 1 });
      const visible = xs.filter((x, i) => (snap.ledgerEntries[i].firstSeenRound ?? 99) < r.round);
      const sessionId = `${p.sessionId}|r${r.round}`; // one visibility frame per (session, round)
      for (const f of r.findings.filter(mediumPlus)) {
        const dedupe = `${p.sessionId}|${f.id}`;
        if (done.has(dedupe)) continue;
        done.add(dedupe);
        findings.push({ id: `${sessionId}|${f.id}`, file: f._primaryFile ?? f.affectedFiles?.[0] ?? null, lines: null, severity: String(f.severity).toUpperCase(), text: [f.category, f.section, f.detail].filter(Boolean).join('\n'), arm: p.mode, sessionId });
      }
      for (const x of visible) { const id = `${sessionId}|${x.id}`; if (!ledger.some((l) => l.id === id)) ledger.push({ ...x, id, sessionId }); }
    }
  }
  return { findings, ledger };
}

export function runCalibrateDraw({ datasetPath, seed, outDir, sizes }) {
  const { dataset, snapshots } = loadDataset(datasetPath);
  const { findings, ledger } = calibrationMaterial({ dataset, snapshots });
  const sets = drawCalibrationSets({ findings, ledgerEntries: ledger, seed, ...(sizes ? { sizes } : {}) });
  const { worksheetMarkdown, key } = renderWorksheet(sets, { seed, ledgerEntries: ledger });
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of ['calibration-worksheet.md', 'calibration-key.json', 'calibration-material.json']) if (fs.existsSync(path.join(outDir, f))) throw new ArgvError(`${f} already exists in ${outDir}; a human may have labelled it. Draw into a new --out-dir.`);
  atomicWriteFileSync(path.join(outDir, 'calibration-worksheet.md'), worksheetMarkdown);
  writeJson(path.join(outDir, 'calibration-key.json'), key);
  writeJson(path.join(outDir, 'calibration-material.json'), { datasetHash: dataset.datasetHash, findings, ledger });
  return { findings: findings.length, ledger: ledger.length, shortfalls: sets.shortfalls, pairs: Object.keys(key.pairs).length, recall: Object.keys(key.filterRecall).length };
}

/** Parse the filled worksheet: `Label: same` under `### P001`, `Restates: id1, id2` (or `none`) under `### R001`. */
export function parseCalibrationAnswers(md) {
  const answers = { pairs: {}, filterRecall: {} };
  for (const block of String(md).split(/^### /m).slice(1)) {
    const id = /^([PR]\d+)/.exec(block)?.[1]; if (!id) continue;
    if (id.startsWith('P')) { const v = /^Label:[ \t]*(\S.*)$/m.exec(block)?.[1]?.trim().toLowerCase(); if (v) answers.pairs[id] = v; }
    else {
      const v = /^Restates:[ \t]*(\S.*)$/m.exec(block)?.[1]?.trim();
      if (v) answers.filterRecall[id] = /^none$/i.test(v) ? [] : v.split(/[,\s]+/).map((s) => s.replace(/[`]/g, '')).filter(Boolean);
    }
  }
  return answers;
}

/** Run both judges over the labelled pairs under their own hard cap, then score each against the human labels. */
export async function runCalibrateScore({ dir, labelsFile, maxUsd, deps = {} }) {
  const key = readJson(path.join(dir, 'calibration-key.json'));
  const material = readJson(path.join(dir, 'calibration-material.json'));
  const answers = parseCalibrationAnswers(fs.readFileSync(labelsFile, 'utf8'));
  const joined = joinWorksheetLabels({ key, answers, findings: material.findings, ledgerEntries: material.ledger });
  const ledgerFile = path.join(dir, 'calibration.budget.jsonl');
  initLedger({ file: ledgerFile, capUsd: maxUsd });
  process.env[BUDGET_LEDGER_ENV] = ledgerFile;
  const out = { version: 1, epoch: SEEDED_BENCH_EPOCH, datasetHash: material.datasetHash, judges: {} };
  for (const [name, sentinel] of [['opus', 'latest-opus'], ['pro', 'latest-pro']]) {
    const judge = await (deps.createJudge || createJudge)({ sentinel });
    const pairs = joined.labelled.map((l) => ({ pairId: l.pairId, f: l.f, x: l.x }));
    const res = await (deps.judgePairs || judgePairs)({ pairs, judge });
    out.judges[name] = { stamp: judge.stamp, counts: res.counts, score: scoreCalibration({ labelled: joined.labelled, judgeVerdicts: res.results.map((r) => ({ pairId: r.pairId, verdict: r.verdict })), filterRecallPairs: joined.filterRecallPairs }), verdicts: res.results };
  }
  const s = readLedgerSummary(ledgerFile);
  out.spentUsd = s.spentUsd; out.flagged = s.flagged;
  out.decision = Object.values(out.judges).every((j) => j.score.decision.status === 'accept') ? 'accept' : Object.values(out.judges).some((j) => j.score.decision.status === 'fail') ? 'fail' : 'inconclusive';
  writeJson(path.join(dir, 'calibration-report.json'), out);
  return out;
}

// ── novelty, worksheet, score ────────────────────────────────────────────────────────────────────────

/** No novelty or score without an ACCEPTED matcher calibration of THIS dataset (plan §1.4: below the bar the pilots stop). */
export function assertCalibrationAccepted({ calibrationPath, dataset }) {
  if (!calibrationPath) throw new ArgvError('--calibration <calibration-report.json> is required: novelty needs an accepted matcher calibration');
  const rep = readJson(calibrationPath);
  if (rep.decision !== 'accept') throw new ArgvError(`the matcher calibration decision is "${rep.decision}", not accept; the pilot stops (§1.4)`);
  if (rep.datasetHash !== dataset.datasetHash) throw new ArgvError('the calibration report was made from a different dataset');
  return rep;
}

/** Novelty of every MEDIUM+ finding against its point's ledger, by BOTH judges (stamped once; a changed stamp refuses a repeat). */
export async function runNovelty({ datasetPath, resultsPath, calibrationPath, deps = {} }) {
  const { dataset, snapshots } = loadDataset(datasetPath);
  const calibration = assertCalibrationAccepted({ calibrationPath, dataset });
  const ledgerFile = path.resolve(`${resultsPath}.budget.jsonl`);
  process.env[BUDGET_LEDGER_ENV] = ledgerFile;
  const outPath = `${resultsPath}.novelty.json`;
  const resultsSha = sha256Hex(fs.readFileSync(resultsPath));
  const prior = fs.existsSync(outPath) ? readJson(outPath) : null;
  if (prior && (prior.datasetHash !== dataset.datasetHash || prior.resultsSha256 !== resultsSha)) throw new Error('the novelty file was made from a different dataset or results file; refusing to reuse it');
  const judges = {};
  for (const [name, sentinel] of [['opus', 'latest-opus'], ['pro', 'latest-pro']]) {
    judges[name] = await (deps.createJudge || createJudge)({ sentinel });
    const calibrated = calibration.judges?.[name]?.stamp;
    if (!calibrated || stampMismatch(calibrated, judges[name].stamp)) throw new Error(`judge "${name}" resolves differently from the one that was calibrated; recalibrate before judging`);
    if (prior && stampMismatch(prior.stamps[name], judges[name].stamp)) throw new Error(`judge "${name}" resolves differently from the frozen stamp; refusing a repeat under a different judge`);
  }
  const out = prior ?? { version: 1, epoch: SEEDED_BENCH_EPOCH, datasetHash: dataset.datasetHash, resultsSha256: resultsSha, stamps: Object.fromEntries(Object.entries(judges).map(([n, j]) => [n, j.stamp])), byFinding: {}, incomplete: false };
  for (const row of readRunRows(resultsPath)) {
    const fs_ = row.findings.filter(mediumPlus);
    if (!fs_.length) continue;
    const snap = snapshots[row.pointId]; const point = dataset.points.find((p) => p.pointId === row.pointId);
    for (const [name, judge] of Object.entries(judges)) {
      // A not-judged entry is RETRYABLE: only a settled judgment is skipped on a rerun.
      const todo = fs_.filter((f) => !out.byFinding[f.key]?.[name] || out.byFinding[f.key][name].notJudged);
      if (!todo.length) continue;
      const r = await (deps.classifyNovelty || classifyNovelty)({ findings: todo.map((f) => ({ id: f.key, file: f.file, files: f.affectedFiles?.length ? f.affectedFiles : undefined, lines: f.lines, severity: f.severity, text: f.text, _priorRuling: f.priorRuling })), ledgerEntries: ledgerTargets(snap), judge, repoRoot: dataset.repoPaths?.[point.repo] ?? undefined });
      for (const pf of r.perFinding) (out.byFinding[pf.id] ||= {})[name] = { novel: pf.novel, flags: pf.flags, sameOf: pf.sameOf ?? null, partialOf: pf.partialOf ?? null, notJudged: pf.notJudged ?? false };
      writeJson(outPath, out); // after EVERY judge batch: a budget stop or crash keeps what was already paid for
    }
  }
  out.incomplete = Object.values(out.byFinding).some((j) => Object.values(j).some((e) => e.notJudged)); // recomputed from the CURRENT state
  writeJson(outPath, out);
  return out;
}

/** The pooled, shuffled, SOURCE-BLINDED sheet a human labels. Every finding novel under EITHER judge is labelled (never a judge's say-so). */
export function buildWorksheet({ rows, novelty, seed, dataset }) {
  const items = [];
  for (const row of rows) for (const f of row.findings.filter(mediumPlus)) {
    const nv = novelty.byFinding[f.key] ?? {};
    if (Object.values(nv).some((j) => j.novel)) items.push({ key: f.key, f, mode: row.mode, repo: dataset.points.find((p) => p.pointId === row.pointId)?.repo, judges: nv, arm: row.arm, runId: row.runId });
  }
  const shuffled = seededShuffle(items, `${seed}:worksheet`, (x) => x.key);
  const key = { version: 1, seed, items: {} };
  const md = ['# Pilot 1 adjudication worksheet (blind to arm)', '',
    'For each finding write ONE label after `Label:`:', '',
    '- `REAL` — a real defect and worth fixing NOW (a round would reasonably be spent on it)',
    '- `RIGOUR_CHASING` — real but not worth a round',
    '- `NOT_A_DEFECT` — not a defect in this code',
    '- `WRONG` — factually wrong about the code',
    '- `UNDETERMINED` — cannot tell (this blocks the score until resolved)', '', 'Judge opinions, arm and run are hidden on purpose.', ''];
  shuffled.forEach((it, i) => {
    const id = `W${String(i + 1).padStart(3, '0')}`;
    key.items[id] = { key: it.key, arm: it.arm, runId: it.runId, judges: it.judges };
    md.push(`### ${id}`, '', `- repo: ${it.repo} (${it.mode} audit) · file: ${it.f.file ?? '?'}${it.f.lines ? `:${it.f.lines[0]}` : ''} · severity: ${it.f.severity}`, '', String(it.f.text).split('\n').map((l) => `> ${l}`).join('\n'), '', 'Label: ', '');
  });
  return { markdown: md.join('\n'), key };
}

export function parseWorksheetLabels(md) {
  const labels = new Map();
  for (const block of String(md).split(/^### /m).slice(1)) {
    const id = /^(W\d+)/.exec(block)?.[1]; const v = /^Label:[ \t]*(\S+)/m.exec(block)?.[1]?.trim().toUpperCase().replace(/[`.]/g, '');
    if (id && v) labels.set(id, v);
  }
  return labels;
}

/** Score both judges against the human labels and apply the pre-registered rule. */
export function scorePilot({ rows, novelty, key, labelsById, plannedPairs }) {
  const labels = new Map();
  for (const [wid, v] of labelsById) {
    if (!LABELS.includes(v)) throw new Error(`worksheet ${wid}: unknown label "${v}"`);
    if (key.items[wid]) labels.set(key.items[wid].key, v);
  }
  const unlabelled = Object.keys(key.items).filter((w) => !labelsById.has(w));
  const byJudge = {}; const blocked = {};
  for (const j of Object.keys(novelty.stamps)) {
    // A missing or not-judged entry stays ABSENT (a blocked finding), never false: absence of a judgment is not 'not novel'.
    const novelByFinding = new Map(Object.entries(novelty.byFinding).filter(([, v]) => v[j] && !v[j].notJudged).map(([k, v]) => [k, v[j].novel === true]));
    const s = scoreMetaRuns({ runs: rows, novelByFinding, labels });
    byJudge[j] = s.rows; blocked[j] = s.blocked;
  }
  const decision = decideMetaPilotBothJudges({ byJudge, plannedPairs });
  const blockedAny = Object.values(blocked).some((b) => b.length) || unlabelled.length > 0 || novelty.incomplete;
  return { decision: blockedAny ? { ...decision, outcome: 'INCOMPLETE', why: `unlabelled ${unlabelled.length}, blocked ${JSON.stringify(Object.fromEntries(Object.entries(blocked).map(([j, b]) => [j, b.length])))}, novelty incomplete ${novelty.incomplete}` } : decision, byJudge, blocked, unlabelled };
}
