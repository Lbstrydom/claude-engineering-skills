/**
 * @fileoverview `lib/sync-pr.mjs` — the planner's decision table and the
 * executor's command sequence, both against a recorded fake runner. The two
 * rules that carry the design are pinned by name: a receipt-only change earns
 * no PR (else every upstream push spawns a consumer PR), and a checkout that
 * is off its base branch or ahead of origin is refused, never "handled".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP_REASON, branchNameFor, buildPrText, planConsumerPr, runConsumerPr,
  parseGhAccounts, isRepoNotResolvable,
} from '../scripts/lib/sync-pr.mjs';
import { RECEIPT_PATH } from '../scripts/lib/sync-receipt.mjs';
import { OWNED_SIDECAR_RELATIVE_PATH } from '../scripts/lib/sync-owned-sidecar.mjs';

const SHA = 'cb0903cfaa30eb2d3e87bd42f3f31bb1db850083';
const MANIFEST = { repo: 'Lbstrydom/claude-engineering-skills', commitSha: SHA };
const entry = (p, origPath = null) => ({ status: ' M', path: p, origPath });
const classified = (syncOwned, needsReview = [], extra = {}) => ({
  ok: true, clean: false, syncOwned, needsReview, other: [], manifestFound: true, degraded: false, partial: false, blindTo: [], ...extra,
});
const facts = { baseBranch: 'main', currentBranch: 'main', aheadCount: 0, branchExists: false };
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

/** Recording runner: `script` maps a `cmd args…` prefix to a response. */
function fakeRunner(script = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input });
    const key = Object.keys(script).find((k) => `${cmd} ${args.join(' ')}`.startsWith(k));
    const r = key ? script[key] : {};
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
  it('switch -c → add → commit (scoped) → push → pr create → merge --auto → switch back', () => {
    const { run, calls } = fakeRunner({ 'gh pr create': { stdout: 'https://github.com/o/r/pull/7\n' } });
    const r = exec(run);
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://github.com/o/r/pull/7');
    assert.equal(r.merged, 'armed');
    const seq = calls.map((c) => (c.cmd === 'git' ? gitArgs(c).slice(0, 2).join(' ') : `${c.cmd} ${c.args.slice(0, 2).join(' ')}`));
    assert.deepEqual(seq, ['switch -c', 'add --', 'commit -q', 'push -u', 'gh pr create', 'gh pr merge', 'switch main']);
    const commit = calls.find((c) => gitArgs(c)[0] === 'commit');
    assert.deepEqual(gitArgs(commit).slice(-3), ['--', '.claude/skills/plan/SKILL.md', RECEIPT_PATH]);
    const create = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'create');
    assert.equal(create.input, prPlan.body, 'the body travels on stdin, never argv');
    const merge = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'merge');
    assert.deepEqual(merge.args, ['pr', 'merge', 'https://github.com/o/r/pull/7', '--auto', '--squash', '--delete-branch']);
  });

  it('--no-merge opens the PR and stops', () => {
    const { run, calls } = fakeRunner({ 'gh pr create': { stdout: 'https://github.com/o/r/pull/8\n' } });
    const r = exec(run, { merge: false });
    assert.equal(r.merged, 'skipped');
    assert.ok(!calls.some((c) => c.cmd === 'gh' && c.args[1] === 'merge'));
  });

  it('a push failure (consumer hook rejected) switches the checkout back and names the step', () => {
    const { run, calls } = fakeRunner({ 'git --literal-pathspecs -C C:/consumer push': { status: 1, stderr: '[pre-push] unit tests failed' } });
    const r = exec(run);
    assert.equal(r.ok, false);
    assert.equal(r.step, 'push');
    assert.match(r.error, /unit tests failed/);
    assert.deepEqual(gitArgs(calls.at(-1)), ['switch', 'main']);
    assert.ok(!calls.some((c) => c.cmd === 'gh'), 'no PR attempted after a failed push');
  });

  it('a failed switch -c leaves the checkout alone and does nothing else', () => {
    const { run, calls } = fakeRunner({ 'git --literal-pathspecs -C C:/consumer switch -c': { status: 128, stderr: 'fatal: a branch named x already exists' } });
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
