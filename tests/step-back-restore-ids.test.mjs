/**
 * Pilot 1 rehearsal defect (2026-11-23): the store reconstruction left a store `topicId` (8 hex) on restored findings, so the reviewer
 * pack and its reply validator (`f.topicId ?? topicOf(f)`) spoke 8-hex while the guard's inventory (`topicOf`) spoke 12-hex and the
 * restored ledger spoke 8-hex: 0 of 5 reviewer decisions could be honoured. A restored finding must look like a LIVE one: no store
 * `topicId`, and ledger topics derived the way the live ledger writer derives them.
 *
 * Every assertion has a negative control showing the old shape disagrees.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { topicOf } from '../scripts/lib/audit/cap-productivity.mjs';
import { openInventory, ruledBefore, guardMetaDecision } from '../scripts/lib/audit/meta-review.mjs';
import { toAuditLedgerEntries, toLiveFinding, restorePointFiles } from '../scripts/lib/audit/step-back-continuation.mjs';

const storeFinding = (id, severity, category, topicId) => ({ id, severity, category, section: 'scripts/a.mjs', detail: `detail of ${category}`, _pass: 'backend', affectedFiles: ['scripts/a.mjs'], topicId });
const F1 = storeFinding('f1', 'HIGH', '[Backend] Unsafe guard', 'ab12cd34');
const F2 = storeFinding('f2', 'MEDIUM', '[Backend] Naming nit', 'ee99ff00');
const snapshot = {
  rounds: [{ round: 1, auditedSha: 'a'.repeat(40), verdict: 'x', findings: [F1] }, { round: 2, auditedSha: 'b'.repeat(40), verdict: 'x', findings: [F1, F2] }],
  ledgerEntries: [
    { topicId: 'ab12cd34', findingId: 'f1', adjudicationOutcome: 'accepted', firstSeenRound: 1, round: 1, severity: 'HIGH', affectedFiles: ['scripts/a.mjs'] },
    { topicId: 'orphan01', findingId: 'gone', adjudicationOutcome: 'accepted', firstSeenRound: 1, round: 1, severity: 'LOW', affectedFiles: [] },
  ],
};
const packTopic = (f) => f.topicId ?? topicOf(f); // buildStepBackPack's expression (step-back.mjs)

test('toLiveFinding drops only the store topicId', () => {
  const live = toLiveFinding(F1);
  assert.equal('topicId' in live, false);
  assert.deepEqual({ ...live, topicId: F1.topicId }, F1);
});

test('NEGATIVE CONTROL: with the store topicId the pack id, the guard inventory id and the ledger id are three different ids', () => {
  const pack = packTopic(F1); const inventory = openInventory([F1])[0].topicId;
  assert.equal(pack, 'ab12cd34'); assert.notEqual(pack, inventory);
  assert.equal(snapshot.ledgerEntries[0].topicId, pack);
  assert.equal(ruledBefore(snapshot.ledgerEntries.map((e) => ({ ...e, resolvedRound: 1 })), inventory, 2, []), false, 'the guard finds no ruling for its own inventory topic');
});

test('POSITIVE: restored findings and the restored ledger agree with the pack, the validator set and the guard inventory', () => {
  const live = [F1, F2].map(toLiveFinding);
  const ledger = toAuditLedgerEntries(snapshot);
  const inventory = openInventory(live);
  for (const i of inventory) assert.equal(packTopic(live.find((f) => f.id === i.findingId)), i.topicId, 'pack id === inventory id');
  const f1Topic = topicOf(live[0]);
  assert.equal(ledger[0].topicId, f1Topic); assert.equal(ledger[0].semanticHash, f1Topic);
  assert.equal(ruledBefore(ledger.map((e) => ({ ...e, resolvedRound: 1 })), f1Topic, 2, inventory), true, 'a topic ruled in an earlier round is found');
  assert.equal(ruledBefore(ledger.map((e) => ({ ...e, resolvedRound: 1 })), openInventory(live).find((i) => i.findingId === 'f2').topicId, 2, inventory), false, 'a topic with no ruling stays unruled (nothing is invented)');
});

test('a ledger entry whose finding is not in the snapshot keeps the store id (it matches nothing live, as before)', () => {
  assert.equal(toAuditLedgerEntries(snapshot)[1].topicId, 'orphan01');
});

test('restorePointFiles writes round results with no store topicId and a remapped ledger; the digest check still runs on the FROZEN snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ids-'));
  try {
    const digest = crypto.createHash('sha256').update(JSON.stringify({ rounds: snapshot.rounds, ledgerEntries: snapshot.ledgerEntries })).digest('hex');
    const point = { snapshotDigest: digest, checkpoint: 2, checkpointSha: 'b'.repeat(40) };
    const { auditDir } = restorePointFiles({ dir, point, snapshot, sid: 's1' });
    const r2 = JSON.parse(fs.readFileSync(path.join(auditDir, 's1-r2-result.json'), 'utf8'));
    assert.ok(r2.findings.every((f) => !('topicId' in f)));
    const led = JSON.parse(fs.readFileSync(path.join(auditDir, 's1-ledger.json'), 'utf8'));
    assert.equal(led.entries[0].topicId, topicOf(toLiveFinding(F1)));
    assert.throws(() => restorePointFiles({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ids2-')), point: { ...point, snapshotDigest: 'x' }, snapshot, sid: 's2' }), /does not match the frozen point/, 'the snapshot is still verified as frozen');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('an orphan ledger entry whose store topic a restored finding carries maps to that finding\'s live topic; a true orphan keeps its id', () => {
  const snap = { ...snapshot, ledgerEntries: [...snapshot.ledgerEntries, { topicId: 'ab12cd34', findingId: 'not-in-snapshot', adjudicationOutcome: 'dismissed', firstSeenRound: 1, round: 1, severity: 'HIGH', affectedFiles: [] }] };
  const led = toAuditLedgerEntries(snap);
  assert.equal(led[2].topicId, topicOf(toLiveFinding(F1)), 'mapped through the store topic of a finding that is in the snapshot');
  assert.equal(led[1].topicId, 'orphan01', 'a topic no finding carries stays as it was');
});

test('a finding id reused across rounds with a different topic is refused, never resolved by "last one wins"', () => {
  const clash = { rounds: [{ round: 1, findings: [{ ...F1 }] }, { round: 2, findings: [{ ...F1, topicId: 'zz000000' }] }], ledgerEntries: [] };
  assert.throws(() => toAuditLedgerEntries(clash), /reused across rounds/);
  assert.doesNotThrow(() => toAuditLedgerEntries({ rounds: [{ round: 1, findings: [F1] }, { round: 2, findings: [F1] }], ledgerEntries: [] }), 'the same finding carried into a later round is not a clash');
});

test('restoring never mutates the frozen snapshot: its digest, and so the dataset hash that seals it, are unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ids3-'));
  try {
    const before = JSON.stringify({ rounds: snapshot.rounds, ledgerEntries: snapshot.ledgerEntries });
    const digest = crypto.createHash('sha256').update(before).digest('hex');
    restorePointFiles({ dir, point: { snapshotDigest: digest, checkpoint: 2, checkpointSha: 'b'.repeat(40) }, snapshot, sid: 's9' });
    assert.equal(JSON.stringify({ rounds: snapshot.rounds, ledgerEntries: snapshot.ledgerEntries }), before);
    assert.equal(snapshot.rounds[1].findings[0].topicId, 'ab12cd34', 'the store topicId is still on the frozen finding');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('the d77b shape: a HIGH ruled in an earlier round now lets a structural decision be HONOURED; with the old ids the same decision is downgraded', () => {
  const high = storeFinding('h1', 'HIGH', '[Backend] Silent catch', 'd61e6185');
  const snap = { rounds: [{ round: 1, auditedSha: 'a'.repeat(40), findings: [high] }, { round: 2, auditedSha: 'b'.repeat(40), findings: [high] }],
    ledgerEntries: [{ topicId: 'd61e6185', findingId: 'h1', adjudicationOutcome: 'accepted', firstSeenRound: 1, round: 1, severity: 'HIGH', affectedFiles: ['scripts/a.mjs'] }] };
  const structural = { action: 'structural', assessment: { sustainability: 's', efficiency: 'e', effectiveness: 'x' }, cause: 'c', evidence: [{ file: 'scripts/a.mjs', why: 'w' }], proposedFix: 'p', reason: 'r' };
  const caps = { soft: 6, absolute: 8 };
  const guard = (findings, ledger) => guardMetaDecision({ trigger: 'T1', output: structural, inventory: openInventory(findings), ledgerEntries: ledger, lastRound: 2, packFiles: ['scripts/a.mjs'], round: 3, caps });
  const restored = guard(snap.rounds[1].findings.map(toLiveFinding), toAuditLedgerEntries(snap));
  assert.equal(restored.honoured, true); assert.equal(restored.effect, 'structural');
  const old = guard(snap.rounds[1].findings, snap.ledgerEntries.map((e) => ({ ...e, resolvedRound: 1 })));
  assert.equal(old.honoured, false); assert.equal(old.reasonCode, 'high-not-settled', 'NEGATIVE CONTROL: the pre-fix shape cannot honour it');
});
