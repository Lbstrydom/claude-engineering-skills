/**
 * @fileoverview Fleet proposal 0ace: a review that STARTS shadows any earlier approval until it records, so a review that
 * loses the marker lock (or crashes) cannot leave the first review's APPROVE standing beside a verdict never written.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  registerPendingReview, readFinalReviewMarker, recordFinalReviewMarker, readGateEvidenceSnapshot,
  PENDING_REVIEWS_RELPATH, writeFinalReviewMarker,
} from '../scripts/lib/final-review-marker.mjs';
import { GATE_EVIDENCE_RELPATH } from '../scripts/lib/audit/gate-evidence.mjs';

const RUN = '981fc79a-0fbb-447a-a294-b0c0217dab71';
const TREE = 'ca77e929e43535fdee278229eed00a08cde80f59';

const withRepo = (fn) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-pending-'));
  fs.mkdirSync(path.join(d, '.audit'), { recursive: true });
  fs.writeFileSync(path.join(d, GATE_EVIDENCE_RELPATH), JSON.stringify({ runId: RUN, sid: 's', round: 4, auditedSha: 'a'.repeat(40), auditedTree: TREE, auditedBranch: 'claude/x', ts: '2026-10-15T07:00:00.000Z' }));
  try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
};
const quiet = (fn) => { const orig = console.error; console.error = () => {}; try { return fn(); } finally { console.error = orig; } };
const approve = { verdict: 'APPROVE', gateDisposition: 'approve' };
const concerns = { verdict: 'CONCERNS', gateDisposition: 'approve_with_debt' };
const record = (d, result, pending) => quiet(() => recordFinalReviewMarker({ auditMode: 'code', result, repoRoot: d, reviewedEvidence: readGateEvidenceSnapshot(d), pending }));

describe('pending-attempt registry (0ace)', () => {
  it('review A approves; review B starts then LOSES the lock: A\'s APPROVE no longer reads as standing', () => withRepo((d) => {
    const a = registerPendingReview({ repoRoot: d, nowMs: 1000 });
    assert.equal(record(d, approve, a), false);
    assert.equal(readFinalReviewMarker(d).ok, true, 'precondition: A recorded and its pending entry is gone');
    const b = registerPendingReview({ repoRoot: d, nowMs: 2000 });
    assert.equal(readFinalReviewMarker(d).reason, 'pending', 'B started: the earlier approval is shadowed');
    // B cannot take the lock: a held lock file makes withFileLockSync fail every attempt.
    const lock = path.join(d, '.audit', 'last-final-review.lock');
    fs.mkdirSync(lock, { recursive: true });
    const w = quiet(() => writeFinalReviewMarker({ repoRoot: d, evidence: readGateEvidenceSnapshot(d), verdict: 'CONCERNS', disposition: 'approve_with_debt', pendingId: b.id, adapters: { lockAttempts: 1 } }));
    assert.equal(w.reason, 'lock-contention', 'precondition: the held lock must actually make B lose, or the assertions below prove nothing');
    assert.equal(readFinalReviewMarker(d).ok, false, 'B recorded nothing and A\'s APPROVE must not stand');
    assert.equal(readFinalReviewMarker(d).reason, 'pending');
    fs.rmSync(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }));

  it('a crashed review (registered, never recorded) keeps the ship refusing; a later recording review clears it', () => withRepo((d) => {
    assert.equal(registerPendingReview({ repoRoot: d, nowMs: 1000 }).ok, true);
    assert.equal(readFinalReviewMarker(d).reason, 'pending');
    const later = registerPendingReview({ repoRoot: d, nowMs: 5000 });
    assert.equal(record(d, approve, later), false);
    assert.equal(readFinalReviewMarker(d).ok, true, 'the later review governs and clears the older crashed entry');
    assert.equal(fs.readdirSync(path.join(d, PENDING_REVIEWS_RELPATH)).length, 0);
  }));

  it('NEGATIVE CONTROL: an EARLIER review finishing does not clear a LATER review\'s pending entry', () => withRepo((d) => {
    const a = registerPendingReview({ repoRoot: d, nowMs: 1000 });
    registerPendingReview({ repoRoot: d, nowMs: 2000 });
    record(d, approve, a);
    assert.equal(readFinalReviewMarker(d).reason, 'pending', 'B (started later) is still in flight: A\'s APPROVE must not read as current');
    assert.equal(fs.readdirSync(path.join(d, PENDING_REVIEWS_RELPATH)).length, 1);
  }));

  it('NEGATIVE CONTROL: no pending entries means the reader behaves exactly as before (no marker is "absent", not "pending")', () => withRepo((d) => {
    assert.equal(readFinalReviewMarker(d).reason, 'absent');
    const a = registerPendingReview({ repoRoot: d, nowMs: 1000 });
    record(d, concerns, a);
    assert.equal(readFinalReviewMarker(d).marker.verdict, 'CONCERNS');
  }));

  it('registration that cannot write reports ok:false, and the recording call then reports the lifecycle FATAL', () => withRepo((d) => {
    const bad = registerPendingReview({ repoRoot: d, fsMod: { mkdirSync() {}, readdirSync: () => [], writeFileSync() { throw Object.assign(new Error('x'), { code: 'EACCES' }); } } });
    assert.deepEqual(bad, { ok: false, code: 'EACCES' });
    assert.equal(record(d, approve, bad), true);
  }));

  it('a foreign entry in the pending directory blocks the reader and is never deleted by a recording review', () => withRepo((d) => {
    fs.mkdirSync(path.join(d, PENDING_REVIEWS_RELPATH), { recursive: true });
    fs.writeFileSync(path.join(d, PENDING_REVIEWS_RELPATH, 'mystery'), 'x');
    const a = registerPendingReview({ repoRoot: d, nowMs: 1000 });
    record(d, approve, a);
    assert.equal(readFinalReviewMarker(d).reason, 'pending');
  }));

  it('two attempts in the SAME millisecond get distinct, ordered stamps (the order is persisted, never a random suffix)', () => withRepo((d) => {
    const a = registerPendingReview({ repoRoot: d, nowMs: 7000 });
    const b = registerPendingReview({ repoRoot: d, nowMs: 7000 });
    assert.ok(a.id < b.id, 'the second registration sorts after the first');
    const c = registerPendingReview({ repoRoot: d, nowMs: 100 });
    assert.ok(c.id > b.id, 'a clock that stepped back still sorts after every existing entry');
  }));

  it('A starts, B starts, B records REJECT, THEN A finishes: A is superseded and cannot overwrite the later verdict', () => withRepo((d) => {
    const a = registerPendingReview({ repoRoot: d, nowMs: 1000 });
    const b = registerPendingReview({ repoRoot: d, nowMs: 2000 });
    record(d, { verdict: 'REJECT', gateDisposition: 'blocked' }, b);
    const fatal = record(d, approve, a);
    assert.equal(fatal, false, 'superseded is reported, not fatal');
    const m = readFinalReviewMarker(d);
    assert.equal(m.ok, true);
    assert.equal(m.marker.verdict, 'REJECT', 'the later review verdict stands');
  }));

  it('a pending registry that is a regular file (ENOTDIR) is refused, never read as no pending reviews', () => withRepo((d) => {
    fs.writeFileSync(path.join(d, PENDING_REVIEWS_RELPATH), 'not a directory');
    assert.equal(readFinalReviewMarker(d).reason, 'unreadable');
  }));

  it('a stamp reused after cleanup (clock stepped back) is a DIFFERENT attempt: the old owner is superseded by nonce, not by name', () => withRepo((d) => {
    const a = registerPendingReview({ repoRoot: d, nowMs: 1000 });
    const b = registerPendingReview({ repoRoot: d, nowMs: 1001 });
    record(d, { verdict: 'REJECT', gateDisposition: 'blocked' }, b);   // clears both entries
    const c = registerPendingReview({ repoRoot: d, nowMs: 1000 });     // reuses A's stamp
    assert.equal(c.id, a.id, 'precondition: the name was reused');
    assert.notEqual(c.nonce, a.nonce);
    record(d, approve, a);
    assert.equal(readFinalReviewMarker(d).reason, 'pending', 'A must not have written: C is in flight and A is superseded');
    assert.equal(fs.readdirSync(path.join(d, PENDING_REVIEWS_RELPATH)).length, 1, 'A did not delete the later entry');
  }));
});
