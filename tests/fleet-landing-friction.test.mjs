/**
 * @fileoverview /fleet train landing friction (consumer report 2026-11-27; docs/plans/fleet-train-landing-friction.md):
 * a red tier is classified from the runner's own `test-outcome/v1` line; only a red a rerun can change is rerun (a test
 * failure's files first); a guard-only red lands only by a recorded `accept-guard` decision bound to the train, its
 * candidate and that tier result; the train's git calls take a configurable timeout and `worktree add` retries a transient
 * failure; a source already contained in the candidate is skipped, ancestors first; every tier result carries `reasonCode`.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { runGit } from '../scripts/lib/fleet/git-facts.mjs';
import { cleanupFleetRoots, tmpRoot } from './helpers/fleet-repo.mjs';
import { fwd, land, readyBranch, setup } from './helpers/fleet-cli-harness.mjs';
import { TIER_REASON_CODES, addIntegrationWorktree, applySources, defaultDeps, targetedRerunArgv } from '../scripts/lib/fleet/train.mjs';
import { approvable } from '../scripts/lib/fleet/overlap.mjs';
import { tierFingerprint } from '../scripts/lib/fleet/tier-acceptance.mjs';
import { ancestorsFirst, orderAncestorsFirst } from '../scripts/lib/fleet/land.mjs';
import { ConfigError, parseFleetConfig, resolveGitTimeoutMs } from '../scripts/lib/fleet/config.mjs';
import { DecisionSchema } from '../scripts/lib/fleet/decisions.mjs';
import { outcomeLine } from '../scripts/lib/test-outcome-marker.mjs';

after(cleanupFleetRoots);

const GUARD_LINE = outcomeLine({ testsFailed: 0, guards: [{ id: 'slow-test-budget', kind: 'policy' }] });
const FAIL_LINE = outcomeLine({ testsFailed: 1, guards: [] });
const counter = (dir, name) => `require('fs').appendFileSync('${fwd(path.join(dir, `${name}.ran`))}','x')`;
const ran = (dir, name) => (fs.existsSync(path.join(dir, `${name}.ran`)) ? fs.readFileSync(path.join(dir, `${name}.ran`), 'utf8').length : 0);
/** A tier that prints `lines` and exits 1. */
const redTier = (dir, name, lines, extra = {}) => ({ name, command: ['node', '-e', `${counter(dir, name)};${lines.map((l) => `console.log(${JSON.stringify(l)})`).join(';')};process.exit(1)`], ...extra });
const okTier = (dir, name) => ({ name, command: ['node', '-e', `${counter(dir, name)}`] });
const withTiers = (tiers) => {
  const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers } } });
  readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
  return s;
};

describe('a classified red: guard-only is not rerun and the next tier still runs', () => {
  it('guard-only red: one attempt, reasonCode guard-failure, next tier ran, approve refuses naming accept-guard', () => {
    const dir = tmpRoot();
    const s = withTiers([redTier(dir, 'full', ['# pass 120', GUARD_LINE]), okTier(dir, 'last')]);
    const r = land(s);
    assert.equal(r.status, 4, r.stdout);
    const [full, last] = r.json.train.tierResults;
    assert.equal(ran(dir, 'full'), 1, 'a deterministic guard is never rerun (was 2 at 888b11e5)');
    assert.equal(full.result, 'red');
    assert.equal(full.reasonCode, 'guard-failure');
    assert.equal(full.failureKind, 'guard');
    assert.equal(full.testsFailed, 0);
    assert.deepEqual(full.guards, [{ id: 'slow-test-budget', kind: 'policy' }]);
    assert.equal(last.result, 'green', 'the next tier ran: an approver needs every verdict');
    assert.equal(last.reasonCode, 'green');
    const ap = s.f(['land', '--approve', r.json.train.trainId, '--json']);
    assert.equal(ap.status, 3);
    assert.equal(ap.json.needsAcceptGuard, true);
    assert.match(ap.json.reason, /guard-only/);
  });

  it('a tier with NO marker stays today\'s behaviour: reran once, unclassified-failure, and the chain stops', () => {
    const dir = tmpRoot();
    const s = withTiers([redTier(dir, 'full', ['boom']), okTier(dir, 'last')]);
    const t = land(s).json.train;
    assert.equal(ran(dir, 'full'), 2);
    assert.equal(t.tierResults[0].reasonCode, 'unclassified-failure');
    assert.equal(t.tierResults[0].rerun, 'full');
    assert.equal(ran(dir, 'last'), 0);
  });

  it('a timeout guard is not rerun (test-timeout)', () => {
    const dir = tmpRoot();
    const s = withTiers([redTier(dir, 'full', [outcomeLine({ testsFailed: 0, guards: [{ id: 'per-test-limit', kind: 'timeout' }] })])]);
    const t = land(s).json.train;
    assert.equal(ran(dir, 'full'), 1);
    assert.equal(t.tierResults[0].reasonCode, 'test-timeout');
  });

  it('every reasonCode a tier wrote is in TIER_REASON_CODES', () => {
    for (const c of ['guard-failure', 'test-failure', 'unclassified-failure', 'test-timeout', 'tier-timeout', 'green']) assert.ok(TIER_REASON_CODES.includes(c), c);
  });
});

describe('a test failure reruns its failing files first', () => {
  const failedFiles = 'run-tests/v1 failed-files: ["tests/a.test.mjs"]';
  it('targeted green → the whole tier reruns and decides (green-after-rerun); the targeted argv carried the file', () => {
    const dir = tmpRoot();
    const state = fwd(path.join(dir, 'state'));
    const argvLog = fwd(path.join(dir, 'targeted.argv'));
    const full = {
      name: 'full',
      command: ['node', '-e', `${counter(dir, 'full')};const f=require('fs');if(!f.existsSync('${state}')){f.writeFileSync('${state}','1');console.log(${JSON.stringify(failedFiles)});console.log(${JSON.stringify(FAIL_LINE)});process.exit(1)}`],
      rerunFailedCommand: ['node', '-e', `require('fs').writeFileSync('${argvLog}',JSON.stringify(process.argv.slice(1)))`, '{files}'],
    };
    const s = withTiers([full]);
    const t = land(s).json.train;
    assert.equal(t.tierResults[0].result, 'green-after-rerun');
    assert.equal(t.tierResults[0].rerun, 'targeted-then-full');
    assert.deepEqual(JSON.parse(fs.readFileSync(argvLog, 'utf8')), ['tests/a.test.mjs']);
    assert.equal(ran(dir, 'full'), 2, 'first run + the full rerun after the targeted pass');
  });

  it('targeted red → red, and the 25-45 minute whole-tier rerun is skipped', () => {
    const dir = tmpRoot();
    const full = redTier(dir, 'full', [failedFiles, FAIL_LINE], { rerunFailedCommand: ['node', '-e', 'process.exit(1)', '{files}'] });
    const t = land(withTiers([full])).json.train;
    assert.equal(t.tierResults[0].result, 'red');
    assert.equal(t.tierResults[0].rerun, 'targeted');
    assert.equal(t.tierResults[0].reasonCode, 'unclassified-failure', 'the targeted attempt printed no marker of its own');
    assert.equal(ran(dir, 'full'), 1);
  });

  it('targetedRerunArgv refuses anything that is not a plain repo-relative file list', () => {
    const tier = { rerunFailedCommand: ['x', '{files}'] };
    const seg = (files) => `run-tests/v1 failed-files: ${JSON.stringify(files)}\n`;
    assert.equal(targetedRerunArgv({}, seg(['a'])).ok, false);
    assert.equal(targetedRerunArgv(tier, 'run-tests/v1 failed-files: unknown\n').ok, false);
    for (const bad of [['--inspect'], ['../x'], ['/etc/x'], ['a b'], ['a&b']]) assert.equal(targetedRerunArgv(tier, seg(bad)).ok, false, bad[0]);
    assert.equal(targetedRerunArgv(tier, seg(Array.from({ length: 51 }, (_, i) => `t${i}`))).ok, false);
    assert.equal(targetedRerunArgv(tier, seg(['a']) + seg(['b'])).ok, false, 'two lines: neither trusted');
    assert.deepEqual(targetedRerunArgv(tier, seg(['tests/a.test.mjs'])).argv, ['x', 'tests/a.test.mjs']);
  });

  it('config: rerunFailedCommand needs exactly one {files}', () => {
    const cfg = (cmd) => parseFleetConfig({ testCommand: { tiers: [{ name: 'full', command: ['npm', 'test'], rerunFailedCommand: cmd }] } });
    assert.equal(cfg(['npm', 'test', '--', '{files}']).ok, true);
    assert.equal(cfg(['npm', 'test']).ok, false);
    assert.equal(cfg(['npm', '{files}', '{files}']).ok, false);
  });
});

describe('accept-guard: a recorded human decision for a guard-only red', () => {
  const words = (dir) => { const p = path.join(dir, 'words.txt'); fs.writeFileSync(p, 'Every test passed; the slow-test budget warning is accepted for this train.\n'); return p; };

  it('records a binding computed from the train, then approve lands it, and the manifest names the decision', () => {
    const dir = tmpRoot();
    const s = withTiers([redTier(dir, 'full', [GUARD_LINE]), okTier(dir, 'last')]);
    const t = land(s).json.train;
    const d = s.f(['decision', 'record', '--scope', 'accept-guard', '--train', t.trainId, '--words-file', words(dir), '--json']);
    assert.equal(d.status, 0, d.stdout + d.stderr);
    assert.deepEqual(d.json.decision.binds.tiers.map((x) => x.name), ['full']);
    assert.equal(d.json.decision.binds.candidateOid, t.candidate.oid);
    const ap = s.f(['land', '--approve', t.trainId, '--accept-guard', d.json.decision.id, '--json']);
    assert.equal(ap.status, 0, ap.stdout);
    assert.equal(git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root), t.candidate.oid);
    assert.ok(ap.json.train.notes.some((n) => n.includes(`under decision ${d.json.decision.id}`)));
  });

  it('a revoked decision refuses at approve (fail closed)', () => {
    const dir = tmpRoot();
    const s = withTiers([redTier(dir, 'full', [GUARD_LINE])]);
    const t = land(s).json.train;
    const d = s.f(['decision', 'record', '--scope', 'accept-guard', '--train', t.trainId, '--words-file', words(dir), '--json']);
    assert.equal(s.f(['decision', 'revoke', d.json.decision.id, '--words-file', words(dir)]).status, 0);
    const ap = s.f(['land', '--approve', t.trainId, '--accept-guard', d.json.decision.id, '--json']);
    assert.equal(ap.status, 3);
    assert.match(ap.json.reason, /revoked/);
  });

  it('a test-failure train: decision record refuses, naming the kind', () => {
    const dir = tmpRoot();
    const s = withTiers([redTier(dir, 'full', [FAIL_LINE])]);
    const t = land(s).json.train;
    const d = s.f(['decision', 'record', '--scope', 'accept-guard', '--train', t.trainId, '--words-file', words(dir), '--json']);
    assert.equal(d.status, 3);
    assert.match(d.json.reason, /test-failure.*never covers a test failure/);
  });

  it('argv: --accept-guard only with --approve; --train only with accept-guard', () => {
    const s = withTiers([okTier(tmpRoot(), 'full')]);
    assert.equal(s.f(['land', '--accept-guard', 'dec-20261127000000-abcd']).status, 2);
    assert.equal(s.f(['decision', 'record', '--scope', 'note', '--train', 'x', '--words-file', words(tmpRoot())]).status, 2);
  });
});

describe('approvable with an accept-guard binding (pure)', () => {
  const cand = { oid: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const guardRed = { name: 'full', result: 'red', failureKind: 'guard', testsFailed: 0, guards: [{ id: 'slow', kind: 'policy' }], startedAt: '2026-11-27T10:00:00.000Z', endedAt: '2026-11-27T10:30:00.000Z' };
  const train = (r = guardRed) => ({ trainId: 't-1', phase: 'tested', candidate: cand, testCommand: [{ name: 'full', command: ['x'], stage: 'pre-land' }], tierResults: [r], result: 'red', checkResults: [] });
  const binds = (over = {}, r = guardRed) => ({ trainId: 't-1', candidateOid: cand.oid, tiers: [{ name: 'full', fingerprint: tierFingerprint('t-1', cand.oid, r), guards: ['slow'] }], ...over });

  it('admits exactly the bound guard-only red', () => {
    const a = approvable(train(), { acceptGuard: binds() });
    assert.equal(a.ok, true, a.reason);
    assert.deepEqual(a.acceptedGuards, ['full']);
  });
  it('without a binding: refused, needsAcceptGuard', () => assert.equal(approvable(train()).needsAcceptGuard, true));
  it('wrong train / wrong candidate / another result of the tier: refused', () => {
    assert.match(approvable(train(), { acceptGuard: binds({ trainId: 't-2' }) }).reason, /bound to train t-2/);
    assert.match(approvable(train(), { acceptGuard: binds({ candidateOid: 'c'.repeat(40) }) }).reason, /bound to candidate/);
    assert.match(approvable(train({ ...guardRed, endedAt: '2026-11-27T11:00:00.000Z' }), { acceptGuard: binds() }).reason, /different result/);
  });
  it('NEVER a test failure, a timeout or an unclassified red, even with a binding naming the tier', () => {
    for (const r of [{ ...guardRed, failureKind: 'test-failure', testsFailed: 2 }, { ...guardRed, failureKind: 'timeout' }, { ...guardRed, failureKind: 'unclassified', testsFailed: undefined }]) {
      const a = approvable(train(r), { acceptGuard: binds({}, r) });
      assert.equal(a.ok, false);
      assert.match(a.reason, /never a test failure/);
    }
  });
  it('a block-level check still refuses', () => {
    const t = { ...train(), checkResults: [{ name: 'c', severity: 'block', status: 'ok', findings: [{ level: 'block', message: 'm' }] }] };
    assert.equal(approvable(t, { acceptGuard: binds() }).ok, false);
  });
  it('the decision schema: binds iff accept-guard', () => {
    const base = { schemaVersion: 1, kind: 'decision', id: 'dec-20261127000000-abcd', at: '2026-11-27T00:00:00.000Z', words: 'w', recordedBy: { session: 's', hostSession: null }, expiresAt: null };
    assert.equal(DecisionSchema.safeParse({ ...base, scope: 'accept-guard', binds: binds() }).success, true);
    assert.equal(DecisionSchema.safeParse({ ...base, scope: 'accept-guard' }).success, false);
    assert.equal(DecisionSchema.safeParse({ ...base, scope: 'note', binds: binds() }).success, false);
  });
});

describe('git timeout + worktree add retry', () => {
  it('resolveGitTimeoutMs: env > config > default; an invalid env value is an error', () => {
    assert.deepEqual(resolveGitTimeoutMs({ env: {} }), { ms: 60_000, source: 'default' });
    assert.deepEqual(resolveGitTimeoutMs({ env: {}, configValue: () => 45_000 }), { ms: 45_000, source: 'config' });
    assert.deepEqual(resolveGitTimeoutMs({ env: { FLEET_GIT_TIMEOUT_MS: '90000' }, configValue: () => 45_000 }), { ms: 90_000, source: 'env' });
    for (const bad of ['abc', '10', '9999999', '1.5']) assert.throws(() => resolveGitTimeoutMs({ env: { FLEET_GIT_TIMEOUT_MS: bad } }), ConfigError);
    assert.equal(parseFleetConfig({ gitTimeoutMs: 500 }).ok, false);
  });

  it('defaultDeps.git applies gitTimeoutMs to the emitted git call; an explicit timeout still wins', () => {
    const cwd = tmpRoot();
    const slow = ['-c', 'alias.zz=!node -e "setTimeout(()=>{},4000)"', 'zz'];
    const d = defaultDeps();
    d.gitTimeoutMs = 1000;
    const r = d.git(slow, cwd);
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    assert.match(r.reason, /timed out after 1000ms/);
    d.gitTimeoutMs = 60_000;
    assert.match(d.git(slow, cwd, { timeoutMs: 1000 }).reason, /timed out after 1000ms/);
    assert.equal(d.git(['--version'], cwd).ok, true, 'negative control: a fast call under the long timeout passes');
  });

  const scripted = (adds) => {
    const calls = []; const q = [...adds];
    const deps = { git: (args) => { calls.push(args.filter((a) => !a.startsWith('core.hooksPath') && a !== '-c').join(' '));
      if (args.includes('add')) return q.shift();
      if (args[0] === 'worktree' && args[1] === 'list') return { ok: true, status: 0, stdout: 'worktree /w/t-1\0HEAD abc\0detached\0\0', stderr: '' };
      return { ok: true, status: 0, stdout: '', stderr: '' }; } };
    return { deps, calls };
  };
  const TIMEOUT = { ok: false, status: null, stdout: '', stderr: '', timedOut: true, reason: 'git worktree timed out after 15000ms' };
  const OK = { ok: true, status: 0, stdout: '', stderr: '' };

  it('a timed-out add is undone (listed → worktree remove) and retried', () => {
    const { deps, calls } = scripted([TIMEOUT, OK]);
    const sleeps = [];
    const r = addIntegrationWorktree({ deps, cwd: '/r', wt: '/w/t-1', baseOid: 'b', hooksDir: '/h', sleep: (ms) => sleeps.push(ms), exists: () => false });
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 2);
    assert.equal(r.notes.length, 1);
    assert.deepEqual(sleeps, [750]);
    assert.ok(calls.includes('worktree remove --force --force /w/t-1'));
    assert.ok(calls.includes('worktree prune'));
  });
  it('three timeouts: gives up, timedOut carried (→ reasonCode git-timeout)', () => {
    const { deps } = scripted([TIMEOUT, TIMEOUT, TIMEOUT]);
    const r = addIntegrationWorktree({ deps, cwd: '/r', wt: '/w/t-1', baseOid: 'b', hooksDir: '/h', sleep: () => {}, exists: () => false });
    assert.equal(r.ok, false);
    assert.equal(r.attempts, 3);
    assert.equal(r.timedOut, true);
  });
  it('a non-transient failure is not retried; a pre-existing directory is refused before any git call', () => {
    const { deps, calls } = scripted([{ ok: false, status: 128, stdout: '', stderr: 'fatal: invalid reference', reason: 'git worktree exited 128: fatal' }]);
    assert.equal(addIntegrationWorktree({ deps, cwd: '/r', wt: '/w/t-1', baseOid: 'b', hooksDir: '/h', sleep: () => {}, exists: () => false }).attempts, 1);
    const n = calls.length;
    assert.equal(addIntegrationWorktree({ deps, cwd: '/r', wt: '/w/t-1', baseOid: 'b', hooksDir: '/h', exists: () => true }).ok, false);
    assert.equal(calls.length, n);
  });
});

describe('a source already contained in the candidate', () => {
  /** HEAD moves only when `moves` says so; `--is-ancestor` answers from `contained`. */
  const fake = ({ contained }) => {
    let head = 'b'.repeat(40);
    const wgit = (args) => {
      if (args[0] === 'rev-parse') return { ok: true, status: 0, stdout: `${head}\n`, stderr: '' };
      if (args[0] === 'merge-base') return contained.has(args[2]) ? { ok: true, status: 0, stdout: '', stderr: '' } : { ok: false, status: 1, stdout: '', stderr: '', reason: 'exit 1' };
      if (args[0] === 'merge' && !contained.has(args.at(-1))) head = `${args.at(-1).slice(0, 1)}`.repeat(40);
      return { ok: true, status: 0, stdout: '', stderr: '' };
    };
    return wgit;
  };
  const A = { id: 'a', oid: '1'.repeat(40) }; const B = { id: 'b', oid: '2'.repeat(40) };

  it('is skipped with reasonCode already-contained, never a stop', () => {
    const r = applySources({ wgit: fake({ contained: new Set([A.oid]) }), dir: '.', sources: [B, A], mergeMethod: 'direct-merge', trainId: 't', sleep: () => {} });
    assert.equal(r.conflict, null);
    assert.deepEqual(r.skipped.map((x) => [x.sourceId, x.reasonCode]), [['a', 'already-contained']]);
  });
  it('negative control: no commit and NOT contained is still a stop, coded no-commit', () => {
    const wgit = (args) => (args[0] === 'merge-base' ? { ok: false, status: 1, stdout: '', stderr: '' } : { ok: true, status: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' });
    const r = applySources({ wgit, dir: '.', sources: [A], mergeMethod: 'direct-merge', trainId: 't', sleep: () => {} });
    assert.equal(r.conflict.reasonCode, 'no-commit');
  });
  it('ancestorsFirst puts an ancestor before its descendant, stable otherwise', () => {
    const anc = new Set(['a>c']); // a is an ancestor of c
    assert.deepEqual(ancestorsFirst(['c', 'b', 'a'], (x, y) => anc.has(`${x}>${y}`)), ['b', 'a', 'c']);
    assert.deepEqual(ancestorsFirst(['x', 'y'], () => null), ['x', 'y'], 'an unanswered question adds no edge');
    assert.deepEqual(ancestorsFirst(['x', 'y'], () => true), ['x', 'y'], 'equal commits keep their order');
  });
  it('end to end: a branch and its ancestor in one direct-merge train land, the ancestor ordered first', () => {
    const s = setup({ fleetConfig: { mergeMethod: 'direct-merge', testCommand: { tiers: [{ name: 'default', command: ['node', '-e', ''] }] } } });
    readyBranch(s, 'base-a', { 'a.txt': 'A\n' });
    // A descendant of base-a, registered as its own session.
    const facts = { registry: { sessions: [{ id: 'x', ready: { oid: git(['rev-parse', 'base-a'], s.fx.repo) } }, { id: 'y', ready: { oid: git(['rev-parse', 'main'], s.fx.repo) } }] } };
    const o = orderAncestorsFirst(['x', 'y'], facts, (args) => runGit(args, s.fx.repo), s.fx.repo);
    assert.deepEqual(o.ids, ['y', 'x'], 'main is an ancestor of base-a');
    assert.match(o.note, /ancestors first/);
  });
});
