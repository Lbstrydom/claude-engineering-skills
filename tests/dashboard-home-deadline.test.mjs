/**
 * @fileoverview The Home composer's execution bounds and aggregate semantics:
 * a card that blocks SYNCHRONOUSLY for 10x its deadline is cut at the deadline (its
 * worker terminated) while the other cards still return; an async card's child is
 * killed and reaped on abort; the aggregate `sources.home` follows the plan's rule
 * and the build's existing exit rule; and `homeContentProjection` strips provenance
 * only.
 *
 * `Promise.race` against a timer is NOT a deadline for synchronous work — the
 * marker-file assertion below is what separates a real terminate from a race that
 * merely stopped waiting.
 *
 * Plan: docs/plans/dashboard-home-summary.md §2 (Deadline and cancellation), §9.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { git } from './helpers/git.mjs';
import {
  collectHome, withDeadline, aggregateSources, homeContentProjection,
} from '../scripts/lib/dashboard/collect-home.mjs';
import { execReader } from '../scripts/lib/store/backlog-gather.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dashboard-home', 'store-unreachable-envelopes.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dirs = [];
function tmp(prefix = 'home-deadline-') {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } } });
const write = (dir, rel, body) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };

const OK_ENV = {
  q1: { ok: true, cloud: true, measured: true, scope: { mode: 'repo' }, byMode: { total: 3, code: 2, plan: 1 }, agedOut: 0 },
  q2: { ok: true, cloud: true, measured: true, scope: { mode: 'repo' }, total: 4, byMode: { total: 4, code: 3, plan: 1 }, byDisposition: { acceptedPermanent: 1 } },
  q3: { state: 'ready', cloud: true, counts: { totalActionable: 5 } },
  upstream: { ok: true, cloud: true, rows: [], total: 0 },
  debt: { ok: true, verdict: 'measured', cloudTotal: 6, localTotal: 7, undrainedSpills: 0 },
};
const readerOf = ({ script, args }) => (path.basename(script) === 'debt-reconcile.mjs' ? 'debt'
  : args[0] === 'list-unlocked-fixes' ? 'q1' : args[0] === 'list-unremediated-acceptances' ? 'q2'
    : args[0] === 'final-review-pending' ? 'q3' : 'upstream');
const okRun = async (a) => ({ exitCode: 0, stdout: JSON.stringify(OK_ENV[readerOf(a)]), aborted: false });
const replayRun = (mode) => async (a) => {
  const c = FIXTURE.captures.find((x) => x.reader === readerOf(a) && x.mode === mode);
  return { exitCode: c.exitCode, stdout: JSON.stringify(c.envelope), aborted: false };
};

/** A throwaway SOURCE-shaped repo: AGENTS.md, status.md, a heartbeat, one consumer-style receipt of its own. */
function mkHomeRepo() {
  const repo = tmp();
  git(['init', '-q', '-b', 'main'], repo);
  for (const [k, v] of Object.entries({ 'user.email': 't@example.com', 'user.name': 'T', 'commit.gpgsign': 'false', 'core.autocrlf': 'false' })) git(['config', k, v], repo);
  write(repo, 'AGENTS.md', '# AGENTS\nshort\n');
  write(repo, 'status.md', '## 2026-10-06 — shipped a thing\n\nBacklog 2026-10-05T10:00Z: Q1 2c/1p (+0 aged) · Q2 3c/1p (1 perm) · Q3 5 · debt 6 cloud/7 local (0 spilled) · upstream 0\n');
  write(repo, '.audit-loop/last-maintenance.json', JSON.stringify({ lastRunAt: '2026-10-05T12:00:00Z', results: [] }));
  write(repo, '.sync-receipt.json', JSON.stringify({ version: 2, olderSyncsDropped: 0, recentSyncs: [{ syncedAt: '2026-10-05T08:00:00Z', source: { repo: 'o/s', branch: 'main', commitSha: 'c'.repeat(40), sourceDirty: false } }] }));
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  return repo;
}
const HOME_OPTS = (extra = {}) => ({
  run: okRun, repo: 'owner/repo', plans: { active: [], completed: [] }, skills: new Array(17).fill({}), isSource: false, now: new Date('2026-10-06T12:00:00Z'), ...extra,
});

describe('withDeadline', () => {
  test('a value, an error and a timeout are all RESOLVED (it never rejects), and the cancel hooks run on timeout only', async () => {
    assert.deepEqual(await withDeadline('a', 1000, async () => 7), { value: 7 });
    const e = await withDeadline('b', 1000, async () => { throw new Error('boom'); });
    assert.equal(e.error.message, 'boom');
    let cancelled = 0; let aborted = false;
    const t = await withDeadline('c', 50, (ctx) => new Promise(() => { ctx.onCancel(() => { cancelled += 1; }); ctx.signal.addEventListener('abort', () => { aborted = true; }); }), { settleMs: 60 });
    assert.deepEqual(t, { timedOut: true, ms: 50, released: false, cancelErrors: [], settled: null }, 'work that never winds down is reported UNRELEASED, not assumed released');
    assert.equal(cancelled, 1);
    assert.equal(aborted, true);
    let ranOnSuccess = 0;
    await withDeadline('d', 1000, async (ctx) => { ctx.onCancel(() => { ranOnSuccess += 1; }); return 1; });
    assert.equal(ranOnSuccess, 0);
  });
});

describe('M7: cancellation is awaited and its failure is surfaced', () => {
  test('a cancel hook that throws or rejects is reported in cancelErrors, never swallowed; the others still run', async () => {
    let ran = 0;
    const t = await withDeadline('x', 30, (ctx) => new Promise(() => {
      ctx.onCancel(() => { throw new Error('sync cancel failure'); });
      ctx.onCancel(() => Promise.reject(new Error('async cancel failure')));
      ctx.onCancel(() => { ran += 1; });
    }), { settleMs: 30 });
    assert.equal(ran, 1);
    assert.deepEqual(t.cancelErrors.sort(), ['async cancel failure', 'sync cancel failure']);
  });

  test('a hook that settles inside the settle window IS awaited: the result is not resolved before it finished', async () => {
    let finished = false;
    const t = await withDeadline('x', 20, (ctx) => new Promise(() => { ctx.onCancel(() => new Promise((r) => setTimeout(() => { finished = true; r(); }, 60))); }), { settleMs: 400 });
    assert.equal(finished, true);
    assert.equal(t.timedOut, true);
  });

  test('a hook that never settles cannot stall the deadline: it is cut at settleMs and reported (audit H1/H3)', async () => {
    const started = Date.now();
    const t = await withDeadline('x', 20, (ctx) => new Promise(() => { ctx.onCancel(() => new Promise(() => {})); }), { settleMs: 60 });
    const took = Date.now() - started;
    assert.equal(t.timedOut, true);
    assert.equal(t.released, false, 'a deadline result never claims a release that was not observed');
    assert.ok(t.cancelErrors.includes('cancellation hook did not settle'), JSON.stringify(t.cancelErrors));
    // deadline 20 ms + ONE settle window of 60 ms (shared by the hook wait and the wind-down wait), with slack for CI.
    assert.ok(took < 400, `the wait must be bounded by one settle window, took ${took} ms`);
  });

  test('work that winds down after the abort is released, and its own settled result is carried', async () => {
    const t = await withDeadline('x', 20, (ctx) => new Promise((resolve) => { ctx.signal.addEventListener('abort', () => setTimeout(() => resolve('wound down'), 30)); }), { settleMs: 1000 });
    assert.deepEqual([t.timedOut, t.released, t.settled], [true, true, { value: 'wound down' }]);
  });

  test('collectHome says so when a unit did not stop: "stop not confirmed" and the cancellation error in the detail', async () => {
    const { home } = await collectHome(mkHomeRepo(), HOME_OPTS({
      deadlineMs: 50, settleMs: 40,
      collectors: { queues: (ctx) => new Promise(() => { ctx.onCancel(() => { throw new Error('child would not die'); }); }) },
    }));
    const d = home.cards.queues.measurements[0].detail;
    assert.match(d, /timed out after 50ms/);
    assert.match(d, /stop not confirmed/);
    assert.match(d, /cancellation failed: child would not die/);
  });
});

describe('a synchronous block is cut at the deadline (worker terminated), the other cards still return', () => {
  const DEADLINE = 400;
  const BLOCK = DEADLINE * 10; // 10x, as the plan specifies

  for (const BLOCKED of ['inflight', 'vitals']) test(`collectHome: the blocked ${BLOCKED} card is missing-optional "timed out", the rest are intact, and the worker really died`, async () => {
    const dir = tmp();
    const marker = path.join(dir, 'worker-finished-blocking.txt');
    const workerFile = path.join(dir, 'blocking-worker.mjs');
    fs.writeFileSync(workerFile, `
import { workerData, parentPort } from 'node:worker_threads';
import fs from 'node:fs';
const card = workerData.card;
if (card === ${JSON.stringify(BLOCKED)}) {
  const end = Date.now() + ${BLOCK};
  while (Date.now() < end) { /* a synchronous block: no event-loop turn, no timer can fire here */ }
  fs.writeFileSync(${JSON.stringify(marker)}, 'finished');
}
const m = (id, card, value) => ({ id, label: id, card, value, status: 'ok', asOf: null, source: 's', detail: '' });
const VITALS = ['agents-size', 'plans', 'skills', 'maintenance'].map((id) => m(id, 'vitals', id === 'agents-size' ? { chars: 1, cap: 100 } : id === 'plans' ? { inProgress: 0, total: 0, plans: [] } : id === 'skills' ? { count: 17, roster: 17 } : { lastRunAt: 'x', windowDays: 7, overdueDays: 0 }));
const result = card === 'vitals' ? { card, measurements: VITALS } : card === 'consumers' ? { card, measurements: [m('consumers', 'consumers', { mode: 'consumer', syncedAt: null, sha7: null })] }
  : card === 'shipped-merges' ? m('shipped-merges', 'shipped', { branch: 'main', subjects: [] })
  : m('inflight', 'inflight', { rows: [], more: 0, total: 0 });
parentPort.postMessage({ ok: true, result });
`);
    const repo = mkHomeRepo();
    const t0 = Date.now();
    const { home, sources } = await collectHome(repo, HOME_OPTS({ deadlineMs: DEADLINE, workerUrl: pathToFileURL(workerFile) }));
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < BLOCK / 2, `cut at the deadline, not after the block: ${elapsed}ms vs a ${BLOCK}ms block`);
    const blocked = BLOCKED === 'inflight' ? home.cards.inflight.measurements[0] : home.cards.vitals.measurements[0];
    assert.equal(blocked.status, 'missing-optional');
    assert.match(blocked.detail, /timed out after 400ms/);
    assert.equal(home.cards.consumers.measurements[0].status, 'ok', 'the other worker card returned');
    assert.equal(home.cards.shipped.measurements.find((x) => x.id === 'shipped-merges').status, 'ok');
    assert.ok(home.cards.queues.measurements.every((x) => x.status === 'ok'), 'the async card returned');
    assert.equal(sources.home.status, 'missing-optional', 'a timeout is an expected absence, not a defect');
    if (BLOCKED === 'inflight') assert.equal(home.cards.vitals.status, 'ok');
    else assert.equal(home.cards.inflight.measurements[0].status, 'ok');

    // The worker must have been TERMINATED, not merely abandoned: wait past the block and look for its marker.
    await sleep(BLOCK - elapsed + 700);
    assert.equal(fs.existsSync(marker), false, 'a worker that outlived the deadline would have written this');
  });

  test('a worker that exits without reporting is a defect (unexpected-error), not a hang', async () => {
    const dir = tmp();
    const workerFile = path.join(dir, 'silent-worker.mjs');
    fs.writeFileSync(workerFile, "import { workerData, parentPort } from 'node:worker_threads';\nif (workerData.card === 'inflight') process.exit(3);\nif (workerData.card === 'vitals') { parentPort.postMessage({ ok: true, result: { measurements: ['agents-size', 'plans', 'skills', 'maintenance'].map((id) => ({ id, label: id, card: 'vitals', status: 'ok', value: null, asOf: null, source: 's', detail: '' })) } }); } else\nparentPort.postMessage({ ok: true, result: { measurements: [{ id: workerData.card, label: 'x', card: workerData.card === 'consumers' ? 'consumers' : 'shipped', status: 'ok', value: workerData.card === 'consumers' ? { mode: 'consumer', syncedAt: null, sha7: null } : { branch: 'main', subjects: [] }, asOf: null, source: 's', detail: '' }] } });\n");
    const { home } = await collectHome(mkHomeRepo(), HOME_OPTS({ deadlineMs: 5000, workerUrl: pathToFileURL(workerFile) }));
    const m = home.cards.inflight.measurements[0];
    assert.equal(m.status, 'unexpected-error');
    assert.match(m.detail, /without reporting|exited/);
  });
});

describe('an aborted async card releases its child', () => {
  test('the queue reader child is killed and reaped when the deadline fires', async () => {
    const dir = tmp();
    const pidFile = path.join(dir, 'pid.txt');
    const sleeper = path.join(dir, 'sleeper.mjs');
    fs.writeFileSync(sleeper, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 120000);\n`);
    const run = (a) => execReader({ ...a, script: sleeper, args: [] });
    const repo = mkHomeRepo();
    const { home } = await collectHome(repo, HOME_OPTS({ run, deadlineMs: 800 }));
    assert.ok(home.cards.queues.measurements.every((x) => x.status === 'missing-optional'), 'timed-out readers are an expected absence');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    let alive = true;
    for (let i = 0; i < 40 && alive; i += 1) {
      try { process.kill(pid, 0); await sleep(100); } catch { alive = false; }
    }
    assert.equal(alive, false, `child ${pid} must not outlive the abort`);
  });
});

describe('aggregate sources.home and the build exit rule', () => {
  // The build's own predicate (scripts/build-dashboard.mjs `isDegraded`): invalid | unexpected-error => non-zero.
  const degraded = (sources) => Object.values(sources).some((s) => s.status === 'invalid' || s.status === 'unexpected-error');

  test('the rule this suite mirrors is really the one in build-dashboard.mjs', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-dashboard.mjs'), 'utf8');
    assert.match(src, /s\.status === 'invalid' \|\| s\.status === 'unexpected-error'/);
  });

  test('every card ok: sources.home ok, build not degraded', async () => {
    const { sources } = await collectHome(mkHomeRepo(), HOME_OPTS());
    assert.deepEqual(sources.home, { status: 'ok', detail: '' });
    assert.equal(degraded(sources), false);
  });

  test('store unreachable (REAL capture replayed): missing-optional, and the BUILD DOES NOT FAIL', async () => {
    const { home, sources } = await collectHome(mkHomeRepo(), HOME_OPTS({ run: replayRun('closed-port') }));
    assert.equal(sources.home.status, 'missing-optional');
    assert.match(sources.home.detail, /queues/);
    assert.equal(degraded(sources), false);
    assert.equal(home.health.filter((c) => c.id.startsWith('queue-') && c.state === 'unmeasured').length, 5);
    assert.equal(home.needs.headline, null, 'unmeasured queues forbid "Nothing needs you"');
    assert.ok(home.health.every((c) => !(c.state === 'ok' && c.measured === false)));
  });

  test('a broken reader: unexpected-error naming the card, and the BUILD FAILS', async () => {
    const run = async (a) => (readerOf(a) === 'q2' ? { exitCode: 1, stdout: 'Error: Cannot find module\n', aborted: false } : okRun(a));
    const { sources } = await collectHome(mkHomeRepo(), HOME_OPTS({ run }));
    assert.equal(sources.home.status, 'unexpected-error');
    assert.match(sources.home.detail, /failing: queues/);
    assert.equal(degraded(sources), true);
  });

  test('a schema fault from a reader is a defect too', async () => {
    const run = async (a) => (readerOf(a) === 'q1'
      ? { exitCode: 2, stdout: JSON.stringify({ ok: false, error: { code: '42P01', message: 'relation missing' } }), aborted: false } : okRun(a));
    const { home, sources } = await collectHome(mkHomeRepo(), HOME_OPTS({ run }));
    assert.equal(home.cards.queues.measurements.find((x) => x.id === 'queue-q1').kind, 'schema-fault');
    assert.equal(degraded(sources), true);
  });

  test('a thrown collector degrades its own card only', async () => {
    const { home, sources } = await collectHome(mkHomeRepo(), HOME_OPTS({ collectors: { queues: async () => { throw new Error('queue module exploded'); } } }));
    assert.ok(home.cards.queues.measurements.every((x) => x.status === 'unexpected-error' && /queue module exploded/.test(x.detail)));
    assert.equal(home.cards.vitals.status, 'ok');
    assert.equal(home.cards.shipped.status, 'ok');
    assert.equal(sources.home.status, 'unexpected-error');
  });

  test('a malformed collector result is refused, not trusted', async () => {
    const { home } = await collectHome(mkHomeRepo(), HOME_OPTS({ collectors: { vitals: async () => ({ measurements: [{ nope: true }] }) } }));
    assert.ok(home.cards.vitals.measurements.every((x) => x.status === 'unexpected-error' && /malformed/.test(x.detail)));
  });

  test('aggregateSources is a pure function of card statuses', () => {
    const c = (status) => ({ status });
    assert.deepEqual(aggregateSources({ a: c('ok'), b: c('ok') }), { status: 'ok', detail: '' });
    assert.equal(aggregateSources({ a: c('ok'), b: c('missing-optional') }).status, 'missing-optional');
    assert.equal(aggregateSources({ a: c('missing-optional'), b: c('unexpected-error') }).status, 'unexpected-error');
    assert.equal(aggregateSources({ a: c('invalid') }).status, 'unexpected-error');
    assert.match(aggregateSources({ q: { id: 'q', status: 'unexpected-error' }, v: { id: 'v', status: 'missing-optional' } }).detail, /failing: q \(unexpected-error\)/);
  });
});

describe('homeContentProjection', () => {
  test('two builds differing only in timestamps project identically; a changed queue count does not', async () => {
    const repo = mkHomeRepo();
    const a = (await collectHome(repo, HOME_OPTS({ now: new Date('2026-10-06T12:00:00Z') }))).home;
    const b = (await collectHome(repo, HOME_OPTS({ now: new Date('2026-10-06T12:03:41Z') }))).home;
    assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'the raw homes DO differ (asOf, builtAt, durations)');
    assert.equal(JSON.stringify(homeContentProjection(a)), JSON.stringify(homeContentProjection(b)));

    const changedRun = async (x) => (readerOf(x) === 'q2' ? { exitCode: 0, stdout: JSON.stringify({ ...OK_ENV.q2, total: 5, byMode: { total: 5, code: 4, plan: 1 } }), aborted: false } : okRun(x));
    const c = (await collectHome(repo, HOME_OPTS({ run: changedRun }))).home;
    assert.notEqual(JSON.stringify(homeContentProjection(a)), JSON.stringify(homeContentProjection(c)));
  });

  test('NEGATIVE CONTROL: a projection that does not strip timestamps sees the two builds as different', async () => {
    const repo = mkHomeRepo();
    const a = (await collectHome(repo, HOME_OPTS({ now: new Date('2026-10-06T12:00:00Z') }))).home;
    const b = (await collectHome(repo, HOME_OPTS({ now: new Date('2026-10-06T12:03:41Z') }))).home;
    const identity = (h) => JSON.parse(JSON.stringify(h));
    assert.notEqual(JSON.stringify(identity(a)), JSON.stringify(identity(b)));
  });

  test('strips only provenance keys, at any depth, and does not mutate its input', () => {
    const home = { builtAt: 't', durations: { q: 1 }, cards: { x: { measurements: [{ id: 'a', asOf: 't', observedAt: 't', durationMs: 5, value: 1, syncedAt: 'keep', previousAt: 'keep' }] } } };
    const copy = JSON.parse(JSON.stringify(home));
    assert.deepEqual(homeContentProjection(home), { cards: { x: { measurements: [{ id: 'a', value: 1, syncedAt: 'keep', previousAt: 'keep' }] } } });
    assert.deepEqual(home, copy);
  });
});

describe('a full collectHome run against a throwaway repo with fakes', () => {
  test('completes quickly and every card is present', async () => {
    const t0 = Date.now();
    const { home } = await collectHome(mkHomeRepo(), HOME_OPTS());
    const ms = Date.now() - t0;
    process.stderr.write(`  [measured] collectHome against fakes: ${ms}ms\n`);
    assert.deepEqual(Object.keys(home.cards).sort(), ['consumers', 'inflight', 'queues', 'shipped', 'vitals']);
    assert.ok(ms < 30_000, `took ${ms}ms`);
    assert.equal(home.health.length, 10);
  });
});
