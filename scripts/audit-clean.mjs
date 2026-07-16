#!/usr/bin/env node
/**
 * @fileoverview `npm run audit:clean` — age-based pruning of TRANSIENT audit
 * working files. `.audit/` accumulates per-cycle artifacts (diffs, ledgers,
 * transcripts, stderr logs, burn-in files, regenerable worksheets) that are
 * only useful while their cycle is alive; weeks later they're noise.
 *
 * Safety model (fail-safe by construction):
 *   - ALLOWLIST-only: a file is deletable ONLY if it matches a TRANSIENT
 *     pattern below. Unknown files are never touched (the per-pattern
 *     .gitignore discipline means a stray file is a signal, not garbage).
 *   - KEEP-list beats everything: load-bearing state (learning outbox,
 *     outcomes, bandit/FP state, cycle-cluster-state, toggles) is named and
 *     never deleted even if a pattern would match it.
 *   - Age-gated: only files older than --age-days (default 14) qualify.
 *   - DRY-RUN by default: prints what would be deleted; `--apply` deletes.
 *
 * Usage:
 *   node scripts/audit-clean.mjs                 # preview (dry-run), 14-day threshold
 *   node scripts/audit-clean.mjs --apply         # actually delete
 *   node scripts/audit-clean.mjs --age-days 30   # different threshold
 *
 * @module scripts/audit-clean
 */
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sweepStaleOrphanPreimages } from './lib/audit/diff-scope-resolver.mjs';
import { retrySync } from './lib/retry-transient-fs.mjs';

if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

/** Orphaned preimage WORKTREES (os.tmpdir()/orphan-preimage-*) — left by a
 *  hard-killed audit run; registered git worktrees, so they must go through
 *  the worktree-aware sweep (a bare rm leaves dangling .git metadata, and a
 *  stale copy poisons temp-dir sibling scans — it blocked a push once). Fixed
 *  1h age gate (a LIVE preimage lives for seconds), independent of --age-days. */
const PREIMAGE_MAX_AGE_MS = 60 * 60 * 1000;

function listStalePreimages() {
  const out = [];
  let entries = [];
  try { entries = readdirSync(os.tmpdir()); } catch { return out; }
  for (const name of entries) {
    if (!name.startsWith('orphan-preimage-')) continue;
    const p = path.join(os.tmpdir(), name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (Date.now() - st.mtimeMs < PREIMAGE_MAX_AGE_MS) continue;
    out.push({ p, ageDays: Math.floor((Date.now() - st.mtimeMs) / 86400000) });
  }
  return out;
}

/** Transient patterns, scoped per directory. RegExp over the basename. */
const TRANSIENT = [
  { dir: '.audit', re: /^cluster.*\.(json|patch|log)$/i },
  { dir: '.audit', re: /^burnin/i },
  { dir: '.audit', re: /\.patch$/i },
  { dir: '.audit', re: /-stderr\.log$/i },
  { dir: '.audit', re: /\.log$/i },
  { dir: '.audit', re: /-transcript\.json$/i },
  { dir: '.audit', re: /-result\.json$/i },
  { dir: '.audit', re: /-ledger\.json$/i },
  { dir: '.audit', re: /^session-audit-.*\.json$/i },
  { dir: '.audit', re: /worksheet.*\.md$/i },           // regenerable on next listing
  { dir: 'docs/arm-eval/worksheets', re: /\.md$/i },    // regenerable on next listing
  { dir: '.audit-loop/cache', re: /./, recurse: true }, // pure cache — safe at any depth
];

/** Never delete, regardless of pattern match (load-bearing local state). */
const KEEP = new Set([
  'outcomes.jsonl', 'experiments.jsonl', 'bandit-state.json', 'fp-tracker.json',
  'cycle-cluster-state.json', 'cache-metrics.jsonl', '.outcomes-finalized',
  'quickfix-hits.jsonl', 'quickfix-pattern-stats.json', 'quickfix-hits.drained-offset',
  'friction-log.jsonl', 'friction-injected.jsonl', 'learning-failed-writes.jsonl',
  'remediation-tasks.jsonl', 'pipeline-state.json', 'session-ledger.json',
  'meta-assessments.jsonl', 'tech-debt.json', 'vendoring-provenance.json',
  'arm-eval-toggle.json', 'domain-map.json', 'repo-id',
]);

function main() {
  const apply = process.argv.includes('--apply');
  const ageIdx = process.argv.indexOf('--age-days');
  const ageDays = ageIdx >= 0 ? Number(process.argv[ageIdx + 1]) : 14;
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    process.stderr.write('  [audit-clean] --age-days must be a non-negative number\n');
    process.exit(2);
  }
  const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;

  const candidates = [];
  const walk = (dir, re, recurse) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (recurse) walk(p, re, recurse); continue; }
      if (KEEP.has(name)) continue;
      if (!re.test(name)) continue;
      if (st.mtimeMs > cutoff) continue;
      candidates.push({ p, bytes: st.size, ageDays: Math.floor((Date.now() - st.mtimeMs) / 86400000) });
    }
  };
  for (const t of TRANSIENT) walk(t.dir, t.re, t.recurse === true);

  // A path can match several patterns — dedupe.
  const seen = new Set();
  const unique = candidates.filter((c) => !seen.has(c.p) && seen.add(c.p));
  const totalKb = Math.round(unique.reduce((s, c) => s + c.bytes, 0) / 1024);

  // Orphaned preimage worktrees (worktree-aware sweep, fixed 1h gate).
  const stalePreimages = listStalePreimages();
  if (stalePreimages.length > 0) {
    if (apply) {
      const r = sweepStaleOrphanPreimages({ repoPath: process.cwd(), maxAgeMs: PREIMAGE_MAX_AGE_MS });
      for (const p of r.swept) process.stdout.write(`  rm (worktree)  ${p}\n`);
    } else {
      for (const w of stalePreimages) process.stdout.write(`  would rm (worktree)  ${w.p}  (${w.ageDays}d)\n`);
    }
  }

  if (unique.length === 0 && stalePreimages.length === 0) {
    process.stdout.write(`audit-clean: nothing transient older than ${ageDays}d — clean.\n`);
    return;
  }
  for (const c of unique.sort((a, b) => b.bytes - a.bytes)) {
    process.stdout.write(`  ${apply ? 'rm' : 'would rm'}  ${c.p}  (${Math.round(c.bytes / 1024)}KB, ${c.ageDays}d)\n`);
    if (apply) { try { retrySync(() => rmSync(c.p)); } catch (err) { process.stderr.write(`  [audit-clean] failed: ${c.p}: ${err.message}\n`); } }
  }
  process.stdout.write(`audit-clean: ${unique.length} file(s) + ${stalePreimages.length} stale worktree(s), ~${totalKb}KB ${apply ? 'deleted' : 'would be deleted'} (files > ${ageDays}d, worktrees > 1h).${apply ? '' : ' Re-run with --apply to delete.'}\n`);
}

main();
