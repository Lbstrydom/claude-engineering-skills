/**
 * @fileoverview The producer side of the pre-authorised-ship final-review binding: `gemini-review.mjs` records WHAT it approved
 * beside the gate-evidence marker (docs/plans/fleet-chips-and-merge-friction.md section 2.2b). The consumer is
 * scripts/lib/ship-preauth.mjs; these tests drive PRODUCER -> CONSUMER together so the contract between them is exercised, not
 * each side against its own fixture.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordFinalReviewMarker, readGateEvidenceSnapshot } from '../scripts/lib/final-review-marker.mjs';

/** The producer as the review CLI calls it: the evidence snapshot taken before the review (here: unchanged since) unless given. */
const record = (args) => recordFinalReviewMarker({ reviewedEvidence: readGateEvidenceSnapshot(args.repoRoot), ...args });
import { readFinalReviewMarker, FINAL_REVIEW_RELPATH } from '../scripts/lib/final-review-marker.mjs';
import { GATE_EVIDENCE_RELPATH } from '../scripts/lib/audit/gate-evidence.mjs';
import { evaluatePreauthorisedShip } from '../scripts/lib/ship-preauth.mjs';
import { stampGateDisposition } from '../scripts/lib/final-review/round-gate.mjs';

const RUN = '981fc79a-0fbb-447a-a294-b0c0217dab71';
const TREE = 'ca77e929e43535fdee278229eed00a08cde80f59';
const OTHER_TREE = '4ca9f5a05945f5495eae1f6b4128406a3af46ab9';

const withRepo = (fn) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-marker-'));
  fs.mkdirSync(path.join(d, '.audit'), { recursive: true });
  try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
};
const writeEvidence = (d, extra = {}) => fs.writeFileSync(path.join(d, GATE_EVIDENCE_RELPATH), JSON.stringify({ runId: RUN, sid: 's', round: 4, auditedSha: 'a'.repeat(40), auditedTree: TREE, auditedBranch: 'claude/x', ts: '2026-10-15T07:00:00.000Z', ...extra }));
const quiet = (fn) => { const orig = console.error; console.error = () => {}; try { return fn(); } finally { console.error = orig; } };

/** The facts under which the consumer accepts everything except the final review. */
const consumerFacts = (d, evidence) => ({
  gate: 'converged', convergence: { roundConvergedAfter: 4 }, evidence, currentBranch: 'claude/x',
  finalReview: readFinalReviewMarker(d), changedPaths: ['scripts/a.mjs'],
});

describe('recordFinalReviewMarker (producer) feeding evaluatePreauthorisedShip (consumer)', () => {
  it('a code-mode APPROVE writes a marker bound to the gate-evidence marker\'s run, tree and round, and the consumer accepts it', () => withRepo((d) => {
    writeEvidence(d);
    const fatal = quiet(() => record({ auditMode: 'code', result: { verdict: 'APPROVE', gateDisposition: 'approve' }, repoRoot: d }));
    assert.equal(fatal, false);
    const m = readFinalReviewMarker(d);
    assert.equal(m.ok, true);
    assert.deepEqual({ runId: m.marker.runId, auditedTree: m.marker.auditedTree, round: m.marker.round, verdict: m.marker.verdict }, { runId: RUN, auditedTree: TREE, round: 4, verdict: 'APPROVE' });
    const v = evaluatePreauthorisedShip(consumerFacts(d, { runId: RUN, auditedTree: TREE, round: 4, auditedBranch: 'claude/x' }));
    assert.equal(v.conditions.find((c) => c.id === 'final-review').ok, true);
  }));

  it('a non-approving verdict is recorded as such and the consumer refuses it', () => withRepo((d) => {
    writeEvidence(d);
    for (const verdict of ['CONCERNS', 'CONCERNS_REMAINING', 'REJECT']) {
      quiet(() => record({ auditMode: 'code', result: { verdict, gateDisposition: verdict === 'REJECT' ? 'blocked' : 'approve_with_debt' }, repoRoot: d }));
      const v = evaluatePreauthorisedShip(consumerFacts(d, { runId: RUN, auditedTree: TREE, round: 4, auditedBranch: 'claude/x' }));
      assert.match(v.conditions.find((c) => c.id === 'final-review').reason, new RegExp(`${verdict}, not APPROVE`));
    }
  }));

  it('an APPROVE then a LATER audit round (the evidence marker moves on): the old approval no longer matches', () => withRepo((d) => {
    writeEvidence(d);
    quiet(() => record({ auditMode: 'code', result: { verdict: 'APPROVE', gateDisposition: 'approve' }, repoRoot: d }));
    writeEvidence(d, { round: 5, auditedTree: OTHER_TREE });
    const v = evaluatePreauthorisedShip(consumerFacts(d, { runId: RUN, auditedTree: OTHER_TREE, round: 5, auditedBranch: 'claude/x' }));
    const row = v.conditions.find((c) => c.id === 'final-review');
    assert.equal(row.ok, false);
    assert.match(row.reason, /different audited tree/);
  }));

  // Each identity field binds on its own: a consumer that ignored one of them would still pass a test that moved two at once.
  for (const [what, moved, why] of [
    ['round only', { round: 5 }, /round 4, the audit evidence is round 5/],
    ['audited tree only', { auditedTree: OTHER_TREE }, /different audited tree/],
    ['run only', { runId: '11111111-2222-4333-8444-555555555555' }, /approval is for run 981fc79a/],
  ]) {
    it(`a later audit that moves the ${what}: the old approval no longer matches`, () => withRepo((d) => {
      writeEvidence(d);
      quiet(() => record({ auditMode: 'code', result: { verdict: 'APPROVE', gateDisposition: 'approve' }, repoRoot: d }));
      const now = { runId: RUN, auditedTree: TREE, round: 4, auditedBranch: 'claude/x', ...moved };
      writeEvidence(d, moved);
      const row = evaluatePreauthorisedShip(consumerFacts(d, now)).conditions.find((c) => c.id === 'final-review');
      assert.equal(row.ok, false);
      assert.match(row.reason, why);
    }));
  }

  it('the evidence MOVES WHILE the review runs: the result is not bound to the new identity, and the old approval is revoked', () => withRepo((d) => {
    writeEvidence(d);
    quiet(() => record({ auditMode: 'code', result: { verdict: 'APPROVE', gateDisposition: 'approve' }, repoRoot: d }));
    const reviewedEvidence = readGateEvidenceSnapshot(d);   // taken when the review started
    writeEvidence(d, { round: 5 });                          // an audit round lands mid-review
    const logs = [];
    const orig = console.error; console.error = (m) => logs.push(m);
    let fatal;
    try { fatal = recordFinalReviewMarker({ auditMode: 'code', result: { verdict: 'APPROVE', gateDisposition: 'approve' }, repoRoot: d, reviewedEvidence }); } finally { console.error = orig; }
    assert.equal(fatal, false, 'safe state, only reported');
    assert.deepEqual(readFinalReviewMarker(d), { ok: false, reason: 'absent' }, 'neither the new identity nor the old approval stands');
    assert.match(logs.join(''), /changed while the review ran.*round 4; now run .* round 5/);
  }));

  it('no snapshot of what was reviewed: nothing is recorded (an unknown is never bound to the current evidence)', () => withRepo((d) => {
    writeEvidence(d);
    quiet(() => recordFinalReviewMarker({ auditMode: 'code', result: { verdict: 'APPROVE', gateDisposition: 'approve' }, repoRoot: d }));
    assert.equal(readFinalReviewMarker(d).reason, 'absent');
  }));

  it('plan mode touches NOTHING: it does not write, and it does not revoke an existing code approval', () => withRepo((d) => {
    writeEvidence(d);
    quiet(() => record({ auditMode: 'code', result: { verdict: 'APPROVE', gateDisposition: 'approve' }, repoRoot: d }));
    const before = fs.readFileSync(path.join(d, FINAL_REVIEW_RELPATH), 'utf8');
    const fatal = quiet(() => record({ auditMode: 'plan', result: { verdict: 'REJECT', gateDisposition: 'blocked' }, repoRoot: d }));
    assert.equal(fatal, false);
    assert.equal(fs.readFileSync(path.join(d, FINAL_REVIEW_RELPATH), 'utf8'), before);
  }));

  it('no gate-evidence marker: nothing is recorded AND an earlier approval is revoked (absence is never an approval)', () => withRepo((d) => {
    writeEvidence(d);
    quiet(() => record({ auditMode: 'code', result: { verdict: 'APPROVE', gateDisposition: 'approve' }, repoRoot: d }));
    fs.rmSync(path.join(d, GATE_EVIDENCE_RELPATH), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const fatal = quiet(() => record({ auditMode: 'code', result: { verdict: 'APPROVE', gateDisposition: 'approve' }, repoRoot: d }));
    assert.equal(fatal, false, 'safe state, only reported');
    assert.equal(readFinalReviewMarker(d).reason, 'absent');
  }));

  it('the fatal cases propagate: a writer that could not revoke, or lost the lock, makes the review exit non-zero', () => withRepo((d) => {
    writeEvidence(d);
    for (const w of [{ written: false, reason: 'stale-marker-not-removable', revoked: false }, { written: false, reason: 'lock-contention', revoked: false }, { written: true, sidecarStuck: true, payload: {} }]) {
      const fatal = quiet(() => record({ auditMode: 'code', result: { verdict: 'APPROVE', gateDisposition: 'approve' }, repoRoot: d, write: () => w }));
      assert.equal(fatal, true, JSON.stringify(w));
    }
    for (const w of [{ written: false, reason: 'write-failed' }, { written: false, reason: 'evidence-cannot-identify-the-review' }]) {
      assert.equal(quiet(() => record({ auditMode: 'code', result: { verdict: 'APPROVE', gateDisposition: 'approve' }, repoRoot: d, write: () => w })), false, JSON.stringify(w));
    }
  }));
});

describe('B2b end to end: an APPROVE verdict whose RESULT is blocked never pre-authorises (docs/plans/copilot-feedback-item4.md P-B4b)', () => {
  const ev = { runId: RUN, auditedTree: TREE, round: 4, auditedBranch: 'claude/x' };
  const reviewed = (extra) => ({ verdict: 'APPROVE', new_findings: [], wrongly_dismissed: [], ...extra });

  it('a required subject not received in full: the round gate says blocked, the marker records it, the ship check refuses naming it', () => withRepo((d) => {
    writeEvidence(d);
    const result = reviewed({ _requiredSubjectsGate: { notReceived: [{ path: 'package-lock.json', state: 'partial', reason: 'head-cut' }] } });
    stampGateDisposition(result, 1);
    assert.equal(result.gateDisposition, 'blocked', 'precondition: the round gate blocks it');
    assert.equal(quiet(() => record({ auditMode: 'code', result, repoRoot: d })), false);
    assert.equal(readFinalReviewMarker(d).marker.disposition, 'blocked');
    const row = evaluatePreauthorisedShip(consumerFacts(d, ev)).conditions.find((c) => c.id === 'final-review');
    assert.equal(row.ok, false);
    assert.match(row.reason, /result is blocked, not approve/);
  }));

  it('the same result with every required subject received is approve, and the ship check accepts it (negative control)', () => withRepo((d) => {
    writeEvidence(d);
    const result = reviewed();
    stampGateDisposition(result, 1);
    assert.equal(result.gateDisposition, 'approve');
    quiet(() => record({ auditMode: 'code', result, repoRoot: d }));
    assert.equal(evaluatePreauthorisedShip(consumerFacts(d, ev)).conditions.find((c) => c.id === 'final-review').ok, true);
  }));

  it('a result with no disposition stamped records NOTHING and revokes the earlier approval (no marker without a result)', () => withRepo((d) => {
    writeEvidence(d);
    quiet(() => record({ auditMode: 'code', result: { verdict: 'APPROVE', gateDisposition: 'approve' }, repoRoot: d }));
    assert.equal(quiet(() => record({ auditMode: 'code', result: { verdict: 'APPROVE' }, repoRoot: d })), false);
    assert.equal(readFinalReviewMarker(d).reason, 'absent');
  }));
});

describe('the producer is actually wired (a marker with no caller is the failure this whole class is about)', () => {
  it('gemini-review.mjs imports recordFinalReviewMarker and its exit status depends on the result', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../scripts/gemini-review.mjs'), 'utf8');
    assert.match(src, /import \{ recordFinalReviewMarker, readGateEvidenceSnapshot, registerPendingReview \} from '\.\/lib\/final-review-marker\.mjs'/);
    // The snapshot is taken BEFORE the provider call, so it names what was reviewed, not what the evidence says afterwards.
    const snap = src.indexOf('const reviewedEvidence = readGateEvidenceSnapshot(process.cwd());');
    const review = src.indexOf(': await runReviewWithRetry(provider, client, planContent, transcriptContent, projectContext, auditMode, null, roundOpts)');
    assert.ok(review > 0, 'the instrument must find the main-path review call, or the ordering check below proves nothing');
    assert.ok(snap > 0 && snap < review, 'the evidence snapshot precedes the review');
    // The pending registration (fleet proposal 0ace) must also precede it, or a review that never records leaves the earlier approval standing.
    const reg = src.indexOf('registerPendingReview({ repoRoot: process.cwd() })');
    assert.ok(reg > 0 && reg < review, 'the review registers itself as pending before it runs');
    // `await` is part of the pattern: a `void finishAndExit(...)` would return before the exit code is applied.
    assert.match(src, /await finishAndExit\(recordFinalReviewMarker\(\{ auditMode, result, repoRoot: process\.cwd\(\), reviewedEvidence, pending: pendingReview \}\) \? 1 : 0\)/,
      'the review must call the recorder after emitting its verdict and exit non-zero when the recorder says fatal');
  });
});
