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

test('upsertRepo — the frozen compat shim IGNORES its repoName argument (audit finding 32754705)', { skip }, async () => {
  // `upsertRepo(profile, repoName)` is a @deprecated legacy shim that delegates
  // to `resolveRepoForStoreResult({ profile })` — repoName never reaches it.
  // That is deliberate (identity derives from repo_uuid/profile, not from a
  // caller-supplied name, to stop the fingerprint-fragmentation class this
  // whole cluster fixed) but it must actually hold: two calls differing ONLY
  // in repoName, for the same repo, must resolve to the identical row.
  const { withTx } = await import('../scripts/lib/db/query.mjs');
  const { upsertRepo } = await import('../scripts/lib/store/repo.mjs');
  const { closePool } = await import('../scripts/lib/db/client.mjs');

  const profile = { repoFingerprint: 'fp-repoName-shim', stack: { node: true }, fileBreakdown: { backend: 1 }, focusAreas: [] };
  let captured;
  try {
    await assert.rejects(
      withTx(async () => {
        const idA = await upsertRepo(profile, 'wrong-name-A');
        const idB = await upsertRepo(profile, 'totally-different-name-B');
        captured = { idA, idB };
        throw new Error('ROLLBACK_SENTINEL'); // never persist
      }),
      /ROLLBACK_SENTINEL/,
    );

    assert.ok(captured.idA, 'first call must resolve a row id');
    assert.equal(
      captured.idA, captured.idB,
      'a differing repoName argument must not change which audit_repos row is resolved — '
      + 'if this fails, the compat shim started honouring repoName again, which reopens the '
      + 'fingerprint/name fragmentation class this cluster fixed',
    );
  } finally {
    await closePool().catch(() => {});
  }
});
