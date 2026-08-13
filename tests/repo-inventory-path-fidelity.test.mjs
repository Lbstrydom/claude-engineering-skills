/**
 * Tier-1 test: the git inventory must record pathnames VERBATIM.
 *
 * `git ls-files` without `-z` quotes any path with non-ASCII or special
 * characters (`core.quotePath` defaults on), emitting `"src/caf\303\251.mjs"`
 * for `src/café.mjs` — so the inventory gains a path that does not exist and
 * loses the one that does. Splitting on `\n` and `.trim()`-ing each line
 * compounds it: a filename with leading/trailing whitespace is silently
 * rewritten, and one containing a newline is split into two phantom entries.
 *
 * This is load-bearing for two consumers that both treat inventory membership
 * as PROOF: `finding-verification.mjs` refutes a "file is missing" finding on
 * it, and (since the suffix-resolution change) `extractPlanPaths` decides from
 * it which files the audit reads at all. A mangled entry is a wrong answer in
 * both directions — a real file called absent, and an absent path called real.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { listRepoFiles } from '../scripts/lib/repo-inventory.mjs';

let repo;

/**
 * Create `name` and confirm GIT can actually track it.
 *
 * The filesystem check alone is the wrong guard, and measurably so: on Windows
 * `fs.writeFileSync` creates `trail.mjs ` and `readdir` reports it back
 * verbatim, but the Win32 API git uses cannot open that name — `git add` fails
 * with "No such file or directory" and the file never enters the index. A guard
 * that stopped at readdir therefore let the assertion run and fail for a reason
 * with nothing to do with the code under test. Tracking is the property this
 * test actually depends on, so that is what it verifies.
 */
function createGitTrackable(repoDir, relPath) {
  try {
    fs.writeFileSync(path.join(repoDir, relPath), 'x');
    execSync('git add -A', { cwd: repoDir, stdio: 'ignore' });
    const tracked = execSync('git ls-files -z', { cwd: repoDir, encoding: 'utf-8' }).split('\0');
    return tracked.includes(relPath.split(path.sep).join('/'));
  } catch {
    return false;
  }
}

describe('listRepoFiles — pathname fidelity', () => {
  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-fidelity-'));
    execSync('git init -q .', { cwd: repo, stdio: 'ignore' });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'plain.mjs'), 'y');
    fs.writeFileSync(path.join(repo, 'src', 'café.mjs'), 'x');
    execSync('git add -A', { cwd: repo, stdio: 'ignore' });
  });

  after(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('VACUOUS-PASS GUARD: the fixture repo really is being read', () => {
    const { files, inventorySource } = listRepoFiles({ baseDir: repo });
    assert.equal(inventorySource, 'git', 'must exercise the git path, not the fs-walk fallback');
    assert.ok(files.includes('src/plain.mjs'), `expected the plain file; got ${JSON.stringify(files)}`);
  });

  it('records a non-ASCII pathname verbatim, never git-quoted', () => {
    const { files } = listRepoFiles({ baseDir: repo });

    assert.ok(
      files.includes('src/café.mjs'),
      `inventory must carry the real path; got ${JSON.stringify(files)}`,
    );
    assert.equal(
      files.some((f) => f.includes('\\303') || f.startsWith('"')),
      false,
      'a git-quoted entry is a path that does not exist on disk',
    );
  });

  it('preserves a trailing space in a filename rather than trimming it', (t) => {
    // The space must be at the very END of the path — that is the only
    // position `.trim()` on a whole output line can reach. A mid-name space
    // (`trail .mjs`) is untouched by trimming and would pass vacuously.
    const name = 'trail.mjs ';
    if (!createGitTrackable(repo, path.join('src', name))) {
      t.skip('git cannot track a trailing-space pathname on this platform (Windows) — untestable here');
      return;
    }

    const { files } = listRepoFiles({ baseDir: repo });
    assert.ok(
      files.includes(`src/${name}`),
      `trimming rewrites the path to a file that does not exist; got ${JSON.stringify(files.filter((f) => f.includes('trail')))}`,
    );
  });
});
