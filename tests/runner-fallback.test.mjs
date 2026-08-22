import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessRunnerFallback, runnerAssetTokens, FALLBACK_DOC,
  isValidRepoSlug, readRepoArg, resolveRepoSlugFromArg,
} from '../scripts/lib/runner-fallback.mjs';
import { ArgvError } from '../scripts/lib/cli-io.mjs';

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

// H2 (self-hosted-runner-management Cluster B audit round 1): `--repo`
// handling collapsed "flag absent" and "flag present but empty/missing"
// into the same falsy value, so a present-but-empty --repo silently fell
// through to git-remote resolution instead of being rejected.
const argv = (...flags) => ['node', 'actions-runner-doctor.mjs', ...flags];

test('readRepoArg: flag absent entirely', () => {
  assert.deepEqual(readRepoArg(argv('--json')), { present: false, value: null });
  assert.deepEqual(readRepoArg(argv()), { present: false, value: null });
});

test('readRepoArg: --repo <value>', () => {
  assert.deepEqual(readRepoArg(argv('--repo', 'octocat/hello-world')),
    { present: true, value: 'octocat/hello-world' });
});

test('readRepoArg: --repo=<value>', () => {
  assert.deepEqual(readRepoArg(argv('--repo=octocat/hello-world')),
    { present: true, value: 'octocat/hello-world' });
});

test('readRepoArg: present but explicitly empty (--repo "")', () => {
  assert.deepEqual(readRepoArg(argv('--repo', '')), { present: true, value: '' });
});

test('readRepoArg: --repo as the last arg, no value at all', () => {
  assert.deepEqual(readRepoArg(argv('--repo')), { present: true, value: null });
});

test('readRepoArg: --repo immediately followed by another flag is NOT swallowed as the value', () => {
  // Before the fix, argv[i+1] was read unconditionally: `--repo --json` would
  // set repoArg to the literal string "--json" and use it as the repo slug.
  assert.deepEqual(readRepoArg(argv('--repo', '--json')), { present: true, value: null });
});

test('readRepoArg: stops at the POSIX -- terminator', () => {
  assert.deepEqual(readRepoArg(argv('--', '--repo', 'octocat/hello-world')),
    { present: false, value: null });
});

test('isValidRepoSlug: accepts plausible owner/repo slugs', () => {
  assert.ok(isValidRepoSlug('octocat/hello-world'));
  assert.ok(isValidRepoSlug('wartsila-software/some-repo'));
  assert.ok(isValidRepoSlug('a/b'));
  assert.ok(isValidRepoSlug('org-name/repo_name.js'));
});

test('isValidRepoSlug: rejects shell metacharacters and malformed shapes (M3)', () => {
  // M3: the resolved slug is interpolated unescaped into a printed
  // copy-paste `config --url https://github.com/<slug> ...` recipe.
  assert.equal(isValidRepoSlug('octocat/hello-world; rm -rf ~'), false);
  assert.equal(isValidRepoSlug('octocat/hello-world`whoami`'), false);
  assert.equal(isValidRepoSlug('octocat/hello-world && curl evil.example'), false);
  assert.equal(isValidRepoSlug('octocat/hello world'), false);
  assert.equal(isValidRepoSlug('octocat'), false, 'missing the /repo half');
  assert.equal(isValidRepoSlug('/hello-world'), false, 'missing the owner half');
  assert.equal(isValidRepoSlug('octocat/'), false, 'missing the repo half');
  assert.equal(isValidRepoSlug(''), false);
  assert.equal(isValidRepoSlug(null), false);
  assert.equal(isValidRepoSlug(undefined), false);
});

test('resolveRepoSlugFromArg: returns the value for a valid slug', () => {
  assert.equal(resolveRepoSlugFromArg({ present: true, value: 'octocat/hello-world' }), 'octocat/hello-world');
});

test('resolveRepoSlugFromArg: trims surrounding whitespace', () => {
  assert.equal(resolveRepoSlugFromArg({ present: true, value: '  octocat/hello-world  ' }), 'octocat/hello-world');
});

test('resolveRepoSlugFromArg: rejects an empty value with an ArgvError, not a fallthrough', () => {
  assert.throws(
    () => resolveRepoSlugFromArg({ present: true, value: '' }),
    (err) => { assert.ok(err instanceof ArgvError); assert.match(err.message, /requires a value/); return true; },
  );
});

test('resolveRepoSlugFromArg: rejects a missing (null) value with an ArgvError', () => {
  assert.throws(
    () => resolveRepoSlugFromArg({ present: true, value: null }),
    (err) => { assert.ok(err instanceof ArgvError); assert.match(err.message, /requires a value/); return true; },
  );
});

test('resolveRepoSlugFromArg: rejects a malformed slug with an ArgvError naming the offending value', () => {
  assert.throws(
    () => resolveRepoSlugFromArg({ present: true, value: 'octocat/hello-world; rm -rf ~' }),
    (err) => {
      assert.ok(err instanceof ArgvError);
      assert.match(err.message, /not a valid GitHub owner\/repository slug/);
      return true;
    },
  );
});
