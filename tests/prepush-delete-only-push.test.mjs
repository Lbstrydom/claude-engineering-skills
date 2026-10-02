/**
 * @fileoverview A push that only DELETES remote refs publishes no commits, so
 * this repo's pre-push hook (`.githooks/pre-push`) must not run `npm run check`
 * for it — and a push that publishes anything must still be checked.
 *
 * THE DEFECT (observed 2026-10-02). `git push origin --delete some-branch` from a
 * linked worktree detached at origin/main ran the full ~10-minute check and was
 * then BLOCKED: the hook's stdin loop skipped the deletion line (correctly —
 * nothing was pushed) but carried on with an empty range, so the sandbox's drift
 * gates fell back to inference, whose fork-point against origin/main WAS HEAD.
 * `status:integrity:gate` then failed closed on `base == HEAD`, rightly refusing
 * to call a zero-commit comparison "conserved". Nothing was wrong with any gate;
 * the hook was asking them to verify a push that sent nothing.
 *
 * WHY BEHAVIOURAL. The cases run the real hook body against a fixture repo whose
 * `scripts/prepush-check.mjs` is a stub that records its argv. That observes the
 * one thing that matters — was the check invoked, and with WHICH range — rather
 * than the spelling of the guard.
 *
 * BOTH DIRECTIONS ARE PINNED. A skip that fires too widely is a gate that passes
 * having checked nothing, so most cases here are ones that must NOT skip: a mixed
 * push, an ordinary update, a NEW branch (zero REMOTE sha — the look-alike of a
 * deletion's zero LOCAL sha), and empty stdin, where "every ref update is a
 * deletion" is vacuously true over zero updates.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { hasBash, git } from './lib/hook-test-helpers.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(__filename, '..', '..');
const HOOK = path.join(REPO_ROOT, '.githooks', 'pre-push');

const HAS_BASH = hasBash();
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

const ZERO = '0'.repeat(40);
const MARKER = 'prepush-check-argv.json';

/**
 * A repo with the three scripts the hook invokes before/at the check, each a
 * stub. `prepush-check.mjs` records its argv so a case can assert the RANGE it
 * was handed, not merely that it ran. No sync/maintenance scripts → those
 * sections self-skip, keeping the run hermetic.
 */
function withFixture(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-delete-only-'));
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    git(['init', '-q', '-b', 'main', repo]);
    git(['config', 'user.email', 'fixture@example.invalid'], repo);
    git(['config', 'user.name', 'Fixture'], repo);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture","private":true}\n');
    fs.writeFileSync(
      path.join(repo, 'scripts', 'prepush-check.mjs'),
      `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(MARKER)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    for (const stub of ['check-stale-skill-surface.mjs', 'harvest-audit-transcripts.mjs']) {
      fs.writeFileSync(path.join(repo, 'scripts', stub), 'process.exit(0);\n');
    }
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'seed'], repo);
    const seed = git(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'NOTES.md'), 'change\n');
    git(['add', 'NOTES.md'], repo);
    git(['commit', '-q', '-m', 'change'], repo);
    const tip = git(['rev-parse', 'HEAD'], repo);
    // The new-branch path computes `git merge-base origin/main <local_sha>`.
    git(['update-ref', 'refs/remotes/origin/main', seed], repo);
    return fn({ repo, seed, tip });
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function runHook(repo, stdin) {
  const r = spawnSync('bash', [HOOK, 'origin', 'https://example.invalid'], {
    cwd: repo,
    encoding: 'utf-8',
    input: stdin,
    // AUDIT_PREPUSH_SANDBOX=0 in the caller's env would route to the in-tree
    // `npm run check` branch and bypass the stub — pin the sandbox branch.
    env: { ...process.env, AUDIT_PREPUSH_SANDBOX: '' },
  });
  const markerPath = path.join(repo, MARKER);
  const argv = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf-8')) : null;
  return { ...r, argv };
}

const SKIP_NOTE = /delete-only push/;

describe('.githooks/pre-push — a delete-only push skips the check', () => {
  it('skips a single branch deletion, saying so on stderr', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withFixture(({ repo, seed }) => {
      const got = runHook(repo, `(delete) ${ZERO} refs/heads/doomed ${seed}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.argv, null, 'the check ran for a push that published nothing');
      assert.match(got.stderr, SKIP_NOTE);
    });
  });

  it('skips several deletions in one push', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withFixture(({ repo, seed, tip }) => {
      const got = runHook(repo,
        `(delete) ${ZERO} refs/heads/a ${seed}\n(delete) ${ZERO} refs/heads/b ${tip}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.argv, null);
      assert.match(got.stderr, SKIP_NOTE);
    });
  });
});

describe('.githooks/pre-push — anything that publishes is still checked', () => {
  it('a mixed push checks the real update, at ITS range, not the deletion', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withFixture(({ repo, seed, tip }) => {
      // Deletion FIRST: a skip keyed on the first line, or a range taken from
      // it, would both show up here.
      const got = runHook(repo,
        `(delete) ${ZERO} refs/heads/doomed ${tip}\nrefs/heads/main ${tip} refs/heads/main ${seed}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.deepEqual(got.argv, ['--base', seed, '--head', tip]);
      assert.doesNotMatch(got.stderr, SKIP_NOTE);
    });
  });

  it('an ordinary update is checked exactly as before', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withFixture(({ repo, seed, tip }) => {
      const got = runHook(repo, `refs/heads/main ${tip} refs/heads/main ${seed}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.deepEqual(got.argv, ['--base', seed, '--head', tip]);
      assert.doesNotMatch(got.stderr, SKIP_NOTE);
    });
  });

  it('a NEW branch (zero REMOTE sha) is not mistaken for a deletion (zero LOCAL sha)', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withFixture(({ repo, seed, tip }) => {
      const got = runHook(repo, `refs/heads/feature ${tip} refs/heads/feature ${ZERO}\n`);
      assert.equal(got.status, 0, got.stderr);
      // Range is the fork point from origin/main, unchanged behaviour.
      assert.deepEqual(got.argv, ['--base', seed, '--head', tip]);
      assert.doesNotMatch(got.stderr, SKIP_NOTE);
    });
  });

  it('empty stdin is NOT a delete-only push — zero updates must not vacuously skip', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withFixture(({ repo }) => {
      const got = runHook(repo, '');
      assert.equal(got.status, 0, got.stderr);
      assert.deepEqual(got.argv, [], 'with no push info the check must still run (inferring its range)');
      assert.doesNotMatch(got.stderr, SKIP_NOTE);
    });
  });
});
