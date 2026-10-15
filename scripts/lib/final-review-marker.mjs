/**
 * @fileoverview The final-review marker: WHAT the Gemini final review approved, recorded beside the gate-evidence marker.
 *
 * Lives in its own shared-lib module (not in lib/audit/gate-evidence.mjs) because it has two sides in two domains: the writer is
 * called by the audit's final-review CLI, and the reader by `ship-commit.mjs` (domain `ship`, which may not import the audit
 * orchestration; tests/arm-vocabulary-layering.test.mjs). Both sides depend only on this file.
 *
 * @module scripts/lib/final-review-marker
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './file-io.mjs';
import { retrySync } from './retry-transient-fs.mjs';
import { RUN_ID_RE, TREE_ID_RE } from './commit-trailers.mjs';

// ── The final-review marker ─────────────────────────────────────────────────────────────────────────────────────────
//
// `audit_runs.gemini_verdict` is ONE column per run with no target identity: a run can keep an earlier APPROVE while the
// audit evidence moves on to another tree or round. A pre-authorised ship (lib/ship-preauth.mjs) must not rest on that, so
// `gemini-review.mjs` (code mode, after it persists the verdict) records WHAT was approved beside the gate-evidence
// marker: the run, the audited tree and the round it copied from that marker at review time. The ship check requires all
// three to equal the CURRENT gate-evidence marker, so a later audit round (which rewrites that marker) makes an old
// approval stop matching, and the check refuses until the review runs again. Written by the tool, never by hand: the same
// rule as the marker above (AGENTS.md: never hand-write gate evidence).

/** Relative location of the final-review marker — one constant for the writer and every reader. */
export const FINAL_REVIEW_RELPATH = path.join('.audit', 'last-final-review.json');

/**
 * The revocation sidecar. CREATING a new file succeeds in cases where deleting or overwriting an existing one does not (a scanner
 * or another process holds THAT file), so when the marker itself cannot be revoked the writer drops this beside it, and the reader
 * refuses while it exists. A successful write of a new marker removes it again.
 */
export const REVOKED_SIDECAR_RELPATH = path.join('.audit', 'last-final-review.revoked');

const FINAL_REVIEW_VERDICTS = new Set(['APPROVE', 'CONCERNS', 'CONCERNS_REMAINING', 'REJECT']);

/**
 * Build the final-review marker from the gate-evidence marker the review ran against. Pure.
 * Returns null (never a partial marker) when the evidence cannot identify what was reviewed.
 *
 * @param {{evidence: {runId?: unknown, auditedTree?: unknown, round?: unknown}|null, verdict: unknown, nowIso?: string}} input
 * @returns {{runId: string, auditedTree: string, round: number, verdict: string, ts: string}|null}
 */
export function buildFinalReviewMarker({ evidence, verdict, nowIso } = {}) {
  if (!evidence || typeof evidence !== 'object') return null;
  if (typeof verdict !== 'string' || !FINAL_REVIEW_VERDICTS.has(verdict)) return null;
  if (!RUN_ID_RE.test(String(evidence.runId ?? ''))) return null;
  if (!TREE_ID_RE.test(String(evidence.auditedTree ?? ''))) return null;
  if (!Number.isInteger(evidence.round)) return null;   // a marker that cannot name the round binds to nothing
  return { runId: evidence.runId, auditedTree: evidence.auditedTree, round: evidence.round, verdict, ts: nowIso ?? new Date().toISOString() };
}

/** What an in-place revocation writes: valid JSON that `readFinalReviewMarker` classifies `malformed`, so every consumer refuses. */
export const REVOKED_MARKER_TEXT = '{"revoked":true}\n';

/**
 * Make any previous marker unusable: delete it (retrying the transient EPERM/EBUSY a scanner or indexer causes on Windows), and if
 * it cannot be deleted, overwrite it IN PLACE with a tombstone. In-place writes succeed in cases where unlink and rename do not.
 * Only when both fail is the previous marker left standing, and then the caller is told.
 *
 * @returns {{ok: true, how: 'absent'|'removed'|'tombstoned'|'sidecar'} | {ok: false, code: string}}
 */
export function revokePreviousMarker(filePath, { unlink = fs.unlinkSync, overwrite = fs.writeFileSync, sidecarPath = null, create = fs.writeFileSync } = {}) {
  try { retrySync(() => unlink(filePath)); return { ok: true, how: 'removed' }; } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, how: 'absent' };
  }
  let code;
  try { retrySync(() => overwrite(filePath, REVOKED_MARKER_TEXT)); return { ok: true, how: 'tombstoned' }; } catch (e) { code = e?.code || e?.name || 'Error'; }
  // Last resort: a NEW file beside it, which the reader treats as a standing revocation.
  if (sidecarPath) {
    try { retrySync(() => create(sidecarPath, `${JSON.stringify({ revokedAt: new Date().toISOString() })}\n`)); return { ok: true, how: 'sidecar' }; } catch { /* fall through */ }
  }
  return { ok: false, code };
}

/**
 * Write the final-review marker. Best-effort like the gate-evidence writer: a failure degrades to "no marker", which the
 * ship check reads as `final-review` NOT satisfied, the safe direction.
 *
 * @returns {{written: boolean, reason?: string, payload?: object, filePath?: string}}
 */
export function writeFinalReviewMarker({ repoRoot, evidence, verdict, log = (m) => process.stderr.write(m), adapters = {}, nowIso } = {}) {
  const write = adapters.atomicWriteFileSync || atomicWriteFileSync;
  const unlink = adapters.unlinkSync || fs.unlinkSync;
  const filePath = path.join(repoRoot, FINAL_REVIEW_RELPATH);
  // FAIL CLOSED: a review that is about to be recorded (or that cannot be) supersedes whatever was recorded before, so the old
  // marker is revoked FIRST. Otherwise a failed replacement leaves a previous APPROVE readable beside a newer CONCERNS/REJECT that
  // never got written, and a pre-authorised ship would read that stale approval for the same run, tree and round.
  const sidecarPath = path.join(repoRoot, REVOKED_SIDECAR_RELPATH);
  const revoked = revokePreviousMarker(filePath, { unlink, overwrite: adapters.overwriteFileSync || fs.writeFileSync, sidecarPath, create: adapters.createFileSync || fs.writeFileSync });
  if (!revoked.ok) {
    // Neither deleting nor overwriting worked (a lock another process holds). The previous approval may still read as current.
    // The CALLER must treat this as FATAL to the review lifecycle (exit non-zero, tell the user): there is nothing left here to
    // make the ship check refuse, and pretending otherwise would be the fail-open this function exists to prevent.
    log(`  [final-review-marker] FATAL: the previous marker could be removed, overwritten or shadowed by a revocation file by none of the three (${revoked.code}) — an earlier approval may still be readable; do not ship pre-authorised\n`);
    return { written: false, reason: 'stale-marker-not-removable', revoked: false, filePath };
  }
  const payload = buildFinalReviewMarker({ evidence, verdict, nowIso });
  if (!payload) return { written: false, reason: 'evidence-cannot-identify-the-review' };
  try {
    write(filePath, JSON.stringify(payload, null, 2));
    // A standing revocation belongs to the marker it shadowed; the new one supersedes it. If it cannot be removed the reader keeps
    // refusing (fail closed), and the result says so.
    let sidecarStuck = false;
    try { retrySync(() => unlink(sidecarPath)); } catch (e) { if (e && e.code !== 'ENOENT') sidecarStuck = true; }
    if (sidecarStuck) log('  [final-review-marker] the revocation file from an earlier failure could not be removed: the ship check will keep refusing until it is deleted\n');
    return { written: true, payload, filePath, ...(sidecarStuck ? { sidecarStuck: true } : {}) };
  } catch (err) {
    log(`  [final-review-marker] write failed (${err?.code || err?.name || 'Error'}) — a pre-authorised ship will read the review as unrecorded\n`);
    return { written: false, reason: 'write-failed', payload, filePath };
  }
}

/**
 * Read the final-review marker. Absent, unreadable or malformed are three distinct reasons, never an empty success.
 *
 * @returns {{ok: true, marker: {runId: string, auditedTree: string, round: number, verdict: string, ts: string}} | {ok: false, reason: 'absent'|'unreadable'|'malformed'}}
 */
export function readFinalReviewMarker(repoRoot, { fsMod = fs } = {}) {
  // A standing revocation outranks any marker beside it.
  try { fsMod.readFileSync(path.join(repoRoot, REVOKED_SIDECAR_RELPATH), 'utf-8'); return { ok: false, reason: 'revoked' }; } catch (e) {
    if (!(e && e.code === 'ENOENT')) return { ok: false, reason: 'unreadable' };
  }
  let raw;
  try {
    raw = fsMod.readFileSync(path.join(repoRoot, FINAL_REVIEW_RELPATH), 'utf-8');
  } catch (e) {
    return { ok: false, reason: e && e.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  let m;
  try { m = JSON.parse(raw); } catch { return { ok: false, reason: 'malformed' }; }
  const shaped = m && typeof m === 'object'
    && RUN_ID_RE.test(String(m.runId ?? '')) && TREE_ID_RE.test(String(m.auditedTree ?? ''))
    && Number.isInteger(m.round) && typeof m.verdict === 'string' && FINAL_REVIEW_VERDICTS.has(m.verdict)
    && typeof m.ts === 'string' && !Number.isNaN(Date.parse(m.ts));
  return shaped ? { ok: true, marker: m } : { ok: false, reason: 'malformed' };
}
