/**
 * @fileoverview `validatePlanPath` must resolve containment against the REPO
 * ROOT, not the process's current directory.
 *
 * ## The defect (debt 0fd6bf8f)
 *
 * `validatePlanPath` accepted `opts.repoRoot` but every caller omitted it, so
 * the root defaulted to `process.cwd()`. Run any plan-recording command from a
 * subdirectory and a valid ABSOLUTE in-repo plan path resolves outside that
 * cwd, so the containment check rejects it as `escapes-repo` — a correct path
 * refused for being typed from the wrong directory.
 *
 * Raised by the consolidated Gemini gate (G1) and, independently, by GPT as the
 * filesystem-root edge of the same check (Cluster C L2). Reproduced 2026-08-09
 * from `scripts/` before any fix was written.
 *
 * ## Why the fix is the DEFAULT, not a threaded parameter
 *
 * Four callers across three modules reach this. Threading `repoRoot` through
 * them leaves the function correct and the system unchanged until every caller
 * is updated — a fix that looks done and does nothing. Correcting the default
 * fixes all four at once; the explicit override stays for callers that know
 * better.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { validatePlanPath } from '../scripts/lib/store/plans-ship.mjs';
import { findRepoRootFromCwd, _resetRepoRootCache } from '../scripts/lib/assert-repo-root.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PLAN_ABS = path.join(REPO_ROOT, 'docs', 'plans', 'requirements-layer.md');
const PLAN_REL = 'docs/plans/requirements-layer.md';

const originalCwd = process.cwd();
afterEach(() => {
  process.chdir(originalCwd);
  _resetRepoRootCache();
});

describe('validatePlanPath — containment is repo-relative, not cwd-relative', () => {
  it('accepts an absolute in-repo plan path from the repo root', () => {
    process.chdir(REPO_ROOT);
    assert.deepEqual(validatePlanPath(PLAN_ABS), { ok: true, path: PLAN_REL });
  });

  // THE regression. Before the fix this returned {ok:false, reason:'escapes-repo'}
  // for a path that is plainly inside the repo.
  it('accepts the SAME path when invoked from a subdirectory', () => {
    process.chdir(path.join(REPO_ROOT, 'scripts'));
    _resetRepoRootCache();
    const r = validatePlanPath(PLAN_ABS);
    assert.equal(
      r.ok, true,
      'a valid in-repo plan path must not be refused for being typed from a subdirectory',
    );
    assert.equal(r.path, PLAN_REL, 'and it must normalise to the same repo-relative path');
  });

  it('normalises to an identical repo-relative path from any cwd (idempotence)', () => {
    // `plans` is unique on (repo_id, path); two spellings of one plan would
    // INSERT twice instead of updating once. That is why the normalised form
    // must not depend on where the command ran.
    process.chdir(REPO_ROOT);
    const fromRoot = validatePlanPath(PLAN_ABS);
    process.chdir(path.join(REPO_ROOT, 'scripts', 'lib'));
    _resetRepoRootCache();
    const fromDeep = validatePlanPath(PLAN_ABS);
    assert.deepEqual(fromDeep, fromRoot);
  });

  it('a differently-cased repoRoot yields the SAME identifier, not a traversal key', () => {
    // Audit CE-r2-M6. On a case-INSENSITIVE platform (win32, darwin) the
    // containment check folds case, so a root spelled `/Users/foo/repo` admits
    // an abs path under `/Users/Foo/repo`. `path.relative` does NOT fold case on
    // POSIX — darwin included — so it answered `../../Foo/repo/docs/...`: a
    // traversal-shaped string that passes containment and is then stored as
    // `plans.path` and used as the `getPlanIdByPath` key. Two spellings, two
    // rows, on a unique index that was supposed to prevent exactly that.
    //
    // **THIS ASSERTION CANNOT FAIL ON WIN32, AND THAT WAS MEASURED, NOT
    // ASSUMED.** Negative-controlled 2026-08-12 by reverting the fix: it still
    // passed. Node's win32 `path.relative` folds case itself, so the two halves
    // agreed here by accident of the platform implementation; on darwin
    // `path.relative` is the POSIX one and does not fold, which is the only
    // place the defect is reachable. So on Windows this is a statement of the
    // invariant, not evidence for it — the evidence has to come from a darwin
    // run. Recorded rather than deleted: the invariant is real, and a reader
    // who sees it green here must not read that as coverage.
    //
    // Skipped on case-sensitive platforms, where the two roots really are
    // different directories and refusal is correct.
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    const swapped = REPO_ROOT.replace(/([a-z])/, (c) => c.toUpperCase())
      .replace(/([A-Z])(?![a-zA-Z]*$)/, (c) => c.toLowerCase());
    assert.notEqual(swapped, REPO_ROOT, 'the probe must actually differ in case, or this asserts nothing');
    const r = validatePlanPath(PLAN_ABS, { repoRoot: swapped });
    assert.equal(r.ok, true, 'a case-variant root must still be admitted (that is what `ci` is for)');
    assert.equal(r.path, PLAN_REL,
      'the identifier must be derived by the same comparison that admitted the path');
    assert.ok(!r.path.startsWith('..'), 'a traversal-shaped identifier must never be stored');
  });

  it('an explicit repoRoot still wins over the resolved default', () => {
    process.chdir(path.join(REPO_ROOT, 'scripts'));
    _resetRepoRootCache();
    assert.deepEqual(
      validatePlanPath(PLAN_ABS, { repoRoot: REPO_ROOT }),
      { ok: true, path: PLAN_REL },
    );
  });

  // The guard must still REFUSE what it was built to refuse. Without these the
  // fix could have been "accept everything", which also makes the test above
  // pass.
  it('still refuses a path genuinely outside the repo', () => {
    process.chdir(REPO_ROOT);
    const outside = path.join(path.dirname(REPO_ROOT), 'not-this-repo', 'plan.md');
    const r = validatePlanPath(outside);
    assert.equal(r.ok, false, 'containment must still be enforced — the fix widens the ROOT, not the rule');
    assert.equal(r.reason, 'escapes-repo');
  });

  it('still refuses a flag-like path, a non-markdown path, and an empty path', () => {
    process.chdir(REPO_ROOT);
    assert.equal(validatePlanPath('--help').reason, 'flag-like');
    assert.equal(validatePlanPath('docs/plans/notes.txt').reason, 'not-markdown');
    assert.equal(validatePlanPath('   ').reason, 'empty');
  });

  it('still refuses the repo root itself', () => {
    process.chdir(REPO_ROOT);
    assert.equal(validatePlanPath(`${REPO_ROOT}/`).ok, false);
  });
});

describe('findRepoRootFromCwd — the resolver behind the default', () => {
  it('returns the same root from the repo root and from a subdirectory', () => {
    process.chdir(REPO_ROOT);
    const a = findRepoRootFromCwd();
    process.chdir(path.join(REPO_ROOT, 'scripts'));
    _resetRepoRootCache();
    const b = findRepoRootFromCwd();
    assert.equal(path.resolve(a), path.resolve(b));
    assert.equal(path.resolve(a), path.resolve(REPO_ROOT));
  });

  // Vacuous-pass guard: prove the two directories genuinely differ, or the
  // assertion above holds for free.
  it('the two probe directories are actually different', () => {
    assert.notEqual(REPO_ROOT, path.join(REPO_ROOT, 'scripts'));
  });

  it('falls back to the given directory outside a git checkout', () => {
    // os.tmpdir() is not a git repo; the resolver must degrade rather than
    // throw, because a tarball install has no .git and must still work.
    const tmp = path.resolve(process.env.TEMP || process.env.TMPDIR || '/tmp');
    _resetRepoRootCache();
    const r = findRepoRootFromCwd(tmp);
    assert.equal(typeof r, 'string');
    assert.ok(r.length > 0, 'a non-git directory must yield a usable root, not an empty string');
  });

  it('memoises per directory (the resolver spawns git; a plan write must not pay it repeatedly)', () => {
    _resetRepoRootCache();
    const first = findRepoRootFromCwd(REPO_ROOT);
    const second = findRepoRootFromCwd(REPO_ROOT);
    assert.equal(first, second);
  });
});
