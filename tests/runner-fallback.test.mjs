import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRunnerFallback, runnerAssetTokens, FALLBACK_DOC } from '../scripts/lib/runner-fallback.mjs';

test('assessRunnerFallback: registration success dominates even when permissions were unreadable', () => {
  const v = assessRunnerFallback({ actionsEnabled: null, canRegisterSelfHosted: true });
  assert.equal(v.verdict, 'self-hosted-viable');
  assert.match(v.headline, /self-serve/);
});

test('assessRunnerFallback: actions disabled entirely, cannot register', () => {
  const v = assessRunnerFallback({ actionsEnabled: false, canRegisterSelfHosted: false });
  assert.equal(v.verdict, 'actions-disabled');
  assert.ok(v.guidance.some((g) => g.includes(FALLBACK_DOC)));
});

test('assessRunnerFallback: permissions unreadable AND registration failed -> unknown, not a false no-admin-rights claim', () => {
  const v = assessRunnerFallback({ actionsEnabled: null, canRegisterSelfHosted: false });
  assert.equal(v.verdict, 'unknown');
});

test('assessRunnerFallback: actions enabled but registration 403s -> no-admin-rights, carries the gh error text', () => {
  const v = assessRunnerFallback({
    actionsEnabled: true,
    canRegisterSelfHosted: false,
    registrationError: 'HTTP 403: Resource not accessible by integration',
  });
  assert.equal(v.verdict, 'no-admin-rights');
  assert.ok(v.guidance.some((g) => g.includes('403')));
});

test('assessRunnerFallback: no registrationError given still produces guidance without a stray null entry', () => {
  const v = assessRunnerFallback({ actionsEnabled: true, canRegisterSelfHosted: false });
  assert.equal(v.verdict, 'no-admin-rights');
  assert.ok(v.guidance.every((g) => typeof g === 'string' && g.length > 0));
});

test('runnerAssetTokens maps known platform/arch pairs', () => {
  assert.deepEqual(runnerAssetTokens('win32', 'x64'), { os: 'win', arch: 'x64' });
  assert.deepEqual(runnerAssetTokens('linux', 'arm64'), { os: 'linux', arch: 'arm64' });
  assert.deepEqual(runnerAssetTokens('darwin', 'x64'), { os: 'osx', arch: 'x64' });
});

test('runnerAssetTokens returns null for unsupported platform/arch', () => {
  assert.equal(runnerAssetTokens('sunos', 'x64'), null);
  assert.equal(runnerAssetTokens('linux', 'ia32'), null);
});
