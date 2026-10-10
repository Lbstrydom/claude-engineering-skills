/**
 * @fileoverview `cross-skill.mjs fleet-telemetry flush|stats` handler, through
 * the real dispatcher with an injected store port (no database).
 * Plan: docs/plans/fleet-telemetry.md.
 */
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { dispatch } from '../scripts/lib/cross-skill/dispatch.mjs';
import { buildEvent, writeSpool } from '../scripts/lib/fleet/telemetry.mjs';
import { pendingFiles } from '../scripts/lib/fleet/telemetry-drain.mjs';
import { git } from './helpers/git.mjs';

const roots = [];
const startCwd = process.cwd();
after(() => {
  process.chdir(startCwd);
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** A throwaway git repo; returns its spool dir (`<git-common-dir>/fleet-telemetry`). */
function repoSpool() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fleet-tel-')));
  roots.push(root);
  git(['init', '-q'], root);
  return { root, dir: path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root), 'fleet-telemetry') };
}

function spool(n) {
  const { root, dir } = repoSpool();
  process.chdir(root);
  for (let i = 0; i < n; i += 1) {
    writeSpool(dir, buildEvent({ verb: 'status', result: { ok: true, code: 'ok' }, exitCode: 0, startedMs: 0, endedMs: 10 + i, eventId: randomUUID() }));
  }
  return dir;
}

const REPO = '11111111-2222-4333-8444-555555555555';
function deps(over = {}) {
  return {
    resolveRepoForStoreResult: async () => ({ kind: 'resolved', repoRowId: REPO, name: 'o/r' }),
    recordFleetEvents: async (_repoId, _name, events) => ({ ok: true, cloud: true, written: events.length }),
    readFleetTelemetry: async () => ({
      goldenSignals: [{ verb: 'status', mode: null, n: 20, ok: 18, refused: 0, pending: 0, error: 2, argv: 0, errorRate: 0.1, p50Ms: 900, p95Ms: 16000, maxMs: 17000 }],
      sessionFlow: { started: 0, released: 0, abandoned: 0, refusalsPerSession: null },
      topReasons: [], errorKinds: [], saturation: { registryInvalidSeen: 0 }, versions: [],
    }),
    ...over,
  };
}
const run = (args, over = {}, cloudGate = 'ready') => dispatch(['node', 'cross-skill.mjs', 'fleet-telemetry', ...args], { deps: deps(over), cloudGate });

describe('fleet-telemetry flush', () => {
  test('drains the spool into the store, scoped to the ambient repo', async () => {
    const dir = spool(3);
    const calls = [];
    const r = await run(['flush', '--spool', dir], {
      recordFleetEvents: async (repoId, name, events) => { calls.push({ repoId, n: events.length }); return { ok: true, written: events.length }; },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.envelope.drained, 3);
    assert.deepEqual(calls, [{ repoId: REPO, n: 3 }]);
    assert.equal(pendingFiles(dir).length, 0);
  });

  test('a failed write exits 1, names the reason, and leaves the events spooled', async () => {
    const dir = spool(2);
    const r = await run(['flush', '--spool', dir], { recordFleetEvents: async () => ({ ok: false, reason: 'schema-fault', error: 'relation "fleet_events" does not exist' }) });
    assert.equal(r.exitCode, 1);
    assert.equal(r.envelope.error.code, 'WRITE_FAILED');
    assert.match(r.envelope.error.message, /schema-fault.*2 event\(s\) stay spooled/);
    assert.equal(pendingFiles(dir).length, 2);
  });

  test('cloud off: degrade, nothing drained, events kept', async () => {
    const dir = spool(1);
    const r = await run(['flush', '--spool', dir], { recordFleetEvents: async () => { throw new Error('must not be called'); } }, 'off');
    assert.equal(r.exitCode, 0);
    assert.equal(r.envelope.cloud, false);
    assert.equal(r.envelope.drained, 0);
    assert.equal(r.envelope.spool.pending, 1);
  });

  test('an unresolved repo refuses the flush and keeps the events (an unscoped row is unreadable)', async () => {
    const dir = spool(2);
    const r = await run(['flush', '--spool', dir], {
      resolveRepoForStoreResult: async () => ({ kind: 'unresolved' }),
      recordFleetEvents: async () => { throw new Error('must not write'); },
    });
    assert.equal(r.exitCode, 1);
    assert.equal(r.envelope.error.code, 'REPO_UNRESOLVED');
    assert.equal(pendingFiles(dir).length, 2);
  });

  test('FLEET_TELEMETRY=off also stops sending what is already spooled', async () => {
    const dir = spool(1);
    const prev = process.env.FLEET_TELEMETRY;
    process.env.FLEET_TELEMETRY = 'off';
    try {
      const r = await run(['flush', '--spool', dir], { recordFleetEvents: async () => { throw new Error('must not write'); } });
      assert.equal(r.exitCode, 0);
      assert.equal(r.envelope.disabled, true);
      assert.equal(pendingFiles(dir).length, 1);
    } finally {
      if (prev === undefined) delete process.env.FLEET_TELEMETRY; else process.env.FLEET_TELEMETRY = prev;
    }
  });

  test('refuses a --spool that is not a fleet telemetry dir (flush deletes what it drains)', async () => {
    spool(0);
    const r = await run(['flush', '--spool', os.tmpdir()]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.envelope.error.code, 'BAD_INPUT');
  });

  test("refuses another repository's spool: rows are scoped to the cwd's repo", async () => {
    const other = repoSpool();
    fs.mkdirSync(other.dir, { recursive: true });
    spool(0); // cwd is now a different repo
    const r = await run(['flush', '--spool', other.dir], { recordFleetEvents: async () => { throw new Error('must not write'); } });
    assert.equal(r.exitCode, 2);
    assert.match(r.envelope.error.message, /not this repository's spool/);
  });
});

describe('fleet-telemetry stats', () => {
  // Each stats test runs in its OWN fresh checkout: the local spool is read from cwd, and the
  // flush tests above chdir into theirs (R1-M17) — a stats result must not depend on test order.
  beforeEach(() => { process.chdir(repoSpool().root); });

  test('returns measurements plus weakness findings', async () => {
    const r = await run(['stats', '--days', '7']);
    assert.equal(r.exitCode, 0);
    assert.equal(r.envelope.measured, true);
    assert.equal(r.envelope.days, 7);
    const signals = r.envelope.weaknesses.map((w) => w.signal).sort();
    assert.deepEqual(signals, ['errors', 'latency']);
  });

  test('a store fault is reported as not measured, with its reason — never as clean', async () => {
    const r = await run(['stats'], { readFleetTelemetry: async () => ({ error: 'relation missing', schemaFault: true }) });
    assert.equal(r.envelope.measured, false);
    assert.equal(r.envelope.reason, 'schema-fault');
    assert.deepEqual(r.envelope.weaknesses, []);
  });

  test('an unresolvable repo is not measured', async () => {
    const r = await run(['stats'], { resolveRepoForStoreResult: async () => ({ kind: 'unresolved' }) });
    assert.equal(r.envelope.measured, false);
    assert.equal(r.envelope.telemetry, null);
  });
});

describe('fleet-telemetry stats --fail-on (the weekly review gate)', () => {
  beforeEach(() => { process.chdir(repoSpool().root); });

  test('a weakness at or above the threshold exits 1 and KEEPS the payload', async () => {
    const r = await run(['stats', '--fail-on', 'high']);
    assert.equal(r.exitCode, 1);
    assert.equal(r.envelope.ok, false);
    assert.equal(r.envelope.reason, 'weaknesses-at-or-above-threshold');
    assert.ok(r.envelope.weaknesses.length >= 1, 'the findings are the point: they ride along');
    assert.match(r.envelope.summary, /\d+ high \/ \d+ medium/);
  });

  test('below the threshold: ok, exit 0, with the one-line summary', async () => {
    const r = await run(['stats', '--fail-on', 'high'], { readFleetTelemetry: async () => ({
      goldenSignals: [{ verb: 'status', mode: null, n: 20, ok: 20, refused: 0, pending: 0, error: 0, argv: 1, errorRate: 0.05, p50Ms: 100, p95Ms: 200, maxMs: 300 }],
      sessionFlow: { started: 0, released: 0, abandoned: 0, refusalsPerSession: null }, topReasons: [], errorKinds: [], saturation: { registryInvalidSeen: 0 }, versions: [],
    }) });
    assert.equal(r.exitCode, 0);
    assert.equal(r.envelope.ok, true);
    assert.match(r.envelope.summary, /0 high \/ 0 medium \/ 1 low/);
  });

  test('a bad severity, or --fail-on with the worksheet format, is BAD_INPUT', async () => {
    assert.equal((await run(['stats', '--fail-on', 'urgent'])).envelope.error.code, 'BAD_INPUT');
    assert.equal((await run(['stats', '--fail-on', 'high', '--format', 'worksheet'])).envelope.error.code, 'BAD_INPUT');
  });

  test('an inherited property name is not a severity (R1-M1)', async () => {
    for (const name of ['toString', 'constructor', '__proto__']) {
      assert.equal((await run(['stats', '--fail-on', name])).envelope.error.code, 'BAD_INPUT', name);
    }
  });

  test('an unreadable store FAILS the gate as not-measured — never passes as "no weaknesses" (R1-M4)', async () => {
    const fault = await run(['stats', '--fail-on', 'high'], { readFleetTelemetry: async () => ({ error: 'relation missing', schemaFault: true }) });
    assert.equal(fault.exitCode, 1);
    assert.equal(fault.envelope.ok, false);
    assert.equal(fault.envelope.reason, 'not-measured');
    const unresolved = await run(['stats', '--fail-on', 'low'], { resolveRepoForStoreResult: async () => ({ kind: 'unresolved' }) });
    assert.equal(unresolved.envelope.ok, false);
    assert.equal(unresolved.envelope.reason, 'not-measured');
  });

  test('with the store OFF, --fail-on is not-measured too — cloud-off is a mode, not a measurement (R1-H4)', async () => {
    const off = await run(['stats', '--fail-on', 'high'], {}, 'off');
    assert.equal(off.envelope.ok, false);
    assert.equal(off.envelope.reason, 'not-measured');
    const plain = await run(['stats'], {}, 'off');
    assert.equal(plain.exitCode, 0, 'without --fail-on, cloud-off stays a clean degrade');
  });

  test('the summary line is present with or without --fail-on (R1-M15)', async () => {
    assert.match((await run(['stats'])).envelope.summary, /^fleet telemetry /);
  });
});
