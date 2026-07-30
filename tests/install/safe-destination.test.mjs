/**
 * The destination-containment guard (S2 layer 2).
 *
 * Two properties carry the weight, and they pull against each other — which is
 * why both are pinned here:
 *
 *   1. A symlink ANYWHERE on the path — including at the root itself — is
 *      refused. The `--uninstall-legacy` delete path never runs the CLI-level
 *      root check, so a guard that trusted its root would leave the one
 *      operation that deletes from `$HOME` unprotected.
 *   2. `ENOENT` is a PASS. An empty target directory is a valid first install,
 *      so on adoption none of the managed destinations exist yet; a traversal
 *      that let ENOENT propagate would crash the primary adoption path.
 *
 * Plan: docs/plans/repo-scoped-skill-surfaces-and-installer.md §6 S2.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertContainedDestination, assertContainedAbsolute, ContainmentError,
} from '../../scripts/lib/install/safe-destination.mjs';
import { _internals as txnInternals } from '../../scripts/lib/install/transaction.mjs';

let root, outside;

beforeEach(() => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-safedest-')));
  root = path.join(tmp, 'root');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  const parent = path.dirname(root);
  fs.rmSync(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/**
 * Can this platform/account create symlinks at all?
 *
 * Probed ONCE, up front, and surfaced as a real `skip` reason rather than an
 * `if (!link) return` inside each test. A silent early-return would let the
 * entire symlink half of this suite read green on a machine where it never ran —
 * and these are the assertions protecting a delete path into `$HOME`, so
 * "it passed" must not be able to mean "it was never attempted". (Windows
 * without Developer Mode / SeCreateSymbolicLink is the realistic case; verified
 * available on the authoring machine.)
 */
const SYMLINK_SUPPORT = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-symprobe-'));
  try {
    const target = path.join(probe, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(probe, 'link'), 'junction');
    return { ok: true, skip: false };
  } catch (err) {
    return { ok: false, skip: `platform cannot create symlinks (${err.code}) — containment symlink cases NOT verified here` };
  } finally {
    fs.rmSync(probe, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
})();

function symlink(target, linkPath, type = 'junction') {
  fs.symlinkSync(target, linkPath, type);
  return linkPath;
}

describe('assertContainedDestination — the happy path', () => {
  it('returns the absolute destination for a plain relative path', () => {
    const abs = assertContainedDestination({ root, relPath: 'a/b/c.md' });
    assert.equal(abs, path.join(root, 'a', 'b', 'c.md'));
  });

  // THE first-install case. If this throws, adoption is broken.
  it('accepts a destination whose ancestors do not exist yet (ENOENT is a pass)', () => {
    assert.equal(fs.readdirSync(root).length, 0);
    const abs = assertContainedDestination({ root, relPath: 'scripts/.claude-skills/deep/x.mjs' });
    assert.equal(abs, path.join(root, 'scripts', '.claude-skills', 'deep', 'x.mjs'));
  });

  it('accepts existing real (non-link) ancestors', () => {
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
    assert.ok(assertContainedDestination({ root, relPath: '.claude/skills/ship/SKILL.md' }));
  });

  it('accepts backslash-separated relative paths (Windows callers)', () => {
    assert.ok(assertContainedDestination({ root, relPath: 'a\\b\\c.md' }));
  });
});

describe('assertContainedDestination — escapes', () => {
  it('refuses a `..` escape', () => {
    assert.throws(() => assertContainedDestination({ root, relPath: '../outside/x.md' }), ContainmentError);
  });

  it('refuses a `..` escape buried mid-path', () => {
    assert.throws(
      () => assertContainedDestination({ root, relPath: 'a/b/../../../outside/x.md' }),
      ContainmentError,
    );
  });

  it('refuses an absolute relPath outright rather than normalising it', () => {
    assert.throws(
      () => assertContainedDestination({ root, relPath: path.join(outside, 'x.md') }),
      /must be relative/,
    );
  });

  it('refuses the root itself as a destination', () => {
    assert.throws(() => assertContainedDestination({ root, relPath: '.' }), ContainmentError);
  });
});

describe('assertContainedDestination — symlinks at every position', { skip: SYMLINK_SUPPORT.skip }, () => {
  it('refuses a symlinked ROOT (the uninstall path never checks its own root)', () => {
    const link = symlink(root, path.join(path.dirname(root), 'root-link'));
    assert.throws(
      () => assertContainedDestination({ root: link, relPath: 'a.md' }),
      /root is a symlink/,
    );
  });

  it('refuses a symlinked FIRST component', () => {
    symlink(outside, path.join(root, '.claude'));
    assert.throws(
      () => assertContainedDestination({ root, relPath: '.claude/skills/x.md' }),
      /crosses a symlink/,
    );
  });

  it('refuses a symlinked DEEP component — not just the nearest ancestor', () => {
    // The distinction that matters: a guard checking only the top level, or only
    // the nearest existing ancestor, passes this.
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    symlink(outside, path.join(root, 'scripts', '.claude-skills'));
    assert.throws(
      () => assertContainedDestination({ root, relPath: 'scripts/.claude-skills/deep/x.mjs' }),
      /crosses a symlink/,
    );
  });

  // The hole this closes, verified by probe before the fix: with
  // `base/link -> outside` and a declared root of `base/link/skills` that does
  // NOT exist yet, `lstat(root)` returned ENOENT so nothing ever inspected
  // `base/link`, and the guard returned `base/link/skills/x.md` — a path that
  // actually lands in `outside/skills/`. The returned value LIED about the write
  // destination, which is worse than a rejection because the caller's
  // containment reasoning is built on it.
  it('resolves a symlinked ANCESTOR when the root does not exist yet', () => {
    const base = path.join(root, 'base');
    fs.mkdirSync(base, { recursive: true });
    symlink(outside, path.join(base, 'link'));

    const declaredRoot = path.join(base, 'link', 'skills');   // does not exist
    const abs = assertContainedDestination({ root: declaredRoot, relPath: 'x.md' });

    const realOutside = fs.realpathSync(outside);
    assert.equal(abs, path.join(realOutside, 'skills', 'x.md'),
      'the returned path must be where the write actually lands, not the lexical form');
    assert.ok(!abs.includes(`link${path.sep}skills`),
      'the unresolved ancestor link must not survive in the returned path');
  });

  // `fs.existsSync` FOLLOWS symlinks, so it returns false for a DANGLING link —
  // an upward walk using it would step straight past a real symlinked ancestor as
  // though nothing were there and anchor containment one level too high. The walk
  // uses lstat for exactly this reason; a dangling ancestor must fail loudly, not
  // silently relocate the root.
  it('fails loudly on a DANGLING symlinked ancestor rather than walking past it', () => {
    const base = path.join(root, 'base');
    fs.mkdirSync(base, { recursive: true });
    const gone = path.join(path.dirname(root), 'never-existed');
    symlink(gone, path.join(base, 'dangling'));

    assert.throws(
      () => assertContainedDestination({ root: path.join(base, 'dangling', 'skills'), relPath: 'x.md' }),
      (err) => err.code === 'DESTINATION_NOT_CONTAINED',
    );
  });

  it('refuses when the destination ITSELF already exists as a symlink', () => {
    const file = path.join(outside, 'real.md');
    fs.writeFileSync(file, 'x');
    symlink(file, path.join(root, 'x.md'), 'file');
    assert.throws(() => assertContainedDestination({ root, relPath: 'x.md' }), /crosses a symlink/);
  });
});

describe('assertContainedAbsolute — the delete path', () => {
  it('accepts a path under the root', () => {
    const target = path.join(root, '.claude', 'skills', 'ship', 'SKILL.md');
    assert.equal(assertContainedAbsolute({ root, absPath: target }), target);
  });

  it('refuses a path outside the root', () => {
    assert.throws(
      () => assertContainedAbsolute({ root, absPath: path.join(outside, 'x.md') }),
      /escapes its root/,
    );
  });

  it('refuses the root itself', () => {
    assert.throws(() => assertContainedAbsolute({ root, absPath: root }), /escapes its root/);
  });

  // Same guard, same verdict — proving the delete path is not a second,
  // subtly-different implementation.
  it('applies the identical symlink rule as the write path', { skip: SYMLINK_SUPPORT.skip }, () => {
    symlink(outside, path.join(root, '.agents'));
    assert.throws(
      () => assertContainedAbsolute({ root, absPath: path.join(root, '.agents', 'skills', 'x.md') }),
      /crosses a symlink/,
    );
  });
});

describe('assertContainedDestination — fails closed on bad input', () => {
  it('requires a root and a relPath', () => {
    assert.throws(() => assertContainedDestination({ relPath: 'a.md' }), /root is required/);
    assert.throws(() => assertContainedDestination({ root }), /relPath is required/);
  });
});

// transaction.mjs keeps its OWN containment check rather than being rerouted
// through this module, and that decision rests on a factual claim about its
// behaviour. Pin the claim here so it is settled by an assertion instead of by a
// docstring someone re-reads and doubts.
//
// History worth keeping: an audit round asserted that check was "lexical" and
// therefore insufficient, and that assertion was written into the plan before
// anyone ran it. It is not lexical — it realpaths the nearest existing ancestor,
// which is exactly what catches a symlinked directory. Replacing it would have
// been churn plus a behaviour change (this module additionally rejects symlinks
// that stay INSIDE the root, which are not escapes).
describe('transaction.mjs containment — the claim that justifies keeping it separate', () => {
  it('rejects a destination beneath a junction pointing outside the root', { skip: SYMLINK_SUPPORT.skip }, () => {
    fs.writeFileSync(path.join(outside, 'victim.md'), 'do not touch');
    symlink(outside, path.join(root, 'skills'));
    assert.equal(
      txnInternals.isWithinAllowedRoots(path.join(root, 'skills', 'victim.md'), [root]),
      false,
      'a symlinked ancestor that escapes the root must be rejected — this is why it is not "lexical"',
    );
  });

  it('accepts a not-yet-existing path inside the root (rename targets, first install)', () => {
    assert.equal(txnInternals.isWithinAllowedRoots(path.join(root, 'a', 'b.md'), [root]), true);
  });

  it('rejects a literal `..` escape', () => {
    assert.equal(
      txnInternals.isWithinAllowedRoots(path.join(root, '..', 'outside', 'victim.md'), [root]),
      false,
    );
  });
});
