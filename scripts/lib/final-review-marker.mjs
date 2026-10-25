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
import { withFileLockSync } from './file-lock.mjs';
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

/**
 * Pending-attempt registry (fleet proposal 0ace). A review registers ONE new file here when it STARTS, and the marker reader
 * refuses while any entry exists. Without it, a review that finishes but loses the marker lock recorded nothing, so an EARLIER
 * review's APPROVE kept standing beside a newer verdict that never got written. Creating a uniquely-named file needs no lock and
 * no read-modify-write, so registering cannot lose a race the way a late revocation can. A review that records its marker removes
 * its OWN entry and every entry that STARTED before it (a crashed or superseded attempt); an entry from a review that started
 * LATER stays, because that review governs. A crashed review therefore leaves the ship refusing until a review records again,
 * the fail-closed direction.
 */
export const PENDING_REVIEWS_RELPATH = path.join('.audit', 'last-final-review.pending');

const PENDING_NAME_RE = /^(\d{15})-[0-9a-f]{12}$/;

/** Register a review that is about to run. @returns {{ok: true, id: string}|{ok: false, code: string}} */
export function registerPendingReview({ repoRoot, nowMs = Date.now(), fsMod = fs, randomHex = () => Math.random().toString(16).slice(2, 14).padEnd(12, '0') } = {}) {
  const id = `${String(nowMs).padStart(15, '0')}-${randomHex()}`;
  try {
    const dir = path.join(repoRoot, PENDING_REVIEWS_RELPATH);
    fsMod.mkdirSync(dir, { recursive: true });
    fsMod.writeFileSync(path.join(dir, id), `${JSON.stringify({ startedAt: new Date(nowMs).toISOString(), pid: process.pid })}\n`, { flag: 'wx' });
    return { ok: true, id };
  } catch (e) { return { ok: false, code: e?.code || e?.name || 'Error' }; }
}

/**
 * Names under the pending directory: `{present: false}` when the directory is absent, `{unreadable: true}` when it cannot be
 * listed (cannot tell, so the reader refuses), else the entry names. Any entry not shaped like ours is kept as a blocker too.
 */
function listPending(repoRoot, fsMod) {
  try { return { names: fsMod.readdirSync(path.join(repoRoot, PENDING_REVIEWS_RELPATH)) }; } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { names: [] };
    return { unreadable: true, names: [] };
  }
}

/** Remove this attempt's entry and every entry that started no later than it. @returns {{stuck: boolean}} */
function clearPendingUpTo(repoRoot, id, fsMod) {
  const { names, unreadable } = listPending(repoRoot, fsMod);
  if (unreadable) return { stuck: true };
  let stuck = false;
  for (const name of names) {
    const m = PENDING_NAME_RE.exec(name);
    if (!m || name > id) continue;   // a foreign name is a blocker we do not own; a later start governs
    try { retrySync(() => fsMod.unlinkSync(path.join(repoRoot, PENDING_REVIEWS_RELPATH, name))); } catch (e) { if (!(e && e.code === 'ENOENT')) stuck = true; }
  }
  return { stuck };
}

const FINAL_REVIEW_VERDICTS = new Set(['APPROVE', 'CONCERNS', 'CONCERNS_REMAINING', 'REJECT']);

/**
 * The final review's RESULT, as `computeGateDisposition` (lib/final-review/round-gate.mjs) computes it from the verdict and the
 * findings. Recorded beside the verdict because the two can differ: an APPROVE verdict is `blocked` when a release-blocking
 * finding, a coverage downgrade or a required subject not received in full stands (docs/plans/copilot-feedback-item4.md B1).
 */
export const FINAL_REVIEW_DISPOSITIONS = Object.freeze(['approve', 'approve_with_debt', 'blocked']);

/**
 * The legal verdict/disposition pairs: exactly what the round gate can produce. `approve` needs APPROVE, `approve_with_debt` needs
 * CONCERNS or CONCERNS_REMAINING, and `blocked` follows any verdict. Any other pair is two fields that contradict each other, and a
 * contradiction is refused rather than resolved in either direction.
 */
function isLegalPair(verdict, disposition) {
  if (disposition === 'approve') return verdict === 'APPROVE';
  if (disposition === 'approve_with_debt') return verdict === 'CONCERNS' || verdict === 'CONCERNS_REMAINING';
  return disposition === 'blocked' && FINAL_REVIEW_VERDICTS.has(verdict);
}

/**
 * Build the final-review marker from the gate-evidence marker the review ran against. Pure.
 * Returns null (never a partial marker) when the evidence cannot identify what was reviewed, or when the review has no legal
 * result to record: a marker without its disposition is the legacy shape every consumer now refuses, so none is written.
 *
 * @param {{evidence: {runId?: unknown, auditedTree?: unknown, round?: unknown}|null, verdict: unknown, disposition: unknown, nowIso?: string}} input
 * @returns {{runId: string, auditedTree: string, round: number, verdict: string, disposition: string, ts: string}|null}
 */
export function buildFinalReviewMarker({ evidence, verdict, disposition, nowIso } = {}) {
  if (!evidence || typeof evidence !== 'object') return null;
  if (typeof verdict !== 'string' || !FINAL_REVIEW_VERDICTS.has(verdict)) return null;
  if (!isLegalPair(verdict, disposition)) return null;
  if (!RUN_ID_RE.test(String(evidence.runId ?? ''))) return null;
  if (!TREE_ID_RE.test(String(evidence.auditedTree ?? ''))) return null;
  if (!Number.isInteger(evidence.round)) return null;   // a marker that cannot name the round binds to nothing
  return { runId: evidence.runId, auditedTree: evidence.auditedTree, round: evidence.round, verdict, disposition, ts: nowIso ?? new Date().toISOString() };
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
export function writeFinalReviewMarker(args = {}) {
  const { repoRoot, log = (m) => process.stderr.write(m), adapters = {} } = args;
  // The whole revoke / build / write / cleanup lifecycle is ONE critical section, shared by every writer in this repo: without it an
  // older writer's cleanup can delete a revocation a newer writer created, resurrecting the approval the newer one revoked.
  // Contention FAILS CLOSED: this writer does not touch the marker at all and says so, and its caller must treat that as fatal.
  const lockPath = path.join(repoRoot, '.audit', 'last-final-review.lock');
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* the lock attempt below reports it */ }
  const lock = withFileLockSync(lockPath, { attempts: adapters.lockAttempts ?? 25 }, () => writeFinalReviewMarkerLocked(args));
  if (lock.ok) return lock.value;
  log('  [final-review-marker] FATAL: another review is writing the marker (lock contention) — this one recorded nothing; do not ship pre-authorised until it is re-run\n');
  return { written: false, reason: 'lock-contention', revoked: false, filePath: path.join(repoRoot, FINAL_REVIEW_RELPATH) };
}

function writeFinalReviewMarkerLocked({ repoRoot, evidence, verdict, disposition, pendingId, log = (m) => process.stderr.write(m), adapters = {}, nowIso } = {}) {
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
  const payload = buildFinalReviewMarker({ evidence, verdict, disposition, nowIso });
  if (!payload) return { written: false, reason: 'evidence-cannot-identify-the-review' };
  try {
    write(filePath, JSON.stringify(payload, null, 2));
    if (adapters.afterWrite) adapters.afterWrite();   // test seam: a deterministic point inside the critical section
    // A standing revocation belongs to the marker it shadowed; the new one supersedes it. If it cannot be removed the reader keeps
    // refusing (fail closed), and the result says so.
    let sidecarStuck = false;
    try { retrySync(() => unlink(sidecarPath)); } catch (e) { if (e && e.code !== 'ENOENT') sidecarStuck = true; }
    if (sidecarStuck) log('  [final-review-marker] the revocation file from an earlier failure could not be removed: the ship check will keep refusing until it is deleted\n');
    // This review has concluded and recorded: its own pending entry, and any from attempts that started before it, are done.
    // One it cannot remove keeps the reader refusing (fail closed), and the result says so.
    const pendingStuck = pendingId ? clearPendingUpTo(repoRoot, pendingId, adapters.fsMod || fs).stuck : false;
    if (pendingStuck) log('  [final-review-marker] a pending-review entry could not be removed: the ship check will keep refusing until .audit/last-final-review.pending is cleared\n');
    return { written: true, payload, filePath, ...(sidecarStuck || pendingStuck ? { sidecarStuck: true } : {}) };
  } catch (err) {
    log(`  [final-review-marker] write failed (${err?.code || err?.name || 'Error'}) — a pre-authorised ship will read the review as unrecorded\n`);
    return { written: false, reason: 'write-failed', payload, filePath };
  }
}

/**
 * Read the final-review marker. Absent, unreadable or malformed are three distinct reasons, never an empty success.
 *
 * A marker WITHOUT a `disposition` key (written before dispositions were recorded) is well-formed and reads as `disposition: null`,
 * so each consumer decides for itself: the trailer is then absent, and the pre-authorised check refuses with its own reason. A
 * `disposition` that is present but is not one of the three, or that contradicts the verdict, is `malformed`.
 *
 * @returns {{ok: true, marker: {runId: string, auditedTree: string, round: number, verdict: string, disposition: string|null, ts: string}} | {ok: false, reason: 'absent'|'unreadable'|'malformed'|'revoked'|'pending'}}
 */
export function readFinalReviewMarker(repoRoot, { fsMod = fs } = {}) {
  // A review that started and has not recorded (running, crashed, or refused the lock) outranks any marker beside it.
  const pending = listPending(repoRoot, fsMod);
  if (pending.unreadable) return { ok: false, reason: 'unreadable' };
  if (pending.names.length > 0) return { ok: false, reason: 'pending' };
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
    && typeof m.ts === 'string' && !Number.isNaN(Date.parse(m.ts))
    && (!Object.hasOwn(m, 'disposition') || isLegalPair(m.verdict, m.disposition));
  return shaped ? { ok: true, marker: { ...m, disposition: m.disposition ?? null } } : { ok: false, reason: 'malformed' };
}

/**
 * THE binding predicate: is this final-review marker about THIS gate evidence? Run, audited tree and round must all equal it
 * (`audit_runs.gemini_verdict` is one column per run with no target, so the run alone binds nothing). It is the binding only: what
 * a bound review must SAY is each caller's policy (the pre-authorised check requires `approve`; the trailer reports any of the
 * three). One definition for both callers (lib/ship-preauth.mjs and ship-commit's AI-Final-Review), so they cannot disagree.
 *
 * @param {{runId: string, auditedTree?: string|null, round?: number|null}|null} evidence the CURRENT gate-evidence marker
 * @param {ReturnType<typeof readFinalReviewMarker>|null} finalReview
 * @returns {{ok: true, reason: null} | {ok: false, reason: string}}
 */
export function matchFinalReviewMarker(evidence, finalReview) {
  const no = (reason) => ({ ok: false, reason });
  if (!evidence) return no('there is no gate-evidence marker to bind the final review to');
  if (!finalReview || !finalReview.ok) return no(`no final-review marker (${finalReview?.reason ?? 'not read'}): gemini-review has not recorded what it approved`);
  const m = finalReview.marker;
  if (!Number.isInteger(evidence.round)) return no('the gate-evidence marker carries no round, so the approval cannot be bound to one');
  if (m.runId !== evidence.runId) return no(`the approval is for run ${m.runId.slice(0, 8)}, the audit evidence is run ${String(evidence.runId).slice(0, 8)}`);
  if (m.auditedTree !== evidence.auditedTree) return no('the approval is for a different audited tree than the audit evidence names');
  if (m.round !== evidence.round) return no(`the approval is for round ${m.round}, the audit evidence is round ${evidence.round}`);
  return { ok: true, reason: null };
}

/**
 * The disposition of a marker BOUND to this evidence, else null: the one input of the AI-Final-Review trailer. Null for an
 * unbound, absent, revoked or legacy marker, so the trailer is then absent, never a value taken from a review of something else.
 *
 * @returns {'approve'|'approve_with_debt'|'blocked'|null}
 */
export function boundFinalReviewDisposition(evidence, finalReview) {
  return matchFinalReviewMarker(evidence, finalReview).ok ? (finalReview.marker.disposition ?? null) : null;
}

/**
 * The gate-evidence marker as JSON, or null when absent or unreadable (the writer then revokes and records nothing). The review CLI
 * reads it once BEFORE it reviews, and passes that snapshot to `recordFinalReviewMarker` as what it reviewed.
 */
export function readGateEvidenceSnapshot(repoRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, '.audit', 'last-audit-run.json'), 'utf-8')); } catch { return null; }
}

/** Do two gate-evidence snapshots name the same audit target (run, audited tree, round)? Two unknowns are not equal. */
function sameEvidenceIdentity(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return typeof a.runId === 'string' && a.runId === b.runId
    && typeof a.auditedTree === 'string' && a.auditedTree === b.auditedTree
    && Number.isInteger(a.round) && a.round === b.round;
}

/**
 * Record WHAT this final review approved (called by gemini-review.mjs after each review), beside the gate-evidence marker, so a pre-authorised ship can tell tree A's approval from
 * tree B's (`audit_runs.gemini_verdict` is one column per run with no target). Code mode only: a plan review is not a verdict on a
 * commit and must not touch the code marker. The evidence (run, audited tree, audit round) is the snapshot the review CLI took BEFORE
 * it reviewed (`reviewedEvidence`), and it must still equal `.audit/last-audit-run.json` as it stands now: an audit round that lands
 * while the review runs rewrites that file, and binding this result to the NEW identity would credit a review of round N to round
 * N+1 (and to its AI-Final-Review trailer). Then nothing is recorded and the previous marker is revoked, the same safe state as
 * evidence that cannot identify the review. A missing snapshot is treated the same way. Plan:
 * docs/plans/fleet-chips-and-merge-friction.md section 2.2b; docs/plans/copilot-feedback-item4.md B1. The writer is fail-closed.
 *
 * @returns {boolean} true when the review lifecycle must be treated as FATAL (exit non-zero): the writer could not make an earlier
 *   approval unusable, or another review held the marker lock. Everything else (a write that failed after revoking, evidence that
 *   cannot identify the review or moved during it) leaves NO approval standing, which is the safe state, and is only reported.
 */
export function recordFinalReviewMarker({ auditMode, result, repoRoot, reviewedEvidence, pending, write = writeFinalReviewMarker, readEvidence = readGateEvidenceSnapshot } = {}) {
  if (auditMode !== 'code') return false;
  const current = readEvidence(repoRoot);
  const moved = !sameEvidenceIdentity(reviewedEvidence, current);
  // Unchanged evidence is recorded; moved or unknown evidence goes to the writer as null, which revokes the old marker and writes none.
  const evidence = moved ? null : current;
  const w = write({ repoRoot, evidence, verdict: result?.verdict, disposition: result?.gateDisposition, pendingId: pending?.ok ? pending.id : undefined });
  if (moved && current && reviewedEvidence) {
    console.error(`  [final-review-marker] the audit evidence changed while the review ran (reviewed run ${String(reviewedEvidence.runId).slice(0, 8)} round ${reviewedEvidence.round}; now run ${String(current.runId).slice(0, 8)} round ${current.round}): nothing bound to it — re-run the final review\n`);
  }
  if (w.written) {
    console.error(`  [final-review-marker] recorded ${result.verdict} (result ${result.gateDisposition}) for run ${String(evidence.runId).slice(0, 8)}, audit round ${evidence.round}, tree ${String(evidence.auditedTree).slice(0, 12)}\n`);
    // Registering the attempt failed at the start: the earlier approval was never shadowed while this review ran. It is recorded
    // now, but the lifecycle is fatal so the caller does not read the run as clean.
    return Boolean(w.sidecarStuck) || pending?.ok === false;
  }
  console.error(`  [final-review-marker] not recorded (${w.reason}): a pre-authorised ship will read this review as unrecorded\n`);
  return w.revoked === false || pending?.ok === false;
}
