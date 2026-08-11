/**
 * @fileoverview Phase 3 — guards A, B and D driven through the REAL ship-commit
 * CLI against REAL git repositories.
 *
 * Plan: docs/plans/worktree-identity-guards.md §5.
 *
 * The oracle's decision logic is unit-tested in tests/worktree-identity.test.mjs.
 * What is unproven without these is the WIRING: that the guards actually fire at
 * the CLI boundary, in the right order, with the documented exit codes — and,
 * critically, that each one can be SEEN TO FAIL. A guard whose refusal is never
 * observed is indistinguishable from a guard that was never wired in.
 *
 * Every case asserts an EXIT CODE, not the presence of a log line. That is
 * deliberate: an earlier draft of this plan made guard B emit a diagnostic and
 * continue, which reads as protection while providing none.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const CLI = fileURLToPath(new URL('../scripts/ship-commit.mjs', import.meta.url));
const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));

let repo;
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const write = (rel, body) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

/** Run the real CLI in the fixture repo. Returns {status, stderr}. */
function ship(args) {
  const msg = path.join(repo, 'msg.txt');
  fs.writeFileSync(msg, 'test: a fixture commit\n');
  const r = spawnSync(process.execPath, [
    CLI, '--message-file', msg, '--skill', 'ship', '--models', 'claude',
    '--gate', 'not-run', '--no-run-id', '--no-tests', ...args,
  ], { cwd: repo, encoding: 'utf-8', windowsHide: true });
  return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ship-'));
  git(['init', '-q', '.']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  // ship-commit resolves its --skill enum from a skills/ layout; symlinking is
  // unreliable on Windows, so mirror just the directory names.
  fs.mkdirSync(path.join(repo, 'skills'), { recursive: true });
  for (const d of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (d.isDirectory()) fs.mkdirSync(path.join(repo, 'skills', d.name), { recursive: true });
  }
  write('seed.txt', 'seed\n');
  git(['add', '.']);
  git(['commit', '-qm', 'seed']);
});

after(() => { try { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } });

const head = () => git(['rev-parse', 'HEAD']);
const branch = () => git(['symbolic-ref', '--quiet', '--short', 'HEAD']);

describe('Guard B — identity is a precondition', () => {
  test('NO expectation refuses (exit 2) — absence must not pass', () => {
    write('a.txt', 'a\n');
    const r = ship(['--path', 'a.txt']);
    assert.equal(r.status, 2, 'omitting the identity bundle must fail closed');
    assert.match(r.stderr, /no-expectation/);
    assert.match(r.stderr, /AGENT FIX/);
  });

  test('an INCOMPLETE bundle refuses — head without a ref disposition', () => {
    const r = ship(['--path', 'a.txt', '--expect-head', head()]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /incomplete-expectation/);
  });

  test('--expect-branch and --expect-detached together refuse', () => {
    const r = ship(['--path', 'a.txt', '--expect-head', head(), '--expect-branch', branch(), '--expect-detached']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /incomplete-expectation/);
  });

  test('a moved HEAD refuses', () => {
    const stale = 'd'.repeat(40);
    const r = ship(['--path', 'a.txt', '--expect-head', stale, '--expect-branch', branch()]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /head-moved/);
  });

  // THE field incident: two refs at the same commit. A sha-only guard passes
  // here and the commit lands on the wrong branch.
  test('same sha, WRONG branch refuses (ref-moved) — the field incident', () => {
    const r = ship(['--path', 'a.txt', '--expect-head', head(), '--expect-branch', 'some-other-branch']);
    assert.equal(r.status, 2, 'a sha match must not be sufficient');
    assert.match(r.stderr, /ref-moved/);
  });

  test('a COMPLETE, matching bundle proceeds and commits', () => {
    const before = head();
    const r = ship(['--path', 'a.txt', '--expect-head', before, '--expect-branch', branch()]);
    assert.equal(r.status, 0, `expected success, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /\[worktree\] identity verified \(source: flag\)/);
    assert.equal(git(['rev-parse', 'HEAD^']), before, 'the new commit sits on the verified base');
    assert.ok(git(['show', '--stat', '--format=', 'HEAD']).includes('a.txt'));
  });
});

describe('Guard A — an unscoped commit is refused', () => {
  test('a staged index with NO --path refuses (exit 2)', () => {
    write('staged.txt', 's\n');
    git(['add', 'staged.txt']);
    const r = ship(['--expect-head', head(), '--expect-branch', branch()]);
    assert.equal(r.status, 2, 'committing the bare index must fail closed');
    assert.match(r.stderr, /refusing to commit the whole index/);
    assert.match(r.stderr, /staged\.txt/, 'the refusal names what it saw');
    assert.match(r.stderr, /--path staged\.txt/, 'and prints the exact remedy');
    git(['reset', '-q']);
  });

  test('--path leaves a FOREIGN staged entry untouched (the isolation property)', () => {
    write('mine.txt', 'm\n');
    write('theirs.txt', 't\n');
    git(['add', 'theirs.txt']);           // another session's in-flight work
    const r = ship(['--path', 'mine.txt', '--expect-head', head(), '--expect-branch', branch()]);
    assert.equal(r.status, 0, r.stderr);
    const committed = git(['show', '--stat', '--format=', 'HEAD']);
    assert.ok(committed.includes('mine.txt'));
    assert.ok(!committed.includes('theirs.txt'), "another session's work must not be absorbed");
    assert.ok(git(['diff', '--cached', '--name-only']).includes('theirs.txt'), 'and must remain staged');
    git(['reset', '-q']);
  });
});

describe('Guard A — a directory silently widens, so it is refused', () => {
  test('an EXISTING directory refuses, with a bounded sample', () => {
    write('sub/a.txt', '1\n');
    write('sub/b.txt', '2\n');
    git(['add', 'sub']); git(['commit', '-qm', 'sub']);
    fs.writeFileSync(path.join(repo, 'sub', 'a.txt'), 'changed\n');
    const r = ship(['--path', 'sub', '--expect-head', head(), '--expect-branch', branch()]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /is a directory, and git would expand it/);
    git(['checkout', '--', '.']);
  });

  // lstat throws ENOENT for a deleted directory, and `cat-file -e` exits 0 for
  // a TREE — so `-e` let this through and git committed every deletion beneath.
  test('a DELETED directory refuses via cat-file -t returning tree', () => {
    fs.rmSync(path.join(repo, 'sub'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const r = ship(['--path', 'sub', '--expect-head', head(), '--expect-branch', branch()]);
    assert.equal(r.status, 2, 'a deleted directory must not pass as a deletion');
    assert.match(r.stderr, /DELETED directory/);
    git(['checkout', '--', '.']);
  });

  test('a deleted FILE is still a legitimate scoped deletion', () => {
    fs.rmSync(path.join(repo, 'sub', 'b.txt'), { recursive: true, maxRetries: 3, retryDelay: 50 });
    const r = ship(['--path', 'sub/b.txt', '--expect-head', head(), '--expect-branch', branch()]);
    assert.equal(r.status, 0, `deletions must still work: ${r.stderr}`);
    assert.ok(git(['show', '--stat', '--format=', 'HEAD']).includes('sub/b.txt'));
  });
});
