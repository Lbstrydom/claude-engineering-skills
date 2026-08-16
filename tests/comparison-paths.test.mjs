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
import childProcess from 'node:child_process';
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

/**
 * A revision guaranteed to predate `docs/plans/role-agnostic-comparison-core.md`
 * — DERIVED from real history, not a magic `HEAD~50` offset (M5).
 *
 * `HEAD~N` decays as the repo grows and breaks outright in a shallow clone
 * that doesn't reach N commits back. Finding the commit that actually ADDED
 * the file and stepping to its parent is robust to both: it's correct at any
 * point in the repo's future, and a shallow clone that can't reach that far
 * back fails the SAME way `git log --follow` would, so the caller can detect
 * and skip rather than get a false pass or a confusing crash.
 *
 * @returns {string|null} a revision, or null if history doesn't reach far enough
 */
function revisionBeforePlanExisted() {
  // NOT wrapped in the outer try/catch (L3): `git log -- <path>` exits 0 with
  // EMPTY stdout when a path has no matching history — verified empirically,
  // it does not throw for that case. So a throw HERE is a genuine unexpected
  // failure (bad git binary, corrupt repo, malformed invocation) and must
  // propagate, never be swallowed into the same "expected, skip" bucket as a
  // shallow clone. Collapsing the two was the bug: a real environmental
  // failure would silently read as "history doesn't reach far enough" and the
  // caller would skip having learned nothing was actually checked.
  const out = childProcess.execFileSync(
    'git', ['log', '--follow', '--diff-filter=A', '--format=%H', '--',
      'docs/plans/role-agnostic-comparison-core.md'],
    { cwd: REPO_ROOT, encoding: 'utf-8' },
  ).trim().split('\n').filter(Boolean);
  const addedAt = out[out.length - 1]; // oldest add, in case of a rename history
  if (!addedAt) return null; // legitimately no history — not an error, nothing to catch

  // THIS is the one legitimate skip case: a shallow clone (or a root commit
  // with no parent) that leaves `rev-parse --verify` unable to resolve the
  // parent commit. But a bare `catch { return null }` (round 5's fix) still
  // swallowed EVERY failure of this call into that one skip bucket — the
  // round-6 finding this comment now closes: a git binary that can't be
  // spawned at all (ENOENT) is not "history doesn't reach far enough", it's
  // an environment problem, and collapsing it into a silent skip means the
  // caller reads "nothing to check" instead of "the check itself is broken".
  // The two shapes are empirically distinguishable (verified live): git
  // RUNNING and refusing to verify the revision sets `err.status` to its exit
  // code (128 here); a failure to spawn the binary at all sets `err.code` to
  // `'ENOENT'` and leaves `err.status` null. Only the former is the legitimate
  // skip; anything else (ENOENT, a signal, or any other shape) propagates.
  // Round 8, M5: a numeric `err.status` alone (round 6's fix) still collapsed
  // EVERY git-ran-and-refused failure into the skip bucket, not only the
  // "revision doesn't resolve" case — a different fatal error sharing exit
  // code 128 (repo corruption, an unexpected git-internal failure) would also
  // silently read as "shallow clone, nothing to check". Capturing stderr
  // instead of discarding it (`stdio: 'pipe'`, not `'ignore'`) and matching
  // git's own documented message for this exact condition (verified live:
  // `git rev-parse --verify <unresolvable>` prints `fatal: Needed a single
  // revision`) narrows the skip to the one condition it is meant for.
  const parent = `${addedAt}^`;
  try {
    childProcess.execFileSync('git', ['rev-parse', '--verify', parent], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : '';
    if (typeof err.status === 'number' && /needed a single revision/i.test(stderr)) return null;
    throw err;
  }
  return parent;
}

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

  it('ENOENT is missing; every OTHER lstat failure is resolution-failed, never collapsed together', (t) => {
    // L3: a broad catch that treats permission-denied / I/O errors the same
    // as "no such entry" hides a real environmental failure behind a message
    // that reads like a typo. Mocking fs.lstatSync's error CODE, not its
    // presence, is what distinguishes the two branches — no new injection
    // parameter needed for one narrow case.
    const enoent = new Error('no such file'); enoent.code = 'ENOENT';
    const eacces = new Error('permission denied'); eacces.code = 'EACCES';

    t.mock.method(fs, 'lstatSync', () => { throw enoent; });
    assert.throws(() => resolveLocalPath('some/path.txt', { repoRoot: REPO_ROOT }),
      (e) => e instanceof PathRefusedError && e.reason === 'missing');
    fs.lstatSync.mock.restore();

    t.mock.method(fs, 'lstatSync', () => { throw eacces; });
    assert.throws(() => resolveLocalPath('some/path.txt', { repoRoot: REPO_ROOT }),
      (e) => e instanceof PathRefusedError && e.reason === 'resolution-failed' && e.message.includes('EACCES'),
      'a permission error must NOT read as "missing" — that would hide a real environmental failure');
    fs.lstatSync.mock.restore();
  });

  it('revisionBeforePlanExisted: an unresolvable revision skips; a spawn failure (ENOENT) PROPAGATES (M5)', (t) => {
    // Round 6, M5 — a re-raise against round 5's own fix: the catch around
    // `rev-parse --verify` still converted EVERY failure into the skip signal.
    // Empirically distinguished (verified live): git RUNNING and refusing to
    // verify a revision sets `err.status` to a real exit code (128); a failure
    // to spawn the binary at all sets `err.code: 'ENOENT'` and leaves `status`
    // null. Only the first is the legitimate "shallow clone" skip.
    const real = childProcess.execFileSync;

    t.mock.method(childProcess, 'execFileSync', (cmd, args, opts) => {
      if (args.includes('rev-parse')) {
        const e = new Error('spawn git ENOENT'); e.code = 'ENOENT'; e.status = null;
        throw e;
      }
      return real(cmd, args, opts);
    });
    assert.throws(() => revisionBeforePlanExisted(), /ENOENT/,
      'a spawn failure must propagate — it is not "history does not reach far enough"');
    childProcess.execFileSync.mock.restore();

    // Round 8, M5 — a numeric status ALONE still collapsed every git-ran-and-
    // refused failure into the skip bucket, not only "revision doesn't
    // resolve". A different fatal error sharing exit code 128 (repo
    // corruption, an unrelated git-internal failure) must still propagate.
    t.mock.method(childProcess, 'execFileSync', (cmd, args, opts) => {
      if (args.includes('rev-parse')) {
        const e = new Error('git rev-parse failed'); e.status = 128;
        e.stderr = Buffer.from('fatal: not a git repository (or any of the parent directories): .git\n');
        throw e;
      }
      return real(cmd, args, opts);
    });
    assert.throws(() => revisionBeforePlanExisted(), /git rev-parse failed/,
      'status 128 alone is not sufficient — a DIFFERENT fatal error sharing that exit code must still propagate');
    childProcess.execFileSync.mock.restore();

    t.mock.method(childProcess, 'execFileSync', (cmd, args, opts) => {
      if (args.includes('rev-parse')) {
        const e = new Error('git rev-parse failed'); e.status = 128;
        e.stderr = Buffer.from('fatal: Needed a single revision\n');
        throw e;
      }
      return real(cmd, args, opts);
    });
    assert.equal(revisionBeforePlanExisted(), null,
      'git running and refusing to verify the revision, with the documented message, is the legitimate skip');
    childProcess.execFileSync.mock.restore();
  });

  it('the SECOND existence check (post-classification) also distinguishes ENOENT from a real I/O failure (round 7)', (t) => {
    // `resolveAndClassify` uses `fs.realpathSync`, never `lstatSync` — so for a
    // path that classifies successfully (the case reached here), the only
    // `lstatSync` call is the one this fix added. `fs.existsSync` used to sit
    // in this spot and collapse ENOENT/EACCES/any other I/O error into a bare
    // `false`, reported as `missing` regardless of cause — the same class L3
    // (round 5) already closed for the sibling `resolutionFailed` branch.
    const eacces = new Error('permission denied'); eacces.code = 'EACCES';
    t.mock.method(fs, 'lstatSync', () => { throw eacces; });
    assert.throws(() => resolveLocalPath('package.json', { repoRoot: REPO_ROOT }),
      (e) => e instanceof PathRefusedError && e.reason === 'resolution-failed' && e.message.includes('EACCES'),
      'a permission error on an existing, successfully-classified path must NOT read as "missing"');
    fs.lstatSync.mock.restore();

    const enoent = new Error('no such file'); enoent.code = 'ENOENT';
    t.mock.method(fs, 'lstatSync', () => { throw enoent; });
    assert.throws(() => resolveLocalPath('package.json', { repoRoot: REPO_ROOT }),
      (e) => e instanceof PathRefusedError && e.reason === 'missing');
    fs.lstatSync.mock.restore();
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
    fs.rmSync(linkAbs, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 }); // clear any conflicting leftover before asserting privilege, not after
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetAbs, 'not a real key');
    try {
      fs.symlinkSync(targetAbs, linkAbs);
    } catch (err) {
      // Narrowed for the same reason as its sibling below: a bare catch
      // swallows EVERY symlinkSync failure into "not permitted", so a
      // conflicting leftover or a bad fixture path silently skips instead of
      // failing visibly — and a security regression test that skips itself is
      // exactly the shape this test was already rewritten once to escape.
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        t.skip(`symlink creation not permitted in this environment (${err.code})`);
        return;
      }
      throw err;
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
    fs.rmSync(linkAbs, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 }); // clear any conflicting leftover before asserting privilege, not after
    fs.mkdirSync(path.dirname(linkAbs), { recursive: true });
    fs.writeFileSync(targetAbs, 'ordinary');
    try {
      fs.symlinkSync(targetAbs, linkAbs);
    } catch (err) {
      // Round 7 — a bare catch swallowed EVERY symlinkSync failure into "not
      // permitted", so a conflicting leftover fixture or a bad path would also
      // silently skip rather than fail visibly. Node's documented shape for
      // "this platform/user lacks symlink privilege" (Windows without
      // SeCreateSymbolicLinkPrivilege / Developer Mode) is EPERM, sometimes
      // EACCES — narrow the skip to those; anything else is a real setup bug
      // and must fail the test, not silently reduce its coverage.
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        t.skip(`symlink creation not permitted in this environment (${err.code})`);
        return;
      }
      throw err;
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

  it('a path ABSENT at that revision is unverifiable, NOT a refusal', (t) => {
    // The functional flaw a realpath-everything rule would have introduced:
    // refusing here turns "the repo moved on" into a false absence claim
    // against a true finding.
    const rev = revisionBeforePlanExisted();
    if (!rev) { t.skip('history does not reach before this plan file existed (shallow clone?)'); return; }
    const h = resolveGitPath('docs/plans/role-agnostic-comparison-core.md', { repoRoot: REPO_ROOT, rev });
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
    // boundary with an arbitrary path. A module-private SYMBOL was tried next
    // and was ALSO forgeable — symbols on a returned object are enumerable via
    // Object.getOwnPropertySymbols, so a caller holding any real handle could
    // copy the brand onto a forged one. The real control is a module-private
    // WeakSet keyed on OBJECT IDENTITY, which cannot be copied or forged off
    // an existing handle — so this forgery, which mimics the visible shape
    // exactly, still fails (L3: this comment used to describe the symbol
    // design after the code had already moved to the WeakSet).
    const forged = Object.freeze({
      __resolved: true, kind: 'local', rel: '../../etc/passwd', abs: '/etc/passwd', rev: null,
    });
    assert.throws(() => assertHandle(forged),
      (e) => e.reason === 'not-a-handle',
      'a hand-built object carrying __resolved must NOT authenticate as a resolved path');
  });
});

describe('comparison/paths — absence vs lookup failure are different facts', () => {
  it('a genuinely absent blob reports absence, not a git failure', (t) => {
    const rev = revisionBeforePlanExisted();
    if (!rev) { t.skip('history does not reach before this plan file existed (shallow clone?)'); return; }
    const h = resolveGitPath('docs/plans/role-agnostic-comparison-core.md', { repoRoot: REPO_ROOT, rev });
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

  it('a GIT handle authenticates — the registry keys on identity, so it must be the returned object', (t) => {
    // The gap that let a real break through: every assertHandle test used a
    // LOCAL handle, so nothing noticed when resolveGitPath started registering
    // one object and returning a different one (spread + extra fields). The
    // module was rejecting its own output. Two DISTINCT revisions, because a
    // handle-identity bug could in principle be masked by a single-call path.
    const revs = ['HEAD', revisionBeforePlanExisted()].filter(Boolean);
    if (revs.length < 2) { t.skip('history does not reach a second distinct revision (shallow clone?)'); return; }
    for (const rev of revs) {
      const h = resolveGitPath('package.json', { repoRoot: REPO_ROOT, rev });
      assert.equal(assertHandle(h), h, `a git handle at ${rev} must authenticate`);
    }
  });
});
