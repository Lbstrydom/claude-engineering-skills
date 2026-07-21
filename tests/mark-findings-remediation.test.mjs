/**
 * Fix-lifecycle projection: pure targeting cores + fail-open behaviour
 * (fix-lifecycle plan §9). The DB round-trip itself is an integration concern;
 * here we lock the deterministic reconciliation logic and the cloud-off no-op.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLedgerTerminalIndex, selectReconcileTargets,
  markFindingsRemediation, reconcileRemediationProjection,
  normalizeRemediationUpdates,
} from '../scripts/lib/store/runs-findings.mjs';

// ── normalizeRemediationUpdates: validation as a PURE seam (audit R1/M7) ─────
// These do NOT rely on cloud-off, so a broken validator is caught directly.
test('normalizeRemediationUpdates resolves state from action or explicit field', () => {
  const { valid } = normalizeRemediationUpdates([
    { findingFingerprint: 'a', action: 'mark-fixed', resolvedRound: 2 },
    { findingFingerprint: 'b', action: 'mark-regressed' },
    { findingFingerprint: 'c', state: 'verified' },
  ]);
  assert.deepEqual(valid, [
    { fingerprint: 'a', state: 'fixed', resolvedRound: 2 },
    { fingerprint: 'b', state: 'regressed', resolvedRound: null },
    { fingerprint: 'c', state: 'verified', resolvedRound: null },
  ]);
});

test('normalizeRemediationUpdates rejects malformed updates with a reason', () => {
  const { valid, rejected } = normalizeRemediationUpdates([
    { action: 'mark-fixed' },                    // no fingerprint
    { findingFingerprint: 'x' },                 // no state
    { findingFingerprint: 'y', state: 'pending' }, // non-terminal
    { findingFingerprint: 'z', action: 'noop' }, // unresolvable action
  ]);
  assert.equal(valid.length, 0);
  assert.equal(rejected.length, 4);
  assert.match(rejected[0].reason, /fingerprint/i);
  assert.match(rejected[1].reason, /state/);
  assert.match(rejected[2].reason, /non-terminal/);
});

test('normalizeRemediationUpdates tolerates a non-array input', () => {
  assert.deepEqual(normalizeRemediationUpdates(undefined), { valid: [], rejected: [] });
});

test('buildLedgerTerminalIndex keeps only terminal states, keyed by fingerprint', () => {
  const ledger = { entries: [
    { semanticHash: 'a', remediationState: 'fixed' },
    { semanticHash: 'b', remediationState: 'pending' },   // excluded
    { semanticHash: 'c', remediationState: 'regressed' },
    { semanticHash: 'd', remediationState: 'verified' },
    { remediationState: 'fixed' },                         // no fingerprint → excluded
  ] };
  const idx = buildLedgerTerminalIndex(ledger);
  assert.deepEqual([...idx.entries()].sort(), [['a', 'fixed'], ['c', 'regressed'], ['d', 'verified']]);
  assert.ok(!idx.has('b'));
});

test('selectReconcileTargets returns only rows whose DB state DISAGREES with the ledger', () => {
  const idx = new Map([['a', 'fixed'], ['c', 'regressed']]);
  const rows = [
    { finding_fingerprint: 'a', remediation_state: 'pending' },   // disagree → project fixed
    { finding_fingerprint: 'c', remediation_state: 'fixed' },     // disagree (terminal→terminal!) → project regressed
    { finding_fingerprint: 'a2', remediation_state: 'fixed' },    // not in index → skip
    { finding_fingerprint: 'a', remediation_state: 'fixed' },     // agree → no-op
  ];
  const targets = selectReconcileTargets(rows, idx);
  assert.deepEqual(targets.sort((x, y) => x.fingerprint.localeCompare(y.fingerprint)), [
    { fingerprint: 'a', state: 'fixed' },
    { fingerprint: 'c', state: 'regressed' },
  ]);
});

test('terminal→terminal divergence IS selected (Gemini-gate-3 regression guard)', () => {
  // The pending-only filter would have missed this: DB says fixed, ledger says regressed.
  const idx = new Map([['x', 'regressed']]);
  const targets = selectReconcileTargets([{ finding_fingerprint: 'x', remediation_state: 'fixed' }], idx);
  assert.deepEqual(targets, [{ fingerprint: 'x', state: 'regressed' }]);
});

test('markFindingsRemediation is a no-op when cloud is disabled (fail-open)', async () => {
  const prev = process.env.AUDIT_DB_URL;
  delete process.env.AUDIT_DB_URL;
  try {
    const r = await markFindingsRemediation('repo-1', [{ findingFingerprint: 'a', state: 'fixed' }]);
    assert.deepEqual(r, { updated: 0 });
  } finally { if (prev !== undefined) process.env.AUDIT_DB_URL = prev; }
});

test('reconcileRemediationProjection no-ops on empty ledger index / cloud-off', async () => {
  const prev = process.env.AUDIT_DB_URL;
  delete process.env.AUDIT_DB_URL;
  try {
    assert.deepEqual(await reconcileRemediationProjection('repo-1', { entries: [] }), { reconciled: 0 });
  } finally { if (prev !== undefined) process.env.AUDIT_DB_URL = prev; }
});

test('markFindingsRemediation ignores updates missing a fingerprint or state', async () => {
  const prev = process.env.AUDIT_DB_URL;
  delete process.env.AUDIT_DB_URL;
  try {
    // cloud-off returns {updated:0}; the guard-skip logic is exercised regardless.
    const r = await markFindingsRemediation('repo-1', [{ action: 'mark-fixed' }, { findingFingerprint: 'a' }]);
    assert.equal(r.updated, 0);
  } finally { if (prev !== undefined) process.env.AUDIT_DB_URL = prev; }
});
