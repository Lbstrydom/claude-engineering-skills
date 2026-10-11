/**
 * @fileoverview `.githooks/pre-push` §0.97 — the archive lane as the HOOK sees it.
 * The scan itself is tested in prepush-archive-lane.test.mjs; this file pins how
 * the hook decides between the lane and the full gate, and that it does so from
 * the right checkout. Plan: docs/plans/prepush-archive-lane.md §2.1, §2.4, §5.
 *
 * Same method as prepush-delete-only-push.test.mjs: a stub `prepush-check.mjs`
 * records its argv, so each case observes the one thing that matters — was the
 * FULL gate invoked — rather than the spelling of a guard.
 *
 * THREE THINGS ARE PINNED THAT A MOCK WOULD HIDE:
 *   · the lane's code comes from the checkout the hook lives in (`$0`), not from the
 *     pusher's cwd — core.hooksPath points at one checkout while pushes come from
 *     any worktree (measured: it pointed into a linked worktree, in backslash form);
 *   · the hook acts on a protocol TOKEN, never on exit status — node exits 1 on a
 *     syntax error before any catch can run;
 *   · a real `git push` from a linked worktree reaches all of it with git's real
 *     stdin format and environment.
 *
 * CONTROLS: an ordinary push and a mixed push must still reach the full gate. A
 * lane that took them too would be a gate that passes having checked nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { hasBash, git } from './lib/hook-test-helpers.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const HOOK = path.join(REPO_ROOT, '.githooks', 'pre-push');
const HAS_BASH = hasBash();
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const ZERO = '0'.repeat(40);
const MARKER = 'prepush-check-argv.json';
const GHP = `ghp_${'a1B2'.repeat(9)}`;

const guard = (t) => {
  if (!HAS_GIT || !HAS_BASH) { t.skip('git and bash are both required'); return false; }
  return true;
};

/**
 * `repo` (the pusher, with stubs for everything the hook runs before the gate) and
 * `dest.git` (the push destination), both seeded with one commit on main.
 */
function withFixture(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-lane-hook-'));
  try {
    const dest = path.join(base, 'dest.git');
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    git(['init', '-q', '--bare', dest]);
    git(['--git-dir', dest, 'symbolic-ref', 'HEAD', 'refs/heads/unused']);
    git(['init', '-q', '-b', 'main', repo]);
    git(['config', 'user.email', 'fixture@example.invalid'], repo);
    git(['config', 'user.name', 'Fixture'], repo);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture","private":true}\n');
    fs.writeFileSync(path.join(repo, 'scripts', 'prepush-check.mjs'),
      `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(MARKER)}, JSON.stringify(process.argv.slice(2)));\n`);
    for (const stub of ['check-stale-skill-surface.mjs', 'harvest-audit-transcripts.mjs']) {
      fs.writeFileSync(path.join(repo, 'scripts', stub), 'process.exit(0);\n');
    }
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'seed'], repo);
    git(['push', '-q', '--no-verify', dest, 'main'], repo);
    git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'], repo)], repo);
    return fn({ base, dest, repo, seed: git(['rev-parse', 'HEAD'], repo) });
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/** Commit files (forced, so a developer's global excludes cannot swallow `.env`). */
function commit(repo, files, msg = 'c') {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), body);
  }
  git(['add', '-A', '-f'], repo);
  git(['commit', '-q', '-m', msg], repo);
  return git(['rev-parse', 'HEAD'], repo);
}

/** A branch under archive/ with one commit; returns `{sha, line}`. */
function archiveCommit(repo, files, name = 'x') {
  git(['checkout', '-q', '-b', `archive/${name}`], repo);
  const sha = commit(repo, files, 'archive');
  return { sha, line: `refs/heads/archive/${name} ${sha} refs/heads/archive/${name} ${ZERO}` };
}

function runHook(repo, stdin, { dest, env = {}, hook = HOOK, remote = 'origin' } = {}) {
  const r = spawnSync('bash', [hook, remote, dest ?? 'https://example.invalid/x.git'], {
    cwd: repo,
    encoding: 'utf-8',
    input: stdin,
    env: { ...process.env, AUDIT_PREPUSH_SANDBOX: '', AUDIT_PREPUSH_ARCHIVE_LANE: '', AUDIT_ARCHIVE_LANE_ACK: '', ...env },
  });
  const markerPath = path.join(repo, MARKER);
  const argv = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf-8')) : null;
  return { ...r, argv };
}

const LANE_CLEAN = /archive lane clean/;
const LANE_UNAVAILABLE = /archive lane unavailable/;

// ── the lane versus the full gate ───────────────────────────────────────────

describe('.githooks/pre-push — a clean archive push skips the full check', () => {
  it('runs the lane, skips the gate, and says what it skipped', (t) => {
    if (!guard(t)) return;
    withFixture(({ repo, dest }) => {
      const { line } = archiveCommit(repo, { 'notes/a.txt': 'a\n' });
      const got = runHook(repo, `${line}\n`, { dest });
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.argv, null, 'the full gate ran for a clean archive push');
      assert.match(got.stdout + got.stderr, LANE_CLEAN);
    });
  });

  it('an archive TAG takes the lane too', (t) => {
    if (!guard(t)) return;
    withFixture(({ repo, dest }) => {
      archiveCommit(repo, { 'a.txt': 'a\n' });
      git(['tag', '-a', 'archive/t', '-m', 'a backup'], repo);
      const tag = git(['rev-parse', 'archive/t'], repo);
      const got = runHook(repo, `refs/tags/archive/t ${tag} refs/tags/archive/t ${ZERO}\n`, { dest });
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.argv, null);
      assert.match(got.stdout + got.stderr, LANE_CLEAN);
    });
  });
});

describe('.githooks/pre-push — an archive push with findings is blocked, with the gate not run', () => {
  it('a committed .env blocks (the secret scan is the point of the lane)', (t) => {
    if (!guard(t)) return;
    withFixture(({ repo, dest }) => {
      const { line } = archiveCommit(repo, { '.env': 'K=v\n' });
      const got = runHook(repo, `${line}\n`, { dest });
      assert.equal(got.status, 1);
      assert.equal(got.argv, null, 'a blocked push must not fall through to the gate');
      assert.match(got.stdout + got.stderr, /archive lane blocked/);
      assert.match(got.stderr, /AUDIT_ARCHIVE_LANE_ACK/);
    });
  });

  it('the printed acknowledgement lets the same push through', (t) => {
    if (!guard(t)) return;
    withFixture(({ repo, dest }) => {
      const { line } = archiveCommit(repo, { 'lib/t.mjs': `const t = '${GHP}';\n` });
      const blocked = runHook(repo, `${line}\n`, { dest });
      assert.equal(blocked.status, 1);
      const fp = /AUDIT_ARCHIVE_LANE_ACK=([0-9a-f]{12})/.exec(blocked.stderr)?.[1];
      assert.ok(fp, blocked.stderr);
      const ok = runHook(repo, `${line}\n`, { dest, env: { AUDIT_ARCHIVE_LANE_ACK: fp } });
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(ok.argv, null);
    });
  });

  it('an unreachable destination BLOCKS an archive push (an incomplete scan is never clean)', (t) => {
    if (!guard(t)) return;
    withFixture(({ repo }) => {
      const { line } = archiveCommit(repo, { 'a.txt': 'a\n' });
      const got = runHook(repo, `${line}\n`, { dest: 'https://user:s3cr3t@127.0.0.1:1/x.git' });
      assert.equal(got.status, 1);
      assert.equal(got.argv, null);
      assert.ok(!(got.stdout + got.stderr).includes('s3cr3t'), 'a credential reached the output');
    });
  });
});

describe('.githooks/pre-push — CONTROLS: everything else still gets the full gate', () => {
  it('an ordinary branch push is checked exactly as before, with no lane message', (t) => {
    if (!guard(t)) return;
    withFixture(({ repo, dest, seed }) => {
      const tip = commit(repo, { 'x.txt': 'x\n' });
      const got = runHook(repo, `refs/heads/feature ${tip} refs/heads/feature ${ZERO}\n`, { dest });
      assert.equal(got.status, 0, got.stderr);
      assert.deepEqual(got.argv, ['--base', seed, '--head', tip]);
      assert.doesNotMatch(got.stdout + got.stderr, /archive lane/);
    });
  });

  it('a MIXED push (archive plus main) gets the full gate, even though the archive half is clean', (t) => {
    if (!guard(t)) return;
    withFixture(({ repo, dest }) => {
      const { sha, line } = archiveCommit(repo, { 'a.txt': 'a\n' });
      const got = runHook(repo, `${line}\nrefs/heads/main ${sha} refs/heads/main ${ZERO}\n`, { dest });
      assert.equal(got.status, 0, got.stderr);
      assert.notEqual(got.argv, null, 'a mixed push skipped the gate');
      assert.doesNotMatch(got.stdout + got.stderr, LANE_CLEAN);
    });
  });

  it('an archive update plus a NON-archive deletion is mixed, so it gets the full gate', (t) => {
    if (!guard(t)) return;
    withFixture(({ repo, dest, seed }) => {
      const { line } = archiveCommit(repo, { 'a.txt': 'a\n' });
      const got = runHook(repo, `${line}\n(delete) ${ZERO} refs/heads/old ${seed}\n`, { dest });
      assert.equal(got.status, 0, got.stderr);
      assert.notEqual(got.argv, null);
    });
  });

  it('AUDIT_PREPUSH_ARCHIVE_LANE=0 reverts an archive push to the full gate', (t) => {
    if (!guard(t)) return;
    withFixture(({ repo, dest }) => {
      const { line } = archiveCommit(repo, { 'a.txt': 'a\n' });
      const got = runHook(repo, `${line}\n`, { dest, env: { AUDIT_PREPUSH_ARCHIVE_LANE: '0' } });
      assert.equal(got.status, 0, got.stderr);
      assert.notEqual(got.argv, null);
      assert.doesNotMatch(got.stdout + got.stderr, /archive lane/);
    });
  });

  it('empty stdin still runs the gate (no push information is not an archive push)', (t) => {
    if (!guard(t)) return;
    withFixture(({ repo, dest }) => {
      const got = runHook(repo, '', { dest });
      assert.equal(got.status, 0, got.stderr);
      assert.deepEqual(got.argv, []);
      assert.doesNotMatch(got.stdout + got.stderr, /archive lane/);
    });
  });

  it('a delete-only archive push is still the §0.5 skip, and the lane never runs', (t) => {
    if (!guard(t)) return;
    withFixture(({ repo, dest, seed }) => {
      const got = runHook(repo, `(delete) ${ZERO} refs/heads/archive/x ${seed}\n`, { dest });
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.argv, null);
      assert.match(got.stderr, /delete-only push/);
      assert.doesNotMatch(got.stdout + got.stderr, /archive lane/);
    });
  });
});

// ── the protocol and the hook's own checkout ────────────────────────────────

/**
 * A second checkout holding a COPY of the hook and, optionally, a lane script. The
 * hook locates its lane from `$0`, so running this copy proves it does NOT look in
 * the pusher's cwd.
 */
function hookCheckout(base, laneBody) {
  const root = path.join(base, 'hook-checkout');
  fs.mkdirSync(path.join(root, '.githooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(HOOK, path.join(root, '.githooks', 'pre-push'));
  if (laneBody !== null) fs.writeFileSync(path.join(root, 'scripts', 'prepush-archive-lane.mjs'), laneBody);
  return path.join(root, '.githooks', 'pre-push');
}

const say = (token, code = 0) => `process.stdout.write(${JSON.stringify(token)} + '\\n'); process.exit(${code});\n`;

describe('.githooks/pre-push — the hook acts on the protocol token, never on exit status', () => {
  // [name, lane script body (null = missing), blocked?, gate runs?, warns?]
  const cases = [
    ['a clean token with exit 1 (token wins over status)', say('archive-lane/v1 clean', 1), false, false, false],
    ['a findings token with exit 0 (status cannot launder it)', say('archive-lane/v1 findings', 0), true, false, false],
    ['an error token with exit 0', say('archive-lane/v1 error', 0), true, false, false],
    ['not-applicable runs the gate and is silent', say('archive-lane/v1 not-applicable', 3), false, true, false],
    ['a token amid other stdout is still found', `console.log('noise'); ${say('archive-lane/v1 clean')}`, false, false, false],
    ['exit 0 with NO token is "unavailable"', 'process.exit(0);\n', false, true, true],
    ['a syntax error (node exits 1 before any catch)', 'this is not javascript (\n', false, true, true],
    ['an unknown outcome word', say('archive-lane/v1 maybe', 0), false, true, true],
    ['a token for another protocol version', say('archive-lane/v2 clean', 0), false, true, true],
    ['a MISSING lane script', null, false, true, true],
  ];
  for (const [name, body, blocked, gateRuns, warns] of cases) {
    it(name, (t) => {
      if (!guard(t)) return;
      withFixture(({ base, repo, dest }) => {
        const { line } = archiveCommit(repo, { 'a.txt': 'a\n' });
        const got = runHook(repo, `${line}\n`, { dest, hook: hookCheckout(base, body) });
        const out = got.stdout + got.stderr;
        assert.equal(got.status, blocked ? 1 : 0, out);
        assert.equal(got.argv !== null, gateRuns, `gate ran: ${got.argv !== null}\n${out}`);
        assert.equal(LANE_UNAVAILABLE.test(out), warns, out);
      });
    });
  }

  it("the lane's code comes from the HOOK's checkout, not the pusher's cwd", (t) => {
    if (!guard(t)) return;
    withFixture(({ base, repo, dest }) => {
      // The pusher's checkout has a lane that would say "clean"; the hook's has none.
      fs.writeFileSync(path.join(repo, 'scripts', 'prepush-archive-lane.mjs'), say('archive-lane/v1 clean'));
      const { line } = archiveCommit(repo, { 'a.txt': 'a\n' });
      const got = runHook(repo, `${line}\n`, { dest, hook: hookCheckout(base, null) });
      assert.match(got.stdout + got.stderr, LANE_UNAVAILABLE, 'the hook read the pusher\'s scripts/');
      assert.notEqual(got.argv, null);
    });
  });

  it('a pure-backslash $0 still finds its own checkout (dirname of a backslash path is ".")', (t) => {
    if (!guard(t)) return;
    if (process.platform !== 'win32') return t.skip('backslash script paths are a Windows form');
    withFixture(({ base, repo, dest }) => {
      const { line } = archiveCommit(repo, { 'a.txt': 'a\n' });
      const hook = hookCheckout(base, say('archive-lane/v1 clean')).replace(/\//g, '\\');
      const got = runHook(repo, `${line}\n`, { dest, hook });
      assert.match(got.stdout + got.stderr, LANE_CLEAN, got.stdout + got.stderr);
      assert.equal(got.argv, null);
    });
  });
});

// ── a real `git push` from a linked worktree ────────────────────────────────

describe('.githooks/pre-push — real git push from a LINKED WORKTREE (constraint 3)', () => {
  /** Hooks dir in the form git was actually given on this machine (backslashes on Windows). */
  const hooksPath = process.platform === 'win32'
    ? path.join(REPO_ROOT, '.githooks').replace(/\//g, '\\')
    : path.join(REPO_ROOT, '.githooks');

  function inWorktree(fn) {
    withFixture(({ base, repo, dest }) => {
      const wt = path.join(base, 'wt');
      git(['worktree', 'add', '-q', '-b', 'wt-branch', wt, 'main'], repo);
      git(['config', 'user.email', 'fixture@example.invalid'], wt);
      git(['config', 'user.name', 'Fixture'], wt);
      // The pusher's checkout has NO lane script: only the hook's checkout (this repo) does.
      assert.equal(fs.existsSync(path.join(wt, 'scripts', 'prepush-archive-lane.mjs')), false);
      const push = (args) => spawnSync('git', ['-c', `core.hooksPath=${hooksPath}`, 'push', ...args], {
        cwd: wt,
        encoding: 'utf8',
        env: { ...process.env, AUDIT_PREPUSH_SANDBOX: '', AUDIT_PREPUSH_ARCHIVE_LANE: '', AUDIT_ARCHIVE_LANE_ACK: '' },
      });
      const remoteHas = (ref) => spawnSync('git', ['--git-dir', dest, 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8' }).status === 0;
      return fn({ wt, dest, push, remoteHas, marker: path.join(wt, MARKER) });
    });
  }

  it('a clean archive branch is published without the full gate', (t) => {
    if (!guard(t)) return;
    inWorktree(({ wt, dest, push, remoteHas, marker }) => {
      git(['checkout', '-q', '-b', 'archive/from-wt'], wt);
      commit(wt, { 'backup/a.txt': 'a\n' });
      const r = push([dest, 'archive/from-wt']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout + r.stderr, LANE_CLEAN);
      assert.equal(fs.existsSync(marker), false, 'the full gate ran');
      assert.equal(remoteHas('refs/heads/archive/from-wt'), true, 'the push did not arrive');
    });
  });

  it('a dirty archive branch is refused and does not arrive', (t) => {
    if (!guard(t)) return;
    inWorktree(({ wt, dest, push, remoteHas }) => {
      git(['checkout', '-q', '-b', 'archive/dirty'], wt);
      commit(wt, { '.env': 'K=v\n' });
      const r = push([dest, 'archive/dirty']);
      assert.notEqual(r.status, 0);
      assert.match(r.stdout + r.stderr, /archive lane blocked/);
      assert.equal(remoteHas('refs/heads/archive/dirty'), false, 'a blocked push arrived anyway');
    });
  });

  it('CONTROL: an ordinary branch from the same worktree still runs the full gate', (t) => {
    if (!guard(t)) return;
    inWorktree(({ wt, dest, push, remoteHas, marker }) => {
      git(['checkout', '-q', '-b', 'feature'], wt);
      commit(wt, { 'f.txt': 'f\n' });
      const r = push([dest, 'feature']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(marker), true, 'the full gate did not run for an ordinary push');
      assert.doesNotMatch(r.stdout + r.stderr, /archive lane/);
      assert.equal(remoteHas('refs/heads/feature'), true);
    });
  });

  it('CONTROL: a mixed push (archive plus ordinary) runs the full gate', (t) => {
    if (!guard(t)) return;
    inWorktree(({ wt, dest, push, marker }) => {
      git(['checkout', '-q', '-b', 'archive/mix'], wt);
      commit(wt, { 'm.txt': 'm\n' });
      const r = push([dest, 'archive/mix', 'archive/mix:refs/heads/mix-ordinary']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(marker), true, 'a mixed push skipped the full gate');
    });
  });
});
