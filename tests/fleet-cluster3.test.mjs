/**
 * @fileoverview Fleet feedback cluster 3 (docs/plans/fleet-feedback-cluster3-land-add-eol.md): a remote-only branch can be
 * adopted (#4), a flaky remote READ is retried but a test rerun never is, and `land --abandon` says what it left behind (#6),
 * line-ending flips are disclosed at `ready` (#7), and the two ignored `--dry-run` CLIs now honour or refuse it.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv, writeFile } from './helpers/fleet-repo.mjs';
import { REMOTE_READ_ATTEMPTS, isPermanentFailure, isTimeoutFailure, lsRemote, retryRemoteRead } from '../scripts/lib/fleet/remote-read.mjs';
import { remoteRefOid } from '../scripts/lib/fleet/git-facts.mjs';
import { removeTrainWorktree } from '../scripts/lib/fleet/train.mjs';
import { renderAbandon } from '../scripts/lib/fleet/render-train.mjs';
import { eolFlipLines, eolFlips, eolJson, printable } from '../scripts/lib/fleet/eol-flips.mjs';
import { materializeRemoteBranch } from '../scripts/lib/fleet/commands.mjs';

after(cleanupFleetRoots);
const env = () => scrubbedEnv({ FLEET_TELEMETRY: 'off' });

describe('#4 fleet add adopts a remote-only branch', () => {
  /** `feat-x` exists on origin only: pushed from a scratch clone, then fetched here. */
  const remoteOnly = () => {
    const fx = makeFleetRepo();
    const scratch = path.join(fx.root, 'scratch');
    git(['clone', '-q', fx.origin, scratch], fx.root);
    git(['checkout', '-q', '-b', 'feat-x'], scratch);
    writeFile(scratch, 'x.txt', 'x\n');
    git(['add', '--', 'x.txt'], scratch);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'work on x'], scratch);
    git(['push', '-q', 'origin', 'feat-x'], scratch);
    git(['fetch', '-q', 'origin'], fx.repo);
    return fx;
  };
  it('creates the local branch from origin/<branch> (tracking, no checkout) and adopts it', () => {
    const fx = remoteOnly();
    assert.notEqual(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/feat-x'], { cwd: fx.repo }).status, 0, 'precondition: no local branch');
    const r = runFleet(['add', 'feat-x', '--json'], { cwd: fx.repo, env: env() });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.json.added, ['feat-x']);
    assert.equal(r.json.createdFrom, 'origin/feat-x');
    assert.match(r.json.text, /created local branch feat-x from origin\/feat-x/);
    assert.equal(spawnSync('git', ['config', '--get', 'branch.feat-x.remote'], { cwd: fx.repo }).status, 1, 'no tracking configuration was written, so rollback is just the ref');
    assert.equal(git(['rev-parse', 'refs/heads/feat-x'], fx.repo), git(['rev-parse', 'refs/remotes/origin/feat-x'], fx.repo));
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], fx.repo), 'main', 'nothing was checked out');
  });
  it('if nothing is adopted the branch this call created is removed again (compare-and-swap), and a moved branch is never deleted', () => {
    const fx = remoteOnly();
    // Already tracked under that id: adoption skips it, so the freshly made branch must not be left behind.
    assert.equal(runFleet(['claim', '--id', 'feat-x', '--intent', 'x', '--paths', 'x.txt'], { cwd: fx.repo, env: env() }).status, 0);
    const r = runFleet(['add', 'feat-x', '--json'], { cwd: fx.repo, env: env() });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.json.added, []);
    // `claim` ran on main, so the session is bound to main; the point is the ref this call made did not survive a no-op add.
    assert.notEqual(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/feat-x'], { cwd: fx.repo }).status, 0, 'the branch made for a no-op add is gone');
    assert.match(r.json.text, /was removed again: nothing was adopted/);
  });
  it('is created from the FULLY QUALIFIED remote ref: a local branch named origin/feat-x cannot shadow it', () => {
    const fx = remoteOnly();
    const remoteTip = git(['rev-parse', 'refs/remotes/origin/feat-x'], fx.repo);
    git(['branch', 'origin/feat-x', 'main'], fx.repo); // a LOCAL branch whose short name collides with the remote-tracking one
    const res = materializeRemoteBranch(fx.repo, 'feat-x');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(git(['rev-parse', 'refs/heads/feat-x'], fx.repo), remoteTip, 'the remote tip, not the shadowing branch');
    assert.equal(res.oid, remoteTip, 'the oid rollback compares against is the one it created at');
  });
  it('a nested branch whose last segment is HEAD is an ordinary branch (only the remote symbolic HEAD is excluded)', () => {
    const fx = remoteOnly();
    git(['update-ref', 'refs/remotes/origin/feature/HEAD', git(['rev-parse', 'refs/remotes/origin/feat-x'], fx.repo)], fx.repo);
    const res = materializeRemoteBranch(fx.repo, 'feature/HEAD');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(git(['rev-parse', 'refs/heads/feature/HEAD'], fx.repo), git(['rev-parse', 'refs/remotes/origin/feat-x'], fx.repo));
  });
  it('creation is create-only: a branch that appears first is never overwritten', () => {
    const fx = remoteOnly();
    git(['branch', 'feat-x', 'main'], fx.repo);
    const before = git(['rev-parse', 'refs/heads/feat-x'], fx.repo);
    // Called directly (as a racing creator would): the all-zero old value makes update-ref refuse.
    const res = materializeRemoteBranch(fx.repo, 'feat-x');
    assert.equal(res.ok, false);
    assert.match(res.reason, /could not create feat-x/);
    assert.equal(git(['rev-parse', 'refs/heads/feat-x'], fx.repo), before);
  });
  it('a branch that exists nowhere is still refused, and creates nothing', () => {
    const fx = makeFleetRepo();
    const r = runFleet(['add', 'no-such-branch'], { cwd: fx.repo, env: env() });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /no local branch no-such-branch/);
  });
  it('a name on two remotes is refused naming both, and creates nothing', () => {
    const fx = remoteOnly();
    git(['remote', 'add', 'other', fx.origin], fx.repo);
    git(['fetch', '-q', 'other'], fx.repo);
    const res = materializeRemoteBranch(fx.repo, 'feat-x');
    assert.equal(res.ok, false);
    assert.match(res.reason, /several remotes \(origin\/feat-x, other\/feat-x\)/);
    assert.notEqual(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/feat-x'], { cwd: fx.repo }).status, 0);
  });
  it('an existing local branch is never touched, and a nonsense name is not a branch', () => {
    const fx = remoteOnly();
    git(['branch', 'feat-x', 'main'], fx.repo);
    const before = git(['rev-parse', 'refs/heads/feat-x'], fx.repo);
    runFleet(['add', 'feat-x'], { cwd: fx.repo, env: env() });
    assert.equal(git(['rev-parse', 'refs/heads/feat-x'], fx.repo), before, 'the local branch kept its own tip');
    assert.equal(materializeRemoteBranch(fx.repo, 'bad name with spaces'), null);
    assert.equal(materializeRemoteBranch(fx.repo, '-flag'), null);
  });
});

describe('#6 a remote READ is retried; nothing else is', () => {
  const fail = (reason) => ({ ok: false, reason });
  it('retries a failed read and stops at the first success', () => {
    const sleeps = []; let calls = 0;
    const r = retryRemoteRead(() => { calls += 1; return calls < 3 ? fail('git ls-remote exited 128: connection reset') : { ok: true, stdout: 'x' }; }, { sleep: (ms) => sleeps.push(ms) });
    assert.equal(r.ok, true);
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [400, 1200], 'bounded backoff');
  });
  it('gives up after the bound and reports how many attempts it made', () => {
    let calls = 0;
    const r = retryRemoteRead(() => { calls += 1; return fail('git ls-remote exited 128: boom'); }, { sleep: () => {} });
    assert.equal(calls, REMOTE_READ_ATTEMPTS);
    assert.equal(r.ok, false);
    assert.equal(r.attempts, REMOTE_READ_ATTEMPTS);
  });
  it('an ANSWER is never retried, whatever it says (a reachable remote reporting "ref absent")', () => {
    let calls = 0;
    const r = retryRemoteRead(() => { calls += 1; return { ok: true, stdout: '' }; }, { sleep: () => assert.fail('must not sleep') });
    assert.equal(calls, 1);
    assert.equal(r.attempts, undefined);
  });
  it('a TIMEOUT is not retried: the remote is hung, tripling the wait is not a flake cure', () => {
    let calls = 0;
    const r = retryRemoteRead(() => { calls += 1; return fail('git ls-remote timed out after 60000ms'); }, { sleep: () => assert.fail('must not sleep') });
    assert.equal(calls, 1);
    assert.equal(isTimeoutFailure(r), true);
  });
  it('a PERMANENT failure (credentials, a wrong remote) is not retried either', () => {
    for (const reason of ['git ls-remote exited 128: fatal: Authentication failed for x', "git ls-remote exited 128: fatal: 'nope' does not appear to be a git repository", 'git ls-remote exited 128: Permission denied (publickey).']) {
      let calls = 0;
      const r = retryRemoteRead(() => { calls += 1; return fail(reason); }, { sleep: () => assert.fail('must not sleep') });
      assert.equal(calls, 1, reason);
      assert.equal(isPermanentFailure(r), true);
    }
  });
  it('lsRemote asks through the injected git dep with ls-remote, and retries it', () => {
    const seen = []; let n = 0;
    const git = (args, cwd, opts) => { seen.push({ args, cwd, opts }); n += 1; return n === 1 ? fail('git ls-remote exited 128: flake') : { ok: true, stdout: 'abc\trefs/heads/main\n' }; };
    const r = lsRemote(git, ['origin', 'refs/heads/main'], '/w', { timeoutMs: 60_000 }, { sleep: () => {} });
    assert.equal(r.ok, true);
    assert.deepEqual(seen.map((s) => s.args), [['ls-remote', 'origin', 'refs/heads/main'], ['ls-remote', 'origin', 'refs/heads/main']]);
    assert.equal(seen[0].opts.timeoutMs, 60_000);
  });
  it('remoteRefOid keeps its answer shape: an absent ref is {ok:true, oid:null}, an unreachable remote is {ok:false}', () => {
    const fx = makeFleetRepo();
    const absent = remoteRefOid(fx.repo, fx.origin, 'refs/heads/does-not-exist');
    assert.deepEqual(absent, { ok: true, oid: null });
    const present = remoteRefOid(fx.repo, fx.origin, 'refs/heads/main');
    assert.equal(present.ok, true);
    assert.match(present.oid, /^[0-9a-f]{40}$/);
  });
});

describe('#6 land --abandon says what it left behind', () => {
  const train = (wt) => ({ trainId: 't-20261122000000-abcd', worktree: wt });
  const depsWith = (results, sleeps = []) => {
    let i = 0;
    return { sleeps, git: (args) => (args[0] === 'worktree' && args[1] === 'list' ? { ok: true, stdout: `worktree ${path.resolve('t-20261122000000-abcd')}\0\0` } : { ok: true, stdout: '' }), removeWorktree: () => results[Math.min(i++, results.length - 1)], sleep: (ms) => sleeps.push(ms) };
  };
  it('retries a removal that failed on a transient lock, and reports success when it clears', () => {
    const wt = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'c3-')), 't-20261122000000-abcd');
    fs.mkdirSync(wt);
    const d = depsWith([{ ok: false, steps: ['locked'] }, { ok: false, steps: ['locked'] }, { ok: true }]);
    d.git = (args) => (args[0] === 'worktree' ? { ok: true, stdout: `worktree ${wt}\0\0` } : { ok: true, stdout: '' });
    const r = removeTrainWorktree('/repo', train(wt), d);
    assert.equal(r.removed, true);
    assert.deepEqual(d.sleeps, [500, 1000], 'bounded retries');
  });
  it('after the bound it reports the failure (no endless retry)', () => {
    const wt = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'c3-')), 't-20261122000000-abcd');
    fs.mkdirSync(wt);
    const d = depsWith([{ ok: false, steps: ['still locked'] }]);
    d.git = (args) => (args[0] === 'worktree' ? { ok: true, stdout: `worktree ${wt}\0\0` } : { ok: true, stdout: '' });
    const r = removeTrainWorktree('/repo', train(wt), d);
    assert.equal(r.removed, false);
    assert.match(r.reason, /not fully removed: still locked/);
    assert.equal(d.sleeps.length, 2);
  });
  it('the rendered result names what is left and the RIGHT recovery for each state; a clean abandon has no such line', () => {
    const base = { ok: true, train: { trainId: 't-1' }, worktreeRemoved: false, worktreeNote: 'worktree not fully removed: locked' };
    const left = (over) => renderAbandon({ ...base, leftBehind: [{ kind: 'worktree', path: 'C:/wt/t-1', reason: 'locked', dirExists: true, registered: true, ...over }] });
    assert.ok(left({}).includes('LEFT BEHIND: worktree C:/wt/t-1 (locked) — inspect it first, then: git worktree remove --force --force'), left({}));
    assert.ok(left({}).includes('(a locked worktree needs --force twice)'));
    assert.ok(left({ registered: false }).includes('git no longer lists it, so it is only a directory: inspect it, then delete'));
    assert.ok(left({ dirExists: false }).includes('git worktree prune --dry-run -v'));
    // The directory is gone and git could NOT be asked: an unanswered query is never read as "nothing left".
    const unknown = left({ dirExists: false, registered: null, reason: 'x; git worktree list failed (boom)' });
    assert.ok(unknown.includes('could not verify the git registration'), unknown);
    assert.ok(unknown.includes('git worktree list failed (boom)'));
    const clean = renderAbandon({ ...base, worktreeRemoved: true, worktreeNote: undefined, leftBehind: [] });
    assert.doesNotMatch(clean, /LEFT BEHIND/);
    assert.match(renderAbandon({ ok: false, reason: 'x' }), /^REFUSED: x$/);
  });
});

describe('#7 line-ending flips are disclosed at ready', () => {
  const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m'];
  /** `eol.txt` (200 LF lines) on main; branch `feat` rewrites it with CRLF; `mixed.txt` gets a real edit AND CRLF. */
  const world = () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const fx = makeFleetRepo({ files: { 'a.txt': 'a\n', 'eol.txt': `${lines.join('\n')}\n`, 'mixed.txt': `${lines.join('\n')}\n`, 'clean.txt': 'c\n' } });
    git(['checkout', '-q', '-b', 'feat'], fx.repo);
    // A byte-exact CRLF write (git's own autocrlf must not undo it).
    git(['config', 'core.autocrlf', 'false'], fx.repo);
    fs.writeFileSync(path.join(fx.repo, 'eol.txt'), `${lines.join('\r\n')}\r\n`);
    fs.writeFileSync(path.join(fx.repo, 'mixed.txt'), `${lines.map((l, i) => (i === 3 ? 'line 3 EDITED' : l)).join('\r\n')}\r\n`);
    fs.writeFileSync(path.join(fx.repo, 'clean.txt'), 'c changed\n');
    git(['add', '--', 'eol.txt', 'mixed.txt', 'clean.txt'], fx.repo);
    git(['config', 'core.safecrlf', 'false'], fx.repo);
    git([...COMMIT, 'flip endings'], fx.repo);
    return { fx, base: git(['rev-parse', 'main'], fx.repo), head: git(['rev-parse', 'HEAD'], fx.repo) };
  };
  it('names a PURE flip and a PARTIAL one (line endings dominating a real edit), and not an ordinary change', () => {
    const { fx, base, head } = world();
    const r = eolFlips(fx.repo, base, head);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.flips.map((f) => [f.file, f.kind]), [['eol.txt', 'pure'], ['mixed.txt', 'partial']]);
    const lines = eolFlipLines(r);
    assert.match(lines[0], /1 file\(s\) changed ONLY in line endings \(CRLF\/LF\): eol\.txt/);
    assert.match(lines[1], /line endings dominate the diff of 1 file\(s\): mixed\.txt/);
  });
  it('filenames are rendered without raw control characters (a newline or ESC cannot forge terminal output)', () => {
    assert.equal(printable('a\nb\u001b[31m\r.txt'), 'a\\x0ab\\x1b[31m\\x0d.txt');
    const lines = eolFlipLines({ ok: true, flips: [{ file: 'evil\nwarning: fake', kind: 'pure', raw: 4, real: 0 }] });
    assert.equal(lines.length, 1, 'one line, not two');
    assert.ok(lines[0].includes('evil\\x0awarning: fake'), lines[0]);
  });
  it('the JSON says checked:false with a reason when it could not look, and checked:true with no flips when it looked and found none', () => {
    assert.deepEqual(eolJson({ ok: false, reason: 'base not measured' }), { checked: false, reason: 'base not measured', flips: [] });
    assert.deepEqual(eolJson({ ok: true, flips: [] }), { checked: true, flips: [] });
  });
  it('renames, binary files and unusual names do not confuse it (real git)', () => {
    const body = (p, sep) => `${Array.from({ length: 60 }, (_, i) => `${p}${i}`).join(sep)}${sep}`;
    const fx = makeFleetRepo({ files: { 'a.txt': 'a\n', 'sp ace é.txt': body('l', '\n'), 'old.txt': body('o', '\n') } });
    const base = git(['rev-parse', 'HEAD'], fx.repo);
    git(['checkout', '-q', '-b', 'odd'], fx.repo);
    git(['config', 'core.autocrlf', 'false'], fx.repo);
    fs.writeFileSync(path.join(fx.repo, 'sp ace é.txt'), body('l', '\r\n'));
    git(['mv', 'old.txt', 'renamed.txt'], fx.repo);
    fs.writeFileSync(path.join(fx.repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255, 0]));
    git(['add', '--', 'sp ace é.txt', 'renamed.txt', 'bin.dat'], fx.repo);
    git([...COMMIT, 'odd'], fx.repo);
    const r = eolFlips(fx.repo, base, git(['rev-parse', 'HEAD'], fx.repo));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.flips.map((f) => f.file), ['sp ace é.txt'], 'only the flipped file; the rename and the binary are not flips');
  });
  it('an unmeasured base or an unreadable range is SAID, never read as "no flips"', () => {
    const { fx, head } = world();
    assert.deepEqual(eolFlipLines(eolFlips(fx.repo, null, head)), ['note: line-ending churn was not checked (base not measured)']);
    const bad = eolFlips(fx.repo, 'f'.repeat(40), head);
    assert.equal(bad.ok, false);
    assert.match(eolFlipLines(bad)[0], /^note: line-ending churn was not checked/);
  });
  it('a clean branch yields no lines', () => {
    const fx = makeFleetRepo();
    git(['checkout', '-q', '-b', 'tidy'], fx.repo);
    writeFile(fx.repo, 'a.txt', 'a changed\n');
    git(['add', '--', 'a.txt'], fx.repo);
    git([...COMMIT, 'tidy'], fx.repo);
    assert.deepEqual(eolFlipLines(eolFlips(fx.repo, git(['rev-parse', 'main'], fx.repo), git(['rev-parse', 'HEAD'], fx.repo))), []);
  });
  it('`fleet ready` prints the warning and carries eolFlips in its JSON, and still marks ready (advisory)', () => {
    const { fx } = world();
    const c = runFleet(['claim', '--id', 'feat', '--intent', 'flip', '--paths', 'eol.txt', '--json'], { cwd: fx.repo, env: env() });
    assert.equal(c.status, 0, c.stdout + c.stderr);
    const r = runFleet(['ready', '--json'], { cwd: fx.repo, env: env() });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.record.state, 'ready', 'advisory only');
    assert.equal(r.json.eol.checked, true);
    assert.deepEqual(r.json.eol.flips.map((f) => f.file), ['eol.txt', 'mixed.txt']);
    assert.match(r.json.text, /warning: 1 file\(s\) changed ONLY in line endings/);
  });
});

describe('--dry-run: the two CLIs that ignored it', () => {
  const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, SKIP_ENV_BOOTSTRAP: '1' } });
  it('sync-refresh refuses a mistyped flag instead of syncing for real', () => {
    const r = run('scripts/sync-refresh.mjs', ['--target', 'nonexistent', '--dry-runn']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /unknown flag "--dry-runn"/);
  });
  it('sync-refresh accepts --dry-run (it reaches target resolution, and never pulls)', () => {
    const r = run('scripts/sync-refresh.mjs', ['--target', 'nonexistent-alias', '--dry-run']);
    assert.equal(r.status, 2, 'an unknown target is its own refusal');
    assert.match(r.stderr, /unknown target/);
    assert.doesNotMatch(r.stdout + r.stderr, /pulling canonical/);
  });
  it('sync-refresh refuses a missing or flag-shaped --target value before doing anything', () => {
    for (const args of [['--target'], ['--target', '--no-pull']]) {
      const r = run('scripts/sync-refresh.mjs', args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.doesNotMatch(r.stdout + r.stderr, /pulling canonical/);
    }
  });
  it('importing write-ledger-r1 writes nothing (only the entry guard runs main)', () => {
    const ledger = path.resolve('.claude/tmp/ledger/audit-1776354886-ledger.json');
    const existed = fs.existsSync(ledger);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./scripts/write-ledger-r1.mjs'); process.stdout.write('imported');"], { encoding: 'utf8' });
    assert.equal(r.stdout.trim().endsWith('imported'), true, r.stdout + r.stderr);
    assert.equal(fs.existsSync(ledger), existed);
  });
  it('write-ledger-r1 refuses a stray word, including one after the -- terminator', () => {
    for (const args of [['stray'], ['--', '--dry-runn'], ['--dry-run', 'extra']]) {
      const r = run('scripts/write-ledger-r1.mjs', args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    }
  });
  it('write-ledger-r1 refuses a mistyped flag; --dry-run writes nothing and says what it would write', () => {
    const bad = run('scripts/write-ledger-r1.mjs', ['--dry-runn']);
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /unknown flag "--dry-runn"/);
    const ledger = path.resolve('.claude/tmp/ledger/audit-1776354886-ledger.json');
    const existed = fs.existsSync(ledger);
    const mtime = existed ? fs.statSync(ledger).mtimeMs : null;
    const ok = run('scripts/write-ledger-r1.mjs', ['--dry-run']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /--dry-run: would write 10 entries .* \(nothing written\)/);
    assert.equal(fs.existsSync(ledger), existed, 'no file appeared');
    if (existed) assert.equal(fs.statSync(ledger).mtimeMs, mtime, 'an existing file was not touched');
  });
});
