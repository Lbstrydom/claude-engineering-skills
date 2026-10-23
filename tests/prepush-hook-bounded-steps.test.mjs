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
import { hasBash, git } from './lib/hook-test-helpers.mjs';
import { writeStepRunnerStub } from './lib/prepush-step-stub.mjs';

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
  const nul = (...names) => names.map((n) => n + '\0').join('');
  const MARK = '\x01abc123\0';
  const base = { 'rev-list --merges --count': '1', 'rev-parse --verify --quiet origin/main^{commit}': 'deadbeef' };
  it('a merge range keeps the branch non-merge files AND what the merge itself authored - not what came from main', () => {
    const run = fakeGit({
      ...base,
      'diff --name-only -z aaa..bbb': nul('docs/plans/p.md', 'src/mine.ts', 'src/from-main.ts', 'src/resolved.ts', 'src/café.ts'),
      'rev-list --count --no-merges': '2',
      'log --no-merges --name-only -z --format= aaa..bbb --not origin/main': nul('src/mine.ts', 'src/mine.ts', 'src/café.ts'),
      'log --merges --cc --name-only -z': MARK + '\0' + nul('src/resolved.ts'),
    });
    const r = branchOwnedChangedFiles(range, { run });
    assert.deepEqual(r, { files: ['src/mine.ts', 'src/resolved.ts', 'src/café.ts'], scoped: true, excluded: 2 });
  });
  it('a pure CLEAN merge of main (no own commits, nothing authored) is scoped to NOTHING, not mistaken for a git failure', () => {
    const run = fakeGit({
      ...base,
      'diff --name-only -z aaa..bbb': nul('docs/plans/p.md', 'src/from-main.ts'),
      'rev-list --count --no-merges': '0',
      'log --merges --cc --name-only -z': MARK,
    });
    assert.deepEqual(branchOwnedChangedFiles(range, { run }), { files: [], scoped: true, excluded: 2 });
  });
  it('a merge that AUTHORED a file (conflict resolution, evil merge) is never scoped to nothing', () => {
    const run = fakeGit({
      ...base,
      'diff --name-only -z aaa..bbb': nul('a.ts', 'from-main.ts'),
      'rev-list --count --no-merges': '0',
      'log --merges --cc --name-only -z': MARK + '\0' + nul('a.ts'),
    });
    assert.deepEqual(branchOwnedChangedFiles(range, { run }).files, ['a.ts']);
  });
  it('NEVER narrows when it cannot tell: no merge, unresolvable default ref, any failing git call', () => {
    const whole = nul('a.md', 'b.ts');
    const diff = { 'diff --name-only -z aaa..bbb': whole };
    assert.equal(branchOwnedChangedFiles(range, { run: fakeGit({ ...diff, 'rev-list --merges --count': '0' }) }).scoped, false);
    const noRef = branchOwnedChangedFiles(range, { run: fakeGit({ ...diff, 'rev-list --merges --count': '2' }) });
    assert.deepEqual([noRef.scoped, noRef.reason, noRef.files], [false, 'default-ref-unresolvable', ['a.md', 'b.ts']]);
    const withRef = { ...diff, ...base };
    const cases = [
      [{ ...withRef }, 'own-count-unavailable'],
      [{ ...withRef, 'rev-list --count --no-merges': '3' }, 'own-log-unavailable'],
      [{ ...withRef, 'rev-list --count --no-merges': '0' }, 'merge-authored-unavailable'],
    ];
    for (const [map, reason] of cases) {
      const r = branchOwnedChangedFiles(range, { run: fakeGit(map) });
      assert.deepEqual([r.scoped, r.reason, r.files.length], [false, reason, 2]);
    }
    assert.equal(branchOwnedChangedFiles(range, { run: fakeGit({}) }), null, 'a failing diff is "no signal", not "nothing changed"');
  });
  it('refuses an option-shaped default ref instead of handing it to git', () => {
    const r = branchOwnedChangedFiles(range, {
      defaultRef: '--upload-pack=x',
      run: fakeGit({ 'diff --name-only -z aaa..bbb': nul('a'), 'rev-list --merges --count': '1' }),
    });
    assert.equal(r.scoped, false);
  });
});

describe('branchOwnedChangedFiles - against REAL git output (the fakes above encode what we expect git to print)', () => {
  it('two merges in one range, each authoring a file: both authored paths are found, no header byte leaks into a path', (t) => {
    const ws = tmpDir('real-two-merges-');
    try {
      const c = buildConsumer(ws);
      const { remoteTip } = mergePush(c, { ownCommitAfterRemote: false });
      c.put('src/evil-one.txt', 'one\n');
      git(['commit', '-q', '--amend', '--no-edit'], c.local); // merge 1 authors a file
      git(['checkout', '-q', 'main'], c.local);
      c.put('src/from-main-2.txt', 'm2\n');
      c.commit('M2');
      git(['push', '-q', 'origin', 'main'], c.local);
      git(['checkout', '-q', 'feature'], c.local);
      git(['merge', '-q', '--no-edit', '--no-commit', 'origin/main'], c.local);
      c.put('src/evil-two café.txt', 'two\n');
      c.put(' lead.txt', 'a path with leading whitespace\n');
      c.commit('merge 2 authors a file');
      const head = git(['rev-parse', 'HEAD'], c.local);
      // The SHIPPED runner (push-range's defaultRun), which reads the current directory - not a re-spelling of it.
      const cwd = process.cwd();
      let r;
      try { process.chdir(c.local); r = branchOwnedChangedFiles({ base: remoteTip, head }); } finally { process.chdir(cwd); }
      assert.equal(r.scoped, true, r.reason);
      assert.deepEqual(r.files, [' lead.txt', 'src/evil-one.txt', 'src/evil-two café.txt'], 'leading whitespace of a path is part of the path');
      assert.ok(r.files.every((f) => !/[\x00-\x1f]/.test(f)), 'no control byte may leak into a path');
      assert.ok(!r.files.some((f) => /from-main/.test(f)));
    } finally { rmrf(ws); }
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
    assert.deepEqual([sig.code, sig.signal], [137, 'SIGKILL'], 'a signal death keeps WHICH signal: 128 + its number');
    const bare = await runStep({ step: 's', cmd: 'x', budgetMs: 1000, progressMs: 0, run: async () => ({ code: null, signal: null, timedOut: false }) });
    assert.equal(bare.code, 1);
    const spawnErr = await runStep({ step: 's', cmd: 'x', budgetMs: 1000, progressMs: 0, log: (l) => lines.push(l), run: async () => ({ code: null, spawnError: 'ENOENT', timedOut: false }) });
    assert.equal(spawnErr.code, 1);
    assert.match(lines.join(''), /could not start: ENOENT - push BLOCKED/);
  });
  it('a step stopped from outside is INTERRUPTED (130), never a pass and never a timeout', async () => {
    const lines = [];
    const r = await runStep({ step: 'code-audit', cmd: 'x', budgetMs: 1000, progressMs: 0, log: (l) => lines.push(l), run: async () => ({ code: null, signal: 'SIGTERM', timedOut: false, stopped: true }) });
    assert.deepEqual([r.code, r.interrupted, r.timedOut], [130, true, false]);
    assert.match(lines.join(''), /was interrupted after .*push BLOCKED/);
  });
  it('forwards the stop request to the child runner', async () => {
    const ac = new AbortController();
    let seen;
    await runStep({ step: 's', cmd: 'x', budgetMs: 1000, progressMs: 0, signal: ac.signal, run: async (o) => { seen = o.signal; return { code: 0, timedOut: false }; } });
    assert.equal(seen, ac.signal);
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
    "if (a.includes('--selfcheck-relocation')) {",
    "  if (process.env.STUB_PROBE_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUB_PROBE_SLEEP_MS));",
    "  console.log('OK'); process.exit(0);",
    '}',
    "const i = a.indexOf('--select');",
    "if (i >= 0) { if (fs.existsSync('docs/plans/active.md')) process.stdout.write('docs/plans/active.md\\n'); process.exit(0); }",
    'process.exit(0);', '',
  ].join('\n'));
  // AUDIT_STUB=hang: never returns (with a child, as the real audit has). Otherwise records its argv and behaves like the real
  // audit's exit contract: exit 0 with a result envelope in --out for ANY completed run (findings never change the exit code),
  // `exit3` = INCOMPLETE, `crash` = an uncaught error (exit 1, no envelope), `noenvelope` = exit 0 having written nothing.
  fs.writeFileSync(path.join(scripts, 'openai-audit.mjs'), [
    "import fs from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "fs.writeFileSync('AUDIT_ARGV', JSON.stringify(process.argv.slice(2)));",
    "const mode = process.env.AUDIT_STUB || 'pass';",
    "const envelope = (verdict, findings) => { const i = process.argv.indexOf('--out'); if (i >= 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify({ verdict, findings })); };",
    "if (mode === 'hang') {",
    "  const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });",
    "  fs.writeFileSync('AUDIT_CHILD_PID', String(c.pid));",
    "  setInterval(() => {}, 1000);",
    "} else if (mode === 'crash') { console.error('Error: audit aborted - boom'); process.exit(1); }",
    "else if (mode === 'exit3') { envelope('INCOMPLETE', []); process.exit(3); }",
    "else if (mode === 'noenvelope') process.exit(0);",
    "else if (mode === 'findings') { envelope('SIGNIFICANT_ISSUES', [{ severity: 'HIGH' }, { severity: 'MEDIUM' }]); process.exit(0); }",
    "else { envelope('PASS', []); process.exit(0); }", '',
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
        fs.rmSync(path.join(c.local, 'AUDIT_ARGV'), { recursive: true, maxRetries: 3, retryDelay: 50 });
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

  it('a file the MERGE itself authored (conflict resolution / evil merge) is audited, and a non-ASCII path survives the hand-off intact', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-merge-authored-');
    try {
      const source = makeSourceRepo(ws);
      const c = buildConsumer(ws);
      const { remoteTip } = mergePush(c, { ownCommitAfterRemote: true });
      c.put('src/evil café.txt', 'written by the merge\n');
      git(['commit', '-q', '--amend', '--no-edit'], c.local);
      const head = git(['rev-parse', 'HEAD'], c.local);
      const got = runHook(c.local, source, `refs/heads/feature ${head} refs/heads/feature ${remoteTip}\n`);
      assert.equal(got.status, 0, got.stderr);
      assert.equal(argvOf(c.local)[3], 'src/evil café.txt,src/f2.txt', 'the merge-authored file is in scope, main\'s files are not');
    } finally { rmrf(ws); }
  });

  it('a slow runner probe (heartbeat due) does not turn a healthy checker into "CANNOT RUN"', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-slow-probe-');
    try {
      const source = makeSourceRepo(ws);
      const c = buildConsumer(ws);
      c.put('src/own.txt', 'x\n');
      const head = c.commit('own');
      const got = runHook(c.local, source, `refs/heads/main ${head} refs/heads/main ${git(['rev-parse', 'HEAD~1'], c.local)}\n`, {
        STUB_PROBE_SLEEP_MS: '2500', AUDIT_PREPUSH_PROGRESS_SEC: '1',
      });
      assert.equal(got.status, 0, got.stderr);
      assert.doesNotMatch(got.stderr, /CANNOT RUN/);
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

  it('a NON-merge push audits the WHOLE range git handed the hook (--base), not the audit HEAD~1 default', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-nonmerge-');
    try {
      const source = makeSourceRepo(ws);
      const c = buildConsumer(ws);
      c.put('src/own.txt', 'x\n');
      const head = c.commit('own');
      const base = git(['rev-parse', 'HEAD~1'], c.local);
      const got = runHook(c.local, source, `refs/heads/main ${head} refs/heads/main ${base}\n`);
      assert.equal(got.status, 0, got.stderr);
      const argv = argvOf(c.local);
      assert.equal(argv[argv.length - 2], '--out', 'the hook reads the audit\'s verdict from its own envelope');
      assert.deepEqual(argv.slice(0, -2), ['code', 'docs/plans/active.md', '--scope', 'diff', '--base', base]);
    } finally { rmrf(ws); }
  });

  it('refuses (fail closed) when the step runner is missing from the source checkout', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-no-runner-');
    try {
      const source = makeSourceRepo(ws);
      fs.rmSync(path.join(source, 'scripts', 'prepush-step.mjs'), { recursive: true, maxRetries: 3, retryDelay: 50 });
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
  const ok = { ok: true, base: 'a', head: 'b', source: 'explicit', trusted: true };
  it('unscoped when the range cannot be resolved or the branch could not be isolated', () => {
    assert.equal(ownFilesLine({ resolve: () => ({ ok: false }), owned: () => assert.fail('must not ask') }), 'unscoped');
    assert.equal(ownFilesLine({ resolve: () => ok, owned: () => ({ files: ['a'], scoped: false }) }), 'unscoped');
    assert.equal(ownFilesLine({ resolve: () => ok, owned: () => null }), 'unscoped');
    // An INFERRED range may already be too small to narrow from.
    const inferred = { ...ok, source: 'fork-point', trusted: false };
    assert.equal(ownFilesLine({ resolve: () => inferred, owned: () => assert.fail('must not narrow an inferred range') }), 'unscoped');
  });
  it('scoped carries the list - empty when the branch owns nothing - and refuses to split a path containing a comma', () => {
    assert.equal(ownFilesLine({ resolve: () => ok, owned: () => ({ files: ['a.ts', 'b.ts'], scoped: true }) }), 'scoped:a.ts,b.ts');
    assert.equal(ownFilesLine({ resolve: () => ok, owned: () => ({ files: [], scoped: true }) }), 'scoped:');
    assert.equal(ownFilesLine({ resolve: () => ok, owned: () => ({ files: ['a,b.ts'], scoped: true }) }), 'unscoped');
    assert.equal(ownFilesLine({ resolve: () => ok, owned: () => ({ files: ['a\nb.ts'], scoped: true }) }), 'unscoped');
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

// ── E. the real hook: an audit that did not run must not pass; an audit that already covered this tree is not redone ─────────────
// lib/prepush-audit-gate.mjs holds the logic (tests/prepush-audit-gate.test.mjs); these pin that the HOOK wires it: the audit's
// exit contract and envelope decide, the override is the one named variable, and the reuse branch really skips the audit.
function pushOf(c) {
  c.put('src/own.txt', 'x\n');
  const head = c.commit('own');
  return { head, base: git(['rev-parse', 'HEAD~1'], c.local) };
}
const stdinOf = (p) => `refs/heads/main ${p.head} refs/heads/main ${p.base}\n`;

describe('the real hook - an audit that did not run is UNMEASURED and refuses the push', () => {
  const clear = { AUDIT_PREPUSH_ALLOW_UNMEASURED: '', AUDIT_PREPUSH_BLOCK: '' };
  function scenario(stub, env = {}) {
    const ws = tmpDir('hook-outcome-');
    try {
      const source = makeSourceRepo(ws);
      const c = buildConsumer(ws);
      const p = pushOf(c);
      return runHook(c.local, source, stdinOf(p), { AUDIT_STUB: stub, ...clear, ...env });
    } finally { rmrf(ws); }
  }

  it('a crash (exit 1, no envelope) REFUSES, names the cause and the override - it is not "noise"', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const got = scenario('crash');
    assert.equal(got.status, 1, got.stderr);
    assert.match(got.stderr, /UNMEASURED: the code audit did NOT run to a verdict - the audit CLI errored before producing a verdict \(exit 1\)/);
    assert.match(got.stderr, /AUDIT_PREPUSH_ALLOW_UNMEASURED=1/);
    assert.match(got.stderr, /\| Error: audit aborted - boom/, 'the operator sees why');
    assert.doesNotMatch(got.stderr, /noise/i);
  });
  it('INCOMPLETE (exit 3) REFUSES, and AUDIT_PREPUSH_BLOCK=1 changes nothing about that', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    for (const env of [{}, { AUDIT_PREPUSH_BLOCK: '1' }]) {
      const got = scenario('exit3', env);
      assert.equal(got.status, 1, got.stderr);
      assert.match(got.stderr, /INCOMPLETE \(exit 3\)/);
    }
  });
  it('exit 0 with no result envelope REFUSES: nothing the audit concluded can be read', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const got = scenario('noenvelope');
    assert.equal(got.status, 1, got.stderr);
    assert.match(got.stderr, /no result envelope/);
  });
  it('the one named override lets an unmeasured push through, and the output records that it did', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    for (const stub of ['crash', 'exit3', 'noenvelope']) {
      const got = scenario(stub, { AUDIT_PREPUSH_ALLOW_UNMEASURED: '1' });
      assert.equal(got.status, 0, `${stub}: ${got.stderr}`);
      assert.match(got.stderr, /push ALLOWED UNMEASURED because AUDIT_PREPUSH_ALLOW_UNMEASURED=1/);
      assert.match(got.stderr, /UNMEASURED: the code audit did NOT run/);
    }
  });
  it('RAN WITH FINDINGS stays advisory, and blocks only under AUDIT_PREPUSH_BLOCK=1', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const advisory = scenario('findings');
    assert.equal(advisory.status, 0, advisory.stderr);
    assert.match(advisory.stderr, /SIGNIFICANT_ISSUES \(H:1 M:1 L:0\) - the audit RAN and found things to address/);
    const blocked = scenario('findings', { AUDIT_PREPUSH_BLOCK: '1' });
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /push BLOCKED: AUDIT_PREPUSH_BLOCK=1/);
  });
  it('no private temp file (mktemp fails) -> refuses before auditing: there is no predictable-path fallback to read a verdict from', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const got = scenario('pass', { TMPDIR: path.join(os.tmpdir(), 'does-not-exist-prepush-v12'), TMP: path.join(os.tmpdir(), 'does-not-exist-prepush-v12'), TEMP: path.join(os.tmpdir(), 'does-not-exist-prepush-v12') });
    assert.equal(got.status, 1, got.stderr);
    assert.match(got.stderr, /cannot create private temp files/);
    assert.equal(got.audited, false);
  });
  it('RAN CLEAN passes, and says it ran', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const got = scenario('pass');
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stderr, /code audit: PASS \(H:0 M:0 L:0\) - ran clean/);
  });
  it('refuses (fail closed) when the source checkout\'s step runner predates the v12 subcommands', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-old-runner-');
    try {
      const source = makeSourceRepo(ws);
      // A v11 runner: the selfcheck answers OK, but it has no `capabilities` and so cannot classify an audit.
      fs.writeFileSync(path.join(source, 'scripts', 'prepush-step.mjs'), [
        "if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }",
        "process.stderr.write('prepush-step.mjs: expected `run` or `own-files`\\n'); process.exit(2);", '',
      ].join('\n'));
      const c = buildConsumer(ws);
      const p = pushOf(c);
      const got = runHook(c.local, source, stdinOf(p), { ...clear });
      assert.equal(got.status, 1, got.stderr);
      assert.match(got.stderr, /step runner CANNOT RUN/);
      assert.match(got.stderr, /predates hook v12/);
      assert.equal(got.audited, false, 'the audit must not run when its outcome could not be classified');
    } finally { rmrf(ws); }
  });
});

describe('the real hook - reuse of an audit that already covered this tree, and a budget scaled to the diff', () => {
  /** Wraps the real runner so a test can declare what `audit-reuse` answers (the store itself is covered in prepush-audit-gate.test.mjs). */
  function stubReuse(source, line) {
    const scripts = path.join(source, 'scripts');
    const real = path.join(scripts, 'prepush-step.real.mjs');
    fs.renameSync(path.join(scripts, 'prepush-step.mjs'), real);
    fs.writeFileSync(path.join(scripts, 'prepush-step.mjs'), [
      "import { spawnSync } from 'node:child_process';",
      `const real = ${JSON.stringify(real)};`,
      `if (process.argv[2] === 'audit-reuse') { if (${JSON.stringify(line)} === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}); } else { process.stdout.write(${JSON.stringify(`${line}\n`)}); process.exit(0); } }`,
      "const r = spawnSync(process.execPath, [real, ...process.argv.slice(2)], { stdio: 'inherit' });",
      'process.exit(r.status ?? 1);', '',
    ].join('\n'));
  }
  const base = { AUDIT_PREPUSH_ALLOW_UNMEASURED: '', AUDIT_PREPUSH_BLOCK: '', AUDIT_PREPUSH_AUDIT_BUDGET_SEC: '' };

  it('a reusable run SKIPS the audit, names the run, and the push goes on', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-reuse-');
    try {
      const source = makeSourceRepo(ws);
      stubReuse(source, 'reuse audit-run-0003 2 abcdef012345');
      const c = buildConsumer(ws);
      const got = runHook(c.local, source, stdinOf(pushOf(c)), { ...base, AUDIT_STUB: 'crash' });
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.audited, false, 'the audit must not run when its run is reused');
      assert.match(got.stderr, /reusing audit run audit-run-0003 2 abcdef012345/);
    } finally { rmrf(ws); }
  });
  it('a stalled reuse check is bounded: the push is REFUSED with the runner\'s timeout message visible, the audit never runs', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-reuse-hang-');
    try {
      const source = makeSourceRepo(ws);
      stubReuse(source, 'hang');
      const c = buildConsumer(ws);
      const got = runHook(c.local, source, stdinOf(pushOf(c)), { ...base, AUDIT_PREPUSH_STEP_BUDGET_SEC: '2', AUDIT_PREPUSH_PROGRESS_SEC: '1' });
      assert.equal(got.status, 1, got.stderr);
      assert.match(got.stderr, /step 'audit-reuse' exceeded its 2s budget/);
      assert.equal(got.audited, false);
    } finally { rmrf(ws); }
  });
  it('no reusable run -> the audit runs, and the reason is printed', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-noreuse-');
    try {
      const source = makeSourceRepo(ws);
      stubReuse(source, 'none the last audited tree (aaaaaaaaaaaa) is not the pushed tree (bbbbbbbbbbbb)');
      const c = buildConsumer(ws);
      const got = runHook(c.local, source, stdinOf(pushOf(c)), { ...base });
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.audited, true);
      assert.match(got.stderr, /no audit run to reuse: the last audited tree \(aaaaaaaaaaaa\) is not the pushed tree \(bbbbbbbbbbbb\)/);
    } finally { rmrf(ws); }
  });
  it('the real runner with no marker re-runs (nothing to reuse is the common case, and never a skip)', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-nomarker-');
    try {
      const source = makeSourceRepo(ws);
      const c = buildConsumer(ws);
      const got = runHook(c.local, source, stdinOf(pushOf(c)), { ...base });
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.audited, true);
      assert.match(got.stderr, /no audit run to reuse: no recorded audit run/);
    } finally { rmrf(ws); }
  });
  it('the budget is scaled to the pushed diff and says what it was scaled to; AUDIT_PREPUSH_AUDIT_BUDGET_SEC pins it', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-budget-');
    try {
      const source = makeSourceRepo(ws);
      const c = buildConsumer(ws);
      const p = pushOf(c);
      const scaled = runHook(c.local, source, stdinOf(p), { ...base });
      assert.match(scaled.stderr, /budget 600s, scaled to 1 file\(s\), 1 changed line\(s\)/);
      const pinned = runHook(c.local, source, stdinOf(p), { ...base, AUDIT_PREPUSH_AUDIT_BUDGET_SEC: '777' });
      assert.match(pinned.stderr, /budget 777s, pinned by AUDIT_PREPUSH_AUDIT_BUDGET_SEC/);
    } finally { rmrf(ws); }
  });
});
