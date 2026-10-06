/**
 * @fileoverview /fleet CLI, end to end (plan §9) — real throwaway git repos, a
 * bare local `origin`, and a PATH-level fake `gh` (a copy of node answering from a
 * JSON state file; the real `gh` is scrubbed from PATH so it can never be reached).
 *
 * Structure: registry verbs (status/claim/add/ready/touch/hold/start/repair),
 * then the train (build, tiers, approve refusals, direct modes, crash/reconcile,
 * pr mode, confirm, abandon, resume).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { git } from './helpers/git.mjs';
import {
  FLEET_CLI, addBranch, cleanupFleetRoots, commitFile, installFakeGh, makeFleetRepo, prRow, runFleet, runFleetAsync,
  scrubbedEnv, snapshotDir, tmpRoot, writeFile,
} from './helpers/fleet-repo.mjs';
import { chipNameFor } from '../scripts/lib/fleet/commands.mjs';
import { resolveConfig } from '../scripts/lib/fleet/config.mjs';
import { SessionSchema, listTrains, readSessions, readTrain, writeSession } from '../scripts/lib/fleet/registry.mjs';
import { PR_APPROVE_FIELDS, approveTrain } from '../scripts/lib/fleet/train-approve.mjs';
import { PR_VIEW_FIELDS } from '../scripts/lib/fleet/gh-facts.mjs';
import {
  UNSAFE_WIN_SHELL_ARGV, buildTrain, defaultDeps, pathsEqual, removeTrainWorktree, resolveTierSpawn, unsafeWinShellArgv, withTrainLock,
} from '../scripts/lib/fleet/train.mjs';
import { parseVerbArgs } from '../scripts/lib/fleet/argv.mjs';
import { parseSelect } from '../scripts/lib/fleet/land.mjs';
import { quoteArg, renderCommand } from '../scripts/lib/fleet/shell-quote.mjs';
import {
  renderApprove, renderBuilt, renderChipPrompt, renderDryRun, renderOpenTrains, renderParticipantRules, renderReconcile,
} from '../scripts/lib/fleet/render-train.mjs';
import { startOidFor } from '../scripts/lib/fleet/commands.mjs';
import { leaseMsFrom, needsEvidenceKey, resolveUpstream } from '../scripts/lib/fleet/facts.mjs';

after(cleanupFleetRoots);

const OK_TIER = { name: 'default', command: ['node', '-e', 'process.exit(0)'] };
const fwd = (p) => p.replace(/\\/g, '/');
const fleetDirOf = (fx) => path.join(fx.repo, '.git', 'fleet');

/** A fixture plus a bound `f(args)` runner. `gh:false` leaves gh absent (PATH scrubbed). */
function setup({ fleetConfig = null, gh = false, files } = {}) {
  const fx = makeFleetRepo({ fleetConfig, ...(files ? { files } : {}) });
  const fake = gh ? installFakeGh(fx.root) : null;
  const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, ...(fake ? fake.env : {}) }, { prependPath: fake ? [fake.bin] : [] });
  const f = (args, o = {}) => runFleet(args, { cwd: o.cwd ?? fx.repo, env: { ...env, ...(o.env ?? {}) } });
  return { fx, env, f, fake, config: () => resolveConfig(fx.repo, { env }) };
}

/** Create `name`, claim it (paths default to `<name>/**`) and mark it ready; ends on main. */
function readyBranch(s, name, files, { paths = `${name}/**`, intent = `work on ${name}` } = {}) {
  const oid = addBranch(s.fx.repo, name, files);
  git(['checkout', '-q', name], s.fx.repo);
  const c = s.f(['claim', '--id', name, '--intent', intent, '--paths', paths, '--json']);
  assert.equal(c.status, 0, `claim ${name}: ${c.stdout}${c.stderr}`);
  const r = s.f(['ready', '--id', name, '--json']);
  assert.equal(r.status, 0, `ready ${name}: ${r.stdout}${r.stderr}`);
  git(['checkout', '-q', 'main'], s.fx.repo);
  return oid;
}

const originLog = (fx, ref = 'main') => git(['--git-dir', fx.origin, 'log', '--format=%s', ref], fx.root).split('\n');
const sessionFiles = (fx) => {
  try { return fs.readdirSync(path.join(fleetDirOf(fx), 'sessions')).filter((n) => n.endsWith('.json')); } catch (e) {
    if (e.code === 'ENOENT') return []; // only "no such directory" means "no sessions"
    throw e;
  }
};
const sessionRec = (fx, id) => readSessions(fleetDirOf(fx)).sessions.find((x) => x.id === id);
const land = (s, extra = []) => s.f(['land', '--json', ...extra]);

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

// ───────────────────────────────────────────────────────────────────────────
describe('land (direct-squash against a bare origin)', () => {
  const cfg = (tiers = [OK_TIER], extra = {}) => ({ mergeMethod: 'direct-squash', testCommand: { tiers }, ...extra });

  function twoReady(over = {}) {
    const s = setup({ fleetConfig: cfg(over.tiers, over.extra) });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' }, {});
    readyBranch(s, 'feat-b', { 'b.txt': 'B\n' }, {});
    return s;
  }

  it('green: one combined run; approve pushes ONE commit per branch to origin to the recorded pushUrl; sessions become done', () => {
    const s = twoReady();
    const built = land(s);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const t = built.json.train;
    assert.equal(t.phase, 'tested');
    assert.equal(t.result, 'green');
    assert.equal(t.mergeMethod, 'direct-squash');
    assert.equal(t.destination.ref, 'refs/heads/main');
    assert.equal(t.destination.pushUrl, s.fx.origin);
    assert.equal(t.destination.expectedOid, git(['rev-parse', 'main'], s.fx.repo));
    assert.deepEqual(t.sources.map((x) => x.id).sort(), ['feat-a', 'feat-b']);
    assert.ok(t.candidate.oid && t.candidate.tree);
    assert.equal(path.dirname(t.worktree), s.fx.wtRoot, 'the worktree is under the configured root, outside .git');
    assert.ok(!fwd(t.worktree).includes('/.git/'));
    assert.match(built.json.text, /A green train does not prove each branch green alone/);
    assert.match(built.json.text, /land --approve t-\d{14}-[0-9a-f]{4}/);
    const before = git(['rev-parse', 'main'], s.fx.repo);
    assert.equal(git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root), before, 'build never touches the base');

    const ap = s.f(['land', '--approve', t.trainId, '--json']);
    assert.equal(ap.status, 0, ap.stdout + ap.stderr);
    assert.equal(ap.json.train.phase, 'landed');
    assert.equal(git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root), t.candidate.oid, 'the pushed commit IS the tested candidate');
    const log = originLog(s.fx);
    assert.equal(log.length, 3, 'init + one commit per branch');
    assert.deepEqual(log.slice(0, 2).sort(), ['work on feat-a', 'work on feat-b']);
    assert.equal(fs.existsSync(t.worktree), false, 'the worktree is removed only after landed');
    assert.equal(ap.json.pushArgv[0], 'git');
    assert.equal(ap.json.pushArgv[2], s.fx.origin, 'pushed to the recorded URL, not the remote name');
    assert.ok(ap.json.pushArgv.some((a) => a === `--force-with-lease=refs/heads/main:${t.destination.expectedOid}`));
    // session finalisation: derived AND cached by the mutating verb
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'done');
    assert.equal(sessionRec(s.fx, 'feat-b').state, 'done');
    // a landed session no longer blocks admission
    assert.equal(s.f(['claim', '--id', 'newcomer', '--intent', 'fresh', '--paths', 'feat-a/**']).status, 0);
  });

  it('approving an already-landed train is refused naming the state', () => {
    const s = twoReady();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    const again = s.f(['land', '--approve', t.trainId, '--json']);
    assert.equal(again.status, 3);
    assert.match(again.json.reason, /train is landed/);
  });

  it('a session whose rev moved after the train was built is NOT derived done', () => {
    const s = twoReady();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    // the session records change (rev bump) after the train was built
    const dir = fleetDirOf(s.fx);
    for (const id of ['feat-a', 'feat-b']) {
      const cur = sessionRec(s.fx, id);
      fs.writeFileSync(path.join(dir, 'sessions', fs.readdirSync(path.join(dir, 'sessions')).find((n) => n.startsWith(id))), `${JSON.stringify({ ...cur, state: 'ready', rev: cur.rev + 1 }, null, 2)}\n`);
    }
    // rev moved after the train was built -> NOT derived done
    assert.notEqual(s.f(['status', '--json']).json.status.items.find((i) => i.id === 'feat-a').state, 'done');
  });

  it('derived done when the rev is untouched: status derives it WITHOUT writing (byte-identical registry)', () => {
    const s = twoReady();
    const t = land(s).json.train;
    // land the train by writing ONLY the train record (as if the process died right after) — via a real approve in-process, with the cache write skipped
    const cfgObj = s.config();
    const dir = fleetDirOf(s.fx);
    const r = approveTrain({ cwd: s.fx.repo, trainId: t.trainId, doneCache: false, deps: defaultDeps({ log: () => {} }) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'ready', 'no cache was written (doneCache:false)');
    const before = snapshotDir(dir);
    const st = s.f(['status', '--json']);
    assert.equal(st.json.status.items.find((i) => i.id === 'feat-a').state, 'done', 'derived on read');
    assert.deepEqual(snapshotDir(dir), before, 'status wrote nothing even though derivation would change a state');
    void cfgObj;
  });

  it('a session that commits after landing, without any fleet command, is NOT done; a deleted source branch is', () => {
    const s = twoReady();
    const t = land(s).json.train;
    const dir = fleetDirOf(s.fx);
    approveTrain({ cwd: s.fx.repo, trainId: t.trainId, doneCache: false, deps: defaultDeps({ log: () => {} }) });
    git(['checkout', '-q', 'feat-a'], s.fx.repo);
    commitFile(s.fx.repo, 'late.txt', 'late\n');
    git(['checkout', '-q', 'main'], s.fx.repo);
    git(['branch', '-D', 'feat-b'], s.fx.repo);
    const items = s.f(['status', '--json']).json.status.items;
    assert.notEqual(items.find((i) => i.id === 'feat-a').state, 'done');
    assert.match(items.find((i) => i.id === 'feat-a').notes.join(' '), /newer commits exist/);
    assert.equal(items.find((i) => i.id === 'feat-b').state, 'done');
    void dir;
  });

  it('red then green on rerun: green-after-rerun; approve is refused WITHOUT --accept-rerun and allowed with it', () => {
    const marker = fwd(path.join(tmpRoot(), 'flaky'));
    const flaky = { name: 'default', command: ['node', '-e', `const f=require('fs');if(!f.existsSync('${marker}')){f.writeFileSync('${marker}','1');process.exit(1)}process.exit(0)`] };
    const s = twoReady({ tiers: [flaky] });
    const t = land(s).json.train;
    assert.equal(t.result, 'green-after-rerun');
    const refused = s.f(['land', '--approve', t.trainId, '--json']);
    assert.equal(refused.status, 3);
    assert.match(refused.json.reason, /--accept-rerun/);
    const ok = s.f(['land', '--approve', t.trainId, '--accept-rerun', '--json']);
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.json.text, /first run failed; passed on rerun — possible flake/);
  });

  it('persistent red: the train is built, NOT approvable, and approve is refused naming the state', () => {
    const s = twoReady({ tiers: [{ name: 'default', command: ['node', '-e', 'process.exit(1)'] }] });
    const r = land(s);
    assert.equal(r.status, 3);
    assert.equal(r.json.train.result, 'red');
    const ap = s.f(['land', '--approve', r.json.train.trainId, '--json']);
    assert.equal(ap.status, 3);
    assert.match(ap.json.reason, /red/);
    assert.equal(git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root), git(['rev-parse', 'main'], s.fx.repo), 'nothing pushed');
  });

  it('a test command that rewrites a tracked file is DIRTY, never approvable', () => {
    const s = twoReady({ tiers: [{ name: 'default', command: ['node', '-e', "require('fs').appendFileSync('a.txt','tamper')"] }] });
    const r = land(s);
    assert.equal(r.json.train.result, 'dirty');
    assert.equal(r.status, 3);
    assert.match(s.f(['land', '--approve', r.json.train.trainId, '--json']).json.reason, /dirty/);
  });

  it('a failed first run that leaves untracked files is reset before the rerun: a leftover cannot make the rerun pass', () => {
    const leftover = { name: 'default', command: ['node', '-e', "const f=require('fs');if(f.existsSync('leftover.txt'))process.exit(0);f.writeFileSync('leftover.txt','x');process.exit(1)"] };
    const s = twoReady({ tiers: [leftover] });
    const r = land(s);
    assert.equal(r.json.train.result, 'red', 'a rerun that would pass only because of leftovers is impossible');
    assert.equal(r.json.train.tierResults[0].reran, true);
  });

  it('a merge conflict stops the train at the conflicting branch; the worktree is left; approve is refused', () => {
    const s = setup({ fleetConfig: cfg() });
    readyBranch(s, 'feat-a', { 'a.txt': 'from a\n' });
    readyBranch(s, 'feat-b', { 'a.txt': 'from b\n' });
    const r = land(s);
    assert.equal(r.status, 3);
    assert.equal(r.json.train.phase, 'conflict');
    assert.equal(r.json.train.conflict.files[0], 'a.txt');
    assert.ok(['feat-a', 'feat-b'].includes(r.json.train.conflict.sourceId));
    assert.ok(fs.existsSync(r.json.train.worktree), 'left for inspection');
    const ap = s.f(['land', '--approve', r.json.train.trainId, '--json']);
    assert.equal(ap.status, 3);
    assert.match(ap.json.reason, /train is conflict/);
  });

  it('a local base ahead of the remote refuses the train (local base differs)', () => {
    const s = twoReady();
    commitFile(s.fx.repo, 'local-only.txt', 'x\n');
    const r = land(s);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /local base differs from origin\/main — sync first/);
  });

  it('--dry-run builds nothing and writes nothing; --select lands only the named ready sessions', () => {
    const s = twoReady();
    const dry = land(s, ['--dry-run']);
    assert.equal(dry.status, 0);
    assert.match(dry.json.text, /nothing was written or built/);
    assert.equal(listTrains(fleetDirOf(s.fx)).trains.length, 0);
    assert.equal(fs.existsSync(s.fx.wtRoot), false);
    const sel = land(s, ['--select', 'feat-b']);
    assert.deepEqual(sel.json.train.sources.map((x) => x.id), ['feat-b']);
    assert.equal(land(s, ['--select', 'nope']).status, 3);
  });

  it('refuses a registry that is incomplete, and a repo with no testCommand', () => {
    const noTests = setup({ fleetConfig: { mergeMethod: 'direct-squash' } });
    readyBranch(noTests, 'feat-a', { 'a.txt': 'A\n' });
    const r = land(noTests);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /no testCommand configured/);
    const s = twoReady();
    writeFile(s.fx.repo, '.git/fleet/sessions/junk.json', 'x');
    assert.match(land(s).json.reason, /registry incomplete/);
  });

  it('the string testCommand form behaves as one pre-land tier "default"; shell metacharacters are honoured', () => {
    const marker = fwd(path.join(tmpRoot(), 'shell-ran'));
    const s = twoReady({ extra: { testCommand: `node -e "require('fs').writeFileSync('${marker}','1')" && node -e "process.exit(0)"` } });
    const cfgNow = s.config();
    assert.equal(cfgNow.testCommand.length, 1);
    assert.equal(cfgNow.testCommand[0].shell, true);
    const r = land(s);
    assert.equal(r.json.train.result, 'green', JSON.stringify(r.json.train.tierResults));
    assert.equal(r.json.train.tierResults.length, 1);
    assert.equal(r.json.train.tierResults[0].name, 'default');
    assert.ok(fs.existsSync(marker), 'the && chain only works if a shell ran it');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('tiers', () => {
  const mark = (dir, name) => ({ name, command: ['node', '-e', `require('fs').appendFileSync('${fwd(path.join(dir, `${name}.ran`))}','x')`] });
  const failing = (dir, name) => ({ name, command: ['node', '-e', `require('fs').appendFileSync('${fwd(path.join(dir, `${name}.ran`))}','x');process.exit(1)`] });
  const ran = (dir, name) => (fs.existsSync(path.join(dir, `${name}.ran`)) ? fs.readFileSync(path.join(dir, `${name}.ran`), 'utf8').length : 0);
  const withTiers = (tiers) => {
    const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers } } });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    return s;
  };

  it('run in order and STOP at the first red; one red pre-land tier makes the train non-approvable', () => {
    const dir = tmpRoot();
    const s = withTiers([mark(dir, 'fast'), failing(dir, 'full'), mark(dir, 'last')]);
    const r = land(s);
    const t = r.json.train;
    assert.deepEqual(t.tierResults.map((x) => `${x.name}:${x.result}`), ['fast:green', 'full:red']);
    assert.equal(ran(dir, 'fast'), 1);
    assert.equal(ran(dir, 'full'), 2, 'rerun once on red');
    assert.equal(ran(dir, 'last'), 0, 'never reached');
    assert.equal(t.result, 'red');
    assert.equal(r.status, 3);
    assert.equal(s.f(['land', '--approve', t.trainId]).status, 3);
  });

  it('a post-merge tier is NEVER executed by land, is recorded as deferredTiers and listed in the approval output', () => {
    const dir = tmpRoot();
    const post = { ...mark(dir, 'packaged'), stage: 'post-merge' };
    const s = withTiers([mark(dir, 'fast'), post]);
    const r = land(s);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(ran(dir, 'packaged'), 0);
    assert.deepEqual(r.json.train.deferredTiers.map((x) => x.name), ['packaged']);
    assert.match(r.json.text, /The `packaged` tier will run on `main` after landing. A green train does not cover it./);
    const ap = s.f(['land', '--approve', r.json.train.trainId, '--json']);
    assert.match(ap.json.text, /The `packaged` tier will run on `main` after landing/);
    assert.match(ap.json.text, /ONE main run covers the post-merge tier for the whole batch/);
    assert.equal(ran(dir, 'packaged'), 0, 'approve does not run it either');
  });

  it('a tier exceeding timeoutMs is red with reason timeout (and is not rerun)', () => {
    const dir = tmpRoot();
    const slow = { name: 'slow', command: ['node', '-e', `require('fs').appendFileSync('${fwd(path.join(dir, 'slow.ran'))}','x');setTimeout(()=>{},60000)`], timeoutMs: 600 };
    const s = withTiers([slow]);
    const t = land(s).json.train;
    assert.equal(t.tierResults[0].result, 'red');
    assert.equal(t.tierResults[0].reason, 'timeout');
    assert.equal(ran(dir, 'slow'), 1);
  });

  it('per-tier rerun-once: a flaky second tier is green-after-rerun and the overall result is the worst tier', () => {
    const dir = tmpRoot();
    const marker = fwd(path.join(dir, 'flaky-state'));
    const flaky = { name: 'full', command: ['node', '-e', `const f=require('fs');if(!f.existsSync('${marker}')){f.writeFileSync('${marker}','1');process.exit(1)}process.exit(0)`] };
    const s = withTiers([mark(dir, 'fast'), flaky]);
    const t = land(s).json.train;
    assert.deepEqual(t.tierResults.map((x) => x.result), ['green', 'green-after-rerun']);
    assert.equal(t.result, 'green-after-rerun');
  });

  it('--resume continues at the first un-run tier in the same clean worktree', () => {
    const dir = tmpRoot();
    const s = withTiers([mark(dir, 'fast'), mark(dir, 'full')]);
    const cfg = s.config();
    const built = (() => {
      const status = s.f(['status', '--json']).json.status;
      void status;
      const sess = sessionRec(s.fx, 'feat-a');
      let n = 0;
      try {
        buildTrain({
          cwd: s.fx.repo, config: cfg, deps: defaultDeps({ log: () => {}, hooks: { afterTier: () => { n += 1; throw new Error('simulated kill after tier 1'); } } }),
          sources: [{ id: 'feat-a', gen: sess.gen, rev: sess.rev, oid: sess.ready.oid, kind: 'branch', pr: null }],
        });
      } catch (e) { assert.match(e.message, /simulated kill/); }
      return listTrains(fleetDirOf(s.fx)).trains[0];
    })();
    assert.equal(built.phase, 'applying');
    assert.deepEqual(built.tierResults.map((x) => x.name), ['fast']);
    const r = s.f(['land', '--resume', built.trainId, '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.json.train.tierResults.map((x) => `${x.name}:${x.result}`), ['fast:green', 'full:green']);
    assert.equal(ran(dir, 'fast'), 1, 'the recorded tier was NOT re-run');
    assert.equal(ran(dir, 'full'), 1);
    assert.equal(r.json.train.phase, 'tested');
  });

  it('--resume refuses a DIRTY worktree and a MOVED one', () => {
    const dir = tmpRoot();
    const s = withTiers([mark(dir, 'fast'), mark(dir, 'full')]);
    const crash = () => {
      const sess = sessionRec(s.fx, 'feat-a');
      try {
        buildTrain({
          cwd: s.fx.repo, config: s.config(), deps: defaultDeps({ log: () => {}, hooks: { afterTier: () => { throw new Error('kill'); } } }),
          sources: [{ id: 'feat-a', gen: sess.gen, rev: sess.rev, oid: sess.ready.oid, kind: 'branch', pr: null }],
        });
      } catch { /* the simulated kill */ }
      return listTrains(fleetDirOf(s.fx)).trains.at(-1);
    };
    const dirty = crash();
    writeFile(dirty.worktree, 'stray.txt', 'x');
    const a = s.f(['land', '--resume', dirty.trainId, '--json']);
    assert.equal(a.status, 3);
    assert.match(a.json.reason, /not clean/);
    const moved = crash();
    git(['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--allow-empty', '-m', 'moved'], moved.worktree);
    const b = s.f(['land', '--resume', moved.trainId, '--json']);
    assert.equal(b.status, 3);
    assert.match(b.json.reason, /HEAD moved/);
    assert.equal(s.f(['land', '--resume', 't-20990101000000-0000']).status, 3, 'an unknown train');
  });

  it('a branch changing package.json records depsChanged:true and provisions AFTER the apply (result none when it cannot be satisfied)', () => {
    const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers: [OK_TIER] } }, files: { 'package.json': '{"name":"x","version":"1.0.0"}\n', 'a.txt': 'a\n' } });
    readyBranch(s, 'deps', { 'package.json': '{"name":"x","version":"1.0.0","dependencies":{"nope-pkg":"1.0.0"}}\n' });
    const r = land(s);
    assert.equal(r.json.train.depsChanged, true);
    assert.equal(r.json.train.result, 'none');
    assert.match(r.json.train.notes.join(' '), /provisioning failed/);
    assert.equal(r.status, 3);
    // ordering, asserted in-process: provisioning is called with the candidate already checked out
    const sess = sessionRec(s.fx, 'deps');
    let seen = null;
    buildTrain({
      cwd: s.fx.repo, config: s.config(),
      deps: defaultDeps({ log: () => {}, provision: (wt, _main, o) => { seen = { head: git(['rev-parse', 'HEAD'], wt), pkg: fs.readFileSync(path.join(wt, 'package.json'), 'utf8'), depsChanged: o.depsChanged }; return { ok: true, mode: 'fake', reason: 'fake' }; } }),
      sources: [{ id: 'deps', gen: sess.gen, rev: sess.rev, oid: sess.ready.oid, kind: 'branch', pr: null }],
    });
    assert.match(seen.pkg, /nope-pkg/, 'the install is of the candidate, not the base');
    assert.equal(seen.depsChanged, true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('approve: re-verification and refusals', () => {
  const cfg = { mergeMethod: 'direct-squash', testCommand: { tiers: [OK_TIER] } };
  function built(over = {}) {
    const s = setup({ fleetConfig: cfg, ...over });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    readyBranch(s, 'feat-b', { 'b.txt': 'B\n' });
    const t = land(s).json.train;
    assert.equal(t.result, 'green');
    return { s, t, approve: (x = []) => s.f(['land', '--approve', t.trainId, '--json', ...x]), originMain: () => git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root) };
  }

  it('base moved (local main advanced) -> refused, naming what moved; nothing pushed', () => {
    const { s, t, approve, originMain } = built();
    commitFile(s.fx.repo, 'moved.txt', 'x\n');
    const r = approve();
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /local base moved/);
    assert.notEqual(originMain(), t.candidate.oid);
  });

  it('a source head moved -> refused naming the source', () => {
    const { s, approve } = built();
    git(['checkout', '-q', 'feat-a'], s.fx.repo);
    commitFile(s.fx.repo, 'more.txt', 'x\n');
    git(['checkout', '-q', 'main'], s.fx.repo);
    const r = approve();
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /source feat-a: head moved/);
  });

  it('the remote ref moved -> refused (and build a new train)', () => {
    const { s, approve } = built();
    const other = path.join(s.fx.root, 'other');
    git(['clone', '-q', s.fx.origin, other], s.fx.root);
    git(['config', 'user.email', 'o@o'], other); git(['config', 'user.name', 'O'], other);
    commitFile(other, 'someone-else.txt', 'x\n');
    git(['push', '-q', 'origin', 'main'], other);
    const r = approve();
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /remote refs\/heads\/main moved/);
  });

  it('remote unreachable (same URL, gone) -> refused, never proceeded on stale local knowledge', () => {
    const { s, approve } = built();
    const gone = `${s.fx.origin}.moved`;
    fs.renameSync(s.fx.origin, gone);
    const r = approve();
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /remote unreachable/);
    fs.renameSync(gone, s.fx.origin);
  });

  it('a pushurl change between build and approve -> refused; a fetch URL change -> refused', () => {
    const { s, approve } = built();
    git(['remote', 'set-url', '--push', 'origin', path.join(s.fx.root, 'elsewhere.git')], s.fx.repo);
    const r = approve();
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /push URL changed/);
    git(['config', '--unset-all', 'remote.origin.pushurl'], s.fx.repo);
    git(['remote', 'set-url', 'origin', `${s.fx.origin}/`], s.fx.repo);
    assert.match(approve().json.reason, /fetch URL changed/);
  });

  it('two push URLs at BUILD time -> the train is refused', () => {
    const s = setup({ fleetConfig: cfg });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    git(['remote', 'set-url', '--add', '--push', 'origin', s.fx.origin], s.fx.repo);
    git(['remote', 'set-url', '--add', '--push', 'origin', path.join(s.fx.root, 'second.git')], s.fx.repo);
    const r = land(s);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /2 push URLs/);
  });

  it('.fleet.json edited between test and approve: the MANIFEST\'s mergeMethod still wins', () => {
    const { s, t, approve, originMain } = built();
    writeFile(s.fx.repo, '.fleet.json', JSON.stringify({ mergeMethod: 'pr', testCommand: 'false', baseBranch: 'develop' }));
    const r = approve();
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.json.mode, 'direct-squash', 'the recorded method, not the edited config');
    assert.equal(originMain(), t.candidate.oid);
  });

  it('abandoned and conflict trains are refused; abandon is legal from tested and removes the worktree', () => {
    const { s, t, approve } = built();
    const ab = s.f(['land', '--abandon', t.trainId, '--json']);
    assert.equal(ab.status, 0, ab.stdout);
    assert.equal(fs.existsSync(t.worktree), false);
    assert.equal(approve().status, 3);
    assert.match(approve().json.reason, /train is abandoned/);
    assert.equal(s.f(['land', '--abandon', t.trainId]).status, 3, 'abandoning twice is refused');
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'ready', 'the train never touched the sessions');
  });

  it('reconcile and confirm do not apply to a tested train', () => {
    const { s, t } = built();
    assert.match(s.f(['land', '--reconcile', t.trainId, '--json']).json.reason, /nothing to reconcile/);
    assert.match(s.f(['land', '--confirm', t.trainId, '--json']).json.reason, /not awaiting-merge|--confirm applies only/);
  });

  it('concurrent land operations are refused by the exclusive trains/.lock (not queued, not proceeded)', () => {
    const { s, t } = built();
    const inner = withTrainLock(fleetDirOf(s.fx), () => approveTrain({ cwd: s.fx.repo, trainId: t.trainId, deps: defaultDeps({ log: () => {} }) }));
    assert.equal(inner.ok, false);
    assert.match(inner.reason, /trains\/\.lock/);
    assert.equal(readTrain(fleetDirOf(s.fx), t.trainId).train.phase, 'tested', 'nothing happened');
    assert.equal(s.f(['land', '--approve', t.trainId]).status, 0, 'the lock was released afterwards');
  });

  it('the push is issued to the recorded pushUrl (asserted on the emitted git argv)', () => {
    const { s, t } = built();
    const calls = [];
    const real = defaultDeps({ log: () => {} });
    const deps = { ...real, git: (args, cwd, o) => { calls.push(args); return real.git(args, cwd, o); } };
    const r = approveTrain({ cwd: s.fx.repo, trainId: t.trainId, deps });
    assert.equal(r.ok, true, JSON.stringify(r));
    const push = calls.find((a) => a[0] === 'push');
    assert.equal(push[1], t.destination.pushUrl);
    assert.notEqual(push[1], 'origin');
    assert.equal(push[2], `${t.candidate.oid}:refs/heads/main`);
    assert.equal(push[3], `--force-with-lease=refs/heads/main:${t.destination.expectedOid}`);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('crash between push-pending and landed -> reconcile from the remote\'s truth', () => {
  const cfg = { mergeMethod: 'direct-squash', testCommand: { tiers: [OK_TIER] } };
  function built() {
    const s = setup({ fleetConfig: cfg });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const t = land(s).json.train;
    const crashApprove = (hooks, git2) => {
      const real = defaultDeps({ log: () => {} });
      try { approveTrain({ cwd: s.fx.repo, trainId: t.trainId, deps: { ...real, hooks, ...(git2 ? { git: git2(real) } : {}) } }); } catch (e) { assert.match(e.message, /simulated crash/); }
    };
    return { s, t, crashApprove, phase: () => readTrain(fleetDirOf(s.fx), t.trainId).train.phase };
  }

  it('killed BEFORE the push: push-pending -> abandon REFUSED -> reconcile returns to approved (remote == expectedOid) -> re-approvable', () => {
    const { s, t, crashApprove, phase } = built();
    crashApprove({ afterPushPending: () => { throw new Error('simulated crash'); } });
    assert.equal(phase(), 'push-pending');
    const ab = s.f(['land', '--abandon', t.trainId, '--json']);
    assert.equal(ab.status, 3);
    assert.match(ab.json.reason, /push-pending/);
    assert.equal(s.f(['land', '--approve', t.trainId]).status, 3, 'push-pending is not approvable until reconciled');
    const rec = s.f(['land', '--reconcile', t.trainId, '--json']);
    assert.equal(rec.status, 0, rec.stdout);
    assert.equal(rec.json.reconciled, 'approved');
    assert.equal(phase(), 'approved');
    assert.equal(readTrain(fleetDirOf(s.fx), t.trainId).train.reconciledFrom, 'push-pending');
    const again = s.f(['land', '--approve', t.trainId, '--json']);
    assert.equal(again.status, 0, again.stdout);
    assert.equal(git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root), t.candidate.oid);
  });

  it('killed AFTER the real push: reconcile records landed (remote == candidate)', () => {
    const { s, t, crashApprove, phase } = built();
    crashApprove({}, (real) => (args, cwd, o) => { const r = real.git(args, cwd, o); if (args[0] === 'push') throw new Error('simulated crash'); return r; });
    assert.equal(phase(), 'push-pending');
    assert.equal(git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root), t.candidate.oid, 'the push really happened');
    const rec = s.f(['land', '--reconcile', t.trainId, '--json']);
    assert.equal(rec.json.reconciled, 'landed');
    assert.equal(phase(), 'landed');
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'done');
  });

  it('remote moved to something else: reconcile -> diverged naming both OIDs; abandon IS allowed from diverged', () => {
    const { s, t, crashApprove, phase } = built();
    crashApprove({ afterPushPending: () => { throw new Error('simulated crash'); } });
    const other = path.join(s.fx.root, 'other');
    git(['clone', '-q', s.fx.origin, other], s.fx.root);
    git(['config', 'user.email', 'o@o'], other); git(['config', 'user.name', 'O'], other);
    commitFile(other, 'x.txt', 'x\n'); git(['push', '-q', 'origin', 'main'], other);
    const theirs = git(['rev-parse', 'HEAD'], other);
    const rec = s.f(['land', '--reconcile', t.trainId, '--json']);
    assert.equal(rec.status, 3);
    assert.equal(rec.json.reconciled, 'diverged');
    assert.ok(rec.json.reason.includes(theirs.slice(0, 12)) && rec.json.reason.includes(t.candidate.oid.slice(0, 12)));
    assert.equal(phase(), 'diverged');
    assert.equal(s.f(['land', '--approve', t.trainId]).status, 3);
    assert.equal(s.f(['land', '--abandon', t.trainId]).status, 0);
    assert.equal(phase(), 'abandoned');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('pr mode: emits a plan, observes via gh', () => {
  const cfg = { mergeMethod: 'pr', testCommand: { tiers: [OK_TIER] } };

  function prFx() {
    const s = setup({ fleetConfig: cfg, gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oidA = readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const oidB = readyBranch(s, 'feat-b', { 'b.txt': 'B\n' });
    const rows = [prRow({ number: 11, branch: 'feat-a', headOid: oidA, baseOid: base }), prRow({ number: 12, branch: 'feat-b', headOid: oidB, baseOid: base })];
    const view = Object.fromEntries(rows.map((r) => [r.number, r]));
    const state = { list: rows, view };
    s.fake.setState(state);
    return { s, base, oidA, oidB, rows, state, set: (v) => s.fake.setState({ ...state, view: v }) };
  }

  it('approve EMITS the ordered gh merge plan and leaves the train awaiting-merge — never landed, never executed', () => {
    const { s, oidA, oidB } = prFx();
    const built = land(s);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const t = built.json.train;
    assert.equal(t.mergeMethod, 'pr');
    assert.deepEqual(t.sources.map((x) => x.prNumber).sort(), [11, 12]);
    assert.equal(t.sources[0].baseRefOid, t.destination.expectedOid);
    const ap = s.f(['land', '--approve', t.trainId, '--json']);
    assert.equal(ap.status, 0, ap.stdout + ap.stderr);
    assert.equal(ap.json.train.phase, 'awaiting-merge');
    assert.equal(ap.json.landed, false);
    const cmds = ap.json.plan.map((p) => p.command.join(' '));
    assert.equal(cmds.length, 2);
    for (const [i, id] of t.sources.map((x) => x.id).entries()) {
      const oid = id === 'feat-a' ? oidA : oidB;
      assert.match(cmds[i], new RegExp(`^gh pr merge ${id === 'feat-a' ? 11 : 12} -R o/n --squash --match-head-commit ${oid}$`));
    }
    assert.match(ap.json.text, /each merge triggers its own post-merge run|NOTHING was executed/);
    assert.equal(s.fake.calls().some((c) => c[1] === 'merge'), false, 'fleet never ran gh pr merge');
    assert.equal(git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root), t.destination.expectedOid, 'nothing was pushed');
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'ready', 'not done: printing commands is never landing');
    assert.equal(s.f(['land', '--abandon', t.trainId, '--json']).status, 3, 'abandon refused in awaiting-merge');
  });

  it('every gh --json field fleet requests is a member of the recorded real field list', () => {
    const fields = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/fleet/gh-pr-view-fields.json'), 'utf8')).view;
    for (const f of [...PR_APPROVE_FIELDS, ...PR_VIEW_FIELDS]) assert.ok(fields.includes(f), `${f} is a real gh pr view field`);
    const { s } = prFx();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    s.f(['land', '--confirm', t.trainId]);
    for (const c of s.fake.calls()) {
      const i = c.indexOf('--json');
      if (i >= 0) for (const f of c[i + 1].split(',')) assert.ok(fields.includes(f), `${f} requested via gh ${c.slice(0, 2).join(' ')}`);
    }
  });

  it('--confirm with a fake gh reporting ONE of two PRs merged: still awaiting-merge', () => {
    const { s, rows, oidA, set } = prFx();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    set({ 11: { ...rows[0], state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } }, 12: rows[1] });
    const c = s.f(['land', '--confirm', t.trainId, '--json']);
    assert.equal(c.status, 3);
    assert.equal(c.json.landed, false);
    assert.deepEqual(c.json.confirmations.map((x) => x.status).sort(), ['merged', 'open']);
    assert.equal(readTrain(fleetDirOf(s.fx), t.trainId).train.phase, 'awaiting-merge');
    void oidA;
  });

  it('--confirm: a PR merged into a DIFFERENT base, or with a CHANGED head, is merged-unexpected and the train stays awaiting-merge', () => {
    const { s, rows, set } = prFx();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    set({ 11: { ...rows[0], state: 'MERGED', baseRefName: 'release', mergeCommit: { oid: 'c'.repeat(40) } }, 12: { ...rows[1], state: 'MERGED', headRefOid: 'd'.repeat(40), mergeCommit: { oid: 'e'.repeat(40) } } });
    const c = s.f(['land', '--confirm', t.trainId, '--json']);
    assert.equal(c.status, 3);
    assert.deepEqual(c.json.confirmations.map((x) => x.status), ['merged-unexpected', 'merged-unexpected']);
    assert.match(c.json.reason, /MERGED UNEXPECTEDLY/);
    assert.equal(readTrain(fleetDirOf(s.fx), t.trainId).train.phase, 'awaiting-merge');
  });

  it('--confirm: a PR belonging to another repo does not count as merged', () => {
    const { s, rows, set } = prFx();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    set({ 11: { ...rows[0], state: 'MERGED', url: 'https://github.com/evil/fork/pull/11', mergeCommit: { oid: 'c'.repeat(40) } }, 12: { ...rows[1], state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } } });
    const c = s.f(['land', '--confirm', t.trainId, '--json']);
    assert.equal(c.json.confirmations.find((x) => x.prNumber === 11).status, 'merged-unexpected');
  });

  it('--confirm with every PR observed merged as tested -> landed, sessions done', () => {
    const { s, rows, set } = prFx();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    set({ 11: { ...rows[0], state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } }, 12: { ...rows[1], state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } } });
    const c = s.f(['land', '--confirm', t.trainId, '--json']);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.equal(c.json.train.phase, 'landed');
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'done');
    assert.equal(fs.existsSync(t.worktree), false);
  });

  it('approve re-checks each PR: a PR whose base moved (baseRefOid) or head changed is refused', () => {
    const { s, rows, set, base } = prFx();
    const t = land(s).json.train;
    set({ 11: { ...rows[0], baseRefOid: 'f'.repeat(40) }, 12: rows[1] });
    const r = s.f(['land', '--approve', t.trainId, '--json']);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /baseRefOid/);
    set({ 11: { ...rows[0], headRefOid: 'a'.repeat(40) }, 12: rows[1] });
    assert.match(s.f(['land', '--approve', t.trainId, '--json']).json.reason, /head moved/);
    set({});
    assert.match(s.f(['land', '--approve', t.trainId, '--json']).json.reason, /cannot be verified/);
    void base;
  });

  it('a branch-only source makes pr-mode construction REFUSE, naming it', () => {
    const s = setup({ fleetConfig: cfg, gh: true });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const r = land(s);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /feat-a has no open PR — open a PR, or set mergeMethod to a direct mode/);
  });

  it('mixed baseRefs refuse construction', () => {
    const { s, rows, state } = prFx();
    s.fake.setState({ ...state, list: [rows[0], { ...rows[1], baseRefName: 'release' }] });
    const r = land(s);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /mixed targets/);
  });

  it('a PR baseRefOid that differs from the remote base refuses construction', () => {
    const { s, rows, state } = prFx();
    s.fake.setState({ ...state, list: [{ ...rows[0], baseRefOid: 'f'.repeat(40) }, rows[1]] });
    assert.match(land(s).json.reason, /does not equal the remote base/);
  });

  it('a pr-kind session (add #PR) is materialised via refs/pull/<n>/head, and a head mismatch is refused', () => {
    const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers: [OK_TIER] } }, gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = addBranch(s.fx.repo, 'pr-src', { 'p.txt': 'p\n' });
    git(['push', '-q', 'origin', `${oid}:refs/pull/21/head`], s.fx.repo);
    git(['branch', '-D', 'pr-src'], s.fx.repo);
    s.fake.setState({ list: [prRow({ number: 21, branch: 'pr-src', headOid: oid, baseOid: base })] });
    assert.equal(s.f(['add', '#21']).status, 0);
    const rd = s.f(['ready', '--id', 'pr-21', '--json']);
    assert.equal(rd.status, 0, rd.stdout + rd.stderr);
    assert.equal(git(['rev-parse', 'refs/fleet/pr/21'], s.fx.repo), oid);
    const t = land(s);
    assert.equal(t.status, 0, t.stdout + t.stderr);
    assert.equal(s.f(['land', '--approve', t.json.train.trainId]).status, 0);
    assert.ok(originLog(s.fx).includes('work on pr-src'));
    // a PR whose headRefOid differs from the fetched head
    const s2 = setup({ gh: true });
    const base2 = git(['rev-parse', 'main'], s2.fx.repo);
    const oid2 = addBranch(s2.fx.repo, 'pr2', { 'q.txt': 'q\n' });
    git(['push', '-q', 'origin', `${oid2}:refs/pull/5/head`], s2.fx.repo);
    s2.fake.setState({ list: [prRow({ number: 5, branch: 'pr2', headOid: 'a'.repeat(40), baseOid: base2 })] });
    assert.equal(s2.f(['add', '#5']).status, 0);
    const r = s2.f(['ready', '--id', 'pr-5', '--json']);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /differs from expected/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('direct-merge: --no-ff merge commits, structurally verified', () => {
  it('a green --no-ff train and a green squash train are BOTH approvable (the first-parent-count check, not reachability)', () => {
    for (const method of ['direct-merge', 'direct-squash']) {
      const s = setup({ fleetConfig: { mergeMethod: method, testCommand: { tiers: [OK_TIER] } } });
      readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
      readyBranch(s, 'feat-b', { 'b.txt': 'B\n' });
      const t = land(s).json.train;
      const ap = s.f(['land', '--approve', t.trainId, '--json']);
      assert.equal(ap.status, 0, `${method}: ${ap.stdout}`);
      const parents = git(['--git-dir', s.fx.origin, 'rev-list', '--first-parent', '--parents', '-n', '1', 'main'], s.fx.root).split(' ').length - 1;
      assert.equal(parents, 1 + (method === 'direct-merge' ? 1 : 0), `${method}: merge commits have two parents`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Audit-round fixes (H1-H7, M1-M11, L1)
describe('argv: POSIX --, inline booleans, empty --select', () => {
  it('everything after -- is positional, never a flag (unit and end to end)', () => {
    assert.throws(() => parseVerbArgs('claim', ['--', '--override']), /positional/);
    assert.deepEqual(parseVerbArgs('add', ['--', '--all']), { flags: {}, positionals: ['--all'] });
    assert.throws(() => parseVerbArgs('claim', ['--intent', '--']), /requires a value/);
    const s = setup();
    addBranch(s.fx.repo, 'ahead-branch', { 'x.txt': 'x\n' });
    const r = s.f(['add', '--json', '--', '--all']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.json.reason, /no local branch --all/);
    assert.equal(sessionFiles(s.fx).length, 0, '--all was NOT interpreted as the flag');
  });

  it('a boolean flag with an inline value is an argv error (never read as true, never as false)', () => {
    for (const bad of ['--accept-rerun=false', '--accept-rerun=0', '--accept-rerun=', '--dry-run=no']) {
      assert.throws(() => parseVerbArgs('land', [bad]), /takes no value/, bad);
    }
    const s = setup();
    assert.equal(s.f(['land', '--approve', 't-20260101000000-abcd', '--accept-rerun=false']).status, 2);
    assert.match(s.f(['land', '--approve', 't-20260101000000-abcd', '--accept-rerun=false']).stderr, /--accept-rerun takes no value/);
    assert.equal(s.f(['status', '--json=true']).status, 2);
    assert.equal(s.f(['claim', '--id', 'a', '--intent', 'i', '--override=false']).status, 2);
  });

  it('an explicitly empty --select (or one with an empty element) is an argv error, never "no selection"', () => {
    assert.throws(() => parseSelect(''), /empty entry/);
    assert.throws(() => parseSelect('  '), /empty entry/);
    assert.throws(() => parseSelect('a,,b'), /empty entry/);
    assert.deepEqual(parseSelect('a, b'), ['a', 'b']);
    const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers: [OK_TIER] } } });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    for (const bad of ['', ' ', 'feat-a,,x']) assert.equal(s.f(['land', '--select', bad]).status, 2, JSON.stringify(bad));
    assert.equal(s.f(['land', '--dry-run', '--select', '']).status, 2);
    assert.equal(s.f(['land', '--approve', 't-20260101000000-abcd', '--select', '']).status, 2, 'present-but-empty still counts as present with a mode');
    assert.equal(listTrains(fleetDirOf(s.fx)).trains.length, 0, 'nothing was built by the refused calls');
  });
});

describe('Windows tier spawning is never hand-quoted', () => {
  it('the unsafe-argv predicate refuses every cmd.exe metacharacter, whitespace and empty elements', () => {
    for (const bad of ['a&b', 'a|b', 'a<b', 'a>b', 'a^b', '%PATH%', 'a!b', 'a"b', 'a\nb', 'a\rb', 'a b', '']) assert.equal(unsafeWinShellArgv(['x', bad]), true, JSON.stringify(bad));
    assert.equal(unsafeWinShellArgv(['pnpm', 'run', 'test:unit', '--filter=@a/b', 'C:\\x\\y']), false);
  });

  it('resolveTierSpawn: node + npm-cli.js for npm/npx; refuse (no shell) when no safe route and the argv is unsafe', () => {
    const exe = 'C:\\n\\node.exe';
    const npm = resolveTierSpawn({ tier: { command: ['npm', 'run', 'a%PATH%'] }, platform: 'win32', execPath: exe, exists: () => true });
    assert.equal(npm.shell, false);
    assert.equal(npm.file, exe);
    assert.match(npm.args[0], /npm-cli\.js$/);
    assert.deepEqual(npm.args.slice(1), ['run', 'a%PATH%'], 'passed literally: no shell sees it');
    assert.match(resolveTierSpawn({ tier: { command: ['npx', 'x'] }, platform: 'win32', execPath: exe, exists: () => true }).args[0], /npx-cli\.js$/);
    assert.deepEqual(resolveTierSpawn({ tier: { command: ['npm', 'run', 'a%PATH%'] }, platform: 'win32', execPath: exe, exists: () => false }), { refuse: UNSAFE_WIN_SHELL_ARGV });
    assert.deepEqual(resolveTierSpawn({ tier: { command: ['pnpm', 'a b'] }, platform: 'win32', exists: () => false }), { refuse: UNSAFE_WIN_SHELL_ARGV });
    assert.deepEqual(resolveTierSpawn({ tier: { command: ['yarn', 'say', '"hi"'] }, platform: 'win32', exists: () => false }), { refuse: UNSAFE_WIN_SHELL_ARGV });
    const safe = resolveTierSpawn({ tier: { command: ['pnpm', 'test'] }, platform: 'win32', exists: () => false });
    assert.deepEqual(safe, { file: 'pnpm.cmd', args: ['test'], shell: true });
    assert.deepEqual(resolveTierSpawn({ tier: { command: ['npm', 'a%PATH%'] }, platform: 'linux' }), { file: 'npm', args: ['a%PATH%'], shell: false });
    assert.deepEqual(resolveTierSpawn({ tier: { command: ['a && b'], shell: true }, platform: 'win32' }), { file: 'a && b', args: [], shell: true });
  });

  it('an argv containing %PATH% on a node-script tier is passed LITERALLY, not expanded', () => {
    const lit = { name: 'default', command: ['node', '-e', 'process.exit(process.argv[1] === "%PATH%" && process.argv[2] === "a&b" ? 0 : 1)', '%PATH%', 'a&b'] };
    const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers: [lit] } } });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const t = land(s).json.train;
    assert.equal(t.tierResults[0].result, 'green', JSON.stringify(t.tierResults));
    assert.equal(t.tierResults[0].reran, undefined);
  });

  it('on Windows a pnpm tier with %PATH% is REFUSED as red/unsafe-windows-shell-argv, not rerun and not executed', { skip: process.platform !== 'win32' }, () => {
    const marker = fwd(path.join(tmpRoot(), 'ran'));
    const tier = { name: 'default', command: ['pnpm', `--${marker}`, '%PATH%'] };
    const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers: [tier] } } });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const t = land(s).json.train;
    assert.equal(t.tierResults[0].result, 'red');
    assert.equal(t.tierResults[0].reason, UNSAFE_WIN_SHELL_ARGV);
    assert.equal(t.tierResults[0].reran, undefined);
  });
});

describe('removeTrainWorktree is honest about git', () => {
  const trainId = 't-20260101000000-abcd';
  const mk = () => ({ trainId, worktree: path.join(tmpRoot(), trainId) }); // directory does not exist
  const listing = (wt) => `worktree ${wt}\0HEAD ${'a'.repeat(40)}\0detached\0\0`;

  it('a failing git worktree prune is NOT reported as removed', () => {
    const tr = mk();
    const r = removeTrainWorktree('/x', tr, { git: (args) => (args[1] === 'prune' ? { ok: false, reason: 'boom' } : { ok: true, stdout: '' }) });
    assert.equal(r.removed, false);
    assert.match(r.reason, /prune failed: boom/);
  });

  it('a prune that succeeds but leaves the path registered is NOT reported as removed', () => {
    const tr = mk();
    const r = removeTrainWorktree('/x', tr, { git: (args) => (args[1] === 'list' ? { ok: true, stdout: listing(tr.worktree) } : { ok: true, stdout: '' }) });
    assert.equal(r.removed, false);
    assert.match(r.reason, /still registered/);
  });

  it('an unverifiable registration (list fails) is not removed; a verified-gone one is', () => {
    const tr = mk();
    assert.equal(removeTrainWorktree('/x', tr, { git: (args) => (args[1] === 'list' ? { ok: false, reason: 'no' } : { ok: true, stdout: '' }) }).removed, false);
    assert.deepEqual(removeTrainWorktree('/x', tr, { git: () => ({ ok: true, stdout: '' }) }), { removed: true, reason: 'already gone' });
  });

  it('path equality is case-insensitive only on win32/darwin; exact elsewhere', () => {
    assert.equal(pathsEqual('/a/B', '/a/b', 'linux'), false);
    assert.equal(pathsEqual('/a/B', '/a/b', 'win32'), true);
    assert.equal(pathsEqual('/a/B', '/a/b', 'darwin'), true);
    assert.equal(pathsEqual('/a/b/', '/a/b', 'linux'), true);
    // and the ownership check uses it: on linux a case-different registration is a DIFFERENT path
    const tr = mk();
    const other = tr.worktree.replace(trainId, trainId.toUpperCase().replace('T-', 't-'));
    fs.mkdirSync(tr.worktree);
    const r = removeTrainWorktree('/x', tr, { git: () => ({ ok: true, stdout: listing(other) }), removeWorktree: () => ({ ok: true }) }, { platform: 'linux' });
    if (other !== tr.worktree) assert.match(r.reason, /not a registered worktree/);
  });
});

describe('shell quoting for DISPLAYED commands', () => {
  const NASTY = ['a b', "it's", 'x;y', '$HOME', '`id`', '*', '%PATH%', '&', '--flag=v w', 'C:\\Program Files\\x'];
  const SCRIPT = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';

  it('quoteArg: bare when plain, single-quoted otherwise, per platform', () => {
    assert.equal(quoteArg('plain-1/x.mjs', 'linux'), 'plain-1/x.mjs');
    assert.equal(quoteArg('a b', 'linux'), "'a b'");
    assert.equal(quoteArg("it's", 'linux'), "'it'\\''s'");
    assert.equal(quoteArg('a b', 'win32'), "'a b'");
    assert.equal(quoteArg("it's", 'win32'), "'it''s'");
    assert.equal(quoteArg('%PATH%', 'win32'), "'%PATH%'");
    assert.equal(renderCommand(['C:\\Program Files\\nodejs\\node.exe', 'x'], 'win32'), "& 'C:\\Program Files\\nodejs\\node.exe' x");
    assert.equal(renderCommand(['node', 'a b'], 'win32'), "node 'a b'");
  });

  it('POSIX form round-trips paths with spaces and metacharacters through a real sh', (t) => {
    const probe = spawnSync('sh', ['-c', 'exit 0']);
    if (probe.error || probe.status !== 0) { t.skip('no sh'); return; }
    const cmd = renderCommand([process.execPath.replace(/\\/g, '/'), '-e', SCRIPT, ...NASTY, 'a"b'], 'linux');
    const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(r.stdout), [...NASTY, 'a"b']);
  });

  it('Windows form round-trips through a real PowerShell', { skip: process.platform !== 'win32' }, (t) => {
    const args = NASTY.filter((a) => a !== 'C:\\Program Files\\x');
    const cmd = renderCommand([process.execPath, '-e', SCRIPT, ...args, 'C:\\Program Files\\x'], 'win32');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
    if (r.error) { t.skip('no powershell'); return; }
    assert.deepEqual(JSON.parse(r.stdout), [...args, 'C:\\Program Files\\x'], r.stderr);
  });

  it('the approval output quotes the plan and the push argv (spaces survive)', () => {
    const plan = renderApprove({ ok: true, mode: 'pr', trainId: 't-1', deferredTiers: [], plan: [{ command: ['gh', 'pr', 'merge', '1', '-R', 'o/n', '--match-head-commit', 'a b'] }] });
    assert.match(plan, /--match-head-commit 'a b'/);
    const direct = renderApprove({ ok: true, mode: 'direct-squash', trainId: 't-1', deferredTiers: [], pushArgv: ['git', 'push', 'C:/with space/x.git', 'oid:refs/heads/main'], train: { candidate: { oid: 'a'.repeat(40) }, destination: { ref: 'refs/heads/main' } } });
    assert.match(direct, /git push 'C:\/with space\/x\.git' /);
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

describe('manifest-driven recovery works with a malformed .fleet.json', () => {
  const cfg = { mergeMethod: 'direct-squash', testCommand: { tiers: [OK_TIER] } };
  const corrupt = (s) => writeFile(s.fx.repo, '.fleet.json', '{ this is not json');

  it('control: a config-driven verb fails (exit 1) on the malformed file', () => {
    const s = setup({ fleetConfig: cfg });
    corrupt(s);
    assert.equal(s.f(['status']).status, 1);
  });

  it('--abandon succeeds', () => {
    const s = setup({ fleetConfig: cfg });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const t = land(s).json.train;
    corrupt(s);
    const r = s.f(['land', '--abandon', t.trainId, '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readTrain(fleetDirOf(s.fx), t.trainId).train.phase, 'abandoned');
  });

  it('--reconcile succeeds (push-pending -> approved, remote untouched)', () => {
    const s = setup({ fleetConfig: cfg });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const t = land(s).json.train;
    try { approveTrain({ cwd: s.fx.repo, trainId: t.trainId, deps: defaultDeps({ log: () => {}, hooks: { afterPushPending: () => { throw new Error('simulated crash'); } } }) }); } catch (e) { assert.match(e.message, /simulated crash/); }
    corrupt(s);
    const r = s.f(['land', '--reconcile', t.trainId, '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.reconciled, 'approved');
  });

  it('--confirm succeeds and lands the train + writes the done cache (base branch comes from the manifest)', () => {
    const s = setup({ fleetConfig: { mergeMethod: 'pr', testCommand: { tiers: [OK_TIER] } }, gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const row = prRow({ number: 11, branch: 'feat-a', headOid: oid, baseOid: base });
    s.fake.setState({ list: [row], view: { 11: row } });
    const t = land(s).json.train;
    assert.equal(s.f(['land', '--approve', t.trainId]).status, 0);
    corrupt(s);
    s.fake.setState({ list: [row], view: { 11: { ...row, state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } } } });
    const r = s.f(['land', '--confirm', t.trainId, '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'done');
  });
});

describe('derived-done cache is decided INSIDE the lock against the current record', () => {
  const cfg = { mergeMethod: 'direct-squash', testCommand: { tiers: [OK_TIER] } };
  function landWith(hook) {
    const s = setup({ fleetConfig: cfg });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    readyBranch(s, 'feat-b', { 'b.txt': 'B\n' });
    const t = land(s).json.train;
    const dir = fleetDirOf(s.fx);
    const r = approveTrain({ cwd: s.fx.repo, trainId: t.trainId, deps: defaultDeps({ log: () => {}, hooks: { beforeDoneWrite: () => hook(dir, s) } }) });
    assert.equal(r.ok, true, JSON.stringify(r));
    return s;
  }

  it('a session RE-REGISTERED (gen bumped) between derivation and the write is NOT marked done; its sibling is', () => {
    const s = landWith((dir) => {
      const cur = readSessions(dir).sessions.find((x) => x.id === 'feat-a');
      writeSession(dir, SessionSchema.parse({ ...cur, rev: cur.rev + 1, gen: cur.gen + 1, state: 'working', ready: null }));
    });
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'working');
    assert.equal(sessionRec(s.fx, 'feat-a').gen, 2);
    assert.equal(sessionRec(s.fx, 'feat-b').state, 'done');
  });

  it('a session whose rev moved (touched) or whose ready.oid moved in between is NOT marked done', () => {
    const s = landWith((dir) => {
      const a = readSessions(dir).sessions.find((x) => x.id === 'feat-a');
      writeSession(dir, SessionSchema.parse({ ...a, rev: a.rev + 1 }));
      const b = readSessions(dir).sessions.find((x) => x.id === 'feat-b');
      writeSession(dir, SessionSchema.parse({ ...b, rev: b.rev + 1, ready: { oid: 'f'.repeat(40), at: b.ready.at } }));
    });
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'ready');
    assert.equal(sessionRec(s.fx, 'feat-b').state, 'ready');
  });

  it('control: with no interference both are marked done', () => {
    const s = landWith(() => {});
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'done');
    assert.equal(sessionRec(s.fx, 'feat-b').state, 'done');
  });
});

describe('status: PR-backed sessions without a local branch, and base freshness upstream', () => {
  it('a PR session with no local branch says changed files were NOT queried; after ready (materialised) they are read', () => {
    const s = setup({ gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = addBranch(s.fx.repo, 'pr-branch', { 'p.txt': 'p\n' });
    git(['push', '-q', 'origin', `${oid}:refs/pull/7/head`], s.fx.repo);
    git(['branch', '-D', 'pr-branch'], s.fx.repo);
    s.fake.setState({ list: [prRow({ number: 7, branch: 'pr-branch', headOid: oid, baseOid: base })] });
    assert.equal(s.f(['add', '#7']).status, 0);
    const before = s.f(['status']);
    assert.match(before.stdout, /changed files not queried \(PR #7 is not materialised locally/);
    assert.equal(s.f(['ready', '--id', 'pr-7']).status, 0);
    const after = s.f(['status', '--json']);
    assert.doesNotMatch(after.stdout, /changed files not queried/);
    assert.deepEqual(after.json.status.items.find((i) => i.id === 'pr-7').changedFiles, ['p.txt']);
  });

  it('resolveUpstream: an open train\'s destination remote, then the configured upstream, then origin', () => {
    const fx = makeFleetRepo();
    assert.deepEqual(resolveUpstream(fx.repo, 'main', []), { upstream: 'origin/main', source: 'upstream' });
    git(['remote', 'rename', 'origin', 'up'], fx.repo);
    assert.deepEqual(resolveUpstream(fx.repo, 'main', []), { upstream: 'up/main', source: 'upstream' }, 'a base tracking a non-origin remote');
    const train = { phase: 'tested', createdAt: '2026-01-01T00:00:00Z', destination: { remote: 'mirror', ref: 'refs/heads/main' } };
    assert.deepEqual(resolveUpstream(fx.repo, 'main', [train]), { upstream: 'mirror/main', source: 'train' });
    assert.equal(resolveUpstream(fx.repo, 'main', [{ ...train, phase: 'landed' }]).source, 'upstream', 'a finished train no longer decides');
    git(['branch', '--unset-upstream', 'main'], fx.repo);
    assert.deepEqual(resolveUpstream(fx.repo, 'main', []), { upstream: 'origin/main', source: 'origin' });
  });

  it('end to end: status measures freshness against the non-origin upstream', () => {
    const s = setup();
    git(['remote', 'rename', 'origin', 'up'], s.fx.repo);
    const other = path.join(s.fx.root, 'other');
    git(['clone', '-q', s.fx.origin, other], s.fx.root);
    git(['config', 'user.email', 'o@o'], other); git(['config', 'user.name', 'O'], other);
    commitFile(other, 'theirs.txt', 'x\n'); git(['push', '-q', 'origin', 'main'], other);
    git(['fetch', '-q', 'up'], s.fx.repo);
    assert.match(s.f(['status']).stdout, /up\/main/);
  });
});

describe('the fake gh survives a NODE_OPTIONS path with spaces', () => {
  it('answers from a state file under a directory whose name contains a space', () => {
    const root = tmpRoot('fleet space dir ');
    assert.ok(root.includes(' '));
    const fake = installFakeGh(root);
    const r = spawnSync('gh', ['pr', 'list', '--json', 'number'], { env: scrubbedEnv(fake.env, { prependPath: [fake.bin] }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, '[]');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Audit round 2
describe('round 2: lease floor, PowerShell quoting, start baseline, PR evidence, scrubbed env, base name', () => {
  it('H1: a lease under one minute is rejected on the CONVERTED value; 0.017h is accepted', () => {
    for (const bad of ['0.00000001', '0.0166', '0.0001']) {
      assert.throws(() => leaseMsFrom({ FLEET_LEASE_HOURS: bad }), (e) => e.name === 'ConfigError' && /at least 1 minute/.test(e.message), bad);
    }
    assert.equal(leaseMsFrom({ FLEET_LEASE_HOURS: '0.017' }), 61_200);
    const s = setup();
    const r = s.f(['status'], { env: { FLEET_LEASE_HOURS: '0.00000001' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FLEET_LEASE_HOURS/);
  });

  it('H2: on Windows only [A-Za-z0-9_./\\\\:-] stays bare; a leading @ (splatting) and + = , ~ # % are quoted', () => {
    assert.equal(renderCommand(['node', 'scripts/fleet.mjs', 'start', '--task', '@work'], 'win32'), "node scripts/fleet.mjs start --task '@work'");
    for (const a of ['@x', 'a@b', '+x', 'a=b', 'a,b', '~', '#x', '%x', 'a b', "a'b"]) assert.match(quoteArg(a, 'win32'), /^'.*'$/, a);
    for (const a of ['plain', 'a/b.mjs', 'C:\\x\\y-1.mjs', '--flag', 'a_b:c']) assert.equal(quoteArg(a, 'win32'), a);
    assert.equal(quoteArg('@work', 'linux'), '@work', 'POSIX behaviour unchanged');
  });

  describe('H3: a baseline that cannot be established is reported, never substituted', () => {
    const ctx = { cwd: '/x', config: { baseBranch: 'main' } };
    const fake = (table) => (args) => {
      if (args[0] === 'rev-parse') return table[args[3].replace(/\^\{commit\}$/, '')] ?? { ok: true, status: 0, stdout: `${'a'.repeat(40)}\n` };
      return table.mergeBase;
    };
    it('unit: each failure kind is distinguished', () => {
      assert.equal(startOidFor(ctx, 'b', { git: fake({ 'refs/heads/main': { ok: false, status: 1, reason: 'x' } }) }).kind, 'base-unresolvable');
      assert.equal(startOidFor(ctx, 'b', { git: fake({ mergeBase: { ok: false, status: 1, reason: 'x' } }) }).kind, 'no-merge-base');
      assert.equal(startOidFor(ctx, 'b', { git: fake({ mergeBase: { ok: false, status: 128, reason: 'fatal' } }) }).kind, 'git-error');
      assert.equal(startOidFor(ctx, 'b', { git: fake({ 'refs/heads/main': { ok: false, status: 128, reason: 'fatal' } }) }).kind, 'git-error');
      assert.equal(startOidFor(ctx, 'b', { git: fake({ 'refs/heads/b': { ok: false, status: 1, reason: 'x' } }) }).kind, 'git-error', 'an unresolvable head is not a baseline either');
      assert.deepEqual(startOidFor(ctx, 'b', { git: fake({ mergeBase: { ok: true, status: 0, stdout: `${'c'.repeat(40)}\n` } }) }), { ok: true, oid: 'c'.repeat(40) });
    });

    it('add refuses (exit 1, nothing adopted) when the base is not resolvable', () => {
      const s = setup({ fleetConfig: { baseBranch: 'nope' } });
      addBranch(s.fx.repo, 'feat-x', { 'x.txt': 'x\n' });
      const r = s.f(['add', 'feat-x', '--json']);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.json.reason, /base branch nope is not resolvable/);
      assert.equal(r.json.kind, 'base-unresolvable');
      assert.equal(sessionFiles(s.fx).length, 0);
    });

    it('add refuses unrelated histories (no merge-base) naming the branch', () => {
      const s = setup();
      git(['checkout', '-q', '--orphan', 'orph'], s.fx.repo);
      git(['rm', '-rfq', '.'], s.fx.repo);
      commitFile(s.fx.repo, 'o.txt', 'o\n');
      git(['checkout', '-q', 'main'], s.fx.repo);
      const r = s.f(['add', 'orph', '--json']);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.json.reason, /cannot adopt orph: .*no common ancestor/);
      assert.equal(r.json.kind, 'no-merge-base');
      assert.equal(sessionFiles(s.fx).length, 0);
    });

    it('start aborts atomically (exit 1, no worktree, no record) when the base is not resolvable', () => {
      const s = setup({ fleetConfig: { baseBranch: 'nope' } });
      const r = s.f(['start', '--task', 'one', '--task', 'two', '--json']);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.json.reason, /cannot resolve the base branch nope/);
      assert.equal(sessionFiles(s.fx).length, 0);
      assert.equal(fs.existsSync(path.join(s.fx.wtRoot, 'chips')), false);
    });

    it('claim never substitutes the branch head: startOid stays null and the reason is surfaced', () => {
      const s = setup({ fleetConfig: { baseBranch: 'nope' } });
      const r = s.f(['claim', '--id', 'a', '--intent', 'i', '--paths', 'p/**', '--json']);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(r.json.record.startOid, null);
      assert.match(r.json.startOidWarning, /nope/);
    });
  });

  it('M1: a fork-PR session (no branch) with a materialised ref contributes changed files to overlap AND the hook payload', () => {
    const s = setup({ gh: true, fleetConfig: { checks: [{ name: 'dump', script: 'hook.mjs', runner: ['node'], runIn: ['status'], severity: 'warn' }] } });
    writeFile(s.fx.repo, 'hook.mjs', `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(path.join(s.fx.root, 'payload.json'))},b);process.stdout.write('{"schemaVersion":1,"findings":[]}');});`);
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = addBranch(s.fx.repo, 'fork-src', { 'p.txt': 'p\n' });
    git(['push', '-q', 'origin', `${oid}:refs/pull/9/head`], s.fx.repo);
    git(['branch', '-D', 'fork-src'], s.fx.repo);
    s.fake.setState({ list: [{ ...prRow({ number: 9, branch: 'fork-src', headOid: oid, baseOid: base }), isCrossRepository: true }] });
    assert.equal(s.f(['add', '#9']).status, 0);
    assert.equal(sessionRec(s.fx, 'pr-9').source.branch, null, 'a fork PR has no local branch name');
    assert.match(s.f(['status']).stdout, /changed files not queried/, 'before materialisation it says so');
    assert.equal(s.f(['ready', '--id', 'pr-9']).status, 0);
    readyBranch(s, 'local-b', { 'p.txt': 'conflicting\n' });
    const st = s.f(['status', '--json']);
    const pr = st.json.status.items.find((i) => i.id === 'pr-9');
    const lb = st.json.status.items.find((i) => i.id === 'local-b');
    assert.deepEqual(pr.changedFiles, ['p.txt']);
    assert.deepEqual(pr.overlaps.map((o) => [o.with, o.via.join('+'), o.files.join(',')]), [['local-b', 'files', 'p.txt']]);
    assert.deepEqual(lb.overlaps.map((o) => o.with), ['pr-9']);
    assert.doesNotMatch(st.stdout, /changed files not queried/);
    const payload = JSON.parse(fs.readFileSync(path.join(s.fx.root, 'payload.json'), 'utf8'));
    assert.deepEqual(payload.sessions.find((x) => x.id === 'pr-9').changedFiles, ['p.txt']);
    assert.ok(payload.overlaps.some((o) => [o.a, o.b].includes('pr-9')), 'overlaps reach the hook too');
  });

  it('M2: with gh and git in the SAME PATH directory the scrubbed env still resolves git and never the gh', () => {
    const d = tmpRoot('fleet-shared-');
    const ext = process.platform === 'win32' ? '.exe' : '';
    fs.copyFileSync(process.execPath, path.join(d, `gh${ext}`));
    fs.copyFileSync(process.execPath, path.join(d, `git${ext}`)); // a relocatable stand-in: answers `--version`
    const env = scrubbedEnv({}, { basePath: [d] });
    const g = spawnSync('git', ['--version'], { env, encoding: 'utf8' });
    assert.equal(g.error, undefined, 'git still resolves');
    assert.match(g.stdout, /^v\d+\./);
    const h = spawnSync('gh', ['--version'], { env, encoding: 'utf8' });
    assert.equal(h.error?.code, 'ENOENT', 'the real gh is unreachable');
    assert.ok(!(env.PATH ?? env.Path).split(path.delimiter).includes(d), 'the shared directory itself is not on PATH');
  });

  it('M3: the post-merge note names the ACTUAL base branch, not main', () => {
    const train = {
      trainId: 't-20260101000000-abcd', phase: 'tested', result: 'green', mergeMethod: 'direct-squash', baseOid: 'a'.repeat(40),
      destination: { remote: 'origin', ref: 'refs/heads/develop', fetchUrl: 'x', pushUrl: 'x', expectedOid: 'a'.repeat(40) },
      sources: [{ id: 's', oid: 'b'.repeat(40) }], candidate: { oid: 'c'.repeat(40), tree: 'd'.repeat(40) }, tierResults: [], checkResults: [],
      deferredTiers: [{ name: 'packaged', command: ['x'], stage: 'post-merge' }],
    };
    const built = renderBuilt({ train, approvability: { ok: true, reason: 'tested green' }, cmd: 'node f.mjs' });
    assert.match(built, /will run on `develop` after landing/);
    assert.match(built, /ONE develop run covers/);
    assert.doesNotMatch(built, /`main`|ONE main run/);
    const dry = renderDryRun({ plan: { baseOid: 'a'.repeat(40), destination: train.destination, mergeMethod: 'direct-squash', sources: train.sources, testCommand: [{ name: 'x', stage: 'pre-land' }], deferredTiers: train.deferredTiers } });
    assert.match(dry, /on `develop`/);
    const direct = renderApprove({ ok: true, mode: 'direct-squash', trainId: train.trainId, deferredTiers: train.deferredTiers, pushArgv: ['git', 'push'], train });
    assert.match(direct, /on `develop`/);
    const pr = renderApprove({ ok: true, mode: 'pr', trainId: train.trainId, deferredTiers: train.deferredTiers, plan: [], train });
    assert.match(pr, /on `develop`/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Audit round 3
describe('round 3: PR evidence freshness and ONE overlap join', () => {
  /** A tracked, branchless fork PR #9 changing shared.txt, materialised (ready), plus the fake-gh row to re-point. */
  function forkPr(extraFiles = {}) {
    const s = setup({ gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = addBranch(s.fx.repo, 'fork-src', { 'shared.txt': 'from the fork\n', ...extraFiles });
    git(['push', '-q', 'origin', `${oid}:refs/pull/9/head`], s.fx.repo);
    git(['branch', '-D', 'fork-src'], s.fx.repo);
    const row = { ...prRow({ number: 9, branch: 'fork-src', headOid: oid, baseOid: base }), isCrossRepository: true };
    s.fake.setState({ list: [row] });
    assert.equal(s.f(['add', '#9']).status, 0);
    assert.equal(s.f(['ready', '--id', 'pr-9']).status, 0);
    return { s, oid, row };
  }
  const item = (st, id) => st.json.status.items.find((i) => i.id === id);

  it('H1: a materialised ref that is STALE against the PR head is not used - it is reported (A != B)', () => {
    const { s, oid, row } = forkPr();
    readyBranch(s, 'local-b', { 'shared.txt': 'local\n' });
    const fresh = s.f(['status', '--json']);
    assert.deepEqual(item(fresh, 'pr-9').changedFiles, ['shared.txt'], 'control: ref == PR head, evidence used');
    const B = 'b'.repeat(40);
    s.fake.setState({ list: [{ ...row, headRefOid: B }] });
    const stale = s.f(['status', '--json']);
    assert.deepEqual(item(stale, 'pr-9').changedFiles, [], 'stale evidence is NOT used');
    assert.deepEqual(item(stale, 'pr-9').overlaps, []);
    assert.ok(stale.stdout.includes(`materialised ref is stale (${oid.slice(0, 12)} != ${B.slice(0, 12)})`), stale.stdout);
  });

  it('H1: with PRs not queried (gh unusable) the head cannot be verified, so the ref evidence is not used either', () => {
    const { s } = forkPr();
    s.fake.setState({ authFail: true });
    const r = s.f(['status', '--json']);
    assert.deepEqual(item(r, 'pr-9').changedFiles, []);
    assert.match(r.stdout, /the PR head cannot be verified: PRs not queried/);
  });

  it('H2: a branchless tracked fork PR and an UNREGISTERED local branch both changing shared.txt overlap in BOTH directions', () => {
    const { s } = forkPr();
    addBranch(s.fx.repo, 'unreg', { 'shared.txt': 'unregistered\n' });
    const r = s.f(['status', '--json']);
    const pr = item(r, 'pr-9'); const un = item(r, 'unreg');
    assert.equal(un.tracked, false);
    assert.deepEqual(pr.overlaps.map((o) => [o.with, o.via, o.files, o.known]), [['unreg', ['files'], ['shared.txt'], false]]);
    assert.deepEqual(un.overlaps.map((o) => [o.with, o.via, o.files, o.known]), [['pr-9', ['files'], ['shared.txt'], false]]);
    assert.equal(pr.branch, null, 'the join stand-in never leaks into the output');
  });

  it('regression: registered-vs-registered overlap output is unchanged (one entry each way, no duplicates)', () => {
    const s = setup();
    readyBranch(s, 'alpha', { 'x.txt': 'a\n' }, { paths: 'alpha/**' });
    readyBranch(s, 'beta', { 'x.txt': 'b\n' }, { paths: 'beta/**' });
    const r = s.f(['status', '--json']);
    assert.deepEqual(item(r, 'alpha').overlaps, [{ with: 'beta', via: ['files'], files: ['x.txt'], known: false }]);
    assert.deepEqual(item(r, 'beta').overlaps, [{ with: 'alpha', via: ['files'], files: ['x.txt'], known: false }]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Audit round 4
describe('round 4: entry guard, local PR branch evidence, rendered commands', () => {
  it('H1: the CLI runs when invoked through a symlink with --preserve-symlinks-main (never a silent no-op), and directly', (t) => {
    const s = setup();
    const claim = s.f(['claim', '--id', 'feature-a', '--intent', 'i', '--paths', 'fa/**', '--json'], { env: { FLEET_NOW: '2026-10-05T10:00:00Z' } });
    assert.equal(claim.status, 0, claim.stdout + claim.stderr);
    assert.equal(sessionRec(s.fx, 'feature-a').leaseExpiresAt, '2026-10-05T14:00:00.000Z');
    const link = path.join(path.dirname(FLEET_CLI), `fleet-link-test-${process.pid}.mjs`);
    try { fs.symlinkSync(FLEET_CLI, link); } catch (e) { t.skip(`symlink creation is unavailable here (${e.code})`); return; }
    try {
      for (const flags of [['--preserve-symlinks-main'], []]) {
        const r = spawnSync(process.execPath, [...flags, link, 'touch', '--id', 'feature-a', '--json'], { cwd: s.fx.repo, env: { ...s.env, FLEET_NOW: '2026-10-05T11:00:00Z' }, encoding: 'utf8' });
        assert.equal(r.status, 0, `${flags.join(' ')}: ${r.stdout}${r.stderr}`);
        assert.notEqual(r.stdout.trim(), '', 'a silent exit 0 is the bug');
        assert.equal(sessionRec(s.fx, 'feature-a').leaseExpiresAt, '2026-10-05T15:00:00.000Z', `${flags.join(' ')}: the touch really ran`);
        const cur = sessionRec(s.fx, 'feature-a');
        writeSession(fleetDirOf(s.fx), SessionSchema.parse({ ...cur, rev: cur.rev + 1, leaseExpiresAt: '2026-10-05T14:00:00.000Z' }));
      }
    } finally { fs.rmSync(link, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    const direct = s.f(['touch', '--id', 'feature-a'], { env: { FLEET_NOW: '2026-10-05T12:00:00Z' } });
    assert.equal(direct.status, 0);
    assert.equal(sessionRec(s.fx, 'feature-a').leaseExpiresAt, '2026-10-05T16:00:00.000Z');
  });

  it('M1: a PR session whose LOCAL branch tip is not the PR head does not get that branch\'s evidence ("local branch tip A != PR head B")', () => {
    const s = setup({ gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = addBranch(s.fx.repo, 'pr-branch', { 'p.txt': 'p\n' });
    const row = prRow({ number: 7, branch: 'pr-branch', headOid: oid, baseOid: base });
    s.fake.setState({ list: [row] });
    assert.equal(s.f(['add', '#7']).status, 0);
    const ok = s.f(['status', '--json']);
    assert.deepEqual(ok.json.status.items.find((i) => i.id === 'pr-7').changedFiles, ['p.txt'], 'control: tip == PR head');
    assert.doesNotMatch(ok.stdout, /changed files not queried/);
    const B = 'b'.repeat(40);
    s.fake.setState({ list: [{ ...row, headRefOid: B }] });
    const stale = s.f(['status', '--json']);
    assert.deepEqual(stale.json.status.items.find((i) => i.id === 'pr-7').changedFiles, []);
    assert.ok(stale.stdout.includes(`local branch tip ${oid.slice(0, 12)} != PR head ${B.slice(0, 12)}`), stale.stdout);
    s.fake.setState({ authFail: true });
    assert.match(s.f(['status']).stdout, /the PR head cannot be verified: PRs not queried/);
  });

  it('M3: every rendered instruction is built from the passed cmd (spaces and all); no literal `fleet <verb>` survives', () => {
    const cmd = renderCommand(['node', 'C:/with space/scripts/fleet.mjs'], 'linux');
    assert.equal(cmd, "node 'C:/with space/scripts/fleet.mjs'");
    const id = 't-20260101000000-abcd';
    const train = (phase, extra = {}) => ({ trainId: id, phase, result: 'green', conflict: { sourceId: 's' }, ...extra });
    const phases = ['snapshot', 'conflict', 'tested', 'approved', 'awaiting-merge', 'push-pending', 'diverged'];
    const open = renderOpenTrains([...phases.map((p) => train(p)), train('tested', { result: 'red' }), train('tested', { result: 'green-after-rerun' })], cmd);
    const dest = { remote: 'origin', ref: 'refs/heads/main', fetchUrl: 'x', pushUrl: 'x', expectedOid: 'a'.repeat(40) };
    const full = { ...train('tested'), mergeMethod: 'direct-squash', baseOid: 'a'.repeat(40), destination: dest, sources: [{ id: 's', oid: 'b'.repeat(40) }], candidate: { oid: 'c'.repeat(40), tree: 'd'.repeat(40) }, deferredTiers: [] };
    const texts = [
      open,
      renderParticipantRules(cmd),
      renderChipPrompt({ branch: 'b', worktree: 'w', task: 't', paths: [], cmd }),
      renderBuilt({ train: full, approvability: { ok: true, reason: 'tested green' }, cmd }),
      renderApprove({ ok: true, mode: 'pr', trainId: id, deferredTiers: [], plan: [], train: full }, cmd),
      renderReconcile({ reconciled: 'approved', trainId: id, remoteOid: 'a'.repeat(40) }, cmd),
    ];
    for (const text of texts) {
      assert.doesNotMatch(text, /(^|[^\w'])fleet (claim|ready|touch|hold|land|repair|start|status)\b/m, 'no literal fleet <verb>');
      for (const m of text.matchAll(/\bland --(approve|abandon|confirm|reconcile|resume)\b/g)) {
        assert.equal(text.slice(m.index - cmd.length - 1, m.index), `${cmd} `, `"${m[0]}" is not prefixed by the exact cmd in: ${text.slice(Math.max(0, m.index - 80), m.index + 40)}`);
      }
    }
    const rules = renderParticipantRules(cmd);
    for (const verb of ['claim', 'ready', 'touch', 'hold', 'land --approve']) assert.ok(rules.includes(`${cmd} ${verb}`), verb);
    assert.ok(texts[3].includes(`${cmd} land --approve ${id}`));
    assert.ok(texts[4].includes(`${cmd} land --confirm ${id}`));
    assert.ok(texts[5].includes(`${cmd} land --approve ${id}`));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Audit round 6
describe('round 6: ONE evidence predicate, per-session distrust, async runner lifecycle', () => {
  it('needsEvidenceKey: PR sessions (with or without a branch) yes; terminal, branch-kind and number-less no', () => {
    const pr = ({ state = 'working', source = {} } = {}) => ({ state, source: { kind: 'pr', prNumber: 42, branch: null, ...source } });
    assert.equal(needsEvidenceKey(pr()), true, 'branchless');
    assert.equal(needsEvidenceKey(pr({ source: { branch: 'feature' } })), true, 'with a branch');
    assert.equal(needsEvidenceKey(pr({ state: 'done' })), false);
    assert.equal(needsEvidenceKey(pr({ state: 'abandoned' })), false);
    assert.equal(needsEvidenceKey({ state: 'working', source: { kind: 'branch', prNumber: null, branch: 'x' } }), false);
    assert.equal(needsEvidenceKey(pr({ source: { prNumber: null } })), false);
  });

  it('pr-42 on branch "feature" with tip != PR head: the PR session warns and keeps NO borrowed evidence, while the branch\'s own evidence still feeds the join', () => {
    const s = setup({ gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = addBranch(s.fx.repo, 'feature', { 'shared.txt': 'feature\n' });
    const row = prRow({ number: 42, branch: 'feature', headOid: oid, baseOid: base });
    s.fake.setState({ list: [row] });
    assert.equal(s.f(['add', '#42']).status, 0);
    assert.equal(sessionRec(s.fx, 'pr-42').source.branch, 'feature');
    readyBranch(s, 'other', { 'shared.txt': 'other\n' });
    // control: tip == PR head -> the session uses the branch evidence and overlaps 'other'
    const ok = s.f(['status', '--json']);
    assert.deepEqual(ok.json.status.items.find((i) => i.id === 'pr-42').changedFiles, ['shared.txt']);
    assert.deepEqual(ok.json.status.items.find((i) => i.id === 'pr-42').overlaps.map((o) => o.with), ['other']);
    // the PR head moves on: local tip != PR head
    const B = 'b'.repeat(40);
    s.fake.setState({ list: [{ ...row, headRefOid: B }] });
    const st = s.f(['status', '--json']);
    const items = st.json.status.items;
    const pr = items.find((i) => i.id === 'pr-42');
    assert.deepEqual(pr.changedFiles, [], 'the PR session itself is not given the branch evidence');
    assert.deepEqual(pr.overlaps, []);
    assert.ok(st.stdout.includes(`local branch tip ${oid.slice(0, 12)} != PR head ${B.slice(0, 12)}`), st.stdout);
    const feature = items.find((i) => i.id === 'feature');
    assert.ok(feature, 'the local branch is now its own (unregistered) consumer');
    assert.equal(feature.tracked, false);
    assert.deepEqual(feature.changedFiles, ['shared.txt'], 'the shared branch evidence was NOT wiped');
    assert.deepEqual(feature.overlaps.map((o) => [o.with, o.files]), [['other', ['shared.txt']]]);
    assert.deepEqual(items.find((i) => i.id === 'other').overlaps.map((o) => o.with), ['feature']);
  });

  it('runFleetAsync has the sync runner\'s lifecycle: a deadline kills the child and rejects; a spawn error rejects', async () => {
    const s = setup();
    await assert.rejects(() => runFleetAsync(['status'], { cwd: s.fx.repo, env: s.env, timeoutMs: 1 }), /timed out after 1ms \(child killed\)/);
    await assert.rejects(() => runFleetAsync(['status'], { cwd: path.join(s.fx.root, 'no-such-dir'), env: s.env }), /could not run/);
    const ok = await runFleetAsync(['status', '--json'], { cwd: s.fx.repo, env: s.env });
    assert.equal(ok.status, 0);
  });
});

describe('fleet.mjs entry', () => {
  it('the CLI file is the one under test', () => { assert.ok(fs.existsSync(FLEET_CLI)); });
});
