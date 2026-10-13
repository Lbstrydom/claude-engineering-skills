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
import { isArchiveRef } from '../scripts/lib/prepush-archive-lane.mjs';

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
  // The hook also hands the sandbox the test-tier request (docs/plans/gate-cost-slice-2.md section 13): those flags say HOW the
  // tests run, not WHICH range is checked, so this case compares the range arguments only.
  const rangeOnly = (a) => { const out = []; for (let i = 0; i < a.length; i += 1) { if (a[i] === '--summary-file' || a[i] === '--tier') { i += 1; continue; } if (a[i] === '--pushes-default') continue; out.push(a[i]); } return out; };
  const argv = fs.existsSync(markerPath) ? rangeOnly(JSON.parse(fs.readFileSync(markerPath, 'utf-8'))) : null;
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
    // The lane says "not an archive push" about bytes this hook reads as archive-only: the
    // two disagree, and the full gate (no scan) would publish it unscanned. Refused.
    ['not-applicable for a push the hook reads as archive-only is a disagreement and is refused', say('archive-lane/v1 not-applicable', 3), true, false, false],
    ['a token amid other stdout is still found', `console.log('noise'); ${say('archive-lane/v1 clean')}`, false, false, false],
    // No valid result for an archive-looking push is REFUSED: the full gate does not
    // scan, so falling through to it would either publish unscanned or send the
    // pusher to --no-verify.
    ['exit 0 with NO token is "unavailable" and refused', 'process.exit(0);\n', true, false, true],
    ['a syntax error (node exits 1 before any catch) is refused', 'this is not javascript (\n', true, false, true],
    ['an unknown outcome word is refused', say('archive-lane/v1 maybe', 0), true, false, true],
    ['a token for another protocol version is refused', say('archive-lane/v2 clean', 0), true, false, true],
    ['a MISSING lane script is refused', null, true, false, true],
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
      assert.equal(got.status, 1, 'an archive push with no usable lane is refused');
      assert.equal(got.argv, null);
    });
  });

  it('CONTROL: a broken lane does not stop an ORDINARY push — it warns and runs the full gate', (t) => {
    if (!guard(t)) return;
    withFixture(({ base, repo, dest, seed }) => {
      const tip = commit(repo, { 'x.txt': 'x\n' });
      for (const body of ['process.exit(0);\n', 'this is not javascript (\n', null]) {
        const got = runHook(repo, `refs/heads/feature ${tip} refs/heads/feature ${ZERO}\n`, { dest, hook: hookCheckout(base, body) });
        assert.equal(got.status, 0, got.stdout + got.stderr);
        assert.deepEqual(got.argv, ['--base', seed, '--head', tip]);
        assert.match(got.stdout + got.stderr, LANE_UNAVAILABLE);
        fs.rmSync(path.join(repo, MARKER), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    });
  });

  it('DRIFT: the hook\'s bash spelling of "archive ref" agrees with the oracle, ref by ref', (t) => {
    if (!guard(t)) return;
    // The bash predicate can only ever BLOCK (it runs when the lane yields nothing),
    // so it is compared with isArchiveRef by feeding each ref through a broken lane:
    // blocked ⇔ the oracle says archive.
    // Whitespace is the trap the adversarial review found: a ref NAME may hold U+00A0 and
    // its kin (legal in refnames, and JS \s splits on them while awk does not), and the
    // LOCAL field is a revision expression that may hold ordinary spaces. Both spellings
    // must classify every one of these identically, in both local-field shapes.
    const refs = [
      'refs/heads/archive/x', 'refs/heads/archive/a/b', 'refs/tags/archive/t',
      'refs/heads/archive/a b', 'refs/heads/archive/a　b', 'refs/heads/archive/a b',
      'refs/heads/archive', 'refs/heads/archive/', 'refs/heads/archived/x', 'refs/heads/x/archive/y',
      'refs/remotes/origin/archive/x', 'refs/notes/archive/x', 'refs/heads/main', 'refs/tags/v1',
      'refs/heads/main archive/x',
    ];
    const locals = ['refs/heads/local', 'HEAD@{2 minutes ago}', 'HEAD^{/add backup}'];
    withFixture(({ base, repo, dest }) => {
      const tip = commit(repo, { 'x.txt': 'x\n' });
      const hook = hookCheckout(base, 'process.exit(0);\n');
      for (const ref of refs) {
        for (const local of locals) {
          const got = runHook(repo, `${local} ${tip} ${ref} ${ZERO}\n`, { dest, hook });
          assert.equal(got.status === 1, isArchiveRef(ref), `${JSON.stringify(local)} -> ${JSON.stringify(ref)}: bash blocked=${got.status === 1}, oracle says archive=${isArchiveRef(ref)}\n${got.stdout}${got.stderr}`);
          fs.rmSync(path.join(repo, MARKER), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        }
      }
    });
  });

  it('CONTROL: an ORDINARY push with a not-applicable token runs the full gate, silently', (t) => {
    if (!guard(t)) return;
    withFixture(({ base, repo, dest, seed }) => {
      const tip = commit(repo, { 'x.txt': 'x\n' });
      const got = runHook(repo, `refs/heads/feature ${tip} refs/heads/feature ${ZERO}\n`, { dest, hook: hookCheckout(base, say('archive-lane/v1 not-applicable', 3)) });
      assert.equal(got.status, 0, got.stdout + got.stderr);
      assert.deepEqual(got.argv, ['--base', seed, '--head', tip]);
      assert.doesNotMatch(got.stdout + got.stderr, /archive lane|disagree/);
    });
  });

  it('a failing awk cannot turn a missing lane into a pass (it refuses unless it can say "not archive")', (t) => {
    if (!guard(t)) return;
    withFixture(({ base, repo, dest }) => {
      const stub = path.join(base, 'no-awk.sh');
      fs.writeFileSync(stub, 'awk() { return 1; }\nexport -f awk\n');
      const { line } = archiveCommit(repo, { '.env': 'K=v\n' });
      const got = runHook(repo, `${line}\n`, { dest, hook: hookCheckout(base, 'process.exit(0);\n'), env: { BASH_ENV: stub.replace(/\\/g, '/') } });
      assert.equal(got.status, 1, got.stdout + got.stderr);
      assert.equal(got.argv, null, 'the full gate ran although neither the lane nor awk worked');
    });
  });

  it('CDPATH cannot corrupt the hook root: a healthy lane is still found via a relative $0', (t) => {
    if (!guard(t)) return;
    withFixture(({ repo, dest }) => {
      // The hook checkout lives INSIDE the pusher's tree so a relative path reaches it, and
      // CDPATH points at the pusher's root so `cd hookco/.githooks/..` would print a path.
      const root = path.join(repo, 'hookco');
      fs.mkdirSync(path.join(root, '.githooks'), { recursive: true });
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      fs.copyFileSync(HOOK, path.join(root, '.githooks', 'pre-push'));
      fs.writeFileSync(path.join(root, 'scripts', 'prepush-archive-lane.mjs'), say('archive-lane/v1 clean'));
      const { line } = archiveCommit(repo, { 'a.txt': 'a\n' });
      const r = spawnSync('bash', ['hookco/.githooks/pre-push', 'origin', dest], {
        cwd: repo,
        encoding: 'utf-8',
        input: `${line}\n`,
        env: { ...process.env, AUDIT_PREPUSH_SANDBOX: '', AUDIT_PREPUSH_ARCHIVE_LANE: '', CDPATH: repo.replace(/\\/g, '/') },
      });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, LANE_CLEAN);
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

  it('a LOCAL source with spaces in it (HEAD^{/add backup}) cannot slip a dirty push past the lane', (t) => {
    if (!guard(t)) return;
    // The adversarial review's HIGH, reproduced with a real push: git writes the stdin line
    // `HEAD^{/add backup} <sha> refs/heads/archive/ws <sha>`, five whitespace-separated
    // fields. A left-to-right parser called it malformed, the lane answered not-applicable,
    // and the full gate (which does not scan) published a .env.
    inWorktree(({ wt, dest, push, remoteHas, marker }) => {
      git(['checkout', '-q', '-b', 'archive/ws'], wt);
      commit(wt, { '.env': 'K=v\n' }, 'add backup');
      const dirty = push([dest, 'HEAD^{/add backup}:refs/heads/archive/ws']);
      assert.notEqual(dirty.status, 0, dirty.stdout + dirty.stderr);
      assert.match(dirty.stdout + dirty.stderr, /archive lane blocked/);
      assert.equal(remoteHas('refs/heads/archive/ws'), false, 'a dirty push with a spaced source arrived unscanned');
      assert.equal(fs.existsSync(marker), false, 'the full gate ran for an archive-only push');

      // The clean control with the same source shape: it takes the lane and arrives.
      git(['checkout', '-q', '-b', 'archive/ws2', 'main'], wt);
      commit(wt, { 'ok.txt': 'ok\n' }, 'add backup');
      const clean = push([dest, 'HEAD^{/add backup}:refs/heads/archive/ws2']);
      assert.equal(clean.status, 0, clean.stdout + clean.stderr);
      assert.match(clean.stdout + clean.stderr, LANE_CLEAN);
      assert.equal(remoteHas('refs/heads/archive/ws2'), true);
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
