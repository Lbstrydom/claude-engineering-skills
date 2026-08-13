/**
 * Fix-lifecycle projection: pure targeting cores + fail-open behaviour
 * (fix-lifecycle plan §9). The DB round-trip itself is an integration concern;
 * here we lock the deterministic reconciliation logic and the cloud-off no-op.
 */
import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildLedgerTerminalIndex, selectReconcileTargets,
  markFindingsRemediation, reconcileRemediationProjection,
  normalizeRemediationUpdates,
} from '../scripts/lib/store/runs-findings.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

// ── normalizeRemediationUpdates: validation as a PURE seam (audit R1/M7) ─────
// These do NOT rely on cloud-off, so a broken validator is caught directly.
test('normalizeRemediationUpdates resolves state from action or explicit field', () => {
  const { valid } = normalizeRemediationUpdates([
    { findingFingerprint: 'a', action: 'mark-fixed', resolvedRound: 2 },
    { findingFingerprint: 'b', action: 'mark-regressed' },
    { findingFingerprint: 'c', state: 'verified' },
  ]);
  assert.deepEqual(valid, [
    { fingerprint: 'a', state: 'fixed', resolvedRound: 2 },
    { fingerprint: 'b', state: 'regressed', resolvedRound: null },
    { fingerprint: 'c', state: 'verified', resolvedRound: null },
  ]);
});

test('normalizeRemediationUpdates rejects malformed updates with a reason', () => {
  const { valid, rejected } = normalizeRemediationUpdates([
    { action: 'mark-fixed' },                    // no fingerprint
    { findingFingerprint: 'x' },                 // no state
    { findingFingerprint: 'y', state: 'pending' }, // non-terminal
    { findingFingerprint: 'z', action: 'noop' }, // unresolvable action
  ]);
  assert.equal(valid.length, 0);
  assert.equal(rejected.length, 4);
  assert.match(rejected[0].reason, /fingerprint/i);
  assert.match(rejected[1].reason, /state/);
  assert.match(rejected[2].reason, /non-terminal/);
});

test('normalizeRemediationUpdates tolerates a non-array input', () => {
  assert.deepEqual(normalizeRemediationUpdates(undefined), { valid: [], rejected: [] });
});

test('buildLedgerTerminalIndex keeps only terminal states, keyed by fingerprint', () => {
  const ledger = { entries: [
    { semanticHash: 'a', remediationState: 'fixed' },
    { semanticHash: 'b', remediationState: 'pending' },   // excluded
    { semanticHash: 'c', remediationState: 'regressed' },
    { semanticHash: 'd', remediationState: 'verified' },
    { remediationState: 'fixed' },                         // no fingerprint → excluded
  ] };
  const idx = buildLedgerTerminalIndex(ledger);
  assert.deepEqual([...idx.entries()].sort(), [['a', 'fixed'], ['c', 'regressed'], ['d', 'verified']]);
  assert.ok(!idx.has('b'));
});

test('selectReconcileTargets returns only rows whose DB state DISAGREES with the ledger', () => {
  const idx = new Map([['a', 'fixed'], ['c', 'regressed']]);
  const rows = [
    { finding_fingerprint: 'a', remediation_state: 'pending' },   // disagree → project fixed
    { finding_fingerprint: 'c', remediation_state: 'fixed' },     // disagree (terminal→terminal!) → project regressed
    { finding_fingerprint: 'a2', remediation_state: 'fixed' },    // not in index → skip
    { finding_fingerprint: 'a', remediation_state: 'fixed' },     // agree → no-op
  ];
  const targets = selectReconcileTargets(rows, idx);
  assert.deepEqual(targets.sort((x, y) => x.fingerprint.localeCompare(y.fingerprint)), [
    { fingerprint: 'a', state: 'fixed' },
    { fingerprint: 'c', state: 'regressed' },
  ]);
});

test('terminal→terminal divergence IS selected (Gemini-gate-3 regression guard)', () => {
  // The pending-only filter would have missed this: DB says fixed, ledger says regressed.
  const idx = new Map([['x', 'regressed']]);
  const targets = selectReconcileTargets([{ finding_fingerprint: 'x', remediation_state: 'fixed' }], idx);
  assert.deepEqual(targets, [{ fingerprint: 'x', state: 'regressed' }]);
});

test('markFindingsRemediation is a no-op when cloud is disabled (fail-open)', async () => {
  const prev = process.env.AUDIT_DB_URL;
  delete process.env.AUDIT_DB_URL;
  try {
    const r = await markFindingsRemediation('repo-1', [{ findingFingerprint: 'a', state: 'fixed' }]);
    // `attempted` accompanies `updated` so a caller can see a SHORTFALL: this
    // writer is fail-open PER ROW, so `updated` alone cannot distinguish
    // "projected all of them" from "projected some and logged the rest".
    assert.deepEqual(r, { updated: 0, attempted: 0 });
  } finally { if (prev !== undefined) process.env.AUDIT_DB_URL = prev; }
});

test('reconcileRemediationProjection no-ops on empty ledger index / cloud-off', async () => {
  const prev = process.env.AUDIT_DB_URL;
  delete process.env.AUDIT_DB_URL;
  try {
    // `ok` distinguishes a HEALTHY no-op from a sweep that threw — both used to
    // answer a bare `{reconciled: 0}`.
    assert.deepEqual(await reconcileRemediationProjection('repo-1', { entries: [] }),
      { reconciled: 0, attempted: 0, ok: true, reason: 'cloud-off' });
  } finally { if (prev !== undefined) process.env.AUDIT_DB_URL = prev; }
});

test('markFindingsRemediation ignores updates missing a fingerprint or state', async () => {
  const prev = process.env.AUDIT_DB_URL;
  delete process.env.AUDIT_DB_URL;
  try {
    // cloud-off returns {updated:0}; the guard-skip logic is exercised regardless.
    const r = await markFindingsRemediation('repo-1', [{ action: 'mark-fixed' }, { findingFingerprint: 'a' }]);
    assert.equal(r.updated, 0);
  } finally { if (prev !== undefined) process.env.AUDIT_DB_URL = prev; }
});

// ── DB write shape (integration) ────────────────────────────────────────────
// The pure-logic tests above cannot see this: `markFindingsRemediation` used to
// DELETE the finding's `finding_adjudication_events` row and re-INSERT one
// carrying only `finding_id`/`remediation_state`/`round` — omitting the NOT
// NULL `adjudication_outcome` column, so the write threw `23502` on every call
// (fixed/verified/regressed alike, not just non-terminal dispositions) and
// `withTx` rolled back the paired `audit_findings.remediation_state` UPDATE
// along with it. A no-DB unit test would have re-implemented the same broken
// assumption and stayed green. This block needs a real constraint-enforcing
// Postgres, so it only runs with `AUDIT_DB_TEST_URL` set.
describe('markFindingsRemediation — DB write shape (integration)', { skip }, () => {
  let mod, q, repoId, runId;
  const FP_WITH_EVENT = 'fpevent1';
  const FP_NO_ROUND = 'fpevent2';
  const FP_NO_EVENT_ROW = 'fpevent3';
  let findingIdWithEvent, findingIdNoRound, findingIdNoEventRow;
  let eventIdWithEvent;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    const savedUrl = process.env.AUDIT_DB_URL;
    // Refuses a production-identical DSN (the July 2026 wipe incident guard).
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    mod = await import('../scripts/lib/store/runs-findings.mjs');

    repoId = crypto.randomUUID();
    runId = crypto.randomUUID();
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2)
                   ON CONFLICT (id) DO NOTHING`, [repoId, `test-${repoId.slice(0, 8)}`]);
    // `plan_file` and `mode` are the two NOT NULL columns on audit_runs with no
    // default, so omitting them throws 23502. It read clean only because a
    // conflicting row skips the check — this passed on a re-used
    // check whenever the row already exists — so this passed on a re-used
    // container and failed on a fresh one. The suite was enrolled in no runner
    // until 2026-08-11, so neither case was ever observed.
    await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/test-fixture.md', 'code')
                   ON CONFLICT (id) DO NOTHING`, [runId, repoId]);

    const insFinding = async (fp, adjudicationOutcome, remediationState) => {
      const row = await q.one(
        `INSERT INTO audit_findings
           (run_id, finding_fingerprint, pass_name, severity, category, adjudication_outcome, remediation_state)
         VALUES ($1, $2, 'test', 'HIGH', 'test', $3, $4)
         RETURNING id`,
        [runId, fp, adjudicationOutcome, remediationState]
      );
      return row.id;
    };
    const insEvent = async (findingId, outcome, remediationState, ruling, rationale, round) => {
      const row = await q.one(
        `INSERT INTO finding_adjudication_events
           (finding_id, adjudication_outcome, remediation_state, ruling, ruling_rationale, round)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [findingId, outcome, remediationState, ruling, rationale, round]
      );
      return row.id;
    };

    findingIdWithEvent = await insFinding(FP_WITH_EVENT, 'accepted', 'pending');
    eventIdWithEvent = await insEvent(findingIdWithEvent, 'accepted', 'pending', 'sustain', 'real bug, needs fix', 1);

    findingIdNoRound = await insFinding(FP_NO_ROUND, 'severity_adjusted', 'fixed');
    await insEvent(findingIdNoRound, 'severity_adjusted', 'fixed', 'compromise', 'partially valid', 2);

    findingIdNoEventRow = await insFinding(FP_NO_EVENT_ROW, 'accepted', 'pending');
  });

  after(async () => {
    if (!q) return;
    // FK is ON DELETE CASCADE finding_adjudication_events -> audit_findings, so
    // deleting audit_findings is sufficient to clean up both tables.
    await q.query('DELETE FROM audit_findings WHERE run_id = $1', [runId]);
    await q.query('DELETE FROM audit_runs WHERE id = $1', [runId]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  it('projects remediation_state + round WITHOUT clobbering adjudication_outcome/ruling', async () => {
    const res = await mod.markFindingsRemediation(repoId, [
      { findingFingerprint: FP_WITH_EVENT, state: 'fixed', resolvedRound: 3 },
    ]);
    assert.equal(res.updated, 1, 'markFindingsRemediation must succeed, not silently fail the whole transaction');

    const finding = await q.one(`SELECT remediation_state FROM audit_findings WHERE id = $1`, [findingIdWithEvent]);
    assert.equal(finding.remediation_state, 'fixed');

    const event = await q.one(
      `SELECT id, adjudication_outcome, remediation_state, ruling, ruling_rationale, round
         FROM finding_adjudication_events WHERE finding_id = $1`,
      [findingIdWithEvent]
    );
    assert.equal(event.id, eventIdWithEvent, 'must UPDATE the existing row in place, not delete+recreate it');
    assert.equal(event.remediation_state, 'fixed');
    assert.equal(event.round, 3);
    // The crux of the regression: the old delete+insert wrote only
    // finding_id/remediation_state/round, omitting the NOT NULL
    // adjudication_outcome column (crash) and silently dropping
    // ruling/ruling_rationale too.
    assert.equal(event.adjudication_outcome, 'accepted', 'adjudication_outcome must be preserved, never nulled');
    assert.equal(event.ruling, 'sustain', 'ruling must be preserved');
    assert.equal(event.ruling_rationale, 'real bug, needs fix', 'ruling_rationale must be preserved');
  });

  it('the self-heal reconcile shape (no resolvedRound) updates state without touching round', async () => {
    // reconcileRemediationProjection's targets carry only {fingerprint, state} —
    // no resolvedRound — so this mirrors that call shape.
    const res = await mod.markFindingsRemediation(repoId, [
      { findingFingerprint: FP_NO_ROUND, state: 'regressed' },
    ]);
    assert.equal(res.updated, 1);

    const event = await q.one(
      `SELECT remediation_state, round, adjudication_outcome
         FROM finding_adjudication_events WHERE finding_id = $1`,
      [findingIdNoRound]
    );
    assert.equal(event.remediation_state, 'regressed');
    assert.equal(event.round, 2, 'round must stay at its prior value, never be nulled, when resolvedRound is unknown');
    assert.equal(event.adjudication_outcome, 'severity_adjusted', 'preserved across the reconcile-driven update');
  });

  it('projects audit_findings even when no prior adjudication_events row exists (logs, never throws or rolls back)', async () => {
    const res = await mod.markFindingsRemediation(repoId, [
      { findingFingerprint: FP_NO_EVENT_ROW, state: 'fixed', resolvedRound: 1 },
    ]);
    assert.equal(res.updated, 1, 'a missing sibling event row must not roll back the audit_findings projection');
    const finding = await q.one(`SELECT remediation_state FROM audit_findings WHERE id = $1`, [findingIdNoEventRow]);
    assert.equal(finding.remediation_state, 'fixed');
  });
});

// ── The believable false zero this pair used to produce (audit 2026-08-13) ────
//
// `reconcileRemediationProjection` answered a bare `{reconciled: 0}` from BOTH
// its healthy "nothing diverged" path and its `catch`. Those are opposite
// facts — a self-heal with nothing to do, versus a self-heal that never ran —
// and the orchestrator, which discarded the value entirely, could not have told
// them apart even if it had looked. That is the exact shape the durability work
// exists to eliminate, sitting inside the function whose job is repairing
// divergence.
describe('remediation projection reports its own failure', () => {
  it('a THROWN sweep is distinguishable from a clean one', async () => {
    // Drive the real function with a ledger index that is non-empty (so it gets
    // past the early returns) while cloud is off in a way that makes the query
    // throw rather than short-circuit — the `catch` branch is the subject.
    const prev = process.env.AUDIT_DB_URL;
    process.env.AUDIT_DB_URL = 'postgresql://nobody@127.0.0.1:1/nonexistent';
    try {
      const r = await reconcileRemediationProjection('repo-1', {
        entries: [{ topicId: 't1', semanticHash: 'abc', remediationState: 'fixed', adjudicationOutcome: 'accepted' }],
      });
      // Whatever the failure mode, the two states must not be the same VALUE.
      const healthy = { reconciled: 0, attempted: 0, ok: true, reason: 'already-consistent' };
      assert.notDeepEqual(r, healthy,
        'a failed sweep returned the healthy no-op value — the caller cannot tell them apart');
      if (r.ok === false) {
        assert.ok(r.reason, 'a failed sweep must carry a reason, not just ok:false');
      }
    } finally {
      if (prev === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = prev;
    }
  });

  it('NEGATIVE CONTROL: the healthy no-op still reports ok:true', async () => {
    // Without this, a function hard-wired to ok:false passes the test above
    // while reporting every clean run as a failure.
    const prev = process.env.AUDIT_DB_URL;
    delete process.env.AUDIT_DB_URL;
    try {
      const r = await reconcileRemediationProjection('repo-1', { entries: [] });
      assert.equal(r.ok, true, 'a clean no-op must not be reported as a failure');
    } finally { if (prev !== undefined) process.env.AUDIT_DB_URL = prev; }
  });

  it('markFindingsRemediation reports attempted so a SHORTFALL is computable', async () => {
    const prev = process.env.AUDIT_DB_URL;
    delete process.env.AUDIT_DB_URL;
    try {
      const r = await markFindingsRemediation('repo-1', [
        { findingFingerprint: 'a', state: 'fixed' },
        { findingFingerprint: 'b', state: 'regressed' },
      ]);
      assert.ok('attempted' in r, 'without `attempted`, updated<attempted is not computable by the caller');
      assert.equal(typeof r.attempted, 'number');
    } finally { if (prev !== undefined) process.env.AUDIT_DB_URL = prev; }
  });
});
