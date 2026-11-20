/**
 * @fileoverview get-neighbourhood carries the active snapshot's coverage verdict.
 * An index that could not read the repo (0 symbols, `empty_universe`) must never
 * return the byte-identical "{records:[], hint:null}" a fully-indexed repo returns
 * when nothing is similar — that reads as "checked, go greenfield".
 *
 * Driven through the orchestrator with the normalizer and embedder injected, so
 * the assertions cover the paid steps too (nothing here touches a provider).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getNeighbourhoodForIntent, snapshotCoverage } from '../scripts/lib/neighbourhood-query.mjs';

const REFRESH = '00000000-0000-4000-8000-000000000001';
const args = { repoUuid: '00000000-0000-5000-8000-000000000001', targetPaths: [], intentDescription: 'add a retry helper' };

function harness(coverage, { wireReader = true, rpcRows = [] } = {}) {
  const calls = { embed: 0, normalize: 0, rpc: 0 };
  const adapters = {
    getRepoIdByUuid: async () => ({ id: 'repo-1' }),
    getActiveSnapshot: async () => ({ refreshId: REFRESH, activeEmbeddingModel: 'm', activeEmbeddingDim: 8 }),
    callNeighbourhoodRpc: async () => { calls.rpc++; return rpcRows; },
    normalizeIntent: async (t) => { calls.normalize++; return { text: t, mode: 'fallback', normalizerId: 'test' }; },
    embedIntent: async () => { calls.embed++; return { result: [0, 0, 0, 0, 0, 0, 0, 1] }; },
    ...(wireReader ? { getGraphCoverage: async () => coverage } : {}),
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nbhd-cov-'));
  return { adapters, calls, run: () => getNeighbourhoodForIntent(adapters, args, root) };
}

const cov = (status, reason, eligible) => ({ verdict: { status, reason }, extraction: { outcome: 'ok', eligible } });

describe('getNeighbourhoodForIntent — coverage verdict', () => {
  it('empty_universe: says nothing was compared, and runs neither the embedding nor the RPC', async () => {
    const h = harness(cov('unverified', 'empty_universe', 0));
    const out = await h.run();
    assert.equal(out.cloud, true);
    assert.deepEqual(out.coverage, { status: 'unverified', reason: 'empty_universe', eligible: 0 });
    assert.equal(out.records.length, 0);
    assert.match(out.hint, /compared nothing/);
    assert.match(out.hint, /NOT "no similar code"/);
    assert.deepEqual(h.calls, { embed: 0, normalize: 0, rpc: 0 });
  });

  it('CONTROL: another unverified reason still searches, and an empty result is flagged', async () => {
    const h = harness(cov('unverified', 'below_floor', 40));
    const out = await h.run();
    assert.equal(h.calls.rpc, 1);
    assert.equal(h.calls.embed, 1);
    assert.equal(out.coverage.reason, 'below_floor');
    assert.match(out.hint, /not evidence that no similar code exists/);
  });

  it('CONTROL: verified coverage with an empty result stays a clean "nothing similar" (no hint)', async () => {
    const h = harness(cov('verified', null, 120));
    const out = await h.run();
    assert.equal(h.calls.rpc, 1);
    assert.equal(out.hint, null);
    assert.equal(out.coverage.status, 'verified');
  });

  it('no measurement stored: unknown/not_measured, and an empty result is flagged', async () => {
    const h = harness(null);
    const out = await h.run();
    assert.deepEqual(out.coverage, { status: 'unknown', reason: 'not_measured', eligible: null });
    assert.match(out.hint, /not evidence/);
  });

  it('reader not wired: an explicit unknown, never a missing verdict', async () => {
    const h = harness(null, { wireReader: false });
    const out = await h.run();
    assert.equal(out.coverage.status, 'unknown');
    assert.equal(out.coverage.reason, 'coverage_reader_unavailable');
    assert.match(out.hint, /not evidence/);
  });
});

describe('injected normalizer semantics (the seam must behave like the `??` call it replaced)', () => {
  it('is called as a plain function: no receiver', async () => {
    const h = harness(cov('verified', null, 120));
    let receiver = 'unset';
    h.adapters.normalizeIntent = function (t) { receiver = this; return { text: t, mode: 'fallback', normalizerId: 'test' }; };
    await getNeighbourhoodForIntent(h.adapters, args, fs.mkdtempSync(path.join(os.tmpdir(), 'nbhd-cov-')));
    assert.equal(receiver, undefined);
  });
});

describe('snapshotCoverage', () => {
  const active = { refreshId: REFRESH };
  const repo = { id: 'repo-1' };

  it('maps a stored verdict', async () => {
    const c = await snapshotCoverage({ getGraphCoverage: async () => cov('verified', null, 12) }, active, repo);
    assert.deepEqual(c, { status: 'verified', reason: null, eligible: 12 });
  });
  it('a failing read is unknown, not a throw and not clean', async () => {
    const c = await snapshotCoverage({ getGraphCoverage: async () => { throw new Error('boom'); } }, active, repo);
    assert.equal(c.status, 'unknown');
  });
});

describe('a FAILED coverage read is not an ABSENT measurement', () => {
  const active = { refreshId: REFRESH };
  const repo = { id: 'repo-1' };
  const failing = (err) => ({ getGraphCoverage: async () => { throw err; } });

  it('a generic read failure is coverage_read_failed, distinct from not_measured', async () => {
    const c = await snapshotCoverage(failing(new Error('connection terminated')), active, repo);
    assert.deepEqual(c, { status: 'unknown', reason: 'coverage_read_failed', eligible: null });
  });

  it('a Postgres schema fault (42xxx) is named as one, and says so loudly on stderr', async () => {
    const lines = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { lines.push(String(s)); return true; };
    let c;
    try { c = await snapshotCoverage(failing(Object.assign(new Error('relation does not exist'), { code: '42P01' })), active, repo); }
    finally { process.stderr.write = orig; }
    assert.equal(c.reason, 'coverage_schema_fault');
    assert.match(lines.join(''), /SCHEMA fault/);
  });

  it('an unusable stored record is coverage_payload_invalid', async () => {
    const c = await snapshotCoverage(failing(Object.assign(new Error('x'), { code: 'COVERAGE_PAYLOAD_INVALID' })), active, repo);
    assert.equal(c.reason, 'coverage_payload_invalid');
  });

  it('CONTROL — a genuinely missing measurement is still not_measured (the four reasons are four different facts)', async () => {
    const c = await snapshotCoverage({ getGraphCoverage: async () => null }, active, repo);
    assert.equal(c.reason, 'not_measured');
    const reasons = new Set([
      (await snapshotCoverage(failing(new Error('x')), active, repo)).reason,
      (await snapshotCoverage(failing(Object.assign(new Error('x'), { code: '42703' })), active, repo)).reason,
      (await snapshotCoverage(failing(Object.assign(new Error('x'), { code: 'COVERAGE_PAYLOAD_INVALID' })), active, repo)).reason,
      c.reason,
    ]);
    assert.equal(reasons.size, 4);
  });

  it('the reader is asked to be STRICT (otherwise the store swallows the failure into null before we can see it)', async () => {
    let seen;
    await snapshotCoverage({ getGraphCoverage: async (...args) => { seen = args; return null; } }, active, repo);
    assert.deepEqual(seen[2], { strict: true });
  });

  it('an empty result over a failed read is still flagged as not evidence', async () => {
    const h = harness(null);
    h.adapters.getGraphCoverage = async () => { throw new Error('boom'); };
    const out = await h.run();
    assert.equal(out.coverage.reason, 'coverage_read_failed');
    assert.match(out.hint, /not evidence/);
  });
});
