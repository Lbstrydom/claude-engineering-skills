/**
 * @fileoverview `lib/sync-pr.mjs` against REAL git: a bare "origin", a
 * consumer clone whose local default branch is BEHIND origin, and a consumer
 * pre-push hook that refuses. Pins the 2026-10-12 incident by name — the sync
 * branch forked from wine-cellar-app's stale local `main`, conflicted on
 * `.sync-receipt.json`, the hook refused, and only the vitest summary line was
 * ever printed — so the two rules it produced are tested on git itself, not a
 * recorded runner:
 *   1. the branch forks from the freshly fetched origin head (default branch
 *      asked of the remote), and a stale base whose upstream touched a synced
 *      path is refused by name before any branch exists;
 *   2. a refused push leaves a log naming the failing tests.
 * `gh` is the only stubbed command; nothing here reaches a network.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  SKIP_REASON, gatherConsumerFacts, planConsumerPr, runConsumerPr, branchNameFor,
} from '../scripts/lib/sync-pr.mjs';
import { formatFailure } from '../scripts/sync-pr.mjs';
import { RECEIPT_PATH } from '../scripts/lib/sync-receipt.mjs';
import { gitFixtureEnv, makeGitRunner, mkdtemp, rmrfBestEffort } from './helpers/fixtures.mjs';

const SHA = 'f3991844aa30eb2d3e87bd42f3f31bb1db850083';
const SKILL = '.claude/skills/plan/SKILL.md';
const MANIFEST = { repo: 'Lbstrydom/claude-engineering-skills', commitSha: SHA };

/** Real git through the fixture env; `gh` stubbed — the only thing that would leave the machine. */
function makeRunner() {
  const ghCalls = [];
  const run = (cmd, args, { cwd, input } = {}) => {
    if (cmd === 'gh') {
      ghCalls.push(args);
      return { status: 0, stdout: args[1] === 'create' ? 'https://github.com/o/r/pull/1\n' : '', stderr: '' };
    }
    const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf-8', env: gitFixtureEnv(), windowsHide: true });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  };
  return { run, ghCalls };
}

const write = (root, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

/**
 * origin (bare, default branch `trunk` — so a hardcoded `main` cannot pass),
 * a publisher clone that moves origin, and the consumer clone left behind.
 */
function makeFixture() {
  const root = mkdtemp('sync-pr-git-');
  const git = makeGitRunner(() => root);
  const origin = path.join(root, 'origin.git');
  git(['init', '-q', '--bare', '-b', 'trunk', origin]);
  const clone = (name) => {
    const dir = path.join(root, name);
    git(['clone', '-q', origin, dir]);
    for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'false'], ['core.hooksPath', path.join(root, `${name}-hooks`)]]) git(['config', k, v], dir);
    return dir;
  };
  const publisher = clone('publisher');
  git(['symbolic-ref', 'HEAD', 'refs/heads/trunk'], publisher);
  write(publisher, RECEIPT_PATH, '{"recentSyncs":["a"]}\n');
  write(publisher, SKILL, 'plan v1\n');
  write(publisher, 'app.js', 'one\n');
  git(['add', '-A'], publisher);
  git(['commit', '-q', '-m', 'seed'], publisher);
  git(['push', '-q', 'origin', 'trunk'], publisher);
  const consumer = clone('consumer');
  /** Land a commit on origin the consumer has not fetched. */
  const advanceOrigin = (rel, content) => {
    write(publisher, rel, content);
    git(['add', '-A'], publisher);
    git(['commit', '-q', '-m', `upstream ${rel}`], publisher);
    git(['push', '-q', 'origin', 'trunk'], publisher);
    return git(['rev-parse', 'HEAD'], publisher).trim();
  };
  /** What the sync leaves in the consumer's working tree. */
  const syncWrites = () => {
    write(consumer, SKILL, 'plan v2\n');
    write(consumer, RECEIPT_PATH, '{"recentSyncs":["a","b"]}\n');
  };
  return { root, origin, publisher, consumer, git, advanceOrigin, syncWrites };
}

const classified = {
  ok: true, clean: false, degraded: false, partial: false, manifestFound: true, blindTo: [], other: [], needsReview: [],
  syncOwned: [{ status: ' M', path: RECEIPT_PATH, origPath: null }, { status: ' M', path: SKILL, origPath: null }],
};
const planFor = (facts) => planConsumerPr({ consumerName: 'fixture', classified, manifest: MANIFEST, ...facts });

describe('sync-pr on real git — a consumer whose local default branch is behind origin', () => {
  let fx, originHead;
  // Each test gets its own stale-consumer / moved-origin fixture: origin
  // gained a commit touching only a path the sync never writes.
  beforeEach(() => { fx = makeFixture(); originHead = fx.advanceOrigin('app.js', 'two\n'); });
  afterEach(() => rmrfBestEffort(fx.root));

  it('asks the REMOTE for its default branch and fetches it fresh (never the stale local ref)', () => {
    const staleLocal = fx.git(['rev-parse', 'HEAD'], fx.consumer).trim();
    assert.notEqual(staleLocal, originHead, 'fixture: the consumer has not seen origin move');
    const facts = gatherConsumerFacts(makeRunner().run, fx.consumer, { commitSha: SHA });
    assert.equal(facts.ok, true, facts.error);
    assert.equal(facts.baseBranch, 'trunk');
    assert.equal(facts.baseSha, originHead);
    assert.equal(facts.behindCount, 1);
    assert.equal(facts.aheadCount, 0);
    assert.deepEqual(facts.upstreamChanged, ['app.js']);
  });

  it('forks the sync branch from origin\'s head and carries the synced files across', () => {
    assert.notEqual(fx.git(['rev-parse', 'HEAD'], fx.consumer).trim(), originHead, 'fixture: the consumer is behind');
    fx.syncWrites();
    const { run, ghCalls } = makeRunner();
    const facts = gatherConsumerFacts(run, fx.consumer, { commitSha: SHA });
    const plan = planFor(facts);
    assert.equal(plan.action, 'pr', plan.detail);
    const result = runConsumerPr({ plan, repoRoot: fx.consumer, baseBranch: facts.baseBranch, currentBranch: facts.currentBranch, merge: false, run });
    assert.equal(result.ok, true, result.error);
    const branch = branchNameFor(SHA);
    const parent = fx.git(['rev-parse', `${branch}^`], fx.consumer).trim();
    assert.equal(parent, originHead, 'the sync commit sits on the fetched origin head, not the stale local trunk');
    assert.equal(fx.git(['show', `${branch}:app.js`], fx.consumer), 'two\n', 'origin\'s newer commit is in the PR base');
    assert.equal(fx.git(['show', `${branch}:${SKILL}`], fx.consumer), 'plan v2\n', 'the synced content is what was committed');
    assert.deepEqual(fx.git(['diff', '--name-only', `${branch}^`, branch], fx.consumer).trim().split('\n').sort(), [RECEIPT_PATH, SKILL].sort());
    assert.equal(fx.git(['rev-parse', '--abbrev-ref', 'HEAD'], fx.consumer).trim(), 'trunk', 'the human\'s checkout is switched back');
    assert.equal(fx.git(['ls-remote', '--heads', 'origin', branch], fx.consumer).trim().split(/\s+/)[0],
      fx.git(['rev-parse', branch], fx.consumer).trim(), 'the pushed branch is the one built on origin\'s head');
    assert.equal(ghCalls.filter((a) => a[1] === 'create').length, 1);
  });
});

describe('sync-pr on real git — the incident: origin already carries a sync this checkout never saw', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => rmrfBestEffort(fx.root));

  it('refuses by name, before any branch exists, when origin changed a path the sync wrote (the receipt)', () => {
    fx.advanceOrigin(RECEIPT_PATH, '{"recentSyncs":["a","previous-sync-pr"]}\n');
    fx.syncWrites();
    const facts = gatherConsumerFacts(makeRunner().run, fx.consumer, { commitSha: SHA });
    assert.equal(facts.ok, true, facts.error);
    const plan = planFor(facts);
    assert.equal(plan.action, 'skip');
    assert.equal(plan.reason, SKIP_REASON.STALE_BASE_COLLISION);
    assert.match(plan.detail, /1 commit\(s\) behind origin\/trunk/);
    assert.match(plan.detail, /\.sync-receipt\.json/);
    assert.match(plan.detail, /re-run the sync/);
    assert.equal(spawnSync('git', ['-C', fx.consumer, 'rev-parse', '--verify', '--quiet', `refs/heads/${branchNameFor(SHA)}`], { env: gitFixtureEnv() }).status, 1);
  });

  it('the overrides file is a collision too: the sync honoured an older declared-divergence set', () => {
    const fy = makeFixture();
    try {
      fy.advanceOrigin('.sync-overrides.json', '{"overrides":[]}\n');
      fy.syncWrites();
      const plan = planFor(gatherConsumerFacts(makeRunner().run, fy.consumer, { commitSha: SHA }));
      assert.equal(plan.reason, SKIP_REASON.STALE_BASE_COLLISION);
      assert.match(plan.detail, /\.sync-overrides\.json/);
    } finally { rmrfBestEffort(fy.root); }
  });
});

describe('sync-pr on real git — an unreachable base is an error, never a fall-back', () => {
  it('a remote that cannot be asked fails at "resolve default branch"; with --base it fails at the fetch', () => {
    const fx = makeFixture();
    try {
      fx.git(['remote', 'set-url', 'origin', path.join(fx.root, 'gone.git')], fx.consumer);
      const run = makeRunner().run;
      const asked = gatherConsumerFacts(run, fx.consumer, { commitSha: SHA });
      assert.equal(asked.ok, false);
      assert.equal(asked.step, 'resolve default branch');
      const named = gatherConsumerFacts(run, fx.consumer, { baseBranch: 'trunk', commitSha: SHA });
      assert.equal(named.ok, false);
      assert.equal(named.step, 'fetch origin trunk');
      assert.ok(!('baseSha' in named), 'no base is offered when the fetch failed');
    } finally { rmrfBestEffort(fx.root); }
  });
});

describe('sync-pr on real git — the consumer\'s pre-push hook refuses', () => {
  it('leaves a log of the full hook output and names the failing tests (not only the summary line)', () => {
    const fx = makeFixture();
    try {
      const hooks = path.join(fx.root, 'consumer-hooks');
      fs.mkdirSync(hooks, { recursive: true });
      // A vitest-shaped report, coloured as a TTY-less CI reporter still is.
      write(hooks, 'pre-push', [
        '#!/bin/sh',
        'echo " RUN  v3.2.4 /consumer"',
        'echo "   x receipt > keeps both events 4ms"',
        'printf "\\033[41m FAIL \\033[49m tests/unit/receipt.test.js > receipt > keeps both events\\n"',
        'echo "AssertionError: expected 1 to be 2"',
        'echo " FAIL  tests/unit/budget.test.js > domainBudgets > tests line"',
        'echo "      Tests  2 failed | 19805 passed (19807)"',
        'exit 1',
        '',
      ].join('\n'));
      fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);
      fx.syncWrites();
      const { run, ghCalls } = makeRunner();
      const facts = gatherConsumerFacts(run, fx.consumer, { commitSha: SHA });
      const plan = planFor(facts);
      assert.equal(plan.action, 'pr', plan.detail);
      const logDir = path.join(fx.root, 'logs');
      const result = runConsumerPr({
        plan, repoRoot: fx.consumer, baseBranch: facts.baseBranch, currentBranch: facts.currentBranch, merge: true, run,
        consumerName: 'wine-cellar-app', pushLogDir: logDir,
      });
      assert.equal(result.ok, false);
      assert.equal(result.step, 'push');
      assert.equal(ghCalls.length, 0, 'no PR attempted after a refused push');
      assert.ok(result.pushLog, 'a refused push returns where its log went');
      assert.deepEqual(result.pushLog.failingTests, [
        'tests/unit/receipt.test.js > receipt > keeps both events',
        'tests/unit/budget.test.js > domainBudgets > tests line',
      ]);
      const { logPath } = result.pushLog;
      assert.equal(path.dirname(logPath), logDir);
      const text = fs.readFileSync(logPath, 'utf-8');
      assert.match(text, /keeps both events/);
      assert.match(text, /AssertionError: expected 1 to be 2/, 'the full output is kept, not just the names');
      assert.match(text, /Tests {2}2 failed \| 19805 passed/);
      const printed = formatFailure(result);
      assert.ok(printed.includes(`full push/hook output: ${logPath}`), printed);
      assert.match(printed, /✗.* tests\/unit\/receipt\.test\.js > receipt > keeps both events/);
      assert.match(printed, /✗.* tests\/unit\/budget\.test\.js > domainBudgets > tests line/);
      assert.equal(fx.git(['rev-parse', '--abbrev-ref', 'HEAD'], fx.consumer).trim(), 'trunk');
    } finally { rmrfBestEffort(fx.root); }
  });
});
