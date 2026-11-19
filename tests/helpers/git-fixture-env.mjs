/**
 * @fileoverview One hermetic environment for tests that build a throwaway git repository: repository-local overrides the caller
 * may have exported (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...) are removed so `git -C <fixture>` can only ever touch the
 * fixture, and global config, template, signing and hooks are cut off. Plan: docs/plans/sashiko-audit-improvements.md §5.6.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_LOCAL = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM'];

/** @returns {{env: NodeJS.ProcessEnv, emptyDir: string, gitArgs: string[], cleanup: () => void}} */
export function makeGitFixtureEnv() {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-empty-'));
  const env = { ...process.env };
  for (const k of REPO_LOCAL) delete env[k];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(emptyDir, 'none'), GIT_TEMPLATE_DIR: emptyDir,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  });
  return {
    env, emptyDir,
    gitArgs: ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${emptyDir}`],
    cleanup: () => fs.rmSync(emptyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}
