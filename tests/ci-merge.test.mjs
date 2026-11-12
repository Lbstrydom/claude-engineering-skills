import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCheck, exitCodeFor, parseNameList, processPr, renderReport, runQueue, repoFromUrl } from '../scripts/lib/ci-merge.mjs';
import { buildOptions, main, parseArgv } from '../scripts/ci-merge.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ci-merge.mjs');

const run = (name, conclusion = 'SUCCESS', status = 'COMPLETED') => ({ __typename: 'CheckRun', name, status, conclusion });
const url = (n) => `https://github.com/o/r/pull/${n}`;

/**
 * A fake `gh` driven by a script of PR views. `views` is consumed one entry per `pr view`; the last repeats.
 * Records every non-view call so a test can assert what was (not) done.
 */
function fakeGh({ views, merge = { status: 0 }, update = { status: 0 }, api = null, parents = null }) {
  const calls = []; let i = 0; const seen = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      const raw = views[Math.min(i, views.length - 1)]; i += 1;
      const v = typeof raw === 'function' ? raw() : raw;
      if (v.headRefOid && !seen.includes(v.headRefOid)) seen.push(v.headRefOid);
      return { status: 0, stdout: JSON.stringify(v), stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'merge') return { stdout: '', stderr: '', ...merge };
    if (args[0] === 'pr' && args[1] === 'update-branch') return { stdout: '', stderr: '', ...update };
    if (args[0] === 'api' && /\/commits\/[0-9a-f]+$/.test(args[1])) return { status: 0, stdout: JSON.stringify(parents ?? seen), stderr: '' };
    if (args[0] === 'api') return api ? api(args) : { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { gh, calls, mergeCalls: () => calls.filter((c) => c[1] === 'merge'), updateCalls: () => calls.filter((c) => c[1] === 'update-branch') };
}
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };
const view = (o = {}) => ({ number: 7, url: url(7), state: 'OPEN', isDraft: false, headRefOid: 'a'.repeat(40), mergeStateStatus: 'CLEAN', statusCheckRollup: [run('ci'), run('gitleaks')], mergeCommit: null, ...o });
const merged = (o = {}) => view({ state: 'MERGED', mergeCommit: { oid: 'm'.repeat(40) }, ...o });
const go = (f, opts = {}, ref = 7) => processPr(ref, { merge: true, settleMs: 0, ...opts }, { gh: f.gh, ...clock(), log: () => {} });

describe('check classification', () => {
  test('pending, pass, fail for check runs and status contexts', () => {
    assert.equal(classifyCheck(run('a')).state, 'pass');
    assert.equal(classifyCheck(run('a', 'SKIPPED')).state, 'pass');
    assert.equal(classifyCheck(run('a', null, 'IN_PROGRESS')).state, 'pending');
    assert.equal(classifyCheck(run('a', 'CANCELLED')).state, 'fail');
    assert.equal(classifyCheck(run('a', 'TIMED_OUT')).state, 'fail');
    assert.equal(classifyCheck({ __typename: 'StatusContext', context: 'x', state: 'PENDING' }).state, 'pending');
    assert.equal(classifyCheck({ __typename: 'StatusContext', context: 'x', state: 'FAILURE' }).state, 'fail');
    assert.equal(classifyCheck({ __typename: 'StatusContext', context: 'x', state: 'SUCCESS' }).state, 'pass');
  });
  test('a malformed entry is pending, never a pass', () => {
    assert.equal(classifyCheck(null).state, 'pending');
    assert.equal(classifyCheck({ name: 'x', status: 'COMPLETED' }).state, 'fail');
  });
  test('helpers', () => {
    assert.deepEqual([...parseNameList(['a, b', 'c'])], ['a', 'b', 'c']);
    assert.equal(repoFromUrl(url(3)), 'o/r');
  });
});

describe('waiting on every check', () => {
  test('keeps waiting while ANY check is pending, even when the named one is green (WCA #1261)', async () => {
    const f = fakeGh({ views: [
      view({ statusCheckRollup: [run('ci'), run('gitleaks', null, 'IN_PROGRESS')] }),
      view({ statusCheckRollup: [run('ci'), run('gitleaks', null, 'QUEUED')] }),
      view(),
      merged(),
    ] });
    const r = await go(f);
    assert.equal(r.verdict, 'merged');
    assert.equal(f.mergeCalls().length, 1);
  });
  test('wait-only never merges or updates, and gives a verdict per check', async () => {
    const f = fakeGh({ views: [view({ mergeStateStatus: 'BEHIND' })] });
    const r = await go(f, { merge: false });
    assert.equal(r.verdict, 'green');
    assert.equal(r.mergeState, 'BEHIND');
    assert.deepEqual(r.checks.map((c) => [c.name, c.state]), [['ci', 'pass'], ['gitleaks', 'pass']]);
    assert.equal(f.mergeCalls().length + f.updateCalls().length, 0);
  });
  test('zero checks is not green: refused after the grace, never merged', async () => {
    const f = fakeGh({ views: [view({ statusCheckRollup: [] })] });
    const r = await go(f);
    assert.equal(r.reason, 'no-checks-reported');
    assert.equal(r.ok, false);
    assert.equal(f.mergeCalls().length, 0);
  });
  test('an expected check that never registers blocks the verdict', async () => {
    const f = fakeGh({ views: [view()] });
    const r = await go(f, { expect: new Set(['deploy-preview']) });
    assert.equal(r.reason, 'expected-check-missing');
    assert.deepEqual(r.pending, ['deploy-preview']);
    assert.equal(f.mergeCalls().length, 0);
  });
});

describe('failures and the allowed list', () => {
  test('a red check refuses the merge (gitleaks red, WCA #1278), even when mergeState says UNSTABLE', async () => {
    const f = fakeGh({ views: [view({ mergeStateStatus: 'UNSTABLE', statusCheckRollup: [run('ci'), run('gitleaks', 'FAILURE')] })] });
    const r = await go(f);
    assert.equal(r.verdict, 'failed');
    assert.deepEqual(r.failures, ['gitleaks']);
    assert.equal(f.mergeCalls().length, 0);
  });
  test('UNSTABLE merges only when EVERY failing check is on the allowed list', async () => {
    const roll = [run('ci'), run('lint', 'FAILURE'), run('gitleaks', 'FAILURE')];
    const partial = fakeGh({ views: [view({ mergeStateStatus: 'UNSTABLE', statusCheckRollup: roll })] });
    assert.equal((await go(partial, { allowFail: new Set(['lint']) })).verdict, 'failed');
    assert.equal(partial.mergeCalls().length, 0);
    const all = fakeGh({ views: [view({ mergeStateStatus: 'UNSTABLE', statusCheckRollup: roll }), merged()] });
    const r = await go(all, { allowFail: new Set(['lint', 'gitleaks']) });
    assert.equal(r.verdict, 'merged');
    assert.deepEqual(r.allowedFailures.sort(), ['gitleaks', 'lint']);
    assert.equal(all.mergeCalls().length, 1);
  });
  test('allow-list matches the exact name only', async () => {
    const f = fakeGh({ views: [view({ statusCheckRollup: [run('lint-extra', 'FAILURE'), run('ci')] })] });
    assert.equal((await go(f, { allowFail: new Set(['lint']) })).verdict, 'failed');
  });
  test('UNSTABLE with no failing check to explain it is refused', async () => {
    const f = fakeGh({ views: [view({ mergeStateStatus: 'UNSTABLE' })] });
    assert.equal((await go(f)).reason, 'unstable-unexplained');
    assert.equal(f.mergeCalls().length, 0);
  });
  test('report mode marks allowed failures green-with-allowed-failures', async () => {
    const f = fakeGh({ views: [view({ statusCheckRollup: [run('ci'), run('lint', 'FAILURE')] })] });
    const r = await go(f, { merge: false, allowFail: new Set(['lint']) });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'green-with-allowed-failures');
  });
  test('fail-fast stops while others are still pending; default waits for all', async () => {
    const roll = [run('a', 'FAILURE'), run('b', null, 'IN_PROGRESS')];
    const fast = await go(fakeGh({ views: [view({ statusCheckRollup: roll })] }), { merge: false, failFast: true });
    assert.equal(fast.verdict, 'failed');
    const slow = await go(fakeGh({ views: [view({ statusCheckRollup: roll }), view({ statusCheckRollup: [run('a', 'FAILURE'), run('b')] })] }), { merge: false });
    assert.equal(slow.verdict, 'failed');
    assert.deepEqual(slow.checks.map((c) => c.state), ['fail', 'pass']);
  });
});

describe('merge state handling', () => {
  test('merges with --squash --match-head-commit <the head the checks passed on>', async () => {
    const f = fakeGh({ views: [view(), merged()] });
    const r = await go(f, { repo: 'o/r' });
    assert.deepEqual(f.mergeCalls()[0], ['pr', 'merge', '7', '--repo', 'o/r', '--squash', '--match-head-commit', 'a'.repeat(40)]);
    assert.equal(r.mergeCommit, 'm'.repeat(40));
  });
  test('BEHIND -> update-branch -> re-wait on the NEW head -> merge with the new sha', async () => {
    const h1 = 'a'.repeat(40); const h2 = 'b'.repeat(40);
    const f = fakeGh({ views: [
      view({ headRefOid: h1, mergeStateStatus: 'BEHIND' }),
      view({ headRefOid: h1, mergeStateStatus: 'BEHIND' }), // update accepted, head not moved yet: must NOT update twice
      view({ headRefOid: h2, mergeStateStatus: 'BLOCKED', statusCheckRollup: [run('ci', null, 'IN_PROGRESS')] }),
      view({ headRefOid: h2 }),
      merged({ headRefOid: h2 }),
    ] });
    const r = await go(f);
    assert.equal(r.verdict, 'merged');
    assert.equal(f.updateCalls().length, 1);
    assert.equal(f.mergeCalls()[0].at(-1), h2);
    assert.deepEqual(r.headChanges, [{ from: h1, to: h2 }]);
  });
  test('BEHIND in a loop stops at maxUpdates', async () => {
    let n = 0;
    const f = fakeGh({ views: [() => view({ headRefOid: String(n++).padStart(40, '0'), mergeStateStatus: 'BEHIND' })] });
    const r = await go(f, { maxUpdates: 2 });
    assert.equal(r.reason, 'behind-after-max-updates');
    assert.equal(f.mergeCalls().length, 0);
  });
  test('DIRTY, draft and not-open are refused', async () => {
    assert.equal((await go(fakeGh({ views: [view({ mergeStateStatus: 'DIRTY' })] }))).reason, 'conflicts');
    assert.equal((await go(fakeGh({ views: [view({ isDraft: true })] }))).reason, 'draft');
    assert.equal((await go(fakeGh({ views: [view({ state: 'MERGED' })] }))).reason, 'not-open:MERGED');
  });
  test('BLOCKED once every check is green is polled, then refused', async () => {
    const f = fakeGh({ views: [view({ mergeStateStatus: 'BLOCKED' })] });
    const r = await go(f);
    assert.equal(r.reason, 'blocked');
    assert.equal(f.mergeCalls().length, 0);
  });
  test('BLOCKED that clears (a required check registered late) merges', async () => {
    const f = fakeGh({ views: [view({ mergeStateStatus: 'BLOCKED' }), view(), merged()] });
    assert.equal((await go(f)).verdict, 'merged');
  });
  test('a merge rejected by --match-head-commit is reported as head-moved, not merged', async () => {
    const f = fakeGh({ views: [view()], merge: { status: 1, stderr: 'Head branch was modified. Review and try the merge again.' } });
    const r = await go(f);
    assert.equal(r.reason, 'head-moved');
    assert.equal(r.merged, false);
  });
  test('a merge that did not land is not reported as merged', async () => {
    const f = fakeGh({ views: [view(), view()] });
    assert.equal((await go(f)).reason, 'merge-not-confirmed');
  });
});

describe('a head that changes mid-wait', () => {
  const h1 = 'a'.repeat(40); const h2 = 'c'.repeat(40);
  const pending = (h) => view({ headRefOid: h, statusCheckRollup: [run('ci', null, 'IN_PROGRESS')] });
  test('merge mode refuses when somebody else moved the head after the decision', async () => {
    const f = fakeGh({ views: [pending(h1), view({ headRefOid: h2 })] });
    const r = await go(f);
    assert.equal(r.reason, 'head-moved');
    assert.equal(f.mergeCalls().length, 0);
  });
  test('--follow-head re-waits on the new head and merges that sha', async () => {
    const f = fakeGh({ views: [pending(h1), pending(h2), view({ headRefOid: h2 }), merged()] });
    const r = await go(f, { followHead: true });
    assert.equal(r.verdict, 'merged');
    assert.equal(f.mergeCalls()[0].at(-1), h2);
  });
  test('report mode follows the new head and records the move', async () => {
    const f = fakeGh({ views: [pending(h1), view({ headRefOid: h2 })] });
    const r = await go(f, { merge: false });
    assert.equal(r.head, h2);
    assert.equal(r.headChanges.length, 1);
    assert.equal(r.ok, true);
  });
  test('verdicts are never taken from the old head: green on h1 then h2 pending keeps waiting', async () => {
    const f = fakeGh({ views: [view({ headRefOid: h1 }), pending(h2), view({ headRefOid: h2 })] });
    const r = await go(f, { merge: false });
    assert.equal(r.head, h1); // report mode returned on the first terminal read: nothing moved yet
    const g = fakeGh({ views: [pending(h1), pending(h2), view({ headRefOid: h2 })] });
    assert.equal((await go(g, { merge: false })).head, h2);
  });
});

describe('audit fixes', () => {
  const h1 = 'a'.repeat(40); const h2 = 'b'.repeat(40);
  test('a slow workflow that registers late is not missed: green waits for the set of check names to hold still', async () => {
    const f = fakeGh({ views: [view({ statusCheckRollup: [run('ci')] }), view({ statusCheckRollup: [run('ci')] }), view({ statusCheckRollup: [run('ci'), run('gitleaks', 'FAILURE')] }), view({ statusCheckRollup: [run('ci'), run('gitleaks', 'FAILURE')] })] });
    const r = await go(f, { merge: false, settleMs: 60_000 });
    assert.equal(r.verdict, 'failed');
    assert.deepEqual(r.failures, ['gitleaks']);
  });
  test('--head refuses a PR whose head is a different commit than the one pushed', async () => {
    const f = fakeGh({ views: [view({ headRefOid: h2 })] });
    const r = await go(f, { merge: false, expectHead: h1.slice(0, 12) });
    assert.equal(r.reason, 'head-mismatch');
    const ok = await go(fakeGh({ views: [view({ headRefOid: h1 })] }), { merge: false, expectHead: h1.slice(0, 12) });
    assert.equal(ok.verdict, 'green');
  });
  test('after update-branch, a new head that is NOT a child of the old head is a foreign push and is refused', async () => {
    const f = fakeGh({ views: [view({ headRefOid: h1, mergeStateStatus: 'BEHIND' }), view({ headRefOid: h2 })], parents: ['f'.repeat(40), 'e'.repeat(40)] });
    const r = await go(f);
    assert.equal(r.reason, 'head-moved');
    assert.equal(f.mergeCalls().length, 0);
  });
  test('a one-parent child of the old head (an ordinary push) is not an update-branch', async () => {
    const f = fakeGh({ views: [view({ headRefOid: h1, mergeStateStatus: 'BEHIND' }), view({ headRefOid: h2 })], parents: [h1] });
    assert.equal((await go(f)).reason, 'head-moved');
  });
  test('--head pins every read: a later head in report mode is refused, not followed', async () => {
    const f = fakeGh({ views: [view({ headRefOid: h1, statusCheckRollup: [run('ci', null, 'IN_PROGRESS')] }), view({ headRefOid: h2 })] });
    const r = await go(f, { merge: false, expectHead: h1.slice(0, 12) });
    assert.equal(r.reason, 'head-mismatch');
  });
  test('a check that goes pending again restarts the settle window', async () => {
    const done = [run('ci'), run('e2e')]; const rerun = [run('ci'), run('e2e', null, 'IN_PROGRESS')];
    const f = fakeGh({ views: [view({ statusCheckRollup: done }), view({ statusCheckRollup: done }), view({ statusCheckRollup: rerun }), view({ statusCheckRollup: [run('ci'), run('e2e', 'FAILURE')] })] });
    const r = await go(f, { merge: false, settleMs: 40_000 });
    assert.equal(r.verdict, 'failed');
  });
  test('an unreadable parent lookup counts as NOT ours', async () => {
    const f = fakeGh({ views: [view({ headRefOid: h1, mergeStateStatus: 'BEHIND' }), view({ headRefOid: h2 })] });
    const base = f.gh;
    f.gh = (a) => (a[0] === 'api' ? { status: 1, stdout: '', stderr: 'boom' } : base(a));
    assert.equal((await go(f)).reason, 'head-moved');
  });
  test('merge succeeded but the read-back failed: NOT reported merged, exits 1', async () => {
    let n = 0;
    const gh = (a) => {
      if (a[1] === 'view') { n += 1; return n === 1 ? { status: 0, stdout: JSON.stringify(view()), stderr: '' } : { status: 1, stdout: '', stderr: 'HTTP 502' }; }
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = await processPr(7, { merge: true, settleMs: 0 }, { gh, ...clock(), log: () => {} });
    assert.equal(r.verdict, 'merge-unconfirmed');
    assert.equal(r.merged, false);
    assert.equal(exitCodeFor([r]), 1);
  });
  test('an accepted update whose head never moves times out at the per-PR budget', async () => {
    const f = fakeGh({ views: [view({ mergeStateStatus: 'BEHIND' })] });
    const r = await go(f, { timeoutMs: 100_000, updateSettleMs: 10_000_000 });
    assert.equal(r.verdict, 'timeout');
  });
  test('a timeout on the first queued PR exits 3, not 1', async () => {
    const gh = () => ({ status: 0, stdout: JSON.stringify(view({ statusCheckRollup: [run('ci', null, 'IN_PROGRESS')] })), stderr: '' });
    const res = await runQueue([1, 2], { merge: true, timeoutMs: 60_000 }, { gh, ...clock(), log: () => {} });
    assert.deepEqual(res.map((x) => x.verdict), ['timeout', 'not-attempted']);
    assert.equal(exitCodeFor(res), 3);
  });
  test('deploy lookup: persistent gh failure is unmeasured with the error, not "never appeared"', async () => {
    const f = fakeGh({ views: [view(), merged()], api: () => ({ status: 1, stdout: '', stderr: 'HTTP 403: forbidden' }) });
    const r = await go(f, { deployWait: 'deploy' });
    assert.equal(r.deploy.state, 'unmeasured');
    assert.match(r.deploy.reason, /403/);
  });
  test('boolean flags reject an equals value instead of discarding it', () => {
    assert.throws(() => parseArgv(['--pr', '1', '--merge=false']), /takes no value/);
    assert.throws(() => parseArgv(['--pr', '1', '--wait-only', '--follow-head=false']), /takes no value/);
  });
  test('--head needs one PR and a hex sha', () => {
    assert.throws(() => buildOptions(parseArgv(['--pr', '1,2', '--wait-only', '--head', 'abcdef1'])), /exactly one/);
    assert.throws(() => buildOptions(parseArgv(['--pr', '1', '--wait-only', '--head', 'zzz'])), /hex/);
  });
});

describe('timeouts', () => {
  test('a timeout exits 3 and names what is still pending', async () => {
    const f = fakeGh({ views: [view({ statusCheckRollup: [run('ci'), run('e2e', null, 'IN_PROGRESS'), run('build', null, 'QUEUED')] })] });
    const r = await go(f, { timeoutMs: 100_000, pollMs: 20_000 });
    assert.equal(r.verdict, 'timeout');
    assert.deepEqual(r.pending, ['e2e', 'build']);
    assert.equal(exitCodeFor([r]), 3);
    assert.match(renderReport([r]), /still pending: e2e, build/);
    assert.equal(f.mergeCalls().length, 0);
  });
  test('gh failing on every read is refused loudly, not read as pending forever', async () => {
    const gh = () => ({ status: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' });
    const r = await processPr(7, { merge: false }, { gh, ...clock(), log: () => {} });
    assert.equal(r.reason, 'gh-error');
    assert.match(r.detail, /401/);
  });
});

describe('deploy wait', () => {
  const api = (seq) => { let i = 0; return () => ({ status: 0, stdout: seq[Math.min(i++, seq.length - 1)].map((c) => JSON.stringify(c)).join('\n'), stderr: '' }); };
  test('waits for the named check run on the merge commit', async () => {
    const f = fakeGh({ views: [view(), merged()], api: api([[], [{ name: 'deploy', status: 'in_progress' }], [{ name: 'deploy', status: 'completed', conclusion: 'success' }]]) });
    const r = await go(f, { deployWait: 'deploy' });
    assert.equal(r.deploy.state, 'pass');
    assert.ok(f.calls.at(-1).includes(`repos/o/r/commits/${'m'.repeat(40)}/check-runs?per_page=100`));
    assert.ok(f.calls.at(-1).includes('--paginate'));
  });
  test('a failed deploy keeps merged:true and exits 1', async () => {
    const f = fakeGh({ views: [view(), merged()], api: api([[{ name: 'deploy', status: 'completed', conclusion: 'failure' }]]) });
    const r = await go(f, { deployWait: 'deploy' });
    assert.equal(r.merged, true);
    assert.equal(r.deploy.state, 'fail');
    assert.equal(exitCodeFor([r]), 1);
  });
  test('a deploy that never appears times out (exit 3)', async () => {
    const f = fakeGh({ views: [view(), merged()] });
    const r = await go(f, { deployWait: 'deploy', deployTimeoutMs: 60_000 });
    assert.equal(r.deploy.state, 'timeout');
    assert.equal(exitCodeFor([r]), 3);
  });
});

describe('serial queue', () => {
  test('merges PRs one at a time, in order, each on its own head', async () => {
    const order = [];
    const gh = (args) => {
      if (args[1] === 'view') {
        const n = args[2];
        const done = order.includes(`merge ${n}`);
        return { status: 0, stdout: JSON.stringify(done ? merged({ number: Number(n), url: url(n), headRefOid: n.repeat(40).slice(0, 40) }) : view({ number: Number(n), url: url(n), headRefOid: n.repeat(40).slice(0, 40) })), stderr: '' };
      }
      if (args[1] === 'merge') { order.push(`merge ${args[2]}`); return { status: 0, stdout: '', stderr: '' }; }
      return { status: 1, stdout: '', stderr: 'x' };
    };
    const res = await runQueue([1, 2, 3], { merge: true }, { gh, ...clock(), log: () => {} });
    assert.deepEqual(order, ['merge 1', 'merge 2', 'merge 3']);
    assert.ok(res.every((r) => r.merged));
  });
  test('merge mode stops at the first failure; the rest are not-attempted, not skipped silently', async () => {
    const done = new Set();
    const gh = (args) => {
      if (args[1] === 'merge') { done.add(args[2]); return { status: 0, stdout: '', stderr: '' }; }
      const n = args[2];
      const base = view({ number: Number(n), url: url(n), statusCheckRollup: n === '2' ? [run('ci', 'FAILURE')] : [run('ci')] });
      return { status: 0, stdout: JSON.stringify(done.has(n) ? { ...base, state: 'MERGED', mergeCommit: { oid: 'm'.repeat(40) } } : base), stderr: '' };
    };
    const res = await runQueue([1, 2, 3], { merge: true }, { gh, ...clock(), log: () => {} });
    assert.deepEqual(res.map((r) => r.verdict), ['merged', 'failed', 'not-attempted']);
    assert.equal(exitCodeFor(res), 1);
    assert.deepEqual([...done], ['1']);
  });
  test('report mode visits every PR even when one is red', async () => {
    const gh = (args) => ({ status: 0, stdout: JSON.stringify(view({ number: Number(args[2]), statusCheckRollup: args[2] === '1' ? [run('ci', 'FAILURE')] : [run('ci')] })), stderr: '' });
    const res = await runQueue([1, 2], { merge: false }, { gh, ...clock(), log: () => {} });
    assert.deepEqual(res.map((r) => r.verdict), ['failed', 'green']);
  });
});

describe('CLI surface', () => {
  test('flags are validated before anything runs', () => {
    const bad = (argv, re) => assert.throws(() => buildOptions(parseArgv(argv)), re);
    bad([], /--pr/);
    bad(['--pr', '1'], /say what you want/);
    bad(['--pr', '1', '--merge', '--wait-only'], /mutually exclusive/);
    bad(['--pr', 'abc', '--wait-only'], /not a PR number/);
    bad(['--pr', '1', '--wait-only', '--deploy-wait', 'x'], /only with --merge/);
    bad(['--pr', '1', '--wait-only', '--timeout-min', '0'], /positive/);
  });
  test('an unknown flag exits 2 and nothing is merged', () => {
    const r = spawnSync(process.execPath, [CLI, '--pr', '1', '--merge', '--yolo'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag/);
  });
  test('--selfcheck-relocation prints OK', () => {
    const r = spawnSync(process.execPath, [CLI, '--selfcheck-relocation'], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), 'OK');
  });
  test('main emits one envelope with a report, and the exit code survives emit', async () => {
    const f = fakeGh({ views: [view({ statusCheckRollup: [run('ci'), run('e2e', null, 'IN_PROGRESS')] })] });
    let env; const prev = process.exitCode;
    const code = await main(['--pr', '7', '--wait-only', '--timeout-min', '1', '--poll-sec', '20'], { gh: f.gh, ...clock(), log: () => {}, emit: (e) => { env = e; } });
    assert.equal(code, 3);
    assert.equal(env.ok, false);
    assert.equal(env.results[0].verdict, 'timeout');
    assert.match(env.report, /still pending: e2e/);
    process.exitCode = prev;
  });
  test('--gh-account that cannot be read fails closed with a usage error', async () => {
    const spawn = () => ({ status: 1, stdout: '', stderr: 'no' });
    await assert.rejects(() => main(['--pr', '1', '--wait-only', '--gh-account', 'nobody'], { env: { PATH: process.env.PATH }, gh: () => ({}) , spawn }), (e) => e.code === 'ARGV_ERROR' || /gh-account/.test(e.message));
  });
});
