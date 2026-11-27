/**
 * @fileoverview Work-consumer report 2026-11-15, items 1, 4 and 6:
 *  - `.fleet.json` `fullSuite: "train"`: `next` and `ready` tell a session to defer the full suite (and the words to log),
 *    `land` says the train is the one full-suite run;
 *  - a user decision (`test-plan` / `answer`) is quoted in `next` as the USER's words, apart from directives, and grants
 *    nothing — no merge, push, --override or deletion can be expressed or reached;
 *  - `lease status` and `lease run` warn when the machine's CPU is saturated (load that took no lease).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots } from './helpers/fleet-repo.mjs';
import { fleetDirOf, land, readyBranch, setup } from './helpers/fleet-cli-harness.mjs';
import { world } from './helpers/fleet-lease-world.mjs';
import { FULL_SUITE_LOG_LINE, parseFleetConfig } from '../scripts/lib/fleet/config.mjs';
import { DECISION_SCOPES, SESSION_SCOPES, decisionsForSession } from '../scripts/lib/fleet/decisions.mjs';
import { cmdDecision } from '../scripts/lib/fleet/decisions-cmd.mjs';
import { CPU_SATURATED_PCT, cpuSaturationLine, machineCpu } from '../scripts/lib/fleet/lease-cpu.mjs';

after(cleanupFleetRoots);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OK = { name: 'default', command: ['node', '-e', 'process.exit(0)'] };

describe('fullSuite: "train"', () => {
  it('is a config key with two values; anything else is refused naming it', () => {
    assert.equal(parseFleetConfig({ fullSuite: 'train' }).value.fullSuite, 'train');
    assert.equal(parseFleetConfig({}).value.fullSuite, 'session');
    assert.match(parseFleetConfig({ fullSuite: 'later' }).errors.join(), /fullSuite/);
  });

  it('next and ready name the deferral and the exact test-log words; land says it is the one full-suite run', () => {
    const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', fullSuite: 'train', testCommand: { tiers: [OK] } } });
    git(['checkout', '-q', '-b', 'feat', 'main'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'feat', '--intent', 'x', '--paths', 'feat/**']).status, 0);
    const n = s.f(['next', '--id', 'feat']);
    assert.match(n.stdout, /TESTS: this repo defers the full suite to the train/);
    assert.match(n.stdout, /do NOT take the heavy slot for a full suite/);
    assert.ok(n.stdout.includes(FULL_SUITE_LOG_LINE), n.stdout);
    git(['checkout', '-q', 'main'], s.fx.repo);
    readyBranch(s, 'feat-b', { 'feat-b/b.txt': 'B\n' });
    const r = land(s);
    assert.match(r.json.text, /full suite: \.fleet\.json fullSuite: "train" defers it to the train; this train's pre-land tiers ran: default:green$/m);
  });

  it('the suite note is said only for a train whose tiers ran — never on a refusal, and a red one says it has not passed (audit R1 M2/H7)', () => {
    const red = { name: 'default', command: ['node', '-e', 'process.exit(1)'] };
    const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', fullSuite: 'train', testCommand: { tiers: [red] } } });
    const none = land(s);
    assert.equal(none.status, 3);
    assert.doesNotMatch(none.json.text, /full suite:/, 'nothing was built, so nothing ran');
    readyBranch(s, 'feat-b', { 'feat-b/b.txt': 'B\n' });
    const r = land(s);
    assert.equal(r.status, 4);
    assert.match(r.json.text, /pre-land tiers ran: default:red — NOT green, so the deferred suite has not passed/);
  });

  it('a malformed .fleet.json is an error, never read as the default mode (audit R1 H5)', () => {
    const s = setup({ fleetConfig: { fullSuite: 'train' } });
    git(['checkout', '-q', '-b', 'feat', 'main'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'feat', '--intent', 'x', '--paths', 'feat/**']).status, 0);
    fs.writeFileSync(path.join(s.fx.repo, '.fleet.json'), JSON.stringify({ fullSuite: 'later' }));
    const n = s.f(['next', '--id', 'feat']);
    assert.notEqual(n.status, 0);
    assert.match(n.stdout + n.stderr, /fullSuite/);
  });

  it('the default (session) prints none of it', () => {
    const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers: [OK] } } });
    git(['checkout', '-q', '-b', 'feat', 'main'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'feat', '--intent', 'x', '--paths', 'feat/**']).status, 0);
    assert.doesNotMatch(s.f(['next', '--id', 'feat']).stdout, /defers the full suite/);
    const ready = s.f(['ready', '--id', 'feat', '--json']);
    assert.equal(ready.json.fullSuite, 'session');
  });

  it('ready under fullSuite: train records the deferral in its result', () => {
    const s = setup({ fleetConfig: { fullSuite: 'train', testCommand: { tiers: [OK] } } });
    git(['checkout', '-q', '-b', 'feat', 'main'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'feat', '--intent', 'x', '--paths', 'feat/**']).status, 0);
    const r = s.f(['ready', '--id', 'feat', '--json']);
    assert.equal(r.json.fullSuite, 'deferred-to-train');
    assert.match(r.json.text, /full suite: deferred to the train/);
  });

  it('the participant rules and chip preamble carry the conditional', () => {
    const rules = fs.readFileSync(path.join(ROOT, 'skills/fleet/references/participant-rules.md'), 'utf8');
    const pre = fs.readFileSync(path.join(ROOT, 'skills/fleet/references/chip-preamble.md'), 'utf8');
    for (const t of [rules, pre]) assert.match(t, /fullSuite: "train"/);
    assert.ok(rules.includes(FULL_SUITE_LOG_LINE));
  });
});

describe('user decisions: test-plan and answer', () => {
  const record = (dir, scope, words, extra = {}) => cmdDecision({ dir, cwd: path.dirname(dir), now: new Date(), cmd: 'fleet' }, { '--scope': scope, '--words-file': '-', '--id': 'coordinator', ...extra }, ['record'], { readStdin: () => words });

  it('next quotes the user\'s words, with source session and time, apart from directives — and never as a DO', () => {
    const s = setup();
    git(['checkout', '-q', '-b', 'feat', 'main'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'feat', '--intent', 'x', '--paths', 'feat/**']).status, 0);
    const dir = fleetDirOf(s.fx);
    const d = record(dir, 'test-plan', 'Run only the `fast` tier here; the train runs the rest.', { '--to': 'feat' });
    assert.equal(d.ok, true, d.text);
    record(dir, 'answer', 'Use the v2 schema.', { '--to': 'someone-else' });
    const n = s.f(['next', '--id', 'feat', '--json']);
    assert.match(n.json.text, new RegExp(`USER DECISION ${d.decision.id} \\(test-plan\\) — recorded as the user's words by coordinator at \\S+ \\(a record, not proof: fleet cannot verify who typed them\\):`));
    assert.equal(n.json.decisionsUsable, true);
    assert.match(n.json.text, /^ {4}> Run only the `fast` tier here; the train runs the rest\.$/m);
    assert.match(n.json.text, /never a merge, a push, --override or a deletion/);
    assert.doesNotMatch(n.json.text, /Use the v2 schema/, 'a decision for another session is not shown');
    assert.doesNotMatch(n.json.text, /DO[^\n]*dec-/, 'a decision is never an obligation');
    assert.deepEqual(n.json.decisions.map((x) => x.id), [d.decision.id]);
  });

  it('to all reaches every session; a revoked one disappears', () => {
    const s = setup();
    const dir = fleetDirOf(s.fx);
    const d = record(dir, 'answer', 'Yes, rename it.');
    assert.equal(d.decision.to, 'all');
    assert.equal(decisionsForSession(dir, 'x').decisions.length, 1);
    cmdDecision({ dir, cwd: path.dirname(dir), now: new Date(), cmd: 'fleet' }, { '--words-file': '-' }, ['revoke', d.decision.id], { readStdin: () => 'no' });
    assert.equal(decisionsForSession(dir, 'x').decisions.length, 0);
  });

  it('NEVER grants merge, push, --override or deletion: no such scope, and no module that does those reads decisions', () => {
    assert.deepEqual([...SESSION_SCOPES], ['test-plan', 'answer']);
    for (const bad of ['merge', 'push', 'override', '--override', 'delete', 'deletion', 'approve', 'land']) {
      assert.ok(!DECISION_SCOPES.includes(bad), bad);
      assert.throws(() => record(fleetDirOf(setup().fx), bad, 'yes'), /not expressible/);
    }
    // EVERY fleet module (the directory is listed, so a new file is covered) except the two that only read or render a
    // decision: none may name decisions.mjs in any form (static or dynamic import), so no merge, push, claim-override or
    // deletion path can consult one (audit R1 M11). The CLI only dispatches the verb.
    // ONE pinned exception (docs/plans/fleet-train-landing-friction.md section 2.3, a gate change): train-approve.mjs reads an
    // accept-guard decision, and nothing else - it is checked below, never excused.
    const readers = new Set(['decisions.mjs', 'decisions-cmd.mjs', 'coordination.mjs', 'train-approve.mjs']);
    const fleetDir = path.join(ROOT, 'scripts/lib/fleet');
    const files = fs.readdirSync(fleetDir).filter((f) => f.endsWith('.mjs') && !readers.has(f));
    assert.ok(files.length > 50, `vacuous-pass guard: the census must see the fleet modules (saw ${files.length})`);
    for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(fleetDir, f), 'utf8'), /decisions(-cmd)?\.mjs/, `${f} must not read decisions`);
    const approve = fs.readFileSync(path.join(fleetDir, 'train-approve.mjs'), 'utf8');
    assert.deepEqual(approve.match(/^import .*decisions\.mjs.*$/gm), ["import { activeDecision } from './decisions.mjs';"], 'approve imports only activeDecision');
    const calls = approve.match(/activeDecision\([^)]*\)/g) ?? [];
    assert.ok(calls.length >= 1 && calls.every((c) => c.includes("'accept-guard'")), `every activeDecision call in approve names the accept-guard scope (saw ${calls.join(' | ')})`);
    assert.doesNotMatch(approve, /decisions-cmd\.mjs|readDecisions|decisionsForSession/, 'approve reads no other decision view');
    const coord = fs.readFileSync(path.join(fleetDir, 'coordination.mjs'), 'utf8');
    assert.match(coord, /import \{ decisionsForSession, renderSessionDecision \} from '\.\/decisions\.mjs';/, 'next reads only the session view');
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'scripts/fleet.mjs'), 'utf8'), /from '\.\/lib\/fleet\/decisions\.mjs'/, 'the CLI imports only the verb module');
    // --to only on the session scopes.
    assert.throws(() => record(fleetDirOf(setup().fx), 'note', 'x', { '--to': 'feat' }), /--to applies only/);
  });
});

describe('machine CPU saturation (unleased test load)', () => {
  it('cpuSaturationLine warns at the threshold, says nothing below it or when unmeasured', () => {
    assert.equal(cpuSaturationLine({ measured: true, busyPct: CPU_SATURATED_PCT - 1, cores: 8 }), null);
    assert.equal(cpuSaturationLine({ measured: false, reason: 'x' }), null);
    assert.match(cpuSaturationLine({ measured: true, busyPct: 97, cores: 8 }), /WARNING: CPU 97% busy across 8 cores — the heavy slot is FREE, so this load took no lease/);
    assert.match(cpuSaturationLine({ measured: true, busyPct: 97, cores: 8 }, { slotFree: false, holder: 'main' }), /held by main, and more than its job may be running/);
  });

  it('machineCpu measures from the core counters, and a pin or a 0 sample is honoured', async () => {
    let n = 0;
    const cpus = () => { n += 1; const busy = n === 1 ? 0 : 90; return [{ times: { user: busy, nice: 0, sys: 0, idle: n === 1 ? 0 : 10, irq: 0 } }]; };
    assert.deepEqual(await machineCpu({ env: {}, cpus, sleep: async () => {} }), { measured: true, busyPct: 90, cores: 1, sampleMs: 1000 });
    assert.equal((await machineCpu({ env: { FLEET_CPU_SAMPLE_MS: '0' } })).measured, false);
    assert.equal((await machineCpu({ env: { FLEET_CPU_BUSY_PCT: '99' } })).busyPct, 99);
  });

  it('lease status prints the machine CPU and the warning; lease run warns at its start', () => {
    const w = world();
    const st = w.runA(['lease', 'status'], { FLEET_CPU_BUSY_PCT: '96' });
    assert.equal(st.status, 0, st.stderr);
    assert.match(st.stdout, /machine CPU: 96% busy across \d+ cores/);
    assert.match(st.stdout, /WARNING: CPU 96% busy .* the heavy slot is FREE, so this load took no lease/);
    assert.doesNotMatch(w.runA(['lease', 'status'], { FLEET_CPU_BUSY_PCT: '10' }).stdout, /WARNING: CPU/);
    const run = w.runA(['lease', 'run', '--for', '5', '--', process.execPath, '-e', '0'], { FLEET_CPU_BUSY_PCT: '96' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /fleet lease run: WARNING: CPU 96% busy .* measured before this job started, so this load took no lease/);
  });
});

describe('lease run: the start-of-run CPU check sits inside the lease lifecycle (audit R1 H1)', () => {
  it('a stop signal while onGranted samples: the job never starts, and the slot is still released', async () => {
    const { runUnderLease } = await import('../scripts/lib/fleet/lease-run.mjs');
    const { readLease } = await import('../scripts/lib/fleet/lease.mjs');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ongranted-'));
    const sig = { handler: null, install(h) { sig.handler = h; return () => { sig.handler = null; }; } };
    let jobRan = false;
    const res = await runUnderLease({
      dir, identity: { repoKey: 'aaaaaaaaaaaa', holder: 'main' }, repo: 'o/a', kind: 'gate', forMin: 30, pid: 4242,
      now: () => new Date('2026-10-15T08:00:00Z'), probe: { scope: 'win32:box', isPidAlive: () => false }, signals: sig, log: () => {}, heartbeatMs: 0,
      onGranted: async () => { assert.ok(sig.handler, 'signals are installed before onGranted runs'); sig.handler('SIGTERM'); },
    }, async () => { jobRan = true; return { code: 0 }; });
    assert.equal(jobRan, false);
    assert.equal(res.signalled, 'SIGTERM');
    assert.equal(res.released.ok, true);
    assert.equal(readLease(dir).lease.heavy?.holder ?? null, null, 'the slot is free again');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});
