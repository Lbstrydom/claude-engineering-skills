#!/usr/bin/env node
/**
 * @fileoverview `npm run audit:clean` — age-based pruning of TRANSIENT audit
 * working files. `.audit/` accumulates per-cycle artifacts (diffs, ledgers,
 * stderr logs, burn-in files, regenerable worksheets) that are only useful
 * while their cycle is alive; weeks later they're noise.
 *
 * ONE class is exempt from "useful only while its cycle is alive": final-review
 * TRANSCRIPTS outlive their cycle as the replay input for evaluating a cheaper
 * or newer final reviewer. They are retained through a bounded newest-N window
 * (`keepNewest`) rather than kept forever — see the TRANSIENT entry.
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
import { readdirSync, statSync, lstatSync, rmSync } from 'node:fs';
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

/**
 * A `TRANSIENT` directory that simply doesn't exist is the NORMAL case — most
 * repos lack most of them. Warning on it would fire every run and train
 * operators to ignore the channel, drowning a real failure. Every other errno
 * is unexpected and must be reported: a silent catch turns EACCES/EIO into an
 * apparently clean sweep while stale data sits unreadable.
 *
 * Same shape as `transaction.mjs::BENIGN_FSYNC_CODES` — the repo's established
 * "expected absence vs real failure" split.
 */
const BENIGN_FS_CODES = new Set(['ENOENT']);


/**
 * @returns {{stale: Array<{p: string, ageDays: number}>, scanned: boolean}}
 *   `scanned:false` means the scan did not happen — the caller MUST NOT report
 *   `stale.length` as a count, because "none found" and "never looked" are then
 *   the same empty array. A `warn` is not sufficient on its own: the summary
 *   line is the authoritative-looking output, and "0 stale worktree(s)" reads
 *   clean regardless of what was printed above it.
 */
function listStalePreimages({ warn } = { warn: () => {} }) {
  const out = [];
  let entries = [];
  // Same classifier as collectCandidates — a silent catch here let the CLI
  // report a clean sweep while the preimage scope was never checked, which is
  // indistinguishable from "there are no stale preimages". That is the same
  // false-clean defect the collector's error policy exists to prevent; leaving
  // it here would give one file two contradictory policies.
  try { entries = readdirSync(os.tmpdir()); } catch (err) {
    if (!BENIGN_FS_CODES.has(err.code)) {
      warn(`could not scan ${os.tmpdir()} for stale preimages: ${err.code || err.message} — preimage cleanup SKIPPED this run`);
      return { stale: out, scanned: false };
    }
    return { stale: out, scanned: true };   // ENOENT: no temp dir => genuinely none
  }
  for (const name of entries) {
    if (!name.startsWith('orphan-preimage-')) continue;
    const p = path.join(os.tmpdir(), name);
    let st;
    try { st = statSync(p); } catch (err) {
      if (!BENIGN_FS_CODES.has(err.code)) warn(`skipped unreadable preimage ${p}: ${err.code || err.message}`);
      continue;
    }
    if (!st.isDirectory()) continue;
    if (Date.now() - st.mtimeMs < PREIMAGE_MAX_AGE_MS) continue;
    out.push({ p, ageDays: Math.floor((Date.now() - st.mtimeMs) / 86400000) });
  }
  return { stale: out, scanned: true };
}

/**
 * Transient patterns, scoped per directory. RegExp over the basename.
 *
 * `keepNewest: N` marks a RETAINED class: the N most recent matches survive at
 * any age, and only what falls out the back of that window is age-gated. Use it
 * for files that are INPUTS to a later evaluation rather than intermediates of
 * a finished cycle — see the transcript entry.
 */
const TRANSIENT = [
  { dir: '.audit', re: /^cluster.*\.(json|patch|log)$/i },
  { dir: '.audit', re: /^burnin/i },
  { dir: '.audit', re: /\.patch$/i },
  { dir: '.audit', re: /-stderr\.log$/i },
  { dir: '.audit', re: /\.log$/i },
  // Final-review transcripts are the ONLY replayable input for a reviewer/model
  // comparison — a cheaper final reviewer can only be evaluated against real
  // audit deliberations, and a synthesized one proves nothing. A 14-day sweep
  // outlives no campaign: the closed shadow A/B spent $50.90 and left zero
  // transcripts to replay, and the Kimi bake-off then ran on a single input.
  // So they are retained, but BOUNDED — the newest 25 (a 12-snapshot campaign
  // plus headroom for incompletes and replacements, ~1-3MB at observed sizes),
  // after which the ordinary age gate applies and the tail is pruned.
  //
  // The suffix group is load-bearing, not cosmetic: `-transcript-v2.json` (the
  // Step 7.1 re-review) and `-transcript-code.json` never matched the old
  // `-transcript\.json$`, so those variants were pruned by NOTHING and grew
  // without bound. Widening the match is what makes the cap a real ceiling.
  { dir: '.audit', re: /-transcript(-[a-z0-9]+)?\.json$/i, keepNewest: 25 },
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

/**
 * Collect delete candidates under `dir`.
 *
 * SYMLINKS ARE A BOUNDARY THIS NEVER CROSSES — the whole point of the
 * function. `walk` is documented as allowlist-only and directory-scoped, but
 * scoping is *lexical*, so following a link silently converts `--apply` into a
 * recursive delete of files OUTSIDE the repo. The realistic trigger is not an
 * attacker but an ordinary `ln -s /mnt/big/audit-cache .audit-loop/cache`, and
 * the one `recurse: true` entry pairs with `re: /./` — matching every basename.
 *
 * Two guards are required, because they cover different halves:
 *   - ROOT (`lstatSync(dir)`): `readdirSync` has already opened `dir` by the
 *     time it returns Dirents, so a symlinked ROOT hands back the target's
 *     children as NORMAL files — indistinguishable from in-tree ones. Verified
 *     empirically; this is the half that closes the documented trigger.
 *   - ENTRIES (`withFileTypes`): `Dirent.isDirectory()` reflects the directory
 *     ENTRY, not a followed target, so a symlink never enters the recursion.
 *     This half also stops the link itself being DELETED as a `re: /./` match.
 * Mirrors `fsWalkFallback` (`lib/arch-intent/adapter-contract.mjs:68-88`), the
 * repo's other recursive walker, which is already immune for the same reason.
 *
 * KNOWN LIMIT — the guards are point-in-time, not race-free. A process that
 * swapped a real directory for a symlink between the `lstatSync` and the
 * `readdirSync` would defeat them. This is documented rather than fixed, on two
 * grounds: (1) closing it properly needs fd-relative traversal (`openat` +
 * `O_NOFOLLOW`), which Node does not expose — there is no `readdirat`, so no
 * amount of re-checking removes the window, only shrinks it; (2) the threat
 * model does not fit a local dev CLI — an actor able to win that race already
 * has write access to the repo and can delete the files directly, so the guard
 * buys nothing against them. What the guards DO close is the realistic,
 * non-adversarial case this function exists for: a cache directory that is
 * *statically* a symlink (`ln -s /mnt/big/audit-cache .audit-loop/cache`).
 *
 * Extracted from `main()` so it is testable: it used to close over main-local
 * `candidates`/`cutoff`. Takes an injected `warn` rather than writing to stderr
 * itself — CLI policy stays in the CLI, and tests assert on a spy.
 *
 * @param {string} dir
 * @param {RegExp} re - tested against the basename
 * @param {boolean} recurse
 * @param {number} cutoff - epoch ms; only files older than this qualify
 * @param {Array<{p: string, bytes: number, ageDays: number}>} out - mutated
 * @param {{warn: (msg: string) => void}} deps
 */
export function collectCandidates(dir, re, recurse, cutoff, out, { warn }) {
  let entries;
  // ONE error boundary over both calls. `existsSync` is deliberately GONE: it
  // was redundant with lstat, a TOCTOU, and it silently skipped real errors
  // (an ENOTDIR read as "absent") — which is the failure this classifier fixes.
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      warn(`skipped symlinked directory (never traversed, never deleted): ${dir}`);
      return;
    }
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (!BENIGN_FS_CODES.has(err.code)) {
      warn(`skipped unreadable directory ${dir}: ${err.code || err.message}`);
    }
    return;
  }

  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      warn(`skipped symlink (never traversed, never deleted): ${p}`);
      continue;
    }
    if (e.isDirectory()) { if (recurse) collectCandidates(p, re, recurse, cutoff, out, { warn }); continue; }
    if (!e.isFile()) continue; // sockets/FIFOs/devices are not ours to delete
    if (KEEP.has(e.name)) continue;
    if (!re.test(e.name)) continue;
    let st;
    // Same classifier: a file vanishing mid-sweep is benign; EACCES/EIO is not.
    try { st = statSync(p); } catch (err) {
      if (!BENIGN_FS_CODES.has(err.code)) warn(`skipped unreadable file ${p}: ${err.code || err.message}`);
      continue;
    }
    if (st.mtimeMs > cutoff) continue;
    out.push({ p, bytes: st.size, mtimeMs: st.mtimeMs, ageDays: Math.floor((Date.now() - st.mtimeMs) / 86400000) });
  }
}

/**
 * Split a retained class into {retained, deletable} at the keep-newest window.
 *
 * Called on a set collected WITHOUT an age gate (cutoff `Infinity`), because the
 * window must count every match — if it saw only the aged ones, ten fresh
 * transcripts would each keep a slot open and the sweep would retain 25 old ones
 * on top of them, so the ceiling would not be a ceiling.
 *
 * Ties in `mtimeMs` are broken by path so the split is deterministic — two files
 * written in the same millisecond otherwise make the retained set depend on
 * readdir order, and a sweep that keeps a different file each run is not a
 * retention policy.
 *
 * @param {Array<{p: string, mtimeMs: number}>} found - every match, any age
 * @param {number} keepNewest - window size; the N most recent survive at any age
 * @param {number} cutoff - epoch ms; beyond the window, only older files qualify
 */
export function splitRetained(found, keepNewest, cutoff) {
  const sorted = [...found].sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.p.localeCompare(b.p));
  return {
    retained: sorted.slice(0, keepNewest),
    deletable: sorted.slice(keepNewest).filter((c) => c.mtimeMs <= cutoff),
  };
}

function main() {
  const apply = process.argv.includes('--apply');
  const ageIdx = process.argv.indexOf('--age-days');
  const ageDays = ageIdx >= 0 ? Number(process.argv[ageIdx + 1]) : 14;
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    process.stderr.write('  [audit-clean] --age-days must be a non-negative number\n');
    process.exit(2);
  }
  const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;

  // Unconditional — NOT gated on --apply. A dry run is a preview of what
  // --apply would do, so it must disclose that a symlinked cache would be
  // skipped; that is precisely when the operator can still act on it.
  const warn = (msg) => process.stderr.write(`  [audit-clean] ${msg}\n`);

  const candidates = [];
  const retained = [];
  for (const t of TRANSIENT) {
    if (!t.keepNewest) {
      collectCandidates(t.dir, t.re, t.recurse === true, cutoff, candidates, { warn });
      continue;
    }
    // Collect at EVERY age (Infinity never trips `mtimeMs > cutoff`), then let
    // the window decide. Passing `Date.now()` instead would be a race with a
    // file written in the same millisecond.
    const found = [];
    collectCandidates(t.dir, t.re, t.recurse === true, Number.POSITIVE_INFINITY, found, { warn });
    const split = splitRetained(found, t.keepNewest, cutoff);
    retained.push(...split.retained);
    candidates.push(...split.deletable);
  }

  // A path can match several patterns — dedupe.
  const seen = new Set();
  const unique = candidates.filter((c) => !seen.has(c.p) && seen.add(c.p));
  const totalKb = Math.round(unique.reduce((s, c) => s + c.bytes, 0) / 1024);

  // Orphaned preimage worktrees (worktree-aware sweep, fixed 1h gate).
  const { stale: stalePreimages, scanned: preimagesScanned } = listStalePreimages({ warn });
  if (stalePreimages.length > 0) {
    if (apply) {
      const r = sweepStaleOrphanPreimages({ repoPath: process.cwd(), maxAgeMs: PREIMAGE_MAX_AGE_MS });
      for (const p of r.swept) process.stdout.write(`  rm (worktree)  ${p}\n`);
    } else {
      for (const w of stalePreimages) process.stdout.write(`  would rm (worktree)  ${w.p}  (${w.ageDays}d)\n`);
    }
  }

  // Disclose retention BEFORE the verdict, and on both exit paths. "0 deleted"
  // otherwise reads as "the sweep found nothing" when it may mean "everything
  // matched a retained class" — the same false-clean shape `scanned:false`
  // exists to prevent one function up.
  if (retained.length > 0) {
    const keptKb = Math.round(retained.reduce((s, c) => s + c.bytes, 0) / 1024);
    process.stdout.write(`audit-clean: retained ${retained.length} replay input(s), ~${keptKb}KB — model-eval transcripts, newest-first window.\n`);
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

/** Internal seams for tests. Underscore-prefixed per repo convention. */
export const _internals = { collectCandidates, listStalePreimages, splitRetained, BENIGN_FS_CODES, TRANSIENT, KEEP };

// isMain guard — importing this module (from a test) must not run a sweep.
const isMain = import.meta.url === `file://${process.argv[1]}`
  || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;

if (isMain) main();
