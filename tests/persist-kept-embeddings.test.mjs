/**
 * @fileoverview `persistKeptEmbeddings` (scripts/lib/store/runs-findings.mjs)
 * — the record-time writer that persists a kept finding's embedding so it
 * becomes a future semantic-dedup match target.
 *
 * Two REOPENED HIGH findings (GH issue #59, 2026-07-22), both fixed here:
 *
 *   1. Unverified write success — the INSERT...ON CONFLICT's resolved promise
 *      was treated as proof a row landed; `rowCount` was never checked, so an
 *      RLS-excluded or otherwise-0-row write looked identical to success.
 *   2. Missing tenant/run scoping — the write authorized solely by a bare
 *      `finding_id` UUID, with no predicate tying it back to the run (and
 *      therefore repo) that finding actually belongs to, in a store shared
 *      across multiple repos.
 *
 * The contract block below needs no DB (a fake `exec.query()` stands in for
 * the pg.Pool/PoolClient the real function receives). The integration block
 * proves the run-scoping predicate actually rejects a cross-run write at the
 * DB level — mirrors the env-gated pattern in final-review-adjudicate.test.mjs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { persistKeptEmbeddings } from '../scripts/lib/store/runs-findings.mjs';

const RUN_ID = 'run-aaaa';
const VEC = [0.1, 0.2, 0.3];

function makeFinding(hash, detail = 'boom') {
  return { _hash: hash, detail };
}

function fakeExec(queryImpl) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return queryImpl(sql, params, calls.length);
    },
  };
}

/** Capture process.stderr.write output for the duration of `fn`, restoring
 *  the real writer afterward even if `fn` throws. */
async function captureStderr(fn) {
  const original = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    process.stderr.write = original;
  }
}

describe('persistKeptEmbeddings — write-success verification + run scoping (contract, no DB)', () => {
  it('is exported for direct testing and returns {persisted, failed} counts', () => {
    assert.equal(typeof persistKeptEmbeddings, 'function');
  });

  it('returns {persisted:0, failed:0} and issues no query when there is nothing to persist', async () => {
    const exec = fakeExec(() => { throw new Error('should not be called'); });
    const out = await persistKeptEmbeddings(exec, [], null, new Map(), RUN_ID);
    assert.deepEqual(out, { persisted: 0, failed: 0 });
    assert.equal(exec.calls.length, 0);
  });

  it('a 0-rowCount UPSERT is counted as a failure AND logged (not silently treated as success)', async () => {
    const f = makeFinding('fp1');
    const exec = fakeExec(() => ({ rowCount: 0 }));
    const { result: out, lines } = await captureStderr(() => persistKeptEmbeddings(
      exec, [f], new Map([[f, VEC]]), new Map([['fp1', 'finding-id-1']]), RUN_ID));
    assert.deepEqual(out, { persisted: 0, failed: 1 });
    // A future implementation could increment `failed` while silently
    // dropping the operational signal — assert the log line actually fires,
    // carries the file's established `[semantic-suppress]` prefix, and names
    // the finding, not just the count.
    assert.ok(
      lines.some((l) => l.includes('[semantic-suppress]') && l.includes('finding-id-1') && l.includes('0 rows')),
      `expected a [semantic-suppress] 0-rows log line, got: ${JSON.stringify(lines)}`);
  });

  it('a 1-rowCount UPSERT is counted as persisted and logs nothing', async () => {
    const f = makeFinding('fp1');
    const exec = fakeExec(() => ({ rowCount: 1 }));
    const { result: out, lines } = await captureStderr(() => persistKeptEmbeddings(
      exec, [f], new Map([[f, VEC]]), new Map([['fp1', 'finding-id-1']]), RUN_ID));
    assert.deepEqual(out, { persisted: 1, failed: 0 });
    assert.equal(lines.length, 0, 'a clean persist must not log a failure line');
  });

  it('a thrown query error is caught, counted as failed, logged, and never propagates (best-effort)', async () => {
    const f = makeFinding('fp1');
    const exec = fakeExec(() => { throw new Error('connection reset'); });
    const { result: out, lines } = await captureStderr(() => persistKeptEmbeddings(
      exec, [f], new Map([[f, VEC]]), new Map([['fp1', 'finding-id-1']]), RUN_ID));
    assert.deepEqual(out, { persisted: 0, failed: 1 });
    assert.ok(
      lines.some((l) => l.includes('[semantic-suppress]') && l.includes('finding-id-1') && l.includes('connection reset')),
      `expected a [semantic-suppress] error log line, got: ${JSON.stringify(lines)}`);
  });

  it('mixed batch: a success and a 0-row failure are counted independently', async () => {
    const fOk = makeFinding('fp-ok');
    const fBad = makeFinding('fp-bad');
    const exec = fakeExec((sql, params) => (params[0] === 'id-ok' ? { rowCount: 1 } : { rowCount: 0 }));
    const idByFingerprint = new Map([['fp-ok', 'id-ok'], ['fp-bad', 'id-bad']]);
    const vectorByFinding = new Map([[fOk, VEC], [fBad, VEC]]);
    const out = await persistKeptEmbeddings(exec, [fOk, fBad], vectorByFinding, idByFingerprint, RUN_ID);
    assert.deepEqual(out, { persisted: 1, failed: 1 });
  });

  it('scopes every write through a run-owning predicate, not a bare finding_id equality', async () => {
    const f = makeFinding('fp1');
    const exec = fakeExec(() => ({ rowCount: 1 }));
    await persistKeptEmbeddings(
      exec, [f], new Map([[f, VEC]]), new Map([['fp1', 'finding-id-1']]), RUN_ID);
    assert.equal(exec.calls.length, 1);
    const { sql, params } = exec.calls[0];
    // A bare `INSERT ... VALUES (...)` keyed only on finding_id (the pre-fix
    // shape) would authorize the write regardless of which run — and
    // therefore which repo — the finding_id belongs to. The fix must join
    // back to audit_findings and constrain by run_id.
    assert.match(sql, /WHERE EXISTS/i);
    assert.match(sql, /FROM audit_findings/i);
    assert.match(sql, /run_id\s*=\s*\$6/);
    assert.equal(params[0], 'finding-id-1');
    assert.equal(params[5], RUN_ID, 'runId must be threaded through as the scoping parameter');
  });

  it('skips a finding with no vector or no resolved id, without querying', async () => {
    const fNoVec = makeFinding('fp-novec');
    const fNoId = makeFinding('fp-noid');
    const exec = fakeExec(() => ({ rowCount: 1 }));
    const out = await persistKeptEmbeddings(
      exec, [fNoVec, fNoId], new Map([[fNoId, VEC]]), new Map(), RUN_ID);
    assert.deepEqual(out, { persisted: 0, failed: 0 });
    assert.equal(exec.calls.length, 0);
  });
});

// ── Integration: prove the run-scoping predicate rejects a cross-run write ──

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('persistKeptEmbeddings — cross-run write rejection (integration)', { skip }, () => {
  let q, pool, repoA, repoB, runA, runB, findingA;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest, getPool } = await import('../scripts/lib/db/client.mjs');
    const savedUrl = process.env.AUDIT_DB_URL;
    // Refuses a production-identical DSN (the July 2026 wipe guard).
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    pool = await getPool();

    repoA = crypto.randomUUID();
    repoB = crypto.randomUUID();
    runA = crypto.randomUUID();
    runB = crypto.randomUUID();
    await q.query(
      `INSERT INTO audit_repos (id, name) VALUES ($1,$2),($3,$4)`,
      [repoA, `test-a-${repoA.slice(0, 8)}`, repoB, `test-b-${repoB.slice(0, 8)}`]);
    await q.query(
      // `plan_file` and `mode` are the two NOT NULL columns on audit_runs with no
      // default, so omitting them throws 23502. It read clean only because a
    // conflicting row skips the check — this passed on a re-used
      // check whenever the row already exists — so this passed on a re-used
      // container and failed on a fresh one. The suite was enrolled in no runner
      // until 2026-08-11, so neither case was ever observed.
      `INSERT INTO audit_runs (id, repo_id, plan_file, mode)
         VALUES ($1,$2,'docs/plans/test-fixture.md','code'),($3,$4,'docs/plans/test-fixture.md','code')`,
      [runA, repoA, runB, repoB]);
    const ins = await q.one(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category)
       VALUES ($1, $2, 'merged', 'HIGH', 'test') RETURNING id`,
      [runA, 'fp-embedtest']);
    findingA = ins.id;
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM audit_findings WHERE run_id = ANY($1)', [[runA, runB]]);
    await q.query('DELETE FROM audit_runs WHERE id = ANY($1)', [[runA, runB]]);
    await q.query('DELETE FROM audit_repos WHERE id = ANY($1)', [[repoA, repoB]]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  it('rejects an embedding write scoped to a run the finding does NOT belong to', async () => {
    const f = { _hash: 'fp-embedtest', detail: 'x' };
    const vec = new Array(768).fill(0.01);
    const out = await persistKeptEmbeddings(
      pool, [f], new Map([[f, vec]]), new Map([['fp-embedtest', findingA]]), runB /* wrong run/repo */);
    assert.deepEqual(out, { persisted: 0, failed: 1 });
    const row = await q.one('SELECT finding_id FROM finding_embeddings WHERE finding_id = $1', [findingA]);
    assert.equal(row, null, 'a cross-run write must not land any row');
  });

  it('persists when scoped to the run the finding actually belongs to', async () => {
    const f = { _hash: 'fp-embedtest', detail: 'x' };
    const vec = new Array(768).fill(0.01);
    const out = await persistKeptEmbeddings(
      pool, [f], new Map([[f, vec]]), new Map([['fp-embedtest', findingA]]), runA /* correct run */);
    assert.deepEqual(out, { persisted: 1, failed: 0 });
    const row = await q.one('SELECT finding_id FROM finding_embeddings WHERE finding_id = $1', [findingA]);
    assert.ok(row, 'the correctly-scoped write must land');
  });
});
