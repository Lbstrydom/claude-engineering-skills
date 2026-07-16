/**
 * @fileoverview Phase D — debt-events tests.
 * Covers local JSONL append/read + metric derivation.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  appendDebtEventsLocal,
  readDebtEventsLocal,
  deriveMetricsFromEvents,
} from '../scripts/lib/debt-events.mjs';

let tmpDir;
let eventsPath;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-events-test-'));
  eventsPath = path.join(tmpDir, 'debt-events.jsonl');
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
});

// ── Append / Read ───────────────────────────────────────────────────────────

describe('appendDebtEventsLocal', () => {
  test('creates parent directory if missing', () => {
    const nested = path.join(tmpDir, 'sub', 'dir', 'events.jsonl');
    const n = appendDebtEventsLocal(
      [{ ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'deferred' }],
      nested
    );
    assert.equal(n, 1);
    assert.ok(fs.existsSync(nested));
  });

  test('appends one line per event', () => {
    appendDebtEventsLocal([
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'deferred' },
      { ts: '2026-04-05T11:00:00.000Z', runId: 'r1', topicId: 'b', event: 'surfaced' },
    ], eventsPath);
    const lines = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
  });

  test('appends idempotently (two calls = 2 events total)', () => {
    appendDebtEventsLocal([{ ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'deferred' }], eventsPath);
    appendDebtEventsLocal([{ ts: '2026-04-05T11:00:00.000Z', runId: 'r2', topicId: 'a', event: 'surfaced' }], eventsPath);
    assert.equal(readDebtEventsLocal(eventsPath).length, 2);
  });

  test('skips invalid events with warning', () => {
    const n = appendDebtEventsLocal([
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'deferred' },
      { ts: 'not-a-date', runId: 'r1', topicId: 'a', event: 'deferred' },   // bad ts
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', event: 'frozen' },     // bad event
    ], eventsPath);
    assert.equal(n, 1);  // only one valid
  });

  test('returns 0 for empty input', () => {
    assert.equal(appendDebtEventsLocal([], eventsPath), 0);
    assert.equal(appendDebtEventsLocal(null, eventsPath), 0);
  });
});

describe('readDebtEventsLocal', () => {
  test('returns empty array for missing file', () => {
    assert.deepEqual(readDebtEventsLocal(eventsPath), []);
  });

  test('reads all valid events', () => {
    fs.writeFileSync(eventsPath, [
      JSON.stringify({ ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'deferred' }),
      JSON.stringify({ ts: '2026-04-05T11:00:00.000Z', runId: 'r1', topicId: 'b', event: 'surfaced' }),
    ].join('\n'));
    const events = readDebtEventsLocal(eventsPath);
    assert.equal(events.length, 2);
    assert.equal(events[0].topicId, 'a');
  });

  test('skips malformed lines', () => {
    fs.writeFileSync(eventsPath, [
      JSON.stringify({ ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'deferred' }),
      'this is not json',
      JSON.stringify({ ts: '2026-04-05T11:00:00.000Z', runId: 'r1', topicId: 'b', event: 'surfaced' }),
    ].join('\n'));
    assert.equal(readDebtEventsLocal(eventsPath).length, 2);
  });

  test('ignores blank lines', () => {
    fs.writeFileSync(eventsPath,
      JSON.stringify({ ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'deferred' }) + '\n\n\n'
    );
    assert.equal(readDebtEventsLocal(eventsPath).length, 1);
  });
});

// ── deriveMetricsFromEvents ─────────────────────────────────────────────────

describe('deriveMetricsFromEvents', () => {
  test('empty stream returns empty map', () => {
    assert.equal(deriveMetricsFromEvents([]).size, 0);
  });

  test('distinctRunCount = unique runIds across surfaced events', () => {
    const events = [
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced' },
      { ts: '2026-04-05T11:00:00.000Z', runId: 'r2', topicId: 'a', event: 'surfaced' },
      { ts: '2026-04-05T12:00:00.000Z', runId: 'r2', topicId: 'a', event: 'surfaced' },  // dup runId
      { ts: '2026-04-05T13:00:00.000Z', runId: 'r3', topicId: 'a', event: 'surfaced' },
    ];
    const m = deriveMetricsFromEvents(events).get('a');
    assert.equal(m.distinctRunCount, 3);
    assert.equal(m.occurrences, 3);
  });

  test('matchCount sums matchCount fields (default 1 when absent)', () => {
    const events = [
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced', matchCount: 3 },
      { ts: '2026-04-05T11:00:00.000Z', runId: 'r2', topicId: 'a', event: 'surfaced' },   // default 1
      { ts: '2026-04-05T12:00:00.000Z', runId: 'r3', topicId: 'a', event: 'surfaced', matchCount: 5 },
    ];
    assert.equal(deriveMetricsFromEvents(events).get('a').matchCount, 9);
  });

  test('lastSurfacedRun + lastSurfacedAt track most recent surfaced event', () => {
    const events = [
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced' },
      { ts: '2026-04-05T15:00:00.000Z', runId: 'r3', topicId: 'a', event: 'surfaced' },
      { ts: '2026-04-05T12:00:00.000Z', runId: 'r2', topicId: 'a', event: 'surfaced' },
    ];
    const m = deriveMetricsFromEvents(events).get('a');
    assert.equal(m.lastSurfacedRun, 'r3');
    assert.equal(m.lastSurfacedAt, '2026-04-05T15:00:00.000Z');
  });

  test('escalated flag flips on "escalated" event', () => {
    const events = [
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced' },
      { ts: '2026-04-05T11:00:00.000Z', runId: 'r2', topicId: 'a', event: 'escalated' },
    ];
    const m = deriveMetricsFromEvents(events).get('a');
    assert.equal(m.escalated, true);
    assert.equal(m.escalatedAt, '2026-04-05T11:00:00.000Z');
  });

  test('resolved event removes entry from metrics', () => {
    const events = [
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced' },
      { ts: '2026-04-05T11:00:00.000Z', runId: 'r2', topicId: 'a', event: 'surfaced' },
      { ts: '2026-04-05T12:00:00.000Z', runId: 'r3', topicId: 'a', event: 'resolved' },
    ];
    assert.equal(deriveMetricsFromEvents(events).has('a'), false);
  });

  test('reopened event does not affect distinctRunCount', () => {
    const events = [
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced' },
      { ts: '2026-04-05T11:00:00.000Z', runId: 'r2', topicId: 'a', event: 'reopened' },
      { ts: '2026-04-05T12:00:00.000Z', runId: 'r3', topicId: 'a', event: 'reopened' },
    ];
    const m = deriveMetricsFromEvents(events).get('a');
    assert.equal(m.distinctRunCount, 1);
  });

  test('multiple topicIds tracked independently', () => {
    const events = [
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced' },
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'b', event: 'surfaced' },
      { ts: '2026-04-05T11:00:00.000Z', runId: 'r2', topicId: 'a', event: 'surfaced' },
    ];
    const metrics = deriveMetricsFromEvents(events);
    assert.equal(metrics.get('a').distinctRunCount, 2);
    assert.equal(metrics.get('b').distinctRunCount, 1);
  });

  test('reconciled markers are ignored', () => {
    const events = [
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced' },
      { ts: '2026-04-05T11:00:00.000Z', runId: 'r-reconcile', event: 'reconciled' },
      { ts: '2026-04-05T12:00:00.000Z', runId: 'r2', topicId: 'a', event: 'surfaced' },
    ];
    assert.equal(deriveMetricsFromEvents(events).get('a').distinctRunCount, 2);
  });

  test('events sorted by timestamp regardless of input order', () => {
    const events = [
      { ts: '2026-04-05T12:00:00.000Z', runId: 'r3', topicId: 'a', event: 'surfaced' },
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced' },
      { ts: '2026-04-05T11:00:00.000Z', runId: 'r2', topicId: 'a', event: 'surfaced' },
    ];
    const m = deriveMetricsFromEvents(events).get('a');
    assert.equal(m.lastSurfacedRun, 'r3');
    assert.equal(m.lastSurfacedAt, '2026-04-05T12:00:00.000Z');
  });
});
