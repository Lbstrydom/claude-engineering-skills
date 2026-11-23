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
import { openInventory, ruledBefore } from '../scripts/lib/audit/meta-review.mjs';
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
