/**
 * @fileoverview The checklist pilot's measurements as repo code (verification-lessons plan, Phase 5), so every figure in
 * `docs/research/checklist-pilot-2026-11.md` is reproducible from a pinned tip rather than quoted from a scratch run.
 *
 *  - `replayWindow`: the N most recent PR squash commits first-parent from a pinned `tip` (after skipping `skip`), each commit's
 *    own diff (`<sha>^..<sha>`, renames detected) through the SAME matcher the CLI uses, purpose `replay`.
 *  - `incidentReplay`: the commits that earned each entry, through the matcher (supplementary recall, outside the window).
 *  - `kernelEstimate`: the chars of AGENTS.md that would remain if every moved sentence left.
 *
 * Source-repo-only. Nothing here shrinks AGENTS.md or writes outside `outDir`.
 *
 * @module scripts/lib/checklist/pilot
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadChecklist } from './schema.mjs';
import { matchChecklist, parseUnifiedDiff } from './match.mjs';
import { sanitizeGitEnv } from '../git-env-sanitize.mjs';

/** Incident PRs/commits that fall INSIDE the pilot window (curated from each entry's incident text). */
export const IN_WINDOW_INCIDENTS = Object.freeze({ 'cli-help-is-a-pure-read': ['19e21e74'] });

/** The commits that earned each entry, all OUTSIDE the window: the supplementary recall replay. */
export const INCIDENT_COMMITS = Object.freeze({
  'cli-entry-guard-is-isinvokedasscript': ['82b63557'],
  'disposable-db-allowlist': ['0e7c63be'],
  'canonicalize-eol-before-hashing': ['97988499'],
  'anthropic-pin-unserviceable-param': ['3dabb3f3'],
  'provider-route-not-env-var': ['3dabb3f3'],
  'jsonb-write-seam': ['48611728'],
  'durable-write-registration': ['72e0a0ef', '1019d519'],
  'exit-after-stdout-must-drain': ['9c104381'],
  'prompt-seed-and-mechanical-wave': ['6dedaca0'],
  'tiered-shadow-window-epoch-gated': ['a584540c'],
  'domain-retag-both-directions': ['d5e66d35', 'a146bb7b'],
});

/** sha256 of the file's bytes with CRLF folded to LF (the checkout's EOL must not change the identity of a frozen file). */
export function sha256File(abs) { return createHash('sha256').update(fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')).digest('hex'); }

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/**
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.tip - pinned commit; the window is defined from it, never from a moving ref
 * @param {number} [args.skip] - PR squash commits to skip first (30 = the held-out window before the pilot window)
 * @param {number} [args.count]
 * @param {string} [args.checklistFile] - a checklist to replay (default the committed one; the frozen v1 for side-by-side)
 * @param {string} args.outDir - scratch dir for per-commit patches and the (throwaway) fires log
 */
export function replayWindow({ repoRoot, tip, skip = 0, count = 30, checklistFile, outDir }) {
  const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: sanitizeGitEnv(repoRoot) });
  const loaded = loadChecklist({ repoRoot, file: checklistFile });
  if (!loaded.ok) throw new Error(loaded.error);
  const entries = loaded.entries;
  fs.mkdirSync(outDir, { recursive: true });
  const logPath = path.join(outDir, 'fires.jsonl');
  const tipSha = git('rev-parse', `${tip}^{commit}`).trim();
  const prs = git('log', '--first-parent', '--format=%H%x09%ad%x09%s', '--date=short', tipSha)
    .split('\n').filter((l) => /\(#\d+\)$/.test(l)).slice(skip, skip + count)
    .map((l) => { const [sha, date, ...s] = l.split('\t'); const subject = s.join('\t'); return { sha, date, subject, pr: Number(/\(#(\d+)\)$/.exec(subject)[1]) }; });

  // A root commit has no parent: diff it against the empty tree rather than fail.
  // Only "no parent" is a root; any other git failure throws (it must not read as a root and diff against the empty tree).
  const parentOf = (sha) => { const [, parent] = git('rev-list', '--parents', '-n', '1', sha).trim().split(/\s+/); return parent ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; };
  const replay = (sha) => {
    const diff = git('-c', 'core.quotepath=false', 'diff', '--find-renames', '--no-ext-diff', '--no-textconv', '--unified=0', parentOf(sha), sha);
    const patch = path.join(outDir, `${sha.slice(0, 10)}.patch`);
    fs.writeFileSync(patch, diff);
    const r = matchChecklist({ entries, diffPath: patch, purpose: 'replay', cwd: repoRoot, logPath, runId: `replay-${sha.slice(0, 10)}` });
    if (!r.ok) throw new Error(`${sha}: ${r.message}`);
    return { fired: r.fired, files: parseUnifiedDiff(diff).length };
  };

  const perPr = prs.map((w) => {
    const r = replay(w.sha);
    return { ...w, files: r.files, firedCount: r.fired.length, fired: r.fired.map((f) => ({ id: f.id, via: f.via })) };
  });
  const counts = perPr.map((p) => p.firedCount);
  const entryRows = entries.map((e) => {
    const firedOnPrs = perPr.filter((p) => p.fired.some((f) => f.id === e.id)).map((p) => p.pr);
    const windowIncidents = (IN_WINDOW_INCIDENTS[e.id] ?? []).map((sha) => {
      const row = perPr.find((p) => p.sha.startsWith(sha));
      return { sha, pr: row?.pr ?? null, inWindow: !!row, fired: row ? row.fired.some((f) => f.id === e.id) : null };
    });
    return { id: e.id, firedOnPrs, firedOnCount: firedOnPrs.length, windowIncidents };
  });
  return {
    tip: tipSha, skip, count: perPr.length, checklist: checklistFile ?? '.audit-loop/checklist.json', checklistSha256: sha256File(path.resolve(repoRoot, checklistFile ?? '.audit-loop/checklist.json')), entries: entries.length,
    window: perPr.length ? { newest: { pr: perPr[0].pr, date: perPr[0].date }, oldest: { pr: perPr.at(-1).pr, date: perPr.at(-1).date } } : null,
    noise: { median: median(counts), max: Math.max(...counts), min: Math.min(...counts), distribution: [...counts].sort((a, b) => a - b), thresholds: { median: 5, max: 12 } },
    perPr, entryRows,
    neverFired: entryRows.filter((e) => e.firedOnCount === 0).map((e) => e.id),
    _replay: replay, _git: git,
  };
}

/** Replay each entry's own incident commit(s). Supplementary: not part of the in-window thresholds. */
export function incidentReplay({ repoRoot, outDir, checklistFile }) {
  const w = replayWindow({ repoRoot, tip: 'HEAD', skip: 0, count: 0, checklistFile, outDir });
  const rows = [];
  for (const [id, shas] of Object.entries(INCIDENT_COMMITS)) {
    for (const sha of shas) {
      const full = w._git('rev-parse', `${sha}^{commit}`).trim();
      const r = w._replay(full);
      rows.push({ entry: id, sha, subject: w._git('log', '-1', '--format=%s', full).trim().slice(0, 100), fired: r.fired.some((f) => f.id === id), via: r.fired.find((f) => f.id === id)?.via ?? [], firedCount: r.fired.length });
    }
  }
  return rows;
}

/** Chars of AGENTS.md left if every moved sentence (and the unit hosting it) left. Units: blank-line blocks split at list items and table rows. */
export function kernelEstimate({ repoRoot, checklistFile }) {
  const text = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8').replace(/\r\n/g, '\n');
  const loaded = loadChecklist({ repoRoot, file: checklistFile });
  if (!loaded.ok) throw new Error(loaded.error);
  const units = [];
  for (const block of text.split(/\n\s*\n/)) {
    let cur = [];
    for (const l of block.split('\n')) {
      const starts = /^(>\s*)?(- |\| |\* )/.test(l) && !/^(>\s*)?\|[-\s|]+\|?$/.test(l);
      if (starts && cur.length) { units.push(cur.join('\n')); cur = []; }
      cur.push(l);
    }
    if (cur.length) units.push(cur.join('\n'));
  }
  const flat = (t) => t.replace(/\n>?\s*/g, ' ').replace(/\s+/g, ' ');
  const flatUnits = units.map(flat);
  const ANCHORS = {
    'cli-entry-guard-is-isinvokedasscript': 'The entry guard itself is',
    'disposable-db-allowlist': '"Disposable" is an ALLOWLIST',
    'canonicalize-eol-before-hashing': 'Hashing working-tree bytes',
    'jsonb-write-seam': 'jsonb-safe write seam',
    'durable-write-registration': 'Every audit-store write in',
    'sensitive-paths-single-oracle': 'single source of truth** for sensitive-path classification',
    'provider-route-not-env-var': 'An availability gate must ask whether a ROUTE exists',
    'npm-run-flag-swallowed': 'The `--` is load-bearing',
    'prompt-seed-and-mechanical-wave': 'A new mechanical wave must be declared',
    'sync-inventory-single-owner': "the sync layout's single source of truth is",
    'learning-repo-name-is-owner-slash-repo': '| `LEARNING_REPO_NAME`',
    'schema-error-is-not-empty-result': 'A SCHEMA ERROR IS NOT AN EMPTY RESULT',
    'domain-retag-both-directions': 'RETAGGING A MODULE CHANGES EVERY EDGE',
  };
  const hosting = new Set();
  const unanchored = [];
  for (const e of loaded.entries) {
    const anchor = e.stated ?? ANCHORS[e.id];
    const idx = anchor ? flatUnits.findIndex((u) => u.includes(flat(anchor))) : -1;
    if (idx < 0) unanchored.push(e.id); else hosting.add(idx);
  }
  const upper = [...hosting].reduce((n, i) => n + units[i].length, 0);
  const lower = loaded.entries.reduce((n, e) => n + e.check.length, 0);
  return {
    agentsMdChars: text.length, units: units.length, entries: loaded.entries.length, unitsHostingAMovedSentence: hosting.size, unanchored,
    removalUpperBoundChars: upper, removalLowerBoundChars: lower,
    kernelRemainingMin: text.length - upper, kernelRemainingMax: text.length - lower, target: [10000, 15000],
  };
}

/** Per-entry control evidence (the `pass` rows Cluster F requires): the control fires it, the negative path stays silent. */
export function controlRows({ repoRoot, checklistFile }) {
  const loaded = loadChecklist({ repoRoot, file: checklistFile });
  if (!loaded.ok) throw new Error(loaded.error);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-controls-'));
  const fire = (entry, filePath, text) => {
    const patch = path.join(dir, 'c.patch');
    fs.writeFileSync(patch, `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -0,0 +1 @@\n+${text}\n`);
    const r = matchChecklist({ entries: [entry], diffPath: patch, purpose: 'control', cwd: repoRoot, logPath: path.join(dir, 'fires.jsonl') });
    return r.ok && r.fired.length === 1;
  };
  return loaded.entries.map((e) => {
    const controlFires = fire(e, e.control.path, e.control.text);
    const negativeSilent = e.control.negativePath ? !fire(e, e.control.negativePath, 'const x = 1;') : false;
    return { id: e.id, controlFires, negativeSilent, verdict: controlFires && negativeSilent ? 'pass' : 'fail' };
  });
}
