/**
 * @fileoverview /fleet CLI, end to end (plan §9) — real throwaway git repos, a
 * bare local `origin`, and a PATH-level fake `gh` (a copy of node answering from a
 * JSON state file; the real `gh` is scrubbed from PATH so it can never be reached).
 *
 * This file: the registry verbs (status/claim/add/ready/touch/hold/start) and the
 * CLI contract. The rest of the suite is split by theme across
 * `tests/fleet-cli-*.test.mjs` because `node --test` runs one file's tests
 * serially, so a single ~1,000 s file was the wall-time floor of `npm test`;
 * the shared harness is `tests/helpers/fleet-cli-harness.mjs`.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { git } from './helpers/git.mjs';
import {
  FLEET_CLI, addBranch, cleanupFleetRoots, commitFile, prRow, runFleet, runFleetAsync, scrubbedEnv, snapshotDir,
  tmpRoot, writeFile,
} from './helpers/fleet-repo.mjs';
import { OK_TIER, fleetDirOf, land, readyBranch, sessionFiles, sessionRec, setup } from './helpers/fleet-cli-harness.mjs';
import { chipNameFor } from '../scripts/lib/fleet/commands.mjs';
import { SessionSchema, writeSession } from '../scripts/lib/fleet/registry.mjs';
import { leaseMsFrom } from '../scripts/lib/fleet/facts.mjs';

after(cleanupFleetRoots);

// ───────────────────────────────────────────────────────────────────────────
describe('CLI contract', () => {
  it('--selfcheck-relocation prints OK and exits 0 before touching anything (even outside a repo)', () => {
    const dir = tmpRoot();
    const r = runFleet(['--selfcheck-relocation'], { cwd: dir, env: scrubbedEnv() });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'OK');
  });

  it('an unknown flag exits 2 naming it; an unknown verb exits 2; no verb exits 2', () => {
    const s = setup();
    const a = s.f(['status', '--bogus']);
    assert.equal(a.status, 2);
    assert.match(a.stderr, /unknown flag "--bogus"/);
    assert.equal(s.f(['claim', '--id', 'x', '--intent', 'i', '--paths', 'a', '--typo']).status, 2);
    assert.equal(s.f(['nonsense']).status, 2);
    for (const inherited of ['toString', 'constructor', 'hasOwnProperty']) assert.equal(s.f([inherited]).status, 2, `${inherited} is not a verb (R1-M3)`);
    assert.equal(s.f([]).status, 2);
    assert.equal(s.f(['claim', '--id']).status, 2, 'a missing value is an argv error');
  });

  it('a malformed train id never reaches a path (land --approve ../x exits 2)', () => {
    const s = setup();
    const r = s.f(['land', '--approve', '../x']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid train id/);
  });

  it('a FLEET_WORKTREE_ROOT inside .git is refused (exit 1)', () => {
    const s = setup();
    const r = s.f(['status'], { env: { FLEET_WORKTREE_ROOT: path.join(s.fx.repo, '.git', 'wt') } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /inside the git directory/);
  });

  it('a land verb combination is refused (two modes, or --accept-rerun without --approve)', () => {
    const s = setup();
    assert.equal(s.f(['land', '--approve', 't-20260101000000-abcd', '--abandon', 't-20260101000000-abcd']).status, 2);
    assert.equal(s.f(['land', '--accept-rerun']).status, 2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('status is strictly read-only and never guesses', () => {
  it('with gh absent, PRs render as "not queried" — never an empty list', () => {
    const s = setup();
    const r = s.f(['status']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PRs: not queried \(gh not installed\)/);
    const j = s.f(['status', '--json']);
    assert.equal(j.json.status.sources.prs.queried, false);
    assert.equal(j.json.status.sources.prs.reason, 'gh not installed');
  });

  it('gh present but unauthenticated is reported with its reason', () => {
    const s = setup({ gh: true });
    s.fake.setState({ authFail: true });
    assert.match(s.f(['status']).stdout, /PRs: not queried \(gh not authenticated\)/);
  });

  it('leaves every registry file byte-identical, and creates no registry on a fresh repo', () => {
    const s = setup();
    assert.equal(s.f(['status']).status, 0);
    assert.equal(fs.existsSync(fleetDirOf(s.fx)), false, 'status must not even create fleet/');
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    s.f(['hold', 'on', '--reason', 'busy']);
    const before = snapshotDir(fleetDirOf(s.fx));
    assert.ok(Object.keys(before).length >= 2);
    assert.equal(s.f(['status']).status, 0);
    assert.equal(s.f(['status', '--json']).status, 0);
    assert.deepEqual(snapshotDir(fleetDirOf(s.fx)), before);
  });

  it('shows tracked, untracked and a missing-worktree session without dropping any', () => {
    const s = setup();
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    addBranch(s.fx.repo, 'untracked-b', { 'b.txt': 'B\n' });
    const r = s.f(['status', '--json']);
    const ids = r.json.status.items.map((i) => i.id);
    assert.ok(ids.includes('feat-a') && ids.includes('untracked-b'));
    assert.equal(r.json.status.items.find((i) => i.id === 'untracked-b').state, 'untracked');
    assert.equal(r.json.status.items.find((i) => i.id === 'feat-a').display, 'ready');
  });

  it('a stale ready (head moved after `ready`) is flagged and land refuses it', () => {
    const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers: [OK_TIER] } } });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    git(['checkout', '-q', 'feat-a'], s.fx.repo);
    commitFile(s.fx.repo, 'a2.txt', 'more\n');
    git(['checkout', '-q', 'main'], s.fx.repo);
    assert.match(s.f(['status']).stdout, /ready \(stale — head moved\)/);
    const r = land(s);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /nothing is ready to land/);
  });

  it('a status hook\'s findings render advisory (block-level never fails the read) and a broken hook never fails it either', () => {
    const s = setup({ fleetConfig: { checks: [
      { name: 'sem', script: 'hook.mjs', runner: ['node'], runIn: ['status'], severity: 'block' },
      { name: 'broken', script: 'nope.mjs', runIn: ['status'], severity: 'block' },
    ] } });
    writeFile(s.fx.repo, 'hook.mjs', `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(path.join(s.fx.root, 'hook-stdin.json'))},b);
      process.stdout.write(JSON.stringify({schemaVersion:1,findings:[{level:'block',message:'both bump the contract hash',sessions:['feat-a']}]}));});`.replace('require(\'node:fs\')', 'process.getBuiltinModule(\'node:fs\')'));
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    s.f(['touch', '--id', 'feat-a', '--waiting-on', 'human:louis:please review']);
    const r = s.f(['status']);
    assert.equal(r.status, 0, 'status never fails on a block-level finding');
    assert.match(r.stdout, /block: \[sem\] both bump the contract hash/);
    assert.match(r.stdout, /check "broken" failed to run/);
    const stdin = JSON.parse(fs.readFileSync(path.join(s.fx.root, 'hook-stdin.json'), 'utf8'));
    assert.equal(stdin.phase, 'status');
    assert.deepEqual(stdin.sessions.find((x) => x.id === 'feat-a').waitingOn.map((w) => `${w.kind}:${w.ref}`), ['human:louis']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('claim: the duplicate gate', () => {
  it('registers a new session; a NEW chip overlapping a live claim is BLOCKED (exit 3), nothing written', () => {
    const s = setup();
    assert.equal(s.f(['claim', '--id', 'a', '--intent', 'csv export', '--paths', 'src/export/**,src/results/table.mjs']).status, 0);
    const before = snapshotDir(fleetDirOf(s.fx));
    const r = s.f(['claim', '--id', 'b', '--intent', 'different words', '--paths', 'src/results/*.mjs', '--json']);
    assert.equal(r.status, 3);
    assert.equal(r.json.verdict, 'blocked');
    assert.equal(r.json.conflicts[0].with, 'a');
    assert.deepEqual(snapshotDir(fleetDirOf(s.fx)), before, 'a blocked claim writes nothing');
  });

  it('identical normalised intent also blocks a new chip', () => {
    const s = setup();
    s.f(['claim', '--id', 'a', '--intent', 'Add   CSV export', '--paths', 'x/**']);
    const r = s.f(['claim', '--id', 'b', '--intent', 'add csv EXPORT', '--paths', 'y/**', '--json']);
    assert.equal(r.status, 3);
    assert.deepEqual(r.json.conflicts[0].via, ['intent']);
  });

  it('a RUNNING session (existing non-terminal record) gets an advisory warning, exit 0', () => {
    const s = setup();
    s.f(['claim', '--id', 'a', '--intent', 'one', '--paths', 'src/a/**']);
    s.f(['claim', '--id', 'b', '--intent', 'two', '--paths', 'src/b/**']);
    const r = s.f(['claim', '--id', 'b', '--paths', 'src/b/**,src/a/x.mjs', '--json']);
    assert.equal(r.status, 0);
    assert.equal(r.json.verdict, 'warn');
    assert.equal(r.json.mode, 'adopt');
    assert.equal(sessionRec(s.fx, 'b').rev, 2);
  });

  it('--override records a knownOverlap on BOTH records in one transaction and proceeds', () => {
    const s = setup();
    s.f(['claim', '--id', 'a', '--intent', 'one', '--paths', 'src/a/**']);
    const r = s.f(['claim', '--id', 'b', '--intent', 'two', '--paths', 'src/a/y.mjs', '--override', '--json']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.json.overridden, true);
    assert.deepEqual(sessionRec(s.fx, 'b').knownOverlaps.map((k) => k.with), ['a']);
    assert.deepEqual(sessionRec(s.fx, 'a').knownOverlaps.map((k) => k.with), ['b']);
    assert.equal(sessionRec(s.fx, 'a').rev, 2);
    // known pairs are not re-flagged for the next new chip... but a third chip still conflicts with both
    assert.equal(s.f(['claim', '--id', 'c', '--intent', 'three', '--paths', 'src/a/z.mjs']).status, 3);
  });

  it('rejects a pattern outside the closed grammar at claim time, naming the character (exit 2)', () => {
    const s = setup();
    for (const bad of ['{a,b}/x', '[x]/y', '!x', '/abs', '../up']) {
      const r = s.f(['claim', '--id', 'a', '--intent', 'i', '--paths', bad]);
      assert.equal(r.status, 2, bad);
    }
    assert.match(s.f(['claim', '--id', 'a', '--intent', 'i', '--paths', 'a/{b}']).stderr, /"\{"/);
  });

  it('a NEW --id on a branch that already has commits still goes through the new gate', () => {
    const s = setup();
    s.f(['claim', '--id', 'a', '--intent', 'one', '--paths', 'src/a/**']);
    addBranch(s.fx.repo, 'advanced', { 'src/a/y.mjs': 'y\n' });
    git(['checkout', '-q', 'advanced'], s.fx.repo);
    const r = s.f(['claim', '--id', 'shared-tree-session', '--intent', 'late', '--paths', 'src/a/**', '--json']);
    assert.equal(r.status, 3);
    assert.equal(r.json.mode, 'new');
  });

  it('a reused id over a DONE record is admitted through the new gate with gen bumped', () => {
    const s = setup();
    s.f(['claim', '--id', 'again', '--intent', 'first life', '--paths', 'src/q/**']);
    const dir = fleetDirOf(s.fx);
    const rec = sessionRec(s.fx, 'again');
    writeSession(dir, SessionSchema.parse({ ...rec, rev: rec.rev + 1, state: 'done', ready: { oid: 'a'.repeat(40), at: new Date().toISOString() } }));
    s.f(['claim', '--id', 'other', '--intent', 'blocker', '--paths', 'src/q/**', '--override']); // would conflict with a live 'again'; done does not block
    const r = s.f(['claim', '--id', 'again', '--intent', 'second life', '--paths', 'src/zzz/**', '--json']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.json.mode, 'new');
    assert.equal(r.json.record.gen, 2);
    assert.equal(r.json.record.ready, null);
    assert.equal(r.json.record.state, 'working');
  });

  it('two concurrent claims for overlapping new sessions: exactly one admitted, one blocked', async () => {
    const s = setup();
    const run = (id) => runFleetAsync(['claim', '--id', id, '--intent', `intent ${id}`, '--paths', 'shared/**', '--json'], { cwd: s.fx.repo, env: s.env });
    const [x, y] = await Promise.all([run('p1'), run('p2')]);
    assert.deepEqual([x.status, y.status].sort(), [0, 3], `${x.stdout}${x.stderr}${y.stdout}${y.stderr}`);
    assert.equal(sessionFiles(s.fx).length, 1);
  });

  it('a corrupted record: status renders under a banner (exit 0), admission is REFUSED (exit 3) until repair --quarantine', () => {
    const s = setup();
    s.f(['claim', '--id', 'a', '--intent', 'one', '--paths', 'src/a/**']);
    writeFile(s.fx.repo, '.git/fleet/sessions/junk.json', '{not json');
    const st = s.f(['status']);
    assert.equal(st.status, 0);
    assert.match(st.stdout, /registry incomplete: 1 record unreadable/);
    const blocked = s.f(['claim', '--id', 'b', '--intent', 'two', '--paths', 'src/b/**', '--json']);
    assert.equal(blocked.status, 3);
    assert.equal(blocked.json.verdict, 'refused');
    assert.match(blocked.json.reason, /registry incomplete/);
    const rep = s.f(['repair', '--quarantine', 'junk.json']);
    assert.equal(rep.status, 0, rep.stdout);
    assert.ok(fs.existsSync(path.join(fleetDirOf(s.fx), 'quarantine')));
    assert.equal(s.f(['claim', '--id', 'b', '--intent', 'two', '--paths', 'src/b/**']).status, 0);
  });

  it('lease: an expired lease with no branch activity is stale and does not block; a fresh tip commit keeps it live', () => {
    const s = setup();
    const old = '2020-01-01T00:00:00Z';
    // stale branch: old tip commit + a claim made "in 2020"
    git(['checkout', '-q', '-b', 'old-work', 'main'], s.fx.repo);
    writeFile(s.fx.repo, 'old.txt', 'o\n'); git(['add', 'old.txt'], s.fx.repo);
    execFileSync('git', ['commit', '-q', '-m', 'old'], { cwd: s.fx.repo, env: { ...process.env, GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old } });
    assert.equal(s.f(['claim', '--id', 'old-work', '--intent', 'ancient', '--paths', 'src/stale/**'], { env: { FLEET_NOW: old } }).status, 0);
    git(['checkout', '-q', 'main'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'newer', '--intent', 'fresh', '--paths', 'src/stale/**']).status, 0, 'stale claim must not block');
    assert.match(s.f(['status']).stdout, /old-work.*stale/);
    // live via branch activity: lease expired (2020) but the tip commit is fresh
    git(['checkout', '-q', '-b', 'busy', 'main'], s.fx.repo);
    commitFile(s.fx.repo, 'busy.txt', 'b\n');
    assert.equal(s.f(['claim', '--id', 'busy', '--intent', 'busy bee', '--paths', 'src/busy/**'], { env: { FLEET_NOW: old } }).status, 0);
    git(['checkout', '-q', 'main'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'rival', '--intent', 'rival', '--paths', 'src/busy/**']).status, 3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('add, ready, touch, hold, waitingOn', () => {
  it('add <branch> adopts with intent from the last commit subject; adoption never blocks', () => {
    const s = setup();
    addBranch(s.fx.repo, 'feat-x', { 'x.txt': 'x\n' }, 'Add the x feature');
    const r = s.f(['add', 'feat-x', '--json']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(sessionRec(s.fx, 'feat-x').intent, 'Add the x feature');
    assert.equal(sessionRec(s.fx, 'feat-x').startOid, git(['rev-parse', 'main'], s.fx.repo));
    assert.equal(s.f(['add', 'feat-x']).status, 0, 'adding again is a skip, not an error');
    assert.equal(s.f(['add']).status, 2);
  });

  it('add --all adopts every untracked branch ahead of base', () => {
    const s = setup();
    addBranch(s.fx.repo, 'b1', { 'b1.txt': '1\n' });
    addBranch(s.fx.repo, 'b2', { 'b2.txt': '2\n' });
    const r = s.f(['add', '--all', '--json']);
    assert.deepEqual(r.json.added.sort(), ['b1', 'b2']);
  });

  it('add #PR needs gh: refused with the reason when not queried; adopts the PR identity when queried', () => {
    const noGh = setup();
    assert.equal(noGh.f(['add', '#7']).status, 3);
    const s = setup({ gh: true });
    const oid = addBranch(s.fx.repo, 'pr-branch', { 'p.txt': 'p\n' });
    s.fake.setState({ list: [prRow({ number: 7, branch: 'pr-branch', headOid: oid, baseOid: git(['rev-parse', 'main'], s.fx.repo) })] });
    const r = s.f(['add', '#7', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const rec = sessionRec(s.fx, 'pr-7');
    assert.deepEqual([rec.source.kind, rec.source.prNumber, rec.source.repo, rec.source.baseRef], ['pr', 7, 'o/n', 'main']);
  });

  it('touch/ready renew the lease and bump rev; ready on an unknown session is refused', () => {
    const s = setup();
    assert.equal(s.f(['ready', '--id', 'ghost']).status, 3);
    assert.equal(s.f(['touch', '--id', 'ghost']).status, 3);
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const rec = sessionRec(s.fx, 'feat-a');
    assert.equal(rec.state, 'ready');
    assert.equal(rec.ready.oid, git(['rev-parse', 'feat-a'], s.fx.repo));
    const rev = rec.rev;
    s.f(['touch', '--id', 'feat-a']);
    assert.equal(sessionRec(s.fx, 'feat-a').rev, rev + 1);
  });

  it('hold on/off round-trips and status shows it', () => {
    const s = setup();
    s.f(['hold', 'on', '--reason', 'CI is hot']);
    assert.match(s.f(['status']).stdout, /HOLD on heavy runs.*CI is hot/);
    s.f(['hold', 'off']);
    assert.doesNotMatch(s.f(['status']).stdout, /HOLD on heavy runs/);
    assert.equal(s.f(['hold', 'maybe']).status, 2);
  });

  it('waitingOn: set / clear round-trips under the registry transaction; invalid refs and long notes are rejected', () => {
    const s = setup();
    s.f(['claim', '--id', 'w', '--intent', 'wait', '--paths', 'w/**', '--waiting-on', 'session:other:needs the refactor', '--waiting-on', 'human:louis']);
    assert.deepEqual(sessionRec(s.fx, 'w').waitingOn.map((x) => `${x.kind}:${x.ref}`), ['session:other', 'human:louis']);
    assert.equal(sessionRec(s.fx, 'w').waitingOn[0].note, 'needs the refactor');
    assert.equal(sessionRec(s.fx, 'w').state, 'working', 'a non-empty waitingOn does not change state');
    s.f(['touch', '--id', 'w', '--clear-waiting']);
    assert.deepEqual(sessionRec(s.fx, 'w').waitingOn, []);
    assert.equal(s.f(['touch', '--id', 'w', '--waiting-on', 'bogus:x']).status, 2, 'unknown kind');
    assert.equal(s.f(['touch', '--id', 'w', '--waiting-on', 'train:not-a-train']).status, 2, 'train ref must be a train id');
    assert.equal(s.f(['touch', '--id', 'w', '--waiting-on', `human:x:${'n'.repeat(501)}`]).status, 2, 'note over 500 chars');
    assert.equal(s.f(['touch', '--id', 'w', '--waiting-on', `human:${'r'.repeat(201)}`]).status, 2, 'ref over 200 chars');
    assert.equal(s.f(['touch', '--id', 'w', '--waiting-on', 'nocolon']).status, 2);
  });

  it('--clear-waiting with --waiting-on keeps the AGE of a wait it re-adds, drops the ones not re-added, and stamps only a new wait now (p-35d6)', () => {
    const s = setup();
    const t0 = '2026-10-10T08:00:00.000Z'; const t1 = '2026-10-12T09:30:00.000Z';
    assert.equal(s.f(['claim', '--id', 'w', '--intent', 'wait', '--paths', 'w/**', '--waiting-on', 'human:account-switch', '--waiting-on', 'session:other:needs it'], { env: { FLEET_NOW: t0 } }).status, 0);
    const before = sessionRec(s.fx, 'w').waitingOn;
    assert.deepEqual(before.map((x) => x.since), [t0, t0]);
    // The handover-receive recipe: clear the switch wait by clearing everything and re-adding the OTHER waits.
    const r = s.f(['touch', '--id', 'w', '--clear-waiting', '--waiting-on', 'session:other:needs it', '--waiting-on', 'human:louis'], { env: { FLEET_NOW: t1 } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = sessionRec(s.fx, 'w').waitingOn;
    assert.deepEqual(after.map((x) => `${x.kind}:${x.ref}`), ['session:other', 'human:louis'], 'the switch wait is gone');
    assert.equal(after[0].since, t0, 'a re-added wait keeps the age it already had (it was not restarted by clearing its neighbour)');
    assert.equal(after[0].note, 'needs it');
    assert.equal(after[1].since, t1, 'a genuinely new wait starts now');
    // Without --clear-waiting the re-add of an existing wait also keeps its age.
    s.f(['touch', '--id', 'w', '--waiting-on', 'human:louis'], { env: { FLEET_NOW: '2026-10-13T00:00:00.000Z' } });
    assert.equal(sessionRec(s.fx, 'w').waitingOn.find((x) => x.ref === 'louis').since, t1);
  });

  it('a session-kind waiting ref that is done or gone renders unblocked?, and human items sort first', () => {
    const s = setup();
    s.f(['claim', '--id', 'w', '--intent', 'wait', '--paths', 'w/**', '--waiting-on', 'session:vanished']);
    s.f(['claim', '--id', 'h', '--intent', 'ask', '--paths', 'h/**', '--waiting-on', 'human:louis']);
    const r = s.f(['status', '--json']);
    const w = r.json.status.items.find((i) => i.id === 'w');
    assert.equal(w.waitingOn[0].unblocked, 'unblocked?');
    assert.equal(r.json.status.items[0].id, 'h', 'needs-the-human first');
    assert.match(s.f(['status']).stdout, /WAITING: session:vanished \(unblocked\?\)/);
  });

  it('landing order puts a waiting session after its dependency; a waiting cycle is reported and ordered by id', () => {
    const s = setup();
    readyBranch(s, 'alpha', { 'a.txt': 'A\n' });
    readyBranch(s, 'zeta', { 'c.txt': 'Z\n' });
    git(['checkout', '-q', 'alpha'], s.fx.repo);
    s.f(['touch', '--id', 'alpha', '--waiting-on', 'session:zeta']);
    git(['checkout', '-q', 'main'], s.fx.repo);
    assert.deepEqual(s.f(['status', '--json']).json.status.landingOrder, ['zeta', 'alpha']);
    s.f(['touch', '--id', 'zeta', '--waiting-on', 'session:alpha']);
    const r = s.f(['status', '--json']);
    assert.deepEqual(r.json.status.cycles, [['alpha', 'zeta']]);
    assert.equal(r.json.status.landingOrder.length, 2);
    assert.match(s.f(['status']).stdout, /waiting cycle: alpha ↔ zeta/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('start: one atomic batch', () => {
  const gitWorktrees = (fx) => git(['worktree', 'list', '--porcelain'], fx.repo).split('\n').filter((l) => l.startsWith('worktree ')).length;

  it('creates a worktree + record per task; --paths binds to the PRECEDING --task; prompts embed the participant rules', () => {
    const s = setup();
    const r = s.f(['start', '--task', 'fix the parser', '--task', 'add csv export', '--paths', 'src/export/**,docs/csv.md', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.chips.length, 2);
    const [c1, c2] = r.json.chips;
    assert.deepEqual(c1.paths, []);
    assert.deepEqual(c2.paths, ['src/export/**', 'docs/csv.md']);
    assert.equal(gitWorktrees(s.fx), 3);
    for (const c of r.json.chips) assert.ok(fs.existsSync(c.worktree));
    const rec = sessionRec(s.fx, c2.id);
    assert.equal(rec.startOid, git(['rev-parse', 'main'], s.fx.repo), 'startOid is the resolved base oid');
    assert.deepEqual(rec.paths, ['src/export/**', 'docs/csv.md']);
    assert.equal(rec.worktree, c2.worktree);
    const human = s.f(['start', '--task', 'third thing']);
    assert.match(human.stdout, /fleet is COOPERATIVE/);
    assert.match(human.stdout, /Never use --override yourself/);
  });

  it('two tasks in ONE batch declaring overlapping paths block the whole batch: zero worktrees, zero records', () => {
    const s = setup();
    const before = gitWorktrees(s.fx);
    const r = s.f(['start', '--task', 'one', '--paths', 'src/a/**', '--task', 'two', '--paths', 'src/a/x.mjs', '--json']);
    assert.equal(r.status, 3);
    assert.equal(r.json.verdict, 'blocked');
    assert.equal(gitWorktrees(s.fx), before);
    assert.equal(sessionFiles(s.fx).length, 0);
    assert.equal(fs.existsSync(path.join(s.fx.wtRoot, 'chips')), false, 'nothing on the filesystem either');
  });

  it('a conflict with an EXISTING live claim blocks the whole batch (the new-session gate applies to start)', () => {
    const s = setup();
    s.f(['claim', '--id', 'a', '--intent', 'one', '--paths', 'src/a/**']);
    const r = s.f(['start', '--task', 'harmless', '--paths', 'other/**', '--task', 'collides', '--paths', 'src/a/z.mjs', '--json']);
    assert.equal(r.status, 3);
    assert.equal(sessionFiles(s.fx).length, 1, 'only the pre-existing record');
    assert.equal(gitWorktrees(s.fx), 1);
  });

  it('worktree creation failing on task 2 of 3 removes task 1\'s worktree and branch and writes NO records', () => {
    const s = setup();
    const t = ['one', 'two', 'three'];
    const blocker = path.join(s.fx.wtRoot, 'chips', chipNameFor(t[1], 1));
    fs.mkdirSync(blocker, { recursive: true });
    fs.writeFileSync(path.join(blocker, 'in-the-way.txt'), 'x');
    const r = s.f(['start', '--task', t[0], '--task', t[1], '--task', t[2], '--json']);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.json.reason, /no record was written/);
    assert.equal(gitWorktrees(s.fx), 1, 'task 1\'s worktree was rolled back');
    assert.equal(fs.existsSync(path.join(s.fx.wtRoot, 'chips', chipNameFor(t[0], 0))), false);
    assert.equal(git(['branch', '--list', `fleet/${chipNameFor(t[0], 0)}`], s.fx.repo), '', 'and so was its branch');
    assert.equal(sessionFiles(s.fx).length, 0);
  });
});

describe('FLEET_LEASE_HOURS is parsed strictly', () => {
  it('valid values; unset is the default; everything else is a ConfigError', () => {
    assert.equal(leaseMsFrom({}), 4 * 3_600_000);
    assert.equal(leaseMsFrom({ FLEET_LEASE_HOURS: '1' }), 3_600_000);
    assert.equal(leaseMsFrom({ FLEET_LEASE_HOURS: '0.5' }), 1_800_000);
    assert.equal(leaseMsFrom({ FLEET_LEASE_HOURS: '720' }), 720 * 3_600_000);
    for (const bad of ['24hours', '0', '-1', 'NaN', '', ' 4', '1e3', '721', 'Infinity', '4h']) {
      assert.throws(() => leaseMsFrom({ FLEET_LEASE_HOURS: bad }), (e) => e.name === 'ConfigError' && /FLEET_LEASE_HOURS/.test(e.message), JSON.stringify(bad));
    }
  });

  it('end to end: an invalid value exits 1 naming the variable; a valid one sets the lease', () => {
    const s = setup();
    const bad = s.f(['status'], { env: { FLEET_LEASE_HOURS: '24hours' } });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /FLEET_LEASE_HOURS="24hours" is invalid/);
    const now = '2026-10-05T10:00:00Z';
    const ok = s.f(['claim', '--id', 'a', '--intent', 'i', '--paths', 'p/**', '--json'], { env: { FLEET_LEASE_HOURS: '1', FLEET_NOW: now } });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(ok.json.record.leaseExpiresAt, '2026-10-05T11:00:00.000Z');
  });
});

describe('fleet.mjs entry', () => {
  it('the CLI file is the one under test', () => { assert.ok(fs.existsSync(FLEET_CLI)); });
});
