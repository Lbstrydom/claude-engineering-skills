/**
 * @fileoverview `audit_pass_stats` post-deliberation writer + pass-timing reader
 * (scripts/lib/store/runs-findings.mjs), against injected fakes — no DB.
 *
 * Pins three store-queue findings (queue burn-down 2026-10-02):
 *  - an UNRESOLVED `round` probe (transient error on both attempts) must not be
 *    read as "un-migrated store": that branch's per-run fallback UPDATE matches
 *    EVERY round's row under run-unification, overwriting all of them;
 *  - a post-deliberation UPDATE that matched no row must not read as success;
 *  - `getPassTimings` aggregates in SQL rather than shipping every historical
 *    stats row into Node to compute a per-pass average.
 *
 * AUDIT_DB_URL is blanked BEFORE the import (the air-gap signal), so a code path
 * that ignored the injected fakes would see cloud-off rather than a real store.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUDIT_DB_URL = '';
const {
  updatePassStatsPostDeliberation, getPassTimings, _resetPassStatsRoundColumnCache,
} = await import('../scripts/lib/store/runs-findings.mjs');

const PROBE = /SELECT\s+"?round"?\s+FROM\s+audit_pass_stats\s+LIMIT 0/i;

/** A deps bundle whose `round` probe behaves as `probe` says, recording every UPDATE. */
function fakeDeps({ probe = 'present', maxRound = 3, rowCount = 1 } = {}) {
  const updates = [];
  return {
    updates,
    deps: {
      isCloudEnabled: async () => true,
      many: async (sql) => {
        if (!PROBE.test(sql)) throw new Error(`unexpected many(): ${sql}`);
        if (probe === 'present') return [];
        const err = new Error(probe === 'absent' ? 'column "round" does not exist' : 'connection terminated unexpectedly');
        err.code = probe === 'absent' ? '42703' : '57P01';
        throw err;
      },
      one: async () => ({ r: maxRound }),
      updateWhere: async (table, patch, where) => { updates.push({ table, patch, where }); return { rowCount }; },
    },
  };
}

const COUNTS = { structure: { accepted: 2, dismissed: 1, compromised: 0 } };

describe('updatePassStatsPostDeliberation', () => {
  beforeEach(() => _resetPassStatsRoundColumnCache());

  it('an UNRESOLVED round probe refuses the all-rounds fallback instead of overwriting every round', async () => {
    const { deps, updates } = fakeDeps({ probe: 'transient' });
    const res = await updatePassStatsPostDeliberation('run-1', COUNTS, deps);
    assert.deepEqual(updates, [], 'no UPDATE may run — the columnless WHERE would match every round of the run');
    assert.deepEqual(res, { updated: 0, attempted: 1, reason: 'round-probe-unresolved' });
  });

  it('NEGATIVE CONTROL: a CONFIRMED-absent round column still takes the per-run fallback', async () => {
    const { deps, updates } = fakeDeps({ probe: 'absent' });
    const res = await updatePassStatsPostDeliberation('run-1', COUNTS, deps);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].where, { run_id: 'run-1', pass_name: 'structure' });
    assert.deepEqual(res, { updated: 1, attempted: 1 });
  });

  it('scopes the write to the latest round when the column exists', async () => {
    const { deps, updates } = fakeDeps({ probe: 'present', maxRound: 4 });
    await updatePassStatsPostDeliberation('run-1', COUNTS, deps);
    assert.deepEqual(updates[0].where, { run_id: 'run-1', pass_name: 'structure', round: 4 });
  });

  it('a 0-row UPDATE is not counted as written', async () => {
    const { deps } = fakeDeps({ probe: 'present', rowCount: 0 });
    const res = await updatePassStatsPostDeliberation('run-1', COUNTS, deps);
    assert.deepEqual(res, { updated: 0, attempted: 1 });
  });
});

describe('getPassTimings', () => {
  it('aggregates per pass in SQL and keeps the per-row-average semantics', async () => {
    let seen = null;
    const deps = {
      isCloudEnabled: async () => true,
      // pg returns sum()/count() of bigint columns as strings.
      many: async (sql) => { seen = sql; return [{ pass_name: 'wiring', n: '3', total_in: '300', total_out: '31', total_lat: '1000' }]; },
    };
    const out = await getPassTimings(deps);
    assert.match(seen, /GROUP BY pass_name/i, 'the aggregate must happen in the database, not over every historical row in Node');
    assert.deepEqual(out, [{ passName: 'wiring', avgInputTokens: 100, avgOutputTokens: 10, avgLatencyMs: 333, runCount: 3 }]);
  });
});
