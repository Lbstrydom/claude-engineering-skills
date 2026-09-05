/**
 * Pure SQL-generation tests for `scripts/lib/db/query.mjs`.
 * No DB required — exercises only the `_builders` test seam.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _builders } from '../scripts/lib/db/query.mjs';
import { _internals as rpcInternals, PG_VECTOR_DIM } from '../scripts/lib/db/rpc.mjs';
import { normalizePostgresError, annotateConflictTargetFault, _internals as errorInternals } from '../scripts/lib/db/errors.mjs';

const {
  quoteIdent,
  normalizeReturning,
  normalizeConflictTarget,
  buildInsert,
  buildUpsert,
  buildUpdate,
  buildDelete,
} = _builders;

describe('quoteIdent', () => {
  it('wraps a plain identifier in double-quotes', () => {
    assert.equal(quoteIdent('foo'), '"foo"');
    assert.equal(quoteIdent('audit_findings'), '"audit_findings"');
  });

  it('preserves case (Postgres folds unquoted identifiers to lowercase)', () => {
    assert.equal(quoteIdent('CamelCase'), '"CamelCase"');
  });

  it('refuses identifiers containing a double-quote', () => {
    assert.throws(() => quoteIdent('a"b'), /double-quote/);
  });

  it('refuses empty / non-string identifiers', () => {
    assert.throws(() => quoteIdent(''), /non-empty/);
    assert.throws(() => quoteIdent(null), TypeError);
    assert.throws(() => quoteIdent(undefined), TypeError);
    assert.throws(() => quoteIdent(42), TypeError);
  });
});

describe('normalizeReturning', () => {
  it('accepts true and * as wildcards', () => {
    assert.equal(normalizeReturning(true), '*');
    assert.equal(normalizeReturning('*'), '*');
  });

  it('quotes string[] entries', () => {
    assert.equal(normalizeReturning(['id', 'name']), '"id", "name"');
  });

  it('rejects raw-string expressions (R2 H2 — no SQL injection surface)', () => {
    assert.throws(() => normalizeReturning('id, name'), TypeError);
    assert.throws(() => normalizeReturning('id; DROP TABLE users--'), TypeError);
  });

  it('rejects empty arrays + invalid types', () => {
    assert.throws(() => normalizeReturning([]), /cannot be empty/);
    assert.throws(() => normalizeReturning(123), TypeError);
    assert.throws(() => normalizeReturning(null), TypeError);
  });
});

describe('normalizeConflictTarget', () => {
  it('wraps a bare column name', () => {
    assert.equal(normalizeConflictTarget('fingerprint'), '("fingerprint")');
  });

  it('wraps a comma-list of column names', () => {
    assert.equal(normalizeConflictTarget('repo_id, incident_id'), '("repo_id", "incident_id")');
  });

  it('rejects raw parenthesised expressions (R2 H2)', () => {
    assert.throws(
      () => normalizeConflictTarget('(LOWER(name))'),
      /raw parenthesised expressions are not accepted/
    );
    assert.throws(
      () => normalizeConflictTarget('(1=1) -- inject'),
      /raw parenthesised expressions are not accepted/
    );
  });

  it('accepts ON CONSTRAINT with a regular-identifier name', () => {
    assert.equal(normalizeConflictTarget('ON CONSTRAINT unique_x'), 'ON CONSTRAINT unique_x');
    assert.equal(normalizeConflictTarget('on constraint myConstraint'), 'ON CONSTRAINT myConstraint');
  });

  it('rejects ON CONSTRAINT with non-identifier names (R2 H2)', () => {
    // The ON CONSTRAINT branch emits the name UNQUOTED, so injection via
    // characters that terminate the SQL statement (semicolons / parens)
    // must be refused by SAFE_IDENT_RE. The wrapping bare-list branch is
    // safe via quoteIdent regardless.
    assert.throws(
      () => normalizeConflictTarget('ON CONSTRAINT bad;name'),
      /regular identifier/
    );
    assert.throws(
      () => normalizeConflictTarget('ON CONSTRAINT bad(name)'),
      /regular identifier/
    );
  });

  it('quotes string[] entries', () => {
    assert.equal(normalizeConflictTarget(['repo_id', 'fingerprint']), '("repo_id", "fingerprint")');
  });

  it('rejects empty arrays + invalid types', () => {
    assert.throws(() => normalizeConflictTarget([]), /cannot be empty/);
    assert.throws(() => normalizeConflictTarget(42), TypeError);
  });
});

describe('buildInsert', () => {
  it('builds a positional-param INSERT', () => {
    const { sql, params } = buildInsert('audit_runs', { repo_id: 'r1', mode: 'code', rounds: 0 });
    assert.equal(sql, 'INSERT INTO "audit_runs" ("repo_id", "mode", "rounds") VALUES ($1, $2, $3)');
    assert.deepEqual(params, ['r1', 'code', 0]);
  });

  it('adds a RETURNING clause for true / "*" / array', () => {
    assert.equal(
      buildInsert('t', { a: 1 }, { returning: true }).sql,
      'INSERT INTO "t" ("a") VALUES ($1) RETURNING *'
    );
    assert.equal(
      buildInsert('t', { a: 1 }, { returning: '*' }).sql,
      'INSERT INTO "t" ("a") VALUES ($1) RETURNING *'
    );
    assert.equal(
      buildInsert('t', { a: 1 }, { returning: ['id', 'name'] }).sql,
      'INSERT INTO "t" ("a") VALUES ($1) RETURNING "id", "name"'
    );
  });

  it('skips undefined columns (lets DB defaults fire) but keeps nulls', () => {
    const { sql, params } = buildInsert('t', { a: 1, b: undefined, c: null });
    assert.equal(sql, 'INSERT INTO "t" ("a", "c") VALUES ($1, $2)');
    assert.deepEqual(params, [1, null]);
  });

  it('refuses non-object rows', () => {
    assert.throws(() => buildInsert('t', null), TypeError);
    assert.throws(() => buildInsert('t', []), TypeError);
    assert.throws(() => buildInsert('t', 'oops'), TypeError);
  });

  it('refuses an all-undefined row', () => {
    assert.throws(() => buildInsert('t', { a: undefined, b: undefined }), /undefined/);
  });
});

describe('buildUpsert', () => {
  it('DO NOTHING when update is omitted', () => {
    const { sql, params } = buildUpsert(
      't',
      [{ a: 1, b: 2 }, { a: 3, b: 4 }],
      { onConflict: 'a' }
    );
    assert.equal(
      sql,
      'INSERT INTO "t" ("a", "b") VALUES ($1, $2), ($3, $4) ON CONFLICT ("a") DO NOTHING'
    );
    assert.deepEqual(params, [1, 2, 3, 4]);
  });

  it('DO NOTHING for explicit ignore / false / null', () => {
    for (const u of ['ignore', false, null]) {
      const { sql } = buildUpsert('t', [{ a: 1 }], { onConflict: 'a', update: u });
      assert.match(sql, /DO NOTHING/);
    }
  });

  it('DO UPDATE SET … = EXCLUDED.… for "all"', () => {
    const { sql } = buildUpsert('t', [{ a: 1, b: 2 }], { onConflict: 'a', update: 'all' });
    assert.equal(
      sql,
      'INSERT INTO "t" ("a", "b") VALUES ($1, $2) ON CONFLICT ("a") DO UPDATE SET "a" = EXCLUDED."a", "b" = EXCLUDED."b"'
    );
  });

  it('DO UPDATE SET for an explicit column list', () => {
    const { sql } = buildUpsert('t', [{ a: 1, b: 2, c: 3 }], {
      onConflict: 'a',
      update: ['b', 'c'],
    });
    assert.match(sql, /DO UPDATE SET "b" = EXCLUDED\."b", "c" = EXCLUDED\."c"/);
  });

  // conflictWhere — partial-index arbiter predicate (ux-lock-selector-policy §7 #2)
  it('appends a WHERE predicate to the conflict target for a partial index', () => {
    const { sql } = buildUpsert('t', [{ a: 1, b: 2 }], {
      onConflict: ['a', 'b'],
      conflictWhere: "b IS NOT NULL AND a IS NOT NULL",
      update: 'all',
    });
    assert.match(sql, /ON CONFLICT \("a", "b"\) WHERE b IS NOT NULL AND a IS NOT NULL DO UPDATE SET/);
  });

  it('conflictWhere works with DO NOTHING too', () => {
    const { sql } = buildUpsert('t', [{ a: 1 }], { onConflict: 'a', conflictWhere: 'a > 0' });
    assert.match(sql, /ON CONFLICT \("a"\) WHERE a > 0 DO NOTHING/);
  });

  it('rejects conflictWhere without an onConflict target', () => {
    assert.throws(
      () => buildUpsert('t', [{ a: 1 }], { conflictWhere: 'a > 0' }),
      /conflictWhere requires a column-list onConflict/,
    );
  });

  it('rejects conflictWhere on an ON CONSTRAINT target', () => {
    assert.throws(
      () => buildUpsert('t', [{ a: 1 }], { onConflict: 'ON CONSTRAINT foo', conflictWhere: 'a > 0', update: 'all' }),
      /illegal with an ON CONSTRAINT target/,
    );
  });

  it('rejects an empty conflictWhere string', () => {
    assert.throws(
      () => buildUpsert('t', [{ a: 1 }], { onConflict: 'a', conflictWhere: '  ' }),
      /conflictWhere must be a non-empty string/,
    );
  });

  it('refuses non-uniform row shapes', () => {
    assert.throws(
      () => buildUpsert('t', [{ a: 1, b: 2 }, { a: 1 }], { onConflict: 'a' }),
      /different .* shape/
    );
    assert.throws(
      () => buildUpsert('t', [{ a: 1 }, { b: 1 }], { onConflict: 'a' }),
      /different .* shape/
    );
  });

  it('treats undefined as "column omitted" — matches buildInsert (H3 / H7)', () => {
    // The H3 fix: an undefined value MUST be dropped from the SQL exactly
    // like buildInsert does, so DB defaults can fire. The pg driver would
    // otherwise bind it as NULL.
    const { sql, params } = buildUpsert(
      't',
      [{ a: 1, b: undefined, c: 'x' }, { a: 2, b: undefined, c: 'y' }],
      { onConflict: 'a' }
    );
    assert.equal(
      sql,
      'INSERT INTO "t" ("a", "c") VALUES ($1, $2), ($3, $4) ON CONFLICT ("a") DO NOTHING'
    );
    assert.deepEqual(params, [1, 'x', 2, 'y']);
  });

  it('rejects mixed-defined / undefined column across rows (H3 — no silent NULL)', () => {
    // Row 0 declares `b: 1`, row 1 declares `b: undefined`. Allowing that
    // would either bind NULL in row 1 (corruption) or change column count
    // per row (broken SQL). Reject up front.
    assert.throws(
      () => buildUpsert('t', [{ a: 1, b: 1 }, { a: 2, b: undefined }], { onConflict: 'a' }),
      /different .* shape/
    );
  });

  it('rejects an all-undefined row 0', () => {
    assert.throws(
      () => buildUpsert('t', [{ a: undefined }], { onConflict: 'a' }),
      /no defined columns/
    );
  });

  it('rejects update columns not in the insert set (M8)', () => {
    assert.throws(
      () => buildUpsert('t', [{ a: 1 }], { onConflict: 'a', update: ['b'] }),
      /not in the inserted column set/
    );
  });

  it('rejects DO UPDATE without onConflict (M8)', () => {
    assert.throws(
      () => buildUpsert('t', [{ a: 1 }], { update: 'all' }),
      /requires `onConflict`/
    );
    assert.throws(
      () => buildUpsert('t', [{ a: 1 }], { update: ['a'] }),
      /requires `onConflict`/
    );
  });

  it('refuses empty row list / empty update array / invalid update', () => {
    assert.throws(() => buildUpsert('t', [], { onConflict: 'a' }), /non-empty array/);
    assert.throws(
      () => buildUpsert('t', [{ a: 1 }], { onConflict: 'a', update: [] }),
      /update array cannot be empty/
    );
    assert.throws(
      () => buildUpsert('t', [{ a: 1 }], { onConflict: 'a', update: 42 }),
      TypeError
    );
  });

  it('supports composite onConflict via array or comma-string', () => {
    const a = buildUpsert('t', [{ x: 1, y: 2 }], {
      onConflict: ['x', 'y'],
      update: 'all',
    });
    assert.match(a.sql, /ON CONFLICT \("x", "y"\)/);

    const b = buildUpsert('t', [{ x: 1, y: 2 }], {
      onConflict: 'x, y',
      update: 'all',
    });
    assert.match(b.sql, /ON CONFLICT \("x", "y"\)/);
  });

  it('appends RETURNING when supplied', () => {
    const { sql } = buildUpsert('t', [{ a: 1 }], {
      onConflict: 'a',
      update: 'all',
      returning: ['id'],
    });
    assert.match(sql, / RETURNING "id"$/);
  });
});

describe('buildUpdate', () => {
  it('builds an UPDATE … WHERE with positional placeholders', () => {
    const { sql, params } = buildUpdate(
      'audit_findings',
      { user_action: 'deferred', notes: 'x' },
      { id: 'fid' }
    );
    assert.equal(
      sql,
      'UPDATE "audit_findings" SET "user_action" = $1, "notes" = $2 WHERE "id" = $3'
    );
    assert.deepEqual(params, ['deferred', 'x', 'fid']);
  });

  it('translates null WHERE values to IS NULL (no parameter slot)', () => {
    const { sql, params } = buildUpdate('t', { a: 1 }, { b: null, c: 5 });
    assert.equal(sql, 'UPDATE "t" SET "a" = $1 WHERE "b" IS NULL AND "c" = $2');
    assert.deepEqual(params, [1, 5]);
  });

  it('refuses an empty patch', () => {
    assert.throws(() => buildUpdate('t', {}, { id: 1 }), /no defined columns/);
    assert.throws(() => buildUpdate('t', { a: undefined }, { id: 1 }), /no defined columns/);
  });

  it('refuses an empty WHERE', () => {
    assert.throws(() => buildUpdate('t', { a: 1 }, {}), /where clause cannot be empty/);
  });

  it('rejects undefined WHERE values (H2 — no silent predicate drop)', () => {
    // The H2 footgun: { id: undefined, kind: 'x' } should NOT silently
    // collapse to `WHERE kind = 'x'` — that widens the UPDATE.
    assert.throws(
      () => buildUpdate('t', { a: 1 }, { id: undefined, kind: 'x' }),
      /refusing undefined WHERE value/
    );
    // Sole-undefined: still rejected, never falls back to "empty WHERE".
    assert.throws(
      () => buildUpdate('t', { a: 1 }, { id: undefined }),
      /refusing undefined WHERE value/
    );
  });

  it('appends RETURNING when supplied', () => {
    const { sql } = buildUpdate('t', { a: 1 }, { id: 'x' }, { returning: '*' });
    assert.match(sql, / RETURNING \*$/);
  });
});

describe('buildDelete', () => {
  it('builds a DELETE … WHERE with positional placeholders', () => {
    const { sql, params } = buildDelete('refresh_runs', { id: 'r1' });
    assert.equal(sql, 'DELETE FROM "refresh_runs" WHERE "id" = $1');
    assert.deepEqual(params, ['r1']);
  });

  it('refuses an empty WHERE clause', () => {
    assert.throws(() => buildDelete('t', {}), /where clause cannot be empty/);
  });

  it('rejects undefined WHERE values (H2 — no silent predicate drop)', () => {
    assert.throws(
      () => buildDelete('t', { a: undefined, b: 1 }),
      /refusing undefined WHERE value/
    );
    assert.throws(
      () => buildDelete('t', { a: undefined }),
      /refusing undefined WHERE value/
    );
  });

  it('translates null WHERE values to IS NULL', () => {
    const { sql, params } = buildDelete('t', { a: null });
    assert.equal(sql, 'DELETE FROM "t" WHERE "a" IS NULL');
    assert.deepEqual(params, []);
  });

  it('appends RETURNING when supplied', () => {
    const { sql } = buildDelete('t', { id: 'x' }, { returning: ['id'] });
    assert.match(sql, / RETURNING "id"$/);
  });
});

describe('rpc._internals.vectorLiteral', () => {
  it('formats a number array as a pgvector literal', () => {
    assert.equal(rpcInternals.vectorLiteral([1, 2, 3]), '[1,2,3]');
    assert.equal(rpcInternals.vectorLiteral([0.5, -0.25, 0]), '[0.5,-0.25,0]');
  });

  it('returns null for null/undefined', () => {
    assert.equal(rpcInternals.vectorLiteral(null), null);
    assert.equal(rpcInternals.vectorLiteral(undefined), null);
  });

  it('throws on non-arrays', () => {
    assert.throws(() => rpcInternals.vectorLiteral('foo'), TypeError);
    assert.throws(() => rpcInternals.vectorLiteral({ 0: 1 }), TypeError);
  });

  it('throws on NaN / Infinity / non-numbers', () => {
    assert.throws(() => rpcInternals.vectorLiteral([1, NaN]), /finite/);
    assert.throws(() => rpcInternals.vectorLiteral([1, Infinity]), /finite/);
    assert.throws(() => rpcInternals.vectorLiteral([1, '2']), /finite/);
  });

  it('exports PG_VECTOR_DIM = 768 to match the migration schema', () => {
    assert.equal(PG_VECTOR_DIM, 768);
  });

  it('validates length when expectedDim is supplied (M6 / M14)', () => {
    assert.equal(rpcInternals.vectorLiteral([1, 2, 3], { expectedDim: 3 }), '[1,2,3]');
    assert.throws(
      () => rpcInternals.vectorLiteral([1, 2], { expectedDim: 3 }),
      /2 dims, DB expects 3/
    );
    assert.throws(
      () => rpcInternals.vectorLiteral([1, 2, 3, 4], { expectedDim: 3 }),
      /4 dims, DB expects 3/
    );
  });
});

describe('normalizePostgresError', () => {
  it('classifies syscall network codes as transient/retryable (H5)', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH']) {
      const err = Object.assign(new Error('boom'), { code });
      const out = normalizePostgresError(err);
      assert.equal(out.reason, 'transient', `${code} should be transient`);
      assert.equal(out.retryable, true);
      assert.equal(out.bufferToOutbox, true);
      assert.equal(out.nativeCode, code);
    }
  });

  it('classifies the entire SQLSTATE 08* family as transient (H5)', () => {
    for (const code of ['08000', '08003', '08006', '08001', '08004', '08P01', '08007']) {
      const out = normalizePostgresError(Object.assign(new Error('x'), { code }));
      assert.equal(out.reason, 'transient', `SQLSTATE ${code} should be transient`);
      assert.equal(out.retryable, true);
    }
  });

  it('classifies serialization / deadlock / pool-saturation SQLSTATEs as retryable', () => {
    for (const code of ['40001', '40P01', '57014', '57P03', '53300', '53400']) {
      const out = normalizePostgresError(Object.assign(new Error('x'), { code }));
      assert.equal(out.reason, 'transient', `SQLSTATE ${code} should be transient`);
      assert.equal(out.retryable, true);
    }
  });

  it('classifies auth failure (28P01 / 28000) as misconfiguration', () => {
    for (const code of ['28P01', '28000']) {
      const out = normalizePostgresError(Object.assign(new Error('x'), { code }));
      assert.equal(out.reason, 'misconfiguration');
      assert.equal(out.retryable, false);
      assert.match(out.operatorHint, /AUDIT_DB_URL/);
    }
  });

  it('classifies missing table (42P01) as misconfiguration with the setup hint', () => {
    const out = normalizePostgresError(Object.assign(new Error('x'), { code: '42P01' }));
    assert.equal(out.reason, 'misconfiguration');
    assert.match(out.operatorHint, /setup-postgres\.mjs/);
  });

  it('classifies unique-violation (23505) as integrity without overclaiming idempotency (M4)', () => {
    const out = normalizePostgresError(Object.assign(new Error('x'), { code: '23505' }));
    assert.equal(out.reason, 'integrity');
    // The hint must NOT say "safe to ignore" unconditionally — that was the M4 bug.
    assert.doesNotMatch(out.operatorHint, /^Idempotency conflict — safe to ignore on retry$/);
    assert.match(out.operatorHint, /23505/);
  });

  it('falls back to message-substring only when err.code is missing', () => {
    const out = normalizePostgresError(new Error('ECONNREFUSED connect 127.0.0.1:5432'));
    assert.equal(out.reason, 'transient');
    assert.equal(out.retryable, true);
  });

  it('returns unknown for unrecognised errors', () => {
    const out = normalizePostgresError(Object.assign(new Error('something weird'), { code: 'XYZ99' }));
    assert.equal(out.reason, 'unknown');
    assert.equal(out.retryable, false);
    assert.match(out.operatorHint, /XYZ99/);
  });

  it('isConnectionExceptionSqlstate matches only valid 5-char 08* codes', () => {
    assert.equal(errorInternals.isConnectionExceptionSqlstate('08001'), true);
    assert.equal(errorInternals.isConnectionExceptionSqlstate('08P01'), true);
    assert.equal(errorInternals.isConnectionExceptionSqlstate('08'), false);     // too short
    assert.equal(errorInternals.isConnectionExceptionSqlstate('080001'), false); // too long
    assert.equal(errorInternals.isConnectionExceptionSqlstate('09000'), false);  // wrong class
    assert.equal(errorInternals.isConnectionExceptionSqlstate(undefined), false);
    assert.equal(errorInternals.isConnectionExceptionSqlstate(null), false);
  });
});

describe('annotateConflictTargetFault — name the table/columns a bare 42P10 omits', () => {
  it('prepends the table and ON CONFLICT columns to the message', () => {
    const err = Object.assign(
      new Error('there is no unique or exclusion constraint matching the ON CONFLICT specification'),
      { code: '42P10' },
    );
    const out = annotateConflictTargetFault(err, 'bandit_arms', ['pass_name', 'variant_id', 'context_bucket']);
    assert.equal(out, err, 'mutates and returns the same error object');
    assert.match(out.message, /^bandit_arms has no unique constraint on \(pass_name, variant_id, context_bucket\) —/);
    assert.match(out.message, /no unique or exclusion constraint matching the ON CONFLICT specification/);
  });

  it('accepts a single string onConflict target, not just an array', () => {
    const err = Object.assign(new Error('boom'), { code: '42P10' });
    const out = annotateConflictTargetFault(err, 't', 'col_a');
    assert.match(out.message, /^t has no unique constraint on \(col_a\) —/);
  });

  it('leaves any other SQLSTATE untouched', () => {
    const err = Object.assign(new Error('unrelated failure'), { code: '42P01' });
    annotateConflictTargetFault(err, 'bandit_arms', ['pass_name']);
    assert.equal(err.message, 'unrelated failure');
  });

  it('leaves a 42P10 untouched when the caller passed no onConflict target', () => {
    const err = Object.assign(new Error('there is no unique or exclusion constraint matching the ON CONFLICT specification'), { code: '42P10' });
    annotateConflictTargetFault(err, 'bandit_arms', undefined);
    assert.equal(err.message, 'there is no unique or exclusion constraint matching the ON CONFLICT specification');
  });

  it('is a no-op on a falsy error (safe to call unconditionally)', () => {
    assert.equal(annotateConflictTargetFault(null, 't', ['c']), null);
  });
});
