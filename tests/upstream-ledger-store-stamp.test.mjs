/**
 * @fileoverview Every ledger entry is stamped with the store it belongs to — and a
 * writer that never asked must fail loudly rather than write a legacy-shaped entry.
 *
 * **The defect, measured 2026-09-07.** Of 56 committed entries, exactly one carried no
 * `storeFingerprint` (35 in `d5a9d07b91225a93`, 20 in `c7177057dcafa55d`, 1 none). It was
 * alone not because the case is rare but because the path that wrote it can never stamp:
 *
 *     applyMissingDispositions → storeFingerprint: row.storeFingerprint ?? null
 *     listTerminalUpstreamIssues → rows.map(r => ({ issueId, state, disposition }))
 *
 * A three-field projection, and `upstream_issues` has no such column at all (its
 * `fingerprint` column is the issue's 64-hex CONTENT hash — a different thing, which the
 * 16-hex validator would reject). So the left side of `??` was `undefined` on every row
 * and the fallback always fired: an unreachable read wearing a considered fallback's
 * clothes. Same shape as the `dbRows: res.rows ?? []` defect fixed in this same function
 * two days earlier — in both, the `??` is what made it silent.
 *
 * **Why an unstamped entry is not cosmetic.** `isForeign` requires a non-empty
 * fingerprint, so an unstamped entry is treated as LEGACY and is never partitioned into
 * `otherStore`. A `--apply` run against the consumer store therefore writes an entry that
 * the next reconcile here reads as `ledgerOnly` → divergence → blocked push. That is
 * precisely the 2026-08-29 incident this field was introduced to prevent, when five real
 * closures had to be deleted from the ledger by hand.
 *
 * **Why the existing guard could not see it.** `upstream-disposition-ledger-single-writer`
 * asserts the two writers agree GIVEN THE SAME ENTRY — it hands both an entry it
 * constructed itself, with a fingerprint. The divergence was never in the merge rule; it
 * was in what each CALLER put into the entry, one layer above anything that suite looks
 * at. So the fix is not another equivalence test: it is making the question impossible to
 * skip silently, which is what `mergeLedgerEntry` now enforces for every writer, present
 * and future.
 *
 * @module tests/upstream-ledger-store-stamp
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyMissingDispositions, mergeLedgerEntry, serialiseDispositionLedger,
  captureReconcilePrecondition, DISPOSITION_LEDGER_PATH,
} from '../scripts/lib/upstream/commands.mjs';
import { MISSING_CAUSE } from '../scripts/lib/upstream/dispositions.mjs';
import { g, uuid, readLedger } from './helpers/upstream-ledger-test-utils.mjs';

const STORE = 'd5a9d07b91225a93';
const _dirs = [];
after(() => {
  for (const d of _dirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

function makeRepo(entries = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
  _dirs.push(dir);
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.email', 't@example.com']);
  g(dir, ['config', 'user.name', 'T']);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, DISPOSITION_LEDGER_PATH), serialiseDispositionLedger(entries));
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'x');
  g(dir, ['add', '.']);
  g(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

/** The row shape `listTerminalUpstreamIssues` really returns — three fields, no more. */
const row = (id, disposition) => ({ issueId: id, state: 'fixed', disposition });

const causeFor = (dir) => ({
  cause: MISSING_CAUSE.NOT_STALENESS,
  presentUpstream: [],
  freshness: { state: 'current', behindBy: 0, upstream: 'origin/main', subjectOid: null, reason: null },
  precondition: captureReconcilePrecondition(dir),
});

const deps = {
  probeIdsFn: () => ['hydration/tooling-absent'],
  trackedTestFilesFn: () => new Set(['tests/real.test.mjs']),
};

describe('the repair path stamps the store it read the rows from', () => {
  it('writes the fingerprint its caller supplied — not one scavenged off the row', async () => {
    const dir = makeRepo();
    const r = await applyMissingDispositions({
      repoRoot: dir,
      dbRows: [row(uuid(1), 'test:tests/real.test.mjs')],
      missingIds: [uuid(1)],
      missingCause: causeFor(dir),
      storeFingerprint: STORE,
      ...deps,
    });
    assert.equal(r.wrote, true, `expected a write, got aborted=${r.aborted}`);
    const [entry] = readLedger(dir);
    assert.equal(entry.storeFingerprint, STORE,
      'an unstamped entry reconciles as ledgerOnly against any OTHER store and blocks a push');
  });

  it('stamps every entry in a multi-row batch, not merely the first', async () => {
    const dir = makeRepo();
    const r = await applyMissingDispositions({
      repoRoot: dir,
      dbRows: [row(uuid(1), 'test:tests/real.test.mjs'), row(uuid(2), 'probe:hydration/tooling-absent')],
      missingIds: [uuid(1), uuid(2)],
      missingCause: causeFor(dir),
      storeFingerprint: STORE,
      ...deps,
    });
    assert.equal(r.applied.length, 2, `expected 2 applied, got aborted=${r.aborted}`);
    const entries = readLedger(dir);
    assert.equal(entries.length, 2);
    for (const e of entries) assert.equal(e.storeFingerprint, STORE, `${e.issueId} went unstamped`);
  });

  it('a caller with no resolvable DSN may pass null — that is legacy, and legal', async () => {
    // The distinction the fix turns on: `null` means ASKED AND UNANSWERABLE (cloud off,
    // no DSN), which is a real state and must keep working. Only "never asked" is a bug.
    const dir = makeRepo();
    const r = await applyMissingDispositions({
      repoRoot: dir,
      dbRows: [row(uuid(1), 'test:tests/real.test.mjs')],
      missingIds: [uuid(1)],
      missingCause: causeFor(dir),
      storeFingerprint: null,
      ...deps,
    });
    assert.equal(r.wrote, true);
    assert.equal('storeFingerprint' in readLedger(dir)[0], false,
      'an unknown store is OMITTED, never invented — an invented value is permanently unreconcilable');
  });

  it('a caller that never asked is REFUSED, not silently unstamped', async () => {
    // The whole sustainability claim. A future third writer that forgets this argument
    // fails here instead of quietly seeding the 2026-08-29 incident again.
    const dir = makeRepo();
    const before = fs.readFileSync(path.join(dir, DISPOSITION_LEDGER_PATH), 'utf-8');
    await assert.rejects(
      () => applyMissingDispositions({
        repoRoot: dir,
        dbRows: [row(uuid(1), 'test:tests/real.test.mjs')],
        missingIds: [uuid(1)],
        missingCause: causeFor(dir),
        ...deps,
      }),
      /storeFingerprint/,
      'omitting the argument entirely must be loud',
    );
    assert.equal(fs.readFileSync(path.join(dir, DISPOSITION_LEDGER_PATH), 'utf-8'), before,
      'and must write nothing — asserted on the bytes, not the thrown message');
  });
});

describe('mergeLedgerEntry — the one choke point every writer passes through', () => {
  const base = { issueId: uuid(1), state: 'fixed', disposition: { kind: 'test', value: 'tests/real.test.mjs' } };

  it('refuses an entry whose author never considered the store', () => {
    assert.throws(() => mergeLedgerEntry([], { ...base }), /storeFingerprint/);
  });

  it('accepts an explicit null, and omits the key from the written entry', () => {
    const [out] = mergeLedgerEntry([], { ...base, storeFingerprint: null });
    assert.equal('storeFingerprint' in out, false);
  });

  it('accepts a value, and carries it through', () => {
    const [out] = mergeLedgerEntry([], { ...base, storeFingerprint: STORE });
    assert.equal(out.storeFingerprint, STORE);
  });

  it('still PRESERVES a prior stamp when a re-write cannot determine one', () => {
    // Unchanged behaviour, pinned here because the new guard sits directly above it:
    // a read-modify-write is a constructor, and dropping a field on re-write is how an
    // entry silently becomes legacy-shaped again.
    const prior = [{ schemaVersion: 1, issueId: base.issueId, storeFingerprint: STORE, state: 'wont_fix', disposition: { kind: 'exempt', value: 'x' }, recordedAt: '2020-01-01T00:00:00.000Z' }];
    const [out] = mergeLedgerEntry(prior, { ...base, storeFingerprint: null });
    assert.equal(out.storeFingerprint, STORE);
  });
});

describe('the row shape the repair reads from is the one the store really returns', () => {
  it('a fingerprint on the ROW is ignored — it is a property of the connection', async () => {
    // The defect was `row.storeFingerprint ?? null`, reading a field the projection has
    // never had. Pinned as a NEGATIVE: even if a future row grew such a field, the
    // caller's answer wins, because only the caller knows which connection produced it.
    const dir = makeRepo();
    await applyMissingDispositions({
      repoRoot: dir,
      dbRows: [{ ...row(uuid(1), 'test:tests/real.test.mjs'), storeFingerprint: 'ffffffffffffffff' }],
      missingIds: [uuid(1)],
      missingCause: causeFor(dir),
      storeFingerprint: STORE,
      ...deps,
    });
    assert.equal(readLedger(dir)[0].storeFingerprint, STORE);
  });
});
