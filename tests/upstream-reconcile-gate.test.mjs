/**
 * @fileoverview `upstream reconcile --gate` (round-3 audit H5 compromise,
 * widened round-4 audit H3): --gate must block on EVERY divergence direction
 * the reconciler can report — a terminal db row missing from the ledger, a
 * ledger entry with no matching terminal db row, a state disagreement, a
 * disposition VALUE disagreement, or an unresolved migration catch-all
 * sentinel — not just the sentinel alone.
 *
 * `upstreamCmd` derives `repoRoot` from `process.cwd()` (not injectable via
 * ctx), so `upstreamReconcile` reads THIS repo's real, on-disk
 * `scripts/upstream-dispositions.json` as the ledger side of every
 * comparison here. A "clean baseline" mock therefore has to cover EVERY
 * real ledger entry with a matching db row (mocking only one entry would
 * make the other real entries read as `ledgerOnly` divergences) — built
 * once in `before()`, then each test perturbs a COPY of it.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { upstreamCmd } from '../scripts/lib/cross-skill/commands/quality.mjs';
import { formatDisposition } from '../scripts/lib/upstream/dispositions.mjs';

const LEDGER_PATH = path.resolve(import.meta.dirname, '..', 'scripts', 'upstream-dispositions.json');
let baselineRows, someFixedEntry;

before(() => {
  const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8'));
  assert.ok(parsed.entries.length > 0, 'the real ledger must have entries for these tests to use');
  baselineRows = parsed.entries.map((e) => ({
    issueId: e.issueId, state: e.state, disposition: formatDisposition(e.disposition),
  }));
  someFixedEntry = parsed.entries.find((e) => e.state === 'fixed');
  assert.ok(someFixedEntry, 'the real ledger must have at least one "fixed" entry for these tests to use');
});

function makeCtx({ boolFlags = new Set(), rows }) {
  return {
    verb: 'reconcile',
    cloud: { enabled: true },
    flag: () => null,
    hasFlag: (name) => boolFlags.has(name),
    resolveScope: async () => ({ kind: 'none' }),
    deps: {
      listTerminalUpstreamIssues: async () => ({ ok: true, cloud: true, rows }),
    },
  };
}

describe('upstream reconcile --gate', () => {
  it('does NOT throw when every db row exactly matches its real ledger entry (clean baseline)', async () => {
    const ctx = makeCtx({ boolFlags: new Set(['gate']), rows: baselineRows });
    const res = await upstreamCmd(ctx);
    assert.equal(res.ok, true);
  });

  it('throws (gates) on a terminal db row with NO matching ledger entry — missingFromLedger', async () => {
    const rows = [...baselineRows, { issueId: 'ffffffff-0000-0000-0000-000000000001', state: 'fixed', disposition: 'exempt:synthetic, not in the real ledger' }];
    const ctx = makeCtx({ boolFlags: new Set(['gate']), rows });
    await assert.rejects(() => upstreamCmd(ctx), (err) => {
      assert.equal(err.code, 'RECONCILE_NEEDS_REVIEW');
      assert.match(err.message, /no ledger entry/);
      return true;
    });
  });

  it('throws (gates) on a STATE mismatch between ledger and db', async () => {
    const flipped = 'wont_fix'; // the ledger recorded someFixedEntry.state ('fixed')
    const rows = baselineRows.map((r) => (r.issueId === someFixedEntry.issueId ? { ...r, state: flipped } : r));
    const ctx = makeCtx({ boolFlags: new Set(['gate']), rows });
    await assert.rejects(() => upstreamCmd(ctx), (err) => {
      assert.equal(err.code, 'RECONCILE_NEEDS_REVIEW');
      assert.match(err.message, /state mismatch/);
      return true;
    });
  });

  it('throws (gates) on a DISPOSITION VALUE mismatch between ledger and db', async () => {
    const rows = baselineRows.map((r) => (r.issueId === someFixedEntry.issueId
      ? { ...r, disposition: 'exempt:a completely different reason than the ledger has' }
      : r));
    const ctx = makeCtx({ boolFlags: new Set(['gate']), rows });
    await assert.rejects(() => upstreamCmd(ctx), (err) => {
      assert.equal(err.code, 'RECONCILE_NEEDS_REVIEW');
      assert.match(err.message, /disposition mismatch/);
      return true;
    });
  });

  it('throws (gates) when a terminal row still carries the migration catch-all sentinel', async () => {
    const rows = baselineRows.map((r) => (r.issueId === someFixedEntry.issueId
      ? { ...r, disposition: 'exempt:legacy-untracked-transition' }
      : r));
    const ctx = makeCtx({ boolFlags: new Set(['gate']), rows });
    await assert.rejects(() => upstreamCmd(ctx), (err) => {
      assert.equal(err.code, 'RECONCILE_NEEDS_REVIEW');
      assert.match(err.message, /catch-all sentinel/);
      return true;
    });
  });

  it('without --gate, a real divergence does NOT throw (worksheet remains advisory-only)', async () => {
    const rows = [...baselineRows, { issueId: 'ffffffff-0000-0000-0000-000000000001', state: 'fixed', disposition: 'exempt:synthetic, not in the real ledger' }];
    const ctx = makeCtx({ rows });
    const res = await upstreamCmd(ctx);
    assert.equal(res.ok, true);
    assert.equal(res.reconciliation.missingFromLedger.length, 1);
  });

  it('cloud off under --gate does not throw, but visibly warns rather than reading as a clean reconciliation (round-6 H6)', async () => {
    const ctx = {
      verb: 'reconcile',
      cloud: { enabled: false },
      flag: () => null,
      hasFlag: (name) => name === 'gate',
      resolveScope: async () => ({ kind: 'none' }),
      deps: {
        listTerminalUpstreamIssues: async () => ({ ok: true, cloud: false, rows: [] }),
      },
    };
    let warned = '';
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk, ...rest) => { warned += chunk; return origWrite.call(process.stderr, chunk, ...rest); };
    try {
      const res = await upstreamCmd(ctx);
      assert.equal(res.ok, true);
      assert.equal(res.reconciliation, null);
    } finally {
      process.stderr.write = origWrite;
    }
    assert.match(warned, /cloud is off.*NOT a verified-clean result/);
  });
});
