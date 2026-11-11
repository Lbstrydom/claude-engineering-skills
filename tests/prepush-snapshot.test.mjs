/**
 * @fileoverview The audit snapshot (docs/plans/prepush-gate-consumer-feedback-theme1.md D2) against REAL git: a detached worktree of the
 * pushed commit, so every audit reader sees exactly the pushed bytes. Tier 3 (consumer hook seam): both directions throughout.
 *
 *  - lib/prepush-snapshot.mjs: create / remove (stat-verified), shared by CES's own gate and the consumer hook.
 *  - lib/prepush-sandbox-cleanup.mjs: the sweep knows both prefixes, each with its own age rule.
 *  - lib/prepush-planless-steps.mjs: the hook steps (create + sweep + .auditignore, remove guard, how a plan crosses the boundary,
 *    the per-invocation intent file).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createSnapshot, removeSnapshot, snapshotPath, CONSUMER_SNAPSHOT_PREFIX } from '../scripts/lib/prepush-snapshot.mjs';
import { surveySandboxes, SANDBOX_PREFIX, CONSUMER_SNAPSHOT_AGE_MS, STALE_SANDBOX_AGE_MS } from '../scripts/lib/prepush-sandbox-cleanup.mjs';
import { snapshotCreateStep, snapshotRemoveStep, snapshotPlanLine, writePlanlessIntent, isConsumerSnapshotPath, pruneKept } from '../scripts/lib/prepush-planless-steps.mjs';
import { git } from './lib/hook-test-helpers.mjs';

const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
const gitFn = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** A repo with one pushed commit, then a DIRTY tracked file and an untracked 3 MB file in the working tree. */
function repo() {
  const dir = tmpDir('snap-repo-');
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'a@example.invalid'], dir);
  git(['config', 'user.name', 'A'], dir);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const pushed = 1;\n');
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'plans', 'p.md'), '# Plan\r\n\r\nline\r\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'seed'], dir);
  fs.writeFileSync(path.join(dir, 'src', 'b.mjs'), 'export const b = 2;\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'feat: add b\n\nbody of the second commit'], dir);
  const head = git(['rev-parse', 'HEAD'], dir);
  fs.writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const pushed = 1; // DIRTY, never pushed\n');
  fs.writeFileSync(path.join(dir, 'src', 'huge-untracked.txt'), 'x'.repeat(3 * 1024 * 1024));
  return { dir, head, base: git(['rev-parse', 'HEAD~1'], dir) };
}

describe('createSnapshot / removeSnapshot (real git)', () => {
  it('the snapshot holds the PUSHED bytes: the dirty edit and the untracked 3 MB file are absent', () => {
    const r = repo();
    const dir = snapshotPath({ prefix: CONSUMER_SNAPSHOT_PREFIX, tag: 'test', tmpDir: os.tmpdir() });
    try {
      const c = createSnapshot({ repoRoot: r.dir, sha: r.head, dir });
      assert.equal(c.ok, true, c.error);
      assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.mjs'), 'utf8'), 'export const pushed = 1;\n', 'the pushed bytes, not the dirty edit');
      assert.equal(fs.existsSync(path.join(dir, 'src', 'huge-untracked.txt')), false, 'untracked files never reach the snapshot');
      assert.equal(fs.existsSync(path.join(dir, 'src', 'b.mjs')), true);
      assert.equal(git(['rev-parse', 'HEAD'], dir), r.head);
      assert.equal(git(['status', '--porcelain'], dir), '', 'a clean tree: the audit\'s diff is exactly the pushed range');
      // Negative control: the checkout itself still has both, so their absence above is the snapshot's doing.
      assert.ok(fs.existsSync(path.join(r.dir, 'src', 'huge-untracked.txt')));
    } finally { removeSnapshot({ repoRoot: r.dir, dir }); rmrf(r.dir); }
  });
  it('removeSnapshot verifies by stat: gone from disk AND from `git worktree list`', () => {
    const r = repo();
    const dir = snapshotPath({ prefix: CONSUMER_SNAPSHOT_PREFIX, tag: 'rm', tmpDir: os.tmpdir() });
    try {
      assert.equal(createSnapshot({ repoRoot: r.dir, sha: r.head, dir }).ok, true);
      fs.writeFileSync(path.join(dir, '.audit-scratch'), 'written by the audit inside the snapshot');
      const res = removeSnapshot({ repoRoot: r.dir, dir });
      assert.equal(res.removed, true);
      assert.equal(fs.existsSync(dir), false);
      assert.doesNotMatch(git(['worktree', 'list'], r.dir).replace(/\\/g, '/'), new RegExp(path.basename(dir)));
    } finally { rmrf(r.dir); }
  });
  it('an unknown commit is a refusal with git\'s reason, never a snapshot of something else', () => {
    const r = repo();
    const dir = snapshotPath({ prefix: CONSUMER_SNAPSHOT_PREFIX, tag: 'bad', tmpDir: os.tmpdir() });
    try {
      const c = createSnapshot({ repoRoot: r.dir, sha: 'f'.repeat(40), dir });
      assert.equal(c.ok, false);
      assert.match(c.error, /could not create the snapshot worktree/);
      assert.equal(fs.existsSync(dir), false);
    } finally { rmrf(r.dir); }
  });
});

describe('the sweep knows both prefixes, each with its own age rule', () => {
  const hour = 3_600_000;
  function husk(tmp, name, ageMs, now) {
    const d = path.join(tmp, name);
    fs.mkdirSync(d);
    const t = (now - ageMs) / 1000;
    fs.utimesSync(d, t, t);
    return d;
  }
  it('a 25h consumer snapshot is swept, a fresh one is kept; a 7h consumer snapshot is kept while a 7h CES sandbox is swept', () => {
    const tmp = tmpDir('sweep-');
    try {
      const now = Date.now();
      const alive = () => 'alive';
      const oldSnap = husk(tmp, `${CONSUMER_SNAPSHOT_PREFIX}aaaaaaaaaaaa-111`, 25 * hour, now);
      const freshSnap = husk(tmp, `${CONSUMER_SNAPSHOT_PREFIX}bbbbbbbbbbbb-222`, 1 * hour, now);
      const midSnap = husk(tmp, `${CONSUMER_SNAPSHOT_PREFIX}cccccccccccc-333`, 7 * hour, now);
      const midCes = husk(tmp, `${SANDBOX_PREFIX}dddddddd-444`, 7 * hour, now);
      const other = husk(tmp, 'someone-elses-dir-555', 100 * hour, now);
      const s = surveySandboxes(tmp, { now, probeOwner: alive });
      assert.deepEqual(new Set(s.stale), new Set([oldSnap, midCes]));
      assert.ok(s.young.some((h) => h.dir === freshSnap));
      assert.ok(s.young.some((h) => h.dir === midSnap && h.maxAgeMs === CONSUMER_SNAPSHOT_AGE_MS));
      assert.ok(![...s.stale, ...s.young.map((h) => h.dir)].includes(other), 'never another tool\'s directory');
      assert.ok(CONSUMER_SNAPSHOT_AGE_MS > STALE_SANDBOX_AGE_MS);
    } finally { rmrf(tmp); }
  });
  it('a consumer snapshot whose owner process is dead is swept at once (a SIGKILLed push)', () => {
    const tmp = tmpDir('sweep-dead-');
    try {
      const now = Date.now();
      const d = husk(tmp, `${CONSUMER_SNAPSHOT_PREFIX}eeeeeeeeeeee-999999`, 60_000, now);
      const s = surveySandboxes(tmp, { now, probeOwner: () => 'dead' });
      assert.deepEqual(s.ownerDead, [d]);
    } finally { rmrf(tmp); }
  });
  it('an explicit prefix keeps the single-prefix behaviour (CES\'s own callers that pass one)', () => {
    const tmp = tmpDir('sweep-one-');
    try {
      const now = Date.now();
      husk(tmp, `${CONSUMER_SNAPSHOT_PREFIX}ffffffffffff-1`, 30 * hour, now);
      assert.deepEqual(surveySandboxes(tmp, { now, prefix: SANDBOX_PREFIX, probeOwner: () => 'alive' }).stale, []);
    } finally { rmrf(tmp); }
  });
});

describe('snapshotCreateStep / snapshotRemoveStep - the hook steps', () => {
  it('creates the snapshot of --head, prints its path, and copies an UNTRACKED .auditignore in', () => {
    const r = repo();
    fs.writeFileSync(path.join(r.dir, '.auditignore'), 'vendor/**\n');
    const lines = [];
    const tmp = tmpDir('snapstep-');
    let made = '';
    try {
      const res = snapshotCreateStep({ cwd: r.dir, headArg: r.head, ownerPid: process.pid, gitFn, write: (l) => lines.push(l), tmpDir: tmp, sweep: () => ({ swept: [], failed: [], young: [], unsurveyed: [] }) });
      assert.equal(res.code, 0, lines.join('\n'));
      made = res.line;
      assert.ok(path.basename(made).startsWith(CONSUMER_SNAPSHOT_PREFIX));
      assert.equal(fs.readFileSync(path.join(made, '.auditignore'), 'utf8'), 'vendor/**\n');
      assert.match(lines.join('\n'), /\.auditignore is untracked here - copied in/);
      assert.match(lines.join('\n'), /reads the pushed commit, not the working tree/);
    } finally { if (made) snapshotRemoveStep({ cwd: r.dir, dir: made, write: () => {} }); rmrf(tmp); rmrf(r.dir); }
  });
  it('NEGATIVE: no .auditignore in the checkout -> none is invented in the snapshot', () => {
    const r = repo();
    const tmp = tmpDir('snapstep-none-');
    let made = '';
    try {
      const res = snapshotCreateStep({ cwd: r.dir, headArg: r.head, ownerPid: process.pid, gitFn, write: () => {}, tmpDir: tmp, sweep: () => ({ swept: [], failed: [], young: [], unsurveyed: [] }) });
      made = res.line;
      assert.equal(fs.existsSync(path.join(made, '.auditignore')), false);
    } finally { if (made) snapshotRemoveStep({ cwd: r.dir, dir: made, write: () => {} }); rmrf(tmp); rmrf(r.dir); }
  });
  it('an unresolvable head refuses (exit 1) - it never falls back to the working tree', () => {
    const r = repo();
    const lines = [];
    try {
      const res = snapshotCreateStep({ cwd: r.dir, headArg: 'no-such-ref', ownerPid: process.pid, gitFn, write: (l) => lines.push(l), sweep: () => ({ swept: [], failed: [], young: [], unsurveyed: [] }) });
      assert.equal(res.code, 1);
      assert.match(lines.join('\n'), /could not be resolved.*push BLOCKED/);
    } finally { rmrf(r.dir); }
  });
  it('the snapshot is named for its OWNER pid (the hook), never the step; no owner pid is a refusal (audit B R1 H1)', () => {
    const r = repo();
    const tmp = tmpDir('snapstep-owner-');
    let made = '';
    try {
      const none = snapshotCreateStep({ cwd: r.dir, headArg: r.head, ownerPid: NaN, gitFn, write: () => {}, tmpDir: tmp, sweep: () => ({ swept: [], failed: [], young: [], unsurveyed: [] }) });
      assert.equal(none.code, 1);
      const res = snapshotCreateStep({ cwd: r.dir, headArg: r.head, ownerPid: 424242, gitFn, write: () => {}, tmpDir: tmp, sweep: () => ({ swept: [], failed: [], young: [], unsurveyed: [] }) });
      made = res.line;
      assert.match(path.basename(made), /-424242$/);
    } finally { if (made) snapshotRemoveStep({ cwd: r.dir, dir: made, write: () => {}, tmpDir: tmp }); rmrf(tmp); rmrf(r.dir); }
  });
  it('a .auditignore TRACKED in the checkout but deleted by the pushed commit is NOT copied in (audit B R1 H7)', () => {
    const r = repo();
    fs.writeFileSync(path.join(r.dir, '.auditignore'), 'tracked/**\n');
    git(['add', '.auditignore'], r.dir);
    git(['commit', '-q', '-m', 'track auditignore'], r.dir);
    const tracked = git(['rev-parse', 'HEAD'], r.dir);
    git(['rm', '-q', '.auditignore'], r.dir);
    git(['commit', '-q', '-m', 'pushed commit deletes it'], r.dir);
    const pushed = git(['rev-parse', 'HEAD'], r.dir);
    git(['checkout', '-q', tracked], r.dir); // the checkout still tracks it
    const tmp = tmpDir('snapstep-tracked-');
    let made = '';
    try {
      const res = snapshotCreateStep({ cwd: r.dir, headArg: pushed, ownerPid: process.pid, gitFn, write: () => {}, tmpDir: tmp, sweep: () => ({ swept: [], failed: [], young: [], unsurveyed: [] }) });
      made = res.line;
      assert.equal(res.code, 0);
      assert.equal(fs.existsSync(path.join(made, '.auditignore')), false, 'the pushed commit deleted it; the checkout copy is not an untracked override');
    } finally { if (made) snapshotRemoveStep({ cwd: r.dir, dir: made, write: () => {}, tmpDir: tmp }); rmrf(tmp); rmrf(r.dir); }
  });
  it('remove accepts only a snapshot NAME directly under the temp root (audit B R1 H3)', () => {
    const tmp = tmpDir('snaproot-');
    const elsewhere = tmpDir('elsewhere-');
    try {
      assert.equal(isConsumerSnapshotPath(path.join(tmp, `${CONSUMER_SNAPSHOT_PREFIX}0123456789ab-77`), tmp), true);
      assert.equal(isConsumerSnapshotPath(path.join(elsewhere, `${CONSUMER_SNAPSHOT_PREFIX}0123456789ab-77`), tmp), false, 'right name, wrong root');
      assert.equal(isConsumerSnapshotPath(path.join(tmp, `${CONSUMER_SNAPSHOT_PREFIX}evil`), tmp), false, 'prefix alone is not a name');
      const victim = path.join(elsewhere, `${CONSUMER_SNAPSHOT_PREFIX}0123456789ab-77`);
      fs.mkdirSync(victim);
      assert.equal(snapshotRemoveStep({ cwd: elsewhere, dir: victim, write: () => {}, tmpDir: tmp }).removed, false);
      assert.equal(fs.existsSync(victim), true);
    } finally { rmrf(tmp); rmrf(elsewhere); }
  });
  it('remove refuses a path that is not an audit snapshot (a cleanup path must not be aimable at anything else)', () => {
    const victim = tmpDir('not-a-snapshot-');
    try {
      const lines = [];
      const res = snapshotRemoveStep({ cwd: victim, dir: victim, write: (l) => lines.push(l) });
      assert.equal(res.removed, false);
      assert.equal(fs.existsSync(victim), true);
      assert.match(lines.join('\n'), /refusing to remove/);
    } finally { rmrf(victim); }
  });
});

describe('snapshotPlanLine - how a selected plan crosses into the snapshot', () => {
  it('relative when the snapshot holds the same bytes (CRLF folded); checkout-absolute when edited, untracked or absolute', () => {
    const r = repo();
    const dir = snapshotPath({ prefix: CONSUMER_SNAPSHOT_PREFIX, tag: 'plan', tmpDir: os.tmpdir() });
    try {
      assert.equal(createSnapshot({ repoRoot: r.dir, sha: r.head, dir }).ok, true);
      // Same content, LF in the snapshot vs CRLF in the checkout (autocrlf on Windows): still the same plan.
      fs.writeFileSync(path.join(dir, 'docs', 'plans', 'p.md'), '# Plan\n\nline\n');
      assert.equal(snapshotPlanLine({ cwd: r.dir, snapshotDir: dir, plan: 'docs/plans/p.md' }), 'relative docs/plans/p.md');
      fs.writeFileSync(path.join(r.dir, 'docs', 'plans', 'p.md'), '# Plan\n\nedited locally\n');
      assert.match(snapshotPlanLine({ cwd: r.dir, snapshotDir: dir, plan: 'docs/plans/p.md' }), /^checkout .*\/docs\/plans\/p\.md$/);
      fs.writeFileSync(path.join(r.dir, 'docs', 'plans', 'untracked.md'), '# U\n');
      assert.match(snapshotPlanLine({ cwd: r.dir, snapshotDir: dir, plan: 'docs/plans/untracked.md' }), /^checkout .*\/docs\/plans\/untracked\.md$/);
      const abs = path.join(r.dir, 'docs', 'plans', 'untracked.md');
      assert.match(snapshotPlanLine({ cwd: r.dir, snapshotDir: dir, plan: abs }), /^checkout .*untracked\.md$/);
    } finally { removeSnapshot({ repoRoot: r.dir, dir }); rmrf(r.dir); }
  });
});

describe('writePlanlessIntent - the per-invocation intent file', () => {
  it('holds the branch\'s own commit messages for the range, redacted, at a name keyed by tree, base, head and pid', () => {
    const r = repo();
    try {
      const res = writePlanlessIntent({ range: { base: r.base, head: r.head }, cwd: r.dir, gitFn, env: {}, pid: 4242 });
      assert.equal(res.ok, true, res.why);
      assert.equal(res.count, 1);
      const text = fs.readFileSync(res.path, 'utf8');
      assert.match(text, /feat: add b/);
      assert.match(text, /body of the second commit/);
      assert.doesNotMatch(text, /seed/, 'only the pushed range');
      assert.match(path.basename(res.path), new RegExp(`^[0-9a-f]{12}-${r.base.slice(0, 12)}-${r.head.slice(0, 12)}-4242\\.intent\\.md$`));
    } finally { rmrf(r.dir); }
  });
  it('two invocations with the same tree but different ranges get two files, each with its own messages', () => {
    const r = repo();
    try {
      const a = writePlanlessIntent({ range: { base: r.base, head: r.head }, cwd: r.dir, gitFn, env: {}, pid: 1 });
      // An empty commit on top: the SAME tree, a different range and an extra message.
      git(['commit', '-q', '--allow-empty', '-m', 'fix: tree-preserving follow-up'], r.dir);
      const head2 = git(['rev-parse', 'HEAD'], r.dir);
      assert.equal(git(['rev-parse', `${head2}^{tree}`], r.dir), git(['rev-parse', `${r.head}^{tree}`], r.dir), 'fixture: same tree');
      const b = writePlanlessIntent({ range: { base: r.base, head: head2 }, cwd: r.dir, gitFn, env: {}, pid: 1 });
      assert.notEqual(a.path, b.path);
      assert.doesNotMatch(fs.readFileSync(a.path, 'utf8'), /tree-preserving follow-up/);
      assert.match(fs.readFileSync(b.path, 'utf8'), /tree-preserving follow-up/);
      assert.ok(fs.existsSync(a.path) && fs.existsSync(b.path), 'neither overwrote the other');
    } finally { rmrf(r.dir); }
  });
  it('a git failure is NOT an empty intent: ok:false with the reason, and no file', () => {
    const r = repo();
    try {
      const failing = (cwd, args) => { if (args[0] === 'log') { const e = new Error('boom'); e.status = 128; throw e; } return gitFn(cwd, args); };
      const res = writePlanlessIntent({ range: { base: r.base, head: r.head }, cwd: r.dir, gitFn: failing, env: {} });
      assert.equal(res.ok, false);
      assert.match(res.why, /could not list the pushed commits' messages/);
      assert.equal(fs.existsSync(path.join(r.dir, '.audit', 'prepush')), false);
    } finally { rmrf(r.dir); }
  });
  it('retention never prunes an intent file younger than an hour - a concurrent push may not have read it yet (audit B R1 H8)', () => {
    const dir = tmpDir('prune-');
    try {
      const now = Date.now();
      for (const [n, ageMin] of [['a', 5], ['b', 10], ['c', 120]]) {
        const f = path.join(dir, `${n}.intent.md`);
        fs.writeFileSync(f, n);
        const t = (now - ageMin * 60_000) / 1000;
        fs.utimesSync(f, t, t);
      }
      pruneKept(dir, { suffix: '.intent.md', protect: 'mine.intent.md', keepArg: '1', minAgeMs: 3_600_000, now });
      assert.deepEqual(fs.readdirSync(dir).sort(), ['a.intent.md', 'b.intent.md'], 'only the 2h-old file is pruned; the young ones survive KEEP=1');
    } finally { rmrf(dir); }
  });
  it('a range that is not a pair of commit ids is refused', () => {
    assert.equal(writePlanlessIntent({ range: { base: 'HEAD~1', head: 'HEAD' }, cwd: '.', gitFn }).ok, false);
  });
});
