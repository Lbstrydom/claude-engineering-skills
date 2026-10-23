/**
 * @fileoverview The consumer pre-push hook may not hang silently, and may not audit what main brought in (Tier 3: consumer hook
 * contract - this change ships to repos nobody here can observe).
 *
 * Incident (storyline, 2026-10-18 .. 10-23): the hook hung four times; workers killed it and pushed with AUDIT_PREPUSH_DISABLE=1, so
 * the gate was effectively off. The fourth was a push of a MERGE commit (main merged into the branch): the plan main had landed was
 * selected as "the plan this push changed", and the audit ran 15 minutes with its output in a temp file - silent. The reporter's
 * "nested machine lease" theory was NOT confirmed (the hook acquires no lease; the reporting lane withdrew the guess), so the lease
 * cases here pin what is true: a held lease never makes the hook WAIT, whoever holds it, and a timeout names the holder.
 *
 * Cases (each in both directions where a direction exists):
 *   A. branchOwnedChangedFiles: merge range scoped to the branch's own files; no-merge / unresolvable default ref NEVER narrow.
 *   B. runStep: a budget overrun is exit 124 with step + elapsed + lease holder, never a pass; heartbeat lines; spawn error fails.
 *   C. describeLeaseHolder: free / held by someone else / unreadable (unknown, never "free").
 *   D. the REAL hook: a hanging audit is killed and the push refused (fail closed) with or without AUDIT_PREPUSH_BLOCK; a held lease
 *      does not delay the hook; a merge push audits only branch-own files; a merge push owning nothing skips the audit, loudly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { _internals } from '../scripts/install-prepush-hook.mjs';
import { branchOwnedChangedFiles } from '../scripts/lib/push-range.mjs';
import { runStep, describeLeaseHolder, timeoutRefusal, STEP_TIMEOUT_EXIT } from '../scripts/lib/prepush-step.mjs';
import { ownFilesLine } from '../scripts/prepush-step.mjs';
import { emptyLease, writeLease } from '../scripts/lib/fleet/lease-model.mjs';
import { decideAcquire } from '../scripts/lib/fleet/lease.mjs';
import { hasBash, git, writeStepRunnerStub } from './lib/hook-test-helpers.mjs';

const { HOOK_BODY } = _internals;
const HAS_BASH = hasBash();

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }

// ── A. branchOwnedChangedFiles ──────────────────────────────────────────────────────────────────────────────────────────────────
function fakeGit(map) {
  return (args) => {
    const key = args.join(' ');
    for (const [prefix, out] of Object.entries(map)) if (key.startsWith(prefix)) return out;
    return null;
  };
}

describe('branchOwnedChangedFiles - what the branch itself changed', () => {
  const range = { base: 'aaa', head: 'bbb' };
  it('a merge range keeps only files the non-merge commits (not on the default branch) touched', () => {
    const run = fakeGit({
      'diff --name-only aaa..bbb': 'docs/plans/p.md\nsrc/mine.ts\nsrc/from-main.ts',
      'rev-list --merges --count': '1',
      'rev-parse --verify --quiet origin/main^{commit}': 'deadbeef',
      'rev-list --count --no-merges': '2',
      'log --no-merges --name-only --format= aaa..bbb --not origin/main': 'src/mine.ts\n\nsrc/mine.ts',
    });
    const r = branchOwnedChangedFiles(range, { run });
    assert.deepEqual(r, { files: ['src/mine.ts'], scoped: true, excluded: 2 });
  });
  it('a pure merge of main (the branch owns no commits in the range) is scoped to NOTHING, not mistaken for a git failure', () => {
    const run = fakeGit({
      'diff --name-only aaa..bbb': 'docs/plans/p.md\nsrc/from-main.ts',
      'rev-list --merges --count': '1',
      'rev-parse --verify --quiet origin/main^{commit}': 'deadbeef',
      'rev-list --count --no-merges': '0',
    });
    assert.deepEqual(branchOwnedChangedFiles(range, { run }), { files: [], scoped: true, excluded: 2 });
  });
  it('NEVER narrows when it cannot tell: no merge, unresolvable default ref, git failure', () => {
    const whole = 'a.md\nb.ts';
    const base = { 'diff --name-only aaa..bbb': whole };
    assert.equal(branchOwnedChangedFiles(range, { run: fakeGit({ ...base, 'rev-list --merges --count': '0' }) }).scoped, false);
    const noRef = branchOwnedChangedFiles(range, { run: fakeGit({ ...base, 'rev-list --merges --count': '2' }) });
    assert.deepEqual([noRef.scoped, noRef.reason, noRef.files], [false, 'default-ref-unresolvable', ['a.md', 'b.ts']]);
    const noCount = branchOwnedChangedFiles(range, { run: fakeGit({ ...base, 'rev-list --merges --count': '1', 'rev-parse --verify': 'x' }) });
    assert.deepEqual([noCount.scoped, noCount.reason, noCount.files.length], [false, 'own-count-unavailable', 2]);
    const noLog = branchOwnedChangedFiles(range, { run: fakeGit({ ...base, 'rev-list --merges --count': '1', 'rev-parse --verify': 'x', 'rev-list --count --no-merges': '3' }) });
    assert.deepEqual([noLog.scoped, noLog.reason, noLog.files.length], [false, 'own-log-unavailable', 2]);
    assert.equal(branchOwnedChangedFiles(range, { run: fakeGit({}) }), null, 'a failing diff is "no signal", not "nothing changed"');
  });
  it('refuses an option-shaped default ref instead of handing it to git', () => {
    const r = branchOwnedChangedFiles(range, {
      defaultRef: '--upload-pack=x',
      run: fakeGit({ 'diff --name-only aaa..bbb': 'a', 'rev-list --merges --count': '1' }),
    });
    assert.equal(r.scoped, false);
  });
});

// ── B. runStep ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('runStep - a budget overrun refuses, with the facts', () => {
  const clockOf = (...ts) => { let i = 0; return () => ts[Math.min(i++, ts.length - 1)]; };
  it('timeout -> 124, and the message names the step, the elapsed time, the budget and the lease holder', async () => {
    const lines = [];
    const r = await runStep({
      step: 'code-audit', cmd: 'x', budgetMs: 600_000, progressMs: 0, log: (l) => lines.push(l),
      clock: clockOf(0, 601_000), run: async () => ({ code: null, signal: 'SIGTERM', timedOut: true, stopped: true }),
      leaseText: () => 'machine lease: held by sess-9 (o/r) for gate until 14:05',
    });
    assert.deepEqual([r.code, r.timedOut], [STEP_TIMEOUT_EXIT, true]);
    const text = lines.join('\n');
    assert.match(text, /step 'code-audit' exceeded its 600s budget \(ran 601s\) - push BLOCKED/);
    assert.match(text, /held by sess-9 \(o\/r\)/);
    assert.equal(STEP_TIMEOUT_EXIT, 124);
  });
  it('a step that finishes inside its budget keeps ITS exit code, and prints no refusal', async () => {
    const lines = [];
    for (const code of [0, 3]) {
      const r = await runStep({ step: 's', cmd: 'x', budgetMs: 1000, progressMs: 0, log: (l) => lines.push(l), run: async () => ({ code, timedOut: false }) });
      assert.deepEqual([r.code, r.timedOut], [code, false]);
    }
    assert.deepEqual(lines, []);
  });
  it('a signal death (null code) and a spawn error are failures, never a pass', async () => {
    const lines = [];
    const sig = await runStep({ step: 's', cmd: 'x', budgetMs: 1000, progressMs: 0, run: async () => ({ code: null, signal: 'SIGKILL', timedOut: false }) });
    assert.equal(sig.code, 1);
    const spawnErr = await runStep({ step: 's', cmd: 'x', budgetMs: 1000, progressMs: 0, log: (l) => lines.push(l), run: async () => ({ code: null, spawnError: 'ENOENT', timedOut: false }) });
    assert.equal(spawnErr.code, 1);
    assert.match(lines.join(''), /could not start: ENOENT - push BLOCKED/);
  });
  it('emits a heartbeat while the step runs, and stops it afterwards', async () => {
    const lines = []; let tick; let cleared = false;
    const r = await runStep({
      step: 'code-audit', cmd: 'x', budgetMs: 90_000, progressMs: 30_000, log: (l) => lines.push(l), clock: clockOf(0, 30_000, 31_000),
      every: (fn) => { tick = fn; return { unref() {} }; }, stopEvery: () => { cleared = true; },
      run: async () => { tick(); return { code: 0, timedOut: false }; },
    });
    assert.equal(r.code, 0);
    assert.deepEqual(lines, ['[prepush-hook] code-audit: still running (30s of 90s)']);
    assert.equal(cleared, true);
  });
  it('timeoutRefusal gives the way out and never suggests the push went through', () => {
    const t = timeoutRefusal({ step: 'plan-select', elapsedMs: 61_000, budgetMs: 60_000, lease: 'machine lease: free' });
    assert.match(t, /BLOCKED/);
    assert.match(t, /git push --no-verify/);
    assert.doesNotMatch(t, /passed|skipped/);
  });
});

// ── C. describeLeaseHolder ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('describeLeaseHolder - who has the slot, said honestly', () => {
  const now = new Date('2026-10-23T08:30:00Z');
  const request = (holder) => ({ identity: { repoKey: 'abcdef012345', holder }, repo: 'o/r', kind: 'gate', forMin: 30, pid: process.pid, exclusive: true });
  function leaseDirHeldBy(holder) {
    const dir = tmpDir('lease-holder-');
    const d = decideAcquire(emptyLease(), request(holder), now);
    assert.equal(d.ok, true, JSON.stringify(d));
    writeLease(dir, d.lease);
    return dir;
  }
  it('names the holder of a held slot - whichever session that is', () => {
    const dir = leaseDirHeldBy('sess-other');
    try { assert.match(describeLeaseHolder({ dir, now }), /machine lease: held by sess-other \(o\/r\) for gate until/); } finally { rmrf(dir); }
  });
  it('says free for an empty directory, and UNKNOWN (never free) for a broken store', () => {
    const empty = tmpDir('lease-empty-');
    const broken = tmpDir('lease-broken-');
    try {
      assert.equal(describeLeaseHolder({ dir: empty, now }), 'machine lease: free');
      fs.writeFileSync(path.join(broken, 'lease.json'), '{ not json');
      assert.match(describeLeaseHolder({ dir: broken, now }), /unreadable|unknown/);
      assert.match(describeLeaseHolder({ env: { FLEET_MACHINE_DIR: 'relative/dir' }, now }), /unknown/);
    } finally { rmrf(empty); rmrf(broken); }
  });
});

// ── D. the real hook ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A stub source repo: discovery sentinel, the real step runner, a selecting plan-status stub, and a controllable audit. */
function makeSourceRepo(ws) {
  const root = path.join(ws, 'source-repo');
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'sync-to-repos.mjs'), '// fixture\n');
  writeStepRunnerStub(scripts);
  fs.writeFileSync(path.join(scripts, 'check-plan-status.mjs'), [
    "import fs from 'node:fs';",
    "const a = process.argv.slice(2);",
    "if (a.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }",
    "const i = a.indexOf('--select');",
    "if (i >= 0) { if (fs.existsSync('docs/plans/active.md')) process.stdout.write('docs/plans/active.md\\n'); process.exit(0); }",
    'process.exit(0);', '',
  ].join('\n'));
  // AUDIT_STUB=hang: never returns (with a child, as the real audit has). Otherwise records its argv and exits 0.
  fs.writeFileSync(path.join(scripts, 'openai-audit.mjs'), [
    "import fs from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "fs.writeFileSync('AUDIT_ARGV', JSON.stringify(process.argv.slice(2)));",
    "if (process.env.AUDIT_STUB === 'hang') {",
    "  const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });",
    "  fs.writeFileSync('AUDIT_CHILD_PID', String(c.pid));",
    "  setInterval(() => {}, 1000);",
    '} else process.exit(0);', '',
  ].join('\n'));
  return root;
}

/** origin + clone with an active plan; returns helpers to build a branch that merged main. */
function buildConsumer(ws) {
  const bare = path.join(ws, 'origin.git');
  const local = path.join(ws, 'local');
  git(['init', '--bare', '-q', '-b', 'main', bare]);
  git(['clone', '-q', bare, local]);
  git(['config', 'user.email', 'a@example.invalid'], local);
  git(['config', 'user.name', 'A'], local);
  fs.mkdirSync(path.join(local, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(local, 'docs', 'plans', 'active.md'), '# Plan\n\n- **Status**: In Progress\n');
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(local, rel)), { recursive: true }); fs.writeFileSync(path.join(local, rel), text); git(['add', rel], local); };
  const commit = (msg) => { git(['commit', '-q', '-m', msg], local); return git(['rev-parse', 'HEAD'], local); };
  git(['add', '.'], local);
  commit('seed');
  git(['push', '-q', 'origin', 'main'], local);
  return { local, put, commit };
}

/** main advances (landing a plan edit + code), the feature branch merges it. Returns the push the hook would be handed. */
function mergePush(c, { ownCommitAfterRemote }) {
  const { local, put, commit } = c;
  git(['checkout', '-q', '-b', 'feature'], local);
  put('src/f1.txt', 'f1\n');
  const remoteTip = commit('F1 own work, already on the remote');
  git(['push', '-q', 'origin', 'feature'], local);
  git(['checkout', '-q', 'main'], local);
  put('docs/plans/active.md', '# Plan\n\n- **Status**: In Progress\n\nlanded on main, 149 KB in the incident\n');
  put('src/from-main.txt', 'main\n');
  commit('M1 main moves on');
  git(['push', '-q', 'origin', 'main'], local);
  git(['checkout', '-q', 'feature'], local);
  if (ownCommitAfterRemote) { put('src/f2.txt', 'f2\n'); commit('F2 own work after the remote tip'); }
  git(['merge', '-q', '--no-edit', 'origin/main'], local);
  const head = git(['rev-parse', 'HEAD'], local);
  return { stdin: `refs/heads/feature ${head} refs/heads/feature ${remoteTip}\n`, remoteTip, head };
}

function runHook(local, source, stdin, env = {}) {
  const script = path.join(local, '.hook.sh');
  fs.writeFileSync(script, HOOK_BODY);
  const t0 = Date.now();
  const r = spawnSync('bash', [script, 'origin', 'https://example.invalid'], {
    cwd: local, encoding: 'utf-8', input: stdin, timeout: 120_000,
    env: { ...process.env, CLAUDE_AUDIT_LOOP_DIR: source, AUDIT_PREPUSH_BLOCK: '', AUDIT_PREPUSH_DISABLE: '', AUDIT_STUB: '', ...env },
  });
  return { ...r, ms: Date.now() - t0, audited: fs.existsSync(path.join(local, 'AUDIT_ARGV')) };
}

const argvOf = (local) => JSON.parse(fs.readFileSync(path.join(local, 'AUDIT_ARGV'), 'utf8'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('the real hook - bounded, visible, fail-closed', () => {
  it('a hanging audit is killed with its children and the push is REFUSED naming step, time and lease holder', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-bounded-');
    const lease = tmpDir('hook-lease-');
    try {
      const source = makeSourceRepo(ws);
      const c = buildConsumer(ws);
      c.put('src/own.txt', 'x\n');
      const head = c.commit('own');
      const base = git(['rev-parse', 'HEAD~1'], c.local);
      const d = decideAcquire(emptyLease(), { identity: { repoKey: 'abcdef012345', holder: 'sess-other' }, repo: 'o/r', kind: 'gate', forMin: 30, pid: process.pid, exclusive: true }, new Date());
      writeLease(lease, d.lease);
      const got = runHook(c.local, source, `refs/heads/main ${head} refs/heads/main ${base}\n`, {
        AUDIT_STUB: 'hang', AUDIT_PREPUSH_AUDIT_BUDGET_SEC: '3', AUDIT_PREPUSH_PROGRESS_SEC: '1', FLEET_MACHINE_DIR: lease,
      });
      assert.equal(got.status, 1, `hang must refuse the push:\n${got.stderr}`);
      assert.match(got.stderr, /step 'code-audit' exceeded its 3s budget \(ran [3-9]s\) - push BLOCKED/);
      assert.match(got.stderr, /machine lease: held by sess-other/);
      assert.match(got.stderr, /code-audit: still running/, 'a slow step says so instead of going quiet');
      assert.ok(got.ms < 60_000, `bounded: took ${got.ms}ms`);
      const child = Number(fs.readFileSync(path.join(c.local, 'AUDIT_CHILD_PID'), 'utf8'));
      assert.equal(alive(child), false, 'the audit\'s child must die with it, or the machine keeps burning');
    } finally { rmrf(ws); rmrf(lease); }
  });

  it('refuses even with AUDIT_PREPUSH_BLOCK unset, and a held lease (anyone\'s) never makes the hook WAIT on a fast audit', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-lease-wait-');
    const lease = tmpDir('hook-lease2-');
    try {
      const source = makeSourceRepo(ws);
      const c = buildConsumer(ws);
      c.put('src/own.txt', 'x\n');
      const head = c.commit('own');
      const base = git(['rev-parse', 'HEAD~1'], c.local);
      // The SAME identity the pushing session would use, and a different one: neither may delay or block the hook.
      for (const holder of ['sess-same', 'sess-other']) {
        const d = decideAcquire(emptyLease(), { identity: { repoKey: 'abcdef012345', holder }, repo: 'o/r', kind: 'gate', forMin: 30, pid: process.pid, exclusive: true }, new Date());
        writeLease(lease, d.lease);
        const got = runHook(c.local, source, `refs/heads/main ${head} refs/heads/main ${base}\n`, { FLEET_MACHINE_DIR: lease });
        assert.equal(got.status, 0, `holder ${holder}: ${got.stderr}`);
        assert.equal(got.audited, true);
        assert.ok(got.ms < 30_000, `holder ${holder}: the hook waited ${got.ms}ms`);
        fs.rmSync(path.join(c.local, 'AUDIT_ARGV'));
      }
    } finally { rmrf(ws); rmrf(lease); }
  });

  it('prints one progress line per step', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-progress-');
    try {
      const source = makeSourceRepo(ws);
      const c = buildConsumer(ws);
      c.put('src/own.txt', 'x\n');
      const head = c.commit('own');
      const got = runHook(c.local, source, `refs/heads/main ${head} refs/heads/main ${git(['rev-parse', 'HEAD~1'], c.local)}\n`);
      assert.equal(got.status, 0, got.stderr);
      for (const step of [/▸ plan-status gate/, /▸ plan selection/, /▸ auditing docs\/plans\/active\.md/]) assert.match(got.stderr, step);
    } finally { rmrf(ws); }
  });

  it('a MERGE push audits only the branch\'s own files - not the plan and code main brought in', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-merge-own-');
    try {
      const source = makeSourceRepo(ws);
      const c = buildConsumer(ws);
      const { stdin } = mergePush(c, { ownCommitAfterRemote: true });
      const got = runHook(c.local, source, stdin);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.audited, true, got.stderr);
      const argv = argvOf(c.local);
      assert.deepEqual(argv.slice(0, 2), ['code', 'docs/plans/active.md']);
      assert.equal(argv[2], '--files');
      assert.equal(argv[3], 'src/f2.txt', 'only what the branch wrote after the remote tip');
      assert.doesNotMatch(argv.join(' '), /from-main|--scope/);
    } finally { rmrf(ws); }
  });

  it('a merge push whose branch owns nothing in the range skips the audit - loudly, not silently', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-merge-none-');
    try {
      const source = makeSourceRepo(ws);
      const c = buildConsumer(ws);
      const { stdin } = mergePush(c, { ownCommitAfterRemote: false });
      const got = runHook(c.local, source, stdin);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.audited, false, `main's delta must not be audited as this push's work:\n${got.stderr}`);
      assert.match(got.stderr, /merge push: the branch owns no files in this range/);
    } finally { rmrf(ws); }
  });

  it('a NON-merge push keeps the old audit scope (--scope diff): the fix does not change ordinary pushes', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-nonmerge-');
    try {
      const source = makeSourceRepo(ws);
      const c = buildConsumer(ws);
      c.put('src/own.txt', 'x\n');
      const head = c.commit('own');
      const got = runHook(c.local, source, `refs/heads/main ${head} refs/heads/main ${git(['rev-parse', 'HEAD~1'], c.local)}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.deepEqual(argvOf(c.local), ['code', 'docs/plans/active.md', '--scope', 'diff']);
    } finally { rmrf(ws); }
  });

  it('refuses (fail closed) when the step runner is missing from the source checkout', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-no-runner-');
    try {
      const source = makeSourceRepo(ws);
      fs.rmSync(path.join(source, 'scripts', 'prepush-step.mjs'));
      const c = buildConsumer(ws);
      c.put('src/own.txt', 'x\n');
      const head = c.commit('own');
      const got = runHook(c.local, source, `refs/heads/main ${head} refs/heads/main ${git(['rev-parse', 'HEAD~1'], c.local)}\n`);
      assert.equal(got.status, 1);
      assert.match(got.stderr, /step runner CANNOT RUN/);
      assert.equal(got.audited, false);
    } finally { rmrf(ws); }
  });
});

describe('ownFilesLine - the protocol line the hook reads', () => {
  const ok = { ok: true, base: 'a', head: 'b' };
  it('unscoped when the range cannot be resolved or the branch could not be isolated', () => {
    assert.equal(ownFilesLine({ resolve: () => ({ ok: false }), owned: () => assert.fail('must not ask') }), 'unscoped');
    assert.equal(ownFilesLine({ resolve: () => ok, owned: () => ({ files: ['a'], scoped: false }) }), 'unscoped');
    assert.equal(ownFilesLine({ resolve: () => ok, owned: () => null }), 'unscoped');
  });
  it('scoped carries the list - empty when the branch owns nothing - and refuses to split a path containing a comma', () => {
    assert.equal(ownFilesLine({ resolve: () => ok, owned: () => ({ files: ['a.ts', 'b.ts'], scoped: true }) }), 'scoped:a.ts,b.ts');
    assert.equal(ownFilesLine({ resolve: () => ok, owned: () => ({ files: [], scoped: true }) }), 'scoped:');
    assert.equal(ownFilesLine({ resolve: () => ok, owned: () => ({ files: ['a,b.ts'], scoped: true }) }), 'unscoped');
  });
});

describe('check-plan-status --select on a real merge push (the incident, at the selector)', () => {
  const CLI = path.join(import.meta.dirname, '..', 'scripts', 'check-plan-status.mjs');
  const select = (local, base, head) => spawnSync(process.execPath, [CLI, '--select', 'docs/plans'], {
    cwd: local, encoding: 'utf-8', env: { ...process.env, AUDIT_PUSH_RANGE_BASE: base, AUDIT_PUSH_RANGE_HEAD: head, AUDIT_PREPUSH_PLAN: '' },
  });
  function twoPlanConsumer(ws) {
    const c = buildConsumer(ws);
    c.put('docs/plans/other.md', '# Other\n\n- **Status**: In Progress\n');
    c.commit('second active plan');
    git(['push', '-q', 'origin', 'main'], c.local);
    return c;
  }
  it('a plan that arrived from main is NOT "the plan this push changed"; with two active plans nothing is guessed', (t) => {
    const ws = tmpDir('select-merge-');
    try {
      const c = twoPlanConsumer(ws);
      const { remoteTip, head } = mergePush(c, { ownCommitAfterRemote: true });
      const r = select(c.local, remoteTip, head);
      assert.equal(r.stdout.trim(), '', `selected a plan main landed:\n${r.stderr}`);
      assert.match(r.stderr, /merge push: \d+ file\(s\) that arrived from the default branch/);
    } finally { rmrf(ws); }
  });
  it('a plan the BRANCH edited is still selected on a merge push (the scoping removes noise, not signal)', (t) => {
    const ws = tmpDir('select-merge-own-');
    try {
      const c = twoPlanConsumer(ws);
      const { remoteTip } = mergePush(c, { ownCommitAfterRemote: false });
      c.put('docs/plans/other.md', '# Other\n\n- **Status**: In Progress\n\nbranch edit\n');
      c.commit('branch edits its own plan');
      git(['merge', '-q', '--no-edit', 'origin/main'], c.local); // already up to date: a no-op, the head stays the plan edit
      const head = git(['rev-parse', 'HEAD'], c.local);
      const r = select(c.local, remoteTip, head);
      assert.equal(r.stdout.trim(), 'docs/plans/other.md', r.stderr);
    } finally { rmrf(ws); }
  });
});
