/**
 * @fileoverview Hunk evidence for the FINAL REVIEW: where each changed file's change is, so the envelope can render
 * changed files as hunk windows and count the changed lines the reviewer never saw
 * (docs/plans/final-review-hunk-windows.md D1).
 *
 * The final reviewer runs as its own process over a transcript; it never saw the audit's diff. The audit's R1 round
 * stamps the commit its `--scope diff` change set was measured against (`_diffBase`, `finalize-outcomes.mjs`), the
 * transcript carries round results verbatim, and this module rebuilds the hunks from that base with the SAME reader
 * (`readChangeHunks`, `git diff -U0 <base>` against the working tree — what the reviewer renders) and the SAME evidence
 * rule (`buildHunkMap`: a changed file the diff does not describe is wholly changed, never clean).
 *
 * Lives under `scripts/lib/audit/` (audit-orchestration) because it needs `change-record.mjs` / `hunk-evidence.mjs`;
 * the shared-lib renderer and coverage modules receive only the resulting `hunksFor` function.
 *
 * @module scripts/lib/audit/final-review-hunks
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { readChangeHunks } from './change-record.mjs';
import { buildHunkMap } from './hunk-evidence.mjs';
import { normalizePath } from '../file-io.mjs';
import { isFullObjectId } from '../finalize-outcomes.mjs';

const defaultReadText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

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
 * @param {{transcript: object, changedFiles: string[], run?: Function, readText?: Function, warn?: Function}} input
 * @returns {{evidence: 'expected'|'not-applicable', base: string|null, reason: string,
 *   hunksFor: ((p: string) => Array<{startLine: number, lineCount: number}>|null)|null}}
 */
export function resolveFinalReviewHunks({
  transcript, changedFiles = [], run = execFileSync, readText = defaultReadText, warn = (l) => process.stderr.write(l),
} = {}) {
  const changed = (Array.isArray(changedFiles) ? changedFiles : []).filter((p) => typeof p === 'string' && p.length > 0);
  const none = (reason) => ({ evidence: 'not-applicable', base: null, reason, hunksFor: null });
  if (changed.length === 0) return none('no changed files declared');
  const base = transcriptDiffBase(transcript);
  if (!base) return none('no diff base recorded in the transcript rounds');

  // Untracked changed files have no diff section; `readChangeHunks` gives each one a whole-file hunk.
  let untracked = [];
  try {
    const out = String(run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 64 * 1024 * 1024,
    }) ?? '');
    const all = new Set(out.split('\0').filter(Boolean).map((p) => normalizePath(p)));
    untracked = changed.filter((p) => all.has(normalizePath(p)));
  } catch { /* unknown: those files then take buildHunkMap's wholly-changed fallback — measured, never clean */ }

  const hunksByPath = readChangeHunks({ baseSha: base, untrackedFiles: untracked, run, readText });
  const records = changed.map((p) => {
    const h = hunksByPath ? hunksByPath.get(normalizePath(p)) : null;
    return Array.isArray(h) ? { path: p, hunks: h } : { path: p };
  });
  const map = buildHunkMap({ diffMap: null, changed: records, coverageChanged: records, readText, warn });
  return {
    evidence: map.evidence,
    base,
    reason: hunksByPath ? `hunks from git diff ${base.slice(0, 12)}..worktree` : `git diff ${base.slice(0, 12)} unreadable — changed files treated as wholly changed`,
    hunksFor: map.applicable ? map.hunksFor : null,
  };
}
