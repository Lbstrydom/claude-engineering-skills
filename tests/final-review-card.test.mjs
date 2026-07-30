/**
 * @fileoverview Contract tests for the `/ship` final-review credit card.
 *
 * `renderFinalReviewCard` exists BECAUSE a SKILL.md is not an executable seam —
 * "three /ship regression tests" could not otherwise have been satisfied (audit
 * R3-M2). Everything the operator sees is decided here, so everything the plan
 * promises about the card is asserted here.
 *
 * The gate-honesty case is the EMPTY-STRING path, and it cuts BOTH ways: a ship
 * must never fail or shout because a label is missing, so `disabled` and a
 * well-formed zero-count `ready` render nothing — but a MALFORMED `ready` must
 * NOT, because a reader/schema regression reading as "nothing pending" is the
 * one failure that silently disables the whole loop (R1-M6).
 *
 * Plan: docs/plans/final-review-credit-and-cheap-shadow.md §2.2.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderFinalReviewCard } from '../scripts/lib/final-review-credit.mjs';

const SHA = 'a1b2c3d';
const item = (over = {}) => ({
  run_id: 'r-1', finding_fingerprint: 'f00d', bucket: 'shadow-only',
  severity: 'HIGH', primary_file: 'scripts/x.mjs', category: 'Cat',
  user_action: null, remediation_state: null, created_at: '2026-07-29', ...over,
});
const ready = (items, counts) => ({
  schemaVersion: 1, state: 'ready', cloud: true, repo: 'o/r',
  counts: { unadjudicated: 0, fixedUnlabelled: 0, acceptedUnfixed: 0, regressed: 0, integrityWarning: 0, unknown: 0, totalActionable: items.length, ...counts },
  shownCount: items.length, items,
});

describe('renderFinalReviewCard — silence is the safe default', () => {
  it('renders NOTHING when cloud is disabled', () => {
    assert.equal(renderFinalReviewCard({ schemaVersion: 1, state: 'disabled' }), '');
  });

  it('renders NOTHING for a ready result with zero actionable findings', () => {
    assert.equal(renderFinalReviewCard(ready([], { totalActionable: 0 })), '');
  });

  it('renders NOTHING for junk, null, or an unrecognised state — never throws', () => {
    for (const bad of [null, undefined, 'string', 42, {}, { state: 'bogus' }]) {
      assert.equal(renderFinalReviewCard(bad), '', `expected '' for ${JSON.stringify(bad)}`);
    }
  });

  it('a MALFORMED ready warns instead of reading as a healthy empty queue (R1-M6)', () => {
    // The anti-green case: a reader/schema regression is the one failure that
    // would silently stop the credit loop surfacing anything, so it must NOT be
    // indistinguishable from "nothing pending".
    for (const broken of [
      { state: 'ready' },                                             // no counts, no items
      { state: 'ready', counts: {}, items: [] },                      // counts present but no total
      { state: 'ready', counts: { totalActionable: 3 } },              // total but no items array
      { state: 'ready', counts: { totalActionable: 'lots' }, items: [] }, // non-numeric total
      { state: 'ready', counts: { totalActionable: 0 }, items: [] },        // no schemaVersion (R2-M4)
    ]) {
      const out = renderFinalReviewCard(broken);
      assert.match(out, /MALFORMED_READY/, `expected a warning for ${JSON.stringify(broken)}`);
      assert.match(out, /ship continues/, 'the warning must still be non-blocking');
    }
  });

  it('a WELL-FORMED empty ready stays silent — silence is reserved for real emptiness', () => {
    // Uses the CANONICAL envelope (R2-M4): asserting silence on a minimal
    // hand-made object would have codified an incomplete payload as healthy,
    // which is the very thing the malformed check above exists to reject.
    assert.equal(renderFinalReviewCard(ready([], { totalActionable: 0 })), '');
  });

  it('unavailable renders exactly ONE non-blocking line carrying only the CODE', () => {
    const out = renderFinalReviewCard({ schemaVersion: 1, state: 'unavailable', diagnostic: 'AUTH_FAILED' });
    assert.equal(out.split('\n').length, 1);
    assert.match(out, /AUTH_FAILED/);
    assert.match(out, /ship continues/);
  });

  it('unavailable NEVER leaks a secret placed in the DIAGNOSTIC ITSELF (R2-M5)', () => {
    // The earlier version of this test put credentials in `error`/`stack` while
    // leaving `diagnostic` benign — so it never exercised the one field the
    // renderer actually interpolates, and would have passed against a renderer
    // that echoed `diagnostic` raw. It now does.
    const out = renderFinalReviewCard({
      state: 'unavailable',
      diagnostic: 'postgresql://user:sekret@db.example.com:5432/postgres sk-ant-api03-DEADBEEF',
    });
    assert.doesNotMatch(out, /sekret|postgresql:\/\/|sk-ant/, 'an off-enum diagnostic must not reach stdout');
    assert.match(out, /\(UNKNOWN\)/, 'it collapses to the UNKNOWN literal instead');
  });

  it('unavailable still ignores secrets smuggled into NEIGHBOURING fields', () => {
    const out = renderFinalReviewCard({
      state: 'unavailable',
      diagnostic: 'CLOUD_UNREACHABLE',
      error: 'postgresql://user:sekret@db.example.com:5432/postgres',
      stack: 'sk-ant-api03-DEADBEEF',
    });
    assert.doesNotMatch(out, /sekret|postgresql:\/\/|sk-ant/);
    assert.match(out, /CLOUD_UNREACHABLE/);
  });
});

describe('renderFinalReviewCard — the state→command matrix', () => {
  it('unadjudicated offers BOTH accepted and dismissed', () => {
    const out = renderFinalReviewCard(ready([item()], { unadjudicated: 1 }), { commitSha: SHA });
    assert.match(out, /--action accepted --bucket shadow-only/);
    assert.match(out, /--action dismissed --bucket shadow-only/);
  });

  it('fixed-unlabelled offers BOTH actions — a recorded fix is not proof the finding was valid (R1-H4)', () => {
    const out = renderFinalReviewCard(
      ready([item({ remediation_state: 'fixed', classification: 'fixed-unlabelled' })], { fixedUnlabelled: 1 }),
      { commitSha: SHA },
    );
    // BOTH actions (R1-H4): a recorded remediation proves a commit was
    // ASSOCIATED with the finding, not that the finding was valid or that the
    // fingerprint was the right one. Collapsing adjudication into remediation
    // breaks the two-axis model, and mis-linking is exactly what needs a
    // dismissal path.
    assert.match(out, /--action accepted/);
    assert.match(out, /--action dismissed/, 'a mis-linked fix must remain dismissable');
    assert.match(out, /mis-linked/, 'the dismissal option should say when it applies');
  });

  it('accepted-unfixed emits record-fix --state fixed WITH the resolved commit', () => {
    const out = renderFinalReviewCard(
      ready([item({ user_action: 'accepted-permanent', classification: 'accepted-unfixed' })], { acceptedUnfixed: 1 }),
      { commitSha: SHA },
    );
    assert.match(out, /final-review-record-fix .*--commit a1b2c3d --state fixed/);
  });

  it('regressed emits --state verified AND --commit (the draft omitted the sha, losing provenance)', () => {
    const out = renderFinalReviewCard(
      ready([item({ remediation_state: 'regressed', classification: 'regressed' })], { regressed: 1 }),
      { commitSha: SHA },
    );
    assert.match(out, /--commit a1b2c3d --state verified/);
  });

  it('with no resolved sha, a fix line degrades to guidance rather than an unrunnable command', () => {
    const out = renderFinalReviewCard(
      ready([item({ user_action: 'fix-now', classification: 'accepted-unfixed' })], { acceptedUnfixed: 1 }),
      { commitSha: null },
    );
    // Assert the PROPERTY (no runnable fix command), not the substring: the
    // guidance line legitimately names `--commit` as prose, so a bare
    // /--commit/ check fails on correct output.
    assert.doesNotMatch(out, /final-review-record-fix/, 'must not emit a command with no sha to put in it');
    assert.doesNotMatch(out, /--commit \S/, 'must not emit --commit with any value');
    assert.doesNotMatch(out, /--[a-z-]+/, 'the fallback must not even LOOK like a truncated command');
    assert.match(out, /re-run this check after the commit lands/);
  });

  it('integrity-warning and unknown emit a warning and NO command', () => {
    const out = renderFinalReviewCard(ready([
      item({ user_action: 'dismissed', remediation_state: 'regressed', classification: 'integrity-warning' }),
      item({ finding_fingerprint: 'beef', user_action: 'future', classification: 'unknown' }),
    ], { integrityWarning: 1, unknown: 1 }), { commitSha: SHA });
    assert.match(out, /contradictory; reconcile by hand/);
    assert.match(out, /unrecognised user_action/);
    assert.doesNotMatch(out, /final-review-adjudicate|final-review-record-fix/);
  });
});

describe('renderFinalReviewCard — operator-doc rules and bounds', () => {
  const many = Array.from({ length: 3 }, (_, i) => item({ finding_fingerprint: `f${i}` }));

  it('emits NO <angle-brackets> and NO ellipsis in any line (PowerShell reserves `<`)', () => {
    const out = renderFinalReviewCard(ready(many, { unadjudicated: 3, totalActionable: 3 }), { commitSha: SHA });
    assert.doesNotMatch(out, /<[a-z][a-z-]*>/i, 'a placeholder command is unpasteable in PowerShell');
    assert.doesNotMatch(out, /…|\.\.\./, 'commands must be complete, never abbreviated');
  });

  it('every emitted command is complete — run-id, fingerprint and bucket all present', () => {
    const out = renderFinalReviewCard(ready([item()], { unadjudicated: 1 }), { commitSha: SHA });
    for (const line of out.split('\n').filter((l) => l.includes('cross-skill.mjs'))) {
      assert.match(line, /--run-id \S+/);
      assert.match(line, /--fingerprint \S+/);
      assert.match(line, /--bucket shadow-only/);
    }
  });

  it('shows an overflow pointer to the existing worksheet when the total exceeds the page', () => {
    const out = renderFinalReviewCard(ready(many, { unadjudicated: 42, totalActionable: 42 }), { commitSha: SHA });
    assert.match(out, /39 more not shown/);
    assert.match(out, /final-review-stats --repo o\/r --worksheet/);
  });

  it('shows no overflow pointer when the page holds everything', () => {
    const out = renderFinalReviewCard(ready(many, { unadjudicated: 3, totalActionable: 3 }), { commitSha: SHA });
    assert.doesNotMatch(out, /more not shown/);
  });

  it('never prints detail_snapshot even when a caller leaks one into an item', () => {
    const out = renderFinalReviewCard(
      ready([item({ detail_snapshot: 'FREEFORM MODEL PROSE THAT MUST NOT APPEAR' })], { unadjudicated: 1 }),
      { commitSha: SHA },
    );
    assert.doesNotMatch(out, /FREEFORM MODEL PROSE/);
  });

  it('is deterministic — identical input renders byte-identical output', () => {
    const r = ready(many, { unadjudicated: 3, totalActionable: 3 });
    assert.equal(renderFinalReviewCard(r, { commitSha: SHA }), renderFinalReviewCard(r, { commitSha: SHA }));
  });
});
