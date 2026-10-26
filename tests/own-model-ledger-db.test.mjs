/**
 * @fileoverview Own-model decision ledger against a real Postgres
 * (docs/plans/own-model-decision-ledger.md; migration 20261027120000).
 *
 * Enrolled in scripts/db-test-container.mjs ISOLATED_SUITE_FILES AND
 * .github/workflows/postgres-parity.yml — two edits, always.
 * INC-002: gated on `assertDisposableDbUrl`, never on "is the URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('own_model_ledger (DB integration)', { skip }, () => {
  let q, store, prepare, wi;
  const tag = crypto.randomUUID().slice(0, 8);
  const repoName = `o/omlg-${tag}`;
  const NOW = new Date().toISOString();
  const ids = { items: [], repos: [] };

  const mkEvent = (over = {}, flag = true, ctx = {}) => {
    const raw = {
      kind: 'decision', coordinator: 'CES', actor: 'coordinator', event_at: NOW, work_item_id: wi.mintWorkItemId(),
      payload: { options: [{ id: 'wait', label: 'Wait', summary: 'detail' }, { id: 'go', label: 'Go' }], chosen_option_id: 'wait', rationale: 'why' },
      ...over,
    };
    const r = prepare.prepareLedgerEvent(raw, { repo: { id: null, name: repoName }, flag, purgeGeneration: 0, ...ctx });
    assert.ok(r.ok, r.reason);
    ids.items.push(r.event.work_item_id);
    return r.event;
  };
  const rows = (item) => q.many('SELECT * FROM own_model_ledger WHERE work_item_id = $1 ORDER BY event_at', [item]);

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    store = await import('../scripts/lib/store/own-model-ledger.mjs');
    prepare = await import('../scripts/lib/ledger/prepare.mjs');
    wi = await import('../scripts/lib/ledger/work-item.mjs');
  });

  after(async () => {
    if (!q) return;
    // ONE transaction, so the (transaction-local) bypass and the DELETE provably share a session.
    await q.withTx(async () => {
      await q.query("SELECT set_config('own_model.purge', 'on', true)");
      await q.query('DELETE FROM own_model_ledger WHERE repo_name = ANY($1::text[]) OR work_item_id = ANY($2::text[])', [[repoName, ids.repos7].filter(Boolean), ids.items]);
    });
    await q.query('DELETE FROM own_model_purge_barrier WHERE scope_value = ANY($1::text[])', [[...ids.items, repoName, ids.repos7].filter(Boolean)]);
    await q.query('DELETE FROM audit_runs WHERE work_item_id = ANY($1::text[])', [ids.items]);
    await q.query('DELETE FROM audit_repos WHERE id = ANY($1::uuid[])', [ids.repos]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  test('append-only: UPDATE and DELETE are refused by the trigger (negative control: the purge function succeeds)', async () => {
    const e = mkEvent();
    const res = await store.recordLedgerEvents([e]);
    assert.equal(res.receipts[0].state, 'persisted');
    await assert.rejects(q.query('UPDATE own_model_ledger SET actor = $1 WHERE event_id = $2', ['louis', e.event_id]), /append-only/);
    await assert.rejects(q.query('DELETE FROM own_model_ledger WHERE event_id = $1', [e.event_id]), /append-only/);
    assert.equal((await rows(e.work_item_id)).length, 1, 'both refusals left the row alone');
    const purged = await store.purgeLedger({ workItem: e.work_item_id });
    assert.equal(purged.deleted, 1);
    assert.equal((await rows(e.work_item_id)).length, 0);
  });

  test('idempotent: replaying the same event_id is a counted duplicate, never a second row', async () => {
    const e = mkEvent();
    assert.equal((await store.recordLedgerEvents([e])).receipts[0].state, 'persisted');
    assert.equal((await store.recordLedgerEvents([e])).receipts[0].state, 'duplicate');
    assert.equal((await rows(e.work_item_id)).length, 1);
  });

  test('default-deny: an omitted training_eligible is false, and a structural row can never be trainable', async () => {
    const e = mkEvent({}, true);
    await q.query(
      `INSERT INTO own_model_ledger (event_id, kind, coordinator, actor, event_at, schema_version, redaction_version, content_state, payload, repo_name)
       VALUES ($1, 'task', 'CES', 'system', now(), 1, 1, 'full', '{}', $2)`, [crypto.randomUUID(), repoName]);
    const row = await q.one('SELECT training_eligible FROM own_model_ledger WHERE repo_name = $1 AND kind = $2 ORDER BY id DESC LIMIT 1', [repoName, 'task']);
    assert.equal(row.training_eligible, false);
    await assert.rejects(q.query(
      `INSERT INTO own_model_ledger (event_id, kind, coordinator, actor, event_at, schema_version, redaction_version, content_state, training_eligible, payload)
       VALUES ($1, 'task', 'CES', 'system', now(), 1, 1, 'structural', true, '{}')`, [crypto.randomUUID()]), /structural_not_eligible/);
    void e;
  });

  test('a repo-false decision is stored structural: no option text, no rationale, anywhere in the row', async () => {
    const e = mkEvent({}, false);
    await store.recordLedgerEvents([e]);
    const [row] = await rows(e.work_item_id);
    assert.equal(row.content_state, 'structural');
    assert.equal(row.training_eligible, false);
    assert.deepEqual(row.payload, { options: [{ id: 'wait' }, { id: 'go' }], chosen_option_id: 'wait' });
    assert.ok(!JSON.stringify(row).includes('detail'));
  });

  test('the writer re-checks secrets: a hand-built event carrying a private key is refused', async () => {
    const e = mkEvent();
    const leaky = structuredClone(e);
    leaky.event_id = crypto.randomUUID();
    leaky.payload.rationale = 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 pasted';
    const r = await store.recordLedgerEvents([leaky]);
    assert.equal(r.receipts[0].state, 'refused');
    assert.match(r.receipts[0].reason, /secret-in-content|persisted/);
  });

  test('purge barrier: a pre-purge event is refused on replay (older generation), a current one is accepted, whatever the clocks say', async () => {
    const item = wi.mintWorkItemId(); ids.items.push(item);
    const old = mkEvent({ work_item_id: item });
    assert.equal((await store.recordLedgerEvents([old])).receipts[0].state, 'persisted');
    const { deleted, generation } = await store.purgeLedger({ workItem: item });
    assert.equal(deleted, 1);
    assert.ok(generation > 0);
    // Replay of the spooled copy (stamped with the old generation, an event_at far in the FUTURE to prove clocks are irrelevant):
    const replay = structuredClone(old); replay.event_at = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const r = await store.recordLedgerEvents([replay]);
    assert.deepEqual([r.receipts[0].state, r.receipts[0].reason], ['refused', 'purged-scope']);
    assert.equal((await rows(item)).length, 0, 'the purged rows did not come back');
    const fresh = mkEvent({ work_item_id: item }, true, { purgeGeneration: generation });
    assert.equal((await store.recordLedgerEvents([fresh])).receipts[0].state, 'persisted');
  });

  test('purge by repo records a repo barrier and removes the repo\'s rows', async () => {
    // its OWN repo name: a repo barrier is permanent for its scope, so it must not poison the other tests
    const repo7 = `o/omlg-purge-${tag}`; ids.repos7 = repo7;
    const ctx7 = { repo: { id: null, name: repo7 } };
    const e = mkEvent({}, true, ctx7);
    await store.recordLedgerEvents([e]);
    const { deleted, generation } = await store.purgeLedger({ repo: repo7 });
    assert.ok(deleted >= 1);
    const again = await store.recordLedgerEvents([mkEvent({}, true, { ...ctx7, purgeGeneration: generation - 1 })]);
    assert.equal(again.receipts[0].reason, 'purged-scope');
  });

  test('writer vs purge: purge WAITS for an in-flight writer batch (shared lock), and the late event is then refused', async () => {
    const { getPool } = await import('../scripts/lib/db/client.mjs');
    const pool = await getPool();
    const holder = await pool.connect();
    const item = wi.mintWorkItemId(); ids.items.push(item);
    let purgeDone = false;
    let purge;
    let committed = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock_shared(own_model_purge_lock_key())');   // an in-flight writer batch
      purge = store.purgeLedger({ workItem: item }).then((r) => { purgeDone = true; return r; });
      // Barrier, not a sleep: proceed only once the purge is OBSERVED waiting on the advisory lock.
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        // Identify the PURGE's wait by the lock key itself (classid = high 32 bits, objid = low 32 bits), not any ungranted advisory lock.
        const { rows: w } = await pool.query(
          `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
              AND classid = $1::oid AND objid = $2::oid LIMIT 1`,
          [String(7203948201234501n >> 32n), String(7203948201234501n & 0xffffffffn)]);
        waiting = w.length > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(waiting, 'the purge never reached the lock: the test would pass without proving anything');
      assert.equal(purgeDone, false, 'purge must not complete while a writer holds the shared lock');
      await holder.query('COMMIT');
      committed = true;
    } finally {
      // A failed assertion must not leave the transaction (and its shared lock) open to hang the purge and the suite.
      if (!committed) await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
    const res = await purge;
    assert.equal(purgeDone, true);
    const late = await store.recordLedgerEvents([mkEvent({ work_item_id: item })]);   // stamped generation 0
    assert.equal(late.receipts[0].reason, 'purged-scope');
    assert.ok(res.generation > 0);
  });

  test('deleting an audit_repos row neither fails on the trigger nor disturbs the ledger (no foreign key)', async () => {
    const repoId = crypto.randomUUID();
    await q.query('INSERT INTO audit_repos (id, name) VALUES ($1, $2)', [repoId, `omlg-repo-${tag}`]);
    ids.repos.push(repoId);
    const e = mkEvent();
    const withRepo = { ...e, repo_id: repoId };
    await store.recordLedgerEvents([withRepo]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const [row] = await rows(e.work_item_id);
    assert.equal(row.repo_id, repoId, 'the ledger keeps its own provenance');
  });

  test('cost view: each side aggregates alone (no fan-out), an item present in one source still appears', async () => {
    const w1 = wi.mintWorkItemId(), w2 = wi.mintWorkItemId(), w3 = wi.mintWorkItemId(); ids.items.push(w1, w2, w3);
    const usage = (w, cost, tin) => mkEvent({ kind: 'usage', work_item_id: w, actor: 'chip', payload: { source: 'chip', provider: 'anthropic', model: 'm', input_tokens: tin, output_tokens: 10, cost_usd: cost } });
    await store.recordLedgerEvents([usage(w1, 1.5, 100), usage(w1, 0.5, 200), usage(w2, 4, 1)]);
    const repo = crypto.randomUUID(); ids.repos.push(repo);
    await q.query('INSERT INTO audit_repos (id, name) VALUES ($1, $2)', [repo, `omlg-cost-${tag}`]);
    for (const [w, c] of [[w1, 0.25], [w1, 0.25], [w3, 7]]) {
      await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode, total_cost_estimate, work_item_id) VALUES ($1, $2, 'x.md', 'code', $3, $4)`, [crypto.randomUUID(), repo, c, w]);
    }
    const by = Object.fromEntries((await q.many('SELECT * FROM own_model_task_cost WHERE work_item_id = ANY($1::text[])', [[w1, w2, w3]])).map((r) => [r.work_item_id, r]));
    assert.deepEqual([Number(by[w1].usage_cost_usd), Number(by[w1].audit_cost_usd), Number(by[w1].total_cost_usd), Number(by[w1].usage_events), Number(by[w1].audit_runs)], [2, 0.5, 2.5, 2, 2]);
    assert.deepEqual([Number(by[w2].total_cost_usd), by[w2].audit_cost_usd, Number(by[w2].audit_runs)], [4, null, 0]);
    assert.deepEqual([Number(by[w3].total_cost_usd), by[w3].usage_cost_usd], [7, null]);
  });

  test('sweep candidates are keyed to the MERGED EVENT: a second PR on one work item never hides the first; one terminal observation per merge', async () => {
    const item = wi.mintWorkItemId(); ids.items.push(item);
    const long = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const mergedEv = (n) => mkEvent({ kind: 'outcome', work_item_id: item, actor: 'system', event_at: long, payload: { kind: 'merged', ref: `pr:${n}`, merge_sha: String(n).repeat(40).slice(0, 40) } });
    const a = mergedEv(1), b = mergedEv(2);
    await store.recordLedgerEvents([a, b]);
    const pending = () => store.listMergedAwaitingObservation({ olderThanDays: 7, limit: 1000 }).then((r) => r.filter((x) => x.work_item_id === item).map((x) => x.event_id).sort());
    assert.deepEqual(await pending(), [a.event_id, b.event_id].sort());
    const obs = (parent, kind, id) => mkEvent({ kind: 'outcome', work_item_id: item, actor: 'system', event_id: id, parent_event_id: parent, payload: { kind, ref: 'pr:1', observation_window_days: 7 } });
    const first = obs(a.event_id, 'observed-clean', wi.observationEventId(a.event_id));
    assert.equal((await store.recordLedgerEvents([first])).receipts[0].state, 'persisted');
    assert.equal((await store.recordLedgerEvents([first])).receipts[0].state, 'duplicate', 'a replayed or concurrent sweeper collapses on the deterministic id');
    const rival = obs(a.event_id, 'reverted', crypto.randomUUID());
    assert.equal((await store.recordLedgerEvents([rival])).receipts[0].state, 'duplicate', 'a different payload still cannot add a second terminal observation');
    assert.deepEqual(await pending(), [b.event_id], 'only the observed merge left the candidate set');
  });

  test('the CLI verbs reach a reachable store (cloud:true), not the cloud-off degrade', async () => {
    // A first cut read ctx.cloud.enabled, which is always false for a cloud:'none' registry entry, so every
    // store verb printed cloud:false against a live store. Spawned, with the DSN in the environment.
    const { spawnSync } = await import('node:child_process');
    const path = await import('node:path');
    const run = (...args) => {
      const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../scripts/cross-skill.mjs'), 'ledger', ...args],
        { encoding: 'utf8', env: { ...process.env, AUDIT_DB_URL: TEST_URL, AUDIT_DB_SSL_MODE: 'disable' } });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    const status = run('status');
    assert.equal(status.cloud, true);
    assert.ok(Array.isArray(status.store?.counts), JSON.stringify(status).slice(0, 200));
    const rollup = run('rollup', '--limit', '5');
    assert.equal(rollup.cloud, true);
    assert.ok(Array.isArray(rollup.rows));
  });

  test('sweep candidates can be restricted to ONE repository and carry their purge generation', async () => {
    const item = wi.mintWorkItemId(); ids.items.push(item);
    const other = `o/omlg-other-${tag}`; ids.repos7 = ids.repos7 ?? other;
    const long = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const mine = mkEvent({ kind: 'outcome', work_item_id: item, actor: 'system', event_at: long, payload: { kind: 'merged', ref: 'pr:1', merge_sha: '1'.repeat(40) } });
    const theirs = mkEvent({ kind: 'outcome', work_item_id: item, actor: 'system', event_at: long, payload: { kind: 'merged', ref: 'pr:2', merge_sha: '2'.repeat(40) } }, true, { repo: { id: null, name: other } });
    await q.query('SELECT 1');
    await store.recordLedgerEvents([mine, theirs]);
    const only = await store.listMergedAwaitingObservation({ olderThanDays: 7, limit: 1000, repoName });
    assert.ok(only.some((r) => r.event_id === mine.event_id));
    assert.ok(!only.some((r) => r.event_id === theirs.event_id), 'a merge from another repo must not be offered to this repo sweep');
    assert.equal(only.find((r) => r.event_id === mine.event_id).purge_generation, '0');
    await q.withTx(async () => { await q.query("SELECT set_config('own_model.purge', 'on', true)"); await q.query('DELETE FROM own_model_ledger WHERE repo_name = $1', [other]); });
  });

  test('status counts expose uncorrelated rows (NULL work item) per kind and content state', async () => {
    const e = mkEvent({ work_item_id: null });
    await store.recordLedgerEvents([e]);
    const counts = await store.readLedgerCounts();
    assert.ok(counts.some((c) => c.kind === 'decision' && c.uncorrelated >= 1));
  });
});
