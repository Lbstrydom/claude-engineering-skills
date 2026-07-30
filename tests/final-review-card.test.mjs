/**
 * @fileoverview Contract tests for the `/ship` final-review credit card.
 *
 * `renderFinalReviewCard` exists BECAUSE a SKILL.md is not an executable seam —
 * "three /ship regression tests" could not otherwise have been satisfied (audit
 * R3-M2). Everything the operator sees is decided here, so everything the plan
 * promises about the card is asserted here.
 *
 * The gate-honesty case for this module is the EMPTY-STRING path: a ship must
 * never fail or shout because a label is missing, so `disabled`, a zero-count
 * `ready`, and any unrecognised shape must all render nothing.
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
    for (const bad of [null, undefined, 'string', 42, {}, { state: 'bogus' }, { state: 'ready' }]) {
      assert.equal(renderFinalReviewCard(bad), '', `expected '' for ${JSON.stringify(bad)}`);
    }
  });

  it('unavailable renders exactly ONE non-blocking line carrying only the CODE', () => {
    const out = renderFinalReviewCard({ schemaVersion: 1, state: 'unavailable', diagnostic: 'AUTH_FAILED' });
    assert.equal(out.split('\n').length, 1);
    assert.match(out, /AUTH_FAILED/);
    assert.match(out, /ship continues/);
  });

  it('unavailable NEVER leaks a DSN or key even if one is smuggled in as the diagnostic', () => {
    // The reader maps errors to a closed enum, but the renderer is the last line
    // of defence: this is the seam where an err.message would surface.
    const out = renderFinalReviewCard({
      state: 'unavailable',
      diagnostic: 'CLOUD_UNREACHABLE',
      error: 'postgresql://user:sekret@db.example.com:5432/postgres',
      stack: 'sk-ant-api03-DEADBEEF',
    });
    assert.doesNotMatch(out, /sekret|postgresql:\/\/|sk-ant/);
  });
});

describe('renderFinalReviewCard — the state→command matrix', () => {
  it('unadjudicated offers BOTH accepted and dismissed', () => {
    const out = renderFinalReviewCard(ready([item()], { unadjudicated: 1 }), { commitSha: SHA });
    assert.match(out, /--action accepted --bucket shadow-only/);
    assert.match(out, /--action dismissed --bucket shadow-only/);
  });

  it('fixed-unlabelled offers accepted ONLY — a shipped fix implies the finding was real', () => {
    const out = renderFinalReviewCard(
      ready([item({ remediation_state: 'fixed', classification: 'fixed-unlabelled' })], { fixedUnlabelled: 1 }),
      { commitSha: SHA },
    );
    assert.match(out, /--action accepted/);
    assert.doesNotMatch(out, /--action dismissed/, 'offering dismissed here invites a self-contradictory label');
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
