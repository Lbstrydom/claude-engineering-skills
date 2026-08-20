/**
 * @fileoverview Bake-off log read/append, entry shape (D2).
 *
 * Moved verbatim from `scripts/bakeoff-collect.mjs` (plan: comparison-
 * tooling-consolidation.md, Phase 2). Per D2a: may import `lib/file-io.mjs`
 * only; must NOT import any `scripts/*.mjs` entry point, `bakeoff/spawn.mjs`,
 * or `bakeoff/summary.mjs`.
 *
 * @module scripts/lib/bakeoff/log
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

/** Category A: accumulating run data, gitignored — never a committed artifact. */
export const LOG_PATH = '.audit/bakeoff-log.jsonl';

/**
 * Evidence counts only if produced under the contract the stopping rule
 * validates (AGENTS.md, Model Swap-In Evaluation Harness). Bump on any
 * meaning-changing fix and RE-COLLECT — never backfill by date, which is the
 * relabelling that produced five false "window met" reads on the tiered
 * collector.
 *
 * e2 (2026-08-03): all three arms moved onto one reasoning dial. Under e1 the
 * arms ran at three unchosen depths — Gemini 16384, Opus 0 (forced tool_choice
 * silently disables reasoning), Kimi 'low'. Every e1 row therefore describes a
 * configuration that no longer exists, so they are ineligible rather than
 * deleted: the rows stay readable, they just cannot count.
 *
 * e3 (2026-08-14, docs/plans/final-review-scoped-second-reviewer.md): the
 * shadow envelope itself changed — `thin` drops ~32KB of repo context and
 * narrows code files to the in-scope diff, versus e2's unbounded `full`
 * envelope. A snapshot's `contractEpoch` alone cannot say WHICH envelope
 * produced it (that is `controls.envelopeScope`, now signed cohort state —
 * see `isComplete`'s scope-binding check), but the epoch bump is still
 * required: e2 rows measured a materially different request and must not
 * silently pool with e3 rows just because the reasoning dial didn't change
 * again. Every e2 row is ineligible under this epoch, same disposition as e1
 * before it — re-collect, never backfill by date.
 */
export const CONTRACT_EPOCH = 'e3-scoped-envelope';

/**
 * Snapshot identity is the transcript's CONTENT hash, not its path — two runs
 * over the same bytes are one snapshot even if the file was copied or renamed,
 * and a re-run against edited content is correctly a NEW snapshot rather than a
 * silent overwrite.
 * @param {string} transcriptPath
 * @returns {string} first 12 hex of sha256
 */
export function snapshotId(transcriptPath) {
  const buf = fs.readFileSync(transcriptPath);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

/**
 * Plan-pairing identity (§7 Phase 4) — the SAME convention as `snapshotId`:
 * content, not path. A plan edited between collection calls is correctly a
 * DIFFERENT pairing, and two differently-named files with identical bytes
 * are correctly the SAME pairing.
 *
 * Stamped per ARM RESULT at collection time, never as a single entry-level
 * field — `mergeRetryHistory` (bakeoff-collect.mjs) carries an older
 * invocation's arms forward into a new entry, and only a genuinely NEW
 * collection call for an arm should stamp the CURRENT invocation's hash.
 *
 * @param {string} planPath
 * @returns {string} full hex sha256 (unlike `snapshotId`, not truncated —
 *   this is compared for exact equality, never displayed as a short id)
 */
export function planContentHash(planPath) {
  const buf = fs.readFileSync(planPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Every distinct snapshot in the log, newest entry wins per id.
 *
 * **A torn FINAL line is silently tolerated (the documented, intentional
 * case — a crash mid-write leaves one incomplete trailing line); a corrupt
 * line ANYWHERE ELSE is now surfaced, not silently dropped (consolidated-gate
 * finding, round-4/5 H23).** The prior version caught every parse failure
 * identically, so a truncated or bit-flipped line in the MIDDLE of the file —
 * a real corruption, not the expected append-crash shape — silently shrank
 * the evidence set with no signal anywhere. This repo's own D6 principle
 * ("no silent zero, honest degradation, never let corrupted data drive
 * decisions silently") applies here as directly as anywhere it is stated:
 * the whole campaign's uniqueness/cost/verdict computation is a function of
 * what this returns. A stderr warning is deliberately the mechanism, not a
 * thrown error — readLog is called from read-only reporting paths
 * (printProgress) as well as write paths, and a single corrupt historical
 * line should not make the WHOLE log unreadable for a caller that only
 * wants a progress summary; the point is visibility, not a harder failure
 * mode than the one this function already had.
 */
export function readLog(logPath = LOG_PATH) {
  if (!fs.existsSync(logPath)) return [];
  const byId = new Map();
  const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
  const lastNonEmptyIndex = lines.reduce((acc, l, i) => (l.trim() ? i : acc), -1);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e?.snapshotId) byId.set(e.snapshotId, e);
    } catch (err) {
      if (i === lastNonEmptyIndex) continue; // a torn final line must not lose every prior snapshot
      process.stderr.write(`  [bakeoff/log] readLog: corrupt line ${i + 1} of ${logPath} (not the final line — a real corruption, not a torn append): ${err.message}\n`);
    }
  }
  return [...byId.values()];
}
