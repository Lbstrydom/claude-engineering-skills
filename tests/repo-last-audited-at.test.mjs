/**
 * @fileoverview Guards `audit_repos.last_audited_at` against reverting to
 * "last touched".
 *
 * The defect class this pins: `resolveRepoForStore()` guards its UPDATE branch
 * so a profile-less (read-only) call does not bump the column, but the sibling
 * INSERT branch did not — and the miss was UNOBSERVABLE, because the column was
 * `NOT NULL DEFAULT NOW()`, so omitting it wrote exactly the value the guard
 * was trying to withhold. Migration
 * 20260731130000_audit_repos_last_audited_at_nullable.sql dropped both the NOT
 * NULL and the DEFAULT; `auditStampCols()` is now the single writer.
 *
 * Two lanes, because neither alone is honest:
 *  - a SOURCE guard that runs in the default (no-DB) suite — it is the branch
 *    DRIFT that recurs, and a DB-gated test skips silently on a normal machine;
 *  - DB-gated behaviour assertions (`npm run test:db` / `npm run db:local`)
 *    that read the real column back, which is the only proof the DEFAULT is
 *    actually gone. A code-only change here would have been a no-op.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const REPO_SRC = fs.readFileSync(path.join(ROOT, 'scripts/lib/store/repo.mjs'), 'utf-8');

// ── Lane 1: source guard (no DB) ───────────────────────────────────────────

test('every last_audited_at write in repo.mjs goes through auditStampCols', () => {
  // A write is `last_audited_at:` used as an object key in a column patch. The
  // helper's own body is the sole legitimate occurrence; anything else is a
  // second writer that can drift from the guard (which is exactly what
  // happened to the INSERT branch).
  const writes = REPO_SRC.match(/last_audited_at\s*:/g) ?? [];
  assert.equal(
    writes.length, 1,
    `expected exactly 1 \`last_audited_at:\` write site (inside auditStampCols), found ${writes.length}. ` +
    'Route the new write through auditStampCols(profile) instead of stamping inline.',
  );

  const helper = REPO_SRC.match(/function auditStampCols\(profile\)\s*\{[\s\S]*?\n\}/);
  assert.ok(helper, 'auditStampCols(profile) must exist as the single stamp writer');
  assert.match(
    helper[0], /last_audited_at\s*:/,
    'the single write site must be inside auditStampCols',
  );
  assert.match(
    helper[0], /profile\s*\?/,
    'auditStampCols must gate the stamp on a profile being supplied',
  );
});

test('the migration relaxes BOTH the NOT NULL and the DEFAULT', () => {
  // Dropping only the NOT NULL leaves `DEFAULT NOW()` in place, so omitting the
  // column on INSERT still stamps it and the code fix stays a no-op — the
  // precise half-fix that made the original defect invisible.
  const sql = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260731130000_audit_repos_last_audited_at_nullable.sql'),
    'utf-8',
  );
  assert.match(sql, /ALTER COLUMN last_audited_at DROP NOT NULL/);
  assert.match(sql, /ALTER COLUMN last_audited_at DROP DEFAULT/);
});

test('the committed schema fixture records the column as nullable + defaultless', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/expected-schema.json'), 'utf-8'));
  const col = schema.tables
    .find((t) => t.table_name === 'audit_repos')?.columns
    .find((c) => c.column_name === 'last_audited_at');
  assert.ok(col, 'audit_repos.last_audited_at present in the expected-schema fixture');
  assert.equal(col.is_nullable, 'YES', 'NULL must be expressible — it is how "never audited" is stored');
  assert.equal(col.column_default, null, 'a DEFAULT would re-stamp every omitted insert');
});

// ── Lane 2: real column values (DB-gated) ──────────────────────────────────

const TEST_DSN = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_DSN ? false : 'set AUDIT_DB_TEST_URL (a disposable test DB) to run';

// Point the db client at the TEST DSN before it is imported. Never the live store.
if (TEST_DSN) process.env.AUDIT_DB_URL = TEST_DSN;

test('a profile-less resolveRepoForStore leaves last_audited_at NULL', { skip }, async () => {
  const { withTx, one } = await import('../scripts/lib/db/query.mjs');
  const { resolveRepoForStore } = await import('../scripts/lib/store/repo.mjs');
  const { closePool } = await import('../scripts/lib/db/client.mjs');

  let captured;
  try {
    await assert.rejects(
      withTx(async () => {
        // First touch of this repo is a pure id lookup (no profile) — the
        // auto-vivify path. It must NOT claim the repo was audited.
        const readOnly = await resolveRepoForStore({});
        const afterRead = await one(
          `SELECT last_audited_at FROM audit_repos WHERE id = $1`, [readOnly.repoRowId],
        );
        // A real audit afterwards must stamp it.
        await resolveRepoForStore({
          profile: { repoFingerprint: 'fp-STAMP', stack: {}, fileBreakdown: {}, focusAreas: [] },
        });
        const afterAudit = await one(
          `SELECT last_audited_at FROM audit_repos WHERE id = $1`, [readOnly.repoRowId],
        );
        captured = { readOnly, afterRead, afterAudit };
        throw new Error('ROLLBACK_SENTINEL'); // never persist
      }),
      /ROLLBACK_SENTINEL/,
    );

    assert.ok(captured.readOnly?.repoRowId, 'the profile-less call still resolves a row id');
    assert.equal(
      captured.afterRead.last_audited_at, null,
      'a read-only lookup that vivified the row must leave last_audited_at NULL — ' +
      'a non-null value means the DEFAULT NOW() is still in place or a second writer stamped it',
    );
    assert.notEqual(
      captured.afterAudit.last_audited_at, null,
      'a profile-bearing call (a real audit) must stamp last_audited_at',
    );
  } finally {
    await closePool().catch(() => {});
  }
});

test('upsertRepoByUuid never stamps last_audited_at', { skip }, async () => {
  const { withTx, one } = await import('../scripts/lib/db/query.mjs');
  const { upsertRepoByUuid } = await import('../scripts/lib/store/repo.mjs');
  const { closePool } = await import('../scripts/lib/db/client.mjs');

  const repoUuid = crypto.randomUUID();
  let captured;
  try {
    await assert.rejects(
      withTx(async () => {
        // arch:refresh / security:refresh / azure-doctor path — registers a
        // repo row, runs no audit.
        const repo = await upsertRepoByUuid({ repoUuid, name: 'last-audited-at-test-repo', fingerprint: null });
        captured = await one(`SELECT last_audited_at FROM audit_repos WHERE id = $1`, [repo.id]);
        throw new Error('ROLLBACK_SENTINEL');
      }),
      /ROLLBACK_SENTINEL/,
    );
    assert.equal(
      captured.last_audited_at, null,
      'registering a repo for the symbol index is not an audit — it must not stamp last_audited_at',
    );
  } finally {
    await closePool().catch(() => {});
  }
});
