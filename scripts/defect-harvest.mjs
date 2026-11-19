#!/usr/bin/env node
/**
 * @fileoverview Phase 2 of the audit-effectiveness experiment — mine
 * `commit -> later-fix/revert` pairs from LOCAL git history into a CANDIDATE
 * ground-truth set of known-buggy commits. The fix commit is an objective label
 * that the earlier commit carried a real defect — survivorship-free, signal-dense,
 * and free of "human skimmed a plausible finding" bias.
 *
 * Plan: docs/plans/audit-effectiveness-experiment.md (Phase 2, section 12.1).
 *
 * CANDIDATES ONLY. The harvester never writes the committed ground-truth set —
 * it emits candidates a human curates into `known-defects.json`, because "this fix
 * means the earlier commit had a real defect" is a judgment (esp. for blame-derived
 * introducers and pure-addition/omission defects). LOCAL GIT ONLY — no network /
 * GitHub / PR lookup.
 *
 * @module scripts/defect-harvest
 */

import './lib/load-env.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { classifyPath } from './lib/sensitive-paths.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { log, argOption, hasFlag } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { MAX_DIFF_CHARS } from './lib/model-eval/known-defect-corpus.mjs';

// Delimiters: git's `%x00` placeholder emits a real NUL byte in the output; we
// split the output on that NUL. Fields per commit: hash, subject, body.
const NUL = String.fromCharCode(0);
const FMT = ['%H', '%s', '%b'].join('%x00') + '%x00%x00'; // trailing NUL NUL = record sep
const REVERT_RE = /This reverts commit ([0-9a-f]{7,40})/i;
// SHA-bearing only ("Fixes #123" is skipped). Optional colon covers the git trailer
// form `Fixes: <sha>` as well as prose `Fixes <sha>`.
const FIXES_RE = /\b(?:fixes|closes|resolves):?\s+([0-9a-f]{7,40})\b/i;

/** Default git runner (injectable via deps.git for tests). Returns stdout, or
 * throws — callers that expect possible failure wrap in try/catch. */
function makeGit(root) {
  return (args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Files a commit touched, filtered to auditable source (drop sensitive + generated
 * + binary). Returns [{file, added, deleted}]. */
function changedFiles(git, sha) {
  const out = git(['show', '--numstat', '--format=', sha]).trim();
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (add === '-' || del === '-') continue;          // binary
    if (classifyPath(file) !== null) continue;         // sensitive OR generatedNoise
    files.push({ file, added: Number(add) || 0, deleted: Number(del) || 0 });
  }
  return files;
}

/** For a fix commit's deleted (pre-image) lines, blame the parent to find the
 * introducing commit(s). Best-effort; returns a Set of SHAs. */
function blameIntroducers(git, sha, file) {
  const introducers = new Set();
  let diff;
  try { diff = git(['show', '--unified=0', '--format=', sha, '--', file]); } catch { return introducers; }
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gm)) {
    const start = Number(m[1]); const len = m[2] == null ? 1 : Number(m[2]);
    if (len === 0) continue; // pure-addition hunk — no pre-image (handled separately)
    const end = start + len - 1;
    let blame;
    try { blame = git(['blame', '-w', '-C', '-L', `${start},${end}`, `${sha}^`, '--', file]); } catch { continue; }
    for (const bl of blame.split('\n')) {
      const bm = bl.match(/^\^?([0-9a-f]{7,40})\s/i);
      if (bm) introducers.add(bm[1]);
    }
  }
  return introducers;
}

/** Severity hint from the fix subject (heuristic; the curator sets the real value). */
function severityHint(subject) {
  if (/\b(security|cve|vuln|auth|inject|xss|csrf|rce|leak|data.?loss|corrupt|crash|deadlock|race)\b/i.test(subject)) return 'HIGH';
  if (/\b(fix|bug|incorrect|wrong|broken|npe|null|undefined|overflow)\b/i.test(subject)) return 'MEDIUM';
  return 'LOW';
}

function filesFor(git, sha) { try { return changedFiles(git, sha).map((f) => f.file); } catch { return []; } }

/** Best-effort: the commit that introduced the enclosing function of the first
 * added hunk (git log -L). Returns a SHA hint or null. Never authoritative. */
function firstFunctionOriginHint(git, sha, file) {
  if (!file) return null;
  try {
    const diff = git(['show', '--unified=0', '--format=', sha, '--', file]);
    const m = diff.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m);
    if (!m) return null;
    const line = Number(m[1]);
    const out = git(['log', '-1', '--format=%H', '-L', `${line},${line}:${file}`, `${sha}^`]);
    const hm = out.match(/([0-9a-f]{7,40})/i);
    return hm ? hm[1] : null;
  } catch { return null; }
}

export const MINER_VERSION = 'v2';
const AI_GATE_CLEARED_RE = /^AI-Gate:\s*(passed|converged)\b/im;

/** Does `git` (real or fake) say `a` is an ancestor of `b`? A throwing runner means "no" (git's exit 1). */
function isAncestor(git, a, b) {
  try { git(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
}
const sameSha = (x, y) => !!x && !!y && (x.startsWith(y) || y.startsWith(x));
const dropped = (reason) => ({ outcome: 'dropped', reason, candidates: [], filtered: [] });

/**
 * Classify ONE commit into exactly one terminal outcome (plan sashiko-audit-improvements §5.1):
 *   candidate | candidate-unattributed | dropped:<reason>. Pairs a filter removed are listed with the reason.
 * @returns {{outcome:string, reason?:string, candidates:object[], filtered:{buggyCommit:string, reason:string}[]}}
 */
function classifyCommit(git, rec, ctx) {
  const sha = (rec[0] || '').trim();
  const subj = (rec[1] || '').trim();
  const full = subj + '\n' + (rec[2] || '');
  const revertM = full.match(REVERT_RE);
  const fixesM = full.match(FIXES_RE);
  const isFixTyped = /^(fix|revert)(\(|:|!)/i.test(subj) || /^revert /i.test(subj);
  const mk = (buggy, kind, files, confidence) => ({ buggyCommit: buggy, fixCommit: sha, files, kind, desc: subj, severityHint: severityHint(subj), confidence });

  let pairs = null;
  if (revertM) pairs = [mk(revertM[1], 'revert', filesFor(git, sha), 'high')];
  else if (fixesM) pairs = [mk(fixesM[1], 'fixes-ref', filesFor(git, sha), 'high')];
  else if (/\b(?:fixes|closes|resolves)\s+#\d+/i.test(full)) return dropped('issue-ref-only');
  else if (!isFixTyped) return dropped('not-fix-typed');

  if (!pairs) {
    let files;
    try { files = changedFiles(git, sha); } catch { return dropped('git-error'); }
    if (files.length === 0) return dropped('no-auditable-files');
    if (files.every((f) => f.deleted === 0)) {
      // Omission defect: no pre-image to blame. Never auto-attributed; a human sets buggyCommit.
      return { outcome: 'candidate-unattributed', candidates: [{ ...mk(null, 'pure-addition', files.map((f) => f.file), 'low'), introducerHint: firstFunctionOriginHint(git, sha, files[0]?.file) }], filtered: [] };
    }
    const introducers = new Set();
    for (const f of files) for (const i of blameIntroducers(git, sha, f.file)) introducers.add(i);
    if (introducers.size === 0) return dropped('no-blame-introducer');
    pairs = [...introducers].map((i) => mk(i, 'blame', files.map((f) => f.file), introducers.size > 2 ? 'low' : 'medium'));
  }

  // Size bound shared with the loader: a fix the loader would refuse can never become a corpus case.
  try {
    if (git(['show', '--no-ext-diff', '--no-textconv', '--format=', sha]).length > ctx.maxDiffChars) return dropped('diff-too-large');
  } catch { return dropped('git-error'); }

  const kept = []; const filtered = [];
  for (const p of pairs) {
    if (ctx.curated.some((c) => sameSha(c.buggyCommit, p.buggyCommit) && sameSha(c.fixCommit, p.fixCommit))) { filtered.push({ buggyCommit: p.buggyCommit, reason: 'already-curated' }); continue; }
    if (!isAncestor(git, p.buggyCommit, sha)) { filtered.push({ buggyCommit: p.buggyCommit, reason: 'introducer-not-ancestor' }); continue; }
    // The introducer must touch a file the fix touches. A commit whose files cannot be read is kept: unknown is not disjoint.
    const introFiles = filesFor(git, p.buggyCommit);
    if (introFiles.length > 0 && p.files.length > 0 && !introFiles.some((f) => p.files.includes(f))) { filtered.push({ buggyCommit: p.buggyCommit, reason: 'introducer-disjoint-files' }); continue; }
    let body = '';
    try { body = git(['show', '-s', '--format=%B', p.buggyCommit]); } catch { /* hint only */ }
    kept.push({ ...p, auditCleared: AI_GATE_CLEARED_RE.test(body) });
  }
  return kept.length > 0
    ? { outcome: 'candidate', candidates: kept, filtered }
    : { outcome: 'dropped', reason: 'all-introducers-filtered', candidates: [], filtered };
}

/**
 * Mine candidates with a per-commit outcome and a reconciliation against an INDEPENDENT universe (`git rev-list`): every
 * selected commit must end in exactly one terminal outcome, or the run fails (never prints) naming the sha.
 * Pure over the injected `git` runner.
 *
 * @param {{sinceN?:number, root?:string, rev?:string, curated?:Array<{buggyCommit:string,fixCommit:string}>, maxDiffChars?:number}} opts
 */
export function harvestWithReport({ sinceN = 400, root = process.cwd(), rev = 'HEAD', curated = [], maxDiffChars = MAX_DIFF_CHARS } = {}, deps = {}) {
  const git = deps.git || makeGit(root);
  const oid = git(['rev-parse', '--verify', `${rev}^{commit}`]).trim() || rev;
  const selected = git(['rev-list', '--no-merges', '-n', String(sinceN), oid]).split('\n').map((l) => l.trim()).filter(Boolean);
  const raw = git(['log', '-n', String(sinceN), '--no-merges', `--format=${FMT}`, oid]);
  const records = raw.split(NUL + NUL + '\n').map((r) => r.split(NUL)).filter((p) => p[0] && p[0].trim());

  const outcomes = []; const candidates = [];
  const pairs = { emitted: 0, filteredByReason: {} };
  for (const rec of records) {
    const sha = rec[0].trim();
    const r = classifyCommit(git, rec, { curated, maxDiffChars });
    outcomes.push({ commit: sha, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}), pairs: r.candidates.length, filtered: r.filtered });
    candidates.push(...r.candidates);
    pairs.emitted += r.candidates.length;
    for (const f of r.filtered) pairs.filteredByReason[f.reason] = (pairs.filteredByReason[f.reason] || 0) + 1;
  }

  // Reconciliation: set equality with the independent universe, exactly one outcome per commit.
  const problems = [];
  const seen = new Map();
  for (const o of outcomes) seen.set(o.commit, (seen.get(o.commit) || 0) + 1);
  for (const sha of selected) if (!seen.has(sha)) problems.push(`unclassified:${sha}`);
  for (const [sha, n] of seen) { if (n > 1) problems.push(`double-classified:${sha}`); if (!selected.includes(sha)) problems.push(`not-in-universe:${sha}`); }
  const byOutcome = { candidate: 0, 'candidate-unattributed': 0, dropped: {} };
  for (const o of outcomes) { if (o.outcome === 'dropped') byOutcome.dropped[o.reason] = (byOutcome.dropped[o.reason] || 0) + 1; else byOutcome[o.outcome]++; }
  return { selected, outcomes, candidates, dropReport: { selected: selected.length, byOutcome, pairs }, reconciliation: { ok: problems.length === 0, problems } };
}

/** The original entry point: candidates only, no reconciliation. Kept for existing callers and tests. */
export function harvestCandidates(opts = {}, deps = {}) {
  const git = deps.git || makeGit(opts.root || process.cwd());
  // The legacy callers' fake runners know neither rev-parse nor rev-list; the universe is only checked by harvestWithReport.
  const wrapped = (args) => (args[0] === 'rev-parse' || args[0] === 'rev-list' ? '' : git(args));
  return harvestWithReport(opts, { git: wrapped }).candidates;
}

const CURATED_REL = 'docs/experiments/audit-effectiveness/known-defects.json';

/**
 * The curated set the `already-curated` filter reads, taken from an IMMUTABLE object (`git show <corpusRev>:<path>` in the CES
 * checkout), never the working copy, so it is pinned the same way the mined history is. Returns the pairs and a digest.
 */
export function loadCuratedSet({ corpusRoot, corpusRev }, deps = {}) {
  const git = deps.git || makeGit(corpusRoot);
  const oid = git(['rev-parse', '--verify', `${corpusRev}^{commit}`]).trim();
  const raw = git(['show', `${oid}:${CURATED_REL}`]);
  const parsed = JSON.parse(raw);
  const pairs = (parsed.defects || []).filter((d) => d.buggyCommit && d.fixCommit).map((d) => ({ buggyCommit: d.buggyCommit, fixCommit: d.fixCommit }));
  return { pairs, digest: crypto.createHash('sha256').update(raw.replace(/\r\n/g, '\n')).digest('hex'), corpusRev: oid };
}

/** The output header: every input that affects the output, so identical `inputs` means byte-identical output. */
export function buildInputs({ repo, rev, sinceN, maxDiffChars, curated }) {
  return { minerVersion: MINER_VERSION, repo, rev, options: { sinceN, maxDiffChars }, curated: { path: CURATED_REL, corpusRev: curated.corpusRev, digest: curated.digest } };
}

export function serializeReport({ inputs, report }) {
  const sortKey = (c) => `${c.fixCommit}:${c.buggyCommit ?? ''}`;
  const candidates = [...report.candidates].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const outcomes = [...report.outcomes].sort((a, b) => a.commit.localeCompare(b.commit));
  return JSON.stringify({ version: 2, note: 'CANDIDATES - curate into known-defects.json by hand (suite, curation required). Never written by the miner.', inputs, dropReport: report.dropReport, candidates, outcomes }, null, 2);
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  const sinceN = Number.parseInt(argOption('since', '400'), 10);
  const roots = argOption('roots', process.cwd()).split(',').map((s) => s.trim()).filter(Boolean);
  const rev = argOption('rev', 'HEAD');
  const corpusRoot = argOption('corpus-root', process.cwd());
  const corpusRev = argOption('corpus-rev', 'HEAD');
  const outDir = argOption('out-dir', path.join('.audit', 'defect-candidates'));
  const outArg = argOption('out', null);
  const apply = hasFlag('apply');
  if (outArg && path.basename(outArg).toLowerCase() === 'known-defects.json') { log('REFUSED: the miner never writes known-defects.json; a human curates candidates into it'); return 1; }

  let curated;
  try { curated = loadCuratedSet({ corpusRoot, corpusRev }); } catch (err) { log(`FATAL: cannot read the curated set at ${corpusRev}: ${err.message}`); return 3; }

  let exit = 0;
  for (const root of roots) {
    const repo = path.basename(root);
    let report; let oid;
    try {
      oid = makeGit(root)(['rev-parse', '--verify', `${rev}^{commit}`]).trim();
      report = harvestWithReport({ sinceN, root, rev: oid, curated: curated.pairs });
    } catch (err) { log(`FATAL: git failed in ${root}: ${err.message}`); return 3; }
    if (!report.reconciliation.ok) {
      log(`FATAL: ${repo}: outcomes do not reconcile with the rev-list universe: ${report.reconciliation.problems.slice(0, 5).join(', ')}${report.reconciliation.problems.length > 5 ? ` (+${report.reconciliation.problems.length - 5} more)` : ''}`);
      exit = 3; continue;
    }
    const inputs = buildInputs({ repo, rev: oid, sinceN, maxDiffChars: MAX_DIFF_CHARS, curated });
    const d = report.dropReport;
    log(`${repo}@${oid.slice(0, 12)}: ${d.selected} commit(s) examined -> candidate ${d.byOutcome.candidate}, unattributed ${d.byOutcome['candidate-unattributed']}, dropped ${JSON.stringify(d.byOutcome.dropped)}; pairs emitted ${d.pairs.emitted}, filtered ${JSON.stringify(d.pairs.filteredByReason)}`);
    const body = serializeReport({ inputs, report });
    if (apply) {
      const target = path.resolve(outArg || path.join(outDir, `${repo}-${oid.slice(0, 12)}.json`));
      atomicWriteFileSync(target, body);
      log(`Wrote ${path.relative(process.cwd(), target)}`);
    } else {
      log('(dry-run - pass --apply to write the candidates file)');
      process.stdout.write(body + '\n');
    }
  }
  return exit;
}

if (isInvokedAsScript(import.meta.url)) {
  main().then((code) => { process.exitCode = code || 0; }).catch((e) => { log(`FATAL: ${e && e.stack || e}`); process.exitCode = 1; });
}
