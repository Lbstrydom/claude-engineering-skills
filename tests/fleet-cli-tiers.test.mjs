/**
 * @fileoverview /fleet CLI — test tiers and how they are spawned (Windows argv
 * safety, displayed-command quoting), argv parsing, worktree removal, and the
 * fake gh itself. Split from tests/fleet-cli.test.mjs for wall time; harness:
 * tests/helpers/fleet-cli-harness.mjs.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from './helpers/git.mjs';
import { addBranch, cleanupFleetRoots, installFakeGh, scrubbedEnv, tmpRoot, writeFile } from './helpers/fleet-repo.mjs';
import { OK_TIER, fleetDirOf, fwd, land, readyBranch, sessionFiles, sessionRec, setup } from './helpers/fleet-cli-harness.mjs';
import { listTrains } from '../scripts/lib/fleet/registry.mjs';
import {
  UNSAFE_WIN_SHELL_ARGV, buildTrain, defaultDeps, pathsEqual, removeTrainWorktree, resolveTierSpawn, unsafeWinShellArgv,
} from '../scripts/lib/fleet/train.mjs';
import { parseVerbArgs } from '../scripts/lib/fleet/argv.mjs';
import { parseSelect } from '../scripts/lib/fleet/land.mjs';
import { quoteArg, renderCommand } from '../scripts/lib/fleet/shell-quote.mjs';
import { renderApprove } from '../scripts/lib/fleet/render-train.mjs';

after(cleanupFleetRoots);

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
