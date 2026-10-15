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
import { recordFinalReviewMarker } from '../scripts/lib/final-review-marker.mjs';
import { readFinalReviewMarker, FINAL_REVIEW_RELPATH } from '../scripts/lib/final-review-marker.mjs';
import { GATE_EVIDENCE_RELPATH } from '../scripts/lib/audit/gate-evidence.mjs';
import { evaluatePreauthorisedShip } from '../scripts/lib/ship-preauth.mjs';

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
    const fatal = quiet(() => recordFinalReviewMarker({ auditMode: 'code', result: { verdict: 'APPROVE' }, repoRoot: d }));
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
      quiet(() => recordFinalReviewMarker({ auditMode: 'code', result: { verdict }, repoRoot: d }));
      const v = evaluatePreauthorisedShip(consumerFacts(d, { runId: RUN, auditedTree: TREE, round: 4, auditedBranch: 'claude/x' }));
      assert.match(v.conditions.find((c) => c.id === 'final-review').reason, new RegExp(`${verdict}, not APPROVE`));
    }
  }));

  it('an APPROVE then a LATER audit round (the evidence marker moves on): the old approval no longer matches', () => withRepo((d) => {
    writeEvidence(d);
    quiet(() => recordFinalReviewMarker({ auditMode: 'code', result: { verdict: 'APPROVE' }, repoRoot: d }));
    writeEvidence(d, { round: 5, auditedTree: OTHER_TREE });
    const v = evaluatePreauthorisedShip(consumerFacts(d, { runId: RUN, auditedTree: OTHER_TREE, round: 5, auditedBranch: 'claude/x' }));
    const row = v.conditions.find((c) => c.id === 'final-review');
    assert.equal(row.ok, false);
    assert.match(row.reason, /different audited tree/);
  }));

  it('plan mode touches NOTHING: it does not write, and it does not revoke an existing code approval', () => withRepo((d) => {
    writeEvidence(d);
    quiet(() => recordFinalReviewMarker({ auditMode: 'code', result: { verdict: 'APPROVE' }, repoRoot: d }));
    const before = fs.readFileSync(path.join(d, FINAL_REVIEW_RELPATH), 'utf8');
    const fatal = quiet(() => recordFinalReviewMarker({ auditMode: 'plan', result: { verdict: 'REJECT' }, repoRoot: d }));
    assert.equal(fatal, false);
    assert.equal(fs.readFileSync(path.join(d, FINAL_REVIEW_RELPATH), 'utf8'), before);
  }));

  it('no gate-evidence marker: nothing is recorded AND an earlier approval is revoked (absence is never an approval)', () => withRepo((d) => {
    writeEvidence(d);
    quiet(() => recordFinalReviewMarker({ auditMode: 'code', result: { verdict: 'APPROVE' }, repoRoot: d }));
    fs.rmSync(path.join(d, GATE_EVIDENCE_RELPATH), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const fatal = quiet(() => recordFinalReviewMarker({ auditMode: 'code', result: { verdict: 'APPROVE' }, repoRoot: d }));
    assert.equal(fatal, false, 'safe state, only reported');
    assert.equal(readFinalReviewMarker(d).reason, 'absent');
  }));

  it('the fatal cases propagate: a writer that could not revoke, or lost the lock, makes the review exit non-zero', () => withRepo((d) => {
    writeEvidence(d);
    for (const w of [{ written: false, reason: 'stale-marker-not-removable', revoked: false }, { written: false, reason: 'lock-contention', revoked: false }, { written: true, sidecarStuck: true, payload: {} }]) {
      const fatal = quiet(() => recordFinalReviewMarker({ auditMode: 'code', result: { verdict: 'APPROVE' }, repoRoot: d, write: () => w }));
      assert.equal(fatal, true, JSON.stringify(w));
    }
    for (const w of [{ written: false, reason: 'write-failed' }, { written: false, reason: 'evidence-cannot-identify-the-review' }]) {
      assert.equal(quiet(() => recordFinalReviewMarker({ auditMode: 'code', result: { verdict: 'APPROVE' }, repoRoot: d, write: () => w })), false, JSON.stringify(w));
    }
  }));
});

describe('the producer is actually wired (a marker with no caller is the failure this whole class is about)', () => {
  it('gemini-review.mjs imports recordFinalReviewMarker and its exit status depends on the result', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../scripts/gemini-review.mjs'), 'utf8');
    assert.match(src, /import \{ recordFinalReviewMarker \} from '\.\/lib\/final-review-marker\.mjs'/);
    assert.match(src, /finishAndExit\(recordFinalReviewMarker\(\{ auditMode, result, repoRoot: process\.cwd\(\) \}\) \? 1 : 0\)/,
      'the review must call the recorder after emitting its verdict and exit non-zero when the recorder says fatal');
  });
});
