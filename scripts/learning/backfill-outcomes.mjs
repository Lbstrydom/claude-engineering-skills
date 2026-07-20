#!/usr/bin/env node
/**
 * @fileoverview Out-of-band reconciler for adaptive-learning telemetry.
 * Two responsibilities:
 *
 * 1. **Drain** new entries from `.audit/quickfix-hits.jsonl` into the
 *    `learning_decisions` cloud table (one INSERT per `hit_id` with
 *    outcome=null).  Idempotent via `decision_key UNIQUE`.
 *
 * 2. **Resolve outcomes** for unresolved decisions older than 30 minutes —
 *    `quickfix_hit`, `arch_memory_band`, `convergence_predict`, and (Cluster B)
 *    `pass_selection` — each via its own detector. For quickfix_hit, by
 *    examining the file state NOW vs. at hit time:
 *      - line still present, no ignore-marker  → `ignore`
 *      - line still present, with marker added → `suppress`
 *      - line removed / changed                → `accept`
 *      - file deleted                          → `accept` (assumed fix)
 *
 * After resolving outcomes, optionally rebuild `quickfix-pattern-stats.json`
 * so `matchPatterns()` picks up the latest weights on next session.
 *
 * Run by:
 *   - GH Actions weekly cron (BEFORE weekly-review)
 *   - On-demand: `npm run learning:backfill-outcomes`
 *   - On-demand: `node scripts/cross-skill.mjs learning-backfill-outcomes`
 *
 * CLI output contract: stdout JSON; stderr progress logs.
 *
 * Plan: docs/plans/adaptive-learning-phase-2-quickfix.md §2 (backfill-outcomes)
 *
 * @module scripts/learning/backfill-outcomes
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { redactSecrets } from '../lib/secret-patterns.mjs';
import { atomicWriteFileSync } from '../lib/file-io.mjs';
import { retrySync } from '../lib/retry-transient-fs.mjs';
import { findRepoPragmas } from '../lib/duplicate-justification-pragma.mjs';

// ── Constants ──────────────────────────────────────────────────────────────

const HITS_JSONL_PATH    = '.audit/quickfix-hits.jsonl';
const DRAIN_MARKER_PATH  = '.audit/quickfix-hits.drained-offset';
const FRICTION_JSONL_PATH = '.audit/friction-log.jsonl';
const STALENESS_MS       = 30 * 60 * 1000; // 30 minutes
const HOOK_IGNORE_MARKER = 'quickfix-hook:ignore';

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run the full backfill cycle.  Returns a summary object that gets
 * emitted to stdout when invoked from CLI or cross-skill.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoId]      — restrict to one repo (defaults to all)
 * @param {boolean} [opts.dryRun]     — compute but don't write
 * @param {boolean} [opts.skipDrain]  — don't drain JSONL into learning_decisions
 * @param {boolean} [opts.skipResolve] — don't resolve unresolved outcomes
 * @param {boolean} [opts.rebuildStats] — after resolving, run quickfix-stats --rebuild
 * @returns {Promise<object>}
 */
export async function runBackfill(opts = {}) {
  const {
    repoId = null,
    dryRun = false,
    skipDrain = false,
    skipResolve = false,
    rebuildStats = false,
  } = opts;

  const summary = {
    ok: true,
    drain: { processed: 0, inserted: 0, errors: 0 },
    resolve: { examined: 0, resolved: 0, stillPending: 0, errors: 0 },
    rebuild: { ran: false, ok: null, totalDecisions: null },
  };

  const learningStore = await import('../learning-store.mjs');
  if (typeof learningStore.initLearningStore === 'function') {
    await learningStore.initLearningStore();
  }
  // isCloudEnabled() is async — without await, `&&` yields a (truthy) Promise,
  // so the cloud-disabled guard below never fires (Cluster B fix).
  const cloudEnabled = typeof learningStore.isCloudEnabled === 'function' && await learningStore.isCloudEnabled();
  if (!cloudEnabled) {
    return { ...summary, ok: true, cloud: false, reason: 'cloud-disabled' };
  }

  if (!skipDrain) {
    try {
      const r = await drainJsonlToCloud({ learningStore, repoId, dryRun });
      summary.drain = r;
    } catch (err) {
      summary.drain.errors += 1;
      process.stderr.write(`[backfill] drain failed: ${err.message}\n`);
    }
    // Audit-fix Phase-3-friction R1 H3: also drain the friction-log
    // local fallback so notes captured while cloud was offline make it
    // upstream and surface in the next weekly digest.
    try {
      const r = await drainFrictionFallback({ learningStore, dryRun });
      summary.frictionDrain = r;
    } catch (err) {
      process.stderr.write(`[backfill] friction-drain failed: ${err.message}\n`);
      summary.frictionDrain = { processed: 0, inserted: 0, errors: 1 };
    }
  }

  if (!skipResolve) {
    try {
      const r = await resolveUnresolvedOutcomes({ learningStore, repoId, dryRun });
      summary.resolve = r;
    } catch (err) {
      summary.resolve.errors += 1;
      process.stderr.write(`[backfill] resolve failed: ${err.message}\n`);
    }
  }

  // Cluster C / Phase 6 — recompute recurring_finding_clusters for the repo
  // (cadence: the same maintenance pass that drains/resolves). Per-repo only;
  // a global (repoId-less) backfill skips it (the recompute is repo-scoped).
  if (!dryRun && typeof learningStore.refreshRecurringClusters === 'function') {
    // Per-repo recompute. With an explicit repoId, refresh that repo; in the
    // repo-less (global maintenance) mode, refresh EVERY repo so the scheduled
    // path doesn't silently skip the recompute (R2 finding).
    let repoIds = [];
    try {
      repoIds = repoId
        ? [repoId]
        : (typeof learningStore.listRepoIds === 'function' ? await learningStore.listRepoIds() : []);
    } catch (err) {
      process.stderr.write(`[backfill] cluster refresh: listRepoIds failed: ${err.message}\n`);
      summary.clusterRefreshError = true;
    }
    let total = 0;
    // Per-repo isolation (Gemini): one repo's failure must NOT abort the rest
    // or reset the accumulated count.
    for (const id of repoIds) {
      try {
        total += await learningStore.refreshRecurringClusters(id);
      } catch (err) {
        process.stderr.write(`[backfill] cluster refresh failed for ${id}: ${err.message}\n`);
        summary.clusterRefreshError = true;
      }
    }
    summary.clustersRefreshed = total;
    summary.clustersRefreshedRepos = repoIds.length;
  }

  if (rebuildStats && !dryRun) {
    try {
      const { rebuildFromCloud } = await import('../lib/learning/quickfix-stats.mjs');
      const r = await rebuildFromCloud({ repoId });
      summary.rebuild = { ran: true, ok: r.ok, totalDecisions: r.totalDecisions };
    } catch (err) {
      summary.rebuild = { ran: true, ok: false, error: err.message };
    }
  }

  // Honest status (Gemini-r1): a reconciliation job must not report ok:true
  // when sub-steps errored. Surface the failure rather than masking it.
  const totalErrors = (summary.drain?.errors || 0)
    + (summary.frictionDrain?.errors || 0)
    + (summary.resolve?.errors || 0)
    + (summary.clusterRefreshError ? 1 : 0)
    + (summary.rebuild && summary.rebuild.ran && summary.rebuild.ok === false ? 1 : 0);
  summary.errorCount = totalErrors;
  summary.ok = totalErrors === 0;
  if (totalErrors > 0) summary.degraded = true;
  return summary;
}

// ── Drain JSONL → learning_decisions ──────────────────────────────────────

/**
 * Read new entries from `.audit/quickfix-hits.jsonl` since the last
 * drained-offset marker, and insert one learning_decisions row per match.
 * Skip-on-conflict via decision_key UNIQUE; safe to replay.
 *
 * Audit-fix (Phase 2 R1 H11): the cursor stores BOTH a byte offset AND
 * a fingerprint of the file's leading bytes (sha256 of first 256 bytes,
 * or the whole file if smaller).  On read, we verify the fingerprint
 * matches; if not (file rotated, rewritten, or recreated with the same
 * size), we reset the cursor to 0 and reprocess from the beginning.
 * Idempotent inserts via decision_key UNIQUE keep this safe.
 */
async function drainJsonlToCloud({ learningStore, repoId, dryRun }) {
  const out = { processed: 0, inserted: 0, errors: 0, lastOffset: 0, cursorReset: false };
  if (!fs.existsSync(HITS_JSONL_PATH)) return out;

  const stat = fs.statSync(HITS_JSONL_PATH);
  const cursor = readDrainCursor();
  let prevOffset = cursor.offset;

  // Verify file identity by fingerprint — detects rotation that the byte
  // offset alone would miss (e.g. truncate-then-grow back to same size).
  const currentFingerprint = computeFileFingerprint(HITS_JSONL_PATH);
  if (cursor.fingerprint && cursor.fingerprint !== currentFingerprint) {
    process.stderr.write('[backfill] hits JSONL fingerprint changed — resetting cursor to 0\n');
    prevOffset = 0;
    out.cursorReset = true;
  } else if (stat.size < prevOffset) {
    // Size shrank without fingerprint mismatch — also a rotation signal.
    process.stderr.write('[backfill] hits JSONL shrank — resetting cursor to 0\n');
    prevOffset = 0;
    out.cursorReset = true;
  }

  // Read only the new range.
  const fd = fs.openSync(HITS_JSONL_PATH, 'r');
  const newBytes = stat.size - prevOffset;
  if (newBytes <= 0) {
    fs.closeSync(fd);
    out.lastOffset = prevOffset;
    return out;
  }
  const buf = Buffer.alloc(newBytes);
  fs.readSync(fd, buf, 0, newBytes, prevOffset);
  fs.closeSync(fd);

  const text = buf.toString('utf-8');
  // Audit-fix (Phase 2 R2 H4): if the file does not end with a newline,
  // the last "line" may be a partial record still being written by the
  // hook.  Retain it so the next drain reads it whole.
  // Audit-fix (Phase 3 R2 M3/M13): detect actual newline byte length —
  // CRLF (Windows hook output) consumes 2 bytes per line separator, LF
  // consumes 1.  We sniff the first separator and use it consistently.
  const endsWithCRLF = text.endsWith('\r\n');
  const endsWithNewline = endsWithCRLF || text.endsWith('\n');
  const usesCRLF = /\r\n/.test(text);
  const NEWLINE_BYTES = usesCRLF ? 2 : 1;
  const rawLines = text.split(/\r?\n/);
  const lines = endsWithNewline
    ? rawLines.filter(Boolean)
    : rawLines.slice(0, -1).filter(Boolean); // drop partial tail
  // Compute the retained partial-tail length from the RAW buffer, not the
  // toString'd tail: a half-written multibyte char at EOF becomes U+FFFD (3
  // bytes) under toString and would miscount the cursor (Gemini-r1). The last
  // LF byte (0x0a) is a char boundary; everything after it is the partial tail.
  let partialBytes = 0;
  if (!endsWithNewline) {
    const lastNl = buf.lastIndexOf(0x0a);
    partialBytes = lastNl === -1 ? buf.length : buf.length - (lastNl + 1);
  }

  // Audit-fix Phase 3 R1 H6: track per-line byte offsets so we only
  // advance the cursor past records that COMPLETELY succeeded.  If any
  // insert in a record fails, the cursor stops at the start of that
  // record; subsequent records still process (their inserts are
  // idempotent via decision_key UNIQUE), but the cursor freezes at the
  // first-failure boundary so the failed record is retried on next run.
  let cumulativeBytes = 0;            // bytes BEFORE current line
  let firstFailureOffset = null;      // null until something fails
  for (const line of lines) {
    // Audit-fix Phase 3 R2 M3/M13: use detected NEWLINE_BYTES so CRLF
    // files don't undercount and leak old records into the next drain.
    const lineBytes = Buffer.byteLength(line, 'utf-8') + NEWLINE_BYTES;
    let record;
    let recordOk = true;
    try { record = JSON.parse(line); }
    catch {
      out.errors += 1;
      recordOk = false;
      record = null;
    }
    if (record && Array.isArray(record.matches)) {
      for (const m of record.matches) {
        out.processed += 1;
        if (!m.hit_id) continue;
        const entry = {
          decisionKey: `quickfix_hit:${m.hit_id}`,
          decisionType: 'quickfix_hit',
          externalId: m.hit_id,
          repoId: repoId || null,
          context: {
            pattern: m.name,
            // Defence-in-depth (Gemini): the quickfix hook already redacts +
            // skips sensitive paths at write-time, but re-redact at the cloud
            // egress boundary so a stale/hand-edited jsonl line can't leak a
            // secret upstream.
            file: redactSecrets(String(record.file ?? '')).text,
            severity: m.severity,
            snippet: redactSecrets(String(m.snippet ?? '')).text,
            ts: record.ts,
          },
          contextHash: '',
          choice: { action: 'flagged' },
          outcome: null,
        };
        const canonical = JSON.stringify(entry.context, Object.keys(entry.context).sort());
        entry.contextHash = crypto.createHash('sha256').update(canonical).digest('hex');
        if (dryRun) { out.inserted += 1; continue; }
        const r = await learningStore.insertLearningDecision(entry);
        if (r.ok) {
          out.inserted += 1;
        } else {
          out.errors += 1;
          recordOk = false;
          process.stderr.write(`[backfill] insert failed for ${entry.decisionKey}: ${r.error || ''}\n`);
        }
      }
    }
    if (!recordOk && firstFailureOffset === null) {
      firstFailureOffset = prevOffset + cumulativeBytes;
    }
    cumulativeBytes += lineBytes;
  }

  // Persist cursor.  Default: advance to (file size - partial tail).
  // If a record failed, freeze cursor at the start of that record so it
  // gets retried on the next drain.
  const fullProcessedOffset = stat.size - partialBytes;
  const newOffset = firstFailureOffset !== null ? firstFailureOffset : fullProcessedOffset;
  if (!dryRun) {
    try {
      writeDrainCursor({
        offset: newOffset,
        fingerprint: currentFingerprint,
        updatedAt: new Date().toISOString(),
      });
    } catch { /* best effort */ }
  }
  out.lastOffset = newOffset;
  out.partialBytesRetained = partialBytes;
  out.frozenAtFailure = firstFailureOffset !== null;
  return out;
}

// ── Friction-log fallback drain (Audit-fix friction R1 H3) ──────────────
//
// Plain JSONL drain — every line is one friction note that was captured
// when the cloud was offline.  We DELETE-then-recreate the file after a
// successful drain; the cost of replaying a recently-failed line is
// negligible (friction notes are tiny + not idempotency-critical).
// Skip silently when the file is absent (the common case once cloud is
// healthy and the operator hasn't been working offline).

async function drainFrictionFallback({ learningStore, dryRun }) {
  const out = { processed: 0, inserted: 0, errors: 0 };
  if (!fs.existsSync(FRICTION_JSONL_PATH)) return out;

  let raw;
  try { raw = fs.readFileSync(FRICTION_JSONL_PATH, 'utf-8'); }
  catch { out.errors += 1; return out; }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return out;

  const remaining = []; // lines to retain after this drain (failed inserts)
  for (const line of lines) {
    out.processed += 1;
    let record;
    try { record = JSON.parse(line); }
    catch { out.errors += 1; continue; }
    if (!record || typeof record.message !== 'string') {
      out.errors += 1;
      continue;
    }
    // Resolve repo name → repo_id at drain time; it may have been
    // unresolvable when the note was captured (e.g. fresh consumer repo).
    let repoId = null;
    if (record.repo && typeof learningStore.getRepoIdByName === 'function') {
      repoId = await learningStore.getRepoIdByName(record.repo).catch(() => null);
    }
    if (dryRun) { out.inserted += 1; continue; }
    let result;
    try {
      result = await learningStore.insertFrictionNote({
        repoId,
        message:  record.message,
        cwd:      record.cwd ?? null,
        severity: record.severity ?? 'note',
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (result.ok) {
      out.inserted += 1;
    } else {
      out.errors += 1;
      remaining.push(line); // keep for the next drain attempt
      process.stderr.write(`[friction-drain] insert failed (retained): ${result.error || ''}\n`);
    }
  }

  // Rewrite the file with only the failed lines (or delete it entirely
  // if everything drained).  Atomic via temp+rename.
  if (!dryRun) {
    try {
      if (remaining.length === 0) {
        retrySync(() => fs.unlinkSync(FRICTION_JSONL_PATH));
      } else {
        atomicWriteFileSync(FRICTION_JSONL_PATH, remaining.join('\n') + '\n');
      }
    } catch (err) {
      out.errors += 1;
      process.stderr.write(`[friction-drain] rewrite failed: ${err.message}\n`);
    }
  }
  return out;
}

// Exported for unit testing.
export { drainFrictionFallback };

// ── Drain-cursor helpers (Audit-fix R1 H11) ───────────────────────────────

/**
 * Read the drain cursor.  Backwards-compatible with the legacy plain-int
 * format: if the file contains only a number, we treat it as the offset
 * with no fingerprint (forces a reset on the next drain since we cannot
 * verify continuity).
 *
 * @returns {{offset: number, fingerprint: string|null, updatedAt: string|null}}
 */
function readDrainCursor() {
  if (!fs.existsSync(DRAIN_MARKER_PATH)) return { offset: 0, fingerprint: null, updatedAt: null };
  let raw;
  try { raw = fs.readFileSync(DRAIN_MARKER_PATH, 'utf-8'); }
  catch { return { offset: 0, fingerprint: null, updatedAt: null }; }
  // Try JSON first (new format); fall back to legacy int.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.offset === 'number') {
      return {
        offset: parsed.offset,
        fingerprint: typeof parsed.fingerprint === 'string' ? parsed.fingerprint : null,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      };
    }
  } catch { /* legacy format below */ }
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) {
    return { offset: n, fingerprint: null, updatedAt: null };
  }
  return { offset: 0, fingerprint: null, updatedAt: null };
}

function writeDrainCursor({ offset, fingerprint, updatedAt }) {
  fs.writeFileSync(
    DRAIN_MARKER_PATH,
    JSON.stringify({ offset, fingerprint, updatedAt }),
  );
}

/**
 * SHA-256 of the file's leading bytes (up to 256, or whole file if smaller).
 * Used as a cheap rotation-detection fingerprint — different content at
 * the start of the file = different fingerprint = cursor reset.
 */
function computeFileFingerprint(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const len = Math.min(256, stat.size);
    const buf = Buffer.alloc(len);
    if (len > 0) fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

// ── Resolve unresolved outcomes ──────────────────────────────────────────

async function resolveUnresolvedOutcomes({ learningStore, repoId, dryRun }) {
  const out = {
    examined: 0,
    resolved: 0,
    stillPending: 0,
    errors: 0,
    byType: { quickfix_hit: 0, arch_memory_band: 0, convergence_predict: 0, pass_selection: 0 },
  };

  // Phase 3: resolve THREE decision types — quickfix_hit (Phase 2),
  // arch_memory_band (this phase), and convergence_predict (this phase).
  // Each has its own pure detector below; the resolver routes to the
  // right one based on `decision_type`.
  const RESOLVABLE_TYPES = ['quickfix_hit', 'arch_memory_band', 'convergence_predict', 'pass_selection'];
  const cutoff = new Date(Date.now() - STALENESS_MS).toISOString();

  let rows = [];
  try {
    // M3 P3 — replaces raw `lib/stores/supabase-store::getWriteClient()` +
    // a hand-rolled query with the typed `readUnresolvedDecisions` export.
    rows = await learningStore.readUnresolvedDecisions({
      types: RESOLVABLE_TYPES,
      cutoff,
      repoId: repoId || null,
      limit: 500,
    });
  } catch (err) {
    process.stderr.write(`[backfill] resolve read error: ${err.message}\n`);
    out.errors += 1;
    return out;
  }

  for (const row of rows) {
    out.examined += 1;
    let outcome = null;
    if (row.decision_type === 'quickfix_hit') {
      outcome = computeOutcomeFromFileState(row);
    } else if (row.decision_type === 'arch_memory_band') {
      outcome = await computeArchMemoryBandOutcome(row);
    } else if (row.decision_type === 'convergence_predict') {
      // M3 P3 — the detector now takes the store, not a raw supabase client,
      // so it can use the typed `getAuditRunConvergence` export.
      outcome = await computeConvergencePredictOutcome(row, { learningStore });
    } else if (row.decision_type === 'pass_selection') {
      // Cluster B / Phase 4 — resolve against the run's finding adjudications.
      outcome = await computePassSelectionOutcome(row, { learningStore });
    }
    if (!outcome) { out.stillPending += 1; continue; }
    if (dryRun) {
      out.resolved += 1;
      out.byType[row.decision_type] = (out.byType[row.decision_type] || 0) + 1;
      continue;
    }
    const r = await learningStore.backfillLearningOutcome({
      decisionKey: row.decision_key,
      outcome,
    });
    if (r.ok) {
      out.resolved += 1;
      out.byType[row.decision_type] = (out.byType[row.decision_type] || 0) + 1;
    } else {
      out.errors += 1;
    }
  }
  return out;
}

// ── arch_memory_band outcome detector ─────────────────────────────────────

/**
 * How long a `justify-divergence` row stays pending while we wait for a
 * `@duplicate-justification` pragma to appear. Deliberately much longer than
 * STALENESS_MS (which only gates when a row becomes *eligible* to resolve):
 * the pragma is written by a human or an audit round, not within 30 minutes of
 * the consultation. Bounded so pending rows cannot accumulate forever.
 */
const PRAGMA_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Repo-root-relative, forward-slashed, no `./` prefix — pragma `target=` is
 *  author-typed while `context.filePath` comes from the indexer, so the two
 *  spellings must be normalised before comparison. */
function normaliseRepoPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Memoised pragma sweep. `findRepoPragmas` shells out to `git grep`, and
 * resolvePending processes up to 500 rows per invocation — one sweep per row
 * would be 500 subprocesses for an answer that cannot change mid-run. Module
 * scope is safe here for the same reason as the other caches in this repo
 * (CLI-per-invocation; see AGENTS.md "Accepted Technical Debt").
 */
let _pragmaCache = null;
function defaultGetRepoPragmas() {
  if (_pragmaCache) return _pragmaCache;
  // strict: a failed sweep must not read as "zero pragmas" — that would mint
  // false `divergence-unjustified` verdicts for every row in the batch.
  _pragmaCache = findRepoPragmas(process.cwd(), { strict: true });
  return _pragmaCache;
}

/** Test seam — clears the memoised sweep. */
export function _resetPragmaCache() { _pragmaCache = null; }

/**
 * Resolve the outcome of an arch_memory_band decision by inspecting git
 * history shortly after the decision.  v1 implementation is conservative:
 * it returns 'reuse-correct' / 'extend-correct' / 'wrong-fork' / 'uncertain'
 * based on whether the candidate symbol's source file gained new commits
 * referencing the symbol within 30 minutes of the decision.
 *
 * Heuristic (v1):
 *   - decision recommended `reuse` AND no new symbol added in the
 *     candidate file's directory within 30 min → reuse-correct
 *   - decision recommended `extend` AND the candidate file was modified
 *     within 30 min → extend-correct
 *   - decision recommended `reuse` AND a NEW symbol with a similar name
 *     appeared in a sibling/different file within 30 min → wrong-fork
 *   - otherwise → uncertain (still emit so the row stops being pending)
 *
 * Pure given inputs.  Exec'd for git only when fs paths exist.
 *
 * @param {{decision_key: string, context: object, choice: object, created_at: string}} row
 * @param {object} [deps] — { execGit } injected for tests
 * @returns {Promise<{action: string, evidence: string}|null>}
 */
export async function computeArchMemoryBandOutcome(row, deps = {}) {
  const ctx = row?.context;
  const ch  = row?.choice;
  if (!ctx || !ch) return null;
  const filePath = typeof ctx.filePath === 'string' ? ctx.filePath : null;
  const symbol   = typeof ctx.symbol === 'string' ? ctx.symbol : null;
  const band     = ch.band;
  if (!band) return null;

  // `justify-divergence` IS a recommendation ("proceed, but say why"), so it is
  // resolvable — and it has to be, because it and `review` are the only bands
  // that ever fire. `reuse`/`extend` carry the git-probe logic below but sit
  // above this pipeline's similarity ceiling: 0 of 1,763 consultations reached
  // them (docs/plans/arch-memory-band-recalibration.md §1). Returning a blanket
  // `uncertain` here therefore made the arch_memory_band loop vacuous BY
  // CONSTRUCTION — 1,745 resolved rows, 100% `uncertain`, every `evidence`
  // string echoing the input band back as if it were a measurement. Same
  // species as the since/until inversion documented below, which also produced
  // a verdict that had checked nothing.
  //
  // The resolution signal already exists and is already mechanical: the
  // `@duplicate-justification` pragma that /audit-code's duplication wave and
  // drift.mjs both consume. A pragma naming this candidate as its `target=` is
  // the author saying, in a greppable artifact, "I saw it and forked anyway,
  // here is why" — which is exactly what the band asked for.
  if (band === 'justify-divergence') {
    if (!filePath || !symbol) {
      return { action: 'uncertain', evidence: 'missing-file-or-symbol' };
    }
    const getPragmas = deps.getRepoPragmas || defaultGetRepoPragmas;
    let pragmas;
    try {
      pragmas = getPragmas();
    } catch (err) {
      // A failed sweep and "genuinely zero pragmas" are NOT interchangeable
      // here: treating a git hiccup as zero would mint a false
      // `divergence-unjustified`. Stay pending instead.
      return { action: 'uncertain', evidence: `pragma-sweep-failed: ${err.message || 'unknown'}` };
    }
    const hit = pragmas.find(p =>
      normaliseRepoPath(p.targetFile) === normaliseRepoPath(filePath) &&
      p.targetSymbol === symbol);
    if (hit) {
      return {
        action: 'divergence-justified',
        evidence: `pragma@${normaliseRepoPath(hit.pragmaFile)}:${hit.pragmaLine}`,
      };
    }
    // No pragma yet. A pragma can legitimately land later than the decision, so
    // do NOT resolve on first look — `uncertain` would close the row forever
    // (backfillLearningOutcome sets outcome_at) and re-create the vacuity in a
    // new shape. Stay pending until the grace window has passed; the bounded
    // window is what stops rows accumulating unresolved.
    const decisionMs = Date.parse(row.created_at);
    if (!Number.isFinite(decisionMs)) {
      return { action: 'uncertain', evidence: 'unparseable-decision-timestamp' };
    }
    if (Date.now() - decisionMs < PRAGMA_GRACE_MS) return null; // retry later
    return { action: 'divergence-unjustified', evidence: 'no-pragma-targeting-candidate' };
  }

  // `review` means "nothing appropriate exists — proceed greenfield". Resolving
  // that requires evidence the greenfield call was right, which no artifact in
  // this repo currently carries, so it stays deliberately unresolved rather
  // than pretending. NOTE this is still 1,917 tautological rows; it is the
  // remaining half of the vacuity, tracked in the plan's §13, not fixed here.
  if (band === 'review') {
    return { action: 'uncertain', evidence: 'band=review; no resolution signal defined' };
  }

  // Without a file path we can't probe git — emit uncertain.
  if (!filePath || !symbol) {
    return { action: 'uncertain', evidence: 'missing-file-or-symbol' };
  }

  const execGit = deps.execGit || defaultExecGit;
  const decisionTs = row.created_at;

  // Look at commits in the cited file's directory within 30 min AFTER the
  // decision — proxies "did the user act on the recommendation?"
  //
  // The window must run FORWARD from the decision. It previously read
  // `--since=30.minutes.ago --until=<decisionTs>`, i.e. since=~now against
  // until=a timestamp at least STALENESS_MS old (rows are only selected once
  // they are >30min old). since > until always, so git returned nothing for
  // every row ever resolved, pinning commitsTouched=0 and making `reuse`
  // unconditionally emit `reuse-correct` — a green that never checked
  // anything. Bounds are now both derived from decisionTs.
  const decisionMs = Date.parse(decisionTs);
  if (!Number.isFinite(decisionMs)) {
    return { action: 'uncertain', evidence: 'unparseable-decision-timestamp' };
  }
  const windowEnd = new Date(decisionMs + STALENESS_MS).toISOString();

  let commitsTouched = 0;
  try {
    const dir = path.posix.dirname(String(filePath).replace(/\\/g, '/'));
    const argLog = ['log',
      `--since=${decisionTs}`,
      `--until=${windowEnd}`,
      '--pretty=format:%H',
      '--', dir];
    const out1 = execGit(argLog, { cwd: process.cwd() });
    if (typeof out1 === 'string' && out1.trim().length > 0) {
      commitsTouched = out1.trim().split('\n').filter(Boolean).length;
    }
  } catch {
    // Git unavailable/failed — we observed NOTHING. Emitting the
    // commitsTouched=0 branch here would convert an error into a positive
    // `reuse-correct` label. Degrade to uncertain instead.
    return { action: 'uncertain', evidence: 'git-probe-failed' };
  }

  if (band === 'reuse') {
    return commitsTouched === 0
      ? { action: 'reuse-correct', evidence: 'no-new-commits-in-dir' }
      : { action: 'wrong-fork', evidence: `${commitsTouched}-commits-after-reuse` };
  }
  if (band === 'extend') {
    return commitsTouched > 0
      ? { action: 'extend-correct', evidence: `${commitsTouched}-commits-touched-dir` }
      : { action: 'uncertain', evidence: 'no-followup-edits' };
  }
  return { action: 'uncertain', evidence: `band=${band}` };
}

function defaultExecGit(args, opts) {
  return execFileSync('git', args, {
    cwd: opts?.cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf-8',
    timeout: 5000,
  });
}

// ── convergence_predict outcome detector ──────────────────────────────────

/**
 * Resolve the outcome of a convergence_predict decision by reading
 * `audit_runs.round_converged_after` + `rigor_pressure_round` for the
 * decision's run.  Once the run finishes, those columns tell us whether
 * a "continue" choice would have been correct (run did go to next round)
 * or wasted (this round was the convergence point).
 *
 * @param {object} row
 * @param {object} deps — { client } the supabase client to read audit_runs
 * @returns {Promise<{action: string, evidence: string, converged_at: number, round: number}|null>}
 */
export async function computeConvergencePredictOutcome(row, deps = {}) {
  // M3 P3 — the legacy `deps.client` path (raw supabase client) is gone;
  // callers inject the learning store instead and we use the typed
  // `getAuditRunConvergence` export. The `deps.getRunConvergence` injection
  // point stays for unit tests that want to stub without a real store.
  if (!row.audit_run_id || row.round == null) return null;
  const ls = deps.learningStore;
  const getRunConvergence = deps.getRunConvergence
    || (ls && typeof ls.getAuditRunConvergence === 'function' ? ls.getAuditRunConvergence : null);
  if (!getRunConvergence) return null;
  let runRow = null;
  try {
    runRow = await getRunConvergence(row.audit_run_id);
    if (!runRow) return null;
  } catch { return null; }

  const convergedAt        = runRow.roundConvergedAfter;
  const rigorPressureRound = runRow.rigorPressureRound;
  const finalRound         = runRow.rounds;
  // If the run is still in flight (no convergence + no rigor + no final round
  // recorded), leave pending.
  if (convergedAt == null && rigorPressureRound == null && finalRound == null) return null;

  const decisionRound = Number(row.round);
  // Synthesize a stable "stopAtRound" — whichever of the three signals is
  // first.  Falls back to finalRound (== rounds) when neither convergence
  // nor rigor-pressure was tagged.
  const stopAt = [convergedAt, rigorPressureRound, finalRound]
    .filter(x => Number.isFinite(x))
    .reduce((a, b) => a < b ? a : b, Infinity);

  if (!Number.isFinite(stopAt)) return null;

  const hitMax = rigorPressureRound != null && rigorPressureRound === decisionRound;
  const wasConvergence = convergedAt != null && convergedAt === decisionRound;

  return {
    action: wasConvergence ? 'converged-here' : (decisionRound < stopAt ? 'continued' : 'wasted'),
    evidence: `stopAt=${stopAt} thisRound=${decisionRound}`,
    converged_at: convergedAt ?? null,
    rigor_pressure_round: rigorPressureRound ?? null,
    hit_max: hitMax,
    round: decisionRound,
  };
}

// ── pass_selection outcome detector ───────────────────────────────────────

/**
 * Resolve a `pass_selection` decision (Cluster B / Phase 4, plan R1-H7) by
 * joining it to the adjudication outcomes of the findings its run raised.
 * Reward = fraction of the run's findings the deliberation sustained
 * (`adjudication_outcome = 'accepted'`).
 *
 * Stays PENDING (returns null) until the run's findings have been adjudicated
 * (outcome-sync has run) — so we never resolve to a false 0 before the labels
 * exist. **Zero-findings guard (Gemini-3)**: a run with 0 findings → terminal
 * `low-yield` with neutral reward 0, never a division-by-zero.
 *
 * Terminal states: `useful` (reward ≥ 0.5) / `low-yield` (< 0.5 or empty).
 * Idempotency: the resolver keys on the decision's own decision_key.
 *
 * @param {object} row - learning_decisions row (has audit_run_id)
 * @param {object} [deps] - { learningStore, getOutcomeCounts? } injection for tests
 */
export async function computePassSelectionOutcome(row, deps = {}) {
  if (!row.audit_run_id) return null;
  const ls = deps.learningStore;
  const getCounts = deps.getOutcomeCounts
    || (ls && typeof ls.getRunFindingOutcomeCounts === 'function' ? ls.getRunFindingOutcomeCounts : null);
  if (!getCounts) return null;

  let counts = null;
  try { counts = await getCounts(row.audit_run_id); } catch { return null; }
  if (!counts) return null;

  // Findings exist but none adjudicated yet → leave pending (resolves once
  // outcome-sync labels them). This is the Phase-3 → Phase-4 coupling.
  if (counts.total > 0 && !counts.anyAdjudicated) return null;

  if (counts.total === 0) {
    return { action: 'low-yield', reward: 0, total: 0, accepted_or_fixed: 0, evidence: 'run raised no findings' };
  }
  const reward = counts.acceptedOrFixed / counts.total;
  return {
    action: reward >= 0.5 ? 'useful' : 'low-yield',
    reward,
    total: counts.total,
    accepted_or_fixed: counts.acceptedOrFixed,
    evidence: `${counts.acceptedOrFixed}/${counts.total} accepted`,
  };
}

/**
 * Pure outcome detector — given a learning_decisions row's `context`
 * (file path, snippet, ts) and the current file state, return one of
 * {accept, suppress, ignore, no_action} or null when undecidable.
 *
 * Exported for unit testing.
 *
 * Audit-fix (Phase 2 R1 H7): the `file` field comes from the database
 * which we don't fully trust — explicitly resolve against repo root,
 * reject absolute paths and `..` traversal, and refuse to read anything
 * outside the repo cwd.  Defence-in-depth even though service-role-only
 * RLS already gates writers.
 *
 * @param {{decision_key: string, context: object, created_at: string}} row
 * @param {object} [deps] — { fs, repoRoot } injected for tests
 * @returns {{action: 'accept'|'suppress'|'ignore'|'no_action'}|null}
 */
export function computeOutcomeFromFileState(row, deps = {}) {
  const fsLib = deps.fs || fs;
  const repoRoot = deps.repoRoot || process.cwd();
  const ctx = row?.context;
  if (!ctx || typeof ctx.file !== 'string' || !ctx.snippet) return null;

  // Path-safety gate: reject absolute paths, drive letters, and traversal
  // sequences.  Resolve relative to repo root and verify the result stays
  // inside it.  No fs read happens until the path passes.
  const rawFile = ctx.file;
  if (path.isAbsolute(rawFile) || /^[a-zA-Z]:[\\/]/.test(rawFile)) return null;
  if (rawFile.split(/[\\/]/).some(seg => seg === '..')) return null;
  const resolvedPath = path.resolve(repoRoot, rawFile);
  const repoRootResolved = path.resolve(repoRoot);
  // path.relative returns '..' or starts with '..' when target escapes the root.
  const rel = path.relative(repoRootResolved, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  let fileExists = false;
  let content = '';
  try {
    fileExists = fsLib.existsSync(resolvedPath);
    if (fileExists) content = fsLib.readFileSync(resolvedPath, 'utf-8');
  } catch { return null; }

  if (!fileExists) {
    // File deleted — assume the user fixed by removing the offending file.
    return { action: 'accept', evidence: 'file-deleted' };
  }

  // Snippet match: the snippet is truncated at 80 chars by matchPatterns,
  // so we look for it as a substring of any line (loose match — exact
  // line-by-line match would be too brittle once a line is reformatted).
  const snippet = ctx.snippet || '';
  // Strip the "..." truncation suffix when checking.
  const probe = snippet.endsWith('...') ? snippet.slice(0, -3) : snippet;
  if (probe.length < 8) return { action: 'no_action', evidence: 'snippet-too-short' };

  const present = content.includes(probe);
  if (!present) {
    return { action: 'accept', evidence: 'snippet-removed' };
  }

  // Snippet still present.  Check for the suppression marker on the line
  // containing the snippet OR the line above (multi-line patterns put the
  // marker above).
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes(probe)) continue;
    const here = lines[i];
    const prev = i > 0 ? lines[i - 1] : '';
    if (here.includes(HOOK_IGNORE_MARKER) || prev.includes(HOOK_IGNORE_MARKER)) {
      return { action: 'suppress', evidence: 'ignore-marker-found' };
    }
    break;
  }
  // Snippet present and no marker → user ignored.
  return { action: 'ignore', evidence: 'still-present-no-marker' };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const repoIdx = args.indexOf('--repo');
  const opts = {
    repoId:        repoIdx >= 0 ? args[repoIdx + 1] : null,
    dryRun:        args.includes('--dry-run'),
    skipDrain:     args.includes('--skip-drain'),
    skipResolve:   args.includes('--skip-resolve'),
    rebuildStats:  args.includes('--rebuild-stats'),
  };
  const result = await runBackfill(opts);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}

// ── Test-only export ─────────────────────────────────────────────────────

export const _internals = Object.freeze({
  HITS_JSONL_PATH,
  DRAIN_MARKER_PATH,
  STALENESS_MS,
  HOOK_IGNORE_MARKER,
  drainJsonlToCloud,
  resolveUnresolvedOutcomes,
});
