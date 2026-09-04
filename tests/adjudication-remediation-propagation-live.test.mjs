/**
 * @fileoverview The ONE DB-gated assertion that `recordAdjudicationEvent`
 * actually propagates `remediation_state` onto `audit_findings`.
 *
 * **Why this file exists.** Its pure sibling
 * (`adjudication-remediation-propagation.test.mjs`) tests
 * `buildFindingAdjudicationPatch` and says so in its own docstring: "the DB
 * round-trip is out of scope for a unit test". But the defect that test was
 * written for was *specifically* a divergence between event persistence
 * (`finding_adjudication_events`) and the `audit_findings` column the
 * `unlocked_fixes` view reads — so a green patch-builder proves only that a
 * detached helper builds the right object. It cannot show that
 * `recordAdjudicationEvent` calls that helper, aims the UPDATE at the intended
 * finding, or commits it.
 *
 * That gap is not hypothetical here. AGENTS.md records the `getRefreshRun` /
 * 42703 incident in the same terms: "every unit test exercised the pure
 * decision, never the query, so split the decision out AND put one assertion on
 * a real Postgres — the pure tests passed throughout the entire period the
 * cache was dead." This is that one assertion, for this seam.
 *
 * INC-002 (docs/security-strategy.md — the 2026-07-14 production wipe): gated
 * on `assertDisposableDbUrl`, never on "is AUDIT_DB_TEST_URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('recordAdjudicationEvent — remediation_state reaches audit_findings (DB integration)', { skip }, () => {
  let store, q, repoId, runId;
  const FP = `remprop-${crypto.randomUUID().slice(0, 8)}`;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    store = await import('../scripts/lib/store/runs-findings.mjs');

    repoId = crypto.randomUUID();
    runId = crypto.randomUUID();
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [repoId, `test-${repoId.slice(0, 8)}`]);
    await q.query(
      `INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/test-fixture.md', 'code')
       ON CONFLICT (id) DO NOTHING`, [runId, repoId]);
    await q.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, round_raised)
       VALUES ($1, $2, 'structure', 'HIGH', 'test', 1)`, [runId, FP]);
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM finding_adjudication_events WHERE finding_id IN (SELECT id FROM audit_findings WHERE run_id = $1)', [runId]);
    await q.query('DELETE FROM audit_findings WHERE run_id = $1', [runId]);
    await q.query('DELETE FROM audit_runs WHERE id = $1', [runId]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  /** Read the two columns that must agree, straight from the base table. */
  async function readFinding() {
    return q.one(
      `SELECT id, adjudication_outcome, remediation_state FROM audit_findings
        WHERE run_id = $1 AND finding_fingerprint = $2`, [runId, FP]);
  }

  test('a fresh finding starts with neither axis set (negative control)', async () => {
    const row = await readFinding();
    assert.ok(row, 'the seeded finding must exist — otherwise every assertion below is vacuous');
    assert.equal(row.adjudication_outcome, null);
    assert.equal(row.remediation_state, null);
  });

  test('writes remediation_state onto audit_findings, not only the events table', async () => {
    await store.recordAdjudicationEvent(runId, FP, {
      adjudicationOutcome: 'accepted', remediationState: 'fixed',
      ruling: 'sustain', rulingRationale: 'live propagation test', round: 1,
    });

    const row = await readFinding();
    // The column `unlocked_fixes` reads. This is the whole point of the file:
    // the event row below can be perfect while this stays null.
    assert.equal(row.remediation_state, 'fixed',
      'remediation_state must land on audit_findings — the events table alone is what the original defect was');
    assert.equal(row.adjudication_outcome, 'accepted');

    const ev = await q.one(
      `SELECT adjudication_outcome, remediation_state FROM finding_adjudication_events WHERE finding_id = $1`,
      [row.id]);
    assert.ok(ev, 'the adjudication event must also be persisted');
    assert.equal(ev.remediation_state, 'fixed');
    // Both sides agreeing is the invariant; asserting only one lets them diverge.
    assert.equal(ev.remediation_state, row.remediation_state,
      'the event row and audit_findings must not disagree — divergence IS the defect');
  });

  test('an event omitting remediationState is REFUSED, leaving both axes untouched', async () => {
    // The pure sibling asserts that `buildFindingAdjudicationPatch` omits the
    // key when the event carries no remediationState, so a later event "cannot
    // null an existing state". Against a real schema that path is unreachable:
    // `finding_adjudication_events.remediation_state` is NOT NULL, so the INSERT
    // fails before the UPDATE runs and `withTx` rolls the whole thing back.
    //
    // The end state is SAFER than the pure test describes — neither axis moves,
    // not just the remediation one — but it is reached by a different mechanism,
    // and only a live schema can show that. Recording it here so the next reader
    // does not conclude from the patch-builder test that a partial adjudication
    // is a supported call shape. It is not; the store fails closed on it.
    await store.recordAdjudicationEvent(runId, FP, {
      adjudicationOutcome: 'dismissed', ruling: 'overrule', round: 1,
    });

    const row = await readFinding();
    assert.equal(row.remediation_state, 'fixed',
      'the recorded remediation state must survive a refused event');
    assert.equal(row.adjudication_outcome, 'accepted',
      'the refused event must not move the adjudication axis either — the tx rolls back whole');
  });

  test('the prior successful event is still the only one on record', async () => {
    // Guards the rollback claim above from the other side: a partial write that
    // deleted the old event and then failed to insert would leave zero rows and
    // still satisfy the assertions above.
    const row = await readFinding();
    const evs = await q.many(
      `SELECT adjudication_outcome, remediation_state FROM finding_adjudication_events WHERE finding_id = $1`,
      [row.id]);
    assert.equal(evs.length, 1, 'exactly one event row must remain — the refused one must not have deleted it');
    assert.equal(evs[0].adjudication_outcome, 'accepted');
    assert.equal(evs[0].remediation_state, 'fixed');
  });
});
