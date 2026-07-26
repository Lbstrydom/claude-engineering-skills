import fs from 'node:fs';

/**
 * @fileoverview Shared symlink-creation helper for tests that need to assert
 * on real filesystem symlinks. Some hosts (locked-down CI runners, some
 * Windows configurations without SeCreateSymbolicLinkPrivilege) refuse
 * symlink creation with EPERM/EACCES — that is a platform capability gap,
 * not a test failure, so callers should skip (return early) rather than fail
 * when `trySymlink` returns `false`. Any OTHER error rethrows: it must never
 * be misread as "this host can't do symlinks" when it's a real bug.
 *
 * Extracted (M16, code-audit r1 on refactor-audit-pipeline-reliability-2026-07)
 * from three near-identical copies: tests/audit-clean-traversal.test.mjs,
 * tests/orphan-preimage-sweep.test.mjs, tests/discovery-diff-scope.test.mjs.
 */
export const SYMLINK_UNSUPPORTED = new Set(['EPERM', 'EACCES']);

/**
 * @param {string} target - the symlink's target path
 * @param {string} linkPath - where to create the symlink
 * @param {'file'|'dir'} [type] - symlink type (Windows distinguishes them; ignored on POSIX)
 * @returns {boolean} true if created, false if this host can't create symlinks
 */
export function trySymlink(target, linkPath, type = 'file') {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    if (SYMLINK_UNSUPPORTED.has(err.code)) return false;
    throw err;
  }
}
