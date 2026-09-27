/**
 * Field report 2026-09-26: a consumer store had lost `bandit_arms`'s
 * three-column unique key, so every audit logged `learning.banditArms — 1 lost`
 * and reported `runStatus: incomplete` although analysis, ledger and findings
 * were all written. `bandit_arms` is a write-only telemetry mirror (live bandit
 * state is local), so its loss must stay VISIBLE but must not degrade the run.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerWriter, isTelemetryWriter, registeredWriters, _resetRegistry } from '../scripts/lib/durable-write.mjs';
import { tallyWriteOutcomes, describeLostWrites } from '../scripts/lib/robustness.mjs';
import { registerAuditStoreWriters } from '../scripts/lib/audit-store-writers.mjs';

// Snapshot the REAL registry before any test resets it (registration is once-only).
registerAuditStoreWriters();
const REAL_WRITERS = registeredWriters();
const REAL_TELEMETRY = REAL_WRITERS.filter(isTelemetryWriter);

const noop = async () => ({ applied: true });
const fresh = () => ({ written: 0, spilled: 0, lost: 0, skipped: 0, telemetryLost: 0, byWriter: {} });
// The pinned runStatus expression (tests/audit-store-durability-call-site.test.mjs).
const runStatusOf = (w) => (w.lost > 0 || w.spilled > 0 ? 'incomplete' : 'complete');

beforeEach(() => _resetRegistry());
afterEach(() => _resetRegistry());

test('a telemetry writer failure is counted and named but leaves the run complete', () => {
  registerWriter('learning.banditArms', { schemaVersion: 1, telemetry: true, replay: noop });
  const w = tallyWriteOutcomes(fresh(), [{
    outcome: 'lost', writerId: 'learning.banditArms',
    error: 'bandit_arms has no unique constraint on (pass_name, variant_id, context_bucket) — there is no unique or exclusion constraint matching the ON CONFLICT specification',
  }]);
  assert.equal(w.lost, 0);
  assert.equal(w.telemetryLost, 1);
  assert.equal(runStatusOf(w), 'complete');
  assert.equal(w.byWriter['learning.banditArms'].telemetry, true);
  // Still named, with the schema-drift remedy — visible, just not degrading.
  assert.match(describeLostWrites(w.byWriter).join('\n'), /learning\.banditArms — 1 lost/);
});

test('negative control: the same failure from an audit writer still makes the run incomplete', () => {
  registerWriter('audit.findings', { schemaVersion: 1, replay: noop });
  const w = tallyWriteOutcomes(fresh(), [{ outcome: 'lost', writerId: 'audit.findings', error: 'boom' }]);
  assert.equal(w.lost, 1);
  assert.equal(w.telemetryLost, 0);
  assert.equal(runStatusOf(w), 'incomplete');
});

test('an unregistered writer id is NOT telemetry (fails closed to incomplete)', () => {
  const w = tallyWriteOutcomes(fresh(), [{ outcome: 'lost', writerId: 'nobody.registered' }]);
  assert.equal(runStatusOf(w), 'incomplete');
});

test('registry: learning.banditArms is the ONLY telemetry writer', () => {
  assert.ok(REAL_WRITERS.length >= 5, 'instrument: the real registry was populated');
  assert.deepEqual(REAL_TELEMETRY, ['learning.banditArms']);
});

test('registerWriter rejects a non-boolean telemetry flag', () => {
  assert.throws(() => registerWriter('x', { schemaVersion: 1, telemetry: 'yes', replay: noop }), /telemetry must be a boolean/);
});
