/**
 * @fileoverview Fixture mechanics against a REAL git repository.
 *
 * Every assertion here corresponds to something that was measured to fail on
 * 2026-08-17/18 (plan: docs/plans/pinned-revision-fixture.md §4). The
 * `node_modules` resolution case in particular is a one-off probe promoted to a
 * standing test, per this repo's "promote a one-off check that mattered" rule.
 *
 * Temp repos live under `C:/tmp`-equivalent OS temp, NOT the session scratchpad:
 * a deep scratchpad path plus a full checkout hits Windows MAX_PATH and
 * half-checks-out, which reads as a broken tool rather than a path-length
 * problem.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixture, verifyFixture, removeFixture, resolveRevision, provisionNodeModules } from '../scripts/lib/pinned-worktree/manage.mjs';
import { assertFixtureName, defaultFixtureRoot } from '../scripts/lib/pinned-worktree/paths.mjs';
import { git } from './helpers/git.mjs';

let ROOT; let REPO; let FIXTURES; let FIRST; let SECOND;

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pwt-suite-'));
  REPO = path.join(ROOT, 'repo');
  FIXTURES = path.join(ROOT, 'fixtures');
  fs.mkdirSync(REPO, { recursive: true });

  git(['init', '-b', 'main'], REPO);
  git(['config', 'user.email', 'test@example.invalid'], REPO);
  git(['config', 'user.name', 'test'], REPO);

  // A dependency set that is IDENTICAL across both commits, so the link path is
  // taken and no `npm ci` runs inside a unit test.
  fs.writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({ name: 'pwt-fixture', version: '1.0.0', dependencies: {} }, null, 2));
  fs.writeFileSync(path.join(REPO, 'package-lock.json'), JSON.stringify({ name: 'pwt-fixture', lockfileVersion: 3, packages: {} }, null, 2));
  fs.writeFileSync(path.join(REPO, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(REPO, 'marker.txt'), 'first\n');
  git(['add', '-A'], REPO);
  git(['commit', '-m', 'first'], REPO);
  FIRST = git(['rev-parse', 'HEAD'], REPO);

  fs.writeFileSync(path.join(REPO, 'marker.txt'), 'second\n');
  git(['add', '-A'], REPO);
  git(['commit', '-m', 'second'], REPO);
  SECOND = git(['rev-parse', 'HEAD'], REPO);

  // A real node_modules with a resolvable package, so "does Node resolve
  // through the link" is asserted by RESOLVING, not by existsSync.
  const pkg = path.join(REPO, 'node_modules', 'fakepkg');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fakepkg', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = 42;\n');
});

after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
});

describe('the pin — detached at an explicit commit', () => {
  it('checks out DETACHED at the pinned sha, not at HEAD', () => {
    const f = createFixture({ name: 'pin-a', rev: FIRST, root: FIXTURES, cwd: REPO });
    try {
      assert.equal(f.sha, FIRST);
      assert.equal(git(['rev-parse', 'HEAD'], f.dir), FIRST);
      // ...and the repo's own HEAD really is elsewhere, so the assertion above
      // is discriminating rather than trivially true.
      assert.notEqual(FIRST, SECOND);
      assert.equal(git(['rev-parse', 'HEAD'], REPO), SECOND);
      // Detached: `symbolic-ref -q HEAD` exits non-zero.
      assert.throws(() => git(['symbolic-ref', '-q', 'HEAD'], f.dir));
    } finally { removeFixture({ dir: f.dir, cwd: REPO }); }
  });

  it('NEGATIVE CONTROL — a branch checkout is detectable, so `detached` is not vacuous', () => {
    // Proves the detached assertion above can fail: the same probe against a
    // worktree on a branch succeeds instead of throwing.
    const onBranch = path.join(ROOT, 'branch-wt');
    git(['worktree', 'add', '-b', 'probe-branch', onBranch, SECOND], REPO);
    try {
      assert.equal(git(['symbolic-ref', '-q', 'HEAD'], onBranch), 'refs/heads/probe-branch');
      assert.equal(verifyFixture({ dir: onBranch }).checks.find((c) => c.name === 'detached').ok, false);
    } finally {
      git(['worktree', 'remove', '--force', onBranch], REPO);
    }
  });

  it('resolveRevision refuses anything that is not a commit', () => {
    assert.throws(() => resolveRevision('no-such-ref-anywhere', REPO));
  });
});

describe('node_modules provisioning', () => {
  it('links, and Node RESOLVES a package through the link', () => {
    const f = createFixture({ name: 'nm-a', rev: FIRST, root: FIXTURES, cwd: REPO });
    try {
      assert.equal(f.modules.mode, 'linked');
      // The load-bearing assertion: resolution, not existence. A dangling link
      // passes existsSync and fails every subprocess the run spawns.
      const resolved = execFileSync(process.execPath,
        ['-e', "process.stdout.write(String(require('fakepkg')))"],
        { cwd: f.dir, encoding: 'utf-8' });
      assert.equal(resolved, '42');
    } finally { removeFixture({ dir: f.dir, cwd: REPO }); }
  });

  it('creates a symlink whose target is ABSOLUTE (Windows junctions require it)', () => {
    const f = createFixture({ name: 'nm-b', rev: FIRST, root: FIXTURES, cwd: REPO });
    try {
      const link = path.join(f.dir, 'node_modules');
      const st = fs.lstatSync(link);
      // Asserted on lstat/readlink semantics, which hold on win32 AND POSIX —
      // `'junction'` is a Windows-only type that other platforms ignore, so
      // asserting "is a junction" would be a win32-only test.
      assert.equal(st.isSymbolicLink(), true, 'node_modules should be a link, not a copy');
      assert.equal(path.isAbsolute(fs.readlinkSync(link)), true);
      assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(REPO, 'node_modules')));
    } finally { removeFixture({ dir: f.dir, cwd: REPO }); }
  });

  it('links when the lockfiles differ ONLY by line ending (CRLF regression)', () => {
    // Found by this suite on 2026-08-18. With `core.autocrlf=true` — the
    // Git-for-Windows SYSTEM default, present even when user and global config
    // are empty — a fresh worktree checkout gets CRLF while the main working
    // tree holds LF, so the same committed lockfile measured 59 bytes against
    // 63 and every `create` paid a full `npm ci`. This repo's
    // `.gitattributes eol=lf` masks it; a consumer repo without one does not.
    //
    // Forced explicitly rather than relying on the ambient git config, so the
    // regression is still covered on a machine where autocrlf is off.
    const f = createFixture({ name: 'eol-a', rev: FIRST, root: FIXTURES, cwd: REPO });
    try {
      const lock = path.join(f.dir, 'package-lock.json');
      fs.writeFileSync(lock, fs.readFileSync(lock, 'utf-8').replace(/\r?\n/g, '\r\n'));
      fs.unlinkSync(path.join(f.dir, 'node_modules'));
      const again = provisionNodeModules(f.dir, REPO);
      assert.equal(again.mode, 'linked', 'a CRLF-only difference must not force an install');
    } finally { removeFixture({ dir: f.dir, cwd: REPO }); }
  });
});

describe('removal — reconciles registry and disk, and never deletes through a link', () => {
  it('leaves the LINK TARGET intact (the destructive risk this guards)', () => {
    const f = createFixture({ name: 'rm-a', rev: FIRST, root: FIXTURES, cwd: REPO });
    const r = removeFixture({ dir: f.dir, cwd: REPO });
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(f.dir), false);
    // The failure mode being defended against: destroying the main checkout's
    // node_modules by recursing through the junction.
    assert.equal(fs.existsSync(path.join(REPO, 'node_modules', 'fakepkg', 'index.js')), true);
  });

  it('is idempotent — removing an already-removed fixture succeeds', () => {
    const f = createFixture({ name: 'rm-b', rev: FIRST, root: FIXTURES, cwd: REPO });
    assert.equal(removeFixture({ dir: f.dir, cwd: REPO }).ok, true);
    // git deregisters even when its own delete fails, so the second call must
    // tolerate "is not a working tree" rather than treat it as an error.
    assert.equal(removeFixture({ dir: f.dir, cwd: REPO }).ok, true);
  });

  it('does NOT unlink a REAL node_modules directory — it deletes it with the tree', () => {
    const f = createFixture({ name: 'rm-c', rev: FIRST, root: FIXTURES, cwd: REPO });
    // Replace the link with a real directory: `remove` must not treat it as a
    // link, and must still leave the main checkout's tree untouched.
    fs.unlinkSync(path.join(f.dir, 'node_modules'));
    fs.mkdirSync(path.join(f.dir, 'node_modules', 'realpkg'), { recursive: true });
    fs.writeFileSync(path.join(f.dir, 'node_modules', 'realpkg', 'i.js'), 'x');
    const r = removeFixture({ dir: f.dir, cwd: REPO });
    assert.equal(r.ok, true);
    assert.match(r.steps.join('\n'), /real directory/);
    assert.equal(fs.existsSync(path.join(REPO, 'node_modules', 'fakepkg', 'index.js')), true);
  });
});

describe('verify — the four properties fail independently', () => {
  it('reports a dirty tree as a distinct failure from a wrong pin', () => {
    const f = createFixture({ name: 'vf-a', rev: FIRST, root: FIXTURES, cwd: REPO });
    try {
      fs.writeFileSync(path.join(f.dir, 'marker.txt'), 'dirtied\n');
      const r = verifyFixture({ dir: f.dir, expectedSha: FIRST });
      const by = Object.fromEntries(r.checks.map((c) => [c.name, c.ok]));
      assert.equal(by.clean, false, 'a dirty tree must be reported');
      assert.equal(by.pinned, true, 'the pin is still correct — the two must not be conflated');
      assert.equal(r.ok, false);
    } finally { removeFixture({ dir: f.dir, cwd: REPO }); }
  });

  it('reports a pin mismatch when the expected sha differs', () => {
    const f = createFixture({ name: 'vf-b', rev: FIRST, root: FIXTURES, cwd: REPO });
    try {
      const r = verifyFixture({ dir: f.dir, expectedSha: SECOND });
      assert.equal(r.checks.find((c) => c.name === 'pinned').ok, false);
    } finally { removeFixture({ dir: f.dir, cwd: REPO }); }
  });

  it('reports a non-existent fixture rather than throwing', () => {
    const r = verifyFixture({ dir: path.join(FIXTURES, 'never-created') });
    assert.equal(r.ok, false);
  });
});

describe('cross-agent hygiene — no Claude-specific side effects', () => {
  it('suppresses the post-checkout hook, and the NEGATIVE CONTROL shows the hook does fire without suppression', () => {
    // Wire a marker-writing post-checkout hook into the temp repo.
    const hooks = path.join(ROOT, 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, 'post-checkout');
    fs.writeFileSync(hook, '#!/bin/sh\ntouch "$(git rev-parse --show-toplevel)/HOOK_FIRED"\n');
    fs.chmodSync(hook, 0o755);
    git(['config', 'core.hooksPath', hooks], REPO);

    try {
      // Negative control FIRST: without suppression the hook must fire, or the
      // positive assertion below would pass against a hook that never runs.
      const control = path.join(ROOT, 'hook-control');
      git(['worktree', 'add', '--detach', control, FIRST], REPO);
      const controlFired = fs.existsSync(path.join(control, 'HOOK_FIRED'));
      git(['worktree', 'remove', '--force', control], REPO);
      assert.equal(controlFired, true, 'the negative control did not fire — this test proves nothing');

      // Now the real assertion.
      const f = createFixture({ name: 'hook-a', rev: FIRST, root: FIXTURES, cwd: REPO });
      try {
        assert.equal(fs.existsSync(path.join(f.dir, 'HOOK_FIRED')), false,
          'createFixture must suppress repo hooks — a Codex or Copilot user must not inherit Claude-specific side effects');
      } finally { removeFixture({ dir: f.dir, cwd: REPO }); }
    } finally {
      git(['config', '--unset', 'core.hooksPath'], REPO);
    }
  });
});

describe('the decision tripwire — an OUTSIDE fixture must still resolve the main .env', () => {
  // This is what makes "put the fixture outside the repo" (plan §2 Decision 1)
  // safe, and it is the ONE property that would reverse the decision if it
  // regressed. `.env` is gitignored, so a fixture has none of its own; it
  // resolves the MAIN checkout's through `discoverLocalEnvPath`'s
  // `main-worktree` branch (landed in 606537ee). Without that branch, an
  // outside fixture would silently run credential-less — which on 2026-08-17
  // left five keys unset and a stray ancestor `.env` shadowing the real one.
  //
  // Pinned here rather than left implicit so removing the branch fails a test
  // that says WHY, instead of silently invalidating a design decision.
  it('resolves the MAIN checkout .env, not a stray one in an ancestor directory', () => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pwt-outside-'));
    try {
      // The negative control: a competing `.env` ABOVE where the fixture will
      // sit. Proximity must lose to repository membership.
      fs.writeFileSync(path.join(outsideRoot, '.env'), 'PWT_MARKER=stray\n');
      fs.writeFileSync(path.join(REPO, '.env'), 'PWT_MARKER=main\n');

      const f = createFixture({ name: 'env-a', rev: FIRST, root: path.join(outsideRoot, 'fx'), cwd: REPO });
      try {
        const resolved = execFileSync(process.execPath, [
          '--input-type=module', '-e',
          `import(${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'scripts/lib/shared-cloud-config.mjs')).href)})`
          + '.then(m => process.stdout.write(String(m.discoverLocalEnvPath(process.cwd(), { onNotice(){} }))))',
        ], { cwd: f.dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

        assert.equal(fs.realpathSync(resolved), fs.realpathSync(path.join(REPO, '.env')),
          'an outside fixture must resolve the MAIN checkout .env — if this fails, revisit plan §2 Decision 1 before shipping');
        assert.notEqual(fs.realpathSync(resolved), fs.realpathSync(path.join(outsideRoot, '.env')));
      } finally { removeFixture({ dir: f.dir, cwd: REPO }); }
    } finally {
      try { fs.unlinkSync(path.join(REPO, '.env')); } catch { /* already gone */ }
      fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('containment — a fixture name cannot escape its root', () => {
  it('refuses path separators and traversal', () => {
    for (const bad of ['..', '../evil', 'a/b', 'a\\b', '.hidden', 'UPPER', '']) {
      assert.throws(() => assertFixtureName(bad), undefined, `${JSON.stringify(bad)} was accepted`);
    }
  });

  it('accepts ordinary campaign-shaped names', () => {
    for (const ok of ['bakeoff-2026q3', 'a', 'arm-eval-2']) assert.equal(assertFixtureName(ok), ok);
  });

  it('defaults to a SIBLING of the main checkout, never inside it', () => {
    const root = defaultFixtureRoot(REPO);
    assert.equal(path.dirname(root), path.dirname(REPO));
    assert.equal(root.startsWith(REPO + path.sep), false, 'the default root must not be inside the repository');
  });
});
