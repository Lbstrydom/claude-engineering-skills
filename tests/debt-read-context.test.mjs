/**
 * @fileoverview `resolveDebtReadContext` + `loadAuthoritativeDebt` — the
 * states a reporting CLI must never confuse (docs/plans/debt-readers-ask-store.md).
 *
 * The load-bearing one: store configured, repo identity unresolvable.
 * `selectEventSource` turns that into a LOCAL context, so the oracle's
 * `repo-identity-unresolved` branch was unreachable and a CLI printed the
 * cache's count under a store-shaped question. No store needed: the context
 * decision takes injected seams, and the oracle's CLOUD-without-repoId branch
 * returns before touching the store.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDebtReadContext, loadAuthoritativeDebt, EventSource } from '../scripts/lib/debt-memory.mjs';

const seams = ({ cloud = true, repo = { repoRowId: 'row-1' }, onInit = () => {} } = {}) => ({
  init: async () => { onInit(); },
  cloudEnabled: async () => cloud,
  resolveRepo: async () => { if (repo instanceof Error) throw repo; return repo; },
});

describe('resolveDebtReadContext', () => {
  test('store on + repo resolved → a CLOUD context carrying the repo row id', async () => {
    const ctx = await resolveDebtReadContext({}, seams());
    assert.deepEqual(ctx, { source: EventSource.CLOUD, canWrite: false, repoId: 'row-1' });
  });

  test('store on + repo UNRESOLVED stays CLOUD (no repoId) — never quietly LOCAL', async () => {
    for (const repo of [null, { repoRowId: null }, new Error('ECONNRESET')]) {
      const ctx = await resolveDebtReadContext({}, seams({ repo }));
      assert.equal(ctx.source, EventSource.CLOUD, `repo=${String(repo)}`);
      assert.equal(ctx.repoId, null);
    }
  });

  test('store off → LOCAL', async () => {
    const ctx = await resolveDebtReadContext({}, seams({ cloud: false }));
    assert.equal(ctx.source, EventSource.LOCAL);
  });

  test('--no-cloud → LOCAL without even initialising the store', async () => {
    let initialised = false;
    const ctx = await resolveDebtReadContext({ noCloud: true }, seams({ onInit: () => { initialised = true; } }));
    assert.equal(ctx.source, EventSource.LOCAL);
    assert.equal(initialised, false);
  });

  test('a store that fails to initialise degrades to whatever cloudEnabled reports, never throws', async () => {
    const ctx = await resolveDebtReadContext({}, { ...seams({ cloud: false }), init: async () => { throw new Error('boom'); } });
    assert.equal(ctx.source, EventSource.LOCAL);
  });
});

describe('loadAuthoritativeDebt — unresolved identity', () => {
  test('a CLOUD context without a repoId is unavailable: no entries, no count, no recurrence', async () => {
    const r = await loadAuthoritativeDebt({ source: EventSource.CLOUD, canWrite: false, repoId: null });
    assert.equal(r.source, 'unavailable');
    assert.equal(r.reason, 'repo-identity-unresolved');
    assert.deepEqual(r.entries, []);
    assert.equal(r.recurrenceMeasured, false);
  });

  test('end to end: an unresolved repo never reaches the local cache', async () => {
    const ctx = await resolveDebtReadContext({}, seams({ repo: null }));
    const r = await loadAuthoritativeDebt(ctx, { ledgerPath: 'definitely/not/read/tech-debt.json' });
    assert.equal(r.reason, 'repo-identity-unresolved', 'a local read would have said clean-checkout-sandbox');
  });
});
