/**
 * @fileoverview Fleet feedback cluster 2 (docs/plans/fleet-feedback-cluster2-claims-turns.md): a turn outlives its work (D1),
 * broad claims and the verified `narrow` directive (D2), stale ready marks (D3). The incident behind D1 (work consumer,
 * 2026-11-21): the slot was released with the PR merged and the session archived, yet the repo kept its turn and a queued
 * repo waited ~20 minutes with the slot free.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv } from './helpers/fleet-repo.mjs';
import { git } from './helpers/git.mjs';
import { T0, world } from './helpers/fleet-lease-world.mjs';
import { emptyLease } from '../scripts/lib/fleet/lease.mjs';
import { endTurnWorkGone } from '../scripts/lib/fleet/lease-turns.mjs';
import { afterRetire, cmdReleaseStaleReady, evidenceHolds, retireSession } from '../scripts/lib/fleet/lifecycle.mjs';
import { repairCommand } from '../scripts/lib/fleet/lease-workgone.mjs';
import { fleetDir, transact } from '../scripts/lib/fleet/registry.mjs';
import { broadClaimPatterns, staleReadyMarks } from '../scripts/lib/fleet/overlap.mjs';
import { classifyDirective, DIRECTIVE_KINDS } from '../scripts/lib/fleet/directives.mjs';
import { deriveObligations, verifyDirective } from '../scripts/lib/fleet/obligations.mjs';

after(cleanupFleetRoots);

const NOW = new Date(T0);
const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
const turnOf = (repoKey) => ({ repoKey, repo: `o/${repoKey[0]}`, startedAt: '2026-10-13T19:00:00.000Z', endsAt: '2026-10-13T20:30:00.000Z' });
const ciWindow = (repoKey, id) => ({ id, repoKey, repo: `o/${repoKey[0]}`, kind: 'ci', from: '2026-10-13T19:50:00.000Z', until: '2026-10-13T20:20:00.000Z' });
const leaseWith = (extra) => ({ ...emptyLease(), ...extra });

describe('D1 endTurnWorkGone (pure)', () => {
  it('ends the repo\'s turn when nothing it served remains', () => {
    const r = endTurnWorkGone(leaseWith({ turn: turnOf(A) }), A, NOW);
    assert.equal(r.turnEnded, true);
    assert.equal(r.lease.turn, undefined);
    assert.deepEqual(r.lease.journal.map((e) => [e.kind, e.reason]), [['turn-ended', 'work-gone']]);
  });
  it('clears its OWN unexpired CI windows only with clearCi, journaled as work-gone, and never another repo\'s', () => {
    const base = leaseWith({ turn: turnOf(A), windows: [ciWindow(A, 'w-1'), ciWindow(B, 'w-2')] });
    const without = endTurnWorkGone(base, A, NOW);
    assert.equal(without.windowsCleared, 0);
    assert.equal(without.lease.windows.length, 2);
    const withCi = endTurnWorkGone(base, A, NOW, { clearCi: true });
    assert.equal(withCi.windowsCleared, 1);
    assert.deepEqual(withCi.lease.windows.map((w) => w.id), ['w-2']);
    const cleared = withCi.lease.journal.find((e) => e.kind === 'window-cleared');
    assert.equal(cleared.reason, 'work-gone');
    assert.equal(cleared.ownRepo, true);
  });
  it('clears the window even when the turn already expired or is another repo\'s; the other repo\'s turn is untouched', () => {
    const other = endTurnWorkGone(leaseWith({ turn: turnOf(B), windows: [ciWindow(A, 'w-1')] }), A, NOW, { clearCi: true });
    assert.equal(other.windowsCleared, 1);
    assert.equal(other.turnEnded, false);
    assert.equal(other.lease.turn.repoKey, B);
    const none = endTurnWorkGone(leaseWith({ windows: [ciWindow(A, 'w-1')] }), A, NOW, { clearCi: true });
    assert.equal(none.windowsCleared, 1);
  });
  it('an expired window is left alone', () => {
    const old = { ...ciWindow(A, 'w-old'), from: '2026-10-13T18:00:00.000Z', until: '2026-10-13T18:30:00.000Z' };
    const r = endTurnWorkGone(leaseWith({ windows: [old] }), A, NOW, { clearCi: true });
    assert.equal(r.windowsCleared, 0);
  });
  it('does nothing (the SAME object) while the repo holds the slot or has a waiter, or when there is nothing to end', () => {
    const held = leaseWith({ turn: turnOf(A), heavy: { holder: 'h', repoKey: A, repo: 'o/a', kind: 'gate', startedAt: T0, expiresAt: '2026-10-13T21:00:00.000Z', scope: 's', token: 't' } });
    assert.equal(endTurnWorkGone(held, A, NOW, { clearCi: true }).lease, held);
    const waiting = leaseWith({ turn: turnOf(A), waiters: [{ repoKey: A, repo: 'o/a', since: T0, forMin: 10 }] });
    assert.equal(endTurnWorkGone(waiting, A, NOW).lease, waiting);
    const empty = emptyLease();
    assert.equal(endTurnWorkGone(empty, A, NOW, { clearCi: true }).lease, empty);
    const others = leaseWith({ turn: turnOf(B) });
    assert.equal(endTurnWorkGone(others, A, NOW).lease, others);
  });
});

describe('D1 audit fixes', () => {
  it('a FUTURE CI window (a reservation, not this work) is left; only a running one is cleared', () => {
    const future = { ...ciWindow(A, 'w-future'), from: '2026-10-14T09:00:00.000Z', until: '2026-10-14T09:30:00.000Z' };
    const r = endTurnWorkGone(leaseWith({ windows: [future, ciWindow(A, 'w-run')] }), A, NOW, { clearCi: true });
    assert.deepEqual(r.lease.windows.map((w) => w.id), ['w-future']);
  });
  it('the repair command quotes the session id as data (a branch name may hold shell metacharacters)', () => {
    const cmd = repairCommand('fleet', 'topic;touch pwned');
    assert.ok(/(['"]).*topic;touch pwned.*\1/.test(cmd), `the id must sit inside quotes: ${cmd}`);
    assert.equal(repairCommand('fleet', 'plain-branch'), 'fleet release --id plain-branch');
  });
  it('an unreadable lease file is a FAILED follow-on with the repair, never a quiet skip', () => {
    const w = world();
    assert.equal(w.runA(['lease', 'acquire', '--for', '30']).status, 0);
    assert.equal(w.runA(['lease', 'release']).status, 0);
    fs.writeFileSync(w.leaseFile, '{ not json');
    const r = w.runA(['release', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.leaseStep.lease, 'failed');
    assert.match(r.json.leaseStep.reason, /unreadable/);
    assert.ok(r.json.repair);
  });
  it('merged evidence is bound to the session generation, revision and branch tip it described', () => {
    const fx = makeFleetRepo();
    const tip = git(['rev-parse', 'refs/heads/main'], fx.repo);
    const cur = { gen: 1, rev: 2, source: { kind: 'branch', branch: 'main' } };
    const ctx = { cwd: fx.repo };
    assert.equal(evidenceHolds(ctx, cur, { gen: 1, rev: 2, tip }), true);
    assert.equal(evidenceHolds(ctx, cur, { gen: 1, rev: 3, tip }), false, 'the record moved');
    assert.equal(evidenceHolds(ctx, { ...cur, gen: 2 }, { gen: 1, rev: 2, tip }), false, 'a new generation');
    assert.equal(evidenceHolds(ctx, cur, { gen: 1, rev: 2, tip: 'f'.repeat(40) }), false, 'the tip moved');
    assert.equal(evidenceHolds(ctx, cur, null), false);
    assert.equal(evidenceHolds(ctx, { ...cur, source: { kind: 'pr' } }, { gen: 1, rev: 2, tip }), false, 'a PR session has no local tip');
  });
});

describe('D1 fleet release ends the turn of a repo whose work is gone (the 16:17/16:37 incident)', () => {
  /** A holds then releases the slot (a plain release keeps its turn for the between-jobs gap); B is queued behind. */
  const queued = () => {
    const w = world();
    assert.equal(w.runA(['lease', 'acquire', '--for', '30']).status, 0);
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 3);
    assert.equal(w.runA(['lease', 'release']).status, 0);
    const held = w.runB(['lease', 'acquire', '--for', '10']);
    assert.equal(held.status, 3, 'precondition: A keeps its turn after a plain release');
    assert.match(held.stdout, /turn until/);
    return w;
  };

  it('releasing the repo\'s LAST live session ends its turn: the queued repo goes at once', () => {
    const w = queued();
    const r = w.runA(['release', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.leaseStep.lease, 'ended');
    assert.match(r.stdout, /ended this repo's turn/);
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 0);
  });

  it('a sibling live session keeps the turn (batching is untouched)', () => {
    const w = queued();
    assert.equal(w.runA(['claim', '--id', 'sibling', '--intent', 'second job', '--paths', 'b.txt']).status, 0);
    const r = w.runA(['release', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.leaseStep.lease, 'n/a');
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 3, 'the turn is still A\'s');
  });

  it('an abandoned release (no merged evidence) ends the turn but leaves the repo\'s CI window', () => {
    const w = queued();
    assert.equal(w.runA(['lease', 'announce', '--kind', 'ci', '--until', '+30m']).status, 0);
    const r = w.runA(['release', '--abandoned', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.leaseStep.turnEnded, true);
    assert.equal(r.json.leaseStep.windowsCleared, 0);
    assert.equal(w.read().windows.filter((x) => x.kind === 'ci').length, 1, 'the window stays: no merged evidence it is moot');
    assert.equal(w.read().turn, undefined);
  });

  it('a lease failure leaves the release standing, prints the repair command, and re-running it completes the step', () => {
    const w = queued();
    const bad = w.runA(['release', '--json'], { FLEET_MACHINE_DIR: 'not-absolute' });
    assert.equal(bad.status, 0, bad.stdout + bad.stderr);
    assert.equal(bad.json.state, 'done', 'the retirement is durable');
    assert.equal(bad.json.leaseStep.lease, 'failed');
    assert.match(bad.json.repair, /release --id main$/);
    assert.match(bad.stdout, /warning: the lease was not updated/);
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 3, 'the turn is still there');
    const again = w.runA(['release', '--json']);
    assert.equal(again.json.changed, false, 'already retired');
    assert.equal(again.json.leaseStep.lease, 'ended', 're-running repairs the lease step');
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 0);
  });

  it('the lease step runs while the registry lock is held: a claim cannot register between the count and the lease write', () => {
    const fx = makeFleetRepo();
    const env = scrubbedEnv({ FLEET_NOW: T0 });
    assert.equal(runFleet(['claim', '--id', 'solo', '--intent', 'x', '--paths', 'a.txt'], { cwd: fx.repo, env }).status, 0);
    const dir = fleetDir(fx.repo);
    const ctx = { dir, cwd: fx.repo, env, now: NOW, cmd: 'fleet' };
    const registry = pathToFileURL(path.resolve('scripts/lib/fleet/registry.mjs')).href;
    let probed;
    transact(dir, (t) => {
      const cur = t.sessions.find((s) => s.id === 'solo');
      retireSession(t, cur, 'done', ctx);
      afterRetire(ctx, t, 'solo', false, () => {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { transact } from ${JSON.stringify(registry)}; process.stdout.write(JSON.stringify(transact(${JSON.stringify(dir)}, () => 1, { maxWaitMs: 150 })));`], { encoding: 'utf8' });
        probed = JSON.parse(child.stdout);
        return { lease: 'n/a' };
      });
    });
    assert.deepEqual(probed, { ok: false, reason: 'lock-contention' });
  });
});

describe('D2 broad claims', () => {
  it('classifies by the last whole-segment wildcard over a literal prefix of at most two segments', () => {
    assert.deepEqual(broadClaimPatterns(['tests/**', '**', '*', 'app/views/**', 'src/*', 'src/*/lib/**']), ['tests/**', '**', '*', 'app/views/**', 'src/*', 'src/*/lib/**']);
    assert.deepEqual(broadClaimPatterns(['tests/foo.test.mjs', 'src/lib/fleet/**', 'tests/*.test.mjs', 'a/b/c/**', 'docs/plans/*.md']), []);
    assert.deepEqual(broadClaimPatterns(['/abs/**', 'a//b/**', 'x/../**']), [], 'an invalid pattern is never classified (it is refused elsewhere)');
    assert.deepEqual(broadClaimPatterns(undefined), []);
  });
  it('claim warns, reports broadPatterns, and never blocks', () => {
    const fx = makeFleetRepo();
    const env = scrubbedEnv({ FLEET_NOW: T0 });
    const r = runFleet(['claim', '--id', 'wide', '--intent', 'wide', '--paths', 'tests/**,a.txt', '--json'], { cwd: fx.repo, env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.json.broadPatterns, ['tests/**']);
    assert.match(r.json.text, /warning: broad claim tests\/\*\*/);
    const narrow = runFleet(['claim', '--id', 'tight', '--intent', 'tight', '--paths', 'b.txt', '--json'], { cwd: fx.repo, env });
    assert.equal(narrow.status, 0);
    assert.equal(narrow.json.broadPatterns, undefined);
  });
});

describe('D2 the narrow directive is verified by the fact, not by the coordinator\'s word', () => {
  const baseItem = (over = {}) => ({ id: 's1', branch: 's1', paths: ['tests/**'], overlaps: [{ with: 's2', via: ['paths'], known: false, ownPatterns: ['tests/**'] }], ...over });
  const session = (paths) => ({ id: 's1', state: 'working', paths });
  const directive = (over = {}) => ({ id: 'd-20261121000000-0001', to: 's1', kind: 'narrow', reason: { kind: 'note', note: 'tests/** blocks siblings' }, by: 'coord', createdAt: T0, expiresAt: '2026-11-22T00:00:00.000Z', acks: [], ...over });
  const derive = (item, sess, dirs = []) => deriveObligations({ item, session: sess, directives: { active: dirs, complete: true }, now: NOW });

  it('VERIFIED for a broad claim that overlaps a sibling, even with a note reason; the action quotes the narrowing command', () => {
    const r = derive(baseItem(), session(['tests/**']), [directive()]);
    assert.ok(r.obligations.some((o) => o.kind === 'broad-claim'));
    const v = r.directives[0];
    assert.equal(v.status, 'verified');
    assert.match(v.action, /fleet claim --paths/);
  });
  it('UNVERIFIED when the overlap was not caused by the broad pattern (files only, or only a narrow pattern met)', () => {
    const filesOnly = derive(baseItem({ overlaps: [{ with: 's2', via: ['files'], known: false, files: ['a.txt'] }] }), session(['tests/**']), [directive()]);
    assert.equal(filesOnly.directives[0].status, 'unverified');
    const narrowCaused = derive(baseItem({ paths: ['tests/**', 'a.txt'], overlaps: [{ with: 's2', via: ['paths'], known: false, ownPatterns: ['a.txt'] }] }), session(['tests/**', 'a.txt']), [directive()]);
    assert.equal(narrowCaused.directives[0].status, 'unverified');
  });
  it('UNVERIFIED when the claim is not broad, or broad but overlaps nobody', () => {
    const narrow = derive(baseItem({ paths: ['tests/x.test.mjs'] }), session(['tests/x.test.mjs']), [directive()]);
    assert.equal(narrow.directives[0].status, 'unverified');
    const alone = derive(baseItem({ overlaps: [] }), session(['tests/**']), [directive()]);
    assert.equal(alone.directives[0].status, 'unverified');
    assert.equal(verifyDirective(directive(), { obligations: [] }).status, 'unverified');
  });
  it('mixed versions: the kind is in the closed vocabulary here, and an unknown kind is still unsupported, never acted on', () => {
    assert.ok(DIRECTIVE_KINDS.includes('narrow'));
    const mine = classifyDirective({ schemaVersion: 1, ...directive() });
    assert.ok(mine.directive, JSON.stringify(mine));
    // An OLDER reader's vocabulary lacks `narrow`: the same rule files it as unsupported (listed, never actionable).
    const future = classifyDirective({ schemaVersion: 1, ...directive({ kind: 'a-kind-from-the-next-release' }) });
    assert.ok(future.unsupported);
    assert.equal(future.directive, undefined);
    // The REAL compatibility case: a `narrow` record read with the OLD five-kind vocabulary is unsupported, never an error.
    const oldKinds = DIRECTIVE_KINDS.filter((k) => k !== 'narrow');
    const seenByOld = classifyDirective({ schemaVersion: 1, ...directive() }, oldKinds);
    assert.ok(seenByOld.unsupported, JSON.stringify(seenByOld));
    assert.match(seenByOld.unsupported.reason, /not understood/);
    assert.equal(seenByOld.directive, undefined);
  });
});

describe('D3 stale ready marks', () => {
  const DAY = 86_400_000;
  const known = (merged, extra = {}) => ({ known: true, merged, ...extra });
  const item = (id, over = {}) => ({
    id, tracked: true, kind: 'branch', state: 'ready', gen: 1, rev: 3, oid: 'b'.repeat(40), readyStale: true,
    ready: { oid: 'a'.repeat(40), at: new Date(NOW.getTime() - 20 * DAY).toISOString() }, merged: known(false), ...over,
  });
  const pick = (items, days) => staleReadyMarks(items, { now: NOW, ...(days ? { days } : {}) });

  it('lists landed (exact-tip merged evidence) and aged (old mark, moved head) separately', () => {
    const r = pick([item('landed', { merged: known(true, { via: 'pr', pr: 9 }) }), item('aged'), item('fresh', { ready: { oid: 'a'.repeat(40), at: new Date(NOW.getTime() - 2 * DAY).toISOString() } })]);
    assert.deepEqual(r.landed.map((i) => i.id), ['landed']);
    assert.deepEqual(r.aged.map((i) => i.id), ['aged']);
    assert.equal(r.aged[0].class, 'aged');
  });
  it('a branch with commits after the merge ("partially") is NOT landed; it falls to the aged test', () => {
    const r = pick([item('post', { merged: known('partially', { pr: 4 }) })]);
    assert.deepEqual(r.landed, []);
    assert.deepEqual(r.aged.map((i) => i.id), ['post']);
  });
  it('unreadable or absent merged evidence lists the session in NEITHER class', () => {
    const r = pick([item('gh-down', { merged: { known: false, merged: false, reason: 'PR list truncated' } }), item('none', { merged: null })]);
    assert.deepEqual([r.landed, r.aged], [[], []]);
    assert.deepEqual(r.skipped.map((s) => s.id), ['gh-down', 'none']);
    assert.match(r.skipped[0].reason, /unreadable/);
  });
  it('a current mark (head not moved) and a non-ready or untracked item are never listed', () => {
    const r = pick([item('current', { readyStale: false }), item('working', { state: 'working' }), item('untracked', { tracked: false })]);
    assert.deepEqual([r.landed, r.aged, r.skipped], [[], [], []]);
  });
  it('the age cutoff is inclusive at exactly N days; a bad timestamp is skipped, never aged', () => {
    const at = (d) => ({ oid: 'a'.repeat(40), at: new Date(NOW.getTime() - d * DAY).toISOString() });
    assert.equal(pick([item('edge', { ready: at(14) })]).aged.length, 1);
    assert.equal(pick([item('almost', { ready: { oid: 'a'.repeat(40), at: new Date(NOW.getTime() - 14 * DAY + 1).toISOString() } })]).aged.length, 0);
    const bad = pick([item('bad', { ready: { oid: 'a'.repeat(40), at: 'not-a-date' } })]);
    assert.deepEqual(bad.aged, []);
    assert.match(bad.skipped[0].reason, /valid timestamp/);
  });
  it('a PR-sourced session and an unreadable tip are skipped with a reason, in preview as in apply', () => {
    const r = pick([item('pr', { kind: 'pr', merged: known(true) }), item('notip', { oid: null, merged: known(true) })]);
    assert.deepEqual([r.landed, r.aged], [[], []]);
    assert.deepEqual(r.skipped.map((x) => x.id), ['pr', 'notip']);
  });
  it('--days is a whole number 1..3650', () => {
    for (const days of [0, -1, 1.5, 3651, NaN]) assert.throws(() => staleReadyMarks([], { now: NOW, days }), /days must be/);
    assert.doesNotThrow(() => staleReadyMarks([], { now: NOW, days: 3650 }));
  });
});

describe('D3 fleet release --stale-ready through the command', () => {
  /** A repo with two ready sessions on real branches; the evidence the hermetic repo cannot give (merged PRs) is injected. */
  const setup = () => {
    const fx = makeFleetRepo();
    const env = scrubbedEnv({ FLEET_NOW: T0 });
    const dir = fleetDir(fx.repo);
    const run = (args) => runFleet(args, { cwd: fx.repo, env });
    const ctx = { dir, cwd: fx.repo, env, now: NOW, cmd: 'fleet', config: { baseBranch: 'main' } };
    for (const id of ['one', 'two']) {
      assert.equal(run(['claim', '--id', id, '--intent', id, '--paths', `${id}.txt`]).status, 0);
    }
    return { fx, run, ctx, dir, tip: git(['rev-parse', 'refs/heads/main'], fx.repo) };
  };
  const mark = (dir, id, patch) => transact(dir, (t) => t.writeSession({ ...t.sessions.find((s) => s.id === id), ...patch }));
  const itemsFor = (dir, over, tip) => () => {
    const r = transact(dir, (t) => t.sessions).value;
    return r.map((s) => ({
      id: s.id, tracked: true, kind: 'branch', state: s.state, gen: s.gen, rev: s.rev, oid: tip, readyStale: true, ready: s.ready,
      merged: over[s.id] ?? { known: true, merged: false },
    }));
  };
  const old = () => ({ oid: 'a'.repeat(40), at: new Date(NOW.getTime() - 30 * 86_400_000).toISOString() });

  it('is a dry run by default and writes nothing', () => {
    const s = setup();
    mark(s.dir, 'one', { state: 'ready', ready: old(), rev: 5 });
    const r = cmdReleaseStaleReady(s.ctx, {}, { items: itemsFor(s.dir, { one: { known: true, merged: true, via: 'pr', pr: 3 } }, s.tip) });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.landed.map((i) => i.id), ['one']);
    assert.equal(transact(s.dir, (t) => t.sessions.find((x) => x.id === 'one').state).value, 'ready');
  });
  it('rejects --id / --abandoned and a bad --days', () => {
    const s = setup();
    assert.throws(() => cmdReleaseStaleReady(s.ctx, { '--id': 'one' }, { items: () => [] }), /takes no --id or --abandoned/);
    assert.throws(() => cmdReleaseStaleReady(s.ctx, { '--abandoned': true }, { items: () => [] }), /takes no --id or --abandoned/);
    for (const d of ['0', '-3', '2.5', 'abc', '3651']) assert.throws(() => cmdReleaseStaleReady(s.ctx, { '--days': d }, { items: () => [] }), /--days must be/);
  });
  it('--apply retires a landed session, but only INVALIDATES an aged mark (the session and its claim live on)', () => {
    const s = setup();
    mark(s.dir, 'one', { state: 'ready', ready: old(), rev: 5 });
    mark(s.dir, 'two', { state: 'ready', ready: old(), rev: 5 });
    const r = cmdReleaseStaleReady(s.ctx, { '--apply': true }, { items: itemsFor(s.dir, { one: { known: true, merged: true, via: 'pr', pr: 3 } }, s.tip) });
    assert.equal(r.ok, true, r.text);
    const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
    assert.equal(byId.one.retirement, 'retired');
    assert.equal(byId.two.retirement, 'invalidated');
    const sessions = transact(s.dir, (t) => t.sessions).value;
    assert.equal(sessions.find((x) => x.id === 'one').state, 'done');
    const two = sessions.find((x) => x.id === 'two');
    assert.equal(two.state, 'working');
    assert.equal(two.ready, null);
    assert.deepEqual(two.paths, ['two.txt'], 'its claim is intact');
  });
  it('--apply reports a per-item write failure and carries on; it never aborts the command mid-list', () => {
    const s = setup();
    mark(s.dir, 'one', { state: 'ready', ready: old(), rev: 5 });
    mark(s.dir, 'two', { state: 'ready', ready: old(), rev: 5 });
    // The clock's toISOString throws, so the invalidation write (which stamps updatedAt) fails inside the transaction.
    const brokenClock = Object.assign(new Date(NOW), { toISOString() { throw new Error('disk full'); } });
    const r = cmdReleaseStaleReady({ ...s.ctx, now: brokenClock }, { '--apply': true }, { items: itemsFor(s.dir, {}, s.tip) });
    assert.equal(r.ok, false, 'a failed item makes the command a refusal');
    assert.deepEqual(r.results.map((x) => x.retirement), ['failed', 'failed'], 'both were attempted');
    assert.match(r.results[0].reason, /registry write failed \(disk full\)/);
    assert.equal(transact(s.dir, (t) => t.sessions.filter((x) => x.state === 'ready').length).value, 2, 'nothing half-written');
  });
  it('--apply skips an item whose class changed between the listing and the apply (aged -> landed) and one whose record moved', () => {
    const s = setup();
    mark(s.dir, 'one', { state: 'ready', ready: old(), rev: 5 });
    mark(s.dir, 'two', { state: 'ready', ready: old(), rev: 5 });
    let call = 0;
    const flip = () => { call += 1; return itemsFor(s.dir, call === 1 ? {} : { one: { known: true, merged: true, via: 'pr', pr: 3 } }, s.tip)(); };
    // 'two' is touched by its owner after the listing: the record moved.
    const movingItems = () => { const r = flip(); if (call === 1) mark(s.dir, 'two', { rev: 99 }); return r; };
    const r = cmdReleaseStaleReady(s.ctx, { '--apply': true }, { items: movingItems });
    const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
    assert.equal(byId.one.retirement, 'skipped');
    assert.match(byId.one.reason, /class-changed/);
    assert.equal(byId.two.retirement, 'skipped');
    const sessions = transact(s.dir, (t) => t.sessions).value;
    assert.equal(sessions.find((x) => x.id === 'one').state, 'ready', 'nothing was written for either');
    assert.equal(sessions.find((x) => x.id === 'two').state, 'ready');
  });
  it('retiring the repo\'s last live session through the bulk path ends its turn exactly as a single release does', () => {
    const w = world();
    assert.equal(w.runA(['lease', 'acquire', '--for', '30']).status, 0);
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 3);
    assert.equal(w.runA(['lease', 'release']).status, 0);
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 3);
    const dir = fleetDir(w.a.repo);
    mark(dir, 'main', { state: 'ready', ready: { oid: 'a'.repeat(40), at: T0 }, rev: 5 });
    const ctx = { dir, cwd: w.a.repo, env: w.env(), now: NOW, cmd: 'fleet', config: { baseBranch: 'main' } };
    const tip = git(['rev-parse', 'refs/heads/main'], w.a.repo);
    const items = () => [{ id: 'main', tracked: true, kind: 'branch', state: 'ready', gen: 1, rev: 5, oid: tip, readyStale: true, ready: { oid: 'a'.repeat(40), at: T0 }, merged: { known: true, merged: true, via: 'pr', pr: 1 } }];
    const r = cmdReleaseStaleReady(ctx, { '--apply': true }, { items });
    assert.equal(r.ok, true, r.text);
    assert.equal(r.results[0].retirement, 'retired');
    assert.equal(r.results[0].lease, 'ended');
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 0, 'the queued repo goes at once');
  });
});
