/**
 * @fileoverview DB-integration test for the stable repo-identity write path
 * (signal-recovery Cluster A, Phase 1). Proves fingerprint-invariance — the
 * core B1 fix — and the anti-fragmentation guardrail.
 *
 * GATED on a DEDICATED `AUDIT_DB_TEST_URL` (never the live store, R2-M1).
 * Skipped when unset, so local `npm test` stays green without a DB; the gated
 * DB CI lane (`npm run test:db`) sets it. All writes run inside `withTx` and
 * are rolled back via a sentinel throw — nothing persists even on the test DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const TEST_DSN = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_DSN ? false : 'set AUDIT_DB_TEST_URL (a disposable test DB) to run';

// Point the db client at the TEST DSN before it is imported. Never the live store.
if (TEST_DSN) process.env.AUDIT_DB_URL = TEST_DSN;

test('resolveRepoForStore returns a STABLE repoRowId across differing fingerprints', { skip }, async () => {
  const { withTx } = await import('../scripts/lib/db/query.mjs');
  const { resolveRepoForStore } = await import('../scripts/lib/store/repo.mjs');
  const { closePool } = await import('../scripts/lib/db/client.mjs');

  let captured;
  try {
    await assert.rejects(
      withTx(async () => {
        // Two audits of the same repo with DIFFERENT content fingerprints
        // (files changed between runs). The OLD fingerprint-keyed path minted a
        // new row each time (B1); the uuid-keyed path must return the same id.
        const r1 = await resolveRepoForStore({ profile: { repoFingerprint: 'fp-AAAA', stack: { node: true }, fileBreakdown: { backend: 1 }, focusAreas: [] } });
        const r2 = await resolveRepoForStore({ profile: { repoFingerprint: 'fp-BBBB', stack: { node: true }, fileBreakdown: { backend: 2 }, focusAreas: [] } });
        captured = { r1, r2 };
        throw new Error('ROLLBACK_SENTINEL'); // never persist
      }),
      /ROLLBACK_SENTINEL/,
    );

    assert.ok(captured.r1 && captured.r2, 'both resolutions returned a ref');
    assert.equal(typeof captured.r1.repoRowId, 'string');
    assert.equal(
      captured.r1.repoRowId, captured.r2.repoRowId,
      'same repo (uuid) must resolve to the same audit_repos.id despite a changed fingerprint',
    );
    assert.equal(captured.r1.repoUuid, captured.r2.repoUuid, 'repo_uuid is stable');
  } finally {
    await closePool().catch(() => {});
  }
});

test('fragmentation guardrail: no name resolves to >1 canonical audit_repos.id', { skip }, async () => {
  const { many } = await import('../scripts/lib/db/query.mjs');
  const { closePool } = await import('../scripts/lib/db/client.mjs');
  try {
    const dupes = await many(
      `SELECT name, count(DISTINCT id) AS ids
         FROM audit_repos
        WHERE repo_uuid IS NOT NULL
        GROUP BY name
       HAVING count(DISTINCT id) > 1`,
    );
    assert.deepEqual(dupes, [], `a logical repo fragmented into >1 canonical row: ${JSON.stringify(dupes)}`);
  } finally {
    await closePool().catch(() => {});
  }
});
