/**
 * @fileoverview Tier-1 deterministic-seam tests for scripts/lib/push-range.mjs.
 *
 * The bug this module exists to prevent is a SILENT one: a gate that reports
 * "clean" after diffing a narrower range than the operator believes. So the
 * assertions below care as much about the `source`/`trusted` labelling and the
 * refusal paths as about the happy path — a wrong range that announces itself
 * is a bug report; a wrong range that reads as clean is a shipped defect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePushRange, describePushRange, PUSH_RANGE_ENV } from '../scripts/lib/push-range.mjs';

/** Build a fake git runner from an argv-prefix → output map. */
function fakeGit(responses) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    for (const [prefix, out] of Object.entries(responses)) {
      if (args.join(' ').startsWith(prefix)) return out;
    }
    return null;
  };
  run.calls = calls;
  return run;
}

const ENV_EMPTY = {};

test('explicit env range wins and is marked trusted', () => {
  const run = fakeGit({ 'rev-parse --verify --quiet abc123^{commit}': 'abc123' });
  const r = resolvePushRange({
    env: { [PUSH_RANGE_ENV.BASE]: 'abc123', [PUSH_RANGE_ENV.HEAD]: 'def456' },
    run,
  });
  assert.equal(r.ok, true);
  assert.equal(r.base, 'abc123');
  assert.equal(r.head, 'def456');
  assert.equal(r.source, 'explicit');
  assert.equal(r.trusted, true);
});

test('explicit base defaults head to HEAD when only base is supplied', () => {
  const run = fakeGit({ 'rev-parse --verify --quiet abc123^{commit}': 'abc123' });
  const r = resolvePushRange({ env: { [PUSH_RANGE_ENV.BASE]: 'abc123' }, run });
  assert.equal(r.ok, true);
  assert.equal(r.head, 'HEAD');
});

test('explicit base is preferred even when an upstream exists', () => {
  // Regression guard: the whole point is that the hook's answer beats inference.
  const run = fakeGit({
    'rev-parse --verify --quiet abc123^{commit}': 'abc123',
    'rev-parse --verify --quiet @{upstream}': 'origin/main',
  });
  const r = resolvePushRange({ env: { [PUSH_RANGE_ENV.BASE]: 'abc123' }, run });
  assert.equal(r.source, 'explicit');
});

test('malformed explicit base is rejected, NOT silently demoted to inference', () => {
  // The silent-narrowing class: falling back here would hand the caller a
  // one-commit range while it believes it asked for a five-commit one.
  const run = fakeGit({ 'rev-parse --verify --quiet @{upstream}': 'origin/main' });
  const r = resolvePushRange({ env: { [PUSH_RANGE_ENV.BASE]: 'a b; rm -rf /' }, run });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-explicit');
});

test('unresolvable explicit base is a hard failure', () => {
  const run = fakeGit({}); // rev-parse returns null → not in this checkout
  const r = resolvePushRange({ env: { [PUSH_RANGE_ENV.BASE]: 'deadbeef' }, run });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unresolvable-explicit');
});

test('requireExplicit refuses to infer', () => {
  const run = fakeGit({ 'rev-parse --verify --quiet @{upstream}': 'origin/main' });
  const r = resolvePushRange({ env: ENV_EMPTY, run, requireExplicit: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'inference-forbidden');
});

test('requireExplicit is settable via env', () => {
  const run = fakeGit({ 'rev-parse --verify --quiet @{upstream}': 'origin/main' });
  const r = resolvePushRange({ env: { [PUSH_RANGE_ENV.REQUIRED]: '1' }, run });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'inference-forbidden');
});

test('falls back to upstream, marked untrusted', () => {
  const run = fakeGit({ 'rev-parse --verify --quiet @{upstream}': 'origin/main' });
  const r = resolvePushRange({ env: ENV_EMPTY, run });
  assert.equal(r.ok, true);
  assert.equal(r.base, '@{upstream}');
  assert.equal(r.source, 'upstream');
  assert.equal(r.trusted, false);
});

test('no upstream falls back to fork-point, not HEAD~1', () => {
  // An unpushed branch's real base is where it diverged. HEAD~1 here would
  // scope a multi-commit branch to its tip.
  const run = fakeGit({ 'merge-base origin/main HEAD': 'f00ba7' });
  const r = resolvePushRange({ env: ENV_EMPTY, run });
  assert.equal(r.ok, true);
  assert.equal(r.base, 'f00ba7');
  assert.equal(r.source, 'fork-point');
  assert.equal(r.trusted, false);
});

test('HEAD~1 is the last resort, and says so', () => {
  const run = fakeGit({ 'rev-parse --verify --quiet HEAD~1': 'aaa111' });
  const r = resolvePushRange({ env: ENV_EMPTY, run });
  assert.equal(r.source, 'previous-commit');
  assert.equal(r.trusted, false);
});

test('root commit yields no-base rather than a range that reads as clean', () => {
  const run = fakeGit({});
  const r = resolvePushRange({ env: ENV_EMPTY, run });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-base');
});

test('a detached clean checkout never silently resolves to HEAD~1 when a range was supplied', () => {
  // The worktree scenario end-to-end: no upstream, never dirty. With the hook's
  // range present the result must be the full range, not the tip commit.
  const run = fakeGit({ 'rev-parse --verify --quiet base99^{commit}': 'base99' });
  const r = resolvePushRange({
    env: { [PUSH_RANGE_ENV.BASE]: 'base99', [PUSH_RANGE_ENV.HEAD]: 'tip99' },
    run,
  });
  assert.equal(r.base, 'base99');
  assert.equal(r.head, 'tip99');
  assert.equal(r.trusted, true);
});

test('describePushRange surfaces inference in the label', () => {
  const run = fakeGit({ 'rev-parse --verify --quiet @{upstream}': 'origin/main' });
  const inferred = resolvePushRange({ env: ENV_EMPTY, run });
  assert.match(describePushRange(inferred), /inferred/);

  const explicitRun = fakeGit({ 'rev-parse --verify --quiet abc^{commit}': 'abc' });
  const explicit = resolvePushRange({ env: { [PUSH_RANGE_ENV.BASE]: 'abc' }, run: explicitRun });
  assert.doesNotMatch(describePushRange(explicit), /inferred/);
});

test('describePushRange reports unresolved ranges', () => {
  const r = resolvePushRange({ env: ENV_EMPTY, run: fakeGit({}) });
  assert.match(describePushRange(r), /unresolved \(no-base\)/);
});
