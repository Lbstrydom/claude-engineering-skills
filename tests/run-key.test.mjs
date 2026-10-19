/**
 * @fileoverview Consumer feedback PR 1, report 05 (docs/triage/copilot-feedback-2026-10-19.md):
 *  - a run/audit id longer than the debt schema's 40-char cap must be recorded under a compact, deterministic,
 *    collision-resistant key instead of being rejected after build or silently sliced;
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compactRunKey, RUN_KEY_MAX } from '../scripts/lib/run-key.mjs';
import { buildDebtEntry } from '../scripts/lib/debt-capture.mjs';
import { buildPreExistingDebtEntry } from '../scripts/lib/audit/stage0-debt-routing.mjs';
import { appendDebtEventsLocal, readDebtEventsLocal } from '../scripts/lib/debt-events.mjs';
import { PersistedDebtEntrySchema } from '../scripts/lib/schemas.mjs';

const LONG_A = 'audit-code-streamlit-session-fix-1792044341278-5648ab';
const finding = {
  _hash: 'abc12345', _topicId: 'T1', severity: 'MEDIUM', category: 'x', section: 's', detail: 'd',
  affectedFiles: ['a.py'], _pass: 'backend',
  classification: { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'gpt-5.4' },
};
const captureArgs = (deferredRun) => ({
  deferredReason: 'out-of-scope', deferredRationale: 'x'.repeat(30), deferredRun,
});

describe('compactRunKey', () => {
  it('leaves an id within the cap untouched', () => {
    assert.equal(compactRunKey('audit-code-1792044341278-5648'), 'audit-code-1792044341278-5648');
    assert.equal(compactRunKey('x'.repeat(RUN_KEY_MAX)), 'x'.repeat(RUN_KEY_MAX));
  });

  it('compacts a longer id to exactly the cap, deterministically', () => {
    const k = compactRunKey(LONG_A);
    assert.equal(k.length, RUN_KEY_MAX);
    assert.equal(compactRunKey(LONG_A), k, 'a retry of the same audit must land on the same key');
  });

  it('does not collide for two ids that share a 40-char prefix (the truncation hazard)', () => {
    const a = 'x'.repeat(40) + '-one';
    const b = 'x'.repeat(40) + '-two';
    assert.notEqual(a.slice(0, 40), '', 'fixture sanity');
    assert.equal(a.slice(0, 40), b.slice(0, 40), 'fixture: the naive slice WOULD collide');
    assert.notEqual(compactRunKey(a), compactRunKey(b));
  });

  it('never splits a surrogate pair at the cut, and stays within the cap', () => {
    const id = 'a'.repeat(26) + String.fromCodePoint(0x1f600) + 'b'.repeat(30);
    const k = compactRunKey(id);
    assert.ok(k.length <= RUN_KEY_MAX);
    assert.equal(k.isWellFormed(), true, 'the key must be well-formed UTF-16');
    assert.equal(compactRunKey(id), k);
  });

  it('rejects a missing or empty id loudly instead of inventing one', () => {
    assert.throws(() => compactRunKey(undefined), /run id/i);
    assert.throws(() => compactRunKey(''), /run id/i);
  });
});

describe('long run ids reach the debt record', () => {
  it('buildDebtEntry stores a schema-valid compact deferredRun for a 53-char id', () => {
    const { entry } = buildDebtEntry(finding, captureArgs(LONG_A));
    assert.equal(entry.deferredRun, compactRunKey(LONG_A));
    const r = PersistedDebtEntrySchema.safeParse(entry);
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  });

  it('the stage0 route no longer slices: two ids sharing a prefix stay distinct', () => {
    const env = { fingerprint: 'fp1', canonicalFinding: { severity: 'LOW', category: 'c', section: 's', detail: 'd' } };
    const a = buildPreExistingDebtEntry(env, 'y'.repeat(40) + '-one');
    const b = buildPreExistingDebtEntry(env, 'y'.repeat(40) + '-two');
    assert.notEqual(a.deferredRun, b.deferredRun);
    assert.ok(a.deferredRun.length <= RUN_KEY_MAX);
  });

  it('a debt event with a long runId is written, not skipped as invalid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-key-'));
    try {
      const p = path.join(dir, 'events.jsonl');
      const n = appendDebtEventsLocal([{ ts: new Date().toISOString(), runId: LONG_A, topicId: 'T1', event: 'surfaced', matchCount: 1 }], p);
      assert.equal(n, 1);
      const back = readDebtEventsLocal(p);
      assert.equal(back[0].runId, compactRunKey(LONG_A));
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});
