/**
 * @fileoverview /fleet extension hook (plan §2b) — every behaviour of
 * `checks.mjs`, plus the train-level consequences (manifest records, approvability)
 * against a real throwaway repo. The negative control is explicit: the SAME
 * script, fixed, makes the train approvable.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanupFleetRoots, commitFile, makeFleetRepo, addBranch, tmpRoot, writeFile } from './helpers/fleet-repo.mjs';
import {
  runChecks, checksBlockApproval, checkScriptHash, checkArgv, resultsToFindings, CheckOutputSchema, buildCheckPayload,
} from '../scripts/lib/fleet/checks.mjs';
import { approvable, checkBlocksApproval } from '../scripts/lib/fleet/overlap.mjs';
import { resolveConfig } from '../scripts/lib/fleet/config.mjs';
import { buildTrain, defaultDeps } from '../scripts/lib/fleet/train.mjs';

after(cleanupFleetRoots);

const CHECK = (over = {}) => ({ name: 'sem', script: 'chk.mjs', severity: 'block', timeoutMs: 20_000, runIn: ['status', 'land'], ...over });
const OK_OUT = '{"schemaVersion":1,"findings":[]}';

/** A repo-ish dir holding one check script (no git needed for the pure hook tests). */
function scriptDir(body, name = 'chk.mjs') {
  const dir = tmpRoot('fleet-chk-');
  fs.writeFileSync(path.join(dir, name), body);
  return dir;
}
const emit = (s) => `process.stdout.write(${JSON.stringify(s)});`;
const run = (dir, check, phase = 'land', payload = buildCheckPayload({ phase, baseOid: 'b'.repeat(40) })) => runChecks({ cwd: dir, checks: [check], phase, payload })[0];

describe('hook contract: spawn, stdin, stdout schema', () => {
  it('spawns [...runner, script, ...args] with shell:false and the JSON document on stdin', () => {
    const calls = [];
    const dir = scriptDir('// x');
    const exec = (argv, opts) => { calls.push({ argv, opts }); return { status: 0, stdout: OK_OUT, stderr: '' }; };
    const payload = buildCheckPayload({ phase: 'land', baseOid: 'a'.repeat(40), sessions: [{ id: 's', waitingOn: [{ kind: 'human', ref: 'louis' }] }], trainSources: [{ id: 's' }] });
    const [r] = runChecks({ cwd: dir, checks: [CHECK({ args: ['--x', 'y'] })], phase: 'land', payload, exec });
    assert.equal(r.status, 'ok');
    assert.deepEqual(calls[0].argv, [process.execPath, path.join(dir, 'chk.mjs'), '--x', 'y']);
    const stdin = JSON.parse(calls[0].opts.input);
    assert.equal(stdin.schemaVersion, 1);
    assert.equal(stdin.phase, 'land');
    assert.equal(stdin.baseOid, 'a'.repeat(40));
    assert.deepEqual(stdin.sessions[0].waitingOn, [{ kind: 'human', ref: 'louis' }], 'waitingOn is part of the hook stdin');
    assert.equal(stdin.trainSources.length, 1);
    assert.equal(calls[0].opts.cwd, dir);
  });

  it('the default exec is spawnSync with shell:false (an argv containing ; and $() is passed literally)', () => {
    const dir = scriptDir('process.stdout.write(JSON.stringify({ schemaVersion: 1, findings: [{ level: "info", message: JSON.stringify(process.argv.slice(2)) }] }));', 'chk.cjs');
    const r = run(dir, CHECK({ script: 'chk.cjs', args: ['a;b', '; touch pwned', '$(touch pwned2)', '&& echo x'] }));
    assert.equal(r.status, 'findings');
    assert.deepEqual(JSON.parse(r.findings[0].message), ['a;b', '; touch pwned', '$(touch pwned2)', '&& echo x']);
    assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
    assert.equal(fs.existsSync(path.join(dir, 'pwned2')), false);
  });

  it('an explicit runner is the argv prefix and the HASHED file is the script, never the interpreter', () => {
    const dir = scriptDir(emit(OK_OUT), 'x.mjs');
    assert.deepEqual(checkArgv({ script: 'x.mjs', runner: ['node'] }).argv, ['node', 'x.mjs']);
    assert.deepEqual(checkArgv({ script: 'x.mjs' }).argv, [process.execPath, 'x.mjs']);
    assert.deepEqual(checkArgv({ script: 'tool.sh' }).argv, ['tool.sh'], 'non-js with no runner is run directly');
    const r = run(dir, CHECK({ script: 'x.mjs', runner: ['node'] }));
    assert.equal(r.status, 'ok');
    assert.equal(r.scriptHash, checkScriptHash(dir, 'x.mjs').hash);
    assert.match(r.scriptHash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(r.argv, ['node', 'x.mjs']);
  });

  it('runIn filters by phase', () => {
    const dir = scriptDir(emit(OK_OUT));
    const only = CHECK({ runIn: ['status'] });
    assert.equal(runChecks({ cwd: dir, checks: [only], phase: 'land', payload: {} }).length, 0);
    assert.equal(runChecks({ cwd: dir, checks: [only], phase: 'status', payload: {} }).length, 1);
  });

  it('the strict output schema rejects unknown keys and bad levels', () => {
    assert.equal(CheckOutputSchema.safeParse({ schemaVersion: 1, findings: [] }).success, true);
    assert.equal(CheckOutputSchema.safeParse({ schemaVersion: 1, findings: [], extra: 1 }).success, false);
    assert.equal(CheckOutputSchema.safeParse({ schemaVersion: 1, findings: [{ level: 'fatal', message: 'x' }] }).success, false);
    assert.equal(CheckOutputSchema.safeParse({ schemaVersion: 1, findings: [{ level: 'warn', message: 'x', bogus: 1 }] }).success, false);
    assert.equal(CheckOutputSchema.safeParse({ schemaVersion: 2, findings: [] }).success, false);
  });
});

describe('check-failed: ANY failure, never an exception', () => {
  const cases = {
    'non-zero exit': (d) => scriptDir(`${emit(OK_OUT)} process.exit(3);`),
    'non-JSON stdout': () => scriptDir(emit('hello')),
    'stdout fails the schema': () => scriptDir(emit('{"schemaVersion":1,"findings":[{"level":"loud","message":"m"}]}')),
    'wrong schemaVersion': () => scriptDir(emit('{"schemaVersion":9,"findings":[]}')),
    'timeout': () => scriptDir('setTimeout(() => {}, 60000);'),
    'missing script': () => tmpRoot('fleet-chk-'),
  };
  for (const [name, mk] of Object.entries(cases)) {
    it(`${name} on severity:block is check-failed and blocks approval`, () => {
      const dir = mk();
      const r = run(dir, CHECK({ timeoutMs: 400 }));
      assert.equal(r.status, 'check-failed', name);
      assert.ok(r.reason, 'a reason is recorded');
      assert.equal(checksBlockApproval([r]).blocks, true);
    });
    it(`${name} on severity:warn only discloses`, () => {
      const dir = mk();
      const r = run(dir, CHECK({ severity: 'warn', timeoutMs: 400 }));
      assert.equal(r.status, 'check-failed');
      assert.equal(checksBlockApproval([r]).blocks, false);
      assert.match(resultsToFindings([r])[0].message, /failed to run/);
    });
  }

  it('a script that cannot be hashed (unreadable / escapes the repo) is check-failed with hash null', () => {
    const dir = tmpRoot('fleet-chk-');
    const r = run(dir, CHECK({ script: 'nope.mjs' }));
    assert.equal(r.status, 'check-failed');
    assert.equal(r.scriptHash, null);
    assert.match(r.scriptHashReason, /unreadable/);
    assert.equal(checkScriptHash(dir, 'nope.mjs').hash, null);
    assert.match(checkScriptHash(dir, '../outside.mjs').reason, /outside the repo/);
  });

  it('a throwing exec still yields a result, not an exception', () => {
    const dir = scriptDir('// x');
    const [r] = runChecks({ cwd: dir, checks: [CHECK()], phase: 'land', payload: {}, exec: () => { throw new Error('boom'); } });
    assert.equal(r.status, 'check-failed');
    assert.match(r.reason, /boom/);
  });
});

describe('hook stderr is kept (bounded) in the failure reason', () => {
  it('non-zero exit, invalid JSON and schema failure each carry the stderr tail', () => {
    const mk = (out, code) => scriptDir(`process.stderr.write('boom: something real broke'); ${out} process.exit(${code});`);
    const a = run(mk('', 3), CHECK());
    assert.match(a.reason, /^exited 3 — stderr: boom: something real broke/);
    const b = run(mk(emit('not json'), 0), CHECK());
    assert.match(b.reason, /not valid JSON — stderr: boom/);
    const c = run(mk(emit('{"schemaVersion":1,"findings":[{"level":"x","message":"m"}]}'), 0), CHECK());
    assert.match(c.reason, /findings schema.*stderr: boom/);
    assert.equal(run(mk(emit(OK_OUT), 0), CHECK()).status, 'ok', 'stderr noise on success is not a failure');
  });

  it('only the LAST 2KB survives, and a silent failure adds nothing', () => {
    const big = scriptDir("process.stderr.write('A'.repeat(5000) + 'THE-END'); process.exit(1);");
    const r = run(big, CHECK());
    assert.match(r.reason, /THE-END$/);
    assert.ok(r.reason.length < 2200, `bounded (${r.reason.length})`);
    assert.doesNotMatch(r.reason, /A{2100}/);
    assert.equal(run(scriptDir('process.exit(2);'), CHECK()).reason, 'exited 2');
  });
});

describe('timeout kills the process tree', () => {
  // On Windows node puts descendants in a kill-on-close job, so a plain grandchild dies with its parent;
  // a BREAKAWAY (detached) grandchild is what survives a direct kill and what taskkill /T must reach.
  it('on timeout the WHOLE tree is killed - a hook\'s grandchild does not outlive the check', async () => {
    const pidFile = path.join(tmpRoot('fleet-gc-'), 'grandchild.pid');
    const dir = scriptDir(`
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)', ${JSON.stringify(pidFile)}], { stdio: 'ignore', detached: process.platform === 'win32' });
      setTimeout(() => {}, 60000);
    `, 'chk.cjs');
    const r = run(dir, CHECK({ script: 'chk.cjs', timeoutMs: 2500 }));
    assert.equal(r.status, 'check-failed');
    assert.match(r.reason, /timed out/);
    const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
    let pid = null;
    for (let i = 0; i < 40 && !pid; i += 1) { try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { await sleep(100); } }
    assert.ok(pid > 0, 'the grandchild really started (otherwise this test proves nothing)');
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && alive(); i += 1) await sleep(100);
    const stillAlive = alive();
    if (stillAlive) process.kill(pid, 'SIGKILL');
    assert.equal(stillAlive, false, 'the grandchild must be gone after the timeout');
  });
});

describe('supervisor: bounded output, exact decoding, leaked descendants', () => {
  const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('H2/M1: an over-cap stdout (3 MiB) is check-failed, never a partial parse', () => {
    const dir = scriptDir("process.stdout.write('x'.repeat(3 * 1024 * 1024));");
    const r = run(dir, CHECK({ timeoutMs: 20_000 }));
    assert.equal(r.status, 'check-failed');
    assert.equal(r.reason, 'hook output exceeded 1048576 bytes');
  });

  it('M2: a 4-byte UTF-8 character split across two writes round-trips exactly', () => {
    const dir = scriptDir(`
      const b = Buffer.from('\u{1F600}');
      process.stdout.write(Buffer.concat([Buffer.from('{"schemaVersion":1,"findings":[{"level":"info","message":"'), b.subarray(0, 2)]));
      setTimeout(() => process.stdout.write(Buffer.concat([b.subarray(2), Buffer.from('"}]}')])), 200);
    `);
    const r = run(dir, CHECK({ severity: 'warn' }));
    assert.equal(r.status, 'findings', r.reason);
    assert.equal(r.findings[0].message, '\u{1F600}');
  });

  it('H1/H3: a hook that prints valid findings and EXITS while a detached grandchild holds the pipes: findings returned promptly, grandchild terminated', async () => {
    const pidFile = path.join(tmpRoot('fleet-leak-'), 'gc.pid');
    const dir = scriptDir(`
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const g = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)', ${JSON.stringify(pidFile)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
      g.unref();
      const wait = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(pidFile)})) return;
        clearInterval(wait);
        process.stdout.write('{"schemaVersion":1,"findings":[{"level":"info","message":"done"}]}');
      }, 20);
    `, 'chk.cjs');
    const t0 = Date.now();
    const r = run(dir, CHECK({ script: 'chk.cjs', severity: 'warn', timeoutMs: 30_000 }));
    const took = Date.now() - t0;
    assert.equal(r.status, 'findings', r.reason);
    assert.equal(r.findings[0].message, 'done');
    assert.ok(took < 12_000, `returned well within the 30s timeout (${took}ms)`);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    for (let i = 0; i < 80 && alive(pid); i += 1) await sleep(100);
    const stillAlive = alive(pid);
    if (stillAlive) process.kill(pid, 'SIGKILL');
    assert.equal(stillAlive, false, 'the leaked grandchild must be terminated');
  });
});

describe('approval predicate', () => {
  const tested = (checkResults) => ({
    phase: 'tested', result: 'green', candidate: { oid: 'a'.repeat(40), tree: 'b'.repeat(40) },
    testCommand: [{ name: 'default', stage: 'pre-land', command: ['x'] }], tierResults: [{ name: 'default', result: 'green' }], checkResults,
  });
  const matrix = [
    [],
    [{ name: 'a', severity: 'block', status: 'ok', findings: [] }],
    [{ name: 'a', severity: 'block', status: 'findings', findings: [{ level: 'block', message: 'm' }] }],
    [{ name: 'a', severity: 'warn', status: 'findings', findings: [{ level: 'block', message: 'm' }] }],
    [{ name: 'a', severity: 'block', status: 'check-failed', findings: [], reason: 'exited 1' }],
    [{ name: 'a', severity: 'warn', status: 'check-failed', findings: [], reason: 'timed out' }],
    [{ name: 'a', severity: 'block', status: 'findings', findings: [{ level: 'warn', message: 'm' }, { level: 'info', message: 'i' }] }],
    undefined,
  ];
  it('checksBlockApproval agrees with the predicate approvable() consumes, over a matrix', () => {
    for (const m of matrix) {
      assert.equal(checksBlockApproval(m).blocks, checkBlocksApproval(m) !== null, JSON.stringify(m));
      assert.equal(approvable(tested(m)).ok, !checksBlockApproval(m).blocks, `approvable agrees: ${JSON.stringify(m)}`);
    }
  });
  it('a block finding and a block-severity check-failed both make the manifest non-approvable', () => {
    assert.equal(approvable(tested(matrix[2])).ok, false);
    assert.equal(approvable(tested(matrix[4])).ok, false);
    assert.equal(approvable(tested(matrix[3])).ok, true, 'a warn-severity check never blocks');
  });
});

describe('train-level consequences (real repo, real origin)', () => {
  /** Build a direct-squash train with one source on a repo whose hook is `script`. */
  function trainWith(script, checks, { fleetExtra = {} } = {}) {
    const fx = makeFleetRepo({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers: [{ name: 'default', command: ['node', '-e', 'process.exit(0)'] }] }, checks, ...fleetExtra } });
    // Land checks run INSIDE the train worktree, so the script must be committed (as a repo-owned check is).
    commitFile(fx.repo, 'chk.mjs', script, 'add check');
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: fx.repo, stdio: 'ignore' });
    const oid = addBranch(fx.repo, 'feat-a', { 'a.txt': 'changed\n' });
    const config = resolveConfig(fx.repo, { env: { ...process.env, FLEET_WORKTREE_ROOT: fx.wtRoot } });
    const r = buildTrain({
      cwd: fx.repo, config, deps: defaultDeps({ log: () => {} }),
      sources: [{ id: 'feat-a', gen: 1, rev: 1, oid, kind: 'branch', pr: null }],
      checkPayload: { sessions: [{ id: 'feat-a', waitingOn: [{ kind: 'session', ref: 'x' }] }], overlaps: [] },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    return { fx, r };
  }
  const cfgCheck = (over = {}) => [{ name: 'sem', script: 'chk.mjs', severity: 'block', timeoutMs: 20_000, ...over }];

  it('a block finding makes the train not approvable; the manifest records argv + script hash', () => {
    const script = emit('{"schemaVersion":1,"findings":[{"level":"block","message":"both bump the contract hash"}]}');
    const { fx, r } = trainWith(script, cfgCheck({ runner: ['node'] }));
    assert.equal(r.approvability.ok, false);
    assert.match(r.approvability.reason, /block-level finding/);
    const cr = r.train.checkResults[0];
    assert.deepEqual(cr.argv, ['node', 'chk.mjs']);
    assert.equal(cr.scriptHash, checkScriptHash(fx.repo, 'chk.mjs').hash, 'the hash is of chk.mjs, never of node');
    assert.equal(r.train.result, 'green', 'tests still ran and passed; the check alone blocks');
  });

  it('NEGATIVE CONTROL: the same script, fixed to exit 0 with no findings, is approvable', () => {
    const { r } = trainWith(emit(OK_OUT), cfgCheck({ runner: ['node'] }));
    assert.equal(r.approvability.ok, true, r.approvability.reason);
    assert.equal(r.train.checkResults[0].status, 'ok');
  });

  it('a block-severity check that cannot run is non-approvable; the same failure on a warn check only discloses', () => {
    const failing = 'process.exit(1);';
    const blocking = trainWith(failing, cfgCheck());
    assert.equal(blocking.r.approvability.ok, false);
    assert.match(blocking.r.approvability.reason, /failed to run/);
    const warn = trainWith(failing, cfgCheck({ severity: 'warn' }));
    assert.equal(warn.r.approvability.ok, true);
    assert.equal(warn.r.train.checkResults[0].status, 'check-failed', 'disclosed in the manifest');
  });

  it('a missing script on a block check is check-failed in the manifest, not a thrown error', () => {
    const { r } = trainWith(emit(OK_OUT), cfgCheck({ script: 'missing.mjs' }));
    assert.equal(r.train.checkResults[0].status, 'check-failed');
    assert.equal(r.train.checkResults[0].scriptHash, null);
    assert.equal(r.approvability.ok, false);
  });

  it('the hook receives waitingOn and the train sources on stdin', () => {
    const script = `let b=''; process.stdin.on('data',d=>b+=d); process.stdin.on('end',()=>{ const p=JSON.parse(b);
      process.stdout.write(JSON.stringify({schemaVersion:1,findings:[{level:'info',message:JSON.stringify({phase:p.phase,w:p.sessions[0].waitingOn,src:p.trainSources.map(s=>s.id)})}]})); });`;
    const { r } = trainWith(script, cfgCheck({ severity: 'warn' }));
    const seen = JSON.parse(r.train.checkResults[0].findings[0].message);
    assert.equal(seen.phase, 'land');
    assert.deepEqual(seen.w, [{ kind: 'session', ref: 'x' }]);
    assert.deepEqual(seen.src, ['feat-a']);
  });
});
