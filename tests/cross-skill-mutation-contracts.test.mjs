/**
 * @fileoverview Mutation-contract fixes C1–C5.
 *
 * C1 is covered by the four `resolveRepoScope` variants against a stub (no DB);
 * C2/C3/C5 by their extracted helpers, including a real symlink fixture. Source-level
 * assertions appear only as a belt-and-braces anti-bypass check — the plan is explicit
 * that they are not the coverage.
 *
 * Plan: docs/plans/layering-and-mutation-contracts.md (§9).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isPathContained, classifyTestPath, classifyReadPath } from '../scripts/lib/path-validation.mjs';
import { validateCriteriaCount, validateCountFields } from '../scripts/lib/command-input.mjs';
import { resolveRepoScope } from '../scripts/lib/repo-scope.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function mkTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

// ── C2: containment ─────────────────────────────────────────────────────────

test('C2: a sibling directory sharing the root prefix is NOT contained', () => {
  // The demonstrated bug: `path.resolve('/repo','../repo-evil/x')` startsWith
  // `path.resolve('/repo')` === true. The separator is what fixes it.
  const root = path.resolve('/repo');
  assert.equal(isPathContained(root, path.resolve(root, '../repo-evil/x')), false);
  assert.equal(isPathContained(root, path.join(root, 'sub', 'file.mjs')), true);
  assert.equal(isPathContained(root, root), true, 'the root itself is contained');
});

test('C2: classifyReadPath refuses a symlink escaping the repo', () => {
  const repo = mkTmp('ces-c2-repo-');
  const outside = mkTmp('ces-c2-out-');
  try {
    const secret = path.join(outside, 'id_rsa');
    fs.writeFileSync(secret, 'PRIVATE KEY');
    const link = path.join(repo, 'innocent.txt');
    try { fs.symlinkSync(secret, link); }
    catch { return; }   // unprivileged Windows cannot symlink — skip rather than false-pass

    const v = classifyReadPath({ repoRoot: repo, candidate: 'innocent.txt' });
    assert.equal(v.ok, false, 'a symlink to a file outside the repo must not be readable');
    assert.equal(v.reason, 'path-escapes-repo');
  } finally { rmTmp(repo); rmTmp(outside); }
});

test('C2: an ordinary in-repo file is still readable', () => {
  const repo = mkTmp('ces-c2-ok-');
  try {
    fs.writeFileSync(path.join(repo, 'a.mjs'), 'x');
    const v = classifyReadPath({ repoRoot: repo, candidate: 'a.mjs' });
    assert.equal(v.ok, true, 'the fix must not refuse everything — that would also "pass"');
  } finally { rmTmp(repo); }
});

// ── C3: lock-with-test path policy (one case per row of the plan's table) ───

test('C3: a directory is rejected — existsSync alone accepted these', () => {
  const repo = mkTmp('ces-c3-dir-');
  try {
    fs.mkdirSync(path.join(repo, 'tests'));
    const v = classifyTestPath({ repoRoot: repo, testPath: 'tests' });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'not-a-file');
  } finally { rmTmp(repo); }
});

test('C3: a missing file is rejected', () => {
  const repo = mkTmp('ces-c3-missing-');
  try {
    const v = classifyTestPath({ repoRoot: repo, testPath: 'tests/nope.test.mjs' });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'test-file-not-found');
  } finally { rmTmp(repo); }
});

test('C3: a genuine in-repo test file is accepted', () => {
  const repo = mkTmp('ces-c3-ok-');
  try {
    fs.mkdirSync(path.join(repo, 'tests'));
    fs.writeFileSync(path.join(repo, 'tests', 'a.test.mjs'), 'x');
    const v = classifyTestPath({ repoRoot: repo, testPath: 'tests/a.test.mjs' });
    assert.equal(v.ok, true);
  } finally { rmTmp(repo); }
});

test('C3: a path escaping via ".." is rejected', () => {
  const repo = mkTmp('ces-c3-esc-');
  try {
    const v = classifyTestPath({ repoRoot: repo, testPath: '../outside.test.mjs' });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'path-escapes-repo');
  } finally { rmTmp(repo); }
});

// ── C5: numeric contract ────────────────────────────────────────────────────

test('C5: NaN, negative, fractional and infinite counts are rejected', () => {
  for (const bad of [NaN, -1, 1.5, Infinity, -Infinity, '3', null, undefined]) {
    assert.equal(validateCriteriaCount(bad).ok, false, `${String(bad)} must be rejected`);
  }
});

test('C5: zero is valid — a plan with no parseable criteria is a real state', () => {
  assert.equal(validateCriteriaCount(0).ok, true);
  assert.equal(validateCriteriaCount(42).ok, true);
});

test('C5: a bad PEER field is rejected, not just totalCriteria', () => {
  // Guarding one field while its peers accept NaN through the same handler fixes the
  // example, not the defect — and a NaN peer is worse, because a percentage derived
  // from it renders as a plausible number.
  const r = validateCountFields({ totalCriteria: 10, passedCriteria: NaN });
  assert.equal(r.ok, false);
  assert.match(r.reason, /passedCriteria/);
});

test('C5: parts may not exceed the whole', () => {
  assert.equal(validateCountFields({ totalCriteria: 3, passedCriteria: 2, failedCriteria: 2 }).ok, false);
  assert.equal(validateCountFields({ totalCriteria: 4, passedCriteria: 2, failedCriteria: 2 }).ok, true);
});

test('C5: absent optional fields do not synthesise a failure', () => {
  assert.equal(validateCountFields({ totalCriteria: 5 }).ok, true);
});

// ── C1: the four repo-scope variants, against a stub (no DB) ────────────────

test('C1 scoped: a resolvable uuid translates to the v4 repoId', async () => {
  const r = await resolveRepoScope({
    resolveRepoUuid: async () => 'uuid-v5',
    getRepoIdByUuid: async (u) => (u === 'uuid-v5' ? 'id-v4' : null),
  });
  assert.deepEqual(r, { kind: 'scoped', repoId: 'id-v4' });
});

// The REAL `getRepoIdByUuid` returns the audit_repos ROW, not a bare id. The
// stub above returns a string the implementation never produces, so it passed
// while `scope.repoId` was an OBJECT in production — callers bound it into
// `WHERE repo_id = $1` and Postgres rejected it:
//   invalid input syntax for type uuid: "{"id":"22865de8-…","name":"…"}"
// which killed `persona-outcomes summary` and /ship's Step 0.5a UX gate.
// Pin the real shape so the fixture cannot be more generous than reality again.
test('C1 scoped: unwraps the audit_repos ROW the real resolver returns', async () => {
  const r = await resolveRepoScope({
    resolveRepoUuid: async () => 'uuid-v5',
    getRepoIdByUuid: async () => ({
      id: '22865de8-3b15-484e-83c2-e1cb59c7ce41',
      name: 'Lbstrydom/wine-cellar-app',
      repo_uuid: 'uuid-v5',
      activeRefreshId: '327a1ca8-95a4-41b1-ad43-c974969a726d',
      activeEmbeddingModel: 'gemini-embedding-001',
      activeEmbeddingDim: 768,
    }),
  });
  assert.deepEqual(r, { kind: 'scoped', repoId: '22865de8-3b15-484e-83c2-e1cb59c7ce41' });
  assert.equal(typeof r.repoId, 'string', 'repoId must be bindable as a uuid, never the row object');
});

test('C1 scoped: a row without an id is unknown-repo, not a null-bound query', async () => {
  const r = await resolveRepoScope({
    resolveRepoUuid: async () => 'uuid-v5',
    getRepoIdByUuid: async () => ({ name: 'no-id-row' }),
  });
  assert.equal(r.kind, 'unknown-repo');
});

test('C1 no-identity: outside a checkout the caller proceeds unscoped, as before', async () => {
  const r = await resolveRepoScope({
    resolveRepoUuid: async () => null,
    getRepoIdByUuid: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(r, { kind: 'no-identity' });
});

test('C1 unknown-repo: a uuid with no row is NOT a clean empty result', async () => {
  // This is the believable false zero: the old code queried on the uuid, matched
  // nothing, and reported an authoritative 0 for a repo it never queried.
  const r = await resolveRepoScope({
    resolveRepoUuid: async () => 'uuid-v5',
    getRepoIdByUuid: async () => null,
  });
  assert.equal(r.kind, 'unknown-repo');
  assert.equal(r.repoUuid, 'uuid-v5');
});

test('C1 lookup-failed: a transient error fails closed, never unscoped', async () => {
  const r = await resolveRepoScope({
    resolveRepoUuid: async () => 'uuid-v5',
    getRepoIdByUuid: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(r.kind, 'lookup-failed');
  assert.match(r.error, /ECONNRESET/);
});

test('C1: an explicit repoId is authoritative and skips translation', async () => {
  const r = await resolveRepoScope({
    explicitRepoId: 'id-v4-explicit',
    resolveRepoUuid: async () => { throw new Error('must not be called'); },
    getRepoIdByUuid: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(r, { kind: 'scoped', repoId: 'id-v4-explicit' });
});

// ── Anti-bypass (belt and braces — NOT the coverage) ────────────────────────

test('no call site reintroduces the uuid-as-repoId confusion', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'cross-skill.mjs'), 'utf-8');
  const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  assert.ok(!/repoId\s*=\s*argOption\('repo-id'\)\s*\|\|\s*\(await resolveRepoUuidQuiet\(\)\)/.test(code),
    'binding the ambient UUID straight to a repoId variable is the original bug');
  assert.ok(!/resolveRepoIdentityQuiet/.test(code), 'the misleading name must not return');
});

test('C4: updatePlanStatus carries repo_id as a SQL predicate', () => {
  // RETARGETED (command-registry Cluster E): the plans domain moved out of
  // plans-ship.mjs, now a re-export barrel with no SQL in it.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'lib', 'store', 'plans.mjs'), 'utf-8');
  assert.match(src, /\{ id: planId, repo_id: repoId \}/,
    'tenant scope must be in the WHERE clause, not merely resolved in the CLI');
  assert.match(src, /updatePlanStatus\(\{ repoId, planId, status \}\)/);
});

test('C2: drive-letter case does not falsely reject on Windows', () => {
  // `path.resolve` preserves the drive-letter case it is given, so `c:\repo` vs
  // `C:\repo` compared unequal and rejected a genuinely contained path. Only a
  // Windows concern — on a case-sensitive filesystem those are different paths.
  if (process.platform !== 'win32') return;
  assert.equal(isPathContained('c:/repo', 'C:/repo/sub/a.mjs'), true);
  assert.equal(isPathContained('C:/repo', 'c:/repo/sub/a.mjs'), true);
  assert.equal(isPathContained('C:/repo', 'C:/repo-evil/a.mjs'), false,
    'case-folding must not weaken the boundary check');
});
