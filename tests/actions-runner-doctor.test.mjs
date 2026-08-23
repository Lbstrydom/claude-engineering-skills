/**
 * End-to-end argv-validation tests for `scripts/actions-runner-doctor.mjs`
 * (H2/M3, self-hosted-runner-management Cluster B code audit round 1).
 *
 * These only exercise paths that throw before any `gh`/`git` call, so they
 * run without `gh` installed/authenticated or network access — the
 * pure decision logic lives in scripts/lib/runner-fallback.mjs and is
 * covered directly in tests/runner-fallback.test.mjs; this file pins the
 * CLI wiring (argv -> exit code -> stderr message).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'actions-runner-doctor.mjs');

function run(...flags) {
  let status = 0; let stderr = ''; let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [CLI, ...flags], {
      cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
  } catch (err) {
    status = err.status;
    stderr = String(err.stderr || '');
    stdout = String(err.stdout || '');
  }
  return { status, stderr, stdout };
}

describe('actions-runner-doctor.mjs — --repo argv validation (H2/M3)', () => {
  it('rejects a present-but-empty --repo "" instead of falling through to git-remote resolution', () => {
    const { status, stderr } = run('--repo', '');
    assert.equal(status, 1);
    assert.match(stderr, /--repo requires a value/);
  });

  it('rejects --repo as the last argument (no value at all)', () => {
    const { status, stderr } = run('--repo');
    assert.equal(status, 1);
    assert.match(stderr, /--repo requires a value/);
  });

  it('rejects --repo immediately followed by another flag, and does not treat the flag as the value', () => {
    const { status, stderr } = run('--repo', '--json');
    assert.equal(status, 1);
    assert.match(stderr, /--repo requires a value/);
    assert.doesNotMatch(stderr, /"--json" is not a valid/, '--json must not be consumed as the --repo value');
  });

  it('rejects a --repo value with shell metacharacters rather than printing it into a recipe (M3)', () => {
    const { status, stderr } = run('--repo', 'octocat/hello-world; rm -rf ~');
    assert.equal(status, 1);
    assert.match(stderr, /not a valid GitHub owner\/repository slug/);
  });

  it('rejects a --repo value missing the owner/repo shape', () => {
    const { status, stderr } = run('--repo', 'not-a-slug');
    assert.equal(status, 1);
    assert.match(stderr, /not a valid GitHub owner\/repository slug/);
  });

  // The "valid --repo value passes validation" happy path is covered at the
  // lib level (tests/runner-fallback.test.mjs: resolveRepoSlugFromArg)
  // without touching this CLI's subsequent `gh api` calls, which need a
  // real `gh` install/auth and would otherwise make live network requests.
});
