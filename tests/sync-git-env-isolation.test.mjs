/**
 * The sync must never inherit a repo context from whoever launched it.
 *
 * ## The incident (root-caused 2026-07-30)
 *
 * git's hook machinery exports `GIT_DIR`/`GIT_WORK_TREE` into a hook's process
 * (githooks(5)), and those variables take PRECEDENCE OVER `cwd`. `/ship`'s push
 * runs `.githooks/pre-push`, which runs `sync-to-repos.mjs`, which runs
 * `untrackNewlyIgnored` with `cwd: <consumer>` — so every git call silently
 * retargeted the PUSHING repo. It listed the source repo's tracked files,
 * matched `docs/arm-eval/sessions/*` from `UNTRACK_PATTERNS` against them, and
 * ran `git rm --cached` on the source index, un-tracking 25 committed auditable
 * experiment records. They stayed on disk, so it presented as a staged mass
 * deletion nobody asked for; a later `git add -A` would have made it real.
 *
 * It fired once per worktree (a fresh index re-tracks them, and the untrack is
 * idempotent) and never under a manual `npm run sync` — which is what made it
 * look like a haunting rather than a bug.
 *
 * This is the same class as the six HEAD-corruption incidents of 2026-07-23,
 * whose fix (`git-env-sanitize.mjs`) was applied to test fixtures and the
 * hook→sandbox boundary and MISSED this one. So the pin below is deliberately
 * behavioural, not "is the helper imported": it asserts a victim repo's index
 * survives a git call made with a poisoned ambient environment.
 *
 * Tier 3 per AGENTS.md — the consumer-sync contract, where a regression ships
 * silently to repos you cannot observe.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { untrackNewlyIgnored } from '../scripts/lib/sync-untrack.mjs';
import { GIT_LOCAL_ENV_VARS } from '../scripts/lib/git-env-sanitize.mjs';
import { _internals } from '../scripts/sync-to-repos.mjs';

const { scrubAmbientGitEnv } = _internals;

let tmp;

/** A throwaway repo with one tracked file at `rel`. Never the real repo. */
function seedRepo(name, rel) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), 'tracked content\n');
  // A clean env for the fixture's OWN setup — otherwise this helper falls into
  // the very trap it exists to test.
  const env = { ...process.env };
  for (const v of GIT_LOCAL_ENV_VARS) delete env[v];
  const git = (args) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  git(['add', '--', rel]);
  git(['commit', '-qm', 'seed']);
  return root;
}

function tracks(root, rel) {
  const env = { ...process.env };
  for (const v of GIT_LOCAL_ENV_VARS) delete env[v];
  return execFileSync('git', ['ls-files', '--', rel], { cwd: root, env, encoding: 'utf-8' }).trim() !== '';
}

beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-gitenv-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('scrubAmbientGitEnv', () => {
  test('removes every git-local variable from the ambient environment', () => {
    const saved = {};
    for (const v of GIT_LOCAL_ENV_VARS) { saved[v] = process.env[v]; }
    try {
      process.env.GIT_DIR = path.join(tmp, 'somewhere', '.git');
      process.env.GIT_WORK_TREE = path.join(tmp, 'somewhere');
      process.env.GIT_INDEX_FILE = path.join(tmp, 'somewhere', '.git', 'index');

      scrubAmbientGitEnv();

      for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
        assert.equal(process.env[v], undefined, `${v} must be gone, not merely emptied`);
      }
    } finally {
      for (const v of GIT_LOCAL_ENV_VARS) {
        if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v];
      }
    }
  });
});

describe('the untrack self-heal cannot reach across into the launching repo', () => {
  const REL = 'docs/arm-eval/sessions/20260101-000000Z__x__y__z__abcd1234.md';

  test('REPRODUCTION: a poisoned GIT_DIR redirects git rm --cached into the victim', () => {
    // Not a hypothetical. This asserts the mechanism itself, so the pin below
    // cannot quietly become vacuous if the env plumbing is ever reworked: if
    // this stops reproducing, the guard it justifies needs re-deriving.
    const victim = seedRepo('victim', REL);
    const consumer = seedRepo('consumer', 'unrelated.txt');
    assert.equal(tracks(victim, REL), true, 'precondition');

    const poisoned = { ...process.env, GIT_DIR: path.join(victim, '.git'), GIT_WORK_TREE: victim };
    untrackNewlyIgnored(consumer, ['docs/arm-eval/sessions/*'], { env: poisoned });

    assert.equal(tracks(victim, REL), false,
      'with the ambient env inherited, the victim index IS corrupted — this is the bug');
    assert.equal(fs.existsSync(path.join(victim, REL)), true,
      'and the file survives on disk, which is why it read as an unexplained staged deletion');
  });

  test('a sanitised env leaves the victim untouched', () => {
    const victim = seedRepo('victim', REL);
    const consumer = seedRepo('consumer', 'unrelated.txt');

    const poisoned = { ...process.env, GIT_DIR: path.join(victim, '.git'), GIT_WORK_TREE: victim };
    for (const v of GIT_LOCAL_ENV_VARS) delete poisoned[v];
    untrackNewlyIgnored(consumer, ['docs/arm-eval/sessions/*'], { env: poisoned });

    assert.equal(tracks(victim, REL), true, 'the launching repo must be untouched');
  });

  test('scrubAmbientGitEnv() is what makes the DEFAULT call site safe', () => {
    // The production call site passes no `env`, so it inherits process.env.
    // That is only safe because main() scrubs first — this pins the connection
    // between the two, which is the half the 2026-07-23 fix left undone.
    const victim = seedRepo('victim', REL);
    const consumer = seedRepo('consumer', 'unrelated.txt');

    const saved = {};
    for (const v of GIT_LOCAL_ENV_VARS) { saved[v] = process.env[v]; }
    try {
      process.env.GIT_DIR = path.join(victim, '.git');
      process.env.GIT_WORK_TREE = victim;

      scrubAmbientGitEnv();
      untrackNewlyIgnored(consumer, ['docs/arm-eval/sessions/*']);   // no env — the real call shape

      assert.equal(tracks(victim, REL), true,
        'after the scrub, the default ambient env can no longer reach the launching repo');
    } finally {
      for (const v of GIT_LOCAL_ENV_VARS) {
        if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v];
      }
    }
  });
});
