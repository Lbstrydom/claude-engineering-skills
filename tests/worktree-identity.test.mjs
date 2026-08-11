/**
 * @fileoverview Tier 1 — deterministic module, test-first (testing doctrine).
 *
 * Plan: docs/plans/worktree-identity-guards.md §5.
 *
 * Every git call goes through an injected `run`, so these assert DECISION LOGIC
 * with zero subprocesses. The exit-status semantics are the point: a check that
 * cannot tell "no" from "I could not ask" turns a failed guard into a pass.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  resolveExpectedIdentity,
  verifyHeadIdentity,
  classifyStagedScope,
  resolveRangeSnapshot,
} from '../scripts/lib/worktree-identity.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** Build an injected runner from a map of joined-argv → result. */
function runner(map, { onMiss = 'throw' } = {}) {
  const calls = [];
  const fn = (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (Object.hasOwn(map, key)) return map[key];
    if (onMiss === 'throw') throw new Error(`unexpected git call: ${key}`);
    return { status: 1, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });

describe('resolveExpectedIdentity — the bundle is atomic', () => {
  test('complete attached flags resolve, source=flag', () => {
    const r = resolveExpectedIdentity({
      flags: { expectHead: SHA_A, expectBranch: 'main' }, evidence: null,
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'flag');
    assert.deepEqual(r.identity, { head: SHA_A, ref: { kind: 'attached', name: 'main' } });
  });

  test('complete detached flags resolve', () => {
    const r = resolveExpectedIdentity({
      flags: { expectHead: SHA_A, expectDetached: true }, evidence: null,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.identity.ref, { kind: 'detached' });
  });

  // R3-M1: a partial bundle must never degrade to a SHA-only check.
  test('head without a ref disposition is incomplete-expectation', () => {
    const r = resolveExpectedIdentity({ flags: { expectHead: SHA_A }, evidence: null });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'incomplete-expectation');
  });

  test('ref without a head is incomplete-expectation', () => {
    const r = resolveExpectedIdentity({ flags: { expectBranch: 'main' }, evidence: null });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'incomplete-expectation');
  });

  test('--expect-branch and --expect-detached are mutually exclusive', () => {
    const r = resolveExpectedIdentity({
      flags: { expectHead: SHA_A, expectBranch: 'main', expectDetached: true }, evidence: null,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'incomplete-expectation');
  });

  test('fresh evidence with both fields resolves, source=audit-evidence', () => {
    const r = resolveExpectedIdentity({
      flags: {},
      evidence: { state: 'fresh', auditedSha: SHA_A, auditedBranch: 'main' },
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'audit-evidence');
    assert.deepEqual(r.identity, { head: SHA_A, ref: { kind: 'attached', name: 'main' } });
  });

  // R3-M1 write/read symmetry: PRESENT-and-null means detached, which is a
  // COMPLETE bundle. `??` would collapse this into the legacy branch below.
  test('auditedBranch present and null means detached, not legacy', () => {
    const r = resolveExpectedIdentity({
      flags: {}, evidence: { state: 'fresh', auditedSha: SHA_A, auditedBranch: null },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.identity.ref, { kind: 'detached' });
  });

  test('auditedBranch ABSENT is pre-bundle-evidence, never a SHA-only pass', () => {
    const r = resolveExpectedIdentity({
      flags: {}, evidence: { state: 'fresh', auditedSha: SHA_A },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'pre-bundle-evidence');
  });

  test('no flags and no evidence is no-expectation (H1 — absence must not pass)', () => {
    const r = resolveExpectedIdentity({ flags: {}, evidence: null });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-expectation');
  });

  test('stale evidence does not supply an expectation', () => {
    const r = resolveExpectedIdentity({
      flags: {}, evidence: { state: 'stale', auditedSha: SHA_A, auditedBranch: 'main' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-expectation');
  });

  test('flags win over evidence', () => {
    const r = resolveExpectedIdentity({
      flags: { expectHead: SHA_B, expectBranch: 'feature' },
      evidence: { state: 'fresh', auditedSha: SHA_A, auditedBranch: 'main' },
    });
    assert.equal(r.source, 'flag');
    assert.equal(r.identity.head, SHA_B);
  });

  test('a malformed head sha is rejected before it reaches a git argv', () => {
    const r = resolveExpectedIdentity({
      flags: { expectHead: '--upload-pack=evil', expectBranch: 'main' }, evidence: null,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'incomplete-expectation');
  });
});

describe('verifyHeadIdentity', () => {
  const attached = { head: SHA_A, ref: { kind: 'attached', name: 'main' } };

  test('matching head and branch verify', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD': ok(`${SHA_A}\n`),
      'symbolic-ref --quiet --short HEAD': ok('main\n'),
    });
    assert.equal(verifyHeadIdentity(attached, { run }).ok, true);
  });

  test('a moved head is head-moved', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD': ok(`${SHA_B}\n`),
      'symbolic-ref --quiet --short HEAD': ok('main\n'),
    });
    const r = verifyHeadIdentity(attached, { run });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'head-moved');
  });

  // THE field-incident case: two refs at the same commit. A SHA-only check
  // passes here and the commit lands on the wrong branch.
  test('same sha, different branch is ref-moved', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD': ok(`${SHA_A}\n`),
      'symbolic-ref --quiet --short HEAD': ok('feature\n'),
    });
    const r = verifyHeadIdentity(attached, { run });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ref-moved');
  });

  test('expected attached but actually detached is ref-moved', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD': ok(`${SHA_A}\n`),
      'symbolic-ref --quiet --short HEAD': { status: 1, stdout: '', stderr: '' },
    });
    const r = verifyHeadIdentity(attached, { run });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ref-moved');
  });

  test('detached expectation matches a detached checkout', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD': ok(`${SHA_A}\n`),
      'symbolic-ref --quiet --short HEAD': { status: 1, stdout: '', stderr: '' },
    });
    const r = verifyHeadIdentity({ head: SHA_A, ref: { kind: 'detached' } }, { run });
    assert.equal(r.ok, true);
  });

  test('unresolvable HEAD is unborn-head, not a pass', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD': { status: 1, stdout: '', stderr: '' },
    });
    const r = verifyHeadIdentity(attached, { run });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unborn-head');
  });

  test('a git execution failure is git-exec-failed, never a verdict', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD': { status: 128, stdout: '', stderr: 'fatal: not a git repository' },
    });
    const r = verifyHeadIdentity(attached, { run });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'git-exec-failed');
  });

  test('a spawn error is git-exec-failed', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD': { status: null, stdout: '', stderr: '', error: new Error('ENOENT') },
    });
    assert.equal(verifyHeadIdentity(attached, { run }).reason, 'git-exec-failed');
  });
});

describe('classifyStagedScope', () => {
  const REPO = path.resolve('/repo');
  // Key the mock on paths resolved EXACTLY as the module resolves them.
  // A string-replace on '/repo/' silently missed on Windows, where
  // path.resolve('/repo','sub') is drive-prefixed — the mock reported ENOENT
  // for every path and the directory case fell through to the absent branch.
  const fsOk = (kinds) => {
    const byAbs = new Map(
      Object.entries(kinds).map(([rel, kind]) => [path.resolve(REPO, rel), kind]),
    );
    return {
      lstatSync(abs) {
        const key = path.resolve(abs);
        if (!byAbs.has(key)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return { isDirectory: () => byAbs.get(key) === 'dir' };
      },
    };
  };

  test('no paths with a non-empty index is unscoped-index (guard A, fail-closed)', () => {
    const run = runner({ 'diff --cached --name-only': ok('theirs.txt\n') });
    const r = classifyStagedScope({ paths: [], repoRoot: REPO, run, fsMod: fsOk({}) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unscoped-index');
    assert.deepEqual(r.staged, ['theirs.txt']);
  });

  test('no paths with an empty index is nothing-staged', () => {
    const run = runner({ 'diff --cached --name-only': ok('') });
    const r = classifyStagedScope({ paths: [], repoRoot: REPO, run, fsMod: fsOk({}) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'nothing-staged');
  });

  test('literal files normalise and pass', () => {
    const run = runner({ 'ls-files --error-unmatch -- a.txt': ok('a.txt\n') });
    const r = classifyStagedScope({
      paths: ['a.txt'], repoRoot: REPO, run, fsMod: fsOk({ 'a.txt': 'file' }),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.rels, ['a.txt']);
    assert.equal(r.mode, 'pathspec');
  });

  test('an EXISTING directory is refused (M2 — measured silent widening)', () => {
    const run = runner({}, { onMiss: 'quiet' });
    const r = classifyStagedScope({
      paths: ['sub'], repoRoot: REPO, run, fsMod: fsOk({ sub: 'dir' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'path-is-directory');
    assert.deepEqual(r.offending, ['sub']);
  });

  // Final gate round 3: lstat throws ENOENT for a deleted directory, and
  // `cat-file -e` exits 0 for a TREE. Only `-t` + blob-only closes it.
  test('a DELETED directory is refused via cat-file -t returning tree', () => {
    const run = runner({
      'ls-files --error-unmatch -- sub': { status: 1, stdout: '', stderr: '' },
      'cat-file -t HEAD:sub': ok('tree\n'),
    });
    const r = classifyStagedScope({ paths: ['sub'], repoRoot: REPO, run, fsMod: fsOk({}) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'path-is-directory');
  });

  test('a DELETED file is a legitimate deletion (cat-file -t returns blob)', () => {
    const run = runner({
      'ls-files --error-unmatch -- gone.txt': { status: 1, stdout: '', stderr: '' },
      'cat-file -t HEAD:gone.txt': ok('blob\n'),
    });
    const r = classifyStagedScope({ paths: ['gone.txt'], repoRoot: REPO, run, fsMod: fsOk({}) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.rels, ['gone.txt']);
  });

  test('an absent, untracked path is path-untracked-absent', () => {
    const run = runner({
      'ls-files --error-unmatch -- nope.txt': { status: 1, stdout: '', stderr: '' },
      'cat-file -t HEAD:nope.txt': { status: 128, stdout: '', stderr: 'fatal: Not a valid object name' },
    });
    const r = classifyStagedScope({ paths: ['nope.txt'], repoRoot: REPO, run, fsMod: fsOk({}) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'path-untracked-absent');
  });

  test('a path escaping the repo is refused', () => {
    const run = runner({}, { onMiss: 'quiet' });
    const r = classifyStagedScope({
      paths: ['../outside.txt'], repoRoot: REPO, run, fsMod: fsOk({}),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'path-escapes-repo');
  });

  test('duplicate paths collapse', () => {
    const run = runner({ 'ls-files --error-unmatch -- a.txt': ok('a.txt\n') });
    const r = classifyStagedScope({
      paths: ['a.txt', 'a.txt'], repoRoot: REPO, run, fsMod: fsOk({ 'a.txt': 'file' }),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.rels, ['a.txt']);
  });

  test('an index read failure is git-exec-failed, not an empty index', () => {
    const run = runner({
      'diff --cached --name-only': { status: 128, stdout: '', stderr: 'fatal: bad' },
    });
    const r = classifyStagedScope({ paths: [], repoRoot: REPO, run, fsMod: fsOk({}) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'git-exec-failed');
  });
});

describe('resolveRangeSnapshot', () => {
  test('HEAD is resolved FIRST, and an inferred dirty base equals it', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD^{commit}': ok(`${SHA_A}\n`),
    });
    const r = resolveRangeSnapshot({ explicitBase: null, workingTreeDirty: true, run });
    assert.equal(r.ok, true);
    assert.equal(r.headSha, SHA_A);
    assert.equal(r.baseSha, SHA_A);
    assert.equal(r.relation, 'identical');
    // The ordering is the guarantee: HEAD before base, and the inferred base is
    // DERIVED from the resolved headSha rather than re-read as a second `HEAD`.
    assert.equal(run.calls[0], 'rev-parse --verify --quiet HEAD^{commit}');
  });

  test('an inferred clean base is HEAD~1 derived from the resolved head', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD^{commit}': ok(`${SHA_A}\n`),
      [`rev-parse --verify --quiet ${SHA_A}^^{commit}`]: ok(`${SHA_B}\n`),
    });
    const r = resolveRangeSnapshot({ explicitBase: null, workingTreeDirty: false, run });
    assert.equal(r.ok, true);
    assert.equal(r.baseSha, SHA_B);
    assert.equal(r.relation, 'ancestor');
  });

  test('an explicit ancestor base resolves to OIDs', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD^{commit}': ok(`${SHA_A}\n`),
      'rev-parse --verify --quiet topic^{commit}': ok(`${SHA_B}\n`),
      [`merge-base --is-ancestor ${SHA_B} ${SHA_A}`]: ok(''),
    });
    const r = resolveRangeSnapshot({ explicitBase: 'topic', workingTreeDirty: true, run });
    assert.equal(r.ok, true);
    assert.equal(r.baseSha, SHA_B);
    assert.equal(r.headSha, SHA_A);
    assert.equal(r.relation, 'ancestor');
  });

  test('an unresolvable explicit base fails hard, never demotes to inference', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD^{commit}': ok(`${SHA_A}\n`),
      'rev-parse --verify --quiet nope^{commit}': { status: 1, stdout: '', stderr: '' },
    });
    const r = resolveRangeSnapshot({ explicitBase: 'nope', workingTreeDirty: false, run });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unresolvable-explicit');
  });

  test('a non-ancestor base is not-an-ancestor (incident 3 shape)', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD^{commit}': ok(`${SHA_A}\n`),
      'rev-parse --verify --quiet other^{commit}': ok(`${SHA_B}\n`),
      [`merge-base --is-ancestor ${SHA_B} ${SHA_A}`]: { status: 1, stdout: '', stderr: '' },
    });
    const r = resolveRangeSnapshot({ explicitBase: 'other', workingTreeDirty: false, run });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-an-ancestor');
  });

  // THE exit-status trap: `--is-ancestor` signals a negative answer with exit 1
  // AND an execution failure with a non-zero status. Conflating them is how
  // "I could not check" becomes "the check passed".
  test('exit 1 WITH stderr is git-exec-failed, not a negative answer', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD^{commit}': ok(`${SHA_A}\n`),
      'rev-parse --verify --quiet other^{commit}': ok(`${SHA_B}\n`),
      [`merge-base --is-ancestor ${SHA_B} ${SHA_A}`]: { status: 1, stdout: '', stderr: 'fatal: bad object' },
    });
    const r = resolveRangeSnapshot({ explicitBase: 'other', workingTreeDirty: false, run });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'git-exec-failed');
  });

  test('any other non-zero status is git-exec-failed', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD^{commit}': ok(`${SHA_A}\n`),
      'rev-parse --verify --quiet other^{commit}': ok(`${SHA_B}\n`),
      [`merge-base --is-ancestor ${SHA_B} ${SHA_A}`]: { status: 128, stdout: '', stderr: '' },
    });
    assert.equal(resolveRangeSnapshot({ explicitBase: 'other', workingTreeDirty: false, run }).reason, 'git-exec-failed');
  });

  test('an unresolvable HEAD is a command error, not an ancestry verdict', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD^{commit}': { status: 1, stdout: '', stderr: '' },
    });
    const r = resolveRangeSnapshot({ explicitBase: null, workingTreeDirty: false, run });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'head-unresolvable');
  });

  test('a malformed explicit base never reaches a git argv', () => {
    const run = runner({
      'rev-parse --verify --quiet HEAD^{commit}': ok(`${SHA_A}\n`),
    }, { onMiss: 'throw' });
    const r = resolveRangeSnapshot({ explicitBase: '--upload-pack=evil', workingTreeDirty: false, run });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-explicit');
  });
});

describe('the git object-id contract is defined ONCE (M11)', () => {
  test('commit-trailers TREE_ID_RE IS the oracle GIT_OBJECT_ID_RE', async () => {
    const [{ GIT_OBJECT_ID_RE, isGitObjectId }, ct] = await Promise.all([
      import('../scripts/lib/worktree-identity.mjs'),
      import('../scripts/lib/commit-trailers.mjs'),
    ]);
    assert.equal(ct.TREE_ID_RE, GIT_OBJECT_ID_RE,
      'the reader and the identity oracle must not carry independent copies');
    assert.equal(isGitObjectId(SHA_A), true);
    assert.equal(isGitObjectId('abc'), false);
    assert.equal(isGitObjectId(null), false);
  });
});
