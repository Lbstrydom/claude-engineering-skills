/**
 * @fileoverview Debts d6003d6472e6 + ad2fd650d8bd — `commitReceipt`.
 *
 * The receipt used to be read once, before the copy loop, and rewritten from that
 * snapshot at the end: anything that changed it in between was overwritten, and a
 * failed write was only logged although the rollback guard reads the latest entry.
 * `commitReceipt` re-reads at commit time and reports every failure as an ERROR.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReceiptEntry, readSyncReceipt, appendReceiptEntry, commitReceipt, RECEIPT_VERSION, RECEIPT_PATH,
} from '../scripts/lib/sync-receipt.mjs';

const SOURCE = { repo: 'Lbstrydom/claude-engineering-skills', branch: 'main', commitSha: 'f'.repeat(40), sourceDirty: false };
const at = (t, sha) => buildReceiptEntry({ syncedAt: t, source: { ...SOURCE, commitSha: sha }, created: [`f-${t}`] });
const A = at('2026-11-01T00:00:00.000Z', 'a'.repeat(40));
const B = at('2026-11-02T00:00:00.000Z', 'b'.repeat(40));
const NEW = at('2026-11-03T00:00:00.000Z', 'c'.repeat(40));
const body = (entries) => ({ version: RECEIPT_VERSION, recentSyncs: entries, olderSyncsDropped: 0 }); // newest first
const file = (...entries) => ({ state: 'present', json: body(entries) });
const start = (...entries) => readSyncReceipt(body(entries));

function run(startEntries, freshReads, { fail = false, entry = NEW } = {}) {
  const writes = [];
  let n = 0;
  const out = commitReceipt({
    start: start(...startEntries), entry,
    read: () => freshReads[Math.min(n++, freshReads.length - 1)],
    write: (text) => { if (fail) throw new Error('ENOSPC injected'); writes.push(JSON.parse(text)); },
  });
  return { out, writes };
}

describe('commitReceipt — re-reads at commit time; failures are errors', () => {
  test('unchanged since start: written, history kept, no error', () => {
    const { out, writes } = run([B, A], [file(B, A)]);
    assert.deepEqual([out.outcome, out.error, out.kept], ['written', false, 2]);
    assert.deepEqual(writes[0].recentSyncs.map((e) => e.syncedAt), [NEW.syncedAt, B.syncedAt, A.syncedAt]);
  });

  test('absent at start and at commit: the first entry', () => {
    const { out, writes } = run([], [{ state: 'absent' }]);
    assert.deepEqual([out.outcome, writes[0].recentSyncs.length], ['written', 1]);
  });

  test('RED on the parent: a writer appended an entry mid-run; the parent snapshot append DROPS it, commitReceipt keeps it', () => {
    const X = at('2026-11-02T12:00:00.000Z', 'd'.repeat(40)); // appended by someone else while we ran
    const parentBody = appendReceiptEntry(start(B, A), NEW);   // what the parent wrote: the start snapshot + the new entry
    assert.equal(parentBody.recentSyncs.some((e) => e.syncedAt === X.syncedAt), false, 'red evidence: the parent loses X');
    const { out, writes } = run([B, A], [file(X, B, A)]);
    assert.deepEqual([out.outcome, out.error], ['merged', true]);
    assert.deepEqual(writes[0].recentSyncs.map((e) => e.syncedAt), [NEW.syncedAt, X.syncedAt, B.syncedAt, A.syncedAt]);
    assert.match(out.reason, /changed outside this sync/);
  });

  test('the fresh record LOST an entry the run started with (a checkout to an older history): declined, nothing written', () => {
    const { out, writes } = run([B, A], [file(A)]);
    assert.deepEqual([out.outcome, out.error, writes.length], ['declined', true, 0]);
    assert.match(out.reason, /lost 1 entr/);
  });

  test('an existing entry EDITED IN PLACE (same stamp, a changed field list) is detected, not merged over (audit R1 H5/M3)', () => {
    const edited = { ...B, created: ['someone-edited-this.json'] };
    const { out, writes } = run([B, A], [file(edited, A)]);
    assert.deepEqual([out.outcome, out.error, writes.length], ['declined', true, 0]);
  });

  test('independently changed histories (one shared entry, one new on each side): declined, nothing written', () => {
    const Y = at('2026-11-02T18:00:00.000Z', 'e'.repeat(40));
    const { out, writes } = run([B, A], [file(Y, A)]);
    assert.deepEqual([out.outcome, writes.length], ['declined', 0]);
  });

  for (const state of ['unreadable', 'malformed', 'refused']) {
    test(`the fresh read is ${state}: declined, nothing written`, () => {
      const { out, writes } = run([B], [{ state, message: 'x' }]);
      assert.deepEqual([out.outcome, out.error, writes.length], ['declined', true, 0]);
    });
  }

  test('valid JSON that is not a receipt at commit: declined', () => {
    const { out, writes } = run([B], [{ state: 'present', json: { hello: 'world' } }]);
    assert.deepEqual([out.outcome, writes.length], ['declined', 0]);
  });

  test('a record from a NEWER bundle is never touched, and is not an error (as before)', () => {
    const { out, writes } = run([B], [{ state: 'present', json: { version: RECEIPT_VERSION + 1, recentSyncs: [] } }]);
    assert.deepEqual([out.outcome, out.error, writes.length], ['unsupported', false, 0]);
  });

  test('a WRITE failure is a failed outcome and an ERROR (the parent only logged it)', () => {
    const { out } = run([B, A], [file(B, A)], { fail: true });
    assert.deepEqual([out.outcome, out.error], ['failed', true]);
    assert.match(out.reason, /ENOSPC/);
  });

  test('nothing worth recording: unchanged, no write, no error', () => {
    const same = buildReceiptEntry({ syncedAt: '2026-11-03T00:00:00.000Z', source: SOURCE });
    const next = buildReceiptEntry({ syncedAt: '2026-11-04T00:00:00.000Z', source: SOURCE });
    const { out, writes } = run([same], [file(same)], { entry: next });
    assert.deepEqual([out.outcome, out.error, writes.length], ['unchanged', false, 0]);
  });

  test('the path the CLI reads and the path this commits are the same constant', () => {
    assert.equal(RECEIPT_PATH, '.sync-receipt.json');
  });
});
