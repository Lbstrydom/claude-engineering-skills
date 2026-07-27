/**
 * @fileoverview Tests for resolveEligibleDiffPathMap's sensitive-path
 * filtering, focused on the 6cfb5541 fix: a live symlink resolving to a
 * sensitive target is now caught, while a deleted/renamed-away path (which
 * has no filesystem target) keeps the pre-existing lexical-only behavior —
 * the exact case discovery-diff-scope.mjs's own header explains
 * resolveAndClassify would otherwise silently break.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveEligibleDiffPathMap } from '../scripts/lib/audit/discovery-diff-scope.mjs';
import { trySymlink } from './helpers/fs-symlink-test-utils.mjs';

function diffFor(newPath, oldPath = newPath, status = 'M') {
  const header = status === 'D'
    ? `diff --git a/${oldPath} b/${oldPath}\ndeleted file mode 100644\nindex abc..000\n--- a/${oldPath}\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`
    : `diff --git a/${oldPath} b/${newPath}\nindex abc..def 100644\n--- a/${oldPath}\n+++ b/${newPath}\n@@ -1 +1 @@\n-x\n+y\n`;
  return header;
}

let repoRoot;

before(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-diff-scope-test-'));
});

after(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('resolveEligibleDiffPathMap', () => {
  test('a deleted file (no filesystem target) is unaffected by the symlink check — stays eligible', () => {
    // The exact case the module's own header explains resolveAndClassify
    // would otherwise silently break: a deleted file legitimately has no
    // target to realpath, so it must NOT be dropped just because it doesn't
    // exist on disk.
    const diffText = diffFor('gone.mjs', 'gone.mjs', 'D');
    const { map, skipped } = resolveEligibleDiffPathMap(diffText, { repoRoot });
    assert.equal(map.kind, 'ready', 'a deleted file with a benign lexical name stays eligible');
    assert.equal(skipped.length, 0);
  });

  test('a live symlink resolving to a sensitive target is dropped (6cfb5541 fix)', (t) => {
    const sensitiveTarget = path.join(repoRoot, '.env');
    fs.writeFileSync(sensitiveTarget, 'SECRET=1');
    const benignName = 'config.mjs';
    const linkPath = path.join(repoRoot, benignName);
    if (!trySymlink(sensitiveTarget, linkPath, 'file')) {
      t.skip('symlink creation unavailable on this host — sensitive-symlink drop NOT verified');
      return;
    }

    const diffText = diffFor(benignName);
    const { map, skipped } = resolveEligibleDiffPathMap(diffText, { repoRoot });
    assert.equal(map.kind, 'empty', 'the only entry was dropped, leaving a legitimate empty scope');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].path, benignName);
  });

  test('a live symlink resolving to a benign target stays eligible', (t) => {
    const benignTarget = path.join(repoRoot, 'real-source.mjs');
    fs.writeFileSync(benignTarget, 'export const x = 1;');
    const linkName = 'alias.mjs';
    const linkPath = path.join(repoRoot, linkName);
    if (!trySymlink(benignTarget, linkPath, 'file')) {
      t.skip('symlink creation unavailable on this host — benign-symlink pass-through NOT verified');
      return;
    }

    const diffText = diffFor(linkName);
    const { map, skipped } = resolveEligibleDiffPathMap(diffText, { repoRoot });
    assert.equal(map.kind, 'ready');
    assert.equal(skipped.length, 0);
  });

  test('a plain (non-symlink) file that exists on disk stays eligible, same as before', () => {
    const p = path.join(repoRoot, 'plain.mjs');
    fs.writeFileSync(p, 'export const y = 2;');
    const diffText = diffFor('plain.mjs');
    const { map, skipped } = resolveEligibleDiffPathMap(diffText, { repoRoot });
    assert.equal(map.kind, 'ready');
    assert.equal(skipped.length, 0);
  });

  test('a lexically-sensitive path is still dropped before any filesystem check (unchanged behavior)', () => {
    const diffText = diffFor('.env', '.env', 'D'); // deleted .env — lexical check must fire regardless
    const { map, skipped } = resolveEligibleDiffPathMap(diffText, { repoRoot });
    assert.equal(map.kind, 'empty');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].category, 'sensitive');
  });

  test('a live BROKEN symlink with a benign lexical name is dropped, not treated as deleted (H2 fix)', (t) => {
    // Before H2: the gate used fs.existsSync, which follows the final symlink
    // and returns false for a dangling target — identical to a genuinely
    // deleted file, so this case silently skipped resolveAndClassify and
    // stayed eligible. lstat-based existsOnDisk sees the live dirent and
    // still asks resolveAndClassify, which fails closed on the broken
    // realpath (ENOENT) regardless of the lexically-benign name.
    const missingTarget = path.join(repoRoot, 'this-target-does-not-exist.mjs');
    const benignName = 'broken-link.mjs';
    const linkPath = path.join(repoRoot, benignName);
    if (!trySymlink(missingTarget, linkPath, 'file')) {
      t.skip('symlink creation unavailable on this host — broken-symlink drop NOT verified');
      return;
    }

    const diffText = diffFor(benignName);
    const { map, skipped } = resolveEligibleDiffPathMap(diffText, { repoRoot });
    assert.equal(map.kind, 'empty', 'a dangling symlink must fail closed, not fall through as if deleted');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].path, benignName);
  });

  test('an ancestor-path-is-a-file diff (ENOTDIR) is treated as absent, not thrown (H5 fix)', () => {
    // A directory-to-file transition: the parent path segment used to be a
    // directory and is now a plain file, so lstat-ing anything "under" it
    // throws ENOTDIR, not ENOENT. Before H5, existsOnDisk only caught ENOENT
    // and rethrew everything else, crashing resolveEligibleDiffPathMap on an
    // ordinary diff shape instead of treating the path as absent.
    const nowAFile = path.join(repoRoot, 'was-a-dir');
    fs.writeFileSync(nowAFile, 'x');
    const benignPath = 'was-a-dir/child.mjs'; // repo-relative; parent segment is a file on disk
    const diffText = diffFor(benignPath);
    assert.doesNotThrow(() => resolveEligibleDiffPathMap(diffText, { repoRoot }));
    const { map, skipped } = resolveEligibleDiffPathMap(diffText, { repoRoot });
    assert.equal(map.kind, 'ready', 'ENOTDIR degrades to the deleted-file (lexical-only) path, same as ENOENT');
    assert.equal(skipped.length, 0);
  });

  test('the sensitive gate sees the DECODED path from a genuinely-quoted, octal-escaped header (refactor-evidence-integrity.md §9 seam test 4)', () => {
    // Deleted (no filesystem target — no symlink fixture needed), so this
    // exercises exactly "the gate receives the real path", not "the gate
    // works" (already covered above). secrets/ is a lexically-sensitive
    // directory regardless of the accented filename.
    const diffText = 'diff --git "a/secrets/caf\\303\\251.env" "b/secrets/caf\\303\\251.env"\n'
      + 'deleted file mode 100644\nindex abc..000\n--- "a/secrets/caf\\303\\251.env"\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n';
    const { map, skipped } = resolveEligibleDiffPathMap(diffText, { repoRoot });
    assert.equal(map.kind, 'empty', 'the only entry was dropped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].category, 'sensitive');
    assert.equal(skipped[0].path, 'secrets/café.env', 'reported path is the DECODED form, not the raw octal-escaped wire text');
  });
});
