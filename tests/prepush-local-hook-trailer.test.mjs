/**
 * @fileoverview The consumer's own pre-push gates must run on EVERY push, not
 * only on the pushes where an upstream plan audit happened to be selected.
 *
 * THE DEFECT (measured 2026-09-06 in wine-cellar-app). `.githooks/pre-push.local`
 * was invoked on the last lines of the generated hook, below three unconditional
 * `exit 0`s:
 *
 *   - `[ ! -d "$PLANS_DIR" ] && exit 0`
 *   - the "claude-engineering-skills not found beside …" branch
 *   - `[ -z "$PLAN_FILE" ] && exit 0`   ← the ordinary case
 *
 * The third fires whenever `check-plan-status.mjs --select` picks nothing: every
 * plan Complete, or none changed in the push. A real `git push --dry-run` in that
 * consumer emitted no `[pre-push] running unit suite...` line at all, so its full
 * unit suite, npm-args gate and knip gate were silently skipped while its
 * AGENTS.md stated they ran. A skipped gate reads exactly like a pass — the same
 * shape the round-4 fix repaired for the weekly-maintenance block by hoisting it
 * above the early exits.
 *
 * WHY A TRAILER AND NOT A HOIST. The local hook is typically the EXPENSIVE gate
 * (a whole test suite). Hoisting it would run it before the cheap upstream gates
 * got their chance to fail, so a plan-Status typo would cost two minutes of tests
 * before being reported. `finish` keeps it last in ORDER while making it
 * unconditional in REACH.
 *
 * WHAT MUST NOT CHANGE: a BLOCKING exit stays a hard exit. Running the consumer's
 * test suite after already deciding to refuse the push only makes the refusal
 * slower, and would report the suite's verdict for a push that was never going to
 * happen. Cases below pin both directions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { _internals } from '../scripts/install-prepush-hook.mjs';
import { hasBash } from './lib/hook-test-helpers.mjs';

const { HOOK_BODY } = _internals;
const HAS_BASH = hasBash();

const MARKER = 'local-hook-ran.txt';

/**
 * Nested one level below mkdtemp: the discovery scan reads the PARENT of cwd, so
 * a consumer rooted directly at the mkdtemp dir would enumerate a shared tmp
 * directory and could match a concurrent test's source-repo fixture.
 */
function withWorkspace(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'local-trailer-'));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  try {
    return fn(workspace);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/** A consumer repo whose local hook leaves a marker and exits `code`. */
function makeConsumer(workspace, { code = 0, plans = false } = {}) {
  const root = path.join(workspace, 'consumer');
  fs.mkdirSync(path.join(root, '.githooks'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.githooks', 'pre-push.local'),
    `#!/bin/sh\necho "[pre-push] local hook ran" >&2\n: > "${MARKER}"\nexit ${code}\n`,
  );
  if (plans) fs.mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
  return root;
}

/**
 * A stand-in source repo. `sync-to-repos.mjs` is the discovery sentinel;
 * `openai-audit.mjs` is what the "found it" guard tests for; the status CLI is
 * optional so a case can exercise the CANNOT-RUN branch.
 */
function makeSourceRepo(workspace, { statusCli = 'ok' } = {}) {
  const root = path.join(workspace, 'source-repo');
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'sync-to-repos.mjs'), '// fixture\n');
  fs.writeFileSync(path.join(scripts, 'openai-audit.mjs'), 'process.exit(0);\n');
  if (statusCli === 'ok') {
    fs.writeFileSync(path.join(scripts, 'check-plan-status.mjs'), [
      "if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }",
      "if (process.argv.includes('--drift')) process.exit(0);",
      "// --select prints nothing: no plan selected, the ordinary case.",
      'process.exit(0);',
      '',
    ].join('\n'));
  }
  return root;
}

function runHook(consumer, env = {}) {
  const script = path.join(consumer, '.hook.sh');
  fs.writeFileSync(script, HOOK_BODY);
  const r = spawnSync('bash', [script, 'origin', 'https://example.invalid'], {
    cwd: consumer,
    encoding: 'utf-8',
    input: '',
    env: { ...process.env, CLAUDE_AUDIT_LOOP_DIR: '', PREPUSH_LOCAL_DISABLE: '', ...env },
  });
  return { ...r, ran: fs.existsSync(path.join(consumer, MARKER)) };
}

describe('managed pre-push hook — the local hook runs on every success path', () => {
  it('runs it when there is no docs/plans at all', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    withWorkspace((ws) => {
      const consumer = makeConsumer(ws, { plans: false });
      const got = runHook(consumer);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.ran, true, `local hook did not run:\n${got.stderr}`);
      // RED CONTROL: this must really be an EARLY-exit path, or the case proves
      // nothing about the trailer — the old trailing block would have run too.
      assert.doesNotMatch(got.stderr, /auditing/, 'fixture reached the audit; not an early exit');
    });
  });

  it('runs it when the source repo is not found beside the checkout', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    withWorkspace((ws) => {
      const consumer = makeConsumer(ws, { plans: true });
      const got = runHook(consumer);
      assert.equal(got.status, 0, got.stderr);
      // Fixture validity: prove we took THIS branch, not another.
      assert.match(got.stderr, /not found beside/);
      assert.equal(got.ran, true, `local hook did not run:\n${got.stderr}`);
    });
  });

  it('runs it when no plan is selected — the case that was silently skipping', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    withWorkspace((ws) => {
      makeSourceRepo(ws);
      const consumer = makeConsumer(ws, { plans: true });
      const got = runHook(consumer);
      assert.equal(got.status, 0, got.stderr);
      // Fixture validity: discovery SUCCEEDED and selection returned nothing.
      assert.doesNotMatch(got.stderr, /not found beside/);
      assert.doesNotMatch(got.stderr, /auditing/);
      assert.equal(got.ran, true, `local hook did not run:\n${got.stderr}`);
    });
  });

  it('keeps the local hook authoritative — its non-zero exit aborts the push', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    withWorkspace((ws) => {
      const consumer = makeConsumer(ws, { plans: false, code: 3 });
      const got = runHook(consumer);
      assert.equal(got.ran, true);
      assert.equal(got.status, 3, 'the local hook exit code must reach git unchanged');
    });
  });

  it('still honours PREPUSH_LOCAL_DISABLE=1', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    withWorkspace((ws) => {
      const consumer = makeConsumer(ws, { plans: false, code: 3 });
      const got = runHook(consumer, { PREPUSH_LOCAL_DISABLE: '1' });
      assert.equal(got.ran, false, 'the documented bypass no longer bypasses');
      assert.equal(got.status, 0);
    });
  });

  it('leaves AUDIT_PREPUSH_DISABLE=1 a whole-hook kill switch', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    withWorkspace((ws) => {
      // Deliberate, not an oversight: it is the documented "turn this off"
      // escape and routing it through the trailer would take that away.
      const consumer = makeConsumer(ws, { plans: false, code: 3 });
      const got = runHook(consumer, { AUDIT_PREPUSH_DISABLE: '1' });
      assert.equal(got.ran, false);
      assert.equal(got.status, 0);
    });
  });
});

describe('managed pre-push hook — a BLOCKING exit does not run the local hook', () => {
  it('refuses without running it when the plan-status checker cannot start', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    withWorkspace((ws) => {
      makeSourceRepo(ws, { statusCli: 'missing' });
      const consumer = makeConsumer(ws, { plans: true });
      const got = runHook(consumer);
      assert.equal(got.status, 1);
      assert.match(got.stderr, /CANNOT RUN/, 'fixture did not reach the blocking branch');
      assert.equal(
        got.ran, false,
        'the push is already refused; running the consumer suite only makes the refusal slower',
      );
    });
  });
});

describe('managed pre-push hook — exit-path population', () => {
  /** Executable lines only: a `#` comment quoting `exit 0` is documentation. */
  const code = HOOK_BODY.split('\n').filter(l => !l.trim().startsWith('#'));

  it('routes every SUCCESS exit through finish', () => {
    const bare = code.filter(l => /(^|[;&|]\s*)exit 0\b/.test(l));
    assert.deepEqual(
      bare.map(l => l.trim()),
      ['[ "$AUDIT_PREPUSH_DISABLE" = "1" ] && exit 0'],
      'a new `exit 0` bypasses the consumer extension point — use `finish`, or '
      + 'declare it here with the reason it must not run the local hook',
    );
  });

  it('defines finish before the first call', () => {
    // Over executable lines only — the rationale comments above the definition
    // quote `finish`, and a prose mention is not a call. A CALL is `finish` not
    // followed by `(`, which also keeps the definition line itself out.
    const codeText = code.join('\n');
    const defAt = codeText.indexOf('finish() {');
    assert.ok(defAt > 0, 'finish() is not defined');
    const firstCall = codeText.search(/\bfinish\b(?!\(\))/);
    assert.ok(firstCall > 0, 'finish is never called');
    assert.ok(firstCall > defAt, `finish is called (offset ${firstCall}) before it is defined (${defAt})`);
  });

  it('has exactly one invocation of the local hook', () => {
    // Two would mean the old trailing block survived alongside the trailer, and
    // a consumer suite would run twice on the audit path.
    assert.equal(code.filter(l => l.includes('sh "$LOCAL_HOOK"')).length, 1);
  });

  it('no longer ends with the unreachable trailing block', () => {
    assert.doesNotMatch(
      HOOK_BODY,
      /LOCAL_HOOK="\.githooks\/pre-push\.local"\nif \[ "\$PREPUSH_LOCAL_DISABLE"/,
    );
  });

  it('bumped the version so consumers re-install', () => {
    const v = Number(HOOK_BODY.match(/# hook-version: (\d+)/)[1]);
    assert.ok(v >= 5, `hook-version must be >= 5 for this fix, got ${v}`);
  });
});
