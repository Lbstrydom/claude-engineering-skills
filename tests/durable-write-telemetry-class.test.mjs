/**
 * Field report 2026-09-26: a consumer store had lost `bandit_arms`'s
 * three-column unique key, so every audit logged `learning.banditArms — 1 lost`
 * and reported `runStatus: incomplete` although analysis, ledger and findings
 * were all written. `bandit_arms` is a write-only telemetry mirror (live bandit
 * state is local), so its loss must stay VISIBLE but must not degrade the run.
 *
 * Asserted through the PRODUCTION finalizer (`finalizeRun`), not a local copy of
 * its runStatus expression — a copy would keep passing if the real one drifted.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Cloud off BEFORE any module reads config (static imports hoist above env writes).
process.env.LEARNING_DISABLE = '1';
process.env.AUDIT_DB_URL = '';

const { registerWriter, isTelemetryWriter, registeredWriters, _resetRegistry } = await import('../scripts/lib/durable-write.mjs');
const { tallyWriteOutcomes, describeLostWrites } = await import('../scripts/lib/robustness.mjs');
const { registerAuditStoreWriters } = await import('../scripts/lib/audit-store-writers.mjs');
const { finalizeRun } = await import('../scripts/lib/audit/run-finalization.mjs');
const { minimalFinalizationData } = await import('./helpers/multi-pass-audit-fixtures.mjs');

// Snapshot the REAL registry before any test resets it (registration is once-only).
registerAuditStoreWriters();
const REAL_WRITERS = registeredWriters();
const REAL_TELEMETRY = REAL_WRITERS.filter(isTelemetryWriter);

const noop = async () => ({ applied: true });
const fresh = () => ({ written: 0, spilled: 0, lost: 0, skipped: 0, telemetryLost: 0, byWriter: {} });
const BANDIT_42P10 = 'bandit_arms has no unique constraint on (pass_name, variant_id, context_bucket) — there is no unique or exclusion constraint matching the ON CONFLICT specification';

/** Run the production finalizer over a pre-tallied outcome set; capture its stderr. */
async function finalizeWith(writeOutcomes) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    const { mergedResult } = await finalizeRun(minimalFinalizationData(), writeOutcomes);
    return { mergedResult, stderr: lines.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

beforeEach(() => _resetRegistry());
afterEach(() => _resetRegistry());

test('finalizeRun: a telemetry writer failure stays visible but the run is complete', async () => {
  registerWriter('learning.banditArms', { schemaVersion: 1, telemetry: true, replay: noop });
  const w = tallyWriteOutcomes(fresh(), [{ outcome: 'lost', writerId: 'learning.banditArms', error: BANDIT_42P10 }]);
  const { mergedResult, stderr } = await finalizeWith(w);
  assert.equal(mergedResult.runStatus, 'complete');
  assert.equal(mergedResult.writeOutcomes.lost, 0);
  assert.equal(mergedResult.writeOutcomes.telemetryLost, 1);
  assert.equal(mergedResult.writeOutcomes.byWriter['learning.banditArms'].telemetry, true);
  // The operator still sees WHICH write was lost and the schema-drift remedy.
  assert.match(stderr, /1 telemetry-only lost/);
  assert.match(stderr, /learning\.banditArms — 1 lost/);
  assert.match(stderr, /ON CONFLICT target above has no matching unique constraint/);
});

test('negative control: the same failure from an audit writer makes the run incomplete', async () => {
  registerWriter('audit.findings', { schemaVersion: 1, replay: noop });
  const w = tallyWriteOutcomes(fresh(), [{ outcome: 'lost', writerId: 'audit.findings', error: BANDIT_42P10 }]);
  const { mergedResult, stderr } = await finalizeWith(w);
  assert.equal(mergedResult.runStatus, 'incomplete');
  assert.equal(mergedResult.writeOutcomes.telemetryLost, 0);
  assert.match(stderr, /audit\.findings — 1 lost/);
});

test('an unregistered writer id is NOT telemetry (fails closed to incomplete)', async () => {
  const w = tallyWriteOutcomes(fresh(), [{ outcome: 'lost', writerId: 'nobody.registered' }]);
  const { mergedResult } = await finalizeWith(w);
  assert.equal(mergedResult.runStatus, 'incomplete');
});

test('describeLostWrites names a telemetry loss like any other', () => {
  registerWriter('learning.banditArms', { schemaVersion: 1, telemetry: true, replay: noop });
  const w = tallyWriteOutcomes(fresh(), [{ outcome: 'lost', writerId: 'learning.banditArms', error: BANDIT_42P10 }]);
  assert.match(describeLostWrites(w.byWriter).join('\n'), /learning\.banditArms — 1 lost/);
});

test('registry: learning.banditArms is the ONLY telemetry writer (a new one fails here, on purpose)', () => {
  assert.ok(REAL_WRITERS.length >= 5, 'instrument: the real registry was populated');
  assert.deepEqual(REAL_TELEMETRY, ['learning.banditArms']);
});

test('registerWriter rejects a non-boolean telemetry flag', () => {
  assert.throws(() => registerWriter('x', { schemaVersion: 1, telemetry: 'yes', replay: noop }), /telemetry must be a boolean/);
});
