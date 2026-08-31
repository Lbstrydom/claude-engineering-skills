/**
 * @fileoverview `getPool()` says WHICH store it connected to (2026-08-31).
 *
 * The defect it closes: getPool announced nothing, so a process had no way to
 * know which database it reached. An ad-hoc script that imports `db/client.mjs`
 * WITHOUT first importing `lib/load-env.mjs` skips the repo's own `.env` and
 * falls back to whatever `~/.audit-loop.env` names — a different, real,
 * populated database. The wrong-store read does not error. It returns rows, or
 * zero rows, and looks exactly like a correct answer.
 *
 * Measured cost: a consumer session verifying the Azure `finding_embeddings`
 * backfill reported "storyline has zero rows", having queried a local Docker
 * Postgres on :5433 instead of the tenant store. It surfaced only because the
 * figure contradicted another account and someone checked `inet_server_addr()`
 * by hand. Had the two agreed, the wrong number would have been believed — and
 * the remedy under discussion was a re-embed billed to a corporate Azure tenant.
 *
 * The identity is a FINGERPRINT, never a hostname: AGENTS.md requires a store be
 * named to operators by fingerprint, because this repo is public and one
 * consumer's store is corporate. So the tests below assert both halves — that
 * the line identifies the store, and that it leaks no locator.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { storeFingerprint, dbIdentity } from '../scripts/lib/db/client.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = fs.readFileSync(path.join(repoRoot, 'scripts/lib/db/client.mjs'), 'utf8');

// Placeholder host, matching the convention every sibling Azure test already
// uses (`tenant-apim.azure-api.net` in anthropic-azure-route-default.test.mjs).
// This repo is PUBLIC and one consumer's store is corporate: AGENTS.md's
// fingerprint-not-hostname rule governs test fixtures too, not just runtime
// output. The assertions below need only that two DSNs differ.
const AZURE = 'postgresql://audit_app:pw@tenant-psql.postgres.database.azure.com:5432/audit_loop';
const LOCAL = 'postgresql://postgres:postgres@192.168.1.176:5433/postgres';

describe('storeFingerprint — the identity the announcement prints', () => {
  test('THE WHOLE POINT: two different stores get different fingerprints', () => {
    // This is the incident, reduced. The consumer believed it was on the Azure
    // store and was on the local one; the two must be distinguishable at a
    // glance or the line is decoration.
    assert.notEqual(storeFingerprint(AZURE), storeFingerprint(LOCAL));
  });

  test('the SAME store is stable across processes', () => {
    // Two sessions comparing notes have to be able to tell "we are on the same
    // store" from "we disagree about the data" — which is exactly the question
    // that was unanswerable during the incident.
    assert.equal(storeFingerprint(AZURE), storeFingerprint(AZURE));
    assert.match(storeFingerprint(AZURE), /^[0-9a-f]{16}$/);
  });

  test('a differing PORT alone is a different store', () => {
    // The local fallback differed from a legitimate loopback store only by
    // port. A fingerprint that ignored the port would have printed identically
    // for both and taught the operator to trust a wrong reading.
    const a = 'postgresql://u:p@localhost:5432/postgres';
    const b = 'postgresql://u:p@localhost:5433/postgres';
    assert.notEqual(storeFingerprint(a), storeFingerprint(b));
  });

  test('a differing DATABASE alone is a different store', () => {
    const a = 'postgresql://u:p@localhost:5432/audit_loop';
    const b = 'postgresql://u:p@localhost:5432/postgres';
    assert.notEqual(storeFingerprint(a), storeFingerprint(b));
  });

  test('NO LOCATOR LEAKS: the fingerprint contains no host, port or credential', () => {
    // AGENTS.md — never a hostname; one consumer's store is corporate and this
    // repo is public. The digest is one-way, so this asserts the property
    // rather than the implementation.
    const fp = storeFingerprint(AZURE);
    for (const secret of ['tenant-psql', 'azure', 'audit_app', 'pw', '5432', 'audit_loop']) {
      assert.ok(!fp.includes(secret), `fingerprint leaked "${secret}"`);
    }
  });

  test('an unparseable DSN yields null rather than a fabricated identity', () => {
    // A fingerprint invented from garbage would be worse than none: it would
    // compare unequal to itself across processes and read as a store change.
    assert.equal(storeFingerprint('not a dsn'), null);
    assert.equal(dbIdentity('not a dsn'), null);
  });
});

describe('the announcement is wired into getPool', () => {
  const src = () => CLIENT_SRC;

  test('getPool calls announceStore, and announceStore prints the fingerprint', () => {
    // Source-level: the value of this line is that it fires on EVERY connect,
    // and a behavioural test would need a live pool per store to prove that.
    const s = src();
    assert.match(s, /announceStore\(url\);/, 'getPool must announce the store it resolved');
    assert.match(s, /\[db\/client\] store \$\{fp\} \(db=\$\{db\}\)/, 'the line must carry the fingerprint');
    assert.match(s, /process\.stderr\.write/, 'stdout stays clean for JSON');
  });

  test('the announcement latch is CLEARED by _resetForTest', () => {
    // Without this, a test that reconnects to a different store gets silence —
    // the exact blindness this closes, reproduced inside the suite.
    const s = src();
    // Anchored on the DECLARATION, not the bare name: the file mentions
    // `_resetForTest` in a doc comment ~30 lines earlier, and a window measured
    // from that match lands nowhere near the function body.
    assert.match(s, /export async function _resetForTest\(\)[\s\S]{0,500}_announcedStore = null/);
  });

  test('the emitted line interpolates ONLY the fingerprint and the db name', () => {
    // Asserted on the emitted template itself rather than a source slice: the
    // property that matters is that no locator can reach stderr, and the
    // template is the only thing that decides that. (An earlier version of this
    // test sliced the file between two markers and over-ran into getPool, which
    // made it fail on unrelated text — a reminder that a source-scanning
    // assertion is only as good as its boundaries.)
    const s = src();
    const line = s.match(/process\.stderr\.write\(`\s*\[db\/client\] store [^`]*`\)/);
    assert.ok(line, 'the store-announcement line must exist');
    const interpolations = [...line[0].matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
    assert.deepEqual(interpolations, ['fp', 'db'],
      'only the digest and the database name may be printed — never a host, port or credential');
    assert.match(s, /const fp = storeFingerprint\(dsn\)/, 'the identity must come from the one-way digest');
  });
});
