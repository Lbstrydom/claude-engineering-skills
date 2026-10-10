/**
 * @fileoverview This repo's pre-push hook (`.githooks/pre-push`) publishes to consumer repos
 * ONLY when the push updates the default branch.
 *
 * THE DEFECT (2026-10-10). Step 2 ran `scripts/sync-to-repos.mjs` on every push. That was
 * right under the old main-only workflow, where every push was main; since branches + PRs
 * (2026-09-25) every feature-branch push copied UNMERGED tooling into every consumer. On
 * 2026-10-10 an agent's push of a branch whose PR was still under review synced it into all
 * three consumers ("Created 3, Updated 27").
 *
 * WHY BEHAVIOURAL. Each case runs the real hook against a fixture repo whose
 * `scripts/sync-to-repos.mjs` is a stub that leaves a marker, so the case observes whether
 * the sync RAN, not the spelling of the guard. Both directions are pinned: a branch push must
 * not sync, and a default-branch push (alone or within a multi-ref push) must.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { hasBash, git } from './lib/hook-test-helpers.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const HOOK = path.join(REPO_ROOT, '.githooks', 'pre-push');
const HAS_BASH = hasBash();
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const SYNC_MARKER = 'sync-ran.marker';

function withFixture(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-consumer-sync-'));
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    git(['init', '-q', '-b', 'main', repo]);
    git(['config', 'user.email', 'fixture@example.invalid'], repo);
    git(['config', 'user.name', 'Fixture'], repo);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture","private":true}\n');
    for (const stub of ['prepush-check.mjs', 'check-stale-skill-surface.mjs', 'harvest-audit-transcripts.mjs']) {
      fs.writeFileSync(path.join(repo, 'scripts', stub), 'process.exit(0);\n');
    }
    fs.writeFileSync(path.join(repo, 'scripts', 'sync-to-repos.mjs'),
      `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(SYNC_MARKER)}, 'ran');\n`);
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'seed'], repo);
    const seed = git(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'NOTES.md'), 'change\n');
    git(['add', 'NOTES.md'], repo);
    git(['commit', '-q', '-m', 'change'], repo);
    const tip = git(['rev-parse', 'HEAD'], repo);
    git(['update-ref', 'refs/remotes/origin/main', seed], repo);
    return fn({ repo, seed, tip });
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function runHook(repo, stdin) {
  const r = spawnSync('bash', [HOOK, 'origin', 'https://example.invalid'], {
    cwd: repo, encoding: 'utf-8', input: stdin,
    env: { ...process.env, AUDIT_PREPUSH_SANDBOX: '', AUDIT_LOOP_WEEKLY_MAINTENANCE: '' },
  });
  return { ...r, synced: fs.existsSync(path.join(repo, SYNC_MARKER)) };
}

describe('.githooks/pre-push — consumers receive the default branch only', () => {
  it('a feature-branch push does NOT sync consumers, and says so', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withFixture(({ repo, tip }) => {
      const got = runHook(repo, `refs/heads/feature ${tip} refs/heads/feature ${'0'.repeat(40)}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.synced, false, 'unmerged branch tooling was published to consumers');
      assert.match(got.stdout, /Consumer sync skipped: this push does not update 'main'/);
    });
  });

  it('control: a push that updates main DOES sync consumers', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withFixture(({ repo, seed, tip }) => {
      const got = runHook(repo, `refs/heads/main ${tip} refs/heads/main ${seed}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.synced, true, 'a default-branch push must still publish');
    });
  });

  it('a multi-ref push that includes main (listed second) syncs', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withFixture(({ repo, seed, tip }) => {
      const got = runHook(repo,
        `refs/heads/feature ${tip} refs/heads/feature ${'0'.repeat(40)}\nrefs/heads/main ${tip} refs/heads/main ${seed}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.synced, true);
    });
  });

  it('updating main to a commit that is NOT this checkout skips — the sync would publish the wrong tree (R1-M1)', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withFixture(({ repo, seed }) => {
      // `git push origin <seed>:main` from a checkout at tip: main moves to seed, the working tree is tip.
      const got = runHook(repo, `${seed} ${seed} refs/heads/main ${'0'.repeat(40)}
`);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.synced, false, 'published a tree that is not the commit going to main');
      assert.match(got.stdout, /would publish the wrong tree/);
    });
  });

  it('pushing a local branch TO main counts as updating main (the remote ref decides)', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withFixture(({ repo, seed, tip }) => {
      const got = runHook(repo, `refs/heads/release ${tip} refs/heads/main ${seed}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.synced, true);
    });
  });
});
