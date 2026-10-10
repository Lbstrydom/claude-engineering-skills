/**
 * @fileoverview The Home card collectors against throwaway git repos and a faked
 * queue runner — nothing here touches the real store, the user's registry or a real
 * consumer. Consumer names are SYNTHETIC (this repo is public).
 *
 * Plan: docs/plans/dashboard-home-summary.md §9 (throwaway git repos, corrupted
 * receipt, hook marker, 20 branches, no status.md / no remote / detached HEAD).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execFileSync, spawnSync } from 'node:child_process';
import { git } from './helpers/git.mjs';
import { collectQueues } from '../scripts/lib/dashboard/collect-home-queues.mjs';
import { collectVitals, reduceVitalsInput } from '../scripts/lib/dashboard/collect-home-vitals.mjs';
import { collectConsumers, MAX_CONSUMERS, MAX_RECEIPT_BYTES } from '../scripts/lib/dashboard/collect-home-consumers.mjs';
import { collectShippedMerges, shippedLog, readStatusHead } from '../scripts/lib/dashboard/collect-home-shipped.mjs';
import { collectInflight, INFLIGHT_ROW_CAP, PRS_NOTE } from '../scripts/lib/dashboard/collect-home-inflight.mjs';
import { buildHomeModel } from '../scripts/lib/dashboard/home-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dashboard-home', 'store-unreachable-envelopes.json'), 'utf8'));
const NOW = new Date('2026-10-06T12:00:00.000Z');

const dirs = [];
function tmp(prefix = 'home-collect-') {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } } });

const write = (dir, rel, body) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };

/** A repo on `main` with `commits` commits; optionally a bare local origin. */
function mkRepo({ commits = 1, remote = false } = {}) {
  const root = tmp();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  for (const [k, v] of Object.entries({ 'user.email': 't@example.com', 'user.name': 'T', 'commit.gpgsign': 'false', 'core.autocrlf': 'false' })) git(['config', k, v], repo);
  const shas = [];
  for (let i = 1; i <= commits; i += 1) {
    write(repo, 'f.txt', `${i}\n`);
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', `commit ${i}`], repo);
    shas.push(git(['rev-parse', 'HEAD'], repo));
  }
  if (remote) {
    const origin = path.join(root, 'origin.git');
    git(['init', '--bare', '-q', '-b', 'main', origin], root);
    git(['remote', 'add', 'origin', origin], repo);
    git(['push', '-q', '-u', 'origin', 'main'], repo);
  }
  return { root, repo, shas };
}

// ── queues ──────────────────────────────────────────────────────────────────────

/** A runner that replays what a real reader printed (envelope + exit code) from the capture. */
function replay(mode) {
  return async ({ script, args }) => {
    const reader = path.basename(script) === 'debt-reconcile.mjs' ? 'debt'
      : args[0] === 'list-unlocked-fixes' ? 'q1' : args[0] === 'list-unremediated-acceptances' ? 'q2'
        : args[0] === 'final-review-pending' ? 'q3' : 'upstream';
    const c = FIXTURE.captures.find((x) => x.reader === reader && x.mode === mode);
    return { exitCode: c.exitCode, stdout: `${JSON.stringify(c.envelope)}\n`, aborted: false };
  };
}
const OK_ENV = {
  q1: { ok: true, cloud: true, measured: true, scope: { mode: 'repo' }, rows: new Array(20).fill({}), byMode: { total: 51, code: 26, plan: 25 }, agedOut: 190 },
  q2: { ok: true, cloud: true, measured: true, scope: { mode: 'repo' }, total: 168, byMode: { total: 168, code: 80, plan: 88 }, byDisposition: { acceptedPermanent: 50 } },
  q3: { state: 'ready', cloud: true, counts: { totalActionable: 486 } },
  upstream: { ok: true, cloud: true, rows: [{ createdAt: '2026-09-01T00:00:00Z' }, { createdAt: '2026-08-01T00:00:00Z' }], total: 2 },
  debt: { ok: true, verdict: 'measured', cloudTotal: 173, localTotal: 106, undrainedSpills: 0 },
};
const okRun = async ({ script, args }) => {
  const key = path.basename(script) === 'debt-reconcile.mjs' ? 'debt'
    : args[0] === 'list-unlocked-fixes' ? 'q1' : args[0] === 'list-unremediated-acceptances' ? 'q2'
      : args[0] === 'final-review-pending' ? 'q3' : 'upstream';
  return { exitCode: 0, stdout: JSON.stringify(OK_ENV[key]), aborted: false };
};
const byId = (card, id) => card.measurements.find((x) => x.id === id);

describe('collectQueues', () => {
  test('five measurements from COUNT fields (never rows.length), with the repo slug Q3 used', async () => {
    const card = await collectQueues(tmp(), { run: okRun, repo: 'owner/repo', now: NOW });
    assert.deepEqual(card.measurements.map((x) => x.id), ['queue-q1', 'queue-q2', 'queue-q3', 'queue-debt', 'queue-upstream']);
    assert.ok(card.measurements.every((x) => x.status === 'ok' && x.card === 'queues'));
    assert.deepEqual(byId(card, 'queue-q1').value, { total: 51, code: 26, plan: 25, aged: 190 });
    assert.equal(byId(card, 'queue-q2').value.perm, 50);
    assert.equal(byId(card, 'queue-q3').value.total, 486);
    assert.equal(byId(card, 'queue-q3').repo, 'owner/repo');
    assert.deepEqual(byId(card, 'queue-debt').value, { total: 173, cloud: 173, local: 106, spilled: 0 });
    assert.equal(byId(card, 'queue-upstream').value.total, 2);
    assert.equal(byId(card, 'queue-upstream').value.oldestAt, '2026-08-01T00:00:00.000Z');
  });

  test('trend comes from the newest Backlog line in status.md', async () => {
    const statusText = '## 2026-10-06 — x\nBacklog 2026-10-06T04:56Z: Q1 20c/5p (+3 aged) · Q2 89c/42p (54 perm) · Q3 35 · debt unmeasured · upstream 1\n';
    const card = await collectQueues(tmp(), { run: okRun, repo: 'owner/repo', statusText, now: NOW });
    assert.deepEqual(byId(card, 'queue-q1').previous, { total: 25, code: 20, partial: false });
    assert.equal(byId(card, 'queue-q1').previousAt, '2026-10-06T04:56:00Z');
    assert.equal(byId(card, 'queue-q3').previous.total, 35);
    assert.equal(byId(card, 'queue-debt').previous, null, 'a queue that was unmeasured then has no baseline');
  });

  test('the store unreachable (REAL capture replayed): every queue missing-optional, kind store-unreachable, none a zero', async () => {
    const card = await collectQueues(tmp(), { run: replay('closed-port'), repo: 'owner/repo', now: NOW });
    for (const x of card.measurements) {
      assert.equal(x.status, 'missing-optional', x.id);
      assert.equal(x.kind, 'store-unreachable', x.id);
      assert.equal(x.value, null, `${x.id}: an unasked question is never a number`);
    }
  });

  test('air-gap (empty DSN, REAL capture replayed): store-off is missing-optional too', async () => {
    const card = await collectQueues(tmp(), { run: replay('empty-dsn'), repo: 'owner/repo', now: NOW });
    assert.ok(card.measurements.every((x) => x.status === 'missing-optional' && x.value === null));
    assert.equal(byId(card, 'queue-q1').kind, 'store-off');
  });

  test('a broken reader is a DEFECT: unexpected-error, one measurement only', async () => {
    const run = async (a) => (a.args[0] === 'list-unlocked-fixes' ? { exitCode: 1, stdout: 'Error: Cannot find module\n', aborted: false } : okRun(a));
    const card = await collectQueues(tmp(), { run, repo: 'owner/repo', now: NOW });
    assert.equal(byId(card, 'queue-q1').status, 'unexpected-error');
    assert.equal(byId(card, 'queue-q1').kind, 'process-failed');
    assert.equal(card.measurements.filter((x) => x.status === 'ok').length, 4);
  });

  test('an envelope without count fields is malformed (unexpected-error), never a measured zero', async () => {
    const run = async (a) => (a.args[0] === 'list-unlocked-fixes'
      ? { exitCode: 0, stdout: JSON.stringify({ ok: true, cloud: true, measured: true, scope: { mode: 'repo' }, rows: [] }), aborted: false } : okRun(a));
    const card = await collectQueues(tmp(), { run, repo: 'owner/repo', now: NOW });
    assert.equal(byId(card, 'queue-q1').status, 'unexpected-error');
    assert.equal(byId(card, 'queue-q1').value, null);
  });

  test('M1: previousOf carries the partial qualifier of a paginated upstream count', async () => {
    const statusText = 'Backlog 2026-10-06T04:56Z: Q1 20c/5p · Q2 89c/42p · Q3 35 · debt unmeasured · upstream 5+\n';
    const card = await collectQueues(tmp(), { run: okRun, repo: 'owner/repo', statusText, now: NOW });
    assert.deepEqual(byId(card, 'queue-upstream').previous, { total: 5, partial: true });
    assert.equal(byId(card, 'queue-q1').previous.partial, false);
  });

  test('H6c: a truncated status.md head is a prefix: its cut final line is not parsed as the latest Backlog line', async () => {
    const full = 'Backlog 2026-10-06T04:56Z: Q1 20c/5p · Q2 89c/42p · Q3 35 · debt unmeasured · upstream 1';
    const card = await collectQueues(tmp(), { run: okRun, repo: 'owner/repo', statusText: `${full.slice(0, 40)}`, statusCapped: true, now: NOW });
    assert.equal(byId(card, 'queue-q1').previous, null);
  });

  test('no valid repo slug: Q3 is not asked and is unmeasured', async () => {
    const card = await collectQueues(tmp(), { run: okRun, repo: 'not a slug', now: NOW });
    assert.equal(byId(card, 'queue-q3').status, 'missing-optional');
    assert.equal(byId(card, 'queue-q3').repo, null);
  });
});

// ── vitals ──────────────────────────────────────────────────────────────────────

describe('collectVitals', () => {
  test('AGENTS.md is measured in CHARACTERS of the decoded text, not bytes', () => {
    const root = tmp();
    const text = '# AGENTS\n' + 'é—'.repeat(500);
    write(root, 'AGENTS.md', text);
    assert.ok(Buffer.byteLength(text) > text.length);
    const m = byId(collectVitals(root, { plans: { active: [] }, skills: [], now: NOW }), 'agents-size');
    assert.equal(m.status, 'ok');
    assert.equal(m.value.chars, text.length);
    assert.equal(m.value.cap, 92000);
  });

  test('the cap follows .claude-context-allowlist.json (the gate\'s own resolution)', () => {
    const root = tmp();
    write(root, 'AGENTS.md', 'x');
    write(root, '.claude-context-allowlist.json', JSON.stringify({ maxAgentsMdChars: 1234 }));
    assert.equal(byId(collectVitals(root, { plans: { active: [] }, skills: [], now: NOW }), 'agents-size').value.cap, 1234);
  });

  test('M14: a config problem makes the AGENTS.md measurement invalid, not graded against a silently-wrong default', () => {
    for (const cfg of ['{nope', JSON.stringify({ maxAgentsMdLines: 1200 }), JSON.stringify({ maxAgentsMdChars: -1 })]) {
      const root = tmp();
      write(root, 'AGENTS.md', 'x');
      write(root, '.claude-context-allowlist.json', cfg);
      const m = byId(collectVitals(root, { plans: { active: [] }, skills: [], now: NOW }), 'agents-size');
      assert.equal(m.status, 'invalid', cfg);
      assert.match(m.detail, /unmeasured: config problem:/);
      assert.equal(m.value, null);
    }
  });

  test('no AGENTS.md: missing-optional, not an error', () => {
    const m = byId(collectVitals(tmp(), { plans: { active: [] }, skills: [], now: NOW }), 'agents-size');
    assert.equal(m.status, 'missing-optional');
  });

  test('plans: the collector passes RAW In Progress facts (no staleness verdict; home-model owns the policy)', () => {
    const plans = { active: [
      { path: 'docs/plans/old-one.md', title: 'Old', status: 'In Progress', date: '2026-09-01' },
      { path: 'docs/plans/fresh.md', title: 'Fresh', status: 'In Progress', date: '2026-10-01' },
      { path: 'docs/plans/approved.md', title: 'A', status: 'Approved', date: '2026-01-01' },
      { path: 'docs/plans/undated.md', title: 'U', status: 'In Progress', date: null },
    ], completed: [{ path: 'docs/plans/done.md', title: 'D', status: 'Complete', date: '2026-01-01' }] };
    const m = byId(collectVitals(tmp(), { plans, skills: [], now: NOW }), 'plans');
    assert.equal(m.status, 'ok');
    assert.equal(m.value.inProgress, 3);
    assert.equal(m.value.total, 5);
    assert.equal('old' in m.value, false);
    assert.deepEqual(m.value.plans.map((p) => [p.slug, p.date]), [['old-one', '2026-09-01T00:00:00.000Z'], ['fresh', '2026-10-01T00:00:00.000Z'], ['undated', null]]);
    assert.ok(!JSON.stringify(m.value).includes('body'), 'plan bodies never cross');
  });

  test('a degraded plans/skills source makes THAT measurement non-ok and no other', () => {
    const card = collectVitals(tmp(), {
      plans: { active: [] }, skills: [], now: NOW,
      sourceStatus: { plans: { status: 'unexpected-error', detail: 'plan read error(s)' } },
    });
    assert.equal(byId(card, 'plans').status, 'unexpected-error');
    assert.match(byId(card, 'plans').detail, /plan read error/);
    assert.equal(byId(card, 'skills').status, 'ok');
  });

  test('H1: reduceVitalsInput is idempotent and drops plan bodies', () => {
    const full = { active: [{ path: 'docs/plans/a.md', title: 'A', status: 'In Progress', date: '2026-09-01', body: 'x'.repeat(10_000) }, { path: 'b', status: 'Approved' }], completed: [{ path: 'c' }] };
    const r = reduceVitalsInput({ plans: full, skills: [1, 2] });
    assert.deepEqual(r.plans, { total: 3, inProgress: [{ path: 'docs/plans/a.md', title: 'A', date: '2026-09-01' }] });
    assert.equal(r.skillsCount, 2);
    assert.deepEqual(reduceVitalsInput({ plans: r.plans, skills: r.skillsCount }), r);
  });

  test('skills compare count with the census roster (17)', () => {
    const m = byId(collectVitals(tmp(), { plans: { active: [] }, skills: new Array(16).fill({}), now: NOW }), 'skills');
    assert.deepEqual(m.value, { count: 16, roster: 17 });
  });

  test('maintenance: absent, future-dated, malformed, in-window and overdue heartbeats', () => {
    const dir = tmp();
    const hb = path.join(dir, 'last-maintenance.json');
    const run = () => byId(collectVitals(dir, { plans: { active: [] }, skills: [], now: NOW, heartbeatPath: hb }), 'maintenance');
    assert.equal(run().status, 'missing-optional');
    write(dir, 'last-maintenance.json', '{nope');
    assert.equal(run().status, 'missing-optional');
    write(dir, 'last-maintenance.json', JSON.stringify({ lastRunAt: '2027-01-01T00:00:00Z', results: [] }));
    assert.match(run().detail, /no usable heartbeat/);
    write(dir, 'last-maintenance.json', JSON.stringify({ lastRunAt: '2026-10-03T12:00:00Z', results: [] }));
    assert.equal(run().value.overdueDays, 0);
    write(dir, 'last-maintenance.json', JSON.stringify({ lastRunAt: '2026-09-20T12:00:00Z', results: [] }));
    assert.equal(run().value.overdueDays, 9, '16 days since the last run, minus the 7-day window');
  });
});

// ── shipped ─────────────────────────────────────────────────────────────────────

describe('collectShippedMerges + shippedLog', () => {
  test('first-parent subjects, newest first, bounded at 10', () => {
    const { repo } = mkRepo({ commits: 14 });
    const m = collectShippedMerges(repo, { now: NOW });
    assert.equal(m.status, 'ok');
    assert.equal(m.value.subjects.length, 10);
    assert.equal(m.value.subjects[0].subject, 'commit 14');
    assert.match(m.value.subjects[0].sha7, /^[0-9a-f]{7,}$/);
  });

  test('no remote: still lists, off the local main', () => {
    const { repo } = mkRepo({ commits: 2, remote: false });
    const m = collectShippedMerges(repo, { now: NOW });
    assert.equal(m.status, 'ok');
    assert.equal(m.value.branch, 'main');
  });

  test('with a remote: lists the default branch', () => {
    const { repo } = mkRepo({ commits: 2, remote: true });
    assert.equal(collectShippedMerges(repo, { now: NOW }).value.subjects.length, 2);
  });

  test('H5/M9: a clone with origin/HEAD -> origin/main, NO local main, HEAD on a feature branch: lists origin/main', () => {
    const { root, repo } = mkRepo({ commits: 3, remote: true });
    const clone = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', path.join(root, 'origin.git'), clone], { stdio: 'pipe' });
    for (const [k, v] of Object.entries({ 'user.email': 't@example.com', 'user.name': 'T', 'commit.gpgsign': 'false' })) git(['config', k, v], clone);
    git(['checkout', '-q', '-b', 'feature'], clone);
    git(['branch', '-D', 'main'], clone);
    assert.throws(() => git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], clone), 'precondition: no local main');
    write(clone, 'wip.txt', 'x'); git(['add', '.'], clone); git(['commit', '-q', '-m', 'wip on the feature branch'], clone);
    const m = collectShippedMerges(clone, { now: NOW });
    assert.equal(m.status, 'ok');
    assert.equal(m.value.branch, 'origin/main');
    assert.equal(m.value.subjects[0].subject, 'commit 3', 'the default branch, not the feature branch tip');
    assert.ok(!m.value.subjects.some((s) => /wip on the feature/.test(s.subject)));
  });

  test('a local main that TRAILS origin/main lists origin/main and says local is behind (persona P1, 2026-10-10)', () => {
    const { repo } = mkRepo({ commits: 2, remote: true });
    write(repo, 'f.txt', 'newer\n'); git(['add', '.'], repo); git(['commit', '-q', '-m', 'merged upstream'], repo);
    git(['push', '-q', 'origin', 'main'], repo);
    git(['reset', '-q', '--hard', 'HEAD~1'], repo); // local main now trails its upstream by 1
    const m = collectShippedMerges(repo, { now: NOW });
    assert.equal(m.status, 'ok');
    assert.equal(m.value.subjects[0].subject, 'merged upstream', 'the fresher ref, not the stale local one');
    assert.match(m.value.branch, /^origin\/main \(local main is 1 commit\(s\) behind\)$/);
  });

  test('a ref that RESOLVED but whose log fails is unexpected-error, not missing-optional (R1-M6)', () => {
    const { repo, shas } = mkRepo({ commits: 3 });
    const obj = path.join(repo, '.git', 'objects', shas[0].slice(0, 2), shas[0].slice(2));
    fs.rmSync(obj, { force: true }); // the history walk now hits a missing commit
    const m = collectShippedMerges(repo, { now: NOW });
    assert.equal(m.status, 'unexpected-error', m.detail);
    assert.match(m.detail, /git log .* failed/);
  });

  test('H5/M9: no default branch anywhere and no HEAD: the measurement SAYS so (not "no merges")', () => {
    const empty = tmp();
    git(['init', '-q', '-b', 'trunk'], empty);
    const m = collectShippedMerges(empty, { now: NOW });
    assert.equal(m.status, 'missing-optional');
    assert.match(m.detail, /no default branch|could not|bad default|does not have any commits/i);
  });

  test('detached HEAD: main is still the target', () => {
    const { repo, shas } = mkRepo({ commits: 3 });
    git(['checkout', '-q', '--detach', shas[0]], repo);
    const m = collectShippedMerges(repo, { now: NOW });
    assert.equal(m.status, 'ok');
    assert.equal(m.value.subjects[0].subject, 'commit 3');
  });

  test('not a repo / no commits: missing-optional, never a thrown error', () => {
    assert.equal(collectShippedMerges(tmp(), { now: NOW }).status, 'missing-optional');
    const empty = tmp();
    git(['init', '-q', '-b', 'main'], empty);
    assert.equal(collectShippedMerges(empty, { now: NOW }).status, 'missing-optional');
  });

  test('no status.md: the log is missing-optional while the merge list is unaffected', () => {
    const { repo } = mkRepo({ commits: 2 });
    const log = shippedLog(readStatusHead(repo), NOW);
    assert.equal(log.status, 'missing-optional');
    assert.equal(collectShippedMerges(repo, { now: NOW }).status, 'ok');
  });
});

// ── consumers ───────────────────────────────────────────────────────────────────

const receipt = (sha, over = {}) => JSON.stringify({
  version: 2, _note: 'x', olderSyncsDropped: 0,
  recentSyncs: [{ syncedAt: '2026-10-05T08:00:00Z', source: { repo: 'owner/source', branch: 'main', commitSha: sha, sourceDirty: false }, ...over }],
});

describe('collectConsumers (source repo)', () => {
  /** A source repo with 4 commits, a divergent branch, and one synthetic consumer per receipt state. */
  function scenario() {
    const { repo, shas } = mkRepo({ commits: 4 });
    git(['checkout', '-q', '-b', 'divergent', shas[0]], repo);
    write(repo, 'g.txt', 'g\n'); git(['add', '.'], repo); git(['commit', '-q', '-m', 'on a side branch'], repo);
    const divergent = git(['rev-parse', 'HEAD'], repo);
    git(['checkout', '-q', 'main'], repo);
    const consumersRoot = tmp('home-consumers-');
    const mk = (name, body) => { const p = path.join(consumersRoot, name); fs.mkdirSync(p); if (body !== undefined) write(p, '.sync-receipt.json', body); return { name, path: p }; };
    const list = [
      mk('syn-current', receipt(shas[3])),
      mk('syn-behind', receipt(shas[1])),
      mk('syn-unknown-sha', receipt('a'.repeat(40))),
      mk('syn-divergent', receipt(divergent)),
      mk('syn-corrupt', '{"version": 2, "recentSyncs": [{'),
      mk('syn-invalid-sha', receipt('--upload-pack=evil')),
      mk('syn-no-receipt'),
    ];
    return { repo, shas, list, consumersRoot };
  }
  const row = (card, name) => card.measurements.find((x) => x.id === `consumer:${name}`);

  test('each state is classified by git ancestry against THIS repo\'s history', async () => {
    const { repo, list } = scenario();
    const card = await collectConsumers(repo, { now: NOW, consumers: list, isSource: true });
    const agg = card.measurements[0];
    assert.equal(agg.id, 'consumers');
    assert.equal(row(card, 'syn-current').value.state, 'current');
    assert.deepEqual([row(card, 'syn-behind').value.state, row(card, 'syn-behind').value.behind], ['behind', 2]);
    assert.equal(row(card, 'syn-unknown-sha').value.state, 'not-comparable');
    assert.match(row(card, 'syn-unknown-sha').value.detail, /not in this clone/);
    assert.equal(row(card, 'syn-divergent').value.state, 'not-comparable');
    assert.match(row(card, 'syn-divergent').value.detail, /not an ancestor/);
    assert.equal(row(card, 'syn-corrupt').value.state, 'unreadable');
    assert.equal(row(card, 'syn-invalid-sha').value.state, 'unreadable', 'a non-hex sha never reaches a git argv');
    assert.equal(row(card, 'syn-no-receipt').value.state, 'unreadable');
    assert.deepEqual(
      { total: agg.value.total, inspected: agg.value.inspected, omitted: agg.value.omitted, current: agg.value.current, behind: agg.value.behind, nc: agg.value.notComparable, un: agg.value.unreadable },
      { total: 7, inspected: 7, omitted: 0, current: 1, behind: 1, nc: 2, un: 3 },
    );
  });

  test('a corrupted receipt degrades exactly ONE measurement; the aggregate and the others stay ok', async () => {
    const { repo, list } = scenario();
    const card = await collectConsumers(repo, { now: NOW, consumers: list, isSource: true });
    const bad = card.measurements.filter((x) => x.status !== 'ok').map((x) => x.id).sort();
    // corrupt + invalid-sha are schema-invalid; the missing receipt is an expected absence — three non-ok rows, each ITS OWN
    assert.deepEqual(bad, ['consumer:syn-corrupt', 'consumer:syn-invalid-sha', 'consumer:syn-no-receipt']);
    // ANOTHER repo's file never fails this build: unreadable is missing-optional, with an "unreadable (reason)" detail.
    assert.equal(row(card, 'syn-corrupt').status, 'missing-optional');
    assert.match(row(card, 'syn-corrupt').detail, /^unreadable \(/);
    assert.match(row(card, 'syn-invalid-sha').detail, /^unreadable \(/);
    assert.equal(row(card, 'syn-no-receipt').status, 'missing-optional');
    assert.ok(card.measurements.every((x) => x.status !== 'invalid'));
    assert.equal(card.measurements[0].status, 'ok');
    // exactly one corrupted receipt degrades exactly one measurement
    const one = await collectConsumers(repo, { now: NOW, consumers: list.filter((c) => ['syn-current', 'syn-behind', 'syn-corrupt'].includes(c.name)), isSource: true });
    assert.deepEqual(one.measurements.filter((x) => x.status !== 'ok').map((x) => x.id), ['consumer:syn-corrupt']);
  });

  test('receipts over 1 MB are refused unread', async () => {
    const { repo, shas } = mkRepo({ commits: 1 });
    const dir = tmp('home-big-');
    write(dir, '.sync-receipt.json', receipt(shas[0], { pad: 'x'.repeat(MAX_RECEIPT_BYTES) }));
    const card = await collectConsumers(repo, { now: NOW, consumers: [{ name: 'syn-big', path: dir }], isSource: true });
    assert.equal(card.measurements[1].status, 'missing-optional');
    assert.match(card.measurements[1].detail, /^unreadable \(too large/);
  });

  test('H3: the cap holds when the file GROWS after the stat (reads at most cap+1 bytes through the fd)', async () => {
    const { repo, shas } = mkRepo({ commits: 1 });
    const dir = tmp('home-grow-');
    write(dir, '.sync-receipt.json', receipt(shas[0], { pad: 'x'.repeat(MAX_RECEIPT_BYTES * 2) }));
    let lied = 0;
    const fsApi = { ...fs, fstatSync: (fd) => { lied += 1; return { isFile: () => true, size: 100 }; } };
    let bytesRead = 0;
    fsApi.readSync = (...a) => { const n = fs.readSync(...a); bytesRead += n; return n; };
    const card = await collectConsumers(repo, { now: NOW, consumers: [{ name: 'syn-grows', path: dir }], isSource: true, fsApi });
    assert.ok(lied >= 1, 'the stat said the file was tiny');
    assert.equal(card.measurements[1].status, 'missing-optional');
    assert.match(card.measurements[1].detail, /too large/);
    assert.ok(bytesRead <= MAX_RECEIPT_BYTES + 1, `read ${bytesRead} bytes`);
  });

  test('H3: a receipt of exactly the cap is read; the fd is always closed', async () => {
    const { repo, shas } = mkRepo({ commits: 1 });
    const dir = tmp('home-fd-');
    write(dir, '.sync-receipt.json', receipt(shas[0]));
    let open = 0;
    const fsApi = { ...fs, openSync: (...a) => { open += 1; return fs.openSync(...a); }, closeSync: (fd) => { open -= 1; return fs.closeSync(fd); } };
    const card = await collectConsumers(repo, { now: NOW, consumers: [{ name: 'syn-ok', path: dir }], isSource: true, fsApi });
    assert.equal(card.measurements[1].value.state, 'current');
    assert.equal(open, 0, 'no leaked descriptor');
  });

  test('H4/M10: a SHORT sha resolves to a full oid (no string prefix comparison)', async () => {
    const { repo, shas } = mkRepo({ commits: 3 });
    const dir = tmp('home-short-');
    write(dir, '.sync-receipt.json', receipt(shas[2].slice(0, 8)));
    const dir2 = tmp('home-short2-');
    write(dir2, '.sync-receipt.json', receipt(shas[0].slice(0, 8)));
    const card = await collectConsumers(repo, { now: NOW, consumers: [{ name: 'syn-short-head', path: dir }, { name: 'syn-short-old', path: dir2 }], isSource: true });
    assert.equal(card.measurements[1].value.state, 'current');
    assert.deepEqual([card.measurements[2].value.state, card.measurements[2].value.behind], ['behind', 2]);
  });

  test('H4/M10: a syntactically valid but NONEXISTENT sha is not comparable, never current', async () => {
    const { repo, shas } = mkRepo({ commits: 2 });
    // shares the head's first 7 chars but is a different, nonexistent object: a prefix comparison would call it current
    const lookalike = shas[1].slice(0, 7) + 'f'.repeat(33);
    const dir = tmp('home-fake-');
    write(dir, '.sync-receipt.json', receipt(lookalike));
    const card = await collectConsumers(repo, { now: NOW, consumers: [{ name: 'syn-lookalike', path: dir }], isSource: true });
    assert.equal(card.measurements[1].value.state, 'not-comparable');
    assert.notEqual(card.measurements[1].value.state, 'current');
    // and a LONGER hex string that merely STARTS with the head's full oid (a bidirectional prefix test calls it current)
    const dir2 = tmp('home-fake2-');
    write(dir2, '.sync-receipt.json', receipt(shas[1] + 'a'.repeat(24)));
    const card2 = await collectConsumers(repo, { now: NOW, consumers: [{ name: 'syn-extended', path: dir2 }], isSource: true });
    assert.equal(card2.measurements[1].value.state, 'not-comparable');
  });

  test('H4/M10: an AMBIGUOUS abbreviation is not comparable (two real commits share a 7-char prefix)', async () => {
    const root = tmp('home-ambig-');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(['init', '-q', '-b', 'main'], repo);
    const N = 60_000; // 60k deterministic commits: two share a 7-hex prefix (28 bits => ~5 expected pairs)
    let script = '';
    for (let i = 1; i <= N; i += 1) {
      const msg = `c${i}`;
      script += `commit refs/heads/main\nmark :${i}\ncommitter T <t@e.com> ${1000000000 + i} +0000\ndata ${msg.length}\n${msg}\n${i > 1 ? `from :${i - 1}\n` : ''}\n`;
    }
    const fi = spawnSync('git', ['fast-import', '--quiet'], { cwd: repo, input: script, maxBuffer: 1 << 26 });
    assert.equal(fi.status, 0);
    const oids = execFileSync('git', ['rev-list', 'main'], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 }).trim().split('\n');
    const seen = new Map(); let prefix = null;
    for (const o of oids) { const k = o.slice(0, 7); if (seen.has(k)) { prefix = k; break; } seen.set(k, o); }
    assert.ok(prefix, 'the fixture must contain an ambiguous prefix (the instrument is not vacuous)');
    const dir = tmp('home-ambig-c-');
    write(dir, '.sync-receipt.json', receipt(prefix));
    const card = await collectConsumers(repo, { now: NOW, consumers: [{ name: 'syn-ambiguous', path: dir }], isSource: true });
    assert.equal(card.measurements[1].value.state, 'not-comparable');
    assert.match(card.measurements[1].value.detail, /ambiguous/);
  });


  test('20-receipt cap: {total, inspected, omitted} are explicit and the grade can never be ok', async () => {
    const { repo, shas } = mkRepo({ commits: 1 });
    const root = tmp('home-many-');
    const list = Array.from({ length: 25 }, (_, i) => { const p = path.join(root, `syn-${i}`); fs.mkdirSync(p); write(p, '.sync-receipt.json', receipt(shas[0])); return { name: `syn-${i}`, path: p }; });
    const card = await collectConsumers(repo, { now: NOW, consumers: list, isSource: true });
    const v = card.measurements[0].value;
    assert.deepEqual([v.total, v.inspected, v.omitted, v.current], [25, MAX_CONSUMERS, 5, 20]);
    assert.equal(card.measurements.length, 1 + MAX_CONSUMERS);
    assert.match(card.measurements[0].detail, /5 not inspected/);
    const model = buildHomeModel({ consumers: card }, { now: NOW });
    assert.equal(model.health.find((c) => c.id === 'consumers').state, 'warn', 'every inspected one is current and it is STILL not ok');
  });

  test('an invalid registered name is refused rather than interpolated anywhere', async () => {
    const { repo } = mkRepo({ commits: 1 });
    const card = await collectConsumers(repo, { now: NOW, consumers: [{ name: 'bad name; x', path: tmp() }, { name: '..', path: tmp() }], isSource: true });
    assert.ok(card.measurements.slice(1).every((x) => x.status === 'missing-optional' && x.value.name === null));
    assert.doesNotMatch(JSON.stringify(card), /bad name; x/);
  });

  test('a last sync that moved the consumer BACKWARDS is flagged (the sync\'s own rollback predicate)', async () => {
    const { repo, shas } = mkRepo({ commits: 3 });
    const dir = tmp('home-rollback-');
    write(dir, '.sync-receipt.json', JSON.stringify({ version: 2, olderSyncsDropped: 0, recentSyncs: [
      { syncedAt: '2026-10-05T08:00:00Z', source: { repo: 'o/s', branch: 'main', commitSha: shas[0], sourceDirty: false } },
      { syncedAt: '2026-10-04T08:00:00Z', source: { repo: 'o/s', branch: 'main', commitSha: shas[2], sourceDirty: false } },
    ] }));
    const card = await collectConsumers(repo, { now: NOW, consumers: [{ name: 'syn-rolled', path: dir }], isSource: true });
    const r = card.measurements[1].value;
    assert.equal(r.state, 'behind');
    assert.equal(r.rolledBack, true);
    assert.match(r.detail, /rolled it back/);
  });

  test('no registered consumers: the aggregate is missing-optional', async () => {
    const { repo } = mkRepo({ commits: 1 });
    const card = await collectConsumers(repo, { now: NOW, consumers: [], isSource: true });
    assert.equal(card.measurements.length, 1);
    assert.equal(card.measurements[0].status, 'missing-optional');
  });
});

describe('collectConsumers (inside a consumer)', () => {
  test('shows its own last sync as a neutral fact and compares nothing', async () => {
    const dir = tmp('home-in-consumer-');
    write(dir, '.sync-receipt.json', receipt('b'.repeat(40)));
    const card = await collectConsumers(dir, { now: NOW, isSource: false });
    assert.deepEqual(card.measurements.length, 1);
    assert.deepEqual(card.measurements[0].value, { mode: 'consumer', syncedAt: '2026-10-05T08:00:00.000Z', sha7: 'bbbbbbb' });
    assert.equal(buildHomeModel({ consumers: card }, { now: NOW }).health.find((c) => c.id === 'consumers').state, 'neutral');
  });
  test('no receipt yet is missing-optional; a corrupt one of THIS repo is invalid (its own defect)', async () => {
    const dir = tmp('home-in-consumer-');
    assert.equal((await collectConsumers(dir, { now: NOW, isSource: false })).measurements[0].status, 'missing-optional');
    write(dir, '.sync-receipt.json', 'not json');
    assert.equal((await collectConsumers(dir, { now: NOW, isSource: false })).measurements[0].status, 'invalid');
  });
});

// ── in flight ───────────────────────────────────────────────────────────────────

/** `n` branches each one commit ahead of main, made with commit-tree (no checkouts: fast). */
function addAheadBranches(repo, n) {
  const tree = git(['rev-parse', 'main^{tree}'], repo);
  const parent = git(['rev-parse', 'main'], repo);
  for (let i = 1; i <= n; i += 1) {
    const sha = git(['commit-tree', tree, '-p', parent, '-m', `work ${i}`], repo);
    git(['branch', `feat-${String(i).padStart(2, '0')}`, sha], repo);
  }
}

describe('collectInflight', () => {
  test('a quiet repo: measured, no rows, PRs explicitly not queried', () => {
    const { repo } = mkRepo({ commits: 1, remote: true });
    const m = collectInflight(repo, { now: NOW });
    assert.equal(m.status, 'ok');
    assert.deepEqual(m.value.rows, []);
    assert.equal(m.value.total, 0);
    assert.equal(m.value.prs, PRS_NOTE);
    assert.match(PRS_NOTE, /^PRs: not queried/);
  });

  test('20 qualifying branches: 15 rows and a true "+5 more"', () => {
    const { repo } = mkRepo({ commits: 1, remote: true });
    addAheadBranches(repo, 20);
    const m = collectInflight(repo, { now: NOW });
    assert.equal(m.status, 'ok');
    assert.equal(m.value.rows.length, INFLIGHT_ROW_CAP);
    assert.equal(m.value.more, 5);
    assert.equal(m.value.total, 20);
    assert.ok(m.value.rows.every((r) => r.ahead === 1));
  });

  test('more than maxBranches (30): the overflow is reported as "not analysed", never silently skipped', () => {
    const { repo } = mkRepo({ commits: 1, remote: true });
    addAheadBranches(repo, 34);
    const m = collectInflight(repo, { now: NOW });
    assert.equal(m.value.total, 34);
    assert.deepEqual(m.value.notAnalysed, { count: 4 });
    assert.match(m.detail, /4 branch\(es\) not analysed/);
  });

  test('no remote: still measured', () => {
    const { repo } = mkRepo({ commits: 1, remote: false });
    addAheadBranches(repo, 2);
    const m = collectInflight(repo, { now: NOW });
    assert.equal(m.status, 'ok');
    assert.equal(m.value.rows.length, 2);
  });

  test('detached HEAD: measured, the detached checkout is a row', () => {
    const { repo, shas } = mkRepo({ commits: 2, remote: true });
    git(['checkout', '-q', '--detach', shas[0]], repo);
    const m = collectInflight(repo, { now: NOW });
    assert.equal(m.status, 'ok');
  });

  test('M15: an invalid FLEET_LEASE_HOURS is invalid too', () => {
    const { repo } = mkRepo({ commits: 1 });
    const m = collectInflight(repo, { now: NOW, env: { ...process.env, FLEET_LEASE_HOURS: '24hours' } });
    assert.equal(m.status, 'invalid');
    assert.match(m.detail, /FLEET_LEASE_HOURS/);
  });

  test('not a git repository: missing-optional (an expected absence), not a crash', () => {
    const m = collectInflight(tmp(), { now: NOW });
    assert.equal(m.status, 'missing-optional');
  });

  test('a .fleet.json whose hook writes a marker file: the dashboard build must NOT run it', () => {
    const { repo, root } = mkRepo({ commits: 1, remote: true });
    const marker = path.join(root, 'hook-ran.txt');
    write(repo, 'hook.mjs', `process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('{"schemaVersion":1,"findings":[]}');`);
    write(repo, '.fleet.json', JSON.stringify({ checks: [{ name: 'mark', script: 'hook.mjs', runner: ['node'], runIn: ['status'], severity: 'warn' }] }));
    addAheadBranches(repo, 3);
    const m = collectInflight(repo, { now: NOW });
    assert.equal(m.status, 'ok');
    assert.equal(m.value.rows.length, 3, 'the hook config was valid and the facts were gathered');
    assert.equal(fs.existsSync(marker), false, 'consumer code must not execute during a dashboard build');
  });

  test('M15: an explicitly supplied but INVALID .fleet.json is invalid (a defect to fix), with the config message in detail', () => {
    const { repo } = mkRepo({ commits: 1 });
    write(repo, '.fleet.json', '{"surprise": true}');
    const m = collectInflight(repo, { now: NOW });
    assert.equal(m.status, 'invalid');
    assert.match(m.detail, /fleet configuration invalid: .*surprise/);
  });
});
