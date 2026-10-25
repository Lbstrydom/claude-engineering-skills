/**
 * @fileoverview `refreshRunAdjudicationCounts` against a real Postgres
 * (docs/plans/audit-round-cap-structural-or-stop.md §2.3, §9).
 *
 * What a mock cannot show:
 *   1. RUN SCOPING — two runs share a finding fingerprint with opposite rulings; refreshing either counts only its
 *      own (round-3 H1). `finding_adjudication_events.finding_id` is the run-scoped audit_findings.id, so the count
 *      reads that denormalised column `WHERE run_id = $1`.
 *   2. RUN-WIDE counts — rounds that share a run id SUM; they used to overwrite each other (the last round's slice won).
 *   3. NO STALE LAST WRITER — refresh A counts, B commits a newer ruling and refreshes, A writes. With the row lock B
 *      is blocked until A commits and then recounts; WITHOUT it (the control implementation below) B's fresh total is
 *      overwritten by A's stale one. Both implementations run through ONE oracle, and the harness supplies no lock of
 *      its own (round-3 M1).
 *   4. FAILURE keeps the previous aggregate: a refresh that fails writes nothing.
 *
 * INC-002: gated on `assertDisposableDbUrl`, never on "is AUDIT_DB_TEST_URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('refreshRunAdjudicationCounts (DB integration)', { skip }, () => {
  let q, store, repoId, savedUrl;
  const runs = [];

  before(async () => {
    const client = await import('../scripts/lib/db/client.mjs');
    savedUrl = process.env.AUDIT_DB_URL;
    client.assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    await client._resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    store = await import('../scripts/lib/store/run-aggregates.mjs');
    repoId = crypto.randomUUID();
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [repoId, `test-${repoId.slice(0, 8)}`]);
  });

  after(async () => {
    if (!q) return;
    for (const id of runs) {
      await q.query('DELETE FROM audit_findings WHERE run_id = $1', [id]);
      await q.query('DELETE FROM audit_runs WHERE id = $1', [id]);
    }
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = savedUrl;
  });

  async function newRun() {
    const id = crypto.randomUUID();
    runs.push(id);
    await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/test-fixture.md', 'plan')`, [id, repoId]);
    return id;
  }

  async function seed(runId, fp, outcome, round = 1) {
    return (await q.one(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, primary_file, detail_snapshot, round_raised, adjudication_outcome)
       VALUES ($1, $2, 'plan', 'HIGH', 'test', 'x.md', 'd', $3, $4) RETURNING id`, [runId, fp, round, outcome])).id;
  }

  const counts = (runId) => q.one('SELECT accepted_count, dismissed_count, labeled FROM audit_runs WHERE id = $1', [runId]);

  test('run scoping: two runs sharing a fingerprint with opposite rulings never see each other', async () => {
    const a = await newRun();
    const b = await newRun();
    const fp = `shared-${crypto.randomUUID().slice(0, 8)}`;
    await seed(a, fp, 'accepted');
    await seed(b, fp, 'dismissed');
    assert.deepEqual(await store.refreshRunAdjudicationCounts(a), { ok: true, accepted: 1, dismissed: 0 });
    assert.deepEqual(await store.refreshRunAdjudicationCounts(b), { ok: true, accepted: 0, dismissed: 1 });
    assert.deepEqual({ ...(await counts(a)) }, { accepted_count: 1, dismissed_count: 0, labeled: true });
    assert.deepEqual({ ...(await counts(b)) }, { accepted_count: 0, dismissed_count: 1, labeled: true });
  });

  test('run-wide: rounds sharing one run id sum instead of overwriting (per-row counts: a re-raise counts twice)', async () => {
    const run = await newRun();
    await seed(run, 'r1-a', 'accepted', 1);
    await seed(run, 'r1-b', 'accepted', 1);
    await seed(run, 'r2-a', 'dismissed', 2);
    await seed(run, 'r2-same-concern', 'accepted', 2);
    await seed(run, 'unruled', null, 2);
    const r = await store.refreshRunAdjudicationCounts(run);
    assert.deepEqual(r, { ok: true, accepted: 3, dismissed: 1 });
  });

  test('an unknown run, or a refresh that throws, writes nothing and keeps the previous aggregate', async () => {
    const run = await newRun();
    await seed(run, 'k1', 'accepted');
    await store.refreshRunAdjudicationCounts(run);
    const before = { ...(await counts(run)) };
    const res = await store.refreshRunAdjudicationCounts(run, { _afterCount: async () => { throw new Error('injected failure after the count'); } });
    assert.equal(res.ok, false);
    assert.deepEqual({ ...(await counts(run)) }, before, 'the failed refresh left the previous aggregate untouched');
    assert.equal((await store.refreshRunAdjudicationCounts(crypto.randomUUID())).ok, false);
  });

  /** The stale-last-writer schedule, parameterised by the implementation under test. */
  async function staleWriterSchedule(refresh) {
    const run = await newRun();
    const f1 = await seed(run, 'sw-1', 'accepted');
    const f2 = await seed(run, 'sw-2', null);
    let release;
    const gate = new Promise((r) => { release = r; });
    let counted;
    const countedP = new Promise((r) => { counted = r; });
    // Every wait in this schedule is bounded: a hung worker fails the test instead of hanging the suite.
    const bounded = (p, what) => {
      let timer;
      const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} did not happen within 10s`)), 10_000); });
      return Promise.race([p, limit]).finally(() => clearTimeout(timer));
    };

    // A has counted (1 accepted) but not yet written.
    const A = refresh(run, { _afterCount: async () => { counted(); await bounded(gate, 'the barrier release'); } });
    await bounded(countedP, 'refresh A reaching its post-count barrier');
    // A newer ruling commits, then B refreshes.
    await q.query(`UPDATE audit_findings SET adjudication_outcome = 'accepted' WHERE id = $1`, [f2]);
    let bDone = false;
    const B = refresh(run).then((r) => { bDone = true; return r; });
    // Deterministically learn whether B is blocked behind A's lock, or ran to completion on its own.
    let blocked = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !bDone) {
      const row = await q.one(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'`);
      if (row.n > 0) { blocked = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await bounded(Promise.all([A, B]), 'both refreshes completing');
    void f1;
    return { blocked, bFinishedBeforeA: bDone && !blocked, final: { ...(await counts(run)) } };
  }

  test('corrected implementation: B waits on A\'s row lock, then recounts — the aggregate includes both rulings', async () => {
    const r = await staleWriterSchedule(store.refreshRunAdjudicationCounts);
    assert.equal(r.blocked, true, 'B must be observed blocked on the run-row lock');
    assert.equal(r.final.accepted_count, 2);
  });

  test('control: a count-then-update WITHOUT the lock loses the newer ruling (the oracle distinguishes the two)', async () => {
    const naive = async (runId, { _afterCount } = {}) => {
      const c = await q.one(
        `SELECT count(*) FILTER (WHERE adjudication_outcome = 'accepted')::int AS accepted,
                count(*) FILTER (WHERE adjudication_outcome = 'dismissed')::int AS dismissed
           FROM audit_findings WHERE run_id = $1`, [runId]);
      if (_afterCount) await _afterCount(c);
      await q.updateWhere('audit_runs', { accepted_count: c.accepted, dismissed_count: c.dismissed, labeled: true }, { id: runId });
      return { ok: true };
    };
    const r = await staleWriterSchedule(naive);
    assert.equal(r.blocked, false, 'nothing serializes the unlocked implementation');
    assert.equal(r.final.accepted_count, 1, 'A\'s stale total overwrote B\'s fresh one — the defect the lock removes');
  });
});

describe('strict backlog readers on a real schema (DB integration)', { skip }, () => {
  let readers, savedUrl, client;
  before(async () => {
    client = await import('../scripts/lib/db/client.mjs');
    savedUrl = process.env.AUDIT_DB_URL;
    client.assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    await client._resetForTest?.();
    readers = await import('../scripts/lib/store/learning-decisions.mjs');
  });
  after(async () => {
    await client?.closePool();
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = savedUrl;
  });

  test('a repo with nothing recorded is an answered empty list (ok:true), not a failure', async () => {
    const id = crypto.randomUUID();
    assert.deepEqual(await readers.readOpenRecurringClusters({ repoId: id }), { ok: true, cloud: true, rows: [] });
    assert.deepEqual(await readers.readPendingTriageFindingsStrict({ repoId: id }), { ok: true, cloud: true, rows: [] });
  });

  test('a failing query is {ok:false} with the SQLSTATE — the lenient reader renders the same fault as []', async () => {
    const bad = await readers.readOpenRecurringClusters({ repoId: 'not-a-uuid' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /22P02/);
    const badTriage = await readers.readPendingTriageFindingsStrict({ repoId: 'not-a-uuid' });
    assert.equal(badTriage.ok, false);
    // The contrast that motivates the strict variants: the existing reader turns the same fault into an empty list.
    assert.deepEqual(await readers.readPendingTriageFindings({ repoId: 'not-a-uuid' }), []);
  });
});

describe('recordPastCap (DB integration)', { skip }, () => {
  let q, agg, repoId, savedUrl, client;
  const runs = [];
  before(async () => {
    client = await import('../scripts/lib/db/client.mjs');
    savedUrl = process.env.AUDIT_DB_URL;
    client.assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    await client._resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    agg = await import('../scripts/lib/store/run-aggregates.mjs');
    repoId = crypto.randomUUID();
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [repoId, `test-${repoId.slice(0, 8)}`]);
  });
  after(async () => {
    for (const id of runs) await q.query('DELETE FROM audit_runs WHERE id = $1', [id]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    await client.closePool();
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = savedUrl;
  });
  async function newRun() {
    const id = crypto.randomUUID();
    runs.push(id);
    await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/t.md', 'code')`, [id, repoId]);
    return id;
  }
  const row = (id) => q.one('SELECT past_cap_reason, past_cap_card FROM audit_runs WHERE id = $1', [id]);

  test('rounds sharing a run each keep their override: reasons append, cards merge by round, re-recording is a no-op', async () => {
    const run = await newRun();
    const r7 = await agg.recordPastCap(run, { reason: 'seventh round will converge: the cluster is fixed', card: { structural: 1, clusters: 3 }, round: 7 });
    const r8 = await agg.recordPastCap(run, { reason: 'eighth round is the last: only polish left', card: { structural: 0, clusters: 2 }, round: 8 });
    await agg.recordPastCap(run, { reason: 'seventh round will converge: the cluster is fixed', card: { structural: 1, clusters: 3 }, round: 7 });
    assert.equal(r7.ok, true);
    assert.equal(r8.ok, true);
    // first-wins for BOTH columns: re-recording round 7 with a DIFFERENT reason and card changes neither
    await agg.recordPastCap(run, { reason: 'a different seventh-round reason entirely', card: { structural: 9, clusters: 9 }, round: 7 });
    const got = await row(run);
    assert.equal(got.past_cap_reason, 'r7: seventh round will converge: the cluster is fixed\nr8: eighth round is the last: only polish left');
    assert.deepEqual(got.past_cap_card, { 7: { structural: 1, clusters: 3 }, 8: { structural: 0, clusters: 2 } });
  });

  test('a reason carrying newlines and its own "r8:" text cannot forge or hide a round boundary', async () => {
    const run = await newRun();
    await agg.recordPastCap(run, { reason: 'Follow-up plan:\nr8: review remaining issues', card: { structural: 0 }, round: 7 });
    await agg.recordPastCap(run, { reason: 'the genuine eighth round will converge', card: { structural: 1 }, round: 8 });
    const got = await row(run);
    assert.equal(got.past_cap_reason, 'r7: Follow-up plan: r8: review remaining issues\nr8: the genuine eighth round will converge');
    assert.deepEqual(Object.keys(got.past_cap_card).sort(), ['7', '8']);
  });

  test('an unknown run is reported, not claimed written', async () => {
    const r = await agg.recordPastCap(crypto.randomUUID(), { reason: 'a reason that is long enough', card: { structural: 0 }, round: 7 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-row');
  });
});
