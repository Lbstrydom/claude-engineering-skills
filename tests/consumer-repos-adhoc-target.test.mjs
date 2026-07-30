/**
 * `resolveAdHocTarget` — the security contract for an operator-supplied sync target.
 *
 * `--target-path` is the first place this bundle accepts an arbitrary filesystem
 * path from the command line and then writes into it, so the properties here are
 * the ones that keep that bounded:
 *
 *   S1 (INC-001) — canonicalise BEFORE any decision. INC-001's recorded lesson is
 *     "anywhere we make a security decision based on a path, the path MUST be
 *     canonicalised before classification", and it was a symlink that made a
 *     lexically-innocent name resolve somewhere sensitive.
 *   S2 — refuse the source repo and anything inside it. Syncing the bundle onto
 *     itself would have the rewriter rewrite source files into consumer layout
 *     in place: silent, and destructive to the working tree.
 *   S3b — an empty but writable directory IS valid (first install is the normal
 *     case); a missing .git/package.json WARNS rather than rejects, because a
 *     non-Node consumer legitimately adopts the .claude/skills/** half alone.
 *
 * Plan: docs/plans/repo-scoped-skill-surfaces-and-installer.md §6 S1/S2/S3b.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveAdHocTarget, SOURCE_REPO_ROOT } from '../scripts/lib/consumer-repos.mjs';

let tmp;

beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-adhoc-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

/**
 * Can this platform/account create symlinks?
 *
 * Probed once and surfaced as a real `skip` reason. The earlier `if (!link)
 * return` form made Node record these as PASSING tests when the symlink setup
 * failed and no assertion ran — so the canonicalisation guarantees they exist to
 * protect would have read green on a machine where they were never checked.
 */
const SYMLINK_SUPPORT = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-adhoc-symprobe-'));
  try {
    const target = path.join(probe, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(probe, 'link'), 'junction');
    return { skip: false };
  } catch (err) {
    return { skip: `platform cannot create symlinks (${err.code}) — canonicalisation cases NOT verified here` };
  } finally {
    fs.rmSync(probe, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
})();

function symlinkDir(target, linkPath) {
  fs.symlinkSync(target, linkPath, 'junction');
  return linkPath;
}

describe('resolveAdHocTarget — shape', () => {
  it('returns the registry identity triple, and nothing else', () => {
    const t = resolveAdHocTarget(tmp);
    assert.deepEqual(Object.keys(t).sort(), ['alias', 'name', 'path']);
    assert.equal(t.path, tmp);
    assert.equal(t.alias, null);
    assert.equal(t.name, path.basename(tmp));
  });

  it('accepts a relative path and resolves it', () => {
    const child = path.join(tmp, 'child');
    fs.mkdirSync(child);
    const cwd = process.cwd();
    try {
      process.chdir(tmp);
      assert.equal(resolveAdHocTarget('child').path, child);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('resolveAdHocTarget — S1: canonicalise before deciding', () => {
  it('resolves a symlinked target to its real path', { skip: SYMLINK_SUPPORT.skip }, () => {
    const real = path.join(tmp, 'real');
    fs.mkdirSync(real);
    const link = symlinkDir(real, path.join(tmp, 'link'));

    // The load-bearing part: the RESOLVED path is what downstream writes use, so
    // a link cannot smuggle the write somewhere the checks never saw.
    assert.equal(resolveAdHocTarget(link).path, real);
  });

  it('a symlink pointing INTO the source repo is refused (S1 feeding S2)', { skip: SYMLINK_SUPPORT.skip }, () => {
    const link = symlinkDir(SOURCE_REPO_ROOT, path.join(tmp, 'sneaky'));
    // Lexically `sneaky` is innocent; only the canonical target reveals it.
    assert.throws(() => resolveAdHocTarget(link), /source repo/i);
  });

  it('an unresolvable path is a hard error, never a best-effort write', () => {
    assert.throws(() => resolveAdHocTarget(path.join(tmp, 'does-not-exist')), /does not exist/i);
  });
});

describe('resolveAdHocTarget — S2: containment', () => {
  it('refuses the source repo itself', () => {
    assert.throws(() => resolveAdHocTarget(SOURCE_REPO_ROOT), /source repo/i);
  });

  it('refuses a directory INSIDE the source repo', () => {
    assert.throws(() => resolveAdHocTarget(path.join(SOURCE_REPO_ROOT, 'scripts')), /source repo/i);
  });

  it('allows a sibling directory that merely shares a name prefix', () => {
    // Guards against a lexical `startsWith` check: "<root>-other" is NOT inside
    // "<root>", but a naive prefix test says it is.
    const sibling = `${SOURCE_REPO_ROOT}-other`;
    let made = false;
    try {
      if (!fs.existsSync(sibling)) { fs.mkdirSync(sibling); made = true; }
      assert.equal(resolveAdHocTarget(sibling).path, fs.realpathSync(sibling));
    } finally {
      if (made) fs.rmSync(sibling, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('resolveAdHocTarget — S3b: eligibility', () => {
  it('accepts an EMPTY but writable directory (the first-install case)', () => {
    // The sync creates .claude/ and scripts/.claude-skills/ itself, so an empty
    // destination is the normal adoption path, not an error.
    assert.equal(fs.readdirSync(tmp).length, 0);
    assert.equal(resolveAdHocTarget(tmp).path, tmp);
  });

  it('refuses a path that is a FILE, not a directory', () => {
    const file = path.join(tmp, 'a-file.txt');
    fs.writeFileSync(file, 'x');
    assert.throws(() => resolveAdHocTarget(file), /not a directory/i);
  });

  it('a missing .git/package.json warns but does not reject', () => {
    const warnings = [];
    const t = resolveAdHocTarget(tmp, { warn: (m) => warnings.push(m) });
    assert.equal(t.path, tmp);
    assert.equal(warnings.length, 1, 'a non-Node consumer is a legitimate adopter — warn, never refuse');
    assert.match(warnings[0], /\.git|package\.json/);
  });

  it('a real repo produces no warning', () => {
    fs.mkdirSync(path.join(tmp, '.git'));
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    const warnings = [];
    resolveAdHocTarget(tmp, { warn: (m) => warnings.push(m) });
    assert.deepEqual(warnings, []);
  });

  it('rejects a missing/blank argument by name', () => {
    for (const bad of [undefined, null, '', '   ']) {
      assert.throws(() => resolveAdHocTarget(bad), /requires a directory path/i);
    }
  });
});
