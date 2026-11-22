/**
 * @fileoverview resolveDiffScope's working-tree mode (headRef null) must diff
 * against the REQUESTED base, not literal HEAD. With an older base (an explicit
 * `--base <merge-base>` over N commits + a dirty tree) the commits between base
 * and HEAD are part of the change; the old command saw only HEAD..worktree, so
 * the orphan wave analysed a smaller change than every other wave while its
 * preimages and base manifest were already taken at the older base.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveDiffScope } from '../scripts/lib/audit/diff-scope-resolver.mjs';
import { sh, writeFile, commitAll as commit, gitFixtureEnv } from './helpers/fixtures.mjs';

function newRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-base-'));
  sh(repo, 'init', '-q');
  sh(repo, 'config', 'user.email', 'test@example.com');
  sh(repo, 'config', 'user.name', 'Test');
  sh(repo, 'config', 'commit.gpgsign', 'false');
  writeFile(repo, 'package.json', JSON.stringify({ name: 'fixture', type: 'module' }));
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  return repo;
}
const cleanup = (repo) => fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
const paths = (scope) => scope.changedFiles.map((f) => f.headCallerPath || f.baseCallerPath).sort();

describe('resolveDiffScope — working-tree mode honours the requested base', () => {
  it('older base + dirty tree: a file changed in an intervening COMMIT is in scope, with the dirty file', async () => {
    const repo = newRepo();
    try {
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', env: gitFixtureEnv() }).trim();
      writeFile(repo, 'src/committed.mjs', 'export const a = 1;\n');
      commit(repo, 'a committed change after the base');
      writeFile(repo, 'src/dirty.mjs', 'export const b = 2;\n'); // untracked: the dirty part
      const scope = await resolveDiffScope({ repoPath: repo, env: gitFixtureEnv(), baseRef: base, headRef: null });
      assert.deepEqual(paths(scope), ['src/committed.mjs', 'src/dirty.mjs'], 'diffing against HEAD would drop src/committed.mjs');
    } finally { cleanup(repo); }
  });

  it('negative control: base == HEAD keeps the old behaviour (only the uncommitted change)', async () => {
    const repo = newRepo();
    try {
      writeFile(repo, 'src/committed.mjs', 'export const a = 1;\n');
      commit(repo, 'earlier commit');
      writeFile(repo, 'src/committed.mjs', 'export const a = 2;\n'); // tracked + modified
      const scope = await resolveDiffScope({ repoPath: repo, env: gitFixtureEnv(), baseRef: 'HEAD', headRef: null });
      assert.deepEqual(paths(scope), ['src/committed.mjs']);
    } finally { cleanup(repo); }
  });
});
