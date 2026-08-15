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
import { classifyPath } from './lib/sensitive-paths.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { log, argOption, hasFlag } from './lib/cli-io.mjs';

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

/**
 * Harvest candidate (buggy commit, fix commit) pairs from one repo's local history.
 * Pure over the injected `git` runner (deps.git) — tests pass a fake log/show/blame.
 *
 * @param {{sinceN?: number, root?: string}} opts
 * @param {{git?: (args:string[]) => string}} deps
 * @returns {Array<object>}
 */
export function harvestCandidates({ sinceN = 400, root = process.cwd() } = {}, deps = {}) {
  const git = deps.git || makeGit(root);
  const raw = git(['log', '-n', String(sinceN), '--no-merges', `--format=${FMT}`]);
  const records = raw.split(NUL + NUL + '\n').map((r) => r.split(NUL)).filter((p) => p[0] && p[0].trim());

  const candidates = [];
  for (const rec of records) {
    const sha = (rec[0] || '').trim();
    const subj = (rec[1] || '').trim();
    const body = rec[2] || '';
    const full = subj + '\n' + body;
    const isFixTyped = /^(fix|revert)(\(|:|!)/i.test(subj) || /^revert /i.test(subj);
    const revertM = full.match(REVERT_RE);
    const fixesM = full.match(FIXES_RE);

    // (a) revert -> the reverted commit is the "buggy" one.
    if (revertM) {
      candidates.push({ buggyCommit: revertM[1], fixCommit: sha, files: filesFor(git, sha), kind: 'revert', desc: subj, severityHint: severityHint(subj), confidence: 'high' });
      continue;
    }
    // (b) Fixes <sha> / fix(...): ... <sha> body reference.
    if (fixesM) {
      candidates.push({ buggyCommit: fixesM[1], fixCommit: sha, files: filesFor(git, sha), kind: 'fixes-ref', desc: subj, severityHint: severityHint(subj), confidence: 'high' });
      continue;
    }
    // Bare "Fixes #123" (issue, no SHA) -> skip + log (no network lookup).
    if (/\b(?:fixes|closes|resolves)\s+#\d+/i.test(full)) {
      log(`  skip ${sha.slice(0, 8)}: references an issue number, no SHA — not resolvable without network`);
      continue;
    }
    if (!isFixTyped) continue;

    // (c) fix:-typed with no explicit ref -> blame the pre-image lines.
    let files;
    try { files = changedFiles(git, sha); } catch { continue; }
    if (files.length === 0) continue;
    const pureAddition = files.every((f) => f.deleted === 0);
    if (pureAddition) {
      // (Gemini-HIGH) omission/pure-addition defect: no pre-image to blame. Do NOT
      // auto-attribute — surface with an introducerHint (enclosing-function origin,
      // best-effort) and leave buggyCommit for human curation.
      candidates.push({
        buggyCommit: null, fixCommit: sha, files: files.map((f) => f.file),
        kind: 'pure-addition', desc: subj, severityHint: severityHint(subj),
        confidence: 'low', introducerHint: firstFunctionOriginHint(git, sha, files[0]?.file),
      });
      continue;
    }
    const introducers = new Set();
    for (const f of files) for (const i of blameIntroducers(git, sha, f.file)) introducers.add(i);
    if (introducers.size === 0) continue;
    const spread = introducers.size;
    for (const buggy of introducers) {
      candidates.push({
        buggyCommit: buggy, fixCommit: sha, files: files.map((f) => f.file),
        kind: 'blame', desc: subj, severityHint: severityHint(subj),
        confidence: spread > 2 ? 'low' : 'medium',
      });
    }
  }
  return candidates;
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  const sinceN = Number.parseInt(argOption('since', '400'), 10);
  const roots = argOption('roots', process.cwd()).split(',').map((s) => s.trim()).filter(Boolean);
  const outPath = argOption('out', 'docs/experiments/audit-effectiveness/known-defects.candidates.json');
  const apply = hasFlag('apply');

  // main() returns an exit code; the runner sets process.exitCode (never process.exit
  // after a stdout write — it truncates buffered stdout on a pipe).
  const all = [];
  for (const root of roots) {
    try {
      all.push(...harvestCandidates({ sinceN, root }, {}).map((c) => ({ ...c, repo: path.basename(root) })));
    } catch (err) {
      log(`FATAL: git failed in ${root}: ${err.message}`); return 3;
    }
  }

  if (all.length === 0) {
    log(`No candidates in the last ${sinceN} commits across ${roots.length} repo(s). (Widen --since or accept lower power.)`);
    return 0; // explicit "no candidates", never an empty COMMITTED set
  }

  const payload = {
    version: 1,
    note: 'CANDIDATES — curate into known-defects.json by hand. pure-addition + low-confidence rows need a human to set buggyCommit.',
    generatedFromCommits: sinceN, roots, candidates: all,
  };
  const byKind = all.reduce((a, c) => ((a[c.kind] = (a[c.kind] || 0) + 1), a), {});
  log(`Harvested ${all.length} candidate(s): ${JSON.stringify(byKind)}`);
  if (apply) {
    atomicWriteFileSync(path.resolve(outPath), JSON.stringify(payload, null, 2));
    log(`Wrote ${path.relative(process.cwd(), path.resolve(outPath))} — now curate into known-defects.json`);
  } else {
    log('(dry-run — pass --apply to write the candidates file)');
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].endsWith('defect-harvest.mjs'))) {
  main().then((code) => { process.exitCode = code || 0; }).catch((e) => { log(`FATAL: ${e && e.stack || e}`); process.exitCode = 1; });
}
