/**
 * @fileoverview The open-upstream-issues count in `fleet status` / `fleet next` (scripts/lib/fleet/upstream-count.mjs).
 * Plan: docs/plans/fleet-chips-and-merge-friction.md section 2.2d (finding p-20261015045126-5696).
 *
 * The property under test is "unmeasured is never zero": a measured zero followed by a failed refresh must read UNMEASURED
 * (with the last success as labelled history), a partial answer is a floor, and an absent cache is not an empty queue.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  interpretQueues, nextRecord, renderUpstreamLine, upstreamQuiet, runUpstreamQueues, readUpstreamCache, refreshUpstreamCache,
  upstreamScript, UPSTREAM_CACHE_FILE, UPSTREAM_STALE_MS,
} from '../scripts/lib/fleet/upstream-count.mjs';

const NOW = new Date('2026-10-15T20:00:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const rec = (extra = {}) => ({
  schemaVersion: 1, state: 'measured', totalOpen: 0, storesQueried: 2, storesUnqueried: 0, reason: null,
  measuredAt: ago(60_000), attemptedAt: ago(60_000), lastMeasured: null, ...extra,
});
const ok = (record) => ({ state: 'ok', record });

describe('interpretQueues', () => {
  it('maps the reader envelope: all answered = measured, some missing = partial, none = unmeasured', () => {
    assert.deepEqual(interpretQueues({ storesQueried: 2, storesUnqueried: 0, totalOpen: 3, unresolved: [] }), { state: 'measured', totalOpen: 3, storesQueried: 2, storesUnqueried: 0, reason: null });
    const partial = interpretQueues({ storesQueried: 1, storesUnqueried: 1, totalOpen: 4, unresolved: [{ repo: 'x' }] });
    assert.equal(partial.state, 'partial');
    assert.equal(partial.storesUnqueried, 2, 'unqueried and unresolved both count as not asked');
    const none = interpretQueues({ storesQueried: 0, storesUnqueried: 2, totalOpen: 0, unresolved: [] });
    assert.equal(none.state, 'unmeasured');
    assert.match(none.reason, /NOTHING WAS CHECKED/);
    assert.equal(none.totalOpen, undefined, 'an unmeasured answer carries no count at all, not 0');
  });

  it('a missing or malformed envelope is unmeasured', () => {
    for (const bad of [null, undefined, 'x', {}, { storesQueried: 'a', storesUnqueried: 0, totalOpen: 0 }]) assert.equal(interpretQueues(bad).state, 'unmeasured', JSON.stringify(bad));
  });
});

describe('nextRecord: a failed refresh never leaves the last success standing as the current count', () => {
  it('a success moves measuredAt and clears the history', () => {
    const r = nextRecord({ state: 'measured', totalOpen: 5, storesQueried: 2, storesUnqueried: 0, reason: null }, rec({ lastMeasured: { totalOpen: 1, measuredAt: ago(9e6) } }), NOW);
    assert.equal(r.totalOpen, 5);
    assert.equal(r.measuredAt, NOW.toISOString());
    assert.equal(r.lastMeasured, null);
  });

  it('a measured zero followed by a failed refresh is UNMEASURED, with the zero kept only as labelled history', () => {
    const prev = rec({ totalOpen: 0, measuredAt: ago(3_600_000) });
    const r = nextRecord({ state: 'unmeasured', reason: 'the reader exited 1' }, prev, NOW);
    assert.equal(r.state, 'unmeasured');
    assert.equal(r.totalOpen, null);
    assert.deepEqual(r.lastMeasured, { totalOpen: 0, measuredAt: prev.measuredAt });
    assert.equal(r.attemptedAt, NOW.toISOString(), 'the attempt is recorded');
    assert.equal(r.measuredAt, prev.measuredAt, 'but measuredAt does not move on a failure');
    const line = renderUpstreamLine(ok(r), NOW, 'fleet');
    assert.match(line, /UNMEASURED \(the reader exited 1; last measured 0 at /);
    assert.doesNotMatch(line, /none open/);
  });

  it('two failures in a row keep the SAME last success', () => {
    const first = nextRecord({ state: 'unmeasured', reason: 'a' }, rec({ totalOpen: 7 }), NOW);
    const second = nextRecord({ state: 'unmeasured', reason: 'b' }, first, NOW);
    assert.equal(second.lastMeasured.totalOpen, 7);
  });

  it('with no previous record a failure has no history', () => {
    assert.equal(nextRecord({ state: 'unmeasured', reason: 'x' }, null, NOW).lastMeasured, null);
  });
});

describe('renderUpstreamLine: one renderer for status and next', () => {
  it('measured: open count, none open, and the triage pointer only when something is open', () => {
    assert.match(renderUpstreamLine(ok(rec({ totalOpen: 3 })), NOW), /^upstream: 3 open \(un-acked\) across 2 store\(s\) — triage: `npm run upstream:issues`$/);
    assert.equal(renderUpstreamLine(ok(rec({ totalOpen: 0 })), NOW), 'upstream: none open across 2 store(s)');
  });

  it('partial: a floor, naming how many stores did not answer', () => {
    const line = renderUpstreamLine(ok(rec({ state: 'partial', totalOpen: 2, storesQueried: 1, storesUnqueried: 1 })), NOW);
    assert.match(line, /^upstream: ≥2 open \(un-acked\) across the 1 store\(s\) that answered; 1 unqueried/);
  });

  it('missing and unreadable caches are never a count', () => {
    assert.match(renderUpstreamLine({ state: 'missing' }, NOW, 'fleet'), /not measured yet.*not zero/);
    assert.match(renderUpstreamLine(null, NOW, 'fleet'), /not measured yet/);
    assert.match(renderUpstreamLine({ state: 'unreadable', reason: 'schema mismatch' }, NOW, 'fleet'), /UNMEASURED \(cache schema mismatch\)/);
  });

  it('a cache older than 24h says so, and still shows its count', () => {
    const line = renderUpstreamLine(ok(rec({ totalOpen: 0, measuredAt: ago(UPSTREAM_STALE_MS + 3_600_000) })), NOW, 'fleet');
    assert.match(line, /none open across 2 store\(s\) — stale, measured 25h ago/);
  });

  it('is absent (null), not zero, where the reader does not exist (a consumer)', () => {
    assert.equal(renderUpstreamLine(ok(rec()), NOW, 'fleet', { applicable: false }), null);
  });
});

describe('upstreamQuiet: silent only when measured, fresh and empty', () => {
  it('quiet exactly for a fresh measured zero', () => {
    assert.equal(upstreamQuiet(ok(rec({ totalOpen: 0 })), NOW), true);
    assert.equal(upstreamQuiet(ok(rec({ totalOpen: 1 })), NOW), false);
    assert.equal(upstreamQuiet(ok(rec({ state: 'partial', totalOpen: 0 })), NOW), false, 'a partial zero is a floor, not an empty queue');
    assert.equal(upstreamQuiet(ok(rec({ state: 'unmeasured', totalOpen: null, measuredAt: null })), NOW), false);
    assert.equal(upstreamQuiet(ok(rec({ totalOpen: 0, measuredAt: ago(UPSTREAM_STALE_MS + 1000) })), NOW), false, 'a stale zero is not quiet');
    assert.equal(upstreamQuiet({ state: 'missing' }, NOW), false);
    assert.equal(upstreamQuiet(null, NOW), false);
  });
});

describe('runUpstreamQueues: never throws, every failure is a labelled unmeasured', () => {
  const run = (res) => runUpstreamQueues('reader.mjs', { spawn: () => res });
  const env = JSON.stringify({ storesQueried: 2, storesUnqueried: 0, totalOpen: 4, unresolved: [] });

  it('parses the envelope after banner lines', () => {
    const m = run({ status: 0, stdout: `[env] resolved\n${env}\n` });
    assert.equal(m.state, 'measured');
    assert.equal(m.totalOpen, 4);
  });

  it('a non-zero exit, no JSON, invalid JSON, a spawn error and a thrown spawn are all unmeasured with a reason', () => {
    for (const [res, why] of [
      [{ status: 2, stdout: '' }, /exited 2/],
      [{ status: 0, stdout: 'no json here' }, /no JSON/],
      [{ status: 0, stdout: '{not json' }, /not valid JSON/],
      [{ status: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }, /ETIMEDOUT/],
      [null, /no result/],
    ]) {
      const m = run(res);
      assert.equal(m.state, 'unmeasured');
      assert.match(m.reason, why);
    }
    const thrown = runUpstreamQueues('r', { spawn: () => { throw new Error('boom'); } });
    assert.match(thrown.reason, /boom/);
  });
});

describe('upstreamScript and the cache round trip', () => {
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-count-'));
  const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

  it('applicable only where the main checkout carries the reader (the source repo)', () => {
    const root = mk();
    try {
      const cacheDir = path.join(root, '.git', 'fleet-cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      assert.equal(upstreamScript(cacheDir), null, 'a consumer has no reader');
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.writeFileSync(path.join(root, 'scripts', 'upstream-queues.mjs'), '');
      assert.equal(upstreamScript(cacheDir), path.join(root, 'scripts', 'upstream-queues.mjs'));
      assert.equal(upstreamScript(null), null);
      assert.equal(upstreamScript(path.join(root, 'elsewhere', 'fleet-cache')), null, 'not under a .git directory');
    } finally { rm(root); }
  });

  it('refresh writes the cache; a later failed refresh keeps the success as history; a consumer writes nothing', () => {
    const root = mk();
    try {
      const cacheDir = path.join(root, '.git', 'fleet-cache');
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'upstream-queues.mjs'), '');
      const good = refreshUpstreamCache({ fleetDir: cacheDir, now: NOW, run: () => ({ state: 'measured', totalOpen: 0, storesQueried: 2, storesUnqueried: 0, reason: null }) });
      assert.equal(good.written, true);
      assert.equal(readUpstreamCache(cacheDir).record.totalOpen, 0);

      const bad = refreshUpstreamCache({ fleetDir: cacheDir, now: new Date(NOW.getTime() + 60_000), run: () => ({ state: 'unmeasured', reason: 'store down' }) });
      assert.equal(bad.record.state, 'unmeasured');
      const read = readUpstreamCache(cacheDir);
      assert.equal(read.record.totalOpen, null);
      assert.equal(read.record.lastMeasured.totalOpen, 0);

      fs.rmSync(path.join(root, 'scripts', 'upstream-queues.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      assert.deepEqual(refreshUpstreamCache({ fleetDir: cacheDir, now: NOW }), { applicable: false });
    } finally { rm(root); }
  });

  it('readUpstreamCache: missing, unreadable (bad JSON, bad schema) and no dir are distinct, never an empty ok', () => {
    const d = mk();
    try {
      assert.deepEqual(readUpstreamCache(d), { state: 'missing' });
      fs.writeFileSync(path.join(d, UPSTREAM_CACHE_FILE), '{bad');
      assert.equal(readUpstreamCache(d).state, 'unreadable');
      fs.writeFileSync(path.join(d, UPSTREAM_CACHE_FILE), JSON.stringify({ schemaVersion: 1, state: 'measured' }));
      assert.deepEqual(readUpstreamCache(d), { state: 'unreadable', reason: 'schema mismatch' });
      assert.equal(readUpstreamCache(null).state, 'unreadable');
    } finally { rm(d); }
  });
});
