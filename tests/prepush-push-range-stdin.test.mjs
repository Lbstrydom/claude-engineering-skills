/**
 * @fileoverview The generated consumer pre-push hook never read git's own
 * pre-push stdin protocol (`<local_ref> <local_sha> <remote_ref> <remote_sha>`),
 * so the plan-status gate (`check-plan-status.mjs --drift`/`--select`, via
 * scripts/lib/push-range.mjs) always fell back to INFERRING a base from the
 * CURRENT CHECKOUT's own HEAD/@{upstream} instead of the range git actually
 * negotiated with the remote.
 *
 * THE DEFECT (measured live in a consumer, 2026-09-07): a shared checkout's
 * local tracking ref for `origin/main` was 17 commits stale. `--drift`'s
 * inferred base was that stale ref, so the diff swept in intermediate commits
 * that OTHER sessions had already pushed directly — attributing their
 * pre-existing non-conforming plan Status lines to a push that touched no
 * plan file at all. Blocked three consecutive pushes, including one that
 * carried no commits (a branch deletion).
 *
 * git already told the hook the truth: on stdin, `<remote_sha>` is the
 * REMOTE's actual current tip for the ref being pushed, resolved live over
 * the wire at push time — independent of whatever the local checkout's own
 * cached tracking ref says. Threading that through as
 * AUDIT_PUSH_RANGE_BASE/_HEAD (scripts/lib/push-range.mjs's existing,
 * previously-unused contract) fixes it without needing new capability; this
 * repo's own dogfooded .githooks/pre-push already does exactly this.
 *
 * WHY THE BEHAVIOURAL CASES BUILD A REAL STALE CHECKOUT. A regex over
 * HOOK_BODY only pins the spelling of the fix, not its effect — the pre-fix
 * body would pass a a plausible-looking stdin read that silently threads the
 * wrong field. So the cases below construct the actual git topology the
 * incident describes: a local checkout whose `origin/main` tracking ref is
 * stale, fast-forwarded past commits from other sessions that already
 * introduced non-conforming plans, with a NEW local commit that touches no
 * plan file at all. Each carries a RED CONTROL proving the pre-fix inference
 * really does misattribute before showing the fix corrects it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { _internals } from '../scripts/install-prepush-hook.mjs';
import { hasBash, git } from './lib/hook-test-helpers.mjs';

const { HOOK_BODY } = _internals;
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(__filename, '..', '..');
const CHECK_PLAN_STATUS = path.join(REPO_ROOT, 'scripts', 'check-plan-status.mjs');

const HAS_BASH = hasBash();
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

function withWorkspace(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'push-range-stale-'));
  try {
    return fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

const NON_CONFORMING_STATUS = '- **Status**: Bogus-Value-Not-A-Vocabulary-Token\n';

/**
 * When this suite runs INSIDE the sandboxed pre-push check
 * (`scripts/prepush-check.mjs`), the OUTER push already has a known base, so
 * the sandbox sets `AUDIT_PUSH_RANGE_REQUIRED=1` for the whole `npm run check`
 * child process (its own sandbox-honesty guard — see prepush-check.mjs's
 * `env` construction). That var is process-tree-wide and this test's `node`/
 * `bash` subprocesses inherit it via `...process.env`, which turns
 * `resolvePushRange`'s "no explicit base -> fall back to inference" path into
 * a hard refusal for the INNER fixture repo too — unrelated to the outer
 * push, but indistinguishable to `push-range.mjs` since it only sees the env
 * var. Every case here that depends on the FALLBACK inference actually
 * running (the RED controls, and the deletion case, which never supplies an
 * explicit base) must scrub it back out, or it fails only under `/ship`,
 * never locally — exactly the class of env-leak incident documented for
 * `GIT_WORK_TREE` in prepush-check.mjs.
 */
const SANDBOX_REQUIRE_SCRUB = { AUDIT_PUSH_RANGE_REQUIRED: '' };

/**
 * Build the exact topology the incident describes:
 *
 *   A0 ── (local's stale `origin/main` tracking ref points here) ──┐
 *    \                                                              │ (never
 *     \                                                             │  re-fetched
 *      B ── C  (pushed DIRECTLY to the remote by "other sessions",  │  by local)
 *      │      each adding a plan with a non-conforming Status)      │
 *      │                                                            │
 *      └──────────── local fetches + fast-forwards to C ───────────┘
 *                     then commits D on top (touches no plan file)
 *
 * The TRUE current remote tip is C (git's own wire negotiation always reports
 * this correctly regardless of local staleness — that's the value the fixed
 * hook now threads through). Local's cached `refs/remotes/origin/main` is
 * forced back to A0 to reproduce "never re-fetched", the exact condition
 * `@{upstream}`-based inference silently trusts.
 *
 * @returns {{local:string, base:string, head:string, staleRef:string}}
 */
function buildStaleCheckoutFixture(workspace) {
  const bare = path.join(workspace, 'origin.git');
  const local = path.join(workspace, 'local');
  const otherSessions = path.join(workspace, 'other-sessions');

  git(['init', '--bare', '-q', '-b', 'main', bare]);
  git(['clone', '-q', bare, local]);
  git(['config', 'user.email', 'local@example.invalid'], local);
  git(['config', 'user.name', 'Local'], local);

  fs.mkdirSync(path.join(local, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(
    path.join(local, 'docs', 'plans', 'good.md'),
    '# Plan: Good\n\n- **Status**: Complete\n\n## Notes\n',
  );
  git(['add', '.'], local);
  git(['commit', '-q', '-m', 'A0: seed'], local);
  git(['push', '-q', 'origin', 'main'], local);
  const staleRef = git(['rev-parse', 'HEAD'], local);

  // Two "other sessions" push DIRECTLY to the remote, bypassing this checkout.
  git(['clone', '-q', bare, otherSessions]);
  git(['config', 'user.email', 'other@example.invalid'], otherSessions);
  git(['config', 'user.name', 'Other'], otherSessions);
  fs.mkdirSync(path.join(otherSessions, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(otherSessions, 'docs', 'plans', 'bad1.md'), `# Plan: Bad One\n\n${NON_CONFORMING_STATUS}\n## Notes\n`);
  git(['add', '.'], otherSessions);
  git(['commit', '-q', '-m', 'B: other session adds a non-conforming plan'], otherSessions);
  fs.writeFileSync(path.join(otherSessions, 'docs', 'plans', 'bad2.md'), `# Plan: Bad Two\n\n${NON_CONFORMING_STATUS}\n## Notes\n`);
  git(['add', '.'], otherSessions);
  git(['commit', '-q', '-m', 'C: another session adds another non-conforming plan'], otherSessions);
  git(['push', '-q', 'origin', 'main'], otherSessions);

  // This checkout DOES fetch (objects arrive) and fast-forwards past B/C —
  // it is not behind on CONTENT, only on what its cached tracking ref says.
  git(['fetch', '-q', 'origin'], local);
  git(['merge', '-q', '--ff-only', 'origin/main'], local);
  const base = git(['rev-parse', 'HEAD'], local); // = C

  // This session's own real work: touches no plan file at all.
  fs.writeFileSync(path.join(local, 'NOTES.md'), 'unrelated change\n');
  git(['add', 'NOTES.md'], local);
  git(['commit', '-q', '-m', "D: this session's own change"], local);
  const head = git(['rev-parse', 'HEAD'], local);

  // Reproduce "never re-fetched": force the LOCAL tracking ref back to the
  // stale point. `@{upstream}` for `main` now resolves to A0, not the true C.
  git(['update-ref', 'refs/remotes/origin/main', staleRef], local);

  // Fixture validity: the push range git will ACTUALLY report (base..head)
  // must touch no plan file, or the test proves nothing.
  const trueRangeFiles = git(['diff', '--name-only', `${base}..${head}`], local).split('\n').filter(Boolean);
  assert.deepEqual(trueRangeFiles, ['NOTES.md'], 'fixture invalid: the true push range must touch only NOTES.md');

  // Fixture validity: the STALE inferred range must actually sweep in the
  // other sessions' plans, or the red control below is vacuous.
  const staleRangeFiles = git(['diff', '--name-only', `${staleRef}..${head}`], local).split('\n').filter(Boolean);
  assert.ok(
    staleRangeFiles.includes('docs/plans/bad1.md') && staleRangeFiles.includes('docs/plans/bad2.md'),
    `fixture invalid: the stale range must include both other-session plans, got: ${staleRangeFiles.join(', ')}`,
  );

  return { local, base, head, staleRef };
}

describe('HOOK_BODY threads git\'s own stdin push range through — static shape', () => {
  it('reads exactly one line of stdin (single `read`, not a `while` loop)', () => {
    assert.match(HOOK_BODY, /read -r LOCAL_REF LOCAL_SHA REMOTE_REF REMOTE_SHA/);
    assert.doesNotMatch(HOOK_BODY, /while read -r LOCAL_REF/);
  });

  it('exports AUDIT_PUSH_RANGE_BASE/_HEAD from the parsed stdin line', () => {
    assert.match(HOOK_BODY, /export AUDIT_PUSH_RANGE_BASE="\$PUSH_BASE"/);
    assert.match(HOOK_BODY, /export AUDIT_PUSH_RANGE_HEAD="\$PUSH_HEAD"/);
  });

  it('positions the stdin read before the plan-status gate and before STATUS_CLI is ever invoked', () => {
    const exportAt = HOOK_BODY.indexOf('export AUDIT_PUSH_RANGE_HEAD="$PUSH_HEAD"');
    const gateAt = HOOK_BODY.indexOf('if [ "$PLAN_STATUS_DISABLE" != "1" ]; then');
    const firstStatusCliCallAt = HOOK_BODY.indexOf('node "$STATUS_CLI"');
    assert.ok(exportAt > 0 && gateAt > 0 && firstStatusCliCallAt > 0);
    assert.ok(exportAt < gateAt, 'stdin range must be exported before the plan-status gate');
    assert.ok(exportAt < firstStatusCliCallAt, 'stdin range must be exported before any STATUS_CLI invocation');
  });

  it('positions the stdin read before it could be starved by any other read of stdin', () => {
    // The kill switch is the only thing allowed ahead of it.
    const disableAt = HOOK_BODY.indexOf('[ "$AUDIT_PREPUSH_DISABLE" = "1" ] && exit 0');
    const readAt = HOOK_BODY.indexOf('read -r LOCAL_REF LOCAL_SHA REMOTE_REF REMOTE_SHA');
    assert.ok(disableAt > 0 && readAt > disableAt);
  });

  it('treats an all-zero local sha (branch deletion) as "nothing pushed", not a literal range', () => {
    assert.match(HOOK_BODY, /ZERO_SHA="0{40}"/);
    assert.match(HOOK_BODY, /"\$LOCAL_SHA" != "\$ZERO_SHA"/);
  });

  it('bumped the version so consumers re-install', () => {
    const v = Number(HOOK_BODY.match(/# hook-version: (\d+)/)[1]);
    assert.ok(v >= 6, `hook-version must be >= 6 for this fix, got ${v}`);
  });
});

describe('check-plan-status.mjs --drift on a real stale checkout', () => {
  it('RED: with no explicit range, inference misattributes other sessions\' plans to this push', (t) => {
    if (!HAS_GIT) return t.skip('git is required');
    withWorkspace((ws) => {
      const { local } = buildStaleCheckoutFixture(ws);
      const r = spawnSync('node', [CHECK_PLAN_STATUS, '--drift', '--format', 'json'], {
        cwd: local,
        encoding: 'utf-8',
        env: { ...process.env, AUDIT_PUSH_RANGE_BASE: '', AUDIT_PUSH_RANGE_HEAD: '', ...SANDBOX_REQUIRE_SCRUB },
      });
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false, 'red control invalid: stale inference must fail before the fix is applied');
      const gatingFiles = out.gating.map(f => f.file);
      assert.ok(gatingFiles.includes('docs/plans/bad1.md') && gatingFiles.includes('docs/plans/bad2.md'),
        `expected the stale inference to misattribute both other-session plans, got: ${JSON.stringify(out.gating)}`);
      assert.equal(r.status, 1);
    });
  });

  it('GREEN: given the real range git negotiated with the remote, only this push\'s own diff gates', (t) => {
    if (!HAS_GIT) return t.skip('git is required');
    withWorkspace((ws) => {
      const { local, base, head } = buildStaleCheckoutFixture(ws);
      const r = spawnSync('node', [CHECK_PLAN_STATUS, '--drift', '--format', 'json'], {
        cwd: local,
        encoding: 'utf-8',
        env: { ...process.env, AUDIT_PUSH_RANGE_BASE: base, AUDIT_PUSH_RANGE_HEAD: head },
      });
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true, `expected the true range to gate on nothing; got: ${JSON.stringify(out)}`);
      assert.deepEqual(out.gating, []);
      // The other sessions' plans are still real — reported as pre-existing,
      // just not blamed on this push.
      const preExistingFiles = out.preExisting.map(f => f.file);
      assert.ok(preExistingFiles.includes('docs/plans/bad1.md') && preExistingFiles.includes('docs/plans/bad2.md'));
      assert.equal(r.status, 0);
    });
  });
});

describe('the full generated hook, fed git\'s real stdin protocol, on the same stale checkout', () => {
  it('RED: fed no push info (what every pre-v6 hook effectively did) — blocks on an unrelated push', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((ws) => {
      const { local } = buildStaleCheckoutFixture(ws);
      const script = path.join(local, '.hook.sh');
      fs.writeFileSync(script, HOOK_BODY);
      const r = spawnSync('bash', [script, 'origin', 'https://example.invalid'], {
        cwd: local,
        encoding: 'utf-8',
        input: '', // stdin closed immediately, exactly like the pre-fix body's behaviour
        env: { ...process.env, CLAUDE_AUDIT_LOOP_DIR: REPO_ROOT, ...SANDBOX_REQUIRE_SCRUB },
      });
      assert.equal(r.status, 1, `expected the stale inference to block the push; stderr:\n${r.stderr}`);
      assert.match(r.stderr, /non-conforming Status/);
    });
  });

  it('GREEN: fed the real <local_ref> <local_sha> <remote_ref> <remote_sha> line — passes', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((ws) => {
      const { local, base, head } = buildStaleCheckoutFixture(ws);
      const script = path.join(local, '.hook.sh');
      fs.writeFileSync(script, HOOK_BODY);
      const stdin = `refs/heads/main ${head} refs/heads/main ${base}\n`;
      const r = spawnSync('bash', [script, 'origin', 'https://example.invalid'], {
        cwd: local,
        encoding: 'utf-8',
        input: stdin,
        env: { ...process.env, CLAUDE_AUDIT_LOOP_DIR: REPO_ROOT },
      });
      assert.equal(r.status, 0, `expected the real range to pass; stderr:\n${r.stderr}`);
      // The other sessions' plans are still real — reported as pre-existing
      // advisory noise — but must NOT gate this push.
      assert.match(r.stderr, /pre-existing non-conforming Status/);
      assert.doesNotMatch(r.stderr, /plan-status gate FAILED/);
      // No active plan exists in the fixture, so the hook must reach `finish`
      // without ever invoking the audit script.
      assert.doesNotMatch(r.stderr, /auditing/);
    });
  });

  it('a branch-deletion push (all-zero local sha) is a KNOWN, documented non-fix — still falls back to stale inference', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((ws) => {
      const { local } = buildStaleCheckoutFixture(ws);
      const script = path.join(local, '.hook.sh');
      fs.writeFileSync(script, HOOK_BODY);
      const zero = '0'.repeat(40);
      const stdin = `refs/heads/doomed ${zero} refs/heads/doomed deadbeef${'0'.repeat(32)}\n`;
      const r = spawnSync('bash', [script, 'origin', 'https://example.invalid'], {
        cwd: local,
        encoding: 'utf-8',
        input: stdin,
        env: { ...process.env, CLAUDE_AUDIT_LOOP_DIR: REPO_ROOT, ...SANDBOX_REQUIRE_SCRUB },
      });
      // Nothing was pushed, so there is no local_sha to build a corrected
      // range from — PUSH_BASE/_HEAD stay empty by design (see the HOOK_BODY
      // comment above the read) and the gate falls back to this checkout's
      // own (stale) inference, UNCHANGED from before this fix. This is the
      // deletion case named in the incident report: still blocked. Fixing it
      // would mean skipping the plan-status gate whenever nothing was pushed,
      // which interacts with the maintenance block's "must run before any
      // early exit" ordering invariant (maintenance-hook-snippet.test.mjs) —
      // deliberately left out of this change's scope.
      assert.equal(r.status, 1, `expected the deletion push to still hit the stale-inference block; stderr:\n${r.stderr}`);
      assert.match(r.stderr, /non-conforming Status/);
    });
  });
});
