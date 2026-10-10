/**
 * @fileoverview Hunk evidence for the FINAL REVIEW: where each changed file's change is, so the envelope can render
 * changed files as hunk windows and count the changed lines the reviewer never saw
 * (docs/plans/final-review-hunk-windows.md D1).
 *
 * The final reviewer runs as its own process over a transcript; it never saw the audit's diff. The audit's R1 round
 * stamps the commit its `--scope diff` change set was measured against (`_diffBase`, `finalize-outcomes.mjs`), the
 * transcript carries round results verbatim, and this module rebuilds the diff from that base with the SAME git reader
 * (`readChangeDiff`, `git diff -U0 <base>` against the working tree — what the reviewer renders) and hands it to the SAME
 * evidence rule (`buildHunkMap`). That rule trusts a file's hunks only when the diff's post-image blob id is the file's
 * current `git hash-object` — checked lazily, as the reader reaches the file — so an edit between the diff and the render
 * demotes the file to wholly changed instead of misplacing its window (code audit R1-M1). A changed file the diff does
 * not describe is wholly changed, never clean.
 *
 * Lives under `scripts/lib/audit/` (audit-orchestration) because it needs `change-record.mjs` / `hunk-evidence.mjs`;
 * the shared-lib renderer and coverage modules receive only the resulting `hunksFor` function.
 *
 * @module scripts/lib/audit/final-review-hunks
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { readChangeDiff } from './change-record.mjs';
import { buildHunkMap } from './hunk-evidence.mjs';
import { normalizePath, safeReadFile } from '../file-io.mjs';
import { isFullObjectId } from '../finalize-outcomes.mjs';

/**
 * Local line-count reads go through the reader's own boundary (repo-contained, realpath-checked, never sensitive):
 * `changed_files` is transcript-supplied, so a path outside the checkout is never opened here (code audit R1-M2).
 */
const boundedReadText = (p) => safeReadFile(p, path.resolve('.'))?.content ?? null;

/**
 * The diff base the transcript's rounds recorded: the EARLIEST round carrying a full hex object id. R1 is the round that
 * resolves the `--scope diff` snapshot; later rounds run on explicit `--changed` lists and stamp none. Any other value is
 * ignored — it came from a file and would reach `git diff` as an argument.
 *
 * @param {object} transcript
 * @returns {string|null}
 */
export function transcriptDiffBase(transcript) {
  const rounds = Array.isArray(transcript?.rounds) ? transcript.rounds : [];
  for (const r of rounds) if (isFullObjectId(r?._diffBase)) return r._diffBase;
  return null;
}

/**
 * @param {{transcript: object, changedFiles: string[], run?: Function, readText?: Function, hashFile?: Function,
 *   warn?: Function}} input
 * @returns {{evidence: 'expected'|'not-applicable', base: string|null, reason: string,
 *   hunksFor: ((p: string) => Array<{startLine: number, lineCount: number}>|null)|null}}
 */
export function resolveFinalReviewHunks({
  transcript, changedFiles = [], run = execFileSync, readText = boundedReadText, hashFile,
  warn = (l) => process.stderr.write(l),
} = {}) {
  const changed = (Array.isArray(changedFiles) ? changedFiles : []).filter((p) => typeof p === 'string' && p.length > 0);
  const none = (reason) => ({ evidence: 'not-applicable', base: null, reason, hunksFor: null });
  if (changed.length === 0) return none('no changed files declared');
  const base = transcriptDiffBase(transcript);
  if (!base) return none('no diff base recorded in the transcript rounds');

  // Untracked changed files have no diff section: they are wholly new, which is exactly what the hunk map's fallback
  // gives them — so their fallback line is not a degradation worth reporting.
  let untracked = new Set();
  try {
    const out = String(run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 64 * 1024 * 1024,
    }) ?? '');
    untracked = new Set(out.split('\0').filter(Boolean).map((p) => normalizePath(p).replace(/\\/g, '/')));
  } catch { /* unknown: those files take the wholly-changed fallback, and say so */ }
  const isUntracked = (p) => untracked.has(normalizePath(p).replace(/\\/g, '/'));

  const diffMap = readChangeDiff({ baseSha: base, run });
  const map = buildHunkMap({
    // A failed diff is an EMPTY supplied diff: evidence stays expected and every changed file is wholly changed.
    diffMap: diffMap ?? new Map(), changed, coverageChanged: null, readText,
    ...(hashFile ? { hashFile } : {}),
    warn: (line) => { if (![...changed].some((p) => isUntracked(p) && line.includes(p.replace(/\\/g, '/')))) warn(line); },
  });
  return {
    evidence: map.evidence,
    base,
    reason: diffMap
      ? `hunks from git diff ${base.slice(0, 12)}..worktree, post-image verified`
      : `git diff ${base.slice(0, 12)} unreadable — changed files treated as wholly changed`,
    hunksFor: map.applicable ? map.hunksFor : null,
  };
}
