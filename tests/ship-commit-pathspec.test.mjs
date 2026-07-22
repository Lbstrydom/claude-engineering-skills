/**
 * @fileoverview `--path` (pathspec commit) for scripts/ship-commit.mjs.
 *
 * Motivation (field-found 2026-07-19): two Claude sessions shared one working
 * tree. `ship-commit` commits the INDEX, so committing one session's work
 * would have bundled the other's staged `setup-postgres`/`AGENTS.md` edits
 * into an unrelated commit — corrupting blame for both. The workaround was a
 * bare `git commit -- <paths>`, which loses the AI-* provenance trailers this
 * CLI exists to guarantee. `--path` closes that gap: pathspec scoping AND
 * trailers.
 *
 * The load-bearing guarantee is the LAST test: another session's staged work
 * must still be staged, and NOT in the commit, afterwards.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGitRunner } from './helpers/fixtures.mjs';
import { makeRunCli } from './helpers/run-cli.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/ship-commit.mjs');

let repo;

const git = makeGitRunner(() => repo);

const runCli = makeRunCli(CLI, {
  cwd: () => repo,
  command: process.execPath,
  buildEnv: (cwd) => ({ ...process.env, AUDIT_DB_URL: '', HOME: cwd, USERPROFILE: cwd }),
});

function msgFile(text = 'feat: scoped subject\n\nbody\n') {
  fs.mkdirSync(path.join(repo, '.claude', 'tmp'), { recursive: true });
  const mf = path.join('.claude', 'tmp', 'msg.txt');
  fs.writeFileSync(path.join(repo, mf), text);
  return mf;
}

const BASE = (mf) => ['--message-file', mf, '--skill', 'ship', '--models', 'claude', '--gate', 'not-run'];

/** Files touched by the commit at HEAD. */
function filesInHead() {
  return git(['show', '--name-only', '--format=', 'HEAD']).split('\n').map((s) => s.trim()).filter(Boolean);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-pathspec-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(repo, 'skills', 'ship'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'seed']);
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('ship-commit --path', () => {
  it('commits only the named path and still appends the AI-* trailers', () => {
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n');
    fs.writeFileSync(path.join(repo, 'theirs.txt'), 'theirs\n');
    git(['add', 'mine.txt', 'theirs.txt']);

    const r = runCli([...BASE(msgFile()), '--path', 'mine.txt']);
    assert.equal(r.status, 0, r.stderr);

    assert.deepEqual(filesInHead(), ['mine.txt']);
    const body = git(['log', '-1', '--format=%B']);
    assert.match(body, /AI-Skill: ship\n/);
    assert.match(body, /AI-Gate: not-run/);
  });

  it('LOAD-BEARING: another session\'s staged work survives, still staged', () => {
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n');
    fs.writeFileSync(path.join(repo, 'theirs.txt'), 'their in-flight work\n');
    git(['add', 'mine.txt', 'theirs.txt']);

    const r = runCli([...BASE(msgFile()), '--path', 'mine.txt']);
    assert.equal(r.status, 0, r.stderr);

    assert.ok(!filesInHead().includes('theirs.txt'), 'must not bundle unrelated staged work');
    const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    assert.deepEqual(staged, ['theirs.txt'], 'their staging intent must be preserved, not reset');
  });

  it('accepts --path repeatedly', () => {
    for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(repo, f), `${f}\n`);
    git(['add', 'a.txt', 'b.txt', 'c.txt']);

    const r = runCli([...BASE(msgFile()), '--path', 'a.txt', '--path', 'b.txt']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(filesInHead().sort(), ['a.txt', 'b.txt']);
  });

  it('commits an UNTRACKED named path (the new-file case)', () => {
    fs.writeFileSync(path.join(repo, 'brand-new.txt'), 'new module\n');
    // deliberately NOT staged — a bare `git commit -- <untracked>` fails with
    // "did not match any file(s) known to git"; the CLI must handle it.
    const r = runCli([...BASE(msgFile()), '--path', 'brand-new.txt']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(filesInHead(), ['brand-new.txt']);
  });

  it('commits worktree content, not a stale staged version', () => {
    fs.writeFileSync(path.join(repo, 'f.txt'), 'staged version\n');
    git(['add', 'f.txt']);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'newer worktree version\n');

    const r = runCli([...BASE(msgFile()), '--path', 'f.txt']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(git(['show', 'HEAD:f.txt']), /newer worktree version/);
  });

  it('rejects a path outside the repo (containment)', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'evil.txt'), 'x\n');
      fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n');
      git(['add', 'mine.txt']);
      const r = runCli([...BASE(msgFile()), '--path', path.join(outside, 'evil.txt')]);
      assert.equal(r.status, 2, 'containment violation is an input rejection');
      assert.match(r.stderr, /AGENT FIX/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('rejects --path naming something with no changes', () => {
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n');
    git(['add', 'mine.txt']);
    const r = runCli([...BASE(msgFile()), '--path', 'README.md']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /AGENT FIX/);
    assert.equal(git(['rev-list', '--count', 'HEAD']).trim(), '1', 'no commit created');
  });

  it('tolerates an unchanged path alongside a changed one (git semantics)', () => {
    // `git commit -- changed unchanged` commits the changed one without
    // complaint; being stricter than git here would reject legitimate runs.
    // The all-unchanged case IS rejected — see the test above.
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n');
    const r = runCli([...BASE(msgFile()), '--path', 'mine.txt', '--path', 'README.md']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(filesInHead(), ['mine.txt']);
  });

  it('leaves no dangling intent-to-add when the run is rejected', () => {
    // Untracked path FIRST (so `git add -N` is applied), then a containment
    // violation that rejects the run — proving the rollback actually fires.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-rb-'));
    try {
      fs.writeFileSync(path.join(outside, 'evil.txt'), 'x\n');
      fs.writeFileSync(path.join(repo, 'newfile.txt'), 'x\n');
      const r = runCli([...BASE(msgFile()), '--path', 'newfile.txt', '--path', path.join(outside, 'evil.txt')]);
      assert.equal(r.status, 2, r.stderr);
      const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
      assert.ok(!staged.includes('newfile.txt'), 'a rejected run must not leave the shared index dirtied');
      assert.equal(git(['rev-list', '--count', 'HEAD']).trim(), '1', 'no commit created');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('without --path, behaviour is unchanged (commits the whole index)', () => {
    fs.writeFileSync(path.join(repo, 'x.txt'), 'x\n');
    fs.writeFileSync(path.join(repo, 'y.txt'), 'y\n');
    git(['add', 'x.txt', 'y.txt']);
    const r = runCli(BASE(msgFile()));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(filesInHead().sort(), ['x.txt', 'y.txt']);
  });
});
