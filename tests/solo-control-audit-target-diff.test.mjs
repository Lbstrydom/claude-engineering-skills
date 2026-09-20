/**
 * Regression test for the audit-target-identity bug (docs/plans/audit-target-
 * identity-commit-sha-correction.md): `audit_runs.commit_sha` is HEAD at
 * audit-capture time — the PARENT of a dirty-tree `/audit-code` audit, not
 * the diff the arms actually read. `extractAuditedDiff` reconstructs the real
 * diff from `audited_sha`/`audited_tree` via a self-evidencing dirty/clean
 * branch; `partitionDiscoveredRows` dedups audit units by the COMPOSITE
 * `(audited_sha, audited_tree)` pair, not `audited_tree` alone (a real
 * collision the R2 plan-audit round caught: two different starting HEADs can
 * land on the same resulting tree from different diffs).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _internals } from '../scripts/solo-control-audit.mjs';

const { extractDiff, extractAuditedDiff, partitionDiscoveredRows } = _internals;

// Isolated from ambient git config (global signing/hooks/templates) so this
// fixture can't hang or fail for reasons unrelated to what it asserts — e.g. a
// machine with `commit.gpgsign=true` set globally would otherwise block on a
// passphrase prompt inside `git commit`. `GIT_CONFIG_NOSYSTEM` + a throwaway
// `HOME`/`XDG_CONFIG_HOME` skip system and user-global config entirely; the
// per-repo `-c` flags are a second, redundant belt for the values that matter
// most (signing, hooks, templates) even if some global config still leaks in.
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-control-diff-home-'));
const ISOLATED_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: ISOLATED_HOME, XDG_CONFIG_HOME: ISOLATED_HOME };
const ISOLATION_FLAGS = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir='];

function git(root, args) {
  return execFileSync('git', [...ISOLATION_FLAGS, ...args], { cwd: root, encoding: 'utf8', env: ISOLATED_ENV });
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-control-diff-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  return root;
}

describe('extractAuditedDiff — dirty-tree branch reconstructs the real audited diff', () => {
  it('diffs auditedSha..auditedTree when the worktree was dirty at capture, not the wrong git-show diff', () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'line1\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'baseline']);
    const auditedSha = git(root, ['rev-parse', 'HEAD']).trim();

    // Dirty the tree (uncommitted) and capture its tree object — mirrors what
    // gitWorktreeTree does via a throwaway index; a real index is fine here
    // since this repo is disposable.
    fs.writeFileSync(path.join(root, 'a.txt'), 'line1\nline2\n');
    git(root, ['add', '-A']);
    const auditedTree = git(root, ['write-tree']).trim();

    const fixed = extractAuditedDiff(root, { auditedSha, auditedTree });
    assert.deepEqual(fixed.files, ['a.txt']);
    assert.match(fixed.diff, /\+line2/);

    // Negative control: the OLD (buggy) approach — `git show <auditedSha>` —
    // shows the diff that CREATED a.txt, not the dirty line2 addition. If this
    // assertion ever fails, the fixture stopped exercising the bug and the
    // positive assertion above is not proving what it claims to.
    const old = extractDiff(root, auditedSha);
    assert.ok(!old.diff.includes('+line2'), 'old git-show approach must NOT see the dirty change (that is the bug this test guards against)');
  });
});

describe('extractAuditedDiff — clean-tree branch matches the pre-fix behavior exactly', () => {
  it('delegates to git show <auditedSha> when the tree was clean at capture (no dirty-aware base shift)', () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'line1\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'baseline']);
    fs.writeFileSync(path.join(root, 'a.txt'), 'line1\nline2\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'clean commit']);
    const auditedSha = git(root, ['rev-parse', 'HEAD']).trim();
    const auditedTree = git(root, ['rev-parse', `${auditedSha}^{tree}`]).trim();

    const fixed = extractAuditedDiff(root, { auditedSha, auditedTree });
    const legacy = extractDiff(root, auditedSha);
    assert.deepEqual(fixed, legacy);
    assert.match(fixed.diff, /\+line2/);
  });
});

describe('partitionDiscoveredRows — composite (audited_sha, audited_tree) identity', () => {
  it('dedups by the composite pair, never by audited_tree alone (the R2 collision)', () => {
    // Two different starting HEADs land on the SAME resulting tree T via
    // different diffs (one changing f, the other changing g) — audited_tree
    // alone would collapse these into one unit and silently drop a real diff.
    const rows = [
      { commit_sha: 'c1', audited_sha: 'H1', audited_tree: 'T' },
      { commit_sha: 'c2', audited_sha: 'H2', audited_tree: 'T' },
    ];
    const { resolved, unresolvedIncompleteIdentityCount } = partitionDiscoveredRows(rows);
    assert.equal(unresolvedIncompleteIdentityCount, 0);
    assert.equal(resolved.length, 2, 'both units must survive — audited_tree alone must not dedup them');
    assert.deepEqual(new Set(resolved.map((r) => r.auditedSha)), new Set(['H1', 'H2']));
  });

  it('a true duplicate — same audited_sha AND audited_tree — collapses to one unit', () => {
    const rows = [
      { commit_sha: 'c1', audited_sha: 'H1', audited_tree: 'T1' },
      { commit_sha: 'c1', audited_sha: 'H1', audited_tree: 'T1' },
    ];
    const { resolved } = partitionDiscoveredRows(rows);
    assert.equal(resolved.length, 1);
  });

  it('a row with exactly one of audited_sha/audited_tree is unresolved-incomplete-identity, never a unit', () => {
    const rows = [
      { commit_sha: 'c1', audited_sha: 'H1', audited_tree: null },
      { commit_sha: 'c2', audited_sha: null, audited_tree: 'T2' },
      { commit_sha: 'c3', audited_sha: null, audited_tree: null },
    ];
    const { resolved, unresolvedIncompleteIdentityCount } = partitionDiscoveredRows(rows);
    assert.equal(resolved.length, 0);
    assert.equal(unresolvedIncompleteIdentityCount, 3);
  });
});
