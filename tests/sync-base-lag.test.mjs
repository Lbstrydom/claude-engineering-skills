/**
 * @fileoverview Is the consumer behind origin? Asked BEFORE the sync writes (fleet p-...-2753). Tier 3: the consumer sync contract -
 * a break here ships silently to repos nobody here can observe (storyline was 17 commits behind, wine 46, on 2026-10-24).
 *
 *   A. classifyBaseLag / planBaseLag: the decision table, both directions.
 *   B. enforceBaseLag against REAL git (bare origin + clones): fast-forward, refuse, accept-stale, dry-run, unreachable origin.
 *   C. ONE oracle: sync:pr's own stale-base branch and the pre-write check ask the same `classifyBaseLag`.
 *   D. the real `sync-to-repos.mjs` CLI: a stale dirty consumer is refused with nothing written; a clean stale one is fast-forwarded.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classifyBaseLag, planBaseLag, enforceBaseLag, enforceBaseLagForTarget } from '../scripts/lib/sync-base-lag.mjs';
import { planConsumerPr, classifyBaseLag as classifyFromSyncPr, SKIP_REASON } from '../scripts/lib/sync-pr.mjs';
import { spawnRunner } from '../scripts/lib/sync-pr.mjs';
import { spawnRunner as spawnRunnerDirect } from '../scripts/lib/sync-base-lag.mjs';
import { seedInstalledDeps, runSyncCli, whySyncFailed } from './helpers/consumer-fixture.mjs';
import { git } from './lib/hook-test-helpers.mjs';

const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
const stripAnsi = (t) => String(t).replace(/\u001B\[[0-9;]*m/g, '');

// ── A. the decision table ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('classifyBaseLag', () => {
  const f = (o) => ({ baseBranch: 'main', baseSha: 'a'.repeat(40), currentBranch: 'main', aheadCount: 0, behindCount: 0, ...o });
  it('behind, diverged, current, off-base, unknown - and ahead-only is NOT lag', () => {
    assert.equal(classifyBaseLag(f({ behindCount: 17 })), 'behind');
    assert.equal(classifyBaseLag(f({ behindCount: 17, aheadCount: 2 })), 'diverged');
    assert.equal(classifyBaseLag(f({})), 'current');
    assert.equal(classifyBaseLag(f({ aheadCount: 3 })), 'current');
    assert.equal(classifyBaseLag(f({ currentBranch: 'feature', behindCount: 9 })), 'off-base');
  });
  it('a missing count or base sha is UNKNOWN, never current (nothing was compared)', () => {
    assert.equal(classifyBaseLag(f({ behindCount: null })), 'unknown');
    assert.equal(classifyBaseLag(f({ aheadCount: null })), 'unknown');
    assert.equal(classifyBaseLag(f({ baseSha: null })), 'unknown');
    assert.equal(classifyBaseLag(f({ baseSha: '' })), 'unknown');
    // OMITTED / undefined is missing evidence too: there is no fabricated default that could turn it into 'current' or 'behind'.
    assert.equal(classifyBaseLag(f({ baseSha: undefined })), 'unknown');
    const { baseSha, ...omitted } = f({ behindCount: 17 });
    assert.equal(baseSha.length, 40);
    assert.equal(classifyBaseLag(omitted), 'unknown');
  });
});

describe('planBaseLag', () => {
  const clean = { ok: true, clean: true, syncOwned: [], needsReview: [], other: [], degraded: false };
  const own = (...paths) => paths.map((p) => ({ status: ' M', path: p, origPath: null }));
  const base = { repoRoot: 'C:/r', baseBranch: 'main', behindCount: 17, aheadCount: 0 };
  it('current and off-base proceed silently; unknown proceeds but says it was not checked', () => {
    assert.deepEqual(planBaseLag({ ...base, lag: 'current', classified: null }), { action: 'proceed' });
    assert.deepEqual(planBaseLag({ ...base, lag: 'off-base', classified: null }), { action: 'proceed' });
    const u = planBaseLag({ ...base, lag: 'unknown', classified: null, why: 'fetch origin main: no route' });
    assert.equal(u.action, 'unchecked');
    assert.match(u.detail, /no route/);
  });
  it('behind + clean -> fast-forward; behind + only sync-written files -> fast-forward, restoring them first', () => {
    assert.deepEqual(planBaseLag({ ...base, lag: 'behind', classified: clean }), { action: 'fast-forward', discard: [], behindCount: 17 });
    const p = planBaseLag({ ...base, lag: 'behind', classified: { ...clean, clean: false, syncOwned: own('.sync-receipt.json', '.claude/skills/plan/SKILL.md') } });
    assert.deepEqual(p, { action: 'fast-forward', discard: ['.sync-receipt.json', '.claude/skills/plan/SKILL.md'], behindCount: 17 });
  });
  it('untracked and renamed sync output is left for the fast-forward to judge, never restored by path', () => {
    const entries = [{ status: '??', path: 'new.md', origPath: null }, { status: 'R ', path: 'b.md', origPath: 'a.md' }, { status: ' M', path: 'm.md', origPath: null }];
    const p = planBaseLag({ ...base, lag: 'behind', classified: { ...clean, clean: false, syncOwned: entries } });
    assert.deepEqual(p.discard, ['m.md']);
  });
  it('behind + ANY change that is not sync output -> refuse with the exact remedy and the files named', () => {
    const p = planBaseLag({ ...base, lag: 'behind', classified: { ...clean, clean: false, syncOwned: own('.sync-receipt.json'), other: own('src/mine.js') } });
    assert.equal(p.action, 'refuse');
    assert.equal(p.reason, 'dirty');
    assert.match(p.detail, /17 commit\(s\) behind origin\/main.*src\/mine\.js/);
    assert.match(p.remedy, /git -C "C:\/r" pull --ff-only/);
    const r = planBaseLag({ ...base, lag: 'behind', classified: { ...clean, clean: false, needsReview: own('.claude/skills/x/SKILL.md') } });
    assert.equal(r.reason, 'dirty', 'a hand-edited owned path is the human\'s, not the sync\'s');
  });
  it('an unreadable or degraded classification refuses (it cannot be shown clean), and a long list is truncated', () => {
    assert.equal(planBaseLag({ ...base, lag: 'behind', classified: { ok: false, error: 'git status failed' } }).reason, 'unreadable-status');
    assert.equal(planBaseLag({ ...base, lag: 'behind', classified: { ...clean, clean: false, degraded: true, syncOwned: own('a') } }).reason, 'dirty');
    const many = planBaseLag({ ...base, lag: 'behind', classified: { ...clean, clean: false, other: own(...Array.from({ length: 9 }, (_, i) => `f${i}.js`)) } });
    assert.match(many.detail, /f0\.js, f1\.js, f2\.js, f3\.js, f4\.js, and 4 more/);
  });
  it('diverged refuses (it cannot be fast-forwarded) and names the local commits', () => {
    const p = planBaseLag({ ...base, aheadCount: 2, lag: 'diverged', classified: null });
    assert.equal(p.reason, 'diverged');
    assert.match(p.detail, /17 commit\(s\) behind.*2 commit\(s\) ahead/);
    assert.match(p.remedy, /pull --rebase/);
  });
  it('--allow-stale-base accepts both stale shapes on purpose, touching nothing', () => {
    assert.equal(planBaseLag({ ...base, lag: 'behind', classified: null, allowStale: true }).action, 'proceed-stale');
    assert.equal(planBaseLag({ ...base, aheadCount: 1, lag: 'diverged', classified: null, allowStale: true }).action, 'proceed-stale');
    assert.equal(planBaseLag({ ...base, lag: 'current', classified: null, allowStale: true }).action, 'proceed');
  });
});

// ── B. against real git ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** bare origin + the consumer clone + a second clone that advances origin. */
function world() {
  const ws = tmpDir('base-lag-');
  const origin = path.join(ws, 'origin.git');
  const consumer = path.join(ws, 'consumer');
  const other = path.join(ws, 'other');
  git(['init', '--bare', '-q', '-b', 'main', origin]);
  git(['clone', '-q', origin, consumer]);
  for (const d of [consumer]) { git(['config', 'user.email', 'a@example.invalid'], d); git(['config', 'user.name', 'A'], d); }
  fs.writeFileSync(path.join(consumer, '.sync-receipt.json'), '{"v":1}\n');
  fs.writeFileSync(path.join(consumer, 'app.js'), 'one\n');
  git(['add', '.'], consumer); git(['commit', '-q', '-m', 'seed'], consumer); git(['push', '-q', 'origin', 'main'], consumer);
  git(['clone', '-q', origin, other]);
  git(['config', 'user.email', 'b@example.invalid'], other); git(['config', 'user.name', 'B'], other);
  const advance = (file, text) => { git(['pull', '-q', '--ff-only', 'origin', 'main'], other); fs.writeFileSync(path.join(other, file), text); git(['add', file], other); git(['commit', '-q', '-m', `advance ${file}`], other); git(['push', '-q', 'origin', 'main'], other); };
  return { ws, origin, consumer, advance, head: () => git(['rev-parse', 'HEAD'], consumer), originHead: () => git(['rev-parse', 'refs/heads/main'], origin), rm: () => rmrf(ws) };
}
const cleanClassify = () => ({ ok: true, clean: true, syncOwned: [], needsReview: [], other: [], degraded: false });
const run = spawnRunner;

describe('enforceBaseLag - real git', () => {
  it('behind and clean: fast-forwarded to origin, said plainly', () => {
    const w = world();
    try {
      w.advance('app.js', 'two\n'); w.advance('more.js', 'x\n');
      const r = enforceBaseLag({ repoRoot: w.consumer, run, classify: cleanClassify });
      assert.deepEqual([r.ok, r.outcome], [true, 'fast-forwarded']);
      assert.match(r.lines.join('\n'), /fast-forwarded 2 commit\(s\) to origin\/main/);
      assert.equal(w.head(), w.originHead());
      assert.equal(fs.readFileSync(path.join(w.consumer, 'app.js'), 'utf8'), 'two\n');
    } finally { w.rm(); }
  });
  it('the RECEIPT case: a sync-written file dirty locally AND changed upstream is restored, then the fast-forward lands (the by-hand dance, automated)', () => {
    const w = world();
    try {
      w.advance('.sync-receipt.json', '{"v":2,"landed":true}\n');
      fs.writeFileSync(path.join(w.consumer, '.sync-receipt.json'), '{"v":1,"stale local sync output":true}\n');
      assert.notEqual(git(['status', '--porcelain'], w.consumer), '', 'fixture: the receipt really is dirty');
      const classify = () => ({ ok: true, clean: false, syncOwned: [{ status: ' M', path: '.sync-receipt.json', origPath: null }], needsReview: [], other: [], degraded: false });
      const r = enforceBaseLag({ repoRoot: w.consumer, run, classify });
      assert.equal(r.outcome, 'fast-forwarded', r.lines.join('\n'));
      assert.match(r.lines.join('\n'), /restored 1 sync-written file\(s\) first/);
      assert.equal(w.head(), w.originHead());
      assert.equal(fs.readFileSync(path.join(w.consumer, '.sync-receipt.json'), 'utf8'), '{"v":2,"landed":true}\n');
      assert.equal(git(['status', '--porcelain'], w.consumer), '');
    } finally { w.rm(); }
  });
  it('NEGATIVE CONTROL: the same lag with the human\'s own dirty file is REFUSED - nothing moved, nothing lost, remedy named', () => {
    const w = world();
    try {
      w.advance('app.js', 'two\n');
      fs.writeFileSync(path.join(w.consumer, 'app.js'), 'my unfinished edit\n');
      const before = w.head();
      const classify = () => ({ ok: true, clean: false, syncOwned: [], needsReview: [], other: [{ status: ' M', path: 'app.js', origPath: null }], degraded: false });
      const r = enforceBaseLag({ repoRoot: w.consumer, run, classify });
      assert.deepEqual([r.ok, r.outcome], [false, 'refused']);
      assert.match(r.lines.join('\n'), /REFUSED: .* 1 commit\(s\) behind origin\/main, and it holds changes that are not sync output: app\.js/);
      assert.match(r.lines.join('\n'), /remedy: commit or stash those changes, then git -C ".*" pull --ff-only/);
      assert.equal(w.head(), before);
      assert.equal(fs.readFileSync(path.join(w.consumer, 'app.js'), 'utf8'), 'my unfinished edit\n');
    } finally { w.rm(); }
  });
  it('diverged (local commits origin lacks) is refused; a checkout that is only AHEAD is not lag and proceeds', () => {
    const w = world();
    try {
      fs.writeFileSync(path.join(w.consumer, 'local.js'), 'mine\n'); git(['add', '.'], w.consumer); git(['commit', '-q', '-m', 'local'], w.consumer);
      const ahead = enforceBaseLag({ repoRoot: w.consumer, run, classify: cleanClassify });
      assert.deepEqual([ahead.ok, ahead.outcome], [true, 'current']);
      w.advance('app.js', 'two\n');
      const div = enforceBaseLag({ repoRoot: w.consumer, run, classify: cleanClassify });
      assert.deepEqual([div.ok, div.outcome], [false, 'refused']);
      assert.match(div.lines.join('\n'), /1 commit\(s\) behind.*1 commit\(s\) ahead/);
    } finally { w.rm(); }
  });
  it('--allow-stale-base proceeds without touching the checkout, and says so; --dry-run reports without moving', () => {
    const w = world();
    try {
      w.advance('app.js', 'two\n');
      const before = w.head();
      const stale = enforceBaseLag({ repoRoot: w.consumer, run, classify: cleanClassify, allowStale: true });
      assert.deepEqual([stale.ok, stale.outcome], [true, 'stale-accepted']);
      assert.match(stale.lines.join('\n'), /stale base ACCEPTED \(--allow-stale-base\)/);
      const dry = enforceBaseLag({ repoRoot: w.consumer, run, classify: cleanClassify, dryRun: true });
      assert.deepEqual([dry.ok, dry.outcome], [true, 'would-fast-forward']);
      assert.match(dry.lines.join('\n'), /would fast-forward 1 commit\(s\) to origin\/main \(dry run: nothing changed\)/);
      assert.equal(w.head(), before);
    } finally { w.rm(); }
  });
  it('an origin that cannot be reached is "NOT CHECKED", loudly - an unasked question is not a clean answer - and does not block the sync', () => {
    const ws = tmpDir('base-lag-noremote-');
    try {
      git(['init', '-q', '-b', 'main'], ws);
      const r = enforceBaseLag({ repoRoot: ws, run, classify: cleanClassify });
      assert.deepEqual([r.ok, r.outcome], [true, 'unchecked']);
      assert.match(r.lines.join('\n'), /base lag NOT CHECKED/);
    } finally { rmrf(ws); }
  });
  it('not on the base branch: lag against it says nothing, so nothing is done or said', () => {
    const w = world();
    try {
      w.advance('app.js', 'two\n');
      git(['checkout', '-q', '-b', 'feature'], w.consumer);
      const r = enforceBaseLag({ repoRoot: w.consumer, run, classify: () => { throw new Error('must not be classified'); } });
      assert.deepEqual([r.ok, r.outcome, r.lines], [true, 'current', []]);
    } finally { w.rm(); }
  });
  it('RECOVERABLE: a fast-forward that fails AFTER the restore puts the sync-written changes back, byte for byte, and says so', () => {
    const w = world();
    try {
      w.advance('.sync-receipt.json', '{"v":2}\n');
      fs.writeFileSync(path.join(w.consumer, '.sync-receipt.json'), '{"v":1,"local sync output":true}\n');
      const classify = () => ({ ok: true, clean: false, syncOwned: [{ status: ' M', path: '.sync-receipt.json', origPath: null }], needsReview: [], other: [], degraded: false });
      const flaky = (cmd, args, o) => (args.includes('merge') ? { status: 1, stdout: '', stderr: 'fatal: Unable to create index.lock', error: undefined } : spawnRunner(cmd, args, o));
      const before = w.head();
      const r = enforceBaseLag({ repoRoot: w.consumer, run: flaky, classify });
      assert.deepEqual([r.ok, r.outcome], [false, 'refused']);
      assert.match(r.lines.join('\n'), /The sync-written changes were put back as they were/);
      assert.equal(w.head(), before);
      assert.equal(fs.readFileSync(path.join(w.consumer, '.sync-receipt.json'), 'utf8'), '{"v":1,"local sync output":true}\n');
    } finally { w.rm(); }
  });
  it('if the snapshot cannot be taken NOTHING is restored (the destructive step never runs unrecoverable)', () => {
    const w = world();
    try {
      w.advance('.sync-receipt.json', '{"v":2}\n');
      fs.writeFileSync(path.join(w.consumer, '.sync-receipt.json'), 'local\n');
      const classify = () => ({ ok: true, clean: false, syncOwned: [{ status: ' M', path: '.sync-receipt.json', origPath: null }], needsReview: [], other: [], degraded: false });
      const calls = [];
      const noSnap = (cmd, args, o) => { calls.push(args.filter((a) => !a.startsWith('-')).slice(2, 3)[0]); return args.includes('stash') ? { status: 1, stdout: '', stderr: 'fatal: no snapshot' } : spawnRunner(cmd, args, o); };
      const r = enforceBaseLag({ repoRoot: w.consumer, run: noSnap, classify });
      assert.equal(r.outcome, 'refused');
      assert.match(r.lines.join('\n'), /could not snapshot.*nothing was changed/);
      assert.equal(calls.includes('restore'), false, 'restore must not run without a snapshot');
      assert.equal(fs.readFileSync(path.join(w.consumer, '.sync-receipt.json'), 'utf8'), 'local\n');
    } finally { w.rm(); }
  });
  it('a failed fast-forward is a refusal with the remedy, never a quiet proceed', () => {
    const w = world();
    try {
      w.advance('app.js', 'two\n');
      // The fake runner passes everything through except the merge, which fails the way a lock or a dirty-collision would.
      const flaky = (cmd, args, o) => (args.includes('merge') ? { status: 1, stdout: '', stderr: 'error: Your local changes would be overwritten', error: undefined } : spawnRunner(cmd, args, o));
      const r = enforceBaseLag({ repoRoot: w.consumer, run: flaky, classify: cleanClassify });
      assert.deepEqual([r.ok, r.outcome], [false, 'refused']);
      assert.match(r.lines.join('\n'), /fast-forward to origin\/main failed.*would be overwritten/);
      assert.match(r.lines.join('\n'), /remedy: git -C ".*" status/);
    } finally { w.rm(); }
  });
  it('enforceBaseLagForTarget loads the REAL classifier: a stale checkout with an unowned dirty file is refused through the whole pipeline', async () => {
    const w = world();
    try {
      w.advance('app.js', 'two\n');
      fs.writeFileSync(path.join(w.consumer, 'scratch.txt'), 'untracked human file\n');
      const lines = [];
      const ok = await enforceBaseLagForTarget({ name: 'c', path: w.consumer }, { write: (l) => lines.push(stripAnsi(l)) });
      assert.equal(ok, false);
      assert.match(lines.join('\n'), /base-lag REFUSED: .*scratch\.txt/);
      assert.equal(fs.existsSync(path.join(w.consumer, 'scratch.txt')), true);
    } finally { w.rm(); }
  });
});

// ── C. one oracle ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the remote calls are bounded', () => {
  it('spawnRunner with timeoutMs ends a stalled process as an ordinary failure (so a hung ls-remote reads as "not checked"), and with none it does not time out', () => {
    const t0 = Date.now();
    const hung = spawnRunnerDirect(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 });
    assert.ok(Date.now() - t0 < 10_000);
    assert.ok(hung.error || hung.status !== 0, 'a timed-out process is a failure, never a pass');
    assert.equal(spawnRunnerDirect(process.execPath, ['-e', 'process.stdout.write(process.env.PROBE)'], { env: { PROBE: 'seen' } }).stdout, 'seen');
  });
});

describe('sync:pr and the pre-write check share ONE stale-base predicate', () => {
  it('sync-pr re-exports the very function the sync calls', () => {
    assert.equal(classifyFromSyncPr, classifyBaseLag);
  });
  it('planConsumerPr still refuses a stale base whose paths collided (the after-the-write backstop is intact)', () => {
    const classified = { ok: true, clean: false, degraded: false, syncOwned: [{ status: ' M', path: '.claude/skills/plan/SKILL.md', origPath: null }, { status: ' M', path: '.sync-receipt.json', origPath: null }], needsReview: [], other: [] };
    const plan = planConsumerPr({
      consumerName: 'c', classified, manifest: { commitSha: 'abcdef0123456789', repo: 'o/r' }, baseBranch: 'main', baseSha: 'b'.repeat(40),
      currentBranch: 'main', aheadCount: 0, behindCount: 17, upstreamChanged: ['.sync-receipt.json'], branchExists: false,
    });
    assert.equal(plan.reason, SKIP_REASON.STALE_BASE_COLLISION);
    const fresh = planConsumerPr({
      consumerName: 'c', classified, manifest: { commitSha: 'abcdef0123456789', repo: 'o/r' }, baseBranch: 'main', baseSha: 'b'.repeat(40),
      currentBranch: 'main', aheadCount: 0, behindCount: 17, upstreamChanged: ['unrelated.md'], branchExists: false,
    });
    assert.equal(fresh.action, 'pr', 'behind WITHOUT a collision is still honest');
  });
});

// ── D. the real CLI ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('sync-to-repos.mjs CLI - the lag is asked before the first write', { timeout: 600_000 }, () => {
  function staleConsumer({ dirty }) {
    const w = world();
    fs.rmSync(path.join(w.consumer, '.sync-receipt.json'), { force: true });
    fs.writeFileSync(path.join(w.consumer, 'package.json'), JSON.stringify({ name: 'lag-fixture', type: 'module' }));
    seedInstalledDeps(w.consumer);
    fs.writeFileSync(path.join(w.consumer, '.gitignore'), '');
    git(['add', '-A'], w.consumer); git(['commit', '-q', '-m', 'fixture'], w.consumer); git(['push', '-q', 'origin', 'main'], w.consumer);
    w.advance('upstream-only.txt', 'landed on origin\n');
    if (dirty) fs.writeFileSync(path.join(w.consumer, 'app.js'), 'my unfinished edit\n');
    return w;
  }
  it('REFUSES a stale consumer holding the human\'s own edit: exit non-zero, nothing written, the remedy printed', async () => {
    const w = staleConsumer({ dirty: true });
    try {
      const r = await runSyncCli(['--target-path', w.consumer, '--no-prompt']);
      assert.notEqual(r.code, 0, 'a refused consumer must fail the run');
      const out = stripAnsi(r.out);
      assert.match(out, /base-lag REFUSED: .*behind origin\/main, and it holds changes that are not sync output/);
      assert.match(out, /remedy: commit or stash those changes, then git -C/);
      assert.equal(fs.existsSync(path.join(w.consumer, '.claude', 'skills')), false, 'nothing may be written into a refused consumer');
      assert.equal(fs.existsSync(path.join(w.consumer, '.sync-receipt.json')), false);
      assert.equal(fs.readFileSync(path.join(w.consumer, 'app.js'), 'utf8'), 'my unfinished edit\n');
    } finally { w.rm(); }
  });
  it('a stale CLEAN consumer is fast-forwarded and then synced in the same run', async () => {
    const w = staleConsumer({ dirty: false });
    try {
      const r = await runSyncCli(['--target-path', w.consumer, '--no-prompt']);
      assert.equal(r.code, 0, whySyncFailed(r));
      assert.match(stripAnsi(r.out), /base-lag fast-forwarded 1 commit\(s\) to origin\/main/);
      assert.equal(fs.readFileSync(path.join(w.consumer, 'upstream-only.txt'), 'utf8'), 'landed on origin\n');
      assert.ok(fs.existsSync(path.join(w.consumer, '.sync-receipt.json')), 'the sync ran after the fast-forward');
    } finally { w.rm(); }
  });
  it('--dry-run reports the fast-forward without performing it, and --allow-stale-base is a known flag', async () => {
    const w = staleConsumer({ dirty: false });
    try {
      const before = w.head();
      const dry = await runSyncCli(['--target-path', w.consumer, '--no-prompt', '--dry-run']);
      assert.equal(dry.code, 0, whySyncFailed(dry));
      assert.match(stripAnsi(dry.out), /would fast-forward 1 commit\(s\) to origin\/main \(dry run: nothing changed\)/);
      assert.equal(w.head(), before);
      const stale = await runSyncCli(['--target-path', w.consumer, '--no-prompt', '--dry-run', '--allow-stale-base']);
      assert.equal(stale.code, 0, whySyncFailed(stale));
      assert.match(stripAnsi(stale.out), /stale base ACCEPTED/);
    } finally { w.rm(); }
  });
});
