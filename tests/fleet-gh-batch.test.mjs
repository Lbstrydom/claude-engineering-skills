/**
 * @fileoverview lib/fleet/gh-batch.mjs — concurrent gh invocations from
 * synchronous code. The jobs here run `node -e` as the "gh" binary, so each
 * outcome (success, failure exit, timeout, missing binary) is deterministic.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { ghBatch } from '../scripts/lib/fleet/gh-batch.mjs';
import { OPEN_PR_CHECK_ARGS, OPEN_PR_LIST_ARGS, listPullRequests, spawnGh } from '../scripts/lib/fleet/gh-facts.mjs';
import { cleanupFleetRoots, installFakeGh, makeFleetRepo, prRow, scrubbedEnv } from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const node = process.execPath;
const js = (code) => ['-e', code];

describe('ghBatch', () => {
  test('returns spawnSync-shaped results per job, in order, each independent of the others', () => {
    const r = ghBatch(process.cwd(), [
      js('process.stdout.write("ok-1")'),
      js('process.stderr.write("HTTP 401: bad credentials"); process.exit(4)'),
      js('setTimeout(() => {}, 60000)'),
    ], { ghBin: node, timeoutMs: 1500 });
    assert.equal(r.length, 3);
    assert.deepEqual([r[0].status, r[0].stdout, r[0].error], [0, 'ok-1', undefined]);
    assert.deepEqual([r[1].status, r[1].stderr], [4, 'HTTP 401: bad credentials']);
    assert.equal(r[2].error?.code, 'ETIMEDOUT', 'a hung job times out alone');
  });

  test('a missing binary is ENOENT for each job (the code ghSpawnFailure reads as "gh not installed")', () => {
    const r = ghBatch(process.cwd(), [['pr', 'list'], ['pr', 'list']], { ghBin: path.join(process.cwd(), 'no-such-gh-binary'), timeoutMs: 5000 });
    assert.deepEqual(r.map((x) => x.error?.code), ['ENOENT', 'ENOENT']);
  });

  test('a SYNCHRONOUS spawn failure is the job\'s own error, not a crashed worker (R1-H4)', () => {
    // spawn('') throws before any timer exists; the job must settle with the spawn error rather than
    // take the whole worker down (which would turn every job into EBATCH).
    const r = ghBatch(process.cwd(), [['pr', 'list'], ['pr', 'list']], { ghBin: '', timeoutMs: 2000 });
    assert.equal(r.length, 2);
    for (const x of r) {
      assert.ok(x.error, 'each job reports an error');
      assert.notEqual(x.error.code, 'EBATCH', `the worker survived: ${x.error.message}`);
    }
  });

  test('a timed-out child is gone when its job settles, even one that ignores SIGTERM (R1-H5)', () => {
    const r = ghBatch(process.cwd(), [js('process.on("SIGTERM", () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)')], { ghBin: node, timeoutMs: 800 });
    assert.equal(r[0].error?.code, 'ETIMEDOUT');
    const pid = Number(r[0].stdout);
    assert.ok(pid > 0, 'the child reported its pid before timing out');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'no gh process outlives its resolved job');
  });

  test('the jobs really run concurrently', () => {
    const t0 = Date.now();
    ghBatch(process.cwd(), [0, 1, 2].map(() => js('setTimeout(() => {}, 900)')), { ghBin: node, timeoutMs: 10_000 });
    const ms = Date.now() - t0;
    assert.ok(ms < 2 * 900, `three 900 ms jobs took ${ms} ms — they ran one after another`);
  });

  test('a worker that cannot start fails every job as a spawn error, never as an empty answer', () => {
    const r = ghBatch(process.cwd(), [js('1'), js('1')], { ghBin: node, timeoutMs: 5000, env: { ...process.env, NODE_OPTIONS: '--require=./definitely-not-a-module.cjs' } });
    assert.deepEqual(r.map((x) => [x.status, x.error?.code]), [[null, 'EBATCH'], [null, 'EBATCH']]);
    assert.match(r[0].error.message, /gh batch worker/);
  });

  test('no jobs, no worker', () => {
    assert.deepEqual(ghBatch(process.cwd(), [], { timeoutMs: 1000 }), []);
  });
});

describe('prefetched answers are classified exactly like a direct call', () => {
  test('listPullRequests(prefetched) == listPullRequests(direct) against the fake gh', () => {
    const { root, repo } = makeFleetRepo();
    const fake = installFakeGh(root);
    fake.setState({ list: [prRow({ number: 5, branch: 'feat', headOid: '1'.repeat(40), baseOid: '2'.repeat(40) })] });
    const env = scrubbedEnv(fake.env, { prependPath: [fake.bin] });
    const direct = listPullRequests(repo, { env });
    const pre = ghBatch(repo, [OPEN_PR_LIST_ARGS(), OPEN_PR_CHECK_ARGS()], { env, timeoutMs: 30_000 });
    const viaPrefetch = listPullRequests(repo, { env, prefetched: { list: pre[0], checks: pre[1] } });
    const strip = (x) => JSON.stringify(x, (k, v) => (k === 'observedAt' ? undefined : v));
    assert.equal(direct.queried, true, direct.reason);
    assert.equal(direct.prs.length, 1);
    assert.equal(strip(viaPrefetch), strip(direct));
  });

  test('a failed prefetch is classified like the failed direct call', () => {
    const missing = { status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'spawn gh ENOENT' } };
    const r = listPullRequests(process.cwd(), { prefetched: { list: missing, checks: missing } });
    assert.deepEqual([r.queried, r.reason], [false, 'gh not installed']);
    const direct = spawnGh(process.cwd(), ['--version'], { ghBin: path.join(process.cwd(), 'no-such-gh-binary') });
    assert.equal(direct.error.code, missing.error.code, 'the batch reports the same code spawnSync does');
  });
});
