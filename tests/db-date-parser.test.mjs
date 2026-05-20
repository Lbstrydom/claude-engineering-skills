/**
 * Pool-scoped date-type-parser fidelity test (Gemini G1 / plan R13).
 *
 * The raw `pg` driver parses `timestamptz` / `timestamp` / `date` columns
 * into JS `Date` objects, but the legacy PostgREST path returns ISO-8601
 * strings — silently changing every date field in every return shape
 * unless we register pool-scoped type parsers. This test pins the
 * "comes back as string" contract.
 *
 * Env-gated: requires `AUDIT_DB_TEST_URL` pointing at a postgres + pgvector
 * instance the test can talk to. CI sets this; local devs typically don't —
 * the test suite skips cleanly when absent.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { getPool, closePool, _resetForTest } from '../scripts/lib/db/client.mjs';
import { many, one } from '../scripts/lib/db/query.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

// Save + restore the live AUDIT_DB_URL so the tests don't leak into the
// rest of the suite when run with both set.
let savedUrl;

describe('pool-scoped date parsers (G1)', { skip }, () => {
  before(async () => {
    await _resetForTest();
    savedUrl = process.env.AUDIT_DB_URL;
    process.env.AUDIT_DB_URL = TEST_URL;
  });

  after(async () => {
    await closePool();
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
    else process.env.AUDIT_DB_URL = savedUrl;
  });

  it('builds a pool against AUDIT_DB_TEST_URL', async () => {
    const pool = await getPool();
    assert.ok(pool, 'pool must exist');
  });

  it('returns timestamptz columns as string (OID 1184)', async () => {
    const row = await one(`SELECT NOW() AS ts`);
    assert.ok(row);
    assert.equal(typeof row.ts, 'string', `expected string, got ${typeof row.ts} (${row.ts})`);
    // Sanity-check ISO-ish shape — RFC-3339 with offset.
    assert.match(row.ts, /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/);
  });

  it('returns timestamp (no tz) columns as string (OID 1114)', async () => {
    const row = await one(`SELECT TIMESTAMP '2026-05-20 10:00:00' AS ts`);
    assert.equal(typeof row.ts, 'string');
    assert.match(row.ts, /^2026-05-20/);
  });

  it('returns date columns as string (OID 1082)', async () => {
    const row = await one(`SELECT DATE '2026-05-20' AS d`);
    assert.equal(typeof row.d, 'string');
    assert.equal(row.d, '2026-05-20');
  });

  it('preserves global pg.types parsers — other OIDs unaffected', async () => {
    // Numeric/integer/bool should round-trip in their default JS shapes.
    const rows = await many(`SELECT 1::int AS i, 'hi'::text AS s, TRUE AS b`);
    assert.equal(rows[0].i, 1);
    assert.equal(rows[0].s, 'hi');
    assert.equal(rows[0].b, true);
  });
});
