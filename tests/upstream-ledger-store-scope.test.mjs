/**
 * @fileoverview The disposition ledger is committed in ONE repo; the reports it
 * closes are filed by consumers into whatever store each consumer's
 * `AUDIT_DB_URL` names. Those are not the same store — `storyline` files into a
 * corporate Azure Postgres while this repo defaults to the NAS one.
 *
 * Before `currentStore`, `ledgerOnly` carried THREE causes under one reason
 * string ("stale, or the issueId was mistyped"): stale, mistyped, and *belongs
 * to a store this run is not connected to*. The third is not a defect, and it
 * failed the push — which is why five real closures had to be deleted from the
 * ledger by hand on 2026-08-29.
 *
 * The direction that matters most here is the one a green suite cannot show
 * you: partitioning MUST NOT swallow a genuinely stale entry, and MUST NOT
 * fire when the store is unknown on either side. Every scoping test below has a
 * paired test proving the old behaviour still holds where it should.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLedgerReconciliation, validateLedgerEntryShape, LEDGER_SCHEMA_VERSION,
} from '../scripts/lib/upstream/dispositions.mjs';
import { renderReconciliationReport } from '../scripts/lib/upstream/commands.mjs';
import { dbIdentity, storeFingerprint } from '../scripts/lib/db/client.mjs';

// Fingerprints, never hostnames — this suite and the ledger it guards are both
// committed to a PUBLIC repo, and one real consumer's store is a corporate
// internal host. Derived here rather than pasted, so the fixture cannot drift
// from what the writer produces.
const NAS = storeFingerprint('postgres://u:p@nas.example.invalid:5433/postgres');
const AZURE = storeFingerprint('postgres://u:p@corp-db.example.invalid:5432/audit_loop');

const ID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const ID_B = 'bbbbbbbb-1111-2222-3333-444444444444';

const entry = (id, over = {}) => ({
  schemaVersion: LEDGER_SCHEMA_VERSION,
  issueId: id,
  state: 'fixed',
  disposition: { kind: 'exempt', value: 'a reason' },
  recordedAt: '2026-08-29T00:00:00.000Z',
  ...over,
});
const row = (id, over = {}) => ({ issueId: id, state: 'fixed', disposition: 'exempt:a reason', ...over });

describe('the stamp is a one-way fingerprint, not the hostname', () => {
  test('it discloses neither credential nor host', () => {
    // The ledger is COMMITTED to a public repo and one consumer's store is a
    // corporate internal hostname that was not previously tracked here. The
    // reconciler only ever compares for EQUALITY, so a digest is sufficient —
    // and it is the only form that is disclosure-safe by construction rather
    // than by a regex someone can get wrong.
    const fp = storeFingerprint('postgres://audit_app:sup3r-s3cret@corp-db.example.invalid:5432/audit_loop');
    assert.match(fp, /^[0-9a-f]{16}$/);
    for (const secret of ['sup3r-s3cret', 'audit_app', 'corp-db', 'example.invalid', '5432', 'audit_loop']) {
      assert.equal(fp.includes(secret), false, `fingerprint leaked "${secret}"`);
    }
  });

  test('it is stable across DSN spellings of one database', () => {
    // Inherits dbIdentity's canonicalisation, so a `?sslmode=` or a different
    // user does not silently make an entry foreign to its own store.
    assert.equal(
      storeFingerprint('postgres://u:p@127.0.0.1:5432/audit_loop'),
      storeFingerprint('postgresql://other@localhost:5432/audit_loop?sslmode=disable'),
    );
    assert.equal(dbIdentity('postgres://u:p@127.0.0.1:5432/audit_loop'), 'localhost:5432/audit_loop');
  });

  test('different databases fingerprint differently', () => {
    assert.notEqual(NAS, AZURE);
  });

  test('an unparseable DSN yields null, never a guess', () => {
    assert.equal(storeFingerprint('not a dsn'), null);
  });

  test('what the writer produces is what the validator accepts', () => {
    // Guards the two halves against drifting apart: a stamp the writer can
    // produce but the validator rejects would fail the coverage gate on every
    // future close.
    for (const dsn of [
      'postgres://u:p@nas.example.invalid:5433/postgres',
      'postgresql://u:p@127.0.0.1:5432/audit_loop',
      'postgres://u:p@host.example.invalid/audit_loop',
    ]) {
      const stamped = entry(ID_A, { storeFingerprint: storeFingerprint(dsn) });
      assert.deepEqual(validateLedgerEntryShape(stamped), [], `rejected ${storeFingerprint(dsn)}`);
    }
  });
});

describe('validateLedgerEntryShape — the fingerprint is optional, but never garbage', () => {
  test('an unstamped legacy entry is still valid', () => {
    // Promoting `store` to required would break every legacy read-modify-write
    // and force a backfill whose only evidence is inference.
    assert.deepEqual(validateLedgerEntryShape(entry(ID_A)), []);
  });

  test('a malformed fingerprint is rejected', () => {
    // Present-but-unrecognisable is worse than absent: it would make the entry
    // foreign to every run, i.e. permanently unreconcilable.
    for (const bad of ['nonsense', '', '   ', 'ABCDEF0123456789', 'abc', 42, null]) {
      const problems = validateLedgerEntryShape(entry(ID_A, { storeFingerprint: bad }));
      assert.ok(problems.some((x) => x.startsWith('storeFingerprint')),
        `accepted storeFingerprint=${JSON.stringify(bad)}`);
    }
  });

  test('a RAW host:port/database value is refused outright', () => {
    // Not merely unused — REFUSED, because a tolerated one would sit in this
    // public repo indefinitely. This is the disclosure the digest exists to
    // prevent, so the validator has to be what stops it.
    const problems = validateLedgerEntryShape(entry(ID_A, { store: 'corp-db.example.invalid:5432/audit_loop' }));
    assert.ok(problems.some((x) => x.startsWith('store must not be present')), problems.join('; '));
  });
});

describe('computeLedgerReconciliation — foreign entries are scope, not divergence', () => {
  test('an entry for ANOTHER store is partitioned out of ledgerOnly', () => {
    const r = computeLedgerReconciliation({
      dbRows: [],
      ledgerEntries: [entry(ID_A, { storeFingerprint: AZURE })],
      currentStore: NAS,
    });
    assert.deepEqual(r.ledgerOnly, [], 'a foreign entry must not read as stale');
    assert.equal(r.otherStore.length, 1);
    assert.match(r.otherStore[0], new RegExp(`${ID_A}.*${AZURE.replace(/\./g, '\\.')}`));
  });

  test('BOTH fingerprints are named, so the reader can tell them apart', () => {
    // "not checked" is only honest if the reader can see that this run's store
    // and the entry's store are genuinely different things.
    const r = computeLedgerReconciliation({
      dbRows: [], ledgerEntries: [entry(ID_A, { storeFingerprint: AZURE })], currentStore: NAS,
    });
    assert.ok(r.otherStore[0].includes(AZURE), 'entry fingerprint missing');
    assert.ok(r.otherStore[0].includes(NAS), "this run's fingerprint missing");
  });

  test('a foreign entry does not suppress a REAL stale entry beside it', () => {
    // The partition must be per-entry, not a whole-run opt-out.
    const r = computeLedgerReconciliation({
      dbRows: [],
      ledgerEntries: [entry(ID_A, { storeFingerprint: AZURE }), entry(ID_B, { storeFingerprint: NAS })],
      currentStore: NAS,
    });
    assert.deepEqual(r.ledgerOnly, [ID_B]);
    assert.equal(r.otherStore.length, 1);
  });
});

describe('computeLedgerReconciliation — the direction it must NOT fire', () => {
  test('a same-store entry with no db row is STILL stale', () => {
    const r = computeLedgerReconciliation({
      dbRows: [], ledgerEntries: [entry(ID_A, { storeFingerprint: NAS })], currentStore: NAS,
    });
    assert.deepEqual(r.ledgerOnly, [ID_A]);
    assert.deepEqual(r.otherStore, []);
  });

  test('an UNSTAMPED entry reconciles as before — legacy behaviour preserved', () => {
    // Every entry written before the field existed was written against the
    // ambient store. Treating absence as "foreign" would silently stop
    // checking the 20 real entries already in the committed ledger.
    const r = computeLedgerReconciliation({
      dbRows: [], ledgerEntries: [entry(ID_A)], currentStore: NAS,
    });
    assert.deepEqual(r.ledgerOnly, [ID_A]);
    assert.deepEqual(r.otherStore, []);
  });

  test('no currentStore disables the partition entirely', () => {
    // Keeps every existing caller correct, and means an unparseable ambient
    // DSN degrades to the old behaviour rather than excusing everything.
    const r = computeLedgerReconciliation({
      dbRows: [], ledgerEntries: [entry(ID_A, { storeFingerprint: AZURE })], currentStore: null,
    });
    assert.deepEqual(r.ledgerOnly, [ID_A]);
    assert.deepEqual(r.otherStore, []);
  });

  test('a foreign entry is not counted as missingFromLedger either', () => {
    // The DB→ledger direction is about rows in THIS store; a foreign entry
    // must not accidentally satisfy — or fail — that direction.
    const r = computeLedgerReconciliation({
      dbRows: [row(ID_A)],
      ledgerEntries: [entry(ID_A, { storeFingerprint: AZURE })],
      currentStore: NAS,
    });
    // The row is real and in this store; its only ledger entry is foreign, so
    // this store genuinely has no entry for it. That IS a divergence.
    assert.deepEqual(r.missingFromLedger, [ID_A]);
    assert.equal(r.otherStore.length, 1);
  });

  test('a same-store match still reconciles clean', () => {
    const r = computeLedgerReconciliation({
      dbRows: [row(ID_A)],
      ledgerEntries: [entry(ID_A, { storeFingerprint: NAS })],
      currentStore: NAS,
    });
    assert.deepEqual(r.missingFromLedger, []);
    assert.deepEqual(r.ledgerOnly, []);
    assert.deepEqual(r.stateMismatch, []);
    assert.deepEqual(r.dispositionMismatch, []);
  });
});

describe('renderReconciliationReport — out-of-scope is printed, never silent', () => {
  const foreign = computeLedgerReconciliation({
    dbRows: [], ledgerEntries: [entry(ID_A, { storeFingerprint: AZURE })], currentStore: NAS,
  });

  test('a clean run still names the entries it did NOT check', () => {
    // Silence here is how a genuinely stale foreign entry would live forever.
    const out = renderReconciliationReport(foreign);
    assert.match(out, /clean/);
    assert.match(out, /Not reconciled/);
    assert.ok(out.includes(AZURE));
    assert.ok(out.includes(ID_A));
  });

  test('it says what to do about them', () => {
    assert.match(renderReconciliationReport(foreign), /AUDIT_DB_URL/);
  });

  test('a genuinely clean run with no foreign entries stays a one-liner', () => {
    // The direction that must not fire: no noise when there is nothing to say.
    const out = renderReconciliationReport(computeLedgerReconciliation({
      dbRows: [], ledgerEntries: [], currentStore: NAS,
    }));
    assert.match(out, /^Reconciliation: clean/);
    assert.equal(out.includes('Not reconciled'), false);
  });

  test('a divergent run reports BOTH the divergence and the out-of-scope set', () => {
    const mixed = computeLedgerReconciliation({
      dbRows: [],
      ledgerEntries: [entry(ID_A, { storeFingerprint: AZURE }), entry(ID_B, { storeFingerprint: NAS })],
      currentStore: NAS,
    });
    const out = renderReconciliationReport(mixed);
    assert.match(out, /divergence found/);
    assert.match(out, /Not reconciled/);
    assert.ok(out.includes(ID_B), 'the real stale entry must still be named');
  });

  test('omitting otherStore entirely does not crash an older caller', () => {
    // The field is new; a caller passing the pre-change shape must still work.
    const out = renderReconciliationReport({
      missingFromLedger: [], ledgerOnly: [], stateMismatch: [],
      dispositionMismatch: [], needsReview: [],
    });
    assert.match(out, /^Reconciliation: clean/);
  });
});
