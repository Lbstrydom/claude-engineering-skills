/**
 * @fileoverview A killed pre-push hook must not read as a pass.
 *
 * Incident 2026-10-12: during the push of PR #220 the hook's process tree was
 * killed mid-`npm test`, and git transferred the push anyway. Root cause,
 * measured: Git for Windows reads a hook's status as `code & 0xff`
 * (`WEXITSTATUS` in compat/mingw-posix.h, `WIFSIGNALED` hard-wired to 0), and an
 * MSYS bash killed by signal S exits `S << 8` (HUP 256, TERM 3840, KILL 2304) —
 * so every signal death of the hook read as exit 0.
 *
 * These cases drive REAL `git push` runs against a throwaway bare remote, with
 * the hook built from the SHIPPED bytes (the marked blocks are extracted from
 * .githooks/pre-push and from the consumer HOOK_BODY), and judge the outcome by
 * what the remote received — the consumer's side, not the hook's claim.
 *
 *   L1  fail-closed-on-signal   — a trapped signal exits 1, push refused
 *   L3  prepush-inflight-record — an untrappable kill is reported on the NEXT push
 *
 * Runbook: docs/runbooks/prepush-sandbox.md §8.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { _internals } from '../scripts/install-prepush-hook.mjs';
import { IS_WIN, resolveGitBash, hermeticGitEnv } from './helpers/git-bash.mjs';

const REPO = process.cwd();
const REPO_HOOK = fs.readFileSync(path.join(REPO, '.githooks', 'pre-push'), 'utf8').replace(/\r\n/g, '\n');
const CONSUMER_HOOK = _internals.HOOK_BODY.replace(/\r\n/g, '\n');

const L1 = 'fail-closed-on-signal';
const L3 = 'prepush-inflight-record';

function blockRe(name) {
  return new RegExp(`^# >>> ${name}\\b[^\\n]*\\n[\\s\\S]*?^# <<< ${name} <<<$`, 'gm');
}
function extractBlock(text, name) {
  const all = text.match(blockRe(name)) ?? [];
  assert.equal(all.length, 1, `expected exactly one "${name}" block, found ${all.length}`);
  return all[0];
}

const BASH = resolveGitBash();
const cleanEnv = hermeticGitEnv;

function git(cwd, args, extraEnv) {
  return spawnSync('git', args, { cwd, env: cleanEnv(extraEnv), encoding: 'utf8' });
}
function gitOk(cwd, args) {
  const r = git(cwd, args);
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const HOLD = [
  'echo $$ > "$PREPUSH_TEST_PIDFILE"',
  'prepush_i=0',
  'while [ ! -f "$PREPUSH_TEST_RELEASE" ] && [ $prepush_i -lt 150 ]; do sleep 0.1; prepush_i=$((prepush_i + 1)); done',
  // Bounded: a stuck hook ends on its own — and SAYS so, so the harness can tell a
  // deadline expiry from the signal response it is testing (audit R1-M1).
  '[ -f "$PREPUSH_TEST_RELEASE" ] || { echo "STUB-DEADLINE-EXPIRED" >&2; exit 3; }',
].join('\n');

/** A hook = shebang + the shipped blocks + a stub body standing in for the gate. */
function composeHook({ shebang = '#!/bin/bash', blocks = [], l3 = false, hold = 'late' }) {
  const body = [
    'PUSH_STDIN="$(cat)"',
    hold === 'early' ? HOLD : '',
    'PUSH_HEAD="$(printf \'%s\\n\' "$PUSH_STDIN" | awk \'NR == 1 { print $2 }\')"',
    l3 ? 'prepush_inflight_write "${PUSH_HEAD:-unresolved}"' : '',
    hold === 'late' ? HOLD : '',
    'exit 0',
  ].filter(Boolean).join('\n');
  return `${shebang}\n${blocks.join('\n\n')}\n\n${body}\n`;
}

function makeFixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ces-hookkill-${label}-`));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const hooks = path.join(root, 'hooks');
  fs.mkdirSync(hooks);
  gitOk(root, ['init', '--bare', '--quiet', remote]);
  gitOk(root, ['init', '--quiet', '-b', 'main', work]);
  gitOk(work, ['config', 'user.name', 'fixture']);
  gitOk(work, ['config', 'user.email', 'fixture@example.invalid']);
  gitOk(work, ['config', 'core.hooksPath', hooks.replace(/\\/g, '/')]);
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  gitOk(work, ['add', 'a.txt']);
  gitOk(work, ['commit', '--quiet', '-m', 'seed']);
  gitOk(work, ['remote', 'add', 'origin', remote]);
  const fx = {
    root, remote, work, hooks,
    pidFile: path.join(root, 'hook.pid'),
    release: path.join(root, 'release'),
    head: gitOk(work, ['rev-parse', 'HEAD']),
    inflightDir: path.join(work, '.git', 'prepush-inflight'),
  };
  return fx;
}
function installHook(fx, text) {
  const p = path.join(fx.hooks, 'pre-push');
  fs.writeFileSync(p, text.replace(/\r\n/g, '\n'), { mode: 0o755 });
}

function startPush(fx, ref) {
  const child = spawn('git', ['push', 'origin', `HEAD:refs/heads/${ref}`], {
    cwd: fx.work,
    env: cleanEnv({ PREPUSH_TEST_PIDFILE: fx.pidFile, PREPUSH_TEST_RELEASE: fx.release }),
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', () => {});
  const done = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, signal: null, error, stderr }));
    child.on('close', (code, signal) => resolve({ code, signal, error: null, stderr }));
  });
  return { child, done };
}
async function withDeadline(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms); });
  try { return await Promise.race([promise, deadline]); } finally { clearTimeout(timer); }
}
// Waiting for the held hook to PUBLISH its pid is waiting on process start-up (git, then bash), not on what the test
// proves: it returns the moment the pid appears, so a wide bound costs nothing when healthy. 15 s expired in a gate
// that shared the box (27.7 s test, "hook never published its pid"); the hook's own 15 s HOLD starts only after the pid
// is written, so this bound cannot make a stuck hook look signalled.
async function waitForPid(fx, ms = 90_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const pid = fs.readFileSync(fx.pidFile, 'utf8').trim();
      if (/^\d+$/.test(pid)) return pid;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`hook never published its pid within ${ms}ms`);
}
/** MSYS `kill` on Windows: node's process.kill is TerminateProcess(…, 1) there and would not reproduce. */
function sendSignal(pid, sig) {
  if (IS_WIN) return spawnSync(BASH, ['-c', `kill -${sig} ${pid}`], { encoding: 'utf8' });
  try { process.kill(Number(pid), `SIG${sig}`); return { status: 0 }; } catch (error) { return { status: 1, error }; }
}
/**
 * What the remote holds: 'present' | 'absent' | 'unknown'. `rev-parse --verify --quiet`
 * exits 1 for a missing ref; anything else (spawn error, signal, fatal 128) is an
 * inspection failure and must never read as "absent" (audit R1-M2).
 */
function refState(fx, ref) {
  const r = git(fx.remote, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`]);
  if (r.error || r.signal) return 'unknown';
  if (r.status === 0) return 'present';
  if (r.status === 1) return 'absent';
  return 'unknown';
}
function refPresent(fx, ref) {
  const state = refState(fx, ref);
  assert.notEqual(state, 'unknown', `could not inspect refs/heads/${ref} in the remote`);
  return state === 'present';
}
function classify(result, state) {
  if (result.error || result.code === null) return 'indeterminate';
  if (/STUB-DEADLINE-EXPIRED/.test(result.stderr)) return 'indeterminate';   // not the signal's doing
  if (state === 'unknown') return 'indeterminate';
  if (result.code === 0 && state === 'present') return 'fail-open';
  if (result.code !== 0 && state === 'absent') return 'blocked';
  return 'indeterminate';
}

async function teardown(fx, push, { keepFixture = false } = {}) {
  try { fs.writeFileSync(fx.release, ''); } catch { /* fixture already gone */ }
  if (push && push.child.exitCode === null && push.child.signalCode === null) {
    if (IS_WIN) spawnSync('taskkill', ['/T', '/F', '/PID', String(push.child.pid)], { stdio: 'ignore' });
    else push.child.kill('SIGKILL');
    await withDeadline(push.done, 15_000, 'push teardown').catch(() => {});
  }
  if (!keepFixture) fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

/** Push with a held hook, deliver `sig` to the hook's shell, return what the REMOTE saw. */
async function killDuringPush(fx, ref, sig) {
  const push = startPush(fx, ref);
  try {
    const pid = await waitForPid(fx);
    const sent = sendSignal(pid, sig);
    assert.equal(sent.status, 0, `could not deliver SIG${sig} to ${pid}: ${sent.stderr ?? sent.error}`);
    const result = await withDeadline(push.done, 30_000, 'push');
    const state = refState(fx, ref);
    return { result, state, landed: state === 'present', pid };
  } finally {
    await teardown(fx, push);
  }
}

const skipReason = BASH ? false : 'Git for Windows bash not found next to `git --exec-path`';

// On a host whose `/bin/sh` is dash (Ubuntu CI), the CONSUMER hook cannot install the XSI-signal trap: dash's
// `kill -l NAME` errors, so the probe in the L1 block skips them. The push is still refused (that assertion stays on
// every platform); only the 'interrupted by SIG<name>' diagnostic is absent. Finding p-20261014101800-ecff.
const SH_IS_DASH = process.platform !== 'win32' && (() => { try { return path.basename(fs.realpathSync('/bin/sh')) === 'dash'; } catch { return false; } })();

describe('L1 — a signal that kills the hook BLOCKS the push', { skip: skipReason }, () => {
  const l1 = extractBlock(REPO_HOOK, L1);
  const l3 = extractBlock(REPO_HOOK, L3);

  // One per kill class: console close, polite kill, Ctrl+C, the plan-audit R1-H1 gap,
  // and an XSI signal installed only behind the `kill -l` probe (code-audit R3-H1).
  for (const sig of ['HUP', 'TERM', 'INT', 'USR1', 'TRAP']) {
    it(`repo hook, SIG${sig}: refused, and the remote never receives the ref`, async () => {
      const fx = makeFixture(`l1-${sig.toLowerCase()}`);
      installHook(fx, composeHook({ blocks: [l1, l3], l3: true }));
      const { result, state, landed } = await killDuringPush(fx, 'topic', sig);
      assert.equal(classify(result, state), 'blocked', `exit=${result.code} landed=${landed}\n${result.stderr}`);
      assert.match(result.stderr, new RegExp(`interrupted by SIG${sig}`));
    });
  }

  for (const sig of ['TERM', 'TRAP']) {
    it(`consumer hook (#!/bin/sh), SIG${sig}: refused`, async (t) => {
      const fx = makeFixture(`l1-consumer-${sig.toLowerCase()}`);
      installHook(fx, composeHook({ shebang: '#!/bin/sh', blocks: [extractBlock(CONSUMER_HOOK, L1)] }));
      const { result, state, landed } = await killDuringPush(fx, 'topic', sig);
      assert.equal(classify(result, state), 'blocked', `exit=${result.code} landed=${landed}
${result.stderr}`);
      if (sig === 'TRAP' && SH_IS_DASH) { t.skip('dash: the diagnostic-message assertion is not run (finding p-20261014101800-ecff); the push-refusal assertion above did run'); return; }
      assert.match(result.stderr, new RegExp(`interrupted by SIG${sig}`));
    });
  }

  it('characterises the installed git: the UNPROTECTED hook (instrument check, never a contract)', async (t) => {
    // On today's Git for Windows this reads `fail-open` — the defect, reproduced, beside the
    // protected cases reading `blocked`. A repaired git reads `blocked` and must not go red.
    const fx = makeFixture('l1-unprotected');
    installHook(fx, composeHook({}));
    const { result, state, landed } = await killDuringPush(fx, 'topic', 'HUP');
    const verdict = classify(result, state);
    t.diagnostic(`unprotected hook killed by SIGHUP → ${verdict} (exit=${result.code}, remote has ref: ${landed}) on ${gitOk(REPO, ['--version'])}`);
    assert.notEqual(verdict, 'indeterminate', `the harness could not classify the outcome: exit=${result.code} landed=${landed}\n${result.stderr}`);
  });

  it('does NOT fire on a normal finish: the push lands and leaves no in-flight record', async () => {
    const fx = makeFixture('l1-normal');
    let push = null;
    try {
      installHook(fx, composeHook({ blocks: [l1, l3], l3: true }));
      fs.writeFileSync(fx.release, '');
      push = startPush(fx, 'topic');
      const result = await withDeadline(push.done, 30_000, 'push');
      assert.equal(result.code, 0, result.stderr);
      assert.ok(refPresent(fx, 'topic'), 'a hook that exited 0 must let the push through');
      const left = fs.existsSync(fx.inflightDir) ? fs.readdirSync(fx.inflightDir) : [];
      assert.deepEqual(left, [], 'the EXIT trap must remove the record on a normal finish');
    } finally {
      await teardown(fx, push);
    }
  });
});

describe('L3 — an untrappable kill is REPORTED on the next push', { skip: skipReason }, () => {
  const l1 = extractBlock(REPO_HOOK, L1);
  const l3 = extractBlock(REPO_HOOK, L3);

  /** The second push: protected, no hold. Returns its stderr. */
  async function nextPush(fx, ref) {
    fs.writeFileSync(path.join(fx.work, `${ref}.txt`), `${ref}\n`);
    gitOk(fx.work, ['add', `${ref}.txt`]);
    gitOk(fx.work, ['commit', '--quiet', '-m', ref]);
    installHook(fx, composeHook({ blocks: [l1, l3], l3: true, hold: 'none' }));
    const push = startPush(fx, ref);
    try {
      const result = await withDeadline(push.done, 30_000, 'second push');
      assert.equal(result.code, 0, `the report is advisory and must never block: ${result.stderr}`);
      return result.stderr;
    } finally {
      await teardown(fx, push, { keepFixture: true });   // the caller owns the fixture
    }
  }
  async function killThenReport(hold) {
    const fx = makeFixture(`l3-${hold}`);
    try {
      installHook(fx, composeHook({ blocks: [l1, l3], l3: true, hold }));
      const push = startPush(fx, 'topic');
      let pid;
      try {
        pid = await waitForPid(fx);
        const sent = sendSignal(pid, 'KILL');
        assert.equal(sent.status, 0, `could not SIGKILL ${pid}`);
        await withDeadline(push.done, 30_000, 'killed push');
      } finally {
        await teardown(fx, push, { keepFixture: true });   // the fixture is needed for push 2
      }
      const rec = path.join(fx.inflightDir, `${pid}.rec`);
      assert.ok(fs.existsSync(rec), `SIGKILL runs no shell code, so the record must survive: ${rec}`);
      const stderr = await nextPush(fx, 'second');
      assert.ok(!fs.existsSync(rec), 'a reported record is removed');
      return { fx, stderr, pid };
    } finally {
      await teardown(fx, null);
    }
  }

  it('killed AFTER the range was known: names the gated sha and the --contains check', async () => {
    const { fx, stderr, pid } = await killThenReport('late');
    assert.match(stderr, new RegExp(`earlier pre-push \\(pid ${pid}, remote origin`));
    assert.match(stderr, /was KILLED before it/);
    assert.match(stderr, new RegExp(`git branch -r --contains ${fx.head}`));
  });

  it('killed BEFORE the range was known: says the commit is unknown, gives NO --contains advice', async () => {
    const { stderr } = await killThenReport('early');
    assert.match(stderr, /was KILLED before it/);
    assert.match(stderr, /died before the gated commit was known/);
    assert.doesNotMatch(stderr, /--contains/);
  });

  it('leaves a LIVE owner alone, drops a malformed record silently, and reports a dead one with a bad sha as unknown', async () => {
    const fx = makeFixture('l3-planted');
    const sleeper = spawn(BASH, ['-c', 'echo $$; sleep 30']);
    try {
      const livePid = await withDeadline(new Promise((resolve) => {
        let out = '';
        sleeper.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.trim()); });
      }), 15_000, 'sleeper pid');
      const deadPid = spawnSync(BASH, ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();
      fs.mkdirSync(fx.inflightDir, { recursive: true });
      fs.writeFileSync(path.join(fx.inflightDir, `${livePid}.rec`), `${livePid} ${fx.head} 2026-10-12T00:00:00Z origin\n`);
      fs.writeFileSync(path.join(fx.inflightDir, `${deadPid}.rec`), `${deadPid} not-a-sha 2026-10-12T00:00:00Z origin\n`);
      fs.writeFileSync(path.join(fx.inflightDir, 'junk.rec'), 'garbage line\n');
      const stderr = await nextPush(fx, 'second');
      assert.doesNotMatch(stderr, new RegExp(`pid ${livePid}\\b`), 'a live owner is a concurrent push — never reported');
      assert.ok(fs.existsSync(path.join(fx.inflightDir, `${livePid}.rec`)), 'a live owner\'s record is left in place');
      assert.match(stderr, new RegExp(`pid ${deadPid}, remote origin`));
      assert.match(stderr, /died before the gated commit was known/, 'a malformed sha is reported as unknown');
      assert.ok(!fs.existsSync(path.join(fx.inflightDir, 'junk.rec')), 'a malformed record is removed');
      assert.doesNotMatch(stderr, /garbage/);
    } finally {
      if (sleeper.exitCode === null) {
        if (IS_WIN) spawnSync('taskkill', ['/T', '/F', '/PID', String(sleeper.pid)], { stdio: 'ignore' });
        else sleeper.kill('SIGKILL');
      }
      await teardown(fx, null);
    }
  });
});

describe('L3 storage — the record goes into the git COMMON dir, or nowhere', { skip: skipReason }, () => {
  const l3 = extractBlock(REPO_HOOK, L3);
  // Ends in `true`: the probe's status is the block's, not `ls ""`'s on an unresolved DIR.
  const probe = `${l3}\necho "DIR=[$PREPUSH_INFLIGHT_DIR]"\nls "$PREPUSH_INFLIGHT_DIR" 2>/dev/null\ntrue\n`;
  const run = (cwd, extraEnv) => spawnSync(BASH, ['-c', probe], { cwd, env: cleanEnv(extraEnv), encoding: 'utf8' });
  let root;
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-hookkill-storage-')); });
  after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  it('outside a repository: no directory, no record, no fallback path', () => {
    const outside = path.join(root, 'not-a-repo');
    fs.mkdirSync(outside);
    const fallback = path.join(path.parse(outside).root, 'prepush-inflight');
    const existedBefore = fs.existsSync(fallback);
    const r = run(outside, { GIT_CEILING_DIRECTORIES: root });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^DIR=\[\]$/m);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing may be created in cwd');
    assert.equal(fs.existsSync(fallback), existedBefore, 'no /prepush-inflight may be constructed');
  });

  it('a path with a space works, and the record lives under that repo\'s .git', () => {
    const repo = path.join(root, 'with space', 'repo');
    fs.mkdirSync(repo, { recursive: true });
    gitOk(repo, ['init', '--quiet']);
    const r = run(repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DIR=\[.*with space\/repo\/\.git\/prepush-inflight\]/);
    assert.match(r.stdout, /^\d+\.rec$/m, 'the record exists while the hook runs');
    assert.deepEqual(fs.readdirSync(path.join(repo, '.git', 'prepush-inflight')), [], 'and is gone once it exits');
  });

  it('a stale record carrying THIS hook\'s own (reused) pid is reported, not mistaken for a live owner', () => {
    const repo = path.join(root, 'reuse');
    fs.mkdirSync(repo);
    gitOk(repo, ['init', '--quiet']);
    // The probe plants a record named for its own $$ BEFORE the block runs: exactly what a
    // predecessor killed with that pid would have left. kill -0 $$ is always true.
    const sha = 'a'.repeat(40);
    const plant = `d="$(git rev-parse --path-format=absolute --git-common-dir)/prepush-inflight"; mkdir -p "$d"; printf '%s ${sha} 2026-10-12T00:00:00Z origin\\n' "$$" > "$d/$$.rec"\n`;
    const r = spawnSync(BASH, ['-c', plant + probe], { cwd: repo, env: cleanEnv(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /was KILLED before it/, 'the reused-pid record must be reported');
    assert.match(r.stderr, new RegExp(`--contains ${sha}`));
  });

  it('a LINKED worktree writes into the main repository\'s common dir', () => {
    const main = path.join(root, 'main');
    fs.mkdirSync(main);
    gitOk(main, ['init', '--quiet', '-b', 'main']);
    gitOk(main, ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'seed']);
    const wt = path.join(root, 'wt');
    gitOk(main, ['worktree', 'add', '--quiet', '--detach', wt]);
    const r = run(wt);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DIR=\[.*\/main\/\.git\/prepush-inflight\]/);
  });
});

describe('the shipped hooks carry the blocks exactly once, in the right place', () => {
  it('the L1 block is byte-identical in .githooks/pre-push and the consumer HOOK_BODY', () => {
    assert.equal(extractBlock(CONSUMER_HOOK, L1), extractBlock(REPO_HOOK, L1));
  });

  it('L1 is installed before any other work in both hooks', () => {
    assert.ok(REPO_HOOK.indexOf(`# >>> ${L1}`) < REPO_HOOK.indexOf('# ── -1.'), 'repo hook: L1 before §-1');
    assert.ok(CONSUMER_HOOK.indexOf(`# >>> ${L1}`) < CONSUMER_HOOK.indexOf('AUDIT_PREPUSH_DISABLE" = "1"'), 'consumer hook: L1 before the first exit');
  });

  it('L3 follows L1 directly, and its sha update follows the range loop', () => {
    const l1End = REPO_HOOK.indexOf(`# <<< ${L1} <<<`) + `# <<< ${L1} <<<`.length;
    const l3Start = REPO_HOOK.indexOf(`# >>> ${L3}`);
    assert.match(REPO_HOOK.slice(l1End, l3Start), /^\s*$/, 'nothing but blank lines between L1 and L3');
    const update = 'prepush_inflight_write "${PUSH_HEAD:-unresolved}"';
    const rangeEnd = REPO_HOOK.indexOf('done <<EOF');
    const at = REPO_HOOK.indexOf(update);
    assert.ok(rangeEnd > 0 && at > rangeEnd, 'the sha update comes after the range loop');
    assert.ok(at < REPO_HOOK.indexOf('# ── 0.5'), '…and before any later section');
    assert.equal(REPO_HOOK.split(update).length, 2, 'exactly one sha update');
  });

  it('L3 is NOT in the consumer hook (out of scope; L1 is what makes it fail closed)', () => {
    assert.equal((CONSUMER_HOOK.match(blockRe(L3)) ?? []).length, 0);
  });

  it('the consumer hook version carries the fix', () => {
    const v = Number(CONSUMER_HOOK.match(/# hook-version: (\d+)/)[1]);
    assert.ok(v >= 10, `hook-version must be >= 10 for this fix, got ${v}`);
  });
});
