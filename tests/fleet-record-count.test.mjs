/**
 * @fileoverview The "N merged PRs unrecorded" nudge (scripts/lib/fleet/record-count.mjs).
 * Plan: docs/plans/ship-record-catchup.md §2.7. The property under test is "unmeasured is never zero": a missing script, a
 * failed child, a malformed envelope, an absent cache and a not-initialised repo each render as what they are.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  interpretRecordStatus, runRecordStatus, nextRecordCache, refreshRecordCache, readRecordCache, renderRecordLine, recordQuiet,
  recordScript, RECORD_STALE_MS, LAND_RECORD_NUDGE,
} from '../scripts/lib/fleet/record-count.mjs';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const env = (extra = {}) => ({ ok: true, verb: 'status', state: 'measured', reason: null, floor: { mergedThrough: '2026-11-10T00:00:00Z' }, counts: { merged: 5, recorded: 2, unrecorded: 3, unknown: 0 }, remedy: 'node scripts/ship-record.mjs catchup --write', ...extra });
const rec = (m, at = NOW) => ({ state: 'ok', record: nextRecordCache(m, null, at) });

describe('interpretRecordStatus', () => {
  it('reads counts without coercion; a missing counter is unmeasured, never 0', () => {
    assert.equal(interpretRecordStatus(env()).unrecorded, 3);
    const bad = interpretRecordStatus(env({ counts: { unrecorded: null, unknown: 0 } }));
    assert.equal(bad.state, 'unmeasured');
    assert.equal(bad.unrecorded, null);
    assert.equal(interpretRecordStatus({ verb: 'catchup' }).state, 'unmeasured');
    assert.equal(interpretRecordStatus(env({ state: 'nonsense' })).state, 'unmeasured');
  });
  it('a non-measured state carries null counts and its remedy', () => {
    const m = interpretRecordStatus(env({ state: 'no-floor', counts: { unrecorded: null, unknown: null }, remedy: 'node scripts/ship-record.mjs floor --write' }));
    assert.deepEqual([m.state, m.unrecorded, m.remedy], ['no-floor', null, 'node scripts/ship-record.mjs floor --write']);
  });
});

describe('runRecordStatus', () => {
  it('a missing sibling script is UNMEASURED with a re-sync remedy', () => {
    assert.match(runRecordStatus(path.join(os.tmpdir(), 'nope', 'ship-record.mjs'), os.tmpdir()).reason, /re-sync/);
  });
  it('a failed or garbled child is unmeasured', () => {
    const script = fileURLToPath(import.meta.url); // exists
    assert.match(runRecordStatus(script, '.', { spawn: () => ({ status: 1, stdout: '' }) }).reason, /exited 1/);
    assert.match(runRecordStatus(script, '.', { spawn: () => ({ status: 0, stdout: 'hello' }) }).reason, /exactly one JSON value/);
    assert.equal(runRecordStatus(script, '.', { spawn: () => ({ status: 0, stdout: JSON.stringify(env()) }) }).unrecorded, 3);
  });
  it('the sibling resolves next to fleet in this layout', () => {
    assert.ok(fs.existsSync(recordScript(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/lib/fleet'))));
  });
});

describe('cache + renderer', () => {
  it('round-trips the cache; measuredAt only moves on an answer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-count-'));
    refreshRecordCache({ cacheDir: dir, cwd: dir, now: NOW, run: () => interpretRecordStatus(env()), script: 'x' });
    const later = new Date(NOW.getTime() + 60_000);
    refreshRecordCache({ cacheDir: dir, cwd: dir, now: later, run: () => ({ state: 'unmeasured', unrecorded: null, unknown: null, floorThrough: null, reason: 'gh down', remedy: null }), script: 'x' });
    const r = readRecordCache(dir);
    assert.deepEqual([r.record.state, r.record.measuredAt, r.record.attemptedAt], ['unmeasured', NOW.toISOString(), later.toISOString()]);
  });
  it('renders every state as what it is', () => {
    assert.match(renderRecordLine({ state: 'missing' }, NOW), /not measured yet/);
    assert.match(renderRecordLine({ state: 'unreadable', reason: 'schema mismatch' }, NOW), /UNMEASURED \(cache schema mismatch\)/);
    assert.match(renderRecordLine(rec(interpretRecordStatus(env())), NOW), /^records: 3 merged PR\(s\) unrecorded since the floor .* node scripts\/ship-record\.mjs catchup --write \(coordinator\)$/);
    assert.match(renderRecordLine(rec(interpretRecordStatus(env({ state: 'partial', counts: { unrecorded: 1, unknown: 2 } }))), NOW), /≥1 .*2 not yet determinable/);
    assert.match(renderRecordLine(rec(interpretRecordStatus(env({ counts: { unrecorded: 0, unknown: 0 } }))), NOW), /every merged PR is recorded/);
    assert.match(renderRecordLine(rec(interpretRecordStatus(env({ state: 'no-marker', counts: {}, remedy: 'node scripts/ship-record.mjs init' }))), NOW), /not initialised — node scripts\/ship-record\.mjs init/);
    assert.match(renderRecordLine(rec({ state: 'unmeasured', reason: 'gh not installed' }), NOW), /UNMEASURED \(gh not installed\)/);
    assert.match(renderRecordLine(rec(interpretRecordStatus(env()), new Date(NOW.getTime() - RECORD_STALE_MS - 3_600_000)), NOW), /stale/);
  });
  it('quiet only when measured, fresh and zero', () => {
    assert.equal(recordQuiet(rec(interpretRecordStatus(env({ counts: { unrecorded: 0, unknown: 0 } }))), NOW), true);
    assert.equal(recordQuiet(rec(interpretRecordStatus(env())), NOW), false);
    assert.equal(recordQuiet({ state: 'missing' }, NOW), false);
  });
  it('the land nudge names the action, not a stale number', () => {
    assert.match(LAND_RECORD_NUDGE('node scripts/ship-record.mjs', 'node scripts/fleet.mjs'), /catchup --write/);
  });
});

describe('audit C-R1 regressions', () => {
  it('H1/M2: zero unrecorded with an unknown is partial, never "every PR recorded", never quiet', () => {
    const m = interpretRecordStatus(env({ counts: { unrecorded: 0, unknown: 1 } }));
    assert.equal(m.state, 'partial');
    const read = rec(m);
    assert.doesNotMatch(renderRecordLine(read, NOW), /every merged PR is recorded/);
    assert.equal(recordQuiet(read, NOW), false);
  });
  it('H2: a failed envelope is unmeasured, whatever its counts say', () => {
    assert.equal(interpretRecordStatus(env({ ok: false })).state, 'unmeasured');
  });
  it('M2: the cache refuses an inconsistent record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-count-inv-'));
    fs.writeFileSync(path.join(dir, 'record-count.json'), JSON.stringify({ ...nextRecordCache(interpretRecordStatus(env()), null, NOW), unknown: 2 }));
    assert.equal(readRecordCache(dir).state, 'unreadable');
  });
  it('M3: an older refresh never replaces a newer one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-count-ord-'));
    const later = new Date(NOW.getTime() + 60_000);
    refreshRecordCache({ cacheDir: dir, cwd: dir, now: later, run: () => interpretRecordStatus(env()), script: 'x' });
    const older = refreshRecordCache({ cacheDir: dir, cwd: dir, now: NOW, run: () => interpretRecordStatus(env({ counts: { unrecorded: 9, unknown: 0 } })), script: 'x' });
    assert.equal(older.written, false);
    assert.equal(readRecordCache(dir).record.unrecorded, 3);
  });
  it('M1/M4: a serial run that merged and then stopped still nudges', async () => {
    const { _internals } = await import('../scripts/lib/fleet/land.mjs');
    assert.equal(_internals.mergedSomething({ ok: false, run: { steps: [{ step: 'merged' }, { step: 'failed' }] } }), true);
    assert.equal(_internals.mergedSomething({ ok: false, run: { steps: [{ step: 'pending' }] } }), false);
  });
});

describe('audit C-R4 regressions', () => {
  it('H2: a merge invalidates a cached measured zero, so next is no longer quiet', async () => {
    const { invalidateRecordCache } = await import('../scripts/lib/fleet/record-count.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-count-inval-'));
    refreshRecordCache({ cacheDir: dir, cwd: dir, now: NOW, run: () => interpretRecordStatus(env({ counts: { unrecorded: 0, unknown: 0 } })), script: 'x' });
    assert.equal(recordQuiet(readRecordCache(dir), NOW), true);
    assert.equal(invalidateRecordCache(dir, new Date(NOW.getTime() + 1000)), true);
    const r = readRecordCache(dir);
    assert.equal(recordQuiet(r, NOW), false);
    assert.match(renderRecordLine(r, NOW), /UNMEASURED \(a landing merged/);
    assert.equal(r.record.measuredAt, NOW.toISOString(), 'the last measurement is kept as history');
  });
  it('M3: a failing reader keeps its own message', () => {
    const script = fileURLToPath(import.meta.url);
    assert.match(runRecordStatus(script, '.', { spawn: () => ({ status: 3, stdout: JSON.stringify({ ok: false, message: 'catchup refused: no floor' }), stderr: '' }) }).reason, /exited 3: catchup refused: no floor/);
    assert.match(runRecordStatus(script, '.', { spawn: () => ({ status: 1, stdout: '', stderr: 'x\nboom: gh down\n' }) }).reason, /exited 1: boom: gh down/);
  });
  it('M5: stdout must be exactly one JSON value', () => {
    const script = fileURLToPath(import.meta.url);
    assert.match(runRecordStatus(script, '.', { spawn: () => ({ status: 0, stdout: `noise {${JSON.stringify(env())}` }) }).reason, /exactly one JSON value/);
  });
});

describe('audit C-R5 regressions', () => {
  it('M1: a refresh that started in the same millisecond as an invalidation does not overwrite it', async () => {
    const { invalidateRecordCache } = await import('../scripts/lib/fleet/record-count.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-count-tie-'));
    invalidateRecordCache(dir, NOW);
    const r = refreshRecordCache({ cacheDir: dir, cwd: dir, now: NOW, run: () => interpretRecordStatus(env({ counts: { unrecorded: 0, unknown: 0 } })), script: 'x' });
    assert.equal(r.written, false);
    assert.equal(readRecordCache(dir).record.state, 'unmeasured');
  });
  it('H2: an invalidation that cannot be written says so', async () => {
    const { invalidateRecordCache } = await import('../scripts/lib/fleet/record-count.mjs');
    assert.equal(invalidateRecordCache(null, NOW), false);
  });
});
