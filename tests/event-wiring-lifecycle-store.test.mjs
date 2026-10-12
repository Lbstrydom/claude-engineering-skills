/**
 * @fileoverview The event-wiring ledger's two READ-MODIFY-WRITE paths never turn
 * a corrupt ledger into a blank one.
 *
 * `upsertLifecycle` and `reconcileLifecycle` used to swallow a JSON parse error,
 * start from a blank ledger and atomic-write it over the corrupt file - silently
 * and permanently dropping every adjudication entry and every lifecycle record
 * the run did not touch. A file that exists but is not valid JSON now throws and
 * is left byte-for-byte as found; the detector's caller reports that as an
 * 'errored' wave instead of a clean run.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { upsertLifecycle, reconcileLifecycle } from '../scripts/lib/audit/event-wiring-lifecycle-store.mjs';

const withLedger = (initial, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-lifecycle-'));
  const ledgerPath = path.join(dir, 'event-wiring-ledger.json');
  if (initial !== null) fs.writeFileSync(ledgerPath, initial);
  try { return fn(ledgerPath); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
};

const CORRUPT = '{"version":1,"entries":[{"topicId":"abc","adjudicationOutcome":"dismi';
const GOOD = JSON.stringify({
  version: 1,
  entries: [{ topicId: 'abc', adjudicationOutcome: 'dismissed' }],
  lifecycle: { 'event-wiring-symmetry|other': { fingerprint: 'event-wiring-symmetry|other', disposition: 'open' } },
});
const record = { fingerprint: 'event-wiring-symmetry|mine', disposition: 'open' };

describe('a corrupt ledger is refused, never replaced by a blank one', () => {
  it('upsertLifecycle throws and leaves the corrupt file byte-for-byte untouched', () => withLedger(CORRUPT, (p) => {
    assert.throws(() => upsertLifecycle(p, record), /exists but is not valid JSON/);
    assert.equal(fs.readFileSync(p, 'utf-8'), CORRUPT);
  }));

  it('reconcileLifecycle throws and leaves the corrupt file byte-for-byte untouched', () => withLedger(CORRUPT, (p) => {
    assert.throws(
      () => reconcileLifecycle(p, { kind: 'event-wiring-symmetry', observations: [], now: Date.now(), ancestryDecisions: new Map() }),
      /exists but is not valid JSON/,
    );
    assert.equal(fs.readFileSync(p, 'utf-8'), CORRUPT);
  }));
});

describe('NEGATIVE CONTROLS - the same calls on a usable ledger still write, and keep what they did not touch', () => {
  it('upsertLifecycle on an intact ledger keeps its entries and its other lifecycle records', () => withLedger(GOOD, (p) => {
    upsertLifecycle(p, record);
    const after = JSON.parse(fs.readFileSync(p, 'utf-8'));
    assert.equal(after.entries.length, 1, 'the adjudication entry survives');
    assert.ok(after.lifecycle['event-wiring-symmetry|other'], 'the untouched record survives');
    assert.deepEqual(after.lifecycle['event-wiring-symmetry|mine'], record);
  }));

  it('upsertLifecycle on an ABSENT ledger creates it', () => withLedger(null, (p) => {
    upsertLifecycle(p, record);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf-8')).lifecycle['event-wiring-symmetry|mine'], record);
  }));

  it('reconcileLifecycle on an intact ledger keeps its entries', () => withLedger(GOOD, (p) => {
    reconcileLifecycle(p, { kind: 'event-wiring-symmetry', observations: [], now: Date.now(), ancestryDecisions: new Map() });
    const after = JSON.parse(fs.readFileSync(p, 'utf-8'));
    assert.equal(after.entries.length, 1);
    assert.ok(after.lifecycle['event-wiring-symmetry|other']);
  }));
});
