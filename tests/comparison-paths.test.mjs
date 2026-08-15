/**
 * @fileoverview Tier 3 (non-negotiable seam — sensitive-path egress): the
 * single resolver for manifest-derived paths.
 *
 * INC-001's lesson is that a classifier existing is not the control; the
 * control is every call site going through it on the CANONICAL path. These
 * assert refusals in every direction AND the negative control — a resolver
 * that refused everything would pass all four refusal tests and be useless.
 *
 * Plan: docs/plans/role-agnostic-comparison-core.md §Security Considerations.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The repo's single classification oracle — used here only to assert the
// FIXTURE is what the test claims, never to re-implement the check.
import { classifyPath } from '../scripts/lib/sensitive-paths.mjs';

import {
  resolveLocalPath, resolveGitPath, assertHandle, PathRefusedError, classifyLookupError,
} from '../scripts/lib/comparison/paths.mjs';

const REPO_ROOT = process.cwd();

describe('comparison/paths — a failed lookup is not evidence of absence', () => {
  // The sibling of the `resolveGitPath` absent-vs-lookup-failed fix. Tested
  // through the exported classifier because no test can portably make a
  // filesystem return EACCES, and a rule exercised only through the one errno
  // the host happens to produce has no coverage at all.
  it('ENOENT and ENOTDIR are proof of absence', () => {
    assert.equal(classifyLookupError(Object.assign(new Error('x'), { code: 'ENOENT' })), 'absent');
    assert.equal(classifyLookupError(Object.assign(new Error('x'), { code: 'ENOTDIR' })), 'absent');
  });

  it('a permission or I/O failure is NOT absence — the direction that must not fire', () => {
    // The whole defect: reporting these as `missing` states "X does not exist"
    // about a path that was never examined.
    for (const code of ['EACCES', 'EPERM', 'EIO', 'ELOOP', 'ENAMETOOLONG']) {
      assert.equal(classifyLookupError(Object.assign(new Error('x'), { code })), 'unknown',
        `${code} must not be reported as absence`);
    }
  });

  it('fails closed on an unrecognised or absent code, and reports success as ok', () => {
    assert.equal(classifyLookupError(new Error('no code')), 'unknown');
    assert.equal(classifyLookupError(Object.assign(new Error('x'), { code: 'EWEIRD' })), 'unknown');
    assert.equal(classifyLookupError(null), 'ok');
    assert.equal(classifyLookupError(undefined), 'ok');
  });
});

describe('comparison/paths — local reads, fail-closed', () => {
  it('NEGATIVE CONTROL: an ordinary in-repo file IS accepted', () => {
    // Without this, a resolver that threw unconditionally would pass every
    // other test in this file.
    const h = resolveLocalPath('package.json', { repoRoot: REPO_ROOT });
    assert.equal(h.__resolved, true);
    assert.equal(h.kind, 'local');
    assert.equal(h.rel, 'package.json');
    assert.ok(h.abs && fs.existsSync(h.abs));
    assert.ok(Object.isFrozen(h), 'the handle must be frozen — a consumer cannot rewrite a resolved path');
  });

  it('refuses an absolute path', () => {
    assert.throws(
      () => resolveLocalPath(path.join(REPO_ROOT, 'package.json'), { repoRoot: REPO_ROOT }),
      (e) => e instanceof PathRefusedError && e.reason === 'absolute-path',
    );
  });

  it('refuses a path that escapes the repo', () => {
    assert.throws(
      () => resolveLocalPath('../../etc/passwd', { repoRoot: REPO_ROOT }),
      (e) => e instanceof PathRefusedError && ['escapes-repo', 'missing', 'sensitive'].includes(e.reason),
    );
  });

  it('refuses a missing path AT LOAD — a typo costs nothing', () => {
    assert.throws(
      () => resolveLocalPath('docs/plans/definitely-not-a-real-file-9f3a.md', { repoRoot: REPO_ROOT }),
      (e) => e instanceof PathRefusedError && e.reason === 'missing',
    );
  });

  it('refuses a sensitive path by classification, not by name-matching here', () => {
    // `.env` is the canonical sensitive case; the refusal must come from the
    // shared oracle, which is why this module owns no pattern list of its own.
    assert.throws(
      () => resolveLocalPath('.env', { repoRoot: REPO_ROOT }),
      (e) => e instanceof PathRefusedError && ['sensitive', 'missing'].includes(e.reason),
    );
  });

  // Both cases below assert the SPECIFIC reason, not merely that something threw.
  //
  // This test used to link to `${os.homedir()}/.ssh/id_rsa` and assert only
  // `e instanceof PathRefusedError`. Measured 2026-08-15 on a machine with no
  // such key: it threw `resolution-failed` — the dangling-link branch — so the
  // sensitive-path check it exists to guard had never once run, and it passed
  // green anyway. Worse, the target was outside the repo, and `escapedRepo` is
  // tested BEFORE `sensitive`, so even WITH a real key present it would have
  // refused as `escapes-repo` and still never reached the branch. A regression
  // test for a security incident that cannot fail is not a regression test.
  //
  // Owning the target instead of borrowing the developer's removes both
  // problems: it exists, and its location is chosen rather than assumed.
  it('refuses a symlink whose in-repo target is sensitive (the INC-001 shape)', (t) => {
    // The whole incident: a link named innocently, resolving somewhere else.
    // The basename must BE `id_rsa` — the patterns match the name, not a
    // suffix, so `…-id_rsa` classifies as null. The per-pid DIRECTORY keeps
    // concurrent runs apart without touching the filename that carries the
    // meaning. (Caught by the fixture guard below on the first attempt.)
    const targetDir = path.join(REPO_ROOT, '.audit', `inc001-${process.pid}`);
    const targetAbs = path.join(targetDir, 'id_rsa');
    const linkRel = `.audit/inc001-innocent-${process.pid}.txt`;
    const linkAbs = path.join(REPO_ROOT, linkRel);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetAbs, 'not a real key');
    try {
      fs.symlinkSync(targetAbs, linkAbs);
    } catch {
      t.skip('symlink creation not permitted in this environment');
      return;
    }
    try {
      // Guard the fixture itself: if the filename ever stops matching the
      // sensitive patterns, this test would go green on a benign path.
      assert.equal(classifyPath(path.relative(REPO_ROOT, targetAbs)), 'sensitive',
        'fixture invalid — the target must classify as sensitive for this test to mean anything');
      assert.throws(
        () => resolveLocalPath(linkRel, { repoRoot: REPO_ROOT }),
        (e) => e instanceof PathRefusedError && e.reason === 'sensitive',
        'a link must be refused on its CANONICAL target, not its innocent visible name',
      );
    } finally {
      fs.rmSync(linkAbs, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(targetDir, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('refuses a symlink that escapes the repo, naming THAT as the reason', (t) => {
    // The other half of the INC-001 shape, and a distinct fact: we refuse
    // because the canonical target is outside the repo, which we can assert
    // without the target being sensitive at all.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc001-outside-'));
    const targetAbs = path.join(outsideDir, 'ordinary.txt');
    const linkRel = `.audit/inc001-escape-${process.pid}.txt`;
    const linkAbs = path.join(REPO_ROOT, linkRel);
    fs.mkdirSync(path.dirname(linkAbs), { recursive: true });
    fs.writeFileSync(targetAbs, 'ordinary');
    try {
      fs.symlinkSync(targetAbs, linkAbs);
    } catch {
      t.skip('symlink creation not permitted in this environment');
      return;
    }
    try {
      assert.throws(
        () => resolveLocalPath(linkRel, { repoRoot: REPO_ROOT }),
        (e) => e instanceof PathRefusedError && e.reason === 'escapes-repo',
      );
    } finally {
      fs.rmSync(linkAbs, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(outsideDir, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('comparison/paths — historical reads use git, not the filesystem', () => {
  it('resolves a file that exists at HEAD', () => {
    const h = resolveGitPath('package.json', { repoRoot: REPO_ROOT, rev: 'HEAD' });
    assert.equal(h.kind, 'git');
    assert.equal(h.present, true);
    assert.equal(h.rev, 'HEAD');
    assert.equal(h.abs, null, 'a historical handle has no working-tree absolute path');
  });

  it('a path ABSENT at that revision is unverifiable, NOT a refusal', () => {
    // The functional flaw a realpath-everything rule would have introduced:
    // refusing here turns "the repo moved on" into a false absence claim
    // against a true finding.
    const h = resolveGitPath('docs/plans/role-agnostic-comparison-core.md', {
      repoRoot: REPO_ROOT, rev: 'HEAD~50',
    });
    assert.equal(h.present, false, 'absent at that rev');
    assert.equal(h.kind, 'git');
  });

  it('still refuses an absolute path and a repo escape', () => {
    assert.throws(() => resolveGitPath('/etc/passwd', { repoRoot: REPO_ROOT, rev: 'HEAD' }),
      (e) => e.reason === 'absolute-path');
    assert.throws(() => resolveGitPath('../outside.txt', { repoRoot: REPO_ROOT, rev: 'HEAD' }),
      (e) => e.reason === 'escapes-repo');
  });

  it('requires a revision — a historical read with no rev is a programming error', () => {
    assert.throws(() => resolveGitPath('package.json', { repoRoot: REPO_ROOT }), /rev is required/);
  });
});

describe('comparison/paths — the handle is the control', () => {
  it('assertHandle rejects a bare string, which is the whole point', () => {
    // "Branded type" enforces nothing in a JavaScript repo. This does.
    assert.throws(() => assertHandle('scripts/foo.mjs'),
      (e) => e instanceof PathRefusedError && e.reason === 'not-a-handle');
    assert.throws(() => assertHandle(null), (e) => e.reason === 'not-a-handle');
    assert.throws(() => assertHandle({ rel: 'x', abs: '/x' }), (e) => e.reason === 'not-a-handle');
  });

  it('assertHandle passes a real handle through', () => {
    const h = resolveLocalPath('package.json', { repoRoot: REPO_ROOT });
    assert.equal(assertHandle(h), h);
  });

  it('a FORGED handle is rejected — the brand is not the public flag', () => {
    // The control was decorative while it keyed on `__resolved`: any caller
    // could freeze an object carrying that property and walk through the
    // boundary with an arbitrary path. The real brand is a module-private
    // symbol, so this forgery — which mimics the visible shape exactly — fails.
    const forged = Object.freeze({
      __resolved: true, kind: 'local', rel: '../../etc/passwd', abs: '/etc/passwd', rev: null,
    });
    assert.throws(() => assertHandle(forged),
      (e) => e.reason === 'not-a-handle',
      'a hand-built object carrying __resolved must NOT authenticate as a resolved path');
  });
});

describe('comparison/paths — absence vs lookup failure are different facts', () => {
  it('a genuinely absent blob reports absence, not a git failure', () => {
    const h = resolveGitPath('docs/plans/role-agnostic-comparison-core.md', {
      repoRoot: REPO_ROOT, rev: 'HEAD~50',
    });
    assert.equal(h.present, false);
    assert.ok(typeof h.absence === 'string', 'absence must be stated, not implied by present:false alone');
  });

  it('a BAD REVISION is not evidence of absence', () => {
    // Collapsing this into `present:false` manufactures a false absence claim
    // against a true finding — an arm penalised because git was unavailable.
    const h = resolveGitPath('package.json', { repoRoot: REPO_ROOT, rev: 'definitely-not-a-rev-9f3a' });
    assert.equal(h.present, false);
    assert.notEqual(h.absence, 'absent',
      'a lookup failure must be distinguishable from the file genuinely not being there');
    assert.match(String(h.absence), /^lookup-failed:/);
  });

  it('a present blob reports absence: null', () => {
    const h = resolveGitPath('package.json', { repoRoot: REPO_ROOT, rev: 'HEAD' });
    assert.equal(h.present, true);
    assert.equal(h.absence, null);
  });

  it('a GIT handle authenticates — the registry keys on identity, so it must be the returned object', () => {
    // The gap that let a real break through: every assertHandle test used a
    // LOCAL handle, so nothing noticed when resolveGitPath started registering
    // one object and returning a different one (spread + extra fields). The
    // module was rejecting its own output.
    for (const rev of ['HEAD', 'HEAD~50']) {
      const h = resolveGitPath('package.json', { repoRoot: REPO_ROOT, rev });
      assert.equal(assertHandle(h), h, `a git handle at ${rev} must authenticate`);
    }
  });
});
