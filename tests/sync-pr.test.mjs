/**
 * @fileoverview `lib/sync-pr.mjs` — the planner's decision table and the
 * executor's command sequence, both against a recorded fake runner. The two
 * rules that carry the design are pinned by name: a receipt-only change earns
 * no PR (else every upstream push spawns a consumer PR), and a checkout that
 * is off its base branch or ahead of origin is refused, never "handled".
 * The fresh-base and refused-push rules are pinned on REAL git in
 * sync-pr-git.test.mjs; here, their pure halves.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SKIP_REASON, branchNameFor, buildPrText, planConsumerPr, runConsumerPr,
  parseGhAccounts, isRepoNotResolvable, parseSymrefHead, parseFailingTests,
  SUPERSEDE_KEEP_REASON, SUPERSEDE_LIST_LIMIT, parseOpenSyncPrs, parseNameStatus, decideSupersession, supersedeOlderSyncPrs,
  SUPERSEDE_RETRY_SKIP, retrySupersession, supersessionRetryTarget,
} from '../scripts/lib/sync-pr.mjs';
import { parseArgs } from '../scripts/sync-pr.mjs';
import { RECEIPT_PATH } from '../scripts/lib/sync-receipt.mjs';
import { OWNED_SIDECAR_RELATIVE_PATH, buildOwnedSidecar } from '../scripts/lib/sync-owned-sidecar.mjs';

const SHA = 'cb0903cfaa30eb2d3e87bd42f3f31bb1db850083';
const MANIFEST = { repo: 'Lbstrydom/claude-engineering-skills', commitSha: SHA };
const entry = (p, origPath = null) => ({ status: ' M', path: p, origPath });
const classified = (syncOwned, needsReview = [], extra = {}) => ({
  ok: true, clean: false, syncOwned, needsReview, other: [], manifestFound: true, degraded: false, partial: false, blindTo: [], ...extra,
});
const ORIGIN_SHA = '1e538526d0000000000000000000000000000000';
const facts = { baseBranch: 'main', baseSha: ORIGIN_SHA, currentBranch: 'main', aheadCount: 0, behindCount: 0, upstreamChanged: [], branchExists: false };
const plan = (over = {}) => planConsumerPr({
  consumerName: 'wine-cellar-app',
  classified: classified([entry(RECEIPT_PATH), entry('.claude/skills/plan/SKILL.md')]),
  manifest: MANIFEST,
  ...facts,
  ...over,
});

describe('branchNameFor', () => {
  it('is deterministic from the manifest sha, so a re-run cannot open a second PR for the same sync', () => {
    assert.equal(branchNameFor(SHA), 'chore/sync-cb0903cf');
    assert.equal(branchNameFor(SHA), branchNameFor(SHA));
  });
});

describe('planConsumerPr — decision table', () => {
  it('opens a PR when the tracked surface changed, adding the receipt alongside', () => {
    const p = plan();
    assert.equal(p.action, 'pr');
    assert.equal(p.branch, 'chore/sync-cb0903cf');
    assert.deepEqual(p.addPaths, ['.claude/skills/plan/SKILL.md', RECEIPT_PATH]);
    assert.deepEqual(p.surface, ['.claude/skills/plan/SKILL.md']);
    assert.match(p.title, /^chore\(sync\): bundle sync from Lbstrydom\/claude-engineering-skills cb0903cf$/);
    assert.equal(p.startPoint, ORIGIN_SHA, 'the branch forks from the fetched origin sha, never "HEAD"');
  });

  it('a receipt-only change earns NO PR (the receipt changes on every sync run)', () => {
    const p = plan({ classified: classified([entry(RECEIPT_PATH)]) });
    assert.deepEqual(p, { action: 'skip', reason: SKIP_REASON.RECEIPT_ONLY });
  });

  it('the receipt is matched by comparison key, not spelling (Windows case)', () => {
    const p = plan({ classified: classified([entry(RECEIPT_PATH.toUpperCase())]) });
    assert.equal(p.reason, SKIP_REASON.RECEIPT_ONLY);
  });

  it('the ownership sidecar alone IS surface (it is what makes ownership answerable offline)', () => {
    const p = plan({ classified: classified([entry(RECEIPT_PATH), entry(OWNED_SIDECAR_RELATIVE_PATH)]) });
    assert.equal(p.action, 'pr');
    assert.deepEqual(p.surface, [OWNED_SIDECAR_RELATIVE_PATH]);
  });

  it('a clean tree, or no sync-owned paths, skips as clean', () => {
    assert.equal(plan({ classified: classified([]) }).reason, SKIP_REASON.CLEAN);
    assert.equal(plan({ classified: { ...classified([]), clean: true } }).reason, SKIP_REASON.CLEAN);
  });

  it('refuses when classification failed or is degraded — never commits on a guess', () => {
    assert.equal(plan({ classified: { ok: false, error: 'git status failed' } }).reason, SKIP_REASON.UNCLASSIFIABLE);
    assert.equal(plan({ classified: classified([entry('x')], [], { degraded: true }) }).reason, SKIP_REASON.UNCLASSIFIABLE);
  });

  it('refuses without a manifest commitSha (the branch name and PR body need it)', () => {
    assert.equal(plan({ manifest: null }).reason, SKIP_REASON.NO_MANIFEST);
    assert.equal(plan({ manifest: { commitSha: null } }).reason, SKIP_REASON.NO_MANIFEST);
  });

  it('refuses when the checkout is not on the base branch (a feature branch would leak into the PR)', () => {
    const p = plan({ currentBranch: 'feat/thing' });
    assert.equal(p.reason, SKIP_REASON.NOT_ON_BASE);
    assert.match(p.detail, /on feat\/thing, expected main/);
  });

  it('refuses when local base is ahead of origin, or the distance is unknown', () => {
    assert.equal(plan({ aheadCount: 2 }).reason, SKIP_REASON.AHEAD);
    assert.equal(plan({ aheadCount: null }).reason, SKIP_REASON.AHEAD);
    assert.equal(plan({ behindCount: null }).reason, SKIP_REASON.AHEAD);
    assert.equal(plan({ baseSha: null }).reason, SKIP_REASON.AHEAD, 'no fetched base, no plan — never a fall-back to the local branch');
  });

  it('behind origin: proceeds when origin left every synced path alone, from origin\'s sha', () => {
    const p = plan({ behindCount: 30, upstreamChanged: ['server/app.js', 'docs/x.md'] });
    assert.equal(p.action, 'pr');
    assert.equal(p.startPoint, ORIGIN_SHA);
    assert.equal(p.behindCount, 30);
  });

  it('behind origin: refuses by name when origin changed a path the sync wrote (incident 2026-10-12: the receipt)', () => {
    const p = plan({ behindCount: 30, upstreamChanged: ['server/app.js', RECEIPT_PATH] });
    assert.equal(p.reason, SKIP_REASON.STALE_BASE_COLLISION);
    assert.match(p.detail, /30 commit\(s\) behind origin\/main/);
    assert.match(p.detail, /\.sync-receipt\.json/);
    assert.doesNotMatch(p.detail, /server\/app\.js/, 'only the colliding paths are named');
  });

  it('behind origin: a collision is matched by comparison key, and covers a rename\'s source and the overrides file', () => {
    assert.equal(plan({ behindCount: 1, upstreamChanged: ['.CLAUDE/Skills/plan/SKILL.md'] }).reason, SKIP_REASON.STALE_BASE_COLLISION);
    const renamed = classified([entry(RECEIPT_PATH), entry('.claude/skills/new/SKILL.md', '.claude/skills/old/SKILL.md')]);
    assert.equal(plan({ classified: renamed, behindCount: 1, upstreamChanged: ['.claude/skills/old/SKILL.md'] }).reason, SKIP_REASON.STALE_BASE_COLLISION);
    const p = plan({ behindCount: 1, upstreamChanged: ['.sync-overrides.json'] });
    assert.equal(p.reason, SKIP_REASON.STALE_BASE_COLLISION, 'the sync honoured the overrides it saw; origin has since declared others');
  });

  it('refuses when the branch already exists (a prior run, possibly with an open PR)', () => {
    const p = plan({ branchExists: true });
    assert.equal(p.reason, SKIP_REASON.BRANCH_EXISTS);
    assert.equal(p.detail, 'chore/sync-cb0903cf');
  });

  it('needs-review paths are reported as left behind and never enter the commit', () => {
    const p = plan({ classified: classified([entry(RECEIPT_PATH), entry('.claude/skills/plan/SKILL.md')], [entry('.audit-loop/expected-schema.json')]) });
    assert.equal(p.action, 'pr');
    assert.deepEqual(p.leftBehind, ['.audit-loop/expected-schema.json']);
    assert.ok(!p.addPaths.includes('.audit-loop/expected-schema.json'));
    assert.match(p.body, /Left uncommitted \(needs review\)/);
  });

  it('a rename contributes BOTH sides to the commit pathspecs and only the destination to add', () => {
    const p = plan({ classified: classified([entry(RECEIPT_PATH), entry('.claude/skills/new/SKILL.md', '.claude/skills/old/SKILL.md')]) });
    assert.deepEqual(p.addPaths, ['.claude/skills/new/SKILL.md', RECEIPT_PATH]);
    assert.deepEqual(p.commitPathspecs, ['.claude/skills/new/SKILL.md', '.claude/skills/old/SKILL.md', RECEIPT_PATH]);
  });
});

describe('buildPrText', () => {
  it('links the upstream commit and lists every committed path', () => {
    const t = buildPrText({ repo: 'o/r', commitSha: SHA, surface: ['a.md', 'b.md'], leftBehind: [], consumerName: 'c' });
    assert.match(t.body, new RegExp(`https://github.com/o/r/commit/${SHA}`));
    assert.match(t.body, /- `a.md`\n- `b.md`/);
    assert.doesNotMatch(t.body, /Left uncommitted/);
    assert.match(t.message, /never commits here/);
  });

  it('declares AI-Models: none in the body (matches wine-cellar-app\'s check pattern), never as a commit trailer', () => {
    const t = buildPrText({ repo: 'o/r', commitSha: SHA, surface: ['a.md'], leftBehind: ['x.md'], consumerName: 'c' });
    // The consumer check greps for a line-anchored `AI-Models:` with tokens ^[a-z][a-z0-9.-]*$.
    assert.match(t.body, /^AI-Models: none$/m);
    assert.doesNotMatch(t.message, /AI-Models/);
  });
});

describe('sync-pr parseArgs', () => {
  const argv = (...a) => ['node', 'sync-pr.mjs', ...a];
  it('reads the flags; --base defaults to null (the remote\'s default branch is asked, not assumed)', () => {
    assert.deepEqual(parseArgs(argv('--target', 'wine', '--no-merge')), { dryRun: false, merge: false, baseOverride: null, target: 'wine' });
    assert.equal(parseArgs(argv('--base', 'develop')).baseOverride, 'develop');
  });
  it('options end at `--`: nothing after it is read as a flag (assertKnownFlags already stops there)', () => {
    assert.deepEqual(parseArgs(argv('--dry-run', '--', '--target', 'wine', '--no-merge', '--base')),
      { dryRun: true, merge: true, baseOverride: null, target: undefined });
  });
});

describe('parseSymrefHead', () => {
  it('reads the default branch out of `ls-remote --symref origin HEAD`', () => {
    assert.equal(parseSymrefHead('ref: refs/heads/main\tHEAD\n1e538526d\tHEAD\n'), 'main');
    assert.equal(parseSymrefHead('ref: refs/heads/release/v2\tHEAD\r\nabc\tHEAD\r\n'), 'release/v2');
    assert.equal(parseSymrefHead('1e538526d\tHEAD\n'), null, 'no symref advertised');
    assert.equal(parseSymrefHead(''), null);
  });
});

describe('parseFailingTests', () => {
  it('vitest: the FAIL summary lines, ANSI-coloured, each once — never the bare summary count', () => {
    const text = [
      ' \x1b[31m×\x1b[39m receipt > keeps both events 4ms',
      ' \x1b[41m FAIL \x1b[49m tests/unit/receipt.test.js > receipt > keeps both events',
      ' FAIL  tests/unit/budget.test.js > domainBudgets > tests line',
      ' FAIL  tests/unit/budget.test.js > domainBudgets > tests line',
      '      Tests  2 failed | 19805 passed (19807)',
    ].join('\n');
    assert.deepEqual(parseFailingTests(text), [
      'tests/unit/receipt.test.js > receipt > keeps both events',
      'tests/unit/budget.test.js > domainBudgets > tests line',
    ]);
  });

  it('node:test tap, jest, and per-test marks', () => {
    assert.deepEqual(parseFailingTests('ok 1 - a\nnot ok 2 - writes the receipt # TODO\n'), ['writes the receipt']);
    assert.deepEqual(parseFailingTests('  ● Console\n  ● Sync › keeps order\n'), ['Sync › keeps order']);
    assert.deepEqual(parseFailingTests('✖ keeps order (3.2ms)\n✔ other (1ms)\n'), ['keeps order']);
  });

  it('jest: the `●` test names win over the file-level `FAIL path` header printed above them', () => {
    const text = [
      'FAIL tests/receipt.test.js',
      '  Receipt',
      '    ✕ keeps both events (5 ms)',
      '    ✓ rotates (1 ms)',
      '  ● Receipt › keeps both events',
      '    expect(received).toBe(expected)',
      'Tests:       1 failed, 1 passed, 2 total',
    ].join('\n');
    assert.deepEqual(parseFailingTests(text), ['Receipt › keeps both events']);
  });

  it('a hook running two runners lists BOTH runners\' failures, each once', () => {
    const text = [
      '   × receipt > keeps both events 4ms',
      ' FAIL  tests/unit/receipt.test.js > receipt > keeps both events',
      '      Tests  1 failed | 30 passed (31)',
      '✖ guard › rejects stale base (2.1ms)',
      '✖ guard › rejects stale base (2.1ms)',
      'ℹ fail 1',
    ].join('\n');
    assert.deepEqual(parseFailingTests(text), [
      'tests/unit/receipt.test.js > receipt > keeps both events',
      'guard › rejects stale base',
    ]);
  });

  it('a file-level FAIL alone (suite failed to load) still names the file', () => {
    assert.deepEqual(parseFailingTests(' FAIL  tests/broken.test.js [ tests/broken.test.js ]\nError: Cannot find module'),
      ['tests/broken.test.js [ tests/broken.test.js ]']);
  });

  it('nothing parseable is an empty list (the caller then says so and points at the log)', () => {
    assert.deepEqual(parseFailingTests('error: failed to push some refs\n Tests  2 failed | 5 passed'), []);
    assert.deepEqual(parseFailingTests(undefined), []);
  });
});

describe('gh account fallback helpers', () => {
  it('parses `gh auth status` into accounts with the active flag', () => {
    const text = [
      'github.com',
      '  ✓ Logged in to github.com account work-user (keyring)',
      '  - Active account: true',
      '  - Git operations protocol: https',
      '  ✓ Logged in to github.com account home-user (keyring)',
      '  - Active account: false',
    ].join('\n');
    assert.deepEqual(parseGhAccounts(text), [
      { host: 'github.com', login: 'work-user', active: true },
      { host: 'github.com', login: 'home-user', active: false },
    ]);
  });

  it('only a repo-not-visible failure is retryable with another account', () => {
    assert.equal(isRepoNotResolvable("GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)"), true);
    assert.equal(isRepoNotResolvable('gh: Not Found (HTTP 404)'), true);
    assert.equal(isRepoNotResolvable('pull request create failed: validation failed'), false);
    assert.equal(isRepoNotResolvable(''), false);
  });
});

/**
 * Recording runner: `script` maps a `cmd args…` prefix to a response. With no
 * open PRs scripted, `gh pr list` answers an empty list — the common case.
 */
function fakeRunner(script = {}) {
  const calls = [];
  const full = { 'gh pr list': { stdout: '[]' }, ...script };
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input });
    const key = Object.keys(full).find((k) => `${cmd} ${args.join(' ')}`.startsWith(k));
    const r = key ? full[key] : {};
    return { status: 0, stdout: '', stderr: '', ...r };
  };
  return { run, calls };
}
const prPlan = plan();
const exec = (run, over = {}) => runConsumerPr({
  plan: prPlan, repoRoot: 'C:/consumer', baseBranch: 'main', currentBranch: 'main', merge: true, run, ...over,
});
const gitArgs = (c) => c.args.filter((a) => a !== '--literal-pathspecs' && a !== '-C' && a !== 'C:/consumer');

describe('runConsumerPr — command sequence', () => {
  it('switch -c <origin sha> → add → commit (scoped) → push → pr create → merge --auto → switch back', () => {
    const { run, calls } = fakeRunner({ 'gh pr create': { stdout: 'https://github.com/o/r/pull/7\n' } });
    const r = exec(run);
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://github.com/o/r/pull/7');
    assert.equal(r.merged, 'armed');
    const seq = calls.map((c) => (c.cmd === 'git' ? gitArgs(c).slice(0, 2).join(' ') : `${c.cmd} ${c.args.slice(0, 2).join(' ')}`));
    assert.deepEqual(seq, ['switch --no-track', 'add --', 'commit -q', 'push -u', 'gh pr create', 'gh pr list', 'gh pr merge', 'switch main']);
    assert.deepEqual(gitArgs(calls[0]), ['switch', '--no-track', '-c', 'chore/sync-cb0903cf', ORIGIN_SHA]);
    const commit = calls.find((c) => gitArgs(c)[0] === 'commit');
    assert.deepEqual(gitArgs(commit).slice(-3), ['--', '.claude/skills/plan/SKILL.md', RECEIPT_PATH]);
    const create = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'create');
    assert.equal(create.input, prPlan.body, 'the body travels on stdin, never argv');
    const merge = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'merge');
    assert.deepEqual(merge.args, ['pr', 'merge', 'https://github.com/o/r/pull/7', '--auto', '--squash', '--delete-branch']);
  });

  it('--literal-pathspecs rides ONLY add and commit — as a global flag it leaks GIT_LITERAL_PATHSPECS into the consumer hook (first live run, ai-organiser)', () => {
    const { run, calls } = fakeRunner({ 'gh pr create': { stdout: 'https://github.com/o/r/pull/7\n' } });
    exec(run);
    const literal = calls.filter((c) => c.cmd === 'git' && c.args[0] === '--literal-pathspecs').map((c) => gitArgs(c)[0]);
    const plain = calls.filter((c) => c.cmd === 'git' && c.args[0] !== '--literal-pathspecs').map((c) => gitArgs(c)[0]);
    assert.deepEqual(literal, ['add', 'commit']);
    assert.deepEqual(plain, ['switch', 'push', 'switch']);
  });

  it('--no-merge opens the PR and stops', () => {
    const { run, calls } = fakeRunner({ 'gh pr create': { stdout: 'https://github.com/o/r/pull/8\n' } });
    const r = exec(run, { merge: false });
    assert.equal(r.merged, 'skipped');
    assert.ok(!calls.some((c) => c.cmd === 'gh' && c.args[1] === 'merge'));
  });

  it('a push failure (consumer hook rejected) switches the checkout back and names the step', () => {
    const { run, calls } = fakeRunner({ 'git -C C:/consumer push': { status: 1, stderr: '[pre-push] unit tests failed' } });
    const r = exec(run);
    assert.equal(r.ok, false);
    assert.equal(r.step, 'push');
    assert.match(r.error, /unit tests failed/);
    assert.deepEqual(gitArgs(calls.at(-1)), ['switch', 'main']);
    assert.ok(!calls.some((c) => c.cmd === 'gh'), 'no PR attempted after a failed push');
    assert.equal(r.pushLog, undefined, 'no log directory given, no log written');
  });

  it('a push whose runner reported a spawn error still logs the partial output, not the error message alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-pr-log-'));
    try {
      const { run } = fakeRunner({
        'git -C C:/consumer push': { status: null, error: new Error('spawnSync git ENOBUFS'), stderr: ' FAIL  t.test.js > s > late failure\n', stdout: '' },
      });
      const r = exec(run, { pushLogDir: dir, consumerName: 'wine-cellar-app' });
      assert.equal(r.step, 'push');
      assert.match(r.error, /ENOBUFS/);
      const text = fs.readFileSync(r.pushLog.logPath, 'utf-8');
      assert.match(text, /\[spawn error\] spawnSync git ENOBUFS/);
      assert.match(text, /late failure/, 'the output that did come back is kept');
      assert.deepEqual(r.pushLog.failingTests, ['t.test.js > s > late failure']);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a failed switch -c leaves the checkout alone and does nothing else', () => {
    const { run, calls } = fakeRunner({ 'git -C C:/consumer switch --no-track -c': { status: 128, stderr: 'fatal: a branch named x already exists' } });
    const r = exec(run);
    assert.equal(r.ok, false);
    assert.equal(r.step, 'switch -c');
    assert.equal(calls.length, 1);
  });

  it('auto-merge refusal is a warning, not a failure — the PR stays open', () => {
    const { run } = fakeRunner({
      'gh pr create': { stdout: 'https://github.com/o/r/pull/9\n' },
      'gh pr merge': { status: 1, stderr: 'auto-merge is not allowed for this repository' },
    });
    const r = exec(run);
    assert.equal(r.ok, true);
    assert.equal(r.merged, 'not-armed');
    assert.match(r.warnings[0], /Allow auto-merge/);
  });

  it('retries gh with another signed-in account when the active one cannot see the repo, then restores it', () => {
    let switched = null;
    const calls = [];
    const run = (cmd, args, opts = {}) => {
      calls.push({ cmd, args });
      if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'status') {
        return { status: 0, stdout: '', stderr: '  ✓ Logged in to github.com account work (keyring)\n  - Active account: true\n  ✓ Logged in to github.com account home (keyring)\n  - Active account: false\n' };
      }
      if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'switch') { switched = args[3]; return { status: 0, stdout: '', stderr: '' }; }
      if (cmd === 'gh' && args[1] === 'create') {
        return switched === 'home'
          ? { status: 0, stdout: 'https://github.com/home/r/pull/1\n', stderr: '' }
          : { status: 1, stdout: '', stderr: "GraphQL: Could not resolve to a Repository with the name 'home/r'. (repository)" };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = exec(run);
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://github.com/home/r/pull/1');
    const switches = calls.filter((c) => c.cmd === 'gh' && c.args[1] === 'switch').map((c) => c.args[3]);
    assert.deepEqual(switches, ['home', 'work'], 'switched to the other account for the call, then restored the original');
    const merge = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'merge');
    const restoreIdx = calls.findIndex((c) => c.cmd === 'gh' && c.args[1] === 'switch' && c.args[3] === 'work');
    assert.ok(calls.indexOf(merge) < restoreIdx, 'merge ran under the account that can see the repo');
  });
});

// ── Supersession (upstream 2f933809): two sync PRs open at once for one
// consumer both prepend to .sync-receipt.json, so the second to merge is
// DIRTY. Opening a newer sync PR closes the older one — but only one whose
// replacement git EVIDENCE proves, never on its branch name alone.
const OLD_SHA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
const OLD_BRANCH = 'chore/sync-aaaa1111';
const OLD_HEAD = 'b'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);
const REPO = 'Lbstrydom/claude-engineering-skills';
const prRecord = (over = {}) => ({
  number: 5, url: 'https://github.com/o/r/pull/5', headRefName: OLD_BRANCH, baseRefName: 'main',
  isCrossRepository: false, headRefOid: OLD_HEAD, ...over,
});
const receiptOf = (commitSha, repo = REPO) => JSON.stringify({
  version: 2, olderSyncsDropped: 0, recentSyncs: [{ syncedAt: '2026-10-11T12:00:00.000Z', source: { repo, commitSha } }],
});
const sidecarOf = (paths) => JSON.stringify(buildOwnedSidecar(paths));
const SKILL_PATH = '.claude/skills/plan/SKILL.md';
const goodEvidence = (over = {}) => ({
  fetchedOid: OLD_HEAD, commitCount: 1, changes: [{ status: 'M', path: SKILL_PATH }, { status: 'M', path: RECEIPT_PATH }],
  headSidecar: buildOwnedSidecar([SKILL_PATH]), baseSidecar: null,
  receiptEntry: { syncedAt: '2026-10-11T12:00:00.000Z', source: { repo: REPO, commitSha: OLD_SHA } },
  ancestry: 'yes', ...over,
});
const CTX = { baseBranch: 'main', repo: REPO };

describe('parseOpenSyncPrs — the gh list is validated, never trusted', () => {
  it('keeps sync-shaped records, ignores other heads, and excludes the new PR\'s own branch', () => {
    const text = JSON.stringify([
      prRecord(),
      prRecord({ number: 6, headRefName: 'feature/x' }),
      prRecord({ number: 7, headRefName: 'chore/sync-handmade' }),
      prRecord({ number: 8, headRefName: 'chore/sync-cb0903cf' }),
    ]);
    const r = parseOpenSyncPrs(text, { excludeBranch: 'chore/sync-cb0903cf' });
    assert.deepEqual(r.records.map((x) => x.number), [5]);
    assert.deepEqual(r.invalid, []);
    assert.equal(r.full, false);
  });

  it('a sync-shaped record with a malformed field is INVALID (kept open), not dropped and not closed', () => {
    const bad = [
      prRecord({ number: '5' }),
      prRecord({ number: 0 }),
      prRecord({ headRefOid: 'abc' }),
      prRecord({ isCrossRepository: 'false' }),
      prRecord({ baseRefName: null }),
    ];
    const r = parseOpenSyncPrs(JSON.stringify(bad), { excludeBranch: 'x' });
    assert.equal(r.records.length, 0);
    assert.equal(r.invalid.length, 5);
  });

  it('unparseable or non-array output is null — an unread list is never an empty one', () => {
    assert.equal(parseOpenSyncPrs('', {}), null);
    assert.equal(parseOpenSyncPrs('not json', {}), null);
    assert.equal(parseOpenSyncPrs('{"a":1}', {}), null);
    assert.deepEqual(parseOpenSyncPrs('[]', {}), { records: [], invalid: [], full: false });
  });

  it('a page that hit the limit is flagged full (discovery may be incomplete)', () => {
    const many = Array.from({ length: SUPERSEDE_LIST_LIMIT }, (_, i) => prRecord({ number: i + 1, headRefName: `feature/${i}` }));
    assert.equal(parseOpenSyncPrs(JSON.stringify(many), {}).full, true);
  });
});

describe('parseNameStatus', () => {
  it('reads -z status/path pairs; a malformed stream is null, never a short list', () => {
    assert.deepEqual(parseNameStatus('M\0a.md\0D\0b c.md\0'), [{ status: 'M', path: 'a.md' }, { status: 'D', path: 'b c.md' }]);
    assert.deepEqual(parseNameStatus(''), []);
    assert.equal(parseNameStatus('M\0a.md\0D\0'), null);
  });
});

describe('decideSupersession — decision table', () => {
  // The decision sees PARSED records (`branch`), as parseOpenSyncPrs returns them.
  const keep = (record, evidence) => decideSupersession({ ...record, branch: record.headRefName }, evidence, CTX);
  it('supersedes a pure older sync PR', () => {
    assert.deepEqual(keep(prRecord(), goodEvidence()), { supersede: true });
  });
  it('a fork or another base is not ours', () => {
    assert.equal(keep(prRecord({ isCrossRepository: true }), goodEvidence()).reason, SUPERSEDE_KEEP_REASON.NOT_OURS);
    assert.equal(keep(prRecord({ baseRefName: 'develop' }), goodEvidence()).reason, SUPERSEDE_KEEP_REASON.NOT_OURS);
  });
  it('no evidence, or a head that is not the listed one, is evidence-unavailable', () => {
    assert.equal(keep(prRecord(), null).reason, SUPERSEDE_KEEP_REASON.EVIDENCE_UNAVAILABLE);
    assert.equal(keep(prRecord(), goodEvidence({ fetchedOid: 'd'.repeat(40) })).reason, SUPERSEDE_KEEP_REASON.EVIDENCE_UNAVAILABLE);
    assert.equal(keep(prRecord(), goodEvidence({ changes: null })).reason, SUPERSEDE_KEEP_REASON.EVIDENCE_UNAVAILABLE);
  });
  it('a second commit is hand-edited', () => {
    const r = keep(prRecord(), goodEvidence({ commitCount: 2 }));
    assert.equal(r.reason, SUPERSEDE_KEEP_REASON.HAND_EDITED);
    assert.match(r.detail, /2 commits/);
  });
  it('a changed file outside the sync-owned set is hand-edited, and named', () => {
    const r = keep(prRecord(), goodEvidence({ changes: [{ status: 'M', path: SKILL_PATH }, { status: 'M', path: 'src/app.js' }] }));
    assert.equal(r.reason, SUPERSEDE_KEEP_REASON.HAND_EDITED);
    assert.match(r.detail, /src\/app\.js/);
  });
  it('a file the PR\'s own sync retired (a DELETION) is owned via the merge-base sidecar (final-gate G1)', () => {
    const ev = goodEvidence({ changes: [{ status: 'D', path: '.claude/skills/old/SKILL.md' }, { status: 'M', path: RECEIPT_PATH }], baseSidecar: buildOwnedSidecar(['.claude/skills/old/SKILL.md']) });
    assert.deepEqual(keep(prRecord(), ev), { supersede: true });
  });
  it('the merge-base sidecar never authorises a CHANGE to a path the PR\'s own sidecar dropped (audit R1 H1)', () => {
    for (const status of ['M', 'A']) {
      const ev = goodEvidence({ changes: [{ status, path: '.claude/skills/old/SKILL.md' }], baseSidecar: buildOwnedSidecar(['.claude/skills/old/SKILL.md']) });
      assert.equal(keep(prRecord(), ev).reason, SUPERSEDE_KEEP_REASON.HAND_EDITED, status);
    }
  });
  it('the receipt and the sidecar themselves are always sync-owned, matched by comparison key', () => {
    const ev = goodEvidence({ changes: [{ status: 'M', path: RECEIPT_PATH.toUpperCase() }, { status: 'M', path: OWNED_SIDECAR_RELATIVE_PATH }] });
    assert.deepEqual(keep(prRecord(), ev), { supersede: true });
  });
  it('no usable sidecar at the head is ownership-unknown', () => {
    assert.equal(keep(prRecord(), goodEvidence({ headSidecar: null })).reason, SUPERSEDE_KEEP_REASON.OWNERSHIP_UNKNOWN);
  });
  it('the receipt must attest a full bundle sha matching the branch, from the producing repo', () => {
    for (const receiptEntry of [
      null,
      { syncedAt: 'x', source: { repo: REPO, commitSha: 'f'.repeat(40) } },
      { syncedAt: 'x', source: { repo: REPO, commitSha: 'aaaa1111' } },
      { syncedAt: 'x', source: { repo: 'someone/else', commitSha: OLD_SHA } },
    ]) {
      assert.equal(keep(prRecord(), goodEvidence({ receiptEntry })).reason, SUPERSEDE_KEEP_REASON.PROVENANCE_MISMATCH, JSON.stringify(receiptEntry));
    }
  });
  it('a bundle that is not strictly older is kept — the NEW PR may be the stale one', () => {
    assert.equal(keep(prRecord(), goodEvidence({ ancestry: 'no' })).reason, SUPERSEDE_KEEP_REASON.NOT_OLDER);
    assert.equal(keep(prRecord(), goodEvidence({ ancestry: 'equal' })).reason, SUPERSEDE_KEEP_REASON.NOT_OLDER);
    assert.equal(keep(prRecord(), goodEvidence({ ancestry: 'unknown' })).reason, SUPERSEDE_KEEP_REASON.BUNDLE_ORDER_UNKNOWN);
  });
});

/** Every git/gh answer an older, pure sync PR #5 produces. */
const supersedeScript = (over = {}) => ({
  'gh pr list': { stdout: JSON.stringify([prRecord(), prRecord({ number: 6, headRefName: 'feature/x' })]) },
  'git -C C:/consumer fetch': {},
  'git -C C:/consumer rev-parse --verify --quiet refs/remotes/origin/chore/sync-aaaa1111': { stdout: `${OLD_HEAD}\n` },
  'git -C C:/consumer rev-list --count': { stdout: '1\n' },
  'git -C C:/consumer merge-base': { stdout: `${MERGE_BASE}\n` },
  'git -C C:/consumer diff --name-status': { stdout: `M\0${SKILL_PATH}\0M\0${RECEIPT_PATH}\0` },
  [`git -C C:/consumer show ${OLD_HEAD}:${OWNED_SIDECAR_RELATIVE_PATH}`]: { stdout: sidecarOf([SKILL_PATH]) },
  [`git -C C:/consumer show ${MERGE_BASE}:${OWNED_SIDECAR_RELATIVE_PATH}`]: { status: 128, stderr: 'fatal: path does not exist' },
  [`git -C C:/consumer show ${OLD_HEAD}:${RECEIPT_PATH}`]: { stdout: receiptOf(OLD_SHA) },
  'gh pr view 5': { stdout: JSON.stringify({ state: 'OPEN', headRefOid: OLD_HEAD, baseRefName: 'main', isCrossRepository: false }) },
  'gh pr view https://github.com/o/r/pull/7': { stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'f'.repeat(40), baseRefName: 'main', isCrossRepository: false }) },
  'gh pr create': { stdout: 'https://github.com/o/r/pull/7\n' },
  ...over,
});
const olderAncestry = (a, b) => (a === OLD_SHA && b === SHA ? 'yes' : 'unknown');

describe('runConsumerPr — supersedes an older open sync PR', () => {
  it('closes the older sync PR after creating the new one and before arming its merge; never deletes or merges it', () => {
    const { run, calls } = fakeRunner(supersedeScript());
    const r = exec(run, { ancestry: olderAncestry });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.supersede.status, 'complete');
    assert.deepEqual(r.supersede.superseded.map((p) => p.number), [5]);
    const gh = calls.filter((c) => c.cmd === 'gh').map((c) => c.args.slice(0, 2).join(' '));
    assert.deepEqual(gh, ['pr create', 'pr list', 'pr view', 'pr view', 'pr close', 'pr merge']);
    assert.equal(calls.filter((c) => c.cmd === 'gh' && c.args[1] === 'view')[0].args[2], 'https://github.com/o/r/pull/7', 'the successor is confirmed open first');
    const close = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'close');
    assert.equal(close.args[2], '5');
    assert.ok(!close.args.includes('--delete-branch'), 'the branch is kept, so the PR can be reopened');
    assert.match(close.args[close.args.indexOf('--comment') + 1], /Superseded by https:\/\/github\.com\/o\/r\/pull\/7/);
    const merge = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'merge');
    assert.ok(merge.args.includes('https://github.com/o/r/pull/7'), 'only the NEW PR is ever merged');
  });

  it('nothing is superseded when no older sync PR is open', () => {
    const { run, calls } = fakeRunner({ 'gh pr create': { stdout: 'https://github.com/o/r/pull/7\n' } });
    const r = exec(run, { ancestry: olderAncestry });
    assert.equal(r.ok, true);
    assert.deepEqual(r.supersede, { status: 'none', superseded: [], kept: [], warnings: [] });
    assert.ok(!calls.some((c) => c.cmd === 'gh' && ['view', 'close'].includes(c.args[1])));
  });

  it('--no-merge still supersedes, and still merges nothing', () => {
    const { run, calls } = fakeRunner(supersedeScript());
    const r = exec(run, { ancestry: olderAncestry, merge: false });
    assert.deepEqual(r.supersede.superseded.map((p) => p.number), [5]);
    assert.ok(!calls.some((c) => c.cmd === 'gh' && c.args[1] === 'merge'));
  });

  it('a head that moved between evidence and close is kept (changed-before-close)', () => {
    const { run, calls } = fakeRunner(supersedeScript({ 'gh pr view 5': { stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'e'.repeat(40), baseRefName: 'main', isCrossRepository: false }) } }));
    const r = exec(run, { ancestry: olderAncestry });
    assert.equal(r.supersede.status, 'partial');
    assert.equal(r.supersede.kept[0].reason, SUPERSEDE_KEEP_REASON.CHANGED_BEFORE_CLOSE);
    assert.ok(!calls.some((c) => c.cmd === 'gh' && c.args[1] === 'close'));
  });

  it('a newer open sync PR is kept, and the warning says this one may be stale', () => {
    const { run } = fakeRunner(supersedeScript());
    const r = exec(run, { ancestry: () => 'no' });
    assert.equal(r.supersede.kept[0].reason, SUPERSEDE_KEEP_REASON.NOT_OLDER);
    assert.ok(r.warnings.some((w) => /#5/.test(w) && /stale/.test(w)), r.warnings.join('\n'));
  });

  it('a successor that is no longer open supersedes nothing', () => {
    const { run, calls } = fakeRunner(supersedeScript({
      'gh pr view https://github.com/o/r/pull/7': { stdout: JSON.stringify({ state: 'CLOSED', headRefOid: 'f'.repeat(40), baseRefName: 'main', isCrossRepository: false }) },
    }));
    const r = exec(run, { ancestry: olderAncestry, merge: false });
    assert.equal(r.supersede.kept[0].reason, SUPERSEDE_KEEP_REASON.SUCCESSOR_UNAVAILABLE);
    assert.ok(!calls.some((c) => c.cmd === 'gh' && c.args[1] === 'close'));
  });

  it('a PR retargeted to another base between evidence and close is kept (the same decision, re-applied)', () => {
    const { run, calls } = fakeRunner(supersedeScript({
      'gh pr view 5': { stdout: JSON.stringify({ state: 'OPEN', headRefOid: OLD_HEAD, baseRefName: 'release', isCrossRepository: false }) },
    }));
    const r = exec(run, { ancestry: olderAncestry, merge: false });
    assert.equal(r.supersede.kept[0].reason, SUPERSEDE_KEEP_REASON.CHANGED_BEFORE_CLOSE);
    assert.ok(!calls.some((c) => c.cmd === 'gh' && c.args[1] === 'close'));
  });

  it('auto-merge is WITHHELD while another sync PR may still be open (audit R1 H5)', () => {
    for (const [label, over, ancestry] of [
      ['newer PR open', {}, () => 'no'],
      ['close failed', { 'gh pr close 5': { status: 1, stderr: 'boom' } }, olderAncestry],
      ['list failed', { 'gh pr list': { status: 1, stderr: 'HTTP 502' } }, olderAncestry],
    ]) {
      const { run, calls } = fakeRunner(supersedeScript(over));
      const r = exec(run, { ancestry });
      assert.equal(r.ok, true, label);
      assert.equal(r.merged, 'not-armed', label);
      assert.ok(!calls.some((c) => c.cmd === 'gh' && c.args[1] === 'merge'), `${label}: no merge is ever issued`);
      assert.ok(r.warnings.some((w) => /auto-merge withheld/.test(w)), label);
    }
  });

  it('a list failure is a warning — the new PR still opened, ok:true', () => {
    const { run } = fakeRunner(supersedeScript({ 'gh pr list': { status: 1, stderr: 'HTTP 502' } }));
    const r = exec(run, { ancestry: olderAncestry });
    assert.equal(r.ok, true);
    assert.equal(r.supersede.status, 'failed');
    assert.ok(r.warnings.some((w) => /HTTP 502/.test(w)));
  });

  it('a failed close is partial, and the warning carries the exact command to finish by hand', () => {
    const { run } = fakeRunner(supersedeScript({ 'gh pr close 5': { status: 1, stderr: 'GraphQL: something broke' } }));
    const r = exec(run, { ancestry: olderAncestry });
    assert.equal(r.ok, true);
    assert.equal(r.supersede.status, 'partial');
    assert.equal(r.supersede.kept[0].reason, SUPERSEDE_KEEP_REASON.CLOSE_FAILED);
    assert.ok(r.warnings.some((w) => w.includes('gh pr close 5 --comment')), r.warnings.join('\n'));
  });
});

describe('supersedeOlderSyncPrs — exported for a retry path', () => {
  it('reports incomplete discovery when the list hit its limit, still deciding what it found', () => {
    const many = [prRecord(), ...Array.from({ length: SUPERSEDE_LIST_LIMIT - 1 }, (_, i) => prRecord({ number: 100 + i, headRefName: `feature/${i}` }))];
    const { run } = fakeRunner(supersedeScript({ 'gh pr list': { stdout: JSON.stringify(many) } }));
    const gh = (args) => run('gh', args);
    const r = supersedeOlderSyncPrs({
      gh, run, ancestry: olderAncestry, repoRoot: 'C:/consumer', repo: REPO, baseBranch: 'main', baseSha: ORIGIN_SHA,
      newBranch: 'chore/sync-cb0903cf', newBundleSha: SHA, newUrl: 'https://github.com/o/r/pull/7',
    });
    assert.equal(r.status, 'incomplete-discovery');
    assert.deepEqual(r.superseded.map((p) => p.number), [5]);
    assert.ok(r.warnings.some((w) => /incomplete/i.test(w)));
  });
});

describe('retrySupersession — a same-bundle re-run (BRANCH_EXISTS) retries, creating and arming nothing', () => {
  const NEW_URL = 'https://github.com/o/r/pull/7';
  const NEW_HEAD = 'f'.repeat(40);
  const viewNew = (over = {}) => ({ stdout: JSON.stringify({ url: NEW_URL, state: 'OPEN', headRefOid: NEW_HEAD, baseRefName: 'main', ...over }) });
  /** The existing PR #7 as git proves it: its fetched head, and that head's receipt attesting THIS bundle. */
  const successorScript = (over = {}) => supersedeScript({
    'gh pr view chore/sync-cb0903cf': viewNew(),
    'git -C C:/consumer rev-parse --verify --quiet refs/remotes/origin/chore/sync-cb0903cf': { stdout: `${NEW_HEAD}\n` },
    [`git -C C:/consumer show ${NEW_HEAD}:${RECEIPT_PATH}`]: { stdout: receiptOf(SHA) },
    ...over,
  });
  const retry = (run) => {
    const target = supersessionRetryTarget({ plan: plan({ branchExists: true }), manifest: MANIFEST, branchExists: true });
    return retrySupersession({ ...target, repoRoot: 'C:/consumer', baseBranch: 'main', baseSha: ORIGIN_SHA, run, ancestry: olderAncestry });
  };
  const mutations = (calls) => calls.filter((c) => (c.cmd === 'gh' && ['create', 'merge'].includes(c.args[1]))
    || (c.cmd === 'git' && ['switch', 'add', 'commit', 'push'].some((v) => gitArgs(c).includes(v))));

  it('targets the current bundle\'s branch on ANY skip once that branch exists — branch-exists AND a clean re-run (code audit R1 M2)', () => {
    const want = { branch: 'chore/sync-cb0903cf', bundleSha: SHA, repo: MANIFEST.repo };
    assert.deepEqual(supersessionRetryTarget({ plan: plan({ branchExists: true }), manifest: MANIFEST, branchExists: true }), want);
    const clean = plan({ classified: classified([], [], { clean: true }), branchExists: true });
    assert.equal(clean.reason, SKIP_REASON.CLEAN, 'fixture: a bare re-run after the first run committed the synced files');
    assert.deepEqual(supersessionRetryTarget({ plan: clean, manifest: MANIFEST, branchExists: true }), want);
  });

  it('no target when a PR is being opened, the branch does not exist, or the manifest names no full bundle sha', () => {
    const skip = plan({ branchExists: true });
    assert.equal(supersessionRetryTarget({ plan: plan(), manifest: MANIFEST, branchExists: true }), null, 'the creating run supersedes itself');
    assert.equal(supersessionRetryTarget({ plan: skip, manifest: MANIFEST, branchExists: false }), null);
    for (const manifest of [null, {}, { commitSha: 'cb0903cf' }, { commitSha: 'not-a-sha'.padEnd(40, 'x') }]) {
      assert.equal(supersessionRetryTarget({ plan: skip, manifest, branchExists: true }), null, JSON.stringify(manifest));
    }
  });

  it('resolves the existing open PR by branch and supersedes for it against the fresh base', () => {
    const { run, calls } = fakeRunner(successorScript());
    const r = retry(run);
    assert.equal(r.retried, true);
    assert.equal(r.url, NEW_URL);
    assert.equal(r.supersede.status, 'complete');
    assert.deepEqual(r.supersede.superseded.map((p) => p.number), [5]);
    assert.deepEqual(calls.find((c) => c.cmd === 'gh').args, ['pr', 'view', 'chore/sync-cb0903cf', '--json', 'url,state,headRefOid,baseRefName']);
    assert.ok(calls.some((c) => c.cmd === 'git' && gitArgs(c).join(' ') === `rev-list --count ${ORIGIN_SHA}..${OLD_HEAD}`), 'evidence is taken against the fresh base');
    assert.match(calls.find((c) => c.args[1] === 'close').args.at(-1), /Superseded by https:\/\/github\.com\/o\/r\/pull\/7/);
    assert.deepEqual(mutations(calls), [], 'no commit, push, PR or merge');
  });

  it('a close that fails again is partial, still arming nothing', () => {
    const { run, calls } = fakeRunner(successorScript({ 'gh pr close 5': { status: 1, stderr: 'boom' } }));
    const r = retry(run);
    assert.equal(r.supersede.status, 'partial');
    assert.ok(r.warnings.some((w) => w.includes('gh pr close 5 --comment')));
    assert.deepEqual(mutations(calls), []);
  });

  it('runs nothing — with a NAMED reason — when there is no open PR on this base to supersede for', () => {
    for (const [label, view, reason] of [
      ['no PR', { status: 1, stderr: 'no pull requests found for branch "chore/sync-cb0903cf"' }, SUPERSEDE_RETRY_SKIP.NO_PR],
      ['gh broke', { status: 1, stderr: 'HTTP 502' }, SUPERSEDE_RETRY_SKIP.PR_UNREADABLE],
      ['malformed', { stdout: '{"state":"OPEN"}' }, SUPERSEDE_RETRY_SKIP.PR_UNREADABLE],
      ['merged', viewNew({ state: 'MERGED' }), SUPERSEDE_RETRY_SKIP.NOT_OPEN],
      ['closed', viewNew({ state: 'CLOSED' }), SUPERSEDE_RETRY_SKIP.NOT_OPEN],
      ['retargeted', viewNew({ baseRefName: 'release' }), SUPERSEDE_RETRY_SKIP.OTHER_BASE],
    ]) {
      const { run, calls } = fakeRunner(supersedeScript({ 'gh pr view chore/sync-cb0903cf': view }));
      const r = retry(run);
      assert.equal(r.retried, false, label);
      assert.equal(r.reason, reason, label);
      assert.deepEqual(calls.filter((c) => c.cmd === 'gh').map((c) => c.args[1]), ['view'], `${label}: no list, no close`);
    }
  });

  it('an existing PR git cannot prove carries THIS bundle supersedes nothing (code audit R3 H1)', () => {
    for (const [label, over] of [
      ['receipt attests another bundle', { [`git -C C:/consumer show ${NEW_HEAD}:${RECEIPT_PATH}`]: { stdout: receiptOf(OLD_SHA) } }],
      ['receipt from another repo', { [`git -C C:/consumer show ${NEW_HEAD}:${RECEIPT_PATH}`]: { stdout: receiptOf(SHA, 'someone/else') } }],
      ['no receipt at its head', { [`git -C C:/consumer show ${NEW_HEAD}:${RECEIPT_PATH}`]: { status: 128, stderr: 'fatal: path does not exist' } }],
      ['head moved since gh listed it', { 'git -C C:/consumer rev-parse --verify --quiet refs/remotes/origin/chore/sync-cb0903cf': { stdout: `${'e'.repeat(40)}\n` } }],
    ]) {
      const { run, calls } = fakeRunner(successorScript(over));
      const r = retry(run);
      assert.equal(r.retried, false, label);
      assert.equal(r.reason, SUPERSEDE_RETRY_SKIP.SUCCESSOR_UNVERIFIED, label);
      assert.ok(!calls.some((c) => c.cmd === 'gh' && ['list', 'close'].includes(c.args[1])), `${label}: nothing discovered, nothing closed`);
    }
  });

  it('uses the same gh account fallback as runConsumerPr, and restores the original account', () => {
    const notVisible = { status: 1, stderr: "GraphQL: Could not resolve to a Repository with the name 'o/r'." };
    const auth = { stdout: [
      'Logged in to github.com account work-user (keyring)', '  - Active account: true',
      'Logged in to github.com account home-user (keyring)', '  - Active account: false',
    ].join('\n') };
    let switched = false;
    const { run: base, calls } = fakeRunner(successorScript({ 'gh auth status': auth }));
    const run = (cmd, args, opts) => {
      if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'switch') switched = args[3] === 'home-user';
      if (cmd === 'gh' && args[0] === 'pr' && !switched) { calls.push({ cmd, args }); return { stdout: '', ...notVisible }; }
      return base(cmd, args, opts);
    };
    const r = retry(run);
    assert.equal(r.retried, true, JSON.stringify(r));
    const switches = calls.filter((c) => c.args[0] === 'auth' && c.args[1] === 'switch').map((c) => c.args[3]);
    assert.deepEqual(switches, ['home-user', 'work-user'], 'falls back, then restores the original active account');
  });
});
