#!/usr/bin/env node
/**
 * @fileoverview Out-of-band reconciler for adaptive-learning telemetry.
 * Two responsibilities:
 *
 * 1. **Drain** new entries from `.audit/quickfix-hits.jsonl` into the
 *    `learning_decisions` cloud table (one INSERT per `hit_id` with
 *    outcome=null).  Idempotent via `decision_key UNIQUE`.
 *
 * 2. **Resolve outcomes** for unresolved quickfix_hit decisions older
 *    than 30 minutes, by examining the file state NOW vs. at hit time:
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

// ── Constants ──────────────────────────────────────────────────────────────

const HITS_JSONL_PATH    = '.audit/quickfix-hits.jsonl';
const DRAIN_MARKER_PATH  = '.audit/quickfix-hits.drained-offset';
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
  const cloudEnabled = typeof learningStore.isCloudEnabled === 'function' && learningStore.isCloudEnabled();
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

  if (rebuildStats && !dryRun) {
    try {
      const { rebuildFromCloud } = await import('../lib/learning/quickfix-stats.mjs');
      const r = await rebuildFromCloud({ repoId });
      summary.rebuild = { ran: true, ok: r.ok, totalDecisions: r.totalDecisions };
    } catch (err) {
      summary.rebuild = { ran: true, ok: false, error: err.message };
    }
  }

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
  // hook.  Retain it (do NOT advance the cursor past it) so the next
  // drain reads it whole.
  const endsWithNewline = text.endsWith('\n') || text.endsWith('\r\n');
  const rawLines = text.split(/\r?\n/);
  // .filter(Boolean) drops empty strings (incl. the trailing empty caused
  // by a closing newline) but preserves whitespace-only lines, which we
  // skip in the parse loop below.
  const lines = endsWithNewline
    ? rawLines.filter(Boolean)
    : rawLines.slice(0, -1).filter(Boolean); // drop the partial tail
  const partialBytes = endsWithNewline
    ? 0
    : Buffer.byteLength(rawLines[rawLines.length - 1] || '', 'utf-8');

  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { out.errors += 1; continue; }
    if (!record || !Array.isArray(record.matches)) continue;

    for (const m of record.matches) {
      out.processed += 1;
      if (!m.hit_id) {
        // Older JSONL records (pre-Phase 2) have no hit_id — skip gracefully.
        // The bootstrap path handles them separately.
        continue;
      }
      const entry = {
        decisionKey: `quickfix_hit:${m.hit_id}`,
        decisionType: 'quickfix_hit',
        externalId: m.hit_id,
        repoId: repoId || null,
        context: {
          pattern: m.name,
          file: record.file,
          severity: m.severity,
          snippet: m.snippet,
          ts: record.ts,
        },
        contextHash: '', // not used for quickfix_hit (decision_key is the dedup key)
        choice: { action: 'flagged' },
        outcome: null,
      };
      // Compute context_hash to satisfy the table NOT NULL contract.
      const canonical = JSON.stringify(entry.context, Object.keys(entry.context).sort());
      entry.contextHash = crypto.createHash('sha256').update(canonical).digest('hex');

      if (dryRun) { out.inserted += 1; continue; }

      const r = await learningStore.insertLearningDecision(entry);
      if (r.ok) {
        out.inserted += 1;
      } else {
        out.errors += 1;
        process.stderr.write(`[backfill] insert failed for ${entry.decisionKey}: ${r.error || ''}\n`);
      }
    }
  }

  // Persist the new offset + fingerprint so we don't reprocess.
  // Audit-fix R2 H4: leave the trailing partial-record bytes UNREAD so
  // the next drain picks them up whole.  newOffset = stat.size minus the
  // size of the partial tail we deliberately skipped.
  const newOffset = stat.size - partialBytes;
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
  return out;
}

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
  const out = { examined: 0, resolved: 0, stillPending: 0, errors: 0 };
  let getClient;
  try {
    ({ getWriteClient: getClient } = await import('../lib/stores/supabase-store.mjs'));
  } catch (err) {
    out.errors += 1;
    return out;
  }
  const client = await getClient();
  if (!client) return out;

  const cutoff = new Date(Date.now() - STALENESS_MS).toISOString();
  let q = client.from('learning_decisions')
    .select('decision_key, context, created_at')
    .eq('decision_type', 'quickfix_hit')
    .is('outcome', null)
    .lt('created_at', cutoff)
    .limit(500);
  if (repoId) q = q.eq('repo_id', repoId);

  let rows = [];
  try {
    const { data, error } = await q;
    if (error) {
      process.stderr.write(`[backfill] resolve read error: ${error.message}\n`);
      out.errors += 1;
      return out;
    }
    rows = data || [];
  } catch (err) {
    out.errors += 1;
    return out;
  }

  for (const row of rows) {
    out.examined += 1;
    const outcome = computeOutcomeFromFileState(row);
    if (!outcome) { out.stillPending += 1; continue; }
    if (dryRun) { out.resolved += 1; continue; }
    const r = await learningStore.backfillLearningOutcome({
      decisionKey: row.decision_key,
      outcome,
    });
    if (r.ok) out.resolved += 1; else out.errors += 1;
  }
  return out;
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
