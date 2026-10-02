/**
 * @fileoverview The generated CONSUMER pre-push hook (`install-prepush-hook.mjs`
 * `HOOK_BODY`) must not run its plan-status gate for a push that only DELETES
 * remote refs — and must still run it for anything that publishes.
 *
 * THE DEFECT. A delete-only push (`git push origin --delete x`) puts an all-zero
 * LOCAL sha on every stdin line. There is no local sha to build a range from, so
 * AUDIT_PUSH_RANGE_BASE/_HEAD stayed empty and `check-plan-status.mjs --drift`
 * fell back to inferring a base from this checkout's own HEAD/@{upstream} — the
 * stale-inference failure that `prepush-push-range-stdin.test.mjs` measures —
 * and could block a push that sends no commits. This repo's own
 * `.githooks/pre-push` got the equivalent skip first
 * (`prepush-delete-only-push.test.mjs`); this is the consumer half.
 *
 * WHY BEHAVIOURAL. Each case runs the real HOOK_BODY against a fixture consumer
 * whose source repo is a stub. The stub's `check-plan-status.mjs --drift` records
 * the range env it was handed, so a case observes whether the gate ran and with
 * WHICH range, not the spelling of the guard. The weekly-maintenance stub and the
 * consumer's `.githooks/pre-push.local` each leave a marker, to pin the two
 * ordering decisions: maintenance runs BEFORE the skip, the local hook does not
 * run for it.
 *
 * BOTH DIRECTIONS ARE PINNED. A skip that fires too widely is a gate that passes
 * having checked nothing: most cases are ones that must NOT skip — a mixed push
 * (deletion listed FIRST, so a range taken from the first line would be empty), an
 * ordinary update, a NEW branch (zero REMOTE sha, the look-alike of a deletion's
 * zero LOCAL sha), empty stdin (vacuously "all deletions" over zero updates), and
 * a final line with no trailing newline.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { _internals } from '../scripts/install-prepush-hook.mjs';
import { hasBash, git } from './lib/hook-test-helpers.mjs';

const { HOOK_BODY } = _internals;
const HAS_BASH = hasBash();
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

const ZERO = '0'.repeat(40);
const DRIFT_MARKER = 'drift-range.json';
const LOCAL_MARKER = 'local-hook-ran.txt';
const MAINT_MARKER = 'maintenance-ran.txt';
const SKIP_NOTE = /delete-only push/;

/**
 * Nested one level below mkdtemp: the source-repo discovery scan reads the
 * PARENT of cwd, so a consumer rooted directly at the mkdtemp dir would
 * enumerate a shared tmp directory.
 */
function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-delete-only-'));
  // The hook BACKGROUNDS the maintenance stub (`( node ... & )`), and that
  // detached process holds cwd = consumer until it exits; on Windows the rmdir
  // then fails EBUSY. So wait for its marker, then retry the removal.
  const dispose = async () => {
    await waitFor(path.join(base, 'consumer', MAINT_MARKER), 3000);
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        return;
      } catch (err) {
        if (attempt >= 20) throw err;
        await new Promise((res) => setTimeout(res, 250));
      }
    }
  };
  try {
    const consumer = path.join(base, 'consumer');
    const source = path.join(base, 'source-repo');
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(source, 'scripts', 'sync-to-repos.mjs'), '// discovery sentinel\n');
    fs.writeFileSync(path.join(source, 'scripts', 'openai-audit.mjs'), 'process.exit(0);\n');
    fs.writeFileSync(path.join(source, 'scripts', 'check-plan-status.mjs'), [
      "if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }",
      "if (process.argv.includes('--drift')) {",
      "  const fs = await import('node:fs');",
      `  fs.writeFileSync(${JSON.stringify(DRIFT_MARKER)}, JSON.stringify({`,
      "    base: process.env.AUDIT_PUSH_RANGE_BASE, head: process.env.AUDIT_PUSH_RANGE_HEAD }));",
      '}',
      '// --select prints nothing: no plan selected, the ordinary case.',
      'process.exit(0);',
      '',
    ].join('\n'));

    fs.mkdirSync(path.join(consumer, 'docs', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(consumer, 'scripts', '.claude-skills'), { recursive: true });
    fs.mkdirSync(path.join(consumer, '.githooks'), { recursive: true });
    git(['init', '-q', '-b', 'main', consumer]);
    git(['config', 'user.email', 'fixture@example.invalid'], consumer);
    git(['config', 'user.name', 'Fixture'], consumer);
    fs.writeFileSync(path.join(consumer, 'README.md'), 'seed\n');
    git(['add', 'README.md'], consumer);
    git(['commit', '-q', '-m', 'seed'], consumer);
    const seed = git(['rev-parse', 'HEAD'], consumer);
    fs.writeFileSync(path.join(consumer, 'NOTES.md'), 'change\n');
    git(['add', 'NOTES.md'], consumer);
    git(['commit', '-q', '-m', 'change'], consumer);
    const tip = git(['rev-parse', 'HEAD'], consumer);
    // The new-branch path computes `git merge-base origin/main <local_sha>`.
    git(['update-ref', 'refs/remotes/origin/main', seed], consumer);

    // Untracked on purpose: written after the commits so they cannot change `tip`.
    fs.writeFileSync(
      path.join(consumer, 'scripts', '.claude-skills', 'maintenance-checks.mjs'),
      `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(MAINT_MARKER)}, 'ran');\n`,
    );
    fs.writeFileSync(
      path.join(consumer, '.githooks', 'pre-push.local'),
      `#!/bin/sh\n: > "${LOCAL_MARKER}"\nexit 0\n`,
    );
    return { consumer, source, seed, tip, dispose };
  } catch (err) {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    throw err;
  }
}

async function waitFor(file, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fs.existsSync(file);
}

function runHook({ consumer, source }, stdin) {
  const script = path.join(consumer, '.hook.sh');
  fs.writeFileSync(script, HOOK_BODY);
  const r = spawnSync('bash', [script, 'origin', 'https://example.invalid'], {
    cwd: consumer,
    encoding: 'utf-8',
    input: stdin,
    env: {
      ...process.env,
      CLAUDE_AUDIT_LOOP_DIR: source,
      PREPUSH_LOCAL_DISABLE: '',
      PLAN_STATUS_DISABLE: '',
      AUDIT_PREPUSH_DISABLE: '',
      AUDIT_PUSH_RANGE_REQUIRED: '',
    },
  });
  const driftPath = path.join(consumer, DRIFT_MARKER);
  return {
    ...r,
    drift: fs.existsSync(driftPath) ? JSON.parse(fs.readFileSync(driftPath, 'utf-8')) : null,
    localRan: fs.existsSync(path.join(consumer, LOCAL_MARKER)),
  };
}

describe('HOOK_BODY — a delete-only push skips the gate', () => {
  it('skips a single branch deletion, saying so, and still runs maintenance', async (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    const fx = makeFixture();
    try {
      const got = runHook(fx, `(delete) ${ZERO} refs/heads/doomed ${fx.seed}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.drift, null, 'the plan-status gate ran for a push that published nothing');
      assert.match(got.stderr, SKIP_NOTE);
      // Ordering invariant (maintenance-hook-snippet.test.mjs): the maintenance
      // block precedes every early exit, this one included.
      assert.ok(await waitFor(path.join(fx.consumer, MAINT_MARKER)), 'maintenance must run before the skip');
    } finally {
      await fx.dispose();
    }
  });

  it('does NOT run the consumer pre-push.local for a delete-only push', async (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    const fx = makeFixture();
    try {
      const got = runHook(fx, `(delete) ${ZERO} refs/heads/doomed ${fx.seed}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.localRan, false, 'the local hook (a test suite, typically) ran for a push with nothing to test');
    } finally {
      await fx.dispose();
    }
  });

  it('skips several deletions in one push', async (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    const fx = makeFixture();
    try {
      const got = runHook(fx,
        `(delete) ${ZERO} refs/heads/a ${fx.seed}\n(delete) ${ZERO} refs/heads/b ${fx.tip}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.drift, null);
      assert.match(got.stderr, /delete-only push \(2 ref/);
    } finally {
      await fx.dispose();
    }
  });
});

describe('HOOK_BODY — anything that publishes is still gated', () => {
  it('a mixed push is gated at the UPDATE\'s range, even with the deletion listed first', async (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    const fx = makeFixture();
    try {
      // Deletion FIRST: a skip keyed on the first line, or a range taken from it,
      // would both show up here (the range would be empty).
      const got = runHook(fx,
        `(delete) ${ZERO} refs/heads/doomed ${fx.tip}\nrefs/heads/main ${fx.tip} refs/heads/main ${fx.seed}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.deepEqual(got.drift, { base: fx.seed, head: fx.tip });
      assert.doesNotMatch(got.stderr, SKIP_NOTE);
      assert.equal(got.localRan, true, 'the local hook must still run for a push that publishes');
    } finally {
      await fx.dispose();
    }
  });

  it('an ordinary update is gated exactly as before', async (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    const fx = makeFixture();
    try {
      const got = runHook(fx, `refs/heads/main ${fx.tip} refs/heads/main ${fx.seed}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.deepEqual(got.drift, { base: fx.seed, head: fx.tip });
      assert.doesNotMatch(got.stderr, SKIP_NOTE);
    } finally {
      await fx.dispose();
    }
  });

  it('a final line with no trailing newline is still read', async (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    const fx = makeFixture();
    try {
      const got = runHook(fx, `refs/heads/main ${fx.tip} refs/heads/main ${fx.seed}`);
      assert.equal(got.status, 0, got.stderr);
      assert.deepEqual(got.drift, { base: fx.seed, head: fx.tip });
      assert.doesNotMatch(got.stderr, SKIP_NOTE);
    } finally {
      await fx.dispose();
    }
  });

  it('a NEW branch (zero REMOTE sha) is not mistaken for a deletion (zero LOCAL sha)', async (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    const fx = makeFixture();
    try {
      const got = runHook(fx, `refs/heads/feature ${fx.tip} refs/heads/feature ${ZERO}\n`);
      assert.equal(got.status, 0, got.stderr);
      // Range is the fork point from origin/main, unchanged behaviour.
      assert.deepEqual(got.drift, { base: fx.seed, head: fx.tip });
      assert.doesNotMatch(got.stderr, SKIP_NOTE);
    } finally {
      await fx.dispose();
    }
  });

  it('empty stdin is NOT a delete-only push — zero updates must not vacuously skip', async (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    const fx = makeFixture();
    try {
      const got = runHook(fx, '');
      assert.equal(got.status, 0, got.stderr);
      assert.deepEqual(got.drift, { base: '', head: '' }, 'with no push info the gate must still run (inferring its range)');
      assert.doesNotMatch(got.stderr, SKIP_NOTE);
      assert.equal(got.localRan, true);
    } finally {
      await fx.dispose();
    }
  });
});

describe('HOOK_BODY — delete-only skip, static shape', () => {
  it('bumped the version so consumers re-install', () => {
    const v = Number(HOOK_BODY.match(/# hook-version: (\d+)/)[1]);
    assert.ok(v >= 8, `hook-version must be >= 8 for this fix, got ${v}`);
  });

  it('positions the skip AFTER the maintenance block and BEFORE the plans early-exit and the gate', () => {
    const maintAt = HOOK_BODY.indexOf('# ── Opportunistic weekly local maintenance');
    const skipAt = HOOK_BODY.indexOf('if [ "$PUBLISHED_REFS" -eq 0 ] && [ "$DELETED_REFS" -gt 0 ]; then');
    const plansAt = HOOK_BODY.indexOf('PLANS_DIR="docs/plans"');
    const gateAt = HOOK_BODY.indexOf('if [ "$PLAN_STATUS_DISABLE" != "1" ]; then');
    assert.ok(maintAt > 0 && skipAt > 0 && plansAt > 0 && gateAt > 0);
    assert.ok(maintAt < skipAt, 'the maintenance block must run before any early exit');
    assert.ok(skipAt < plansAt && skipAt < gateAt);
  });

  it('exits directly, not through `finish` (the local hook must not run)', () => {
    const skipAt = HOOK_BODY.indexOf('if [ "$PUBLISHED_REFS" -eq 0 ] && [ "$DELETED_REFS" -gt 0 ]; then');
    const block = HOOK_BODY.slice(skipAt, HOOK_BODY.indexOf('\nfi\n', skipAt));
    assert.match(block, /\n\s*exit 0$/);
    assert.doesNotMatch(block, /finish/);
  });
});
