/**
 * @fileoverview `generateBackfillSql` — pure, previously untested. Locks the
 * per-entry UPDATE's WHERE clause shape, including the state-conditional
 * predicate added round-5 audit H4.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateBackfillSql } from '../scripts/backfill-upstream-dispositions.mjs';

const entry = (issueId, state, disposition) => ({ issueId, state, disposition });

describe('generateBackfillSql', () => {
  it('conditions each UPDATE on the RESEARCHED state, not just the id (closes round-5 audit H4)', () => {
    const sql = generateBackfillSql(
      [entry('aaaaaaaa-1111-2222-3333-444444444444', 'fixed', { kind: 'probe', value: 'x' })],
      'scripts/upstream-dispositions.json',
    );
    assert.match(sql, /WHERE id = 'aaaaaaaa-1111-2222-3333-444444444444' AND state = 'fixed' AND disposition IS NULL;/);
  });

  it('a wont_fix entry conditions on wont_fix, not fixed', () => {
    const sql = generateBackfillSql(
      [entry('aaaaaaaa-1111-2222-3333-444444444444', 'wont_fix', { kind: 'exempt', value: 'reason' })],
      'scripts/upstream-dispositions.json',
    );
    assert.match(sql, /AND state = 'wont_fix' AND disposition IS NULL;/);
  });

  it('escapes an apostrophe in the disposition value', () => {
    const sql = generateBackfillSql(
      [entry('aaaaaaaa-1111-2222-3333-444444444444', 'fixed', { kind: 'exempt', value: "it's fine" })],
      'scripts/upstream-dispositions.json',
    );
    assert.match(sql, /it''s fine/);
  });

  it('emits exactly one UPDATE per entry plus the catch-all and constraint', () => {
    const sql = generateBackfillSql(
      [
        entry('aaaaaaaa-0000-0000-0000-000000000001', 'fixed', { kind: 'probe', value: 'a' }),
        entry('aaaaaaaa-0000-0000-0000-000000000002', 'wont_fix', { kind: 'exempt', value: 'b' }),
      ],
      'scripts/upstream-dispositions.json',
    );
    const updateCount = (sql.match(/^UPDATE upstream_issues SET disposition/gm) || []).length;
    assert.equal(updateCount, 3); // 2 per-entry + 1 catch-all
    assert.match(sql, /chk_upstream_terminal_has_disposition/);
  });
});
