/**
 * @fileoverview `--no-tests` — the sanctioned hook-bypass override.
 *
 * WHY THIS EXISTS: `/ship`'s SKILL.md documented `--no-tests` and promised the
 * override would be recorded, but `ship-commit.mjs` (a) rejected it as an
 * unknown flag and (b) committed without `--no-verify`. So the documented
 * escape hatch could not actually be taken. Reported from a consumer repo on
 * 2026-07-19 after a flaky pre-commit hook blocked a commit four times against
 * a suite verified green three times directly — leaving only "retry until
 * lucky" or "move the hook aside", the second of which is gate-tampering.
 *
 * A gate with no sanctioned override manufactures exactly that pressure. The
 * fix is an override that is loud and auditable rather than absent: it passes
 * `--no-verify` AND can only ever DOWNGRADE the gate claim, because a `passed`
 * verdict cannot survive skipping the checks that would evidence it.
 *
 * The cap is evidence-dependent, not a flat `waived`: `waived` asserts "a
 * verdict existed and I shipped past it", so with no fresh audit evidence the
 * truthful label is `not-run` — skipping hooks does not manufacture a verdict.
 *
 * The hook assertions here are the load-bearing ones: asserting the flag
 * "parses" would pass even if `--no-verify` were never appended.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeGitRunner, gitFixtureEnv } from './helpers/fixtures.mjs';
import { guardArgs } from './helpers/worktree-guard-args.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/ship-commit.mjs');

let repo;

const git = makeGitRunner(() => repo);

function runCli(args) {
  const env = { ...process.env, AUDIT_DB_URL: '', HOME: repo, USERPROFILE: repo };
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf-8', env });
}

/** Install a pre-commit hook that ALWAYS fails — stands in for the flaky suite. */
function installFailingHook() {
  const hooks = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const p = path.join(hooks, 'pre-commit');
  fs.writeFileSync(p, '#!/bin/sh\necho "hook: deliberately failing" >&2\nexit 1\n');
  try { fs.chmodSync(p, 0o755); } catch { /* Windows — best effort */ }
}

function arrange(message = 'fix: subject\n\nbody\n') {
  fs.mkdirSync(path.join(repo, '.claude', 'tmp'), { recursive: true });
  const mf = path.join('.claude', 'tmp', 'msg.txt');
  fs.writeFileSync(path.join(repo, mf), message);
  fs.writeFileSync(path.join(repo, 'work.txt'), `payload ${Date.now()}\n`);
  git(['add', 'work.txt']);
  return mf;
}

const ARGS = (mf, ...extra) =>
  ['--message-file', mf, '--skill', 'ship', '--models', 'claude', ...extra, ...guardArgs(repo)];

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-notests-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(repo, 'skills', 'ship'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'skills', 'ship', 'SKILL.md'), '---\nname: ship\n---\n');
});

afterEach(() => {
  // maxRetries/retryDelay are required by tests/rmsync-retry-guard.test.mjs —
  // a git repo's pack files are routinely still held on Windows at teardown.
  try { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
});

describe('ship-commit --no-tests (feedback 2026-07-19 item 5)', () => {
  it('is accepted as a known flag', () => {
    const mf = arrange();
    const r = runCli(ARGS(mf, '--gate', 'not-run', '--no-tests'));
    assert.doesNotMatch(r.stderr, /unknown flag/, r.stderr);
    assert.equal(r.status, 0, r.stderr);
  });

  it('NEGATIVE CONTROL: without --no-tests a failing hook blocks the commit', () => {
    // Establishes the hook actually bites. Without this, the next test proves
    // nothing — a commit could succeed because the hook never ran at all.
    installFailingHook();
    const mf = arrange();
    const before = git(['rev-list', '--count', '--all']).trim();
    const r = runCli(ARGS(mf, '--gate', 'not-run'));
    assert.notEqual(r.status, 0, 'expected the failing pre-commit hook to block');
    // Assert the HOOK is why — a bare non-zero would also be satisfied by an
    // arg-parse rejection, which would make the bypass test below vacuous.
    assert.match(r.stderr, /hook: deliberately failing/, 'the block must come from the hook, not from arg validation');
    assert.equal(git(['rev-list', '--count', '--all']).trim(), before, 'no commit should exist');
  });

  it('with --no-tests the same failing hook is bypassed and the commit lands', () => {
    installFailingHook();
    const mf = arrange();
    const r = runCli(ARGS(mf, '--gate', 'not-run', '--no-tests'));
    assert.equal(r.status, 0, `expected --no-verify passthrough to bypass the hook.\n${r.stderr}`);
    assert.match(git(['log', '-1', '--format=%s']), /fix: subject/);
  });

  it('caps the gate at not-run when no audit evidence exists, and announces it', () => {
    // No evidence => `waived` would be a lie (nothing produced a verdict to
    // waive), so the cap is `not-run`.
    const mf = arrange();
    const r = runCli(ARGS(mf, '--gate', 'passed', '--no-tests'));
    assert.equal(r.status, 0, r.stderr);
    const body = git(['log', '-1', '--format=%B']);
    assert.match(body, /AI-Gate: not-run/, 'the override must downgrade the gate claim');
    assert.doesNotMatch(body, /AI-Gate: passed/);
    assert.match(r.stderr, /--no-tests caps AI-Gate at "not-run"/, 'the downgrade must be announced, not silent');
  });

  it('cannot be used to claim a passed gate', () => {
    const mf = arrange();
    const r = runCli(ARGS(mf, '--gate', 'passed', '--no-tests'));
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(git(['log', '-1', '--format=%B']), /AI-Gate: passed/);
  });
});
