/**
 * @fileoverview Phase D — debt-memory facade tests.
 * Tests source selection + append/load paths. Cloud paths are mocked indirectly
 * by controlling whether isCloudEnabled() returns true.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  EventSource,
  selectEventSource,
  loadDebtLedger,
  appendEvents,
} from '../scripts/lib/debt-memory.mjs';

let tmpDir;
let ledgerPath;
let eventsPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-memory-test-'));
  ledgerPath = path.join(tmpDir, 'tech-debt.json');
  eventsPath = path.join(tmpDir, 'local', 'debt-events.jsonl');
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
});

// ── selectEventSource ───────────────────────────────────────────────────────

describe('selectEventSource', () => {
  test('noDebtLedger → DISABLED', () => {
    const ctx = selectEventSource({ noDebtLedger: true });
    assert.equal(ctx.source, EventSource.DISABLED);
    assert.equal(ctx.canWrite, false);
    assert.equal(ctx.repoId, null);
  });

  test('no cloud + no repoId → LOCAL', () => {
    // Cloud not initialized (learning-store not calling initLearningStore)
    const ctx = selectEventSource({ repoId: null });
    assert.equal(ctx.source, EventSource.LOCAL);
    assert.equal(ctx.canWrite, true);
    assert.equal(ctx.repoId, null);
  });

  test('readOnly flag blocks writes', () => {
    const ctx = selectEventSource({ readOnly: true });
    assert.equal(ctx.source, EventSource.LOCAL);
    assert.equal(ctx.canWrite, false);
  });

  test('DISABLED takes precedence over readOnly', () => {
    const ctx = selectEventSource({ noDebtLedger: true, readOnly: true });
    assert.equal(ctx.source, EventSource.DISABLED);
  });
});

// ── loadDebtLedger ──────────────────────────────────────────────────────────

describe('loadDebtLedger', () => {
  test('DISABLED context returns empty ledger', async () => {
    const ctx = { source: EventSource.DISABLED, canWrite: false, repoId: null };
    const r = await loadDebtLedger(ctx, { ledgerPath, eventsPath });
    assert.deepEqual(r.entries, []);
    assert.equal(r.eventSource, EventSource.DISABLED);
  });

  test('LOCAL context reads from local JSONL', async () => {
    // Write a ledger + local events
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      entries: [{
        source: 'debt', topicId: 't1', semanticHash: 'h1',
        severity: 'HIGH', category: 'c', section: 's', detailSnapshot: 'd',
        affectedFiles: [], affectedPrinciples: [], pass: 'p',
        deferredReason: 'out-of-scope',
        deferredAt: '2026-04-05T10:00:00.000Z',
        deferredRun: 'r1',
        deferredRationale: 'a sufficiently long rationale for testing',
        contentAliases: [], sensitive: false,
      }],
    }));
    fs.writeFileSync(eventsPath,
      JSON.stringify({ ts: '2026-04-05T10:00:00.000Z', runId: 'run1', topicId: 't1', event: 'surfaced' }) + '\n'
    );

    const ctx = { source: EventSource.LOCAL, canWrite: true, repoId: null };
    const r = await loadDebtLedger(ctx, { ledgerPath, eventsPath });
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].occurrences, 1);
    assert.equal(r.eventSource, EventSource.LOCAL);
  });

  test('missing ledger file returns empty entries', async () => {
    const ctx = { source: EventSource.LOCAL, canWrite: true, repoId: null };
    const r = await loadDebtLedger(ctx, { ledgerPath, eventsPath });
    assert.deepEqual(r.entries, []);
  });
});

// ── appendEvents ────────────────────────────────────────────────────────────

describe('appendEvents', () => {
  test('LOCAL context appends to local JSONL', async () => {
    const ctx = { source: EventSource.LOCAL, canWrite: true, repoId: null };
    const r = await appendEvents(ctx, [
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced' },
    ], { eventsPath });
    assert.equal(r.written, 1);
    assert.equal(r.source, EventSource.LOCAL);
    assert.ok(fs.existsSync(eventsPath));
  });

  test('DISABLED context writes nothing', async () => {
    const ctx = { source: EventSource.DISABLED, canWrite: false };
    const r = await appendEvents(ctx, [
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced' },
    ], { eventsPath });
    assert.equal(r.written, 0);
  });

  test('canWrite=false blocks local writes', async () => {
    const ctx = { source: EventSource.LOCAL, canWrite: false };
    const r = await appendEvents(ctx, [
      { ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced' },
    ], { eventsPath });
    assert.equal(r.written, 0);
    assert.equal(fs.existsSync(eventsPath), false);
  });

  test('empty input returns 0 written', async () => {
    const ctx = { source: EventSource.LOCAL, canWrite: true };
    const r = await appendEvents(ctx, [], { eventsPath });
    assert.equal(r.written, 0);
  });
});
