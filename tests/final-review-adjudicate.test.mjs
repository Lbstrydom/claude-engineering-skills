/**
 * @fileoverview `adjudicateFinalReviewFinding` — bucket resolution + the
 * no-silent-success contract.
 *
 * This function had NO test, which is why a hardcoded `bucket: 'shadow-only'`
 * predicate survived: every PRIMARY final-review finding "adjudicated"
 * successfully and nothing changed. `{ok: true, updated: 0}` is the
 * unverified-write-success class this codebase rates HIGH elsewhere.
 *
 * **Coverage honesty about this file itself**: the bucket-resolution matrix
 * genuinely needs a database — the decision is made from a live `SELECT
 * DISTINCT bucket`. So it is an env-gated integration block (`AUDIT_DB_TEST_URL`,
 * disposable-DSN asserted), NOT a pure re-implementation of the branch table.
 * Re-stating the logic in the test would have passed on this machine while
 * proving nothing about the code — the same shape of self-satisfying green
 * that let the original bug through. Without the DSN, only the contract block
 * below runs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { waitUntilBlockedBy } from './helpers/pg-lock-wait.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('adjudicateFinalReviewFinding — contract (no DB required)', () => {
  it('is exported and accepts an optional 4th opts argument', async () => {
    const mod = await import('../scripts/lib/store/runs-findings.mjs');
    assert.equal(typeof mod.adjudicateFinalReviewFinding, 'function');
  });

  it('rejects an invalid action loudly rather than writing nothing quietly', async () => {
    const mod = await import('../scripts/lib/store/runs-findings.mjs');
    await assert.rejects(
      () => mod.adjudicateFinalReviewFinding('run', 'fp', 'maybe'),
      /must be 'accepted' or 'dismissed'/,
    );
  });

  it('names a REASON on every failure, never a bare ok:false', async () => {
    // The CLI turns `reason` into operator guidance. A failure that cannot say
    // why is how the hardcoded-bucket no-op stayed invisible for so long.
    const mod = await import('../scripts/lib/store/runs-findings.mjs');
    const prior = process.env.AUDIT_DB_URL;
    delete process.env.AUDIT_DB_URL;
    try {
      const res = await mod.adjudicateFinalReviewFinding('run', 'fp', 'dismissed');
      assert.equal(res.ok, false);
      assert.ok(res.reason, 'a failure must carry a reason');
    } finally {
      if (prior !== undefined) process.env.AUDIT_DB_URL = prior;
    }
  });
});

// The closing edge of the shadow A/B loop. Before this existed, NOTHING could
// write `remediation_state` for a final-review finding: the only writer
// (markFindingsRemediation) is called solely from legacy-production-audit.mjs,
// projecting from the /audit-code ledger, which final-review findings never
// enter. So "14 accepted, 0 fixed" — the strongest argument that the second
// gate yields observations rather than caught defects — was not a measurement,
// it was missing plumbing. Six findings had genuinely shipped fixes
// (wine-cellar-app#193) and would still have read 0.
describe('recordFinalReviewFix — contract (no DB required)', () => {
  it('is exported', async () => {
    const mod = await import('../scripts/lib/store/runs-findings.mjs');
    assert.equal(typeof mod.recordFinalReviewFix, 'function');
  });

  it('refuses a non-terminal remediation state instead of writing it', async () => {
    // TERMINAL_REMEDIATION is fixed|verified|regressed. 'pending'/'planned' are
    // real states elsewhere in the two-axis model but are not FIX outcomes.
    const mod = await import('../scripts/lib/store/runs-findings.mjs');
    const prior = process.env.AUDIT_DB_URL;
    process.env.AUDIT_DB_URL = prior || 'postgresql://unused/deliberately';
    try {
      const res = await mod.recordFinalReviewFix('run', 'fp', { state: 'pending' });
      assert.equal(res.ok, false);
      assert.match(res.reason, /non-terminal/);
    } finally {
      if (prior === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = prior;
    }
  });

  it('names a REASON on every failure, never a bare ok:false', async () => {
    const mod = await import('../scripts/lib/store/runs-findings.mjs');
    const prior = process.env.AUDIT_DB_URL;
    delete process.env.AUDIT_DB_URL;
    try {
      const res = await mod.recordFinalReviewFix('run', 'fp', {});
      assert.equal(res.ok, false);
      assert.ok(res.reason, 'a failure must carry a reason');
    } finally {
      if (prior !== undefined) process.env.AUDIT_DB_URL = prior;
    }
  });
});

describe('adjudicateFinalReviewFinding — bucket resolution (integration)', { skip }, () => {
  let mod, q, client, repoId, runId;
  const FP_SHADOW = 'fpshadow';
  const FP_PRIMARY = 'fpprimar';
  const FP_BOTH = 'fpboth00';

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    const savedUrl = process.env.AUDIT_DB_URL;
    // Refuses a production-identical DSN. The July 2026 wipe came from a suite
    // run against a prod-aliased URL; this guard is why that cannot recur.
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
    const ins = (fp, bucket) => q.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, bucket)
       VALUES ($1, $2, 'final-review', 'HIGH', 'test', $3)`, [runId, fp, bucket]);
    await ins(FP_SHADOW, 'shadow-only');
    await ins(FP_PRIMARY, null);
    await ins(FP_BOTH, null);
    await ins(FP_BOTH, 'shadow-only');
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM audit_findings WHERE run_id = $1', [runId]);
    await q.query('DELETE FROM audit_runs WHERE id = $1', [runId]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  const outcomeOf = async (fp, bucket) => {
    const r = await q.one(
      `SELECT adjudication_outcome ao, user_action ua, decided_at da
         FROM audit_findings
        WHERE run_id = $1 AND finding_fingerprint = $2 AND bucket IS NOT DISTINCT FROM $3`,
      [runId, fp, bucket]);
    return r;
  };

  it('resolves a lone shadow-only row with no --bucket (back-compat)', async () => {
    const res = await mod.adjudicateFinalReviewFinding(runId, FP_SHADOW, 'accepted');
    assert.equal(res.ok, true);
    assert.equal(res.updated, 1);
    const row = await outcomeOf(FP_SHADOW, 'shadow-only');
    assert.equal(row.ua, 'accepted-permanent');
    // Written alongside user_action so ground-truth queries keyed on these
    // columns can see the adjudication at all.
    assert.equal(row.ao, 'accepted');
    assert.ok(row.da, 'decided_at must be stamped');
  });

  it('adjudicates a PRIMARY (null-bucket) finding — the case that was unreachable', async () => {
    const res = await mod.adjudicateFinalReviewFinding(runId, FP_PRIMARY, 'dismissed');
    assert.equal(res.ok, true, 'a primary finding must be adjudicable');
    assert.equal(res.updated, 1);
    const row = await outcomeOf(FP_PRIMARY, null);
    assert.equal(row.ao, 'dismissed');
  });

  it('REFUSES rather than guessing when a fingerprint spans buckets', async () => {
    // Two buckets sharing a fingerprint are two INDEPENDENT observations
    // (primary vs shadow). Collapsing them would corrupt the A/B comparison
    // the shadow experiment exists to make — the legitimate concern the
    // original hardcode was reaching for.
    const res = await mod.adjudicateFinalReviewFinding(runId, FP_BOTH, 'accepted');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'ambiguous-bucket');
    assert.equal(res.updated, 0);
    assert.equal(res.buckets.length, 2);
    const untouched = await outcomeOf(FP_BOTH, null);
    assert.equal(untouched.ao, null, 'a refusal must not write anything');
  });

  it('an explicit --bucket disambiguates the multi-bucket case', async () => {
    const res = await mod.adjudicateFinalReviewFinding(
      runId, FP_BOTH, 'accepted', { bucket: 'shadow-only' });
    assert.equal(res.ok, true);
    assert.equal(res.updated, 1);
    assert.equal((await outcomeOf(FP_BOTH, 'shadow-only')).ao, 'accepted');
    assert.equal((await outcomeOf(FP_BOTH, null)).ao, null, 'the sibling row stays untouched');
  });

  it('an unknown fingerprint FAILS — never a quiet success', async () => {
    // The whole defect in one assertion.
    const res = await mod.adjudicateFinalReviewFinding(runId, 'nosuchfp', 'dismissed');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no-match');
    assert.equal(res.updated, 0);
  });

  it('an explicit bucket that matches nothing FAILS and names what exists', async () => {
    const res = await mod.adjudicateFinalReviewFinding(
      runId, FP_SHADOW, 'dismissed', { bucket: null });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no-match-in-bucket');
    assert.deepEqual(res.buckets, ['shadow-only']);
  });

  // ── queue burn-down 2026-10-02 (store cluster) ────────────────────────────

  const insRow = (fp, passName, bucket) => q.one(
    `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, bucket)
     VALUES ($1, $2, $3, 'HIGH', 'test', $4) RETURNING id`, [runId, fp, passName, bucket]);

  it('round-1 M1: a fingerprint that exists ONLY in a non-final-review pass is not a final-review finding', async () => {
    const { id } = await insRow('fpmerged', 'merged', null);
    const adj = await mod.adjudicateFinalReviewFinding(runId, 'fpmerged', 'accepted');
    assert.equal(adj.reason, 'no-match', 'a merged-pass row must never resolve as the final-review finding');
    const fix = await mod.recordFinalReviewFix(runId, 'fpmerged', { commitSha: 'abc' });
    assert.equal(fix.reason, 'no-match');
    const row = await q.one(`SELECT user_action, remediation_state FROM audit_findings WHERE id = $1`, [id]);
    assert.deepEqual(row, { user_action: null, remediation_state: null }, 'the merged-pass row must be untouched');
  });

  it('Phase 4: a primary and a shadow row sharing fingerprint AND bucket are ambiguous, never both written', async () => {
    await insRow('fpdupbkt', 'final-review', null);
    await insRow('fpdupbkt', 'final-review-shadow', null);
    const res = await mod.adjudicateFinalReviewFinding(runId, 'fpdupbkt', 'accepted');
    assert.equal(res.reason, 'ambiguous-bucket', 'SELECT DISTINCT bucket collapsed these two rows into one "unambiguous" bucket');
    const written = await q.many(`SELECT id FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = 'fpdupbkt' AND user_action IS NOT NULL`, [runId]);
    assert.equal(written.length, 0);
  });

  it('Phase 4: a dismissal that lands while record-fix is in flight is honoured (one conditional UPDATE, not SELECT-then-UPDATE)', async () => {
    const { id } = await insRow('fprace00', 'final-review', 'primary-only');
    const { getPool } = await import('../scripts/lib/db/client.mjs');
    const pool = await getPool();
    const t1 = await pool.connect();
    let fix;
    let committed = false;
    try {
      await t1.query('BEGIN');
      const { rows: [{ pid }] } = await t1.query('SELECT pg_backend_pid() AS pid');
      await t1.query(`UPDATE audit_findings SET user_action = 'dismissed', adjudication_outcome = 'dismissed' WHERE id = $1`, [id]);
      fix = mod.recordFinalReviewFix(runId, 'fprace00', { commitSha: 'abc' }); // its UPDATE waits on T1's row lock
      // Barrier, not a sleep: commit only once the fix is OBSERVED blocked on T1's lock.
      await waitUntilBlockedBy(pool, pid);
      await t1.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) await t1.query('ROLLBACK').catch(() => {});
      t1.release();
      await fix?.catch(() => {});
    }
    const res = await fix;
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'dismissed-cannot-be-fixed');
    const row = await q.one(`SELECT remediation_state FROM audit_findings WHERE id = $1`, [id]);
    assert.equal(row.remediation_state, null, 'a fix must never be recorded on a finding dismissed before the write committed');
  });

  // ── a disposition must leave a ledger row (standing-queue-burndown §7.2) ──
  //
  // On 2026-09-14 this route closed 435 shadow-only findings in CES one at a
  // time and `finding_adjudication_events` recorded NONE of them, so "who
  // closed these and on what grounds" was unanswerable from the ledger
  // AGENTS.md presents as the record. These cases pin the row it now leaves.

  const eventsFor = (id) => q.many(
    `SELECT adjudication_outcome ao, remediation_state rs, round, ruling,
            ruling_rationale rr, event_origin, adjudicator_kind
       FROM finding_adjudication_events WHERE finding_id = $1`, [id]);

  it('a close leaves EXACTLY ONE ledger row, on both axes, with its grounds', async () => {
    const { id } = await insRow('fpledger', 'final-review', 'shadow-only');
    await q.query('UPDATE audit_findings SET round_raised = 3 WHERE id = $1', [id]);
    const res = await mod.adjudicateFinalReviewFinding(
      runId, 'fpledger', 'dismissed', { bucket: 'shadow-only', rationale: 'stale: path no longer exists' });
    assert.equal(res.ok, true);

    const evs = await eventsFor(id);
    assert.equal(evs.length, 1, 'exactly one event — the whole point of the change');
    const [ev] = evs;
    assert.equal(ev.ao, 'dismissed', 'the adjudication axis');
    assert.equal(ev.rs, 'pending', 'the remediation axis as it STOOD: this route does not fix anything');
    assert.equal(ev.round, 3, 'round is NOT NULL with no default here — it must carry the finding\'s own');
    assert.equal(ev.ruling, null, 'no ruling: a credit disposition is not a ruling on the auditor\'s claim');
    assert.match(ev.rr, /stale: path no longer exists/, '--note is the grounds');
    assert.equal(ev.event_origin, 'audit');
    assert.equal(ev.adjudicator_kind, 'human', 'WHO decided is the axis that separates this from a pipeline ruling');
    // Negative control: the finding's own columns must still be written too —
    // an event alone would be a different bug wearing this fix's clothes.
    const row = await q.one('SELECT user_action ua, adjudication_outcome ao FROM audit_findings WHERE id = $1', [id]);
    assert.deepEqual(row, { ua: 'dismissed', ao: 'dismissed' });
  });

  it('re-adjudicating REPLACES this workflow\'s row and leaves other provenance alone', async () => {
    const { id } = await insRow('fprepeat', 'final-review', 'shadow-only');
    await q.query(
      `INSERT INTO finding_adjudication_events
         (finding_id, adjudication_outcome, remediation_state, round, event_origin, adjudicator_kind)
       VALUES ($1, 'accepted', 'pending', 1, 'audit', 'pipeline')`, [id]);

    await mod.adjudicateFinalReviewFinding(runId, 'fprepeat', 'dismissed', { bucket: 'shadow-only' });
    await mod.adjudicateFinalReviewFinding(runId, 'fprepeat', 'accepted', { bucket: 'shadow-only' });

    const evs = await eventsFor(id);
    assert.equal(evs.length, 2, 'one human row (replaced, not accumulated) + the pipeline ruling');
    const human = evs.filter((e) => e.adjudicator_kind === 'human');
    assert.equal(human.length, 1);
    assert.equal(human[0].ao, 'accepted', 'the latest disposition, not the first');
    assert.equal(evs.filter((e) => e.adjudicator_kind === 'pipeline').length, 1,
      'the pipeline\'s own ruling is separate provenance and must survive');
  });

  it('carries a terminal remediation_state forward, and coerces an out-of-vocabulary one', async () => {
    // `audit_findings.remediation_state` is unconstrained TEXT; the event
    // column is a closed 5-value CHECK. Copying straight across is a 23514.
    const { id: fixed } = await insRow('fpfixed0', 'final-review', 'shadow-only');
    await q.query(`UPDATE audit_findings SET remediation_state = 'fixed' WHERE id = $1`, [fixed]);
    await mod.adjudicateFinalReviewFinding(runId, 'fpfixed0', 'accepted', { bucket: 'shadow-only' });
    assert.equal((await eventsFor(fixed))[0].rs, 'fixed');

    const { id: bogus } = await insRow('fpbogus0', 'final-review', 'shadow-only');
    await q.query(`UPDATE audit_findings SET remediation_state = 'not-a-state' WHERE id = $1`, [bogus]);
    const res = await mod.adjudicateFinalReviewFinding(runId, 'fpbogus0', 'accepted', { bucket: 'shadow-only' });
    assert.equal(res.ok, true, 'an unconstrained finding value must not break the write');
    assert.equal((await eventsFor(bogus))[0].rs, 'pending');
  });

  it('a failed event write ROLLS BACK the disposition — never a closed finding with no record', async () => {
    // Fault injection, because the failure mode is the design decision: the two
    // writes share a transaction, so the bad state this closes is unreachable.
    const { id } = await insRow('fprollbk', 'final-review', 'shadow-only');
    await q.query(`CREATE OR REPLACE FUNCTION test_fae_refuse() RETURNS trigger AS $$
                   BEGIN RAISE EXCEPTION 'injected'; END; $$ LANGUAGE plpgsql`);
    await q.query(`CREATE TRIGGER test_fae_refuse_trg BEFORE INSERT ON finding_adjudication_events
                   FOR EACH ROW EXECUTE FUNCTION test_fae_refuse()`);
    try {
      const res = await mod.adjudicateFinalReviewFinding(runId, 'fprollbk', 'dismissed', { bucket: 'shadow-only' });
      assert.equal(res.ok, false, 'the caller must be told, loudly');
      assert.match(res.reason, /db-error/);
    } finally {
      await q.query('DROP TRIGGER IF EXISTS test_fae_refuse_trg ON finding_adjudication_events');
      await q.query('DROP FUNCTION IF EXISTS test_fae_refuse()');
    }
    const row = await q.one('SELECT user_action ua, decided_at da FROM audit_findings WHERE id = $1', [id]);
    assert.deepEqual(row, { ua: null, da: null }, 'the finding must be exactly as it was');
    assert.equal((await eventsFor(id)).length, 0);
    // Vacuous-pass guard: the same call succeeds once the trigger is gone, so
    // the assertion above measures the rollback and not a broken fixture.
    const ok = await mod.adjudicateFinalReviewFinding(runId, 'fprollbk', 'dismissed', { bucket: 'shadow-only' });
    assert.equal(ok.ok, true);
    assert.equal((await eventsFor(id)).length, 1);
  });

  // Deliberately NOT adding an "adjudicate then replay" case here (plan
  // deviation, noted): this suite's fixture hardcodes pass_name='final-review'
  // for every row regardless of bucket (see `ins()` above), which is not the
  // pass_name recordFinalReviewFindings actually uses for shadow rows
  // ('final-review-shadow') — a replay test built on it would pass without
  // ever exercising the prune it claims to guard. The real, correctly-scoped
  // coverage (both 'final-review' and 'final-review-shadow', a genuinely
  // at-risk unruled absentee alongside a survivor) lives in
  // tests/final-review-replay-db.test.mjs.
});
