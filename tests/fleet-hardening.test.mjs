/**
 * @fileoverview /fleet hardening — three defects the storyline-feedback audit found in code
 * that change did not touch:
 *   1. a tier timeout killed only the process it spawned, leaving its descendants running in
 *      the integration worktree (and a check hook that exited could leave quiet strays);
 *   2. the `fleet repair` hint was a hard-coded `fleet`, not how the operator invokes the CLI;
 *   3. `currentBranch` returned null for BOTH a detached HEAD and a failed `git` call.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from './helpers/git.mjs';
import { superviseTier } from '../scripts/lib/fleet/tier-supervisor.mjs';
import { spawnTier } from '../scripts/lib/fleet/train.mjs';
import { spawnExec } from '../scripts/lib/fleet/checks.mjs';
import { renderClaimVerdict } from '../scripts/lib/fleet/render.mjs';
import { RegistryError } from '../scripts/lib/fleet/registry.mjs';
import { GitUnavailableError, cmdClaim, headState, currentBranch } from '../scripts/lib/fleet/commands.mjs';
import { ArgvError } from '../scripts/lib/cli-io.mjs';
import { makeFleetRepo, tmpRoot, cleanupFleetRoots } from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const IS_WIN = process.platform === 'win32';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function settle(pid, ms = 4000) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return alive(pid);
}
const killQuietly = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };

/** A launcher that starts a long-lived grandchild (holding NO pipe), records its pid, then runs/exits. */
function launcher(dir, { exitNow }) {
  const script = path.join(dir, 'launcher.mjs');
  fs.writeFileSync(script, [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
    'c.unref(); // otherwise the launcher itself waits for the grandchild and never exits',
    'fs.writeFileSync(process.argv[2], String(c.pid));',
    exitNow ? "process.stdout.write(JSON.stringify({ schemaVersion: 1, findings: [] }));" : 'setTimeout(() => {}, 60000);',
  ].join('\n'));
  return script;
}

describe('a tier timeout ends the whole process tree', () => {
  // Measured 2026-10-06 on this Windows host: killing a node parent also reaped its node grandchild, so
  // the defect does not reproduce there; it does on POSIX (process groups are not killed by a plain kill).
  it('control: the old spawnSync({timeout}) leaves the grandchild running (so this test can fail)', { skip: IS_WIN && 'win32 reaps this fixture\'s grandchild on its own' }, async () => {
    const dir = tmpRoot('fleet-tier-ctl-');
    const pidFile = path.join(dir, 'pid');
    spawnSync(process.execPath, [launcher(dir, { exitNow: false }), pidFile], { timeout: 1500, killSignal: 'SIGKILL', stdio: 'ignore' });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const stillAlive = alive(pid);
    killQuietly(pid);
    assert.equal(stillAlive, true, 'the defect this guards against: a descendant outlives a plain spawnSync timeout');
  });

  it('superviseTier kills the grandchild on timeout and reports timedOut', async () => {
    const dir = tmpRoot('fleet-tier-');
    const pidFile = path.join(dir, 'pid');
    const r = superviseTier({ file: process.execPath, args: [launcher(dir, { exitNow: false }), pidFile], shell: false, cwd: dir, logPath: path.join(dir, 'log.txt'), timeoutMs: 1500 });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    try {
      assert.equal(r.timedOut, true);
      assert.equal(r.error, null, 'a timeout is reported as timedOut, not as an error');
      assert.equal(await settle(pid), false, 'the grandchild must be gone');
    } finally { killQuietly(pid); }
  });

  it('spawnTier (the land seam) is wired through the supervisor', async () => {
    const dir = tmpRoot('fleet-tier-seam-');
    const pidFile = path.join(dir, 'pid');
    const r = spawnTier({ tier: { name: 't', command: [process.execPath, launcher(dir, { exitNow: false }), pidFile] }, cwd: dir, logPath: path.join(dir, 'log.txt'), timeoutMs: 1500 });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    try {
      assert.equal(r.timedOut, true);
      assert.equal(await settle(pid), false);
    } finally { killQuietly(pid); }
  });

  it('exit code and log capture are unchanged', () => {
    const dir = tmpRoot('fleet-tier-io-');
    const logPath = path.join(dir, 'log.txt');
    const r = superviseTier({ file: process.execPath, args: ['-e', "console.log('tier-says-hi'); console.error('and-stderr'); process.exit(3)"], shell: false, cwd: dir, logPath, timeoutMs: 20000 });
    assert.deepEqual([r.exitCode, r.timedOut, r.error], [3, false, null]);
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /tier-says-hi/);
    assert.match(log, /and-stderr/);
  });

  it('a tier that cannot start is an error, not a hang or a pass', () => {
    const dir = tmpRoot('fleet-tier-enoent-');
    const r = superviseTier({ file: path.join(dir, 'definitely-not-a-program'), args: [], shell: false, cwd: dir, logPath: path.join(dir, 'log.txt'), timeoutMs: 20000 });
    assert.equal(r.exitCode, null);
    assert.ok(r.error, 'the failure to start must be reported');
  });

  it('POSIX: a tier that EXITS leaving a quiet descendant does not leak it', { skip: IS_WIN && 'win32 cannot find strays once the parent has exited (documented limit)' }, async () => {
    const dir = tmpRoot('fleet-tier-stray-');
    const pidFile = path.join(dir, 'pid');
    const r = superviseTier({ file: process.execPath, args: [launcher(dir, { exitNow: true }), pidFile], shell: false, cwd: dir, logPath: path.join(dir, 'log.txt'), timeoutMs: 20000 });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    try {
      assert.equal(r.exitCode, 0);
      assert.equal(await settle(pid), false);
    } finally { killQuietly(pid); }
  });
});

describe('a check hook that exits does not leak quiet descendants (POSIX)', () => {
  it('reaps a descendant that holds no pipe', { skip: IS_WIN && 'win32 cannot find strays once the parent has exited (documented limit)' }, async () => {
    const dir = tmpRoot('fleet-hook-stray-');
    const pidFile = path.join(dir, 'pid');
    const r = spawnExec([process.execPath, launcher(dir, { exitNow: true }), pidFile], { cwd: dir, input: '{}', timeoutMs: 20000 });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    try {
      assert.equal(r.status, 0);
      assert.equal(await settle(pid), false, 'the pre-fix supervisor only reaped descendants holding the pipes');
    } finally { killQuietly(pid); }
  });
});

describe('the repair hint names how the operator invokes the CLI', () => {
  const refused = { ok: false, verdict: 'refused', conflicts: [], reason: 'registry incomplete' };
  it('uses the supplied command, defaulting to fleet', () => {
    assert.match(renderClaimVerdict(refused, { cmd: 'node scripts/fleet.mjs' }), /`node scripts\/fleet\.mjs repair --quarantine <file>`/);
    assert.match(renderClaimVerdict(refused), /`fleet repair --quarantine <file>`/);
  });
  it('RegistryError carries an optional repairFile (the invalid-record path is pinned in fleet-registry.test.mjs)', () => {
    const e = new RegistryError('TARGET_INVALID', 'refusing to overwrite an invalid record (x)', { repairFile: 'a.json' });
    assert.equal(e.repairFile, 'a.json');
    assert.equal(new RegistryError('REV_STALE', 'stale').repairFile, undefined);
  });
});

describe('headState keeps a detached HEAD apart from a failed git call', () => {
  it('branch / detached / git-failed are three different answers', () => {
    const { repo } = makeFleetRepo();
    assert.deepEqual(headState(repo), { ok: true, branch: 'main', detached: false });
    git(['checkout', '-q', '--detach'], repo);
    assert.deepEqual(headState(repo), { ok: true, branch: null, detached: true });
    const notARepo = tmpRoot('fleet-nogit-');
    const h = headState(notARepo);
    assert.equal(h.ok, false);
    assert.ok(h.reason);
    assert.equal(currentBranch(repo), null, 'the legacy helper still collapses detached to null');
  });

  it('selfId: detached is an argument error; a failed git call is an operational error', () => {
    const { repo } = makeFleetRepo();
    git(['checkout', '-q', '--detach'], repo);
    assert.throws(() => cmdClaim({ cwd: repo }, {}), (e) => e instanceof ArgvError && /detached/.test(e.message));
    const notARepo = tmpRoot('fleet-nogit2-');
    assert.throws(() => cmdClaim({ cwd: notARepo }, {}), (e) => e instanceof GitUnavailableError && /could not determine the current branch/.test(e.message) && !/detached/.test(e.message));
  });
});
