/**
 * @fileoverview Lock-safe JSONL append writer for `.audit/orphan-metrics.jsonl`.
 *
 * Schema: dual-record per run (Gemini-R2/M2 fix):
 *   1. run-summary record (always emitted, even when 0 findings)
 *   2. per-raw-finding record (including suppressed)
 *
 * Audit-code R1/M5+M10 compromise: each run's records are written under a
 * SINGLE lock acquisition (acquire once, append all lines in order, release).
 * This preserves the "summary first, findings follow" run-level contract under
 * concurrent audits without inventing transactional write mechanics.
 *
 * Audit-code R1/H3 fix: file initialization uses `flag: 'wx'` open-create-
 * exclusive semantics — no existsSync + writeFileSync race window.
 *
 * @module scripts/lib/audit/orphan-metrics
 */

import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { findingFingerprint } from './findings-pipeline.mjs';

const METRICS_PATH = '.audit/orphan-metrics.jsonl';

/**
 * Ensure the .audit directory + metrics file exist. Idempotent and race-safe
 * (audit-code R1/H3): uses `wx` flag to atomically create-or-skip-if-exists.
 *
 * @param {string} repoPath
 * @param {string} [sinkPath] - repo-relative sink path (event-wiring-symmetry
 *   plan R1/M1 fix — parameterised so a non-orphan caller can point this at
 *   its own log without a second copy of this module).
 * @returns {string} absolute path to the metrics file
 */
function ensureMetricsFile(repoPath, sinkPath = METRICS_PATH) {
  const auditDir = path.dirname(path.join(repoPath, sinkPath));
  if (!fs.existsSync(auditDir)) {
    try { fs.mkdirSync(auditDir, { recursive: true }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  const absPath = path.join(repoPath, sinkPath);
  try {
    // wx = open-create-exclusive: creates empty file iff it doesn't exist.
    // Atomic at the filesystem level on both POSIX and NTFS.
    fs.writeFileSync(absPath, '', { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // File already exists — fine, no-op.
  }
  return absPath;
}

/**
 * Append a single record to the metrics log under a fresh lock acquisition.
 * Use this only for ad-hoc single-record writes; prefer `emitOrphanRunMetrics`
 * for full run batches (which uses one lock per batch).
 *
 * @param {object} record
 * @param {string} [repoPath]
 */
export async function appendOrphanMetric(record, repoPath = process.cwd()) {
  // Gemini-final-gate G1 fix — file-init MUST be inside the try block.
  // ensureMetricsFile can throw on EACCES/EROFS etc.; an uncaught throw in
  // an async function becomes an unhandled promise rejection that crashes
  // the audit process. Telemetry MUST never abort the audit (graceful
  // degradation principle).
  let release;
  try {
    const absPath = ensureMetricsFile(repoPath);
    release = await lockfile.lock(absPath, {
      retries: { retries: 3, factor: 1.2, minTimeout: 25, maxTimeout: 200 },
      stale: 5000,
    });
    fs.appendFileSync(absPath, JSON.stringify(record) + '\n', { flag: 'a' });
  } catch (err) {
    process.stderr.write(`  [orphan-metrics] append failed: ${err.message}\n`);
  } finally {
    if (release) {
      try { await release(); } catch { /* lock auto-stales */ }
    }
  }
}

/**
 * Emit the full set of records for one audit run: one run-summary + one per
 * raw finding (including suppressed). ALL records are written under a single
 * lock acquisition so the run grouping cannot interleave with another run's
 * writes (audit-code R1/M5+M10 compromise — single-lock batch).
 *
 * Audit-code R1/M6+M13 fix: survivor/suppressed reconciliation uses the
 * canonical fingerprint (`findingFingerprint`) — NOT a fragile file+subKind
 * tuple. The pipeline already computed `_fingerprint` on each survivor /
 * suppressed entry; we compute it on raw findings here for one-shot lookup.
 *
 * @param {object} args
 * @param {string} args.runId
 * @param {string} args.passState - 'ANALYZED_CLEAN' | ...
 * @param {Array<object>} args.rawFindings - pre-suppression
 * @param {Array<object>} args.survivors - post-suppression (have `_fingerprint`)
 * @param {Array<object>} args.suppressed - dropped (have `_fingerprint` + `suppressedBy`)
 * @param {object} [args._meta] - detector _meta
 * @param {string} [args.repoPath]
 * @param {string} [args.sinkPath] - repo-relative sink (default: orphan's own log —
 *   event-wiring-symmetry plan R1/M1 fix). A caller passes its own path/kind rather
 *   than this module hardcoding orphan's.
 * @param {string} [args.summaryKind] - run-summary record `kind` (default: `'orphan-run-summary'`).
 *   NOT a "one-line generalisation" — reusing the default here for a different
 *   detector would inject mislabelled records into that detector's own log.
 */
export async function emitOrphanRunMetrics({
  runId, passState, rawFindings = [], survivors = [], suppressed = [], _meta = {}, repoPath = process.cwd(),
  sinkPath = METRICS_PATH, summaryKind = 'orphan-run-summary',
}) {
  // Gemini-final-gate G1 fix — defer ensureMetricsFile until inside the try
  // block so a synchronous throw (EACCES/EROFS) becomes a graceful stderr
  // log instead of an unhandled promise rejection that crashes the audit.
  const ts = new Date().toISOString();

  // Build all lines BEFORE acquiring the lock — keeps the lock window short.
  const lines = [];

  lines.push(JSON.stringify({
    ts,
    runId,
    kind: summaryKind,
    passState,
    rawFindingCount: rawFindings.length,
    surfacedFindingCount: survivors.length,
    // Named fields kept exactly as-is for orphan's existing readers
    // (weekly-review.mjs etc. may key on these specific names).
    suspectsCount: _meta.suspectsCount ?? 0,
    removedEdgeTargetCount: _meta.removedEdgeTargetCount ?? _meta.removedEdgesCount ?? 0,
    totalRemovedEdges: _meta.totalRemovedEdges ?? 0,
    // Generic passthrough (R1/M1 fix) — a non-orphan caller's own `_meta`
    // shape (e.g. event-wiring's skippedFiles/excludedFiles/filesConsidered)
    // survives verbatim instead of being silently dropped by the named
    // fields above, which this module must not hand-pick per detector.
    _meta,
  }));

  // Build a fingerprint → suppressedBy index once.
  const suppressedByFingerprint = new Map();
  for (const s of suppressed) {
    if (s._fingerprint) suppressedByFingerprint.set(s._fingerprint, s.suppressedBy || 'unknown');
  }
  // Survivors always pass through with suppressedBy=null.
  const survivorFingerprints = new Set(survivors.map(s => s._fingerprint).filter(Boolean));

  for (const f of rawFindings) {
    const fp = findingFingerprint(f);
    let suppressedBy = null;
    if (!survivorFingerprints.has(fp) && suppressedByFingerprint.has(fp)) {
      suppressedBy = suppressedByFingerprint.get(fp);
    }
    lines.push(JSON.stringify({
      ts,
      runId,
      kind: f.kind || 'orphan-introduced',
      subKind: f.subKind,
      file: f.file,
      severity: f.severity || 'MEDIUM',
      fingerprint: fp,
      suppressedBy,
      passState,
    }));
  }

  // Single lock acquisition for the entire batch. ensureMetricsFile is
  // inside the try block (Gemini-G1) — its failure is non-fatal.
  let release;
  try {
    // Bug found by direct end-to-end testing: this call omitted `sinkPath`,
    // so every batch write silently fell back to orphan's own file
    // regardless of what the caller specified — the exact parameterisation
    // this function's signature claimed to support was inert.
    const absPath = ensureMetricsFile(repoPath, sinkPath);
    release = await lockfile.lock(absPath, {
      retries: { retries: 3, factor: 1.2, minTimeout: 25, maxTimeout: 200 },
      stale: 5000,
    });
    fs.appendFileSync(absPath, lines.join('\n') + '\n', { flag: 'a' });
  } catch (err) {
    process.stderr.write(`  [orphan-metrics] batch append failed: ${err.message}\n`);
  } finally {
    if (release) {
      try { await release(); } catch { /* lock auto-stales */ }
    }
  }
}
