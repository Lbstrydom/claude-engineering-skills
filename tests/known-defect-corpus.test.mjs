import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { loadCorpusCase, CorpusCaseUnavailable, CORPUS_LOADER_VERSION } from '../scripts/lib/model-eval/known-defect-corpus.mjs';
import { EgressGateError } from '../scripts/lib/model-eval/egress-path-scan.mjs';
import { gitFixtureEnv } from './helpers/fixtures.mjs';

const REPO_ROOT = process.cwd();
const REPO_NAME = path.basename(REPO_ROOT);

// A fixed, immutable, deliberately-tiny historical commit — NOT `git rev-parse
// HEAD`. HEAD's diff size varies with whatever was last committed (a large
// ship commit can exceed loadCorpusCase's own 200,000-char safety bound and
// make this fixture fail through no fault of the loader itself); a pinned
// single-file/single-line commit is stable forever regardless of future
// commit sizes. (chore(skills): regenerate ux-lock skill copies — 786-byte diff.)
const REAL_SHA = '61d99cc';

// Must match REAL_SHA's REAL changed-file list (round-1 audit M10's new
// declared-files-vs-diff cross-check would otherwise correctly reject this
// fixture as stale corpus metadata).
const REAL_CHANGED_FILES = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--name-only', `${REAL_SHA}^`, REAL_SHA], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

const baseKd = {
  id: 'KD-TEST-001',
  repo: REPO_NAME,
  buggyCommit: REAL_SHA,
  files: REAL_CHANGED_FILES,
  defectDesc: 'test defect description',
  expectedFindingRubric: 'test rubric',
  severity: 'HIGH',
};

describe('known-defect-corpus.mjs — loadCorpusCase', () => {
  test('exports CORPUS_LOADER_VERSION for run-evidence provenance', () => {
    assert.equal(typeof CORPUS_LOADER_VERSION, 'string');
    assert.ok(CORPUS_LOADER_VERSION.length > 0);
  });

  test('loads a real commit: visibleInput has diff text and a non-empty sorted file list', () => {
    const { visibleInput, hiddenGroundTruth } = loadCorpusCase({ kdEntry: baseKd, repoRoots: [REPO_ROOT] });
    assert.equal(typeof visibleInput.diff, 'string');
    assert.ok(visibleInput.diff.length > 0);
    assert.ok(Array.isArray(visibleInput.files));
    assert.ok(visibleInput.files.length > 0);
    const sorted = [...visibleInput.files].sort();
    assert.deepEqual(visibleInput.files, sorted);
  });

  test('hiddenGroundTruth carries exactly the KD entry fields, never leaking into visibleInput', () => {
    const { visibleInput, hiddenGroundTruth } = loadCorpusCase({ kdEntry: baseKd, repoRoots: [REPO_ROOT] });
    assert.deepEqual(hiddenGroundTruth, {
      files: baseKd.files,
      defectDesc: baseKd.defectDesc,
      expectedFindingRubric: baseKd.expectedFindingRubric,
      severity: baseKd.severity,
      kdId: baseKd.id,
    });
    assert.ok(!visibleInput.diff.includes(baseKd.defectDesc));
    assert.ok(!visibleInput.diff.includes(baseKd.expectedFindingRubric));
  });

  test('throws CorpusCaseUnavailable(repo_not_found) when no repoRoot basename matches', () => {
    assert.throws(
      () => loadCorpusCase({ kdEntry: { ...baseKd, repo: 'no-such-repo-anywhere' }, repoRoots: [REPO_ROOT] }),
      (err) => err instanceof CorpusCaseUnavailable && err.reason === 'repo_not_found',
    );
  });

  test('throws CorpusCaseUnavailable(commit_not_found) for a well-formed but nonexistent sha', () => {
    assert.throws(
      () => loadCorpusCase({ kdEntry: { ...baseKd, buggyCommit: '0000000000000000000000000000000000dead' }, repoRoots: [REPO_ROOT] }),
      (err) => err instanceof CorpusCaseUnavailable && err.reason === 'commit_not_found',
    );
  });

  test('repoRoots resolution tries every candidate root, not just the first', () => {
    const { visibleInput } = loadCorpusCase({ kdEntry: baseKd, repoRoots: ['/nonexistent/path/one', REPO_ROOT] });
    assert.ok(visibleInput.files.length > 0);
  });

  test('throws CorpusCaseUnavailable(declared_files_not_in_diff) when kdEntry.files does not match the real diff', () => {
    assert.throws(
      () => loadCorpusCase({ kdEntry: { ...baseKd, files: ['this/file/does/not/exist/in/the/diff.js'] }, repoRoots: [REPO_ROOT] }),
      (err) => err instanceof CorpusCaseUnavailable && err.reason === 'declared_files_not_in_diff',
    );
  });

  // Gemini final-review catch (2026-07-24): SAFE_KD_ID_RE.test() coerces its
  // argument to a string, so a malformed corpus entry with id === null or
  // undefined used to test() as "null"/"undefined" — both match
  // [A-Za-z0-9_-]+ — and slip past the guard instead of failing loudly.
  for (const badId of [null, undefined, 42, {}]) {
    test(`throws CorpusCaseUnavailable(invalid_kd_id) for a non-string id (${String(badId)})`, () => {
      assert.throws(
        () => loadCorpusCase({ kdEntry: { ...baseKd, id: badId }, repoRoots: [REPO_ROOT] }),
        (err) => err instanceof CorpusCaseUnavailable && err.reason === 'invalid_kd_id',
      );
    });
  }

  test('throws CorpusCaseUnavailable(invalid_kd_id) for an id containing unsafe characters', () => {
    assert.throws(
      () => loadCorpusCase({ kdEntry: { ...baseKd, id: '../../etc/passwd' }, repoRoots: [REPO_ROOT] }),
      (err) => err instanceof CorpusCaseUnavailable && err.reason === 'invalid_kd_id',
    );
  });
});

describe('known-defect-corpus.mjs — hardening (throwaway git repo)', () => {
  function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-corpus-'));
    // 2026-07-23: this is one of the two fixtures named in the original
    // GIT_WORK_TREE-rejection incident note — a leaked GIT_DIR/GIT_WORK_TREE
    // makes git ignore `cwd` entirely, so every commit below (including the
    // literal "initial" message) would land on the real repo without env:.
    const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitFixtureEnv() });
    g(['init', '-q']);
    g(['config', 'user.email', 'test@test.com']);
    g(['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'initial']);
    return { dir, g };
  }

  test('refuses (EgressGateError) a diff that touches a sensitive path', () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=abc123\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'add env']);
    const sha = g(['rev-parse', 'HEAD']).trim();
    const kd = { id: 'KD-SENSITIVE-001', repo: path.basename(dir), buggyCommit: sha, files: ['.env'], defectDesc: 'x', expectedFindingRubric: 'y', severity: 'HIGH' };
    assert.throws(() => loadCorpusCase({ kdEntry: kd, repoRoots: [dir], env: gitFixtureEnv() }), EgressGateError);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('pre-ship empirical verify regression — an uppercase-containing declared file path is NOT falsely rejected (parseDiffFile lowercases via normalizePath, kdEntry.files does not)', () => {
    const { dir, g } = makeRepo();
    const upperFile = 'sessions/20260703-182859Z__task.md';
    fs.mkdirSync(path.join(dir, 'sessions'));
    fs.writeFileSync(path.join(dir, upperFile), 'content\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'add uppercase-named file']);
    const sha = g(['rev-parse', 'HEAD']).trim();
    const kd = { id: 'KD-UPPER-001', repo: path.basename(dir), buggyCommit: sha, files: [upperFile], defectDesc: 'x', expectedFindingRubric: 'y', severity: 'LOW' };
    const { visibleInput } = loadCorpusCase({ kdEntry: kd, repoRoots: [dir], env: gitFixtureEnv() });
    assert.ok(visibleInput.files.length > 0);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});

describe('known-defect-corpus.mjs — linked-worktree identity', () => {
  // 2026-10-01 (experiment 7): run from `.claude/worktrees/<name>`, the cwd's
  // basename is the worktree name, so a basename-only match failed every KD
  // for the current repo with repo_not_found. A root's identity now includes
  // its MAIN checkout's basename (`--git-common-dir`).
  test('a linked worktree resolves a KD naming its MAIN checkout, and the worktree root is what is returned', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-wt-'));
    const mainDir = path.join(parent, 'kd-main-repo');
    const wtDir = path.join(parent, 'some-worktree-name');
    fs.mkdirSync(mainDir);
    const env = gitFixtureEnv();
    const g = (args, cwd = mainDir) => execFileSync('git', args, { cwd, encoding: 'utf8', env });
    try {
      g(['init', '-q']);
      g(['config', 'user.email', 'test@test.com']);
      g(['config', 'user.name', 'test']);
      fs.writeFileSync(path.join(mainDir, 'a.txt'), 'line1\n');
      g(['add', '.']);
      g(['commit', '-q', '-m', 'initial']);
      fs.writeFileSync(path.join(mainDir, 'a.txt'), 'line1\nline2\n');
      g(['commit', '-q', '-am', 'second']);
      const sha = g(['rev-parse', 'HEAD']).trim();
      g(['worktree', 'add', '-q', '--detach', wtDir, 'HEAD']);

      const kd = { id: 'KD-WT-001', repo: 'kd-main-repo', buggyCommit: sha, files: ['a.txt'], defectDesc: 'x', expectedFindingRubric: 'y', severity: 'LOW' };
      const { repoRoot, visibleInput } = loadCorpusCase({ kdEntry: kd, repoRoots: [wtDir], env });
      assert.equal(repoRoot, wtDir);
      assert.deepEqual(visibleInput.files, ['a.txt']);

      // Negative control: the worktree must not answer to a name that is
      // neither its own basename nor its main checkout's.
      assert.throws(
        () => loadCorpusCase({ kdEntry: { ...kd, repo: 'unrelated-repo' }, repoRoots: [wtDir], env }),
        (err) => err instanceof CorpusCaseUnavailable && err.reason === 'repo_not_found',
      );
    } finally {
      fs.rmSync(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
