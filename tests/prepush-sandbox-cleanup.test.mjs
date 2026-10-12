/**
 * @fileoverview Behavioural guards for the pre-push sandbox's cleanup path.
 *
 * The bug these pin (measured 2026-08-01): `git worktree remove --force` EXITS
 * 0 while leaving the sandbox directory on disk, because the sandbox always
 * contains a `node_modules` entry git declines to delete. The runner trusted
 * that exit code, so its fallback `rmSync` — which sat in the `catch` — never
 * ran, and one husk leaked per push with no signal at all.
 *
 * These are behavioural, not source-regex, tests: the failure was a wrong
 * belief about what a subprocess's exit code proves, and only touching the
 * filesystem can falsify that class of belief.
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  PRESERVED_EVIDENCE_FILE,
  SANDBOX_PREFIX,
  STALE_SANDBOX_AGE_MS,
  describeSweep,
  findStaleSandboxes,
  probePidAlive,
  removeSandboxDir,
  sandboxOwnerPid,
  surveySandboxes,
  sweepStaleSandboxes,
} from '../scripts/lib/prepush-sandbox-cleanup.mjs';

const IS_WIN = process.platform === 'win32';

/** A git env with the hook-leaked locals stripped, so fixture repos created
 *  here are genuinely isolated. Without this, a run INSIDE the pre-push
 *  sandbox inherits GIT_DIR — which git gives precedence over `cwd`, so the
 *  fixture's commits would land on the real repo's HEAD (the documented
 *  2026-07-23 incident class). */
function isolatedGitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: isolatedGitEnv() }).trim();
}

describe('removeSandboxDir — reports the postcondition, not a success signal', () => {
  let root;
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-cleanup-test-')); });
  after(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('treats an already-absent directory as removed', () => {
    const missing = path.join(root, 'never-existed');
    assert.deepEqual(removeSandboxDir(missing), { removed: true });
  });

  it('removes a plain directory tree', () => {
    const dir = path.join(root, 'plain');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', 'f.txt'), 'x');

    assert.equal(removeSandboxDir(dir).removed, true);
    assert.equal(fs.existsSync(dir), false);
  });

  it('removes a directory containing a node_modules junction WITHOUT deleting the target', () => {
    // The exact shape provisionNodeModules() creates on the common path. If
    // removal ever started following the link, it would delete the MAIN
    // checkout's real node_modules — a far worse bug than the leak.
    const target = path.join(root, 'real-modules');
    fs.mkdirSync(path.join(target, 'somepkg'), { recursive: true });
    fs.writeFileSync(path.join(target, 'somepkg', 'index.js'), 'module.exports = 1;');

    const sandbox = path.join(root, 'sandbox-linked');
    fs.mkdirSync(sandbox, { recursive: true });
    fs.symlinkSync(target, path.join(sandbox, 'node_modules'), 'junction');

    assert.equal(removeSandboxDir(sandbox).removed, true);
    assert.equal(fs.existsSync(sandbox), false);
    assert.equal(
      fs.existsSync(path.join(target, 'somepkg', 'index.js')), true,
      'removal must not follow the junction into the real node_modules',
    );
  });

  it('reports removed:false with an error rather than throwing', () => {
    // A cleanup path that throws would convert a temp-file problem into a
    // failed push. Force the failure by pointing at a path whose parent is a
    // FILE, which makes the recursive removal fail on every platform.
    const file = path.join(root, 'a-file');
    fs.writeFileSync(file, 'x');
    const impossible = path.join(file, 'child');

    let result;
    assert.doesNotThrow(() => { result = removeSandboxDir(impossible); });
    // ENOTDIR surfaces as a non-existent path on some platforms; either way
    // the contract is "never throws" and "the answer is a boolean".
    assert.equal(typeof result.removed, 'boolean');
  });
});

describe('findStaleSandboxes — age rule and prefix scoping', () => {
  let tmp;
  const NOW = 1_800_000_000_000; // fixed clock; the module accepts an injected `now`

  const makeDir = (name, ageMs) => {
    const abs = path.join(tmp, name);
    fs.mkdirSync(abs, { recursive: true });
    const when = new Date(NOW - ageMs);
    fs.utimesSync(abs, when, when);
    return abs;
  };

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-sweep-test-')); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('never sweeps a young husk — a CONCURRENT push\'s live sandbox is always young', () => {
    // This is the safety property of the whole sweep: two sessions share this
    // repo's tree, so a second push can have a live sandbox on disk right now.
    const live = makeDir(`${SANDBOX_PREFIX}abc12345-${process.pid}`, 60_000);
    const stale = findStaleSandboxes(tmp, { now: NOW });
    assert.equal(stale.includes(live), false, 'a 1-minute-old sandbox must never be swept');
  });

  it('sweeps a husk older than the threshold', () => {
    const old = makeDir(`${SANDBOX_PREFIX}def67890-2222`, STALE_SANDBOX_AGE_MS + 60_000);
    assert.ok(findStaleSandboxes(tmp, { now: NOW }).includes(old));
  });

  it('ignores other tools\' and other suites\' temp dirs', () => {
    // %TEMP% is shared. This repo alone also leaves ces-db-test-* and
    // ces-arch-gate-* fixtures around, owned by different code.
    const foreign = makeDir('ces-db-test-XxxRJ7', STALE_SANDBOX_AGE_MS * 10);
    const alien = makeDir('some-other-tool-cache', STALE_SANDBOX_AGE_MS * 10);
    const found = findStaleSandboxes(tmp, { now: NOW });
    assert.equal(found.includes(foreign), false);
    assert.equal(found.includes(alien), false);
  });

  it('ignores files that merely share the prefix', () => {
    const f = path.join(tmp, `${SANDBOX_PREFIX}not-a-dir`);
    fs.writeFileSync(f, 'x');
    const when = new Date(NOW - STALE_SANDBOX_AGE_MS * 2);
    fs.utimesSync(f, when, when);
    assert.equal(findStaleSandboxes(tmp, { now: NOW }).includes(f), false);
  });

  it('returns [] for an unreadable temp dir instead of throwing', () => {
    assert.deepEqual(findStaleSandboxes(path.join(tmp, 'does-not-exist'), { now: NOW }), []);
  });

  it('surveySandboxes reports the husks it deliberately LEFT, not just the ones it takes', () => {
    // Silence is ambiguous (2026-08-30). The runner logged only when it swept,
    // so "temp is clean" and "three husks are here, all too young" printed
    // identically — and a failing push with three husks on disk was read as a
    // broken sweeper for hours. Measured afterwards: the oldest was 3h old
    // against a 6h threshold, and the sweep had been exactly right.
    const young = makeDir(`${SANDBOX_PREFIX}beef0001-${process.pid}`, 3 * 60 * 60 * 1000);
    const { stale, young: retained } = surveySandboxes(tmp, { now: NOW });
    assert.equal(stale.includes(young), false, 'a 3h husk is not stale under a 6h threshold');
    const row = retained.find((h) => h.dir === young);
    assert.ok(row, 'the husk it declined to sweep must be REPORTED, not silently dropped');
    assert.equal(row.ageMs, 3 * 60 * 60 * 1000, 'the age must be carried so the caller can name it');
  });

  it('surveySandboxes ignores foreign temp dirs in BOTH buckets', () => {
    // A prefix-scoping bug that leaked only into the new `young` bucket would
    // make the runner report other tools' temp dirs as this gate's husks.
    const foreign = makeDir('ces-db-test-YoUnG1', 60_000);
    const { stale, young } = surveySandboxes(tmp, { now: NOW });
    assert.equal(stale.includes(foreign), false);
    assert.equal(young.some((h) => h.dir === foreign), false);
  });

  it('sweepStaleSandboxes carries `young` through so the caller need not re-scan', () => {
    const fresh = makeDir(`${SANDBOX_PREFIX}beef0002-${process.pid}`, 30_000);
    const { young } = sweepStaleSandboxes(tmp, { now: NOW });
    assert.ok(young.some((h) => h.dir === fresh));
    assert.equal(fs.existsSync(fresh), true, 'a young husk must survive the sweep');
  });

  it('sweepStaleSandboxes actually removes what it reports (not a vacuous green)', () => {
    const doomed = makeDir(`${SANDBOX_PREFIX}cafe0001-3333`, STALE_SANDBOX_AGE_MS * 2);
    const { swept, failed } = sweepStaleSandboxes(tmp, { now: NOW });
    assert.equal(failed.length, 0);
    assert.ok(swept.includes(doomed), 'the doomed husk must be reported swept');
    assert.equal(fs.existsSync(doomed), false, 'reported-swept must mean gone from disk');
  });
});

/** A real pid that is provably gone: spawn a child that exits, then ASK the probe.
 *  The precondition is the instrument check — a reused pid would make every
 *  "dead owner" assertion below pass or fail for the wrong reason. */
function exitedChildPid() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { pid } = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    if (Number.isInteger(pid) && probePidAlive(pid) === 'dead') return pid;
  }
  throw new Error('could not obtain a pid the probe reports dead — the dead-owner fixtures cannot be trusted');
}

describe('sandboxOwnerPid / probePidAlive — the two facts the dead-owner rule rests on', () => {
  it('pins the marker name operators and the runbook already know', () => {
    assert.equal(PRESERVED_EVIDENCE_FILE, '.prepush-npm-ci.log');
  });

  it('reads the pid after the LAST dash and nothing else', () => {
    assert.equal(sandboxOwnerPid(`${SANDBOX_PREFIX}a4d6ea00-77848`), 77848);
    assert.equal(sandboxOwnerPid(`${SANDBOX_PREFIX}fc2be6f7-82364`), 82364);
    assert.equal(sandboxOwnerPid(`${SANDBOX_PREFIX}fixture-12`), 12);
  });

  it('refuses a name with no usable pid — 0 would address a whole process GROUP', () => {
    assert.equal(sandboxOwnerPid(`${SANDBOX_PREFIX}abc12345-0`), null);
    assert.equal(sandboxOwnerPid(`${SANDBOX_PREFIX}not-a-pid`), null);
    assert.equal(sandboxOwnerPid(`${SANDBOX_PREFIX}abc12345-`), null);
    assert.equal(sandboxOwnerPid(`${SANDBOX_PREFIX}abc12345-99999999999999999999`), null, 'beyond a safe integer');
  });

  it('reports this very process alive and an exited child dead (real probe, no mock)', () => {
    assert.equal(probePidAlive(process.pid), 'alive');
    assert.equal(probePidAlive(exitedChildPid()), 'dead');
  });

  it('maps errno honestly: only ESRCH is dead, EPERM is alive, anything else is unknown', () => {
    const failWith = (code) => mock.method(process, 'kill', () => { throw Object.assign(new Error(code), { code }); });
    try {
      let m = failWith('ESRCH'); assert.equal(probePidAlive(4242), 'dead'); m.mock.restore();
      m = failWith('EPERM'); assert.equal(probePidAlive(4242), 'alive', 'it exists; we just may not signal it'); m.mock.restore();
      m = failWith('EINVAL'); assert.equal(probePidAlive(4242), 'unknown'); m.mock.restore();
    } finally {
      mock.restoreAll();
    }
  });
});

describe('owner liveness — a killed push\'s husk goes at once; a live push\'s sandbox never does', () => {
  let tmp;
  let liveChild;
  const NOW = 1_800_000_000_000;

  /** Files go in BEFORE the mtime is pinned: creating a file bumps the directory's mtime. */
  const makeDir = (name, ageMs, files = []) => {
    const abs = path.join(tmp, name);
    fs.mkdirSync(abs, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(abs, f), 'x');
    const when = new Date(NOW - ageMs);
    fs.utimesSync(abs, when, when);
    return abs;
  };
  const YOUNG = 30_000;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-owner-test-'));
    // A genuinely different, genuinely running process: the concurrent push.
    liveChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  });
  after(() => {
    try { liveChild.kill(); } catch { /* already gone */ }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('sweeps a MINUTES-old husk whose owner is dead, and the disk agrees', () => {
    const dir = makeDir(`${SANDBOX_PREFIX}dead0001-${exitedChildPid()}`, YOUNG);
    assert.equal(fs.existsSync(dir), true, 'fixture must exist before the sweep, or the assertion below is vacuous');

    const { swept, sweptDeadOwner, failed } = sweepStaleSandboxes(tmp, { now: NOW });

    assert.equal(failed.length, 0);
    assert.ok(swept.includes(dir) && sweptDeadOwner.includes(dir), 'swept, and reported as swept FOR ITS DEAD OWNER');
    assert.equal(fs.existsSync(dir), false, 'reported-swept must mean gone from disk');
  });

  it('NEGATIVE CONTROL: the same husk survives when the probe says its owner is alive', () => {
    // Proves the dead verdict is what condemned the previous husk, not the age
    // rule, the prefix scope or an accident of the fixture.
    const dir = makeDir(`${SANDBOX_PREFIX}dead0002-${exitedChildPid()}`, YOUNG);

    const { swept } = sweepStaleSandboxes(tmp, { now: NOW, probeOwner: () => 'alive' });

    assert.equal(swept.includes(dir), false);
    assert.equal(fs.existsSync(dir), true);
  });

  it('NEVER sweeps a husk whose owner is a LIVE other process — a concurrent push\'s sandbox', () => {
    assert.equal(probePidAlive(liveChild.pid), 'alive', 'precondition: the other process really is running');
    const dir = makeDir(`${SANDBOX_PREFIX}live0001-${liveChild.pid}`, YOUNG);

    const { swept, young } = sweepStaleSandboxes(tmp, { now: NOW });

    assert.equal(swept.includes(dir), false, 'a running push\'s sandbox must survive another push\'s sweep');
    assert.equal(fs.existsSync(dir), true);
    assert.equal(young.find((h) => h.dir === dir)?.retained, 'owner-alive', 'and the reason must be reported, not silent');
  });

  it('NEVER sweeps this process\'s own pid either (the live owner is the sweeper itself)', () => {
    const dir = makeDir(`${SANDBOX_PREFIX}self0001-${process.pid}`, YOUNG);
    assert.equal(sweepStaleSandboxes(tmp, { now: NOW }).swept.includes(dir), false);
    assert.equal(fs.existsSync(dir), true);
  });

  it('keeps an evidence-preserving husk on the age rule even though its owner exited', () => {
    // A failed npm ci preserves the sandbox on purpose: the owner exits
    // NORMALLY, so its dead pid means "finished", not "killed".
    const dir = makeDir(`${SANDBOX_PREFIX}keep0001-${exitedChildPid()}`, YOUNG, [PRESERVED_EVIDENCE_FILE]);

    const { swept, young } = sweepStaleSandboxes(tmp, { now: NOW });

    assert.equal(swept.includes(dir), false);
    assert.equal(fs.existsSync(dir), true);
    assert.equal(young.find((h) => h.dir === dir)?.retained, 'evidence-preserved');
  });

  it('...but still sweeps that preserved husk once it is old (the age rule is unchanged)', () => {
    const dir = makeDir(`${SANDBOX_PREFIX}keep0002-${exitedChildPid()}`, STALE_SANDBOX_AGE_MS + 60_000, [PRESERVED_EVIDENCE_FILE]);
    const { swept, sweptDeadOwner } = sweepStaleSandboxes(tmp, { now: NOW });
    assert.ok(swept.includes(dir));
    assert.equal(sweptDeadOwner.includes(dir), false, 'removed for its age, so it must not be reported as a dead-owner sweep');
    assert.equal(fs.existsSync(dir), false);
  });

  for (const [label, probeOwner] of [
    ['reports unknown', () => 'unknown'],
    ['throws', () => { throw new Error('probe broke'); }],
  ]) {
    it(`falls back to the age rule when the liveness probe ${label}`, () => {
      const dir = makeDir(`${SANDBOX_PREFIX}unk-${label.replace(/W/g, '')}-${exitedChildPid()}`, YOUNG);

      const { swept, young } = sweepStaleSandboxes(tmp, { now: NOW, probeOwner });

      assert.equal(swept.includes(dir), false, 'no proof of death, no early sweep');
      assert.equal(fs.existsSync(dir), true);
      assert.equal(young.find((h) => h.dir === dir)?.retained, 'owner-unknown');
    });
  }

  it('falls back to the age rule for a name carrying no pid', () => {
    const dir = makeDir(`${SANDBOX_PREFIX}nopid-here`, YOUNG);
    const { swept, young } = sweepStaleSandboxes(tmp, { now: NOW, probeOwner: () => { throw new Error('must not be consulted'); } });
    assert.equal(swept.includes(dir), false);
    assert.equal(young.find((h) => h.dir === dir)?.retained, 'no-owner-pid');
  });

  it('does not touch another tool\'s directory just because its name ends in a dead pid', () => {
    const foreign = makeDir(`ces-db-test-${exitedChildPid()}`, YOUNG);
    const alien = makeDir(`some-other-tool-${exitedChildPid()}`, YOUNG);
    const { swept, young } = sweepStaleSandboxes(tmp, { now: NOW });
    assert.equal(swept.includes(foreign) || swept.includes(alien), false);
    assert.equal(young.some((h) => h.dir === foreign || h.dir === alien), false);
    assert.equal(fs.existsSync(foreign) && fs.existsSync(alien), true);
  });

  it('removes a dead owner\'s husk WITHOUT following its node_modules junction into the real tree', () => {
    // The shape provisionNodeModules() leaves behind. A sweep that began running
    // minutes after a kill rather than hours must not become the thing that
    // empties the main checkout's real node_modules.
    const real = path.join(tmp, 'real-modules');
    fs.mkdirSync(path.join(real, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(real, 'pkg', 'index.js'), '1;');
    const dir = path.join(tmp, `${SANDBOX_PREFIX}junc0001-${exitedChildPid()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(real, path.join(dir, 'node_modules'), 'junction');
    const when = new Date(NOW - YOUNG);
    fs.utimesSync(dir, when, when);

    const { swept } = sweepStaleSandboxes(tmp, { now: NOW });

    assert.ok(swept.includes(dir));
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(path.join(real, 'pkg', 'index.js')), true, 'the real node_modules must survive');
  });
});

describe('malformed owner tokens never read as a pid', () => {
  const NOW = 1_800_000_000_000;

  it('rejects a second hyphen, a leading zero and zero (the owner token is a plain positive decimal)', () => {
    assert.equal(sandboxOwnerPid(`${SANDBOX_PREFIX}abc12345--82364`), null, 'a signed/malformed token is not pid 82364');
    assert.equal(sandboxOwnerPid(`${SANDBOX_PREFIX}abc12345---1`), null);
    assert.equal(sandboxOwnerPid(`${SANDBOX_PREFIX}abc12345-007`), null);
    assert.equal(sandboxOwnerPid(`${SANDBOX_PREFIX}abc12345-82364`), 82364, 'vacuous-pass guard: the well-formed shape still parses');
  });

  it('keeps a young husk with a malformed token on the age rule, even when the digits name a dead process', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-token-test-'));
    try {
      const dir = path.join(tmp, `${SANDBOX_PREFIX}abc12345--${exitedChildPid()}`);
      fs.mkdirSync(dir);
      const when = new Date(NOW - 30_000);
      fs.utimesSync(dir, when, when);

      const { swept, young } = sweepStaleSandboxes(tmp, { now: NOW });

      assert.equal(swept.includes(dir), false);
      assert.equal(fs.existsSync(dir), true);
      assert.equal(young.find((h) => h.dir === dir)?.retained, 'no-owner-pid');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('unsurveyed — "found nothing" is never also "could not look"', () => {
  const NOW = 1_800_000_000_000;
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-unsurveyed-test-')); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  const makeDir = (name, ageMs) => {
    const abs = path.join(tmp, name);
    fs.mkdirSync(abs, { recursive: true });
    const when = new Date(NOW - ageMs);
    fs.utimesSync(abs, when, when);
    return abs;
  };

  it('names an unreadable temp dir instead of returning a bare empty survey', () => {
    const missing = path.join(tmp, 'does-not-exist');
    const survey = surveySandboxes(missing, { now: NOW });
    assert.deepEqual([survey.stale, survey.young], [[], []]);
    assert.deepEqual(survey.unsurveyed, [{ path: missing, code: 'ENOENT' }]);
    assert.deepEqual(sweepStaleSandboxes(missing, { now: NOW }).unsurveyed, [{ path: missing, code: 'ENOENT' }]);
  });

  it('reports an entry it could not stat (EACCES), but not one that merely vanished (ENOENT)', () => {
    const denied = makeDir(`${SANDBOX_PREFIX}deny0001-${process.pid}`, 30_000);
    const vanished = makeDir(`${SANDBOX_PREFIX}gone0001-${process.pid}`, 30_000);
    const kept = makeDir(`${SANDBOX_PREFIX}seen0001-${process.pid}`, 30_000);
    const realStat = fs.statSync;
    mock.method(fs, 'statSync', (p, ...rest) => {
      if (p === denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (p === vanished) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return realStat(p, ...rest);
    });
    let survey;
    try { survey = surveySandboxes(tmp, { now: NOW }); } finally { mock.restoreAll(); }

    assert.deepEqual(survey.unsurveyed, [{ path: denied, code: 'EACCES' }], 'only the genuine inspection failure is reported');
    assert.equal(survey.young.some((h) => h.dir === kept), true, 'vacuous-pass guard: the survey still saw the husk it could stat');
    assert.equal([...survey.stale, ...survey.young.map((h) => h.dir)].includes(denied), false);
  });

  it('reports nothing unsurveyed on a healthy survey', () => {
    assert.deepEqual(surveySandboxes(tmp, { now: NOW }).unsurveyed, []);
  });
});

describe('describeSweep — the emitted wording and counts, not the runner source', () => {
  const T = '/tmp/x';
  const H = 3_600_000;
  const empty = { swept: [], sweptDeadOwner: [], failed: [], young: [], unsurveyed: [] };

  it('is silent when there is genuinely nothing to say', () => {
    assert.deepEqual(describeSweep(empty, T), []);
  });

  it('says a husk went for its DEAD OWNER, and counts the rest as age', () => {
    assert.deepEqual(
      describeSweep({ ...empty, swept: ['a', 'b'], sweptDeadOwner: ['a'] }, T),
      ['  swept 2 stale sandbox husk(s) from /tmp/x (1 owner process dead, 1 by age)'],
    );
    assert.deepEqual(
      describeSweep({ ...empty, swept: ['a'], sweptDeadOwner: ['a'] }, T),
      ['  swept 1 stale sandbox husk(s) from /tmp/x (1 owner process dead)'],
    );
    assert.deepEqual(
      describeSweep({ ...empty, swept: ['a'] }, T),
      ['  swept 1 stale sandbox husk(s) from /tmp/x'],
      'a sweep for age alone carries no dead-owner claim',
    );
  });

  it('separates "owned by a running push" from "owner could not be shown dead" when it swept nothing', () => {
    const young = [
      { dir: 'a', ageMs: 3 * H, retained: 'owner-alive' },
      { dir: 'b', ageMs: 1 * H, retained: 'evidence-preserved' },
      { dir: 'c', ageMs: 2 * H, retained: 'owner-unknown' },
    ];
    assert.deepEqual(describeSweep({ ...empty, young }, T), [
      '  3 sandbox husk(s) present, none swept — oldest is 3.0h old, under the 6h threshold'
      + '; 1 owned by a running push'
      + '; 2 kept because their owner could not be shown dead (evidence-preserved, no pid, or liveness unknown)',
    ]);
    const onlyLive = [{ dir: 'a', ageMs: 0.5 * H, retained: 'owner-alive' }];
    assert.deepEqual(describeSweep({ ...empty, young: onlyLive }, T), [
      '  1 sandbox husk(s) present, none swept — oldest is 0.5h old, under the 6h threshold; 1 owned by a running push',
    ]);
  });

  it('does not repeat the "none swept" line once something WAS swept', () => {
    const lines = describeSweep({ ...empty, swept: ['a'], young: [{ dir: 'b', ageMs: H, retained: 'owner-alive' }] }, T);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^ {2}swept 1 /);
  });

  it('warns for an un-removable husk and for paths it could not inspect', () => {
    assert.deepEqual(describeSweep({ ...empty, failed: ['/tmp/x/ces-prepush-a-1'] }, T), [
      '  ⚠ 1 stale sandbox husk(s) still un-removable, e.g. /tmp/x/ces-prepush-a-1',
    ]);
    assert.deepEqual(describeSweep({ ...empty, unsurveyed: [{ path: '/tmp/x/ces-prepush-b-2', code: 'EACCES' }] }, T), [
      '  ⚠ could not inspect 1 path(s) under /tmp/x, e.g. /tmp/x/ces-prepush-b-2 (EACCES) — husks there were neither swept nor counted',
    ]);
  });

  it('tolerates a result that predates the optional fields', () => {
    assert.deepEqual(describeSweep({ swept: ['a'], failed: [], young: [] }, T), ['  swept 1 stale sandbox husk(s) from /tmp/x']);
  });
});

describe('the motivating defect: git worktree remove exits 0 but leaves the directory', () => {
  let repo;
  let sandbox;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-wt-fixture-'));
    git(['init', '--quiet'], repo);
    git(['config', 'user.email', 'test@example.com'], repo);
    git(['config', 'user.name', 'Test'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    git(['add', 'README.md'], repo);
    git(['commit', '--quiet', '-m', 'seed fixture'], repo);

    sandbox = path.join(os.tmpdir(), `${SANDBOX_PREFIX}fixture-${process.pid}`);
    git(['worktree', 'add', '--detach', '--quiet', sandbox, 'HEAD'], repo);

    // Reproduce provisionNodeModules()'s common path exactly.
    const modules = path.join(repo, 'node_modules');
    fs.mkdirSync(path.join(modules, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(modules, 'pkg', 'index.js'), '1;');
    fs.symlinkSync(modules, path.join(sandbox, 'node_modules'), 'junction');
  });

  after(() => {
    removeSandboxDir(sandbox);
    try { git(['worktree', 'prune'], repo); } catch { /* fixture teardown */ }
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it(`git reports success yet leaves the husk behind${IS_WIN ? '' : ' (win32 only — skipped)'}`, (t) => {
    if (!IS_WIN) return t.skip('the exit-0-with-leftovers behaviour was measured on Windows');

    const status = execFileSync('git', ['worktree', 'remove', '--force', sandbox], {
      cwd: repo, encoding: 'utf-8', env: isolatedGitEnv(),
    });
    assert.equal(typeof status, 'string', 'git exited 0 — execFileSync throws on non-zero');
    assert.equal(
      fs.existsSync(sandbox), true,
      'THE BUG: git exits 0 while the directory survives. If this ever fails, git or the '
      + 'platform changed and the verify-by-stat below is now belt-and-braces rather than load-bearing.',
    );
    assert.deepEqual(fs.readdirSync(sandbox), ['node_modules'], 'the surviving entry is node_modules');
  });

  it('verify-by-stat finishes the job git left undone', () => {
    // Platform-independent: whatever git did or did not leave, the runner's
    // cleanup contract is that the directory is gone afterwards.
    try {
      execFileSync('git', ['worktree', 'remove', '--force', sandbox], {
        cwd: repo, stdio: 'ignore', env: isolatedGitEnv(),
      });
    } catch { /* the point is that its outcome is not the evidence */ }

    assert.equal(removeSandboxDir(sandbox).removed, true);
    assert.equal(fs.existsSync(sandbox), false);
    assert.equal(
      fs.existsSync(path.join(repo, 'node_modules', 'pkg', 'index.js')), true,
      'the real node_modules must survive the sandbox cleanup',
    );
  });
});
