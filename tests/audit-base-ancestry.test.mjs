/**
 * @fileoverview Phase 4 — guard C at the audit boundary, against a REAL git repo.
 *
 * Plan: docs/plans/worktree-identity-guards.md §5 "Guard C — base ancestry".
 *
 * These use real repos rather than an injected runner on purpose: the oracle's
 * decision logic is already unit-tested in tests/worktree-identity.test.mjs, and
 * what is unproven here is what GIT actually does — specifically the two
 * measurements the plan's design rests on:
 *
 *   1. `git diff --name-only <base>..<head>` DROPS uncommitted work, so the
 *      `..` form silently under-scopes a dirty-tree audit. The no-`..` form
 *      does not. Two rounds of the final gate turned on this.
 *   2. Today's shipped three-call union misses a STAGED-but-uncommitted file
 *      through every branch — a live pre-existing bug this phase fixes.
 *
 * A regression here would restore a silent under-scope, which reads as a green
 * audit that reviewed nothing.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveRangeSnapshot, makeGitRunner } from '../scripts/lib/worktree-identity.mjs';

let repo;
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ancestry-'));
  git(['init', '-q', '.']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
});

after(() => { try { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } });

const write = (rel, body) => fs.writeFileSync(path.join(repo, rel), body);

describe('resolveRangeSnapshot against a real repository', () => {
  test('an explicit ancestor base resolves both ends to OIDs', () => {
    write('a.txt', 'a1\n'); git(['add', '.']); git(['commit', '-qm', 'c1']);
    const base = git(['rev-parse', 'HEAD']);
    write('b.txt', 'b1\n'); git(['add', '.']); git(['commit', '-qm', 'c2']);
    const head = git(['rev-parse', 'HEAD']);

    const r = resolveRangeSnapshot({ explicitBase: base, workingTreeDirty: false, run: makeGitRunner(repo) });
    assert.equal(r.ok, true);
    assert.equal(r.baseSha, base);
    assert.equal(r.headSha, head);
    assert.equal(r.relation, 'ancestor');
  });

  test('a base on a DIVERGED ref is refused — incident 3\'s shape', () => {
    const mainHead = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '-b', 'sidebranch', 'HEAD~1']);
    write('side.txt', 's\n'); git(['add', '.']); git(['commit', '-qm', 'side']);
    const sideHead = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '-']);              // back to the original ref
    assert.equal(git(['rev-parse', 'HEAD']), mainHead, 'precondition: we are back on the first line of history');

    const r = resolveRangeSnapshot({ explicitBase: sideHead, workingTreeDirty: false, run: makeGitRunner(repo) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-an-ancestor',
      'a base off this history must fail hard, never demote to the dirty-aware default');
  });

  test('an unresolvable explicit base fails hard rather than inferring', () => {
    const r = resolveRangeSnapshot({
      explicitBase: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', workingTreeDirty: false, run: makeGitRunner(repo),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unresolvable-explicit');
  });

  test('a dirty inferred base is HEAD itself, so the diff targets the worktree', () => {
    write('a.txt', 'dirty\n');
    const r = resolveRangeSnapshot({ explicitBase: null, workingTreeDirty: true, run: makeGitRunner(repo) });
    assert.equal(r.ok, true);
    assert.equal(r.baseSha, r.headSha);
    assert.equal(r.relation, 'identical');
    git(['checkout', '--', 'a.txt']);
  });
});

// ── The two measurements the design rests on ────────────────────────────────
describe('git diff semantics — why the `..` form was removed', () => {
  test('`<base>..<head>` DROPS uncommitted work; `<base>` alone does not', () => {
    const base = git(['rev-parse', 'HEAD~1']);
    const head = git(['rev-parse', 'HEAD']);
    write('a.txt', 'unstaged-edit\n');           // unstaged
    write('staged.txt', 'new\n'); git(['add', 'staged.txt']);  // STAGED, uncommitted

    const twoDot = git(['diff', '--name-only', `${base}..${head}`]).split('\n').filter(Boolean);
    const noDot = git(['diff', '--name-only', base]).split('\n').filter(Boolean);

    assert.equal(twoDot.includes('staged.txt'), false, 'the `..` form cannot see staged work');
    assert.equal(twoDot.includes('a.txt'), false, 'nor unstaged work');
    assert.ok(noDot.includes('staged.txt'), 'the no-`..` form sees staged work');
    assert.ok(noDot.includes('a.txt'), 'and unstaged work');
  });

  test('the OLD three-call union missed a staged-but-uncommitted file (the live bug)', () => {
    const head = git(['rev-parse', 'HEAD']);
    // Reproduce the shipped pre-fix computation exactly.
    const oldRange = git(['diff', '--name-only', `${head}..${head}`]).split('\n').filter(Boolean);
    const oldBare = git(['diff', '--name-only']).split('\n').filter(Boolean);
    const oldUntracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
    const oldUnion = new Set([...oldRange, ...oldBare, ...oldUntracked]);

    assert.equal(oldUnion.has('staged.txt'), false,
      'pins the defect: staged.txt is in the index, so it is not "other", not in HEAD..HEAD, and not in the bare worktree-vs-index diff');

    const fixed = new Set(git(['diff', '--name-only', head]).split('\n').filter(Boolean));
    assert.ok(fixed.has('staged.txt'), 'the single-call form is what closes it');

    git(['reset', '-q']); git(['checkout', '--', '.']);
    try { fs.rmSync(path.join(repo, 'staged.txt'), { recursive: true, maxRetries: 3, retryDelay: 50 }); } catch { /* already gone */ }
  });
});
