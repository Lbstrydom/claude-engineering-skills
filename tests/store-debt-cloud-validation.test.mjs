/**
 * @fileoverview docs/plans/debt-ledger-persisted-record-contract.md §2 Fix B
 * + Fix C (embedding persistence) + Fix D (markSupersededCloud) — DB
 * integration. `upsertDebtEntries` now validates against
 * `PersistedDebtEntrySchema` before reaching SQL (closing the gap where
 * Postgres's per-column CHECK constraints were the only backstop, and can't
 * see cross-field envelope invariants like the deferredRationale max-4000
 * cap or the classification-or-reason disjunction). A mock cannot prove the
 * real column mapping/round-trip; this suite runs against a live Postgres.
 *
 * INC-002 (docs/security-strategy.md — the 2026-07-14 production wipe):
 * gated on `assertDisposableDbUrl`, never on "is AUDIT_DB_TEST_URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

/** A 768-dim vector (debt_embeddings.embedding's fixed column dimension) with the given values in its first 3 components. */
function vec(a = 0, b = 0, c = 0) {
  return [a, b, c, ...new Array(765).fill(0)];
}

describe('store/debt.mjs — cloud validation + embedding + supersession (DB integration)', { skip }, () => {
  let q, debt, durableWrite, registerAuditStoreWriters, findNearDuplicateDebtTopic, getPool, repoId;

  function makeRow(overrides = {}) {
    return {
      source: 'debt',
      topicId: `topic-${crypto.randomUUID().slice(0, 8)}`,
      semanticHash: 'hash01',
      severity: 'HIGH',
      category: 'test',
      section: 'src/x.js:1',
      detailSnapshot: 'a debt entry seeded by the DB-integration suite',
      affectedFiles: ['src/x.js'],
      affectedPrinciples: [],
      pass: 'backend',
      classificationUnavailableReason: 'not-provided-by-capture-source',
      deferredReason: 'out-of-scope',
      deferredAt: new Date().toISOString(),
      deferredRun: 'db-test',
      deferredRationale: 'a sufficiently long rationale for the schema minimum',
      contentAliases: [],
      sensitive: false,
      ...overrides,
    };
  }

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    const savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    debt = await import('../scripts/lib/store/debt.mjs');
    ({ durableWrite } = await import('../scripts/lib/durable-write.mjs'));
    ({ registerAuditStoreWriters } = await import('../scripts/lib/audit-store-writers.mjs'));
    registerAuditStoreWriters();
    ({ findNearDuplicateDebtTopic } = await import('../scripts/lib/debt-alias.mjs'));
    ({ getPool } = await import('../scripts/lib/db/client.mjs'));

    repoId = crypto.randomUUID();
    await q.query(
      `INSERT INTO audit_repos (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [repoId, `test-${repoId.slice(0, 8)}`],
    );
  });

  after(async () => {
    if (!q) return;
    // round-1 GPT audit M13 — a rejected DELETE (e.g. a leftover FK reference
    // from a failed test) must not skip closePool() and leak the connection
    // into the next test file.
    try {
      await q.query('DELETE FROM debt_embeddings WHERE repo_id = $1', [repoId]);
      await q.query('DELETE FROM debt_entries WHERE repo_id = $1', [repoId]);
      await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    } finally {
      const { closePool } = await import('../scripts/lib/db/client.mjs');
      await closePool();
    }
  });

  test('a valid entry upserts cleanly — appliedCount 1, rejected empty', async () => {
    const row = makeRow();
    const r = await debt.upsertDebtEntries(repoId, [row]);
    assert.equal(r.ok, true, r.error?.message);
    assert.equal(r.appliedCount, 1);
    assert.deepEqual(r.rejected, []);
  });

  test('a schema-invalid entry among valid ones is excluded and named in rejected[] — Postgres CHECK alone would not catch this', async () => {
    const valid = makeRow();
    const invalid = makeRow({ deferredRationale: 'x'.repeat(5000) }); // > Zod's 4000 max; no DB-side max exists
    const r = await debt.upsertDebtEntries(repoId, [valid, invalid]);
    assert.equal(r.ok, true);
    assert.equal(r.appliedCount, 1);
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].topicId, invalid.topicId);

    const cloudEntries = await debt.readDebtEntriesCloud(repoId);
    assert.ok(cloudEntries.find(e => e.topicId === valid.topicId));
    assert.equal(cloudEntries.find(e => e.topicId === invalid.topicId), undefined);
  });

  test('an all-rejected batch never throws and writes nothing — round-1 GPT audit H3', async () => {
    const invalid = makeRow({ deferredRationale: 'x'.repeat(5000) });
    const r = await debt.upsertDebtEntries(repoId, [invalid]);
    assert.equal(r.ok, true);
    assert.equal(r.appliedCount, 0);
    assert.equal(r.rejected.length, 1);
  });

  test('durableWrite: an all-rejected batch reports outcome "skipped", never spilled for retry — Gemini gate round-1 G1', async () => {
    const invalid = makeRow({ deferredRationale: 'x'.repeat(5000) });
    const r = await durableWrite('debt.entries', { repoId, entries: [invalid] });
    assert.equal(r.outcome, 'skipped');
  });

  test('durableWrite: a partial batch reports outcome "written"', async () => {
    const valid = makeRow();
    const invalid = makeRow({ deferredRationale: 'x'.repeat(5000) });
    const r = await durableWrite('debt.entries', { repoId, entries: [valid, invalid] });
    assert.equal(r.outcome, 'written');
  });

  test('classificationUnavailableReason/reviewDeadline/supersededBy round-trip through the cloud store', async () => {
    const seedTopic = makeRow().topicId;
    await debt.upsertDebtEntries(repoId, [makeRow({ topicId: seedTopic })]);
    const row = makeRow({
      classification: undefined,
      classificationUnavailableReason: 'legacy-backfill',
      reviewDeadline: '2027-01-01T00:00:00.000Z',
      supersededBy: seedTopic,
    });
    await debt.upsertDebtEntries(repoId, [row]);
    const cloudEntries = await debt.readDebtEntriesCloud(repoId);
    const found = cloudEntries.find(e => e.topicId === row.topicId);
    assert.equal(found.classificationUnavailableReason, 'legacy-backfill');
    // Postgres returns its own native timestamptz text representation here
    // (same as the pre-existing deferredAt/approvedAt columns), not the ISO
    // string that was written — compare by parsed instant, not by string.
    assert.equal(new Date(found.reviewDeadline).getTime(), new Date(row.reviewDeadline).getTime());
    assert.equal(found.supersededBy, seedTopic);
  });

  test('a re-upsert of the entry NEVER overwrites supersededBy set by markSupersededCloud (round-1 GPT audit H6)', async () => {
    const oldTopic = makeRow().topicId;
    const newTopic = makeRow().topicId;
    await debt.upsertDebtEntries(repoId, [makeRow({ topicId: oldTopic }), makeRow({ topicId: newTopic })]);
    const linked = await debt.markSupersededCloud(repoId, oldTopic, newTopic);
    assert.equal(linked.ok, true, linked.error);

    // Re-upsert the OLD topic again (e.g. a recapture) — its fresh snapshot
    // carries no supersededBy at all. Before the fix, `update: 'all'` would
    // have overwritten the link back to NULL.
    await debt.upsertDebtEntries(repoId, [makeRow({ topicId: oldTopic })]);

    const cloudEntries = await debt.readDebtEntriesCloud(repoId);
    const found = cloudEntries.find(e => e.topicId === oldTopic);
    assert.equal(found.supersededBy, newTopic, 'a re-upsert must never erase an independently-set supersession link');
  });

  test('a malformed embeddingsByTopicId does not fail a write that already succeeded (round-4 GPT audit M2)', async () => {
    const row = makeRow();
    // `null` is not a valid embeddingsByTopicId, but the entries upsert
    // above it must not be undone by a crash while preparing embeddings.
    const r = await debt.upsertDebtEntries(repoId, [row], { embeddingsByTopicId: null, embeddingSpace: { provenanceId: 'x', dim: 768 } });
    assert.equal(r.ok, true, r.error?.message);
    assert.equal(r.appliedCount, 1);
    const cloudEntries = await debt.readDebtEntriesCloud(repoId);
    assert.ok(cloudEntries.find(e => e.topicId === row.topicId), 'the entry write must have landed despite the malformed embeddings argument');
  });

  test('upsertDebtEntries persists a supplied embedding into debt_embeddings as a fail-open side effect', async () => {
    const row = makeRow();
    const embeddingSpace = { provenanceId: 'test-model', dim: 768 };
    await debt.upsertDebtEntries(repoId, [row], {
      embeddingsByTopicId: { [row.topicId]: vec(1, 0, 0) }, embeddingSpace,
    });
    const pool = await getPool();
    const found = await findNearDuplicateDebtTopic(pool, {
      repoId, embedding: vec(1, 0, 0), embeddingSpace, threshold: 0.5, excludeTopicId: 'nonexistent',
    });
    assert.ok(found, 'the persisted embedding must be queryable via the same cosine search debt-alias.mjs uses');
    assert.equal(found.topicId, row.topicId);
  });

  test('removeDebtEntryCloud also deletes the matching debt_embeddings row (§2 Fix C orphan cleanup, Gemini gate round-1 G2)', async () => {
    const row = makeRow();
    const embeddingSpace = { provenanceId: 'test-model', dim: 768 };
    await debt.upsertDebtEntries(repoId, [row], {
      embeddingsByTopicId: { [row.topicId]: vec(1, 0, 0) }, embeddingSpace,
    });
    const before_ = await q.query('SELECT 1 FROM debt_embeddings WHERE repo_id = $1 AND topic_id = $2', [repoId, row.topicId]);
    assert.equal(before_.rows.length, 1);

    await debt.removeDebtEntryCloud(repoId, row.topicId);
    const after_ = await q.query('SELECT 1 FROM debt_embeddings WHERE repo_id = $1 AND topic_id = $2', [repoId, row.topicId]);
    assert.equal(after_.rows.length, 0);
  });

  describe('markSupersededCloud', () => {
    test('links two existing entries', async () => {
      const oldTopic = makeRow().topicId;
      const newTopic = makeRow().topicId;
      await debt.upsertDebtEntries(repoId, [makeRow({ topicId: oldTopic }), makeRow({ topicId: newTopic })]);
      const r = await debt.markSupersededCloud(repoId, oldTopic, newTopic);
      assert.equal(r.ok, true, r.error);
      const cloudEntries = await debt.readDebtEntriesCloud(repoId);
      assert.equal(cloudEntries.find(e => e.topicId === oldTopic).supersededBy, newTopic);
    });

    test('refuses when the old topicId does not exist — round-3 GPT audit H7', async () => {
      const newTopic = makeRow().topicId;
      await debt.upsertDebtEntries(repoId, [makeRow({ topicId: newTopic })]);
      const r = await debt.markSupersededCloud(repoId, 'never-existed', newTopic);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'old-topic-not-found');
    });

    test('refuses when the new topicId is schema-valid but not yet queryable here (round-3 GPT audit H7)', async () => {
      const oldTopic = makeRow().topicId;
      await debt.upsertDebtEntries(repoId, [makeRow({ topicId: oldTopic })]);
      const r = await debt.markSupersededCloud(repoId, oldTopic, 'never-actually-upserted');
      assert.equal(r.ok, false);
      assert.equal(r.error, 'new-topic-not-found');
    });

    test('refuses self-reference', async () => {
      const oldTopic = makeRow().topicId;
      await debt.upsertDebtEntries(repoId, [makeRow({ topicId: oldTopic })]);
      const r = await debt.markSupersededCloud(repoId, oldTopic, oldTopic);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'self-reference');
    });
  });
});
