/**
 * @fileoverview /fleet telemetry: capture (lib/fleet/telemetry.mjs), drain
 * (lib/fleet/telemetry-drain.mjs), weakness findings
 * (lib/fleet/telemetry-insights.mjs), and the CLI wiring in scripts/fleet.mjs.
 * Plan: docs/plans/fleet-telemetry.md.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  buildEvent, modeOf, outcomeOf, reasonClass, recordInvocation, sessionHandle, shouldSpawnDrain, spoolDir,
  summarize, telemetryEnabled, toolShaFor, writeSpool, DRAIN_LOCK_STALE_MS, DRAIN_SPAWN_INTERVAL_MS,
} from '../scripts/lib/fleet/telemetry.mjs';
import { drainSpool, pendingFiles, spoolHealth, SpooledEventSchema } from '../scripts/lib/fleet/telemetry-drain.mjs';
import { deriveWeaknesses, THRESHOLDS } from '../scripts/lib/fleet/telemetry-insights.mjs';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { git } from './helpers/git.mjs';

after(cleanupFleetRoots);

const tmp = () => tmpRoot('fleet-tel-');
const event = (over = {}) => buildEvent({
  verb: 'claim', flags: { '--id': 's1' }, result: { ok: true, code: 'ok', id: 's1', verdict: 'clear', conflicts: [] },
  exitCode: 0, startedMs: 1_000, endedMs: 1_250, ...over,
});

describe('capture', () => {
  test('telemetryEnabled honours FLEET_TELEMETRY=off and the bundle-wide LEARNING_DISABLE', () => {
    assert.equal(telemetryEnabled({}), true);
    for (const v of ['off', '0', 'false', 'OFF']) assert.equal(telemetryEnabled({ FLEET_TELEMETRY: v }), false, v);
    assert.equal(telemetryEnabled({ LEARNING_DISABLE: '1' }), false);
  });

  test('modeOf names the form of the verb that ran', () => {
    assert.equal(modeOf('land', { '--approve': 't1', '--serial': true }), 'approve-serial');
    assert.equal(modeOf('land', { '--dry-run': true }), 'dry-run');
    assert.equal(modeOf('land', {}), 'build');
    assert.equal(modeOf('directive', { '--ack': 'x' }), 'ack');
    assert.equal(modeOf('hold', {}, ['on']), 'on');
    assert.equal(modeOf('release', { '--abandoned': true }), 'abandoned');
    assert.equal(modeOf('status', {}), null);
  });

  test('reasonClass strips what makes a reason unique, so refusals aggregate', () => {
    const a = reasonClass('session claude/foo-1 overlaps claude/bar on scripts/lib/x.mjs at 1a2b3c4d (2 files)');
    const b = reasonClass('session claude/zap overlaps claude/qux on src/y.js at 9f8e7d6c5b (14 files)');
    assert.equal(a, b);
    assert.doesNotMatch(a, /claude\/|scripts|1a2b3c4d/);
    assert.equal(reasonClass('unknown flag "--bogus" for `fleet land`'), 'unknown flag --bogus for `…`', 'the flag name survives');
    assert.equal(reasonClass('bad value "secret-thing"'), 'bad value "…"');
    assert.equal(reasonClass('no session fixthing is registered', ['fixthing']), 'no session <id> is registered', 'a slash-free id named by the invocation is scrubbed');
    assert.equal(reasonClass(''), null);
    assert.equal(reasonClass(undefined), null);
  });

  test('summarize keeps counts, booleans and closed-vocabulary strings — never text, reasons or ids', () => {
    const d = summarize('claim', {
      ok: false, code: 'refused', id: 'claude/secret-branch', text: 'REFUSED: long prose', reason: 'because x',
      verdict: 'blocked', blocked: [1, 2], landed: false, branch: 'claude/secret-branch', count: 3,
    });
    assert.deepEqual(d, { verdict: 'blocked', blockedCount: 2, landed: false, count: 3 });
    assert.doesNotMatch(JSON.stringify(d), /secret|prose|because/);
  });

  test('summarize describes the status board shape', () => {
    const d = summarize('status', {
      ok: true, code: 'ok', warnings: [1], checks: [],
      status: {
        items: [{ state: 'ready' }, { state: 'ready' }, { state: 'Weird State!' }],
        hidden: { count: 4, ids: ['a'] }, trains: [1], cycles: [], duplicates: [1, 2],
        registry: { invalid: [1] }, hold: { held: true }, sources: { prs: { complete: true } },
      },
    });
    assert.equal(d.items, 3);
    assert.deepEqual(d.itemsByState, { ready: 2, other: 1 });
    assert.equal(d.hidden, 4);
    assert.equal(d.registryInvalid, 1);
    assert.equal(d.held, true);
    assert.equal(d.warningsCount, 1);
  });

  test('outcomeOf maps codes and thrown errors', () => {
    assert.equal(outcomeOf({ code: 'pending' }), 'pending');
    assert.equal(outcomeOf({ code: 'weird' }), 'error');
    const argv = new Error('x'); argv.name = 'ArgvError';
    assert.equal(outcomeOf(null, argv), 'argv');
    assert.equal(outcomeOf(null, new TypeError('x')), 'error');
  });

  test('buildEvent produces a schema-valid v1 event', () => {
    const e = event();
    assert.equal(SpooledEventSchema.safeParse(e).success, true);
    assert.equal(e.durationMs, 250);
    assert.equal(e.sessionId, sessionHandle('s1'), 'the session id is hashed, never the branch name itself');
    assert.match(e.sessionId, /^[0-9a-f]{16}$/);
    assert.equal(e.outcome, 'ok');
    const err = buildEvent({ verb: 'land', error: Object.assign(new Error('boom at /x/y.js'), { name: 'RegistryError' }), exitCode: 1, startedMs: 0, endedMs: 5 });
    assert.equal(err.detail.errorKind, 'RegistryError');
    assert.equal(err.reasonClass, 'boom at <path>');
    assert.equal(SpooledEventSchema.safeParse(err).success, true);
  });

  test('writeSpool writes one file per event; past the cap it counts a drop instead', () => {
    const dir = path.join(tmp(), 'fleet-telemetry');
    assert.deepEqual(writeSpool(dir, event()), { written: true });
    assert.deepEqual(writeSpool(dir, event({ eventId: randomUUID() }), { maxFiles: 1 }), { written: false, reason: 'spool-full' });
    writeSpool(dir, event({ eventId: randomUUID() }), { maxFiles: 1 });
    assert.equal(pendingFiles(dir).length, 1);
    assert.equal(spoolHealth(dir).dropped, 2);
    assert.equal(fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), false, 'no half-written file left behind');
  });

  test('shouldSpawnDrain: never under the test runner, never over a live lock, at most once per interval', () => {
    const dir = path.join(tmp(), 'fleet-telemetry');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    assert.equal(shouldSpawnDrain({ env: { NODE_TEST_CONTEXT: 'child' }, dir, nowMs: now }), false);
    assert.equal(shouldSpawnDrain({ env: {}, dir, nowMs: now }), true);
    fs.writeFileSync(path.join(dir, 'drain.requested'), 'x');
    assert.equal(shouldSpawnDrain({ env: {}, dir, nowMs: now }), false, 'just requested');
    assert.equal(shouldSpawnDrain({ env: {}, dir, nowMs: now + DRAIN_SPAWN_INTERVAL_MS + 1000 }), true);
    fs.writeFileSync(path.join(dir, 'drain.lock'), 'x');
    assert.equal(shouldSpawnDrain({ env: {}, dir, nowMs: now + DRAIN_SPAWN_INTERVAL_MS + 1000 }), false, 'live lock');
    assert.equal(shouldSpawnDrain({ env: {}, dir, nowMs: now + DRAIN_LOCK_STALE_MS + 1000 }), true, 'stale lock');
  });

  test('recordInvocation never throws, and reports a spool fault on stderr only', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'fleet-telemetry'), 'a file where the spool should be');
    const notADir = path.join(root, 'fleet');
    const writes = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => { writes.push(String(s)); return true; };
    try {
      recordInvocation({ fleetDirPath: notADir, cwd: root, env: {}, scriptsDir: root, verb: 'status', exitCode: 0, startedMs: 0, endedMs: 1 });
    } finally { process.stderr.write = orig; }
    assert.match(writes.join(''), /telemetry not recorded/);
    const root2 = tmp();
    recordInvocation({ fleetDirPath: path.join(root2, 'fleet'), cwd: root2, env: { FLEET_TELEMETRY: 'off' }, scriptsDir: root2, verb: 'status', exitCode: 0, startedMs: 0, endedMs: 1 });
    assert.deepEqual(fs.readdirSync(root2), [], 'off means nothing is written');
  });

  test('toolShaFor reads the synced manifest only in the consumer layout', () => {
    const root = tmp();
    const scripts = path.join(root, 'scripts');
    fs.mkdirSync(path.join(scripts, '.claude-skills'), { recursive: true });
    fs.writeFileSync(path.join(scripts, '.sync-manifest.json'), JSON.stringify({ generatedAt: 'x', commitSha: 'abcdef1234567' }));
    assert.equal(toolShaFor(path.join(scripts, '.claude-skills')), 'abcdef1234567');
    assert.equal(toolShaFor(scripts), null, 'source layout: the manifest describes the last sync, not the code running');
  });
});

describe('drain', () => {
  const spool = (n = 3) => {
    const dir = path.join(tmp(), 'fleet-telemetry');
    for (let i = 0; i < n; i += 1) writeSpool(dir, event({ eventId: randomUUID(), endedMs: 1_000 + i }));
    return dir;
  };

  test('a successful write drains and removes the files', async () => {
    const dir = spool(3);
    const seen = [];
    const res = await drainSpool({ dir, write: async (evs) => { seen.push(...evs); return { ok: true, written: evs.length }; } });
    assert.deepEqual({ ok: res.ok, drained: res.drained, remaining: res.remaining }, { ok: true, drained: 3, remaining: 0 });
    assert.equal(seen.length, 3);
    assert.equal(fs.existsSync(path.join(dir, 'drain.lock')), false, 'lock released');
  });

  test('a failed write keeps every event for the next drain (same eventIds)', async () => {
    const dir = spool(2);
    const ids = [];
    const res = await drainSpool({ dir, write: async (evs) => { ids.push(...evs.map((e) => e.eventId)); return { ok: false, reason: 'schema-fault' }; } });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'schema-fault');
    assert.equal(res.remaining, 2);
    const again = [];
    await drainSpool({ dir, write: async (evs) => { again.push(...evs.map((e) => e.eventId)); return { ok: true }; } });
    assert.deepEqual(again.sort(), ids.sort(), 'the retry carries the same ids, so the store dedupes');
  });

  test('a file that is not a v1 event is set aside and counted, never retried forever', async () => {
    const dir = spool(1);
    fs.writeFileSync(path.join(dir, '1-bad.json'), '{"v":99}');
    fs.writeFileSync(path.join(dir, '2-garbage.json'), 'not json');
    const res = await drainSpool({ dir, write: async () => ({ ok: true }) });
    assert.equal(res.drained, 1);
    assert.equal(res.rejected, 2);
    assert.equal(spoolHealth(dir).rejected, 2);
    assert.equal(pendingFiles(dir).length, 0);
  });

  test('dropped events become one synthetic event, and the counter is reset', async () => {
    const dir = spool(0);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dropped'), '7');
    const seen = [];
    const res = await drainSpool({ dir, write: async (evs) => { seen.push(...evs); return { ok: true }; } });
    assert.equal(res.droppedReported, 7);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].verb, 'telemetry');
    assert.equal(seen[0].detail.droppedEvents, 7);
    assert.equal(SpooledEventSchema.safeParse(seen[0]).success, true);
    assert.equal(spoolHealth(dir).dropped, 0);
  });

  test('a live lock means another drainer owns the spool; a stale one is taken over', async () => {
    const dir = spool(1);
    fs.writeFileSync(path.join(dir, 'drain.lock'), '1');
    const res = await drainSpool({ dir, write: async () => { throw new Error('must not write'); } });
    assert.equal(res.locked, true);
    const later = Date.now() + DRAIN_LOCK_STALE_MS + 5_000;
    const res2 = await drainSpool({ dir, nowMs: later, write: async () => ({ ok: true }) });
    assert.equal(res2.drained, 1);
  });

  test('a crash after the dropped event was spooled reports the count once (same eventId)', async () => {
    const dir = spool(0);
    fs.mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    // State left by a drainer that spooled the synthetic event, then died before deleting its snapshot.
    fs.writeFileSync(path.join(dir, `dropped-${id}.count`), '4');
    fs.writeFileSync(path.join(dir, `1000-${id}.json`), JSON.stringify({
      v: 1, eventId: id, occurredAt: new Date(1000).toISOString(), verb: 'telemetry', mode: 'spool-full', outcome: 'error',
      exitCode: null, durationMs: 0, sessionId: null, reasonClass: 'spool full: events dropped', toolSha: null, detail: { droppedEvents: 4 },
    }));
    const seen = [];
    await drainSpool({ dir, write: async (evs) => { seen.push(...evs); return { ok: true }; } });
    assert.ok(seen.length >= 1);
    assert.deepEqual([...new Set(seen.map((e) => e.eventId))], [id], 'every copy carries the snapshot id, so the store keeps one row');
    assert.equal(spoolHealth(dir).dropped, 0);
  });

  test('release never deletes a lock another drainer now owns', async () => {
    const dir = spool(1);
    let stolen = false;
    const res = await drainSpool({ dir, write: async () => {
      // Simulate a takeover mid-drain: someone else now holds the lock.
      fs.writeFileSync(path.join(dir, 'drain.lock'), 'someone-else');
      stolen = true;
      return { ok: true };
    } });
    assert.equal(res.ok, true);
    assert.ok(stolen);
    assert.equal(fs.readFileSync(path.join(dir, 'drain.lock'), 'utf8'), 'someone-else');
  });

  test('two drainers judging one stale lock: exactly one takes it over', async () => {
    const dir = spool(1);
    const lock = path.join(dir, 'drain.lock');
    fs.writeFileSync(lock, 'dead');
    const old = (Date.now() - DRAIN_LOCK_STALE_MS - 60_000) / 1000;
    fs.utimesSync(lock, old, old);
    const { acquireLock } = await import('../scripts/lib/fleet/telemetry-drain.mjs');
    const a = acquireLock(dir, Date.now());
    const b = acquireLock(dir, Date.now());
    assert.equal(typeof a, 'function');
    assert.equal(b, null, 'the second sees a fresh, live lock');
    a();
    assert.equal(fs.existsSync(path.join(dir, 'drain.lock')), false);
  });

  test('an unreadable spool is a failure with a reason, not an empty spool', async () => {
    const root = tmp();
    const dir = path.join(root, 'fleet-telemetry');
    fs.writeFileSync(dir, 'a file, not a directory');
    const res = await drainSpool({ dir, write: async () => ({ ok: true }) });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'spool-unreadable');
    assert.match(spoolHealth(dir).error, /ENOTDIR|EEXIST|not a directory/i);
  });

  test('an event that cannot be READ is kept and reported, never rejected as malformed', async () => {
    const dir = spool(1);
    fs.mkdirSync(path.join(dir, '0-unreadable.json')); // readFileSync → EISDIR
    const res = await drainSpool({ dir, write: async () => ({ ok: true }) });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'spool-unreadable');
    assert.equal(fs.existsSync(path.join(dir, '0-unreadable.json')), true);
    assert.equal(spoolHealth(dir).rejected, 0);
  });

  test('an empty spool returns at once without calling the writer', async () => {
    const dir = path.join(tmp(), 'fleet-telemetry');
    const res = await drainSpool({ dir, write: async () => { throw new Error('no'); } });
    assert.deepEqual(res, { ok: true, drained: 0, rejected: 0, remaining: 0 });
  });
});

describe('weakness findings', () => {
  const verb = (o) => ({ verb: 'status', mode: null, n: 20, ok: 20, refused: 0, pending: 0, error: 0, argv: 0, errorRate: 0, p50Ms: 100, p95Ms: 200, maxMs: 300, ...o });
  const m = (o = {}) => ({
    goldenSignals: [verb()], sessionFlow: { started: 0, released: 0, abandoned: 0, refusalsPerSession: null },
    topReasons: [], errorKinds: [], saturation: { registryInvalidSeen: 0 }, versions: [], ...o,
  });

  test('not measured is not clean', () => {
    assert.deepEqual(deriveWeaknesses(null, null), { measured: false, state: 'unavailable', insufficient: [], findings: [] });
    assert.equal(deriveWeaknesses({ error: 'x' }, null).measured, false);
    const ok = deriveWeaknesses(m(), null);
    assert.equal(ok.measured, true);
    assert.equal(ok.state, 'measured');
    assert.deepEqual(ok.findings, []);
    assert.deepEqual(ok.insufficient, ['session flow'], 'what was not judged is named');
  });

  test('every rule short of data → insufficient, never measured', () => {
    const w = deriveWeaknesses(m({ goldenSignals: [verb({ n: 3 })] }), null);
    assert.equal(w.measured, false);
    assert.equal(w.state, 'insufficient');
    assert.deepEqual(w.insufficient, ['status', 'session flow']);
  });

  test('claim refusal rate is the collision signal', () => {
    const f = deriveWeaknesses(m({ goldenSignals: [verb({ verb: 'claim', refused: 8, ok: 12 })] }), null).findings;
    assert.deepEqual(f.map((x) => x.signal), ['collisions']);
  });

  test('version comparison uses the actual newest two, and skips a thin pair rather than substituting', () => {
    const thin = deriveWeaknesses(m({ versions: [
      { tool: 'cccccccc', n: 2, statusN: 2, statusP95Ms: 9000 },
      { tool: 'bbbbbbbb', n: 20, statusN: 20, statusP95Ms: 4000 },
      { tool: 'aaaaaaaa', n: 20, statusN: 20, statusP95Ms: 1000 },
    ] }), null);
    assert.equal(thin.findings.some((x) => x.signal === 'regression'), false, 'b vs a is not the comparison that was asked');
    assert.ok(thin.insufficient.includes('version comparison'));
    // Many runs but few of them status: the status p95 is not judged on all-verb n.
    const fewStatus = deriveWeaknesses(m({ versions: [
      { tool: 'bbbbbbbb', n: 500, statusN: 3, statusP95Ms: 9000 },
      { tool: 'aaaaaaaa', n: 500, statusN: 3, statusP95Ms: 1000 },
    ] }), null);
    assert.equal(fewStatus.findings.some((x) => x.signal === 'regression'), false);
  });

  test('an unreadable spool is a high capture finding', () => {
    const f = deriveWeaknesses(null, { error: 'ENOTDIR: not a directory' }).findings;
    assert.deepEqual(f.map((x) => [x.severity, x.signal]), [['high', 'capture']]);
  });

  test('error rate, latency, WAIT share and argv misuse each fire above threshold', () => {
    const f = deriveWeaknesses(m({ goldenSignals: [
      verb({ errorRate: 0.2, error: 4 }),
      verb({ verb: 'next', p95Ms: 9_000 }),
      verb({ verb: 'land', mode: 'approve', pending: 10 }),
      verb({ verb: 'claim', argv: 2 }),
    ] }), null).findings.map((x) => x.signal);
    assert.deepEqual(f.sort(), ['errors', 'flow', 'latency', 'usability']);
  });

  test('a rate is not judged below the minimum sample', () => {
    const f = deriveWeaknesses(m({ goldenSignals: [verb({ n: THRESHOLDS.minN - 1, errorRate: 1 })] }), null).findings;
    assert.deepEqual(f, []);
  });

  test('session flow, crash kinds, registry integrity and version regressions', () => {
    const f = deriveWeaknesses(m({
      sessionFlow: { started: 10, released: 4, abandoned: 5, refusalsPerSession: 2 },
      errorKinds: [{ kind: 'TypeError', n: 3 }, { kind: 'RegistryError', n: 9 }],
      saturation: { registryInvalidSeen: 2 },
      versions: [{ tool: 'bbbbbbbb', n: 20, statusN: 20, statusP95Ms: 4000 }, { tool: 'aaaaaaaa', n: 20, statusN: 20, statusP95Ms: 1000 }],
    }), null).findings;
    const signals = f.map((x) => x.signal);
    assert.ok(signals.includes('regression'));
    assert.ok(signals.includes('integrity'));
    assert.equal(signals.filter((s) => s === 'flow').length, 2, 'abandon rate + refusals after claiming');
    assert.equal(f.filter((x) => x.signal === 'errors').length, 1, 'a RegistryError is a refusal path, not a crash');
    assert.equal(f[0].severity, 'high', 'sorted by severity');
  });

  test('a stale spool is a capture failure even when the store has nothing', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    const f = deriveWeaknesses(null, { pending: 4, oldestPendingAt: '2026-10-08T12:00:00Z', dropped: 1, rejected: 0 }, { nowMs: now }).findings;
    assert.deepEqual(f.map((x) => [x.severity, x.signal]), [['high', 'capture'], ['medium', 'capture']]);
  });
});

describe('fleet.mjs wiring', () => {
  const spoolOf = (repo) => spoolDir(path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo), 'fleet'));
  const events = (repo) => pendingFiles(spoolOf(repo)).map((n) => JSON.parse(fs.readFileSync(path.join(spoolOf(repo), n), 'utf8')));

  test('each invocation spools one event; --json stdout is unchanged', () => {
    const { repo } = makeFleetRepo();
    const env = scrubbedEnv();
    const r = runFleet(['status', '--json'], { cwd: repo, env });
    assert.equal(r.status, 0);
    assert.equal(r.json?.verb, 'status', 'stdout is still exactly the JSON envelope');
    const evs = events(repo);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].verb, 'status');
    assert.equal(evs[0].outcome, 'ok');
    assert.equal(SpooledEventSchema.safeParse(evs[0]).success, true);
    assert.equal(fs.existsSync(path.join(spoolOf(repo), 'drain.requested')), false, 'no drainer under the test runner');
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo);
    assert.equal(fs.existsSync(path.join(common, 'fleet')), false, 'recording usage never creates the registry');
  });

  test('a mis-invocation is recorded as argv, a refusal as refused', () => {
    const { repo } = makeFleetRepo();
    const env = scrubbedEnv();
    assert.equal(runFleet(['status', '--bogus'], { cwd: repo, env }).status, 2);
    assert.equal(runFleet(['next', '--id', 'nobody'], { cwd: repo, env }).status, 3);
    const byVerb = Object.fromEntries(events(repo).map((e) => [e.verb, e]));
    assert.equal(byVerb.status.outcome, 'argv');
    assert.equal(byVerb.status.exitCode, 2);
    assert.match(byVerb.status.reasonClass, /--bogus/);
    assert.equal(byVerb.next.outcome, 'refused');
    assert.equal(byVerb.next.sessionId, sessionHandle('nobody'));
    assert.doesNotMatch(JSON.stringify(events(repo)), /nobody/, 'no event carries the raw session id');
  });

  test('FLEET_TELEMETRY=off writes nothing; help and unknown verbs are not recorded', () => {
    const { repo } = makeFleetRepo();
    runFleet(['status'], { cwd: repo, env: scrubbedEnv({ FLEET_TELEMETRY: 'off' }) });
    runFleet(['help'], { cwd: repo, env: scrubbedEnv() });
    runFleet(['nonsense'], { cwd: repo, env: scrubbedEnv() });
    assert.equal(events(repo).length, 0);
  });

  test('outside a git repo there is nowhere to spool, and the verb still answers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-norepo-'));
    try {
      const r = runFleet(['status'], { cwd: dir, env: scrubbedEnv({ GIT_CEILING_DIRECTORIES: path.dirname(dir) }) });
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.stderr, /telemetry/);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});
