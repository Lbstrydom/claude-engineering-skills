/**
 * @fileoverview Hunk EVIDENCE for an audit round: where each changed file's change is, verified, with the fallback
 * for a change whose location is unknown (docs/plans/audit-hunk-window-coverage.md D7).
 *
 * Split from file-coverage.mjs (code audit R1 M1): that module accounts for what was read; this one acquires and
 * verifies the evidence of what changed — git subprocesses, the stale-patch check and the wholly-changed fallback.
 *
 * @module scripts/lib/audit/hunk-evidence
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { normalizePath } from '../file-io.mjs';

const defaultReadText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
// The blob id git gives the working-tree file — its clean filters applied, so a CRLF checkout hashes as the patch did.
const defaultHashFile = (p) => {
  try {
    return String(execFileSync('git', ['hash-object', '--', p], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 })).trim() || null;
  } catch { return null; }
};

/**
 * The ONE hunk map an audit renders and measures against (docs/plans/audit-hunk-window-coverage.md D7).
 *
 * Evidence is `expected` where the round declares a diff — an operator-supplied `--diff` (R2+; a non-null `diffMap`, even
 * an empty one) or an R1 `--scope diff` VCS change record; otherwise (`--scope plan|full`, an R2+ re-run without `--diff`)
 * it is `not-applicable` and every lookup is null. Where evidence is expected:
 *
 *   - a supplied `--diff` entry is trusted only when its post-image blob id (`index …..<post>`) is the working-tree
 *     file's `git hash-object` — the patch then describes exactly this content (a stale patch would otherwise misplace
 *     every window, and the ledger would agree with it and report nothing unread);
 *   - else the R1 change record's `hunks` (an array — possibly empty, which is a measured "no changed text line");
 *   - else, for a CHANGED file with no usable evidence, the whole file: with no record of where the change is, the
 *     file is the change. Said on stderr once per file, with the cause. Files outside the changed set (dependents,
 *     shared context) never take this fallback.
 *
 * Lookups are memoised: verification and the whole-file read happen once per file per audit.
 *
 * @param {{diffMap?: Map|null, changed?: Array<string|object>|null, coverageChanged?: Array<object>|null,
 *   readText?: (p: string) => string|null, hashFile?: (p: string) => string|null,
 *   warn?: (line: string) => void}} input
 * @returns {{evidence: 'expected'|'not-applicable', applicable: boolean,
 *   hunksFor: (p: string) => Array<{startLine: number, lineCount: number}>|null, asDiffMap: () => {get: Function}}}
 */
export function buildHunkMap({ diffMap = null, changed = [], coverageChanged = null, readText = defaultReadText, hashFile = defaultHashFile, warn = (l) => process.stderr.write(l) } = {}) {
  // Evidence is expected only where the round DECLARES a diff: an operator-supplied `--diff` (a non-null diffMap — even
  // an empty one, which is a failed or empty patch) or an R1 `--scope diff` VCS record. An R2+ round run without
  // `--diff` (e.g. `--scope full` re-runs) declared none, and is not-applicable exactly like R1 full scope.
  const evidence = diffMap || Array.isArray(coverageChanged) ? 'expected' : 'not-applicable';
  const records = new Map();
  for (const raw of changed || []) {
    const rec = typeof raw === 'string' ? { path: raw } : raw;
    if (rec && typeof rec.path === 'string' && rec.path) records.set(normalizePath(rec.path), rec);
  }
  const diffHasHunks = !!diffMap && [...diffMap.values()].some((v) => (v?.hunks?.length ?? 0) > 0);
  const memo = new Map();
  const wholeFile = (rec, cause) => {
    const text = readText(rec.path);
    if (typeof text !== 'string') return null;
    warn(`  [coverage] ${rec.path.replace(/\\/g, '/')}: ${cause} — treated as wholly changed\n`);
    return [{ startLine: 1, lineCount: text.split('\n').length }];
  };
  const resolve = (key) => {
    if (evidence !== 'expected') return null;
    const rec = records.get(key);
    const entry = diffHasHunks ? diffMap.get(key) : null;
    if (entry && entry.hunks?.length > 0) {
      // A file outside the changed set is never measured, so its diff hunks only steer where its window sits: used as
      // given, unverified (a stale entry misplaces a window, it cannot fake coverage).
      if (!rec) return entry.hunks;
      // A CHANGED file's patch is trusted only if its post-image blob is the working-tree content. Anything weaker (do
      // its added lines still exist?) passes a patch that predates a later edit elsewhere in the file.
      const post = typeof entry.postImage === 'string' ? entry.postImage : null;
      const actual = post ? hashFile(rec.path) : null;
      if (post && typeof actual === 'string' && actual.startsWith(post)) return entry.hunks;
      const why = !post ? 'the supplied --diff carries no post-image id for it (no `index` line)'
        : actual === null ? 'its content could not be hashed to verify the supplied --diff'
          : 'the supplied --diff does not describe the current file (stale)';
      return wholeFile(rec, why);
    }
    if (!rec) return null;   // not a changed file: never invent a change for a dependent or shared file
    // A supplied --diff is the round's only evidence: never fall through to change-record hunks (code audit R1 H4).
    if (!diffMap && Array.isArray(rec.hunks)) return rec.hunks;
    const cause = diffMap
      ? (diffHasHunks ? 'absent from the supplied --diff' : 'no usable --diff for this round')
      : 'its diff hunks could not be read';
    return wholeFile(rec, cause);
  };
  const lookup = (key) => {
    if (!memo.has(key)) memo.set(key, resolve(key));
    return memo.get(key);
  };
  const hunksFor = (p) => lookup(normalizePath(p));
  return {
    evidence,
    applicable: evidence === 'expected',
    hunksFor,
    // The annotated reader's input shape: `get(normalisedKey) → {hunks} | undefined`.
    asDiffMap: () => ({ get: (key) => { const h = lookup(key); return h && h.length > 0 ? { hunks: h } : undefined; } }),
  };
}
