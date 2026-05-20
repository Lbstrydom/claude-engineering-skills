/**
 * Transaction-client propagation + re-entrancy test (Gemini G3 / plan R15).
 *
 *  - Verifies that `withTx` runs every helper on the same checked-out
 *    `PoolClient` so `BEGIN`/work/`COMMIT` actually transact together.
 *  - Verifies rollback isolation — a thrown callback leaves zero rows
 *    behind in a temp table.
 *  - Verifies nested `withTx` joins the parent transaction via SAVEPOINT
 *    rather than checking out a second client (which would deadlock
 *    against AUDIT_DB_POOL_MAX=1).
 *
 * Env-gated: requires `AUDIT_DB_TEST_URL`. Skips cleanly when absent.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getPool, closePool, _resetForTest, getActiveTxClient } from '../scripts/lib/db/client.mjs';
import { query, many, one, insertReturning, withTx } from '../scripts/lib/db/query.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

// Force pool max=1 so a "checks out a second client" bug deadlocks the
// test (instead of merely "appearing to work"). Saved + restored around
// the suite so other env-gated tests don't inherit the cap.
let savedUrl, savedPoolMax;

const TMP_TABLE = 'db_withtx_test_tmp';

describe('withTx — re-entrant + auto-bind (G3)', { skip }, () => {
  before(async () => {
    await _resetForTest();
    savedUrl = process.env.AUDIT_DB_URL;
    savedPoolMax = process.env.AUDIT_DB_POOL_MAX;
    process.env.AUDIT_DB_URL = TEST_URL;
    process.env.AUDIT_DB_POOL_MAX = '1';

    // Build the pool, create the temp table once.
    const pool = await getPool();
    assert.ok(pool, 'pool must exist');
    await pool.query(`CREATE TABLE IF NOT EXISTS ${TMP_TABLE} (id SERIAL PRIMARY KEY, label TEXT NOT NULL)`);
  });

  after(async () => {
    const pool = await getPool();
    if (pool) {
      try { await pool.query(`DROP TABLE IF EXISTS ${TMP_TABLE}`); } catch { /* best-effort */ }
    }
    await closePool();
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
    else process.env.AUDIT_DB_URL = savedUrl;
    if (savedPoolMax === undefined) delete process.env.AUDIT_DB_POOL_MAX;
    else process.env.AUDIT_DB_POOL_MAX = savedPoolMax;
  });

  beforeEach(async () => {
    await query(`TRUNCATE ${TMP_TABLE} RESTART IDENTITY`);
  });

  it('commits when callback returns', async () => {
    await withTx(async () => {
      await insertReturning(TMP_TABLE, { label: 'committed' });
    });
    const rows = await many(`SELECT label FROM ${TMP_TABLE} ORDER BY id`);
    assert.deepEqual(rows.map((r) => r.label), ['committed']);
  });

  it('rolls back when callback throws', async () => {
    await assert.rejects(
      withTx(async () => {
        await insertReturning(TMP_TABLE, { label: 'rolled-back' });
        throw new Error('boom');
      }),
      /boom/
    );
    const row = await one(`SELECT COUNT(*)::int AS c FROM ${TMP_TABLE}`);
    assert.equal(row.c, 0, 'rollback must leave zero rows');
  });

  it('binds query helpers to the tx client automatically', async () => {
    // The temp table is only visible to the same client during BEGIN, so
    // the post-insert SELECT inside the same withTx must see the row.
    await withTx(async () => {
      await insertReturning(TMP_TABLE, { label: 'visible-in-tx' });
      const cnt = await one(`SELECT COUNT(*)::int AS c FROM ${TMP_TABLE}`);
      assert.equal(cnt.c, 1, 'mid-tx SELECT must see the just-inserted row on the same client');
    });
  });

  it('exposes the active tx client via getActiveTxClient()', async () => {
    let inside = null;
    let outside = getActiveTxClient();
    assert.equal(outside, null, 'no tx outside withTx');
    await withTx(async () => {
      inside = getActiveTxClient();
    });
    assert.ok(inside, 'tx client is exposed inside withTx');
    assert.equal(getActiveTxClient(), null, 'tx client is gone after withTx resolves');
  });

  it('nests via SAVEPOINT — outer commits, inner commits → both visible', async () => {
    await withTx(async () => {
      await insertReturning(TMP_TABLE, { label: 'outer' });
      await withTx(async () => {
        await insertReturning(TMP_TABLE, { label: 'inner' });
      });
    });
    const labels = (await many(`SELECT label FROM ${TMP_TABLE} ORDER BY id`)).map((r) => r.label);
    assert.deepEqual(labels, ['outer', 'inner']);
  });

  it('nested rollback only undoes the inner work — outer survives', async () => {
    await withTx(async () => {
      await insertReturning(TMP_TABLE, { label: 'outer' });
      await assert.rejects(
        withTx(async () => {
          await insertReturning(TMP_TABLE, { label: 'inner-doomed' });
          throw new Error('inner-boom');
        }),
        /inner-boom/
      );
      // Outer must still be in-flight + able to query state mid-tx.
      const cnt = await one(`SELECT COUNT(*)::int AS c FROM ${TMP_TABLE}`);
      assert.equal(cnt.c, 1, 'inner SAVEPOINT rolled back; outer row remains');
    });
    const labels = (await many(`SELECT label FROM ${TMP_TABLE} ORDER BY id`)).map((r) => r.label);
    assert.deepEqual(labels, ['outer']);
  });

  it('nested withTx does NOT deadlock on a pool with max=1', async () => {
    // The whole point of the SAVEPOINT path is to avoid a second checkout
    // when the pool is saturated. AUDIT_DB_POOL_MAX=1 makes that a hard
    // deadlock if the code regresses. We add a small overall timeout so
    // a regression fails the test fast instead of hanging CI.
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('nested withTx deadlocked on pool max=1')), 5000));
    const work = withTx(async () => {
      await insertReturning(TMP_TABLE, { label: 'L1' });
      await withTx(async () => {
        await insertReturning(TMP_TABLE, { label: 'L2' });
        await withTx(async () => {
          await insertReturning(TMP_TABLE, { label: 'L3' });
        });
      });
    });
    await Promise.race([work, timeout]);
    const labels = (await many(`SELECT label FROM ${TMP_TABLE} ORDER BY id`)).map((r) => r.label);
    assert.deepEqual(labels, ['L1', 'L2', 'L3']);
  });

  it('outer rollback discards every nested commit (savepoints are part of the outer tx)', async () => {
    await assert.rejects(
      withTx(async () => {
        await insertReturning(TMP_TABLE, { label: 'A' });
        await withTx(async () => {
          await insertReturning(TMP_TABLE, { label: 'B' });
        });
        throw new Error('outer-boom');
      }),
      /outer-boom/
    );
    const row = await one(`SELECT COUNT(*)::int AS c FROM ${TMP_TABLE}`);
    assert.equal(row.c, 0, 'outer ROLLBACK undoes the released savepoint too');
  });
});
