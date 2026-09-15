/**
 * @fileoverview docs/plans/debt-ledger-persisted-record-contract.md §2 Fix C
 * — DB integration for the real `ivfflat` cosine query. The mocked-pool unit
 * tests in tests/debt-alias.test.mjs prove the decision logic; only a live
 * Postgres can prove the query actually ranks correctly, scopes by repo, and
 * round-trips a real `VECTOR(768)` value — the column's fixed dimension,
 * which pgvector enforces server-side (a shorter literal is a hard error,
 * not silently accepted).
 *
 * INC-002 (docs/security-strategy.md — the 2026-07-14 production wipe):
 * gated on `assertDisposableDbUrl`, never on "is AUDIT_DB_TEST_URL set".
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

const SPACE = { provenanceId: 'test-model', dim: 768 };

/** A 768-dim vector with the given values in its first 3 components. */
function vec(a = 0, b = 0, c = 0) {
  return [a, b, c, ...new Array(765).fill(0)];
}

describe('debt-alias.mjs — real Postgres cosine query (DB integration)', { skip }, () => {
  let q, getPool, findNearDuplicateDebtTopic, populateContentAliases, upsertDebtEntries, debtAliasInternals, repoIdA, repoIdB;

  function makeDebtRow(topicId, overrides = {}) {
    return {
      source: 'debt',
      topicId,
      semanticHash: 'hash01',
      severity: 'HIGH',
      category: 'test',
      section: 'src/x.js:1',
      detailSnapshot: 'a debt entry seeded by the debt-alias integration suite',
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

  /**
   * `findNearDuplicateDebtTopic` JOINs `debt_entries` (round-1 GPT audit
   * H4/H7 — "nearest OPEN debt topic" is a claim about the authoritative
   * table, not just the embedding cache), so any topic this suite expects to
   * be FOUND must have a real `debt_entries` row, not only an embedding.
   */
  async function seedDebtTopic(repoId, topicId, vector) {
    await upsertDebtEntries(repoId, [makeDebtRow(topicId)]);
    const { toVectorLiteral } = await import('../scripts/lib/semantic-suppression.mjs');
    const pool = await getPool();
    await pool.query(
      `INSERT INTO debt_embeddings (repo_id, topic_id, embedding, embedding_model, dimension, snapshot_hash)
       VALUES ($1, $2, $3::vector, $4, $5, 'seed')
       ON CONFLICT (repo_id, topic_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [repoId, topicId, toVectorLiteral(vector), SPACE.provenanceId, SPACE.dim],
    );
  }

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    const savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    ({ getPool } = await import('../scripts/lib/db/client.mjs'));
    ({ findNearDuplicateDebtTopic, populateContentAliases, _internals: debtAliasInternals } = await import('../scripts/lib/debt-alias.mjs'));
    ({ upsertDebtEntries } = await import('../scripts/lib/store/debt.mjs'));

    repoIdA = crypto.randomUUID();
    repoIdB = crypto.randomUUID();
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [repoIdA, `a-${repoIdA.slice(0, 8)}`]);
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [repoIdB, `b-${repoIdB.slice(0, 8)}`]);
  });

  // Each test seeds its own rows; without this, an earlier test's row can
  // tie or win a later test's nearest-neighbour ranking (found live: two
  // identical vec(1,0,0) rows from different tests made the ranking depend
  // on Postgres's arbitrary tie-break order rather than the test's own setup).
  beforeEach(async () => {
    if (!q) return;
    await q.query('DELETE FROM debt_embeddings WHERE repo_id = ANY($1)', [[repoIdA, repoIdB]]);
    await q.query('DELETE FROM debt_entries WHERE repo_id = ANY($1)', [[repoIdA, repoIdB]]);
  });

  after(async () => {
    if (!q) return;
    // Gemini gate round 2 — a rejected DELETE must not skip closePool() and
    // leak the connection into the next test file (same defect class already
    // fixed in tests/store-debt-cloud-validation.test.mjs's after() hook).
    try {
      await q.query('DELETE FROM debt_embeddings WHERE repo_id = ANY($1)', [[repoIdA, repoIdB]]);
      await q.query('DELETE FROM debt_entries WHERE repo_id = ANY($1)', [[repoIdA, repoIdB]]);
      await q.query('DELETE FROM audit_repos WHERE id = ANY($1)', [[repoIdA, repoIdB]]);
    } finally {
      const { closePool } = await import('../scripts/lib/db/client.mjs');
      await closePool();
    }
  });

  test('finds a near-identical seeded vector above threshold', async () => {
    const pool = await getPool();
    await seedDebtTopic(repoIdA, 'topic-close', vec(1, 0, 0));
    const r = await findNearDuplicateDebtTopic(pool, {
      repoId: repoIdA, embedding: vec(0.99, 0.01, 0), embeddingSpace: SPACE, threshold: 0.9,
    });
    assert.ok(r, 'a near-identical seeded vector must rank above threshold');
    assert.equal(r.topicId, 'topic-close');
  });

  test('a genuinely dissimilar seeded vector does not match — negative control', async () => {
    const pool = await getPool();
    await seedDebtTopic(repoIdA, 'topic-close', vec(1, 0, 0));
    await seedDebtTopic(repoIdA, 'topic-far', vec(0, 0, 1));
    const r = await findNearDuplicateDebtTopic(pool, {
      repoId: repoIdA, embedding: vec(1, 0, 0), embeddingSpace: SPACE, threshold: 0.9,
    });
    assert.equal(r?.topicId, 'topic-close', 'must still find the CLOSE one, never the far one');
    assert.notEqual(r?.topicId, 'topic-far');
  });

  test('never matches across repos — the same vector seeded in a DIFFERENT repo is invisible', async () => {
    const pool = await getPool();
    await seedDebtTopic(repoIdA, 'topic-close', vec(1, 0, 0));
    await seedDebtTopic(repoIdB, 'topic-other-repo', vec(1, 0, 0));
    const r = await findNearDuplicateDebtTopic(pool, {
      repoId: repoIdB, embedding: vec(1, 0, 0), embeddingSpace: SPACE, threshold: 0.9, excludeTopicId: 'topic-other-repo',
    });
    // Excluding its own topicId, and repoIdA's seeded rows must not leak in.
    assert.equal(r, null);
  });

  test('excludes the candidate\'s own topicId from its own repo\'s results', async () => {
    const pool = await getPool();
    await seedDebtTopic(repoIdA, 'topic-close', vec(1, 0, 0));
    const r = await findNearDuplicateDebtTopic(pool, {
      repoId: repoIdA, embedding: vec(1, 0, 0), embeddingSpace: SPACE, threshold: 0.9, excludeTopicId: 'topic-close',
    });
    assert.notEqual(r?.topicId, 'topic-close');
  });

  test('never matches a superseded topic (round-3 GPT audit M2)', async () => {
    const pool = await getPool();
    await seedDebtTopic(repoIdA, 'topic-close', vec(1, 0, 0));
    const { markSupersededCloud } = await import('../scripts/lib/store/debt.mjs');
    await seedDebtTopic(repoIdA, 'topic-new', vec(0, 1, 0)); // needs its own debt_entries row to be a valid supersession target
    const linked = await markSupersededCloud(repoIdA, 'topic-close', 'topic-new');
    assert.equal(linked.ok, true, linked.error);

    const r = await findNearDuplicateDebtTopic(pool, {
      repoId: repoIdA, embedding: vec(1, 0, 0), embeddingSpace: SPACE, threshold: 0.9,
    });
    assert.notEqual(r?.topicId, 'topic-close', 'a superseded topic must never be offered as an alias target');
  });

  test('a re-captured batch-mate already superseded in the DB is never offered as an in-batch alias target, even with no supersededBy in its own DTO (round-5 GPT audit H1)', async () => {
    const pool = await getPool();
    const { markSupersededCloud } = await import('../scripts/lib/store/debt.mjs');
    // 'old1' exists and is ALREADY superseded by 'new1' — a real persisted
    // debt_entries.superseded_by, set by a PRIOR write, not by this batch.
    await seedDebtTopic(repoIdA, 'old1', vec(1, 0, 0));
    await seedDebtTopic(repoIdA, 'new1', vec(0, 1, 0));
    const linked = await markSupersededCloud(repoIdA, 'old1', 'new1');
    assert.equal(linked.ok, true, linked.error);

    // Re-capture 'old1' in the SAME batch as a textually-similar new entry.
    // Neither DTO below carries `supersededBy` — that state lives only in
    // the debt_entries row this batch's DTOs know nothing about.
    const embed = async () => vec(1, 0, 0); // both entries embed identically
    const entries = [
      {
        topicId: 'old1', category: 'god-module', section: 'src/x.js:1',
        detailSnapshot: 'the exact same defect described one way in enough detail',
        contentAliases: [],
      },
      {
        topicId: 'entry2', category: 'god-module', section: 'src/x.js:1',
        detailSnapshot: 'the exact same defect described one way in enough detail',
        contentAliases: [],
      },
    ];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: repoIdA, pool, embed, embeddingSpace: SPACE, threshold: 0.9,
    });
    const old1Result = result.find(e => e.topicId === 'old1');
    const entry2Result = result.find(e => e.topicId === 'entry2');
    assert.deepEqual(entry2Result.contentAliases, [], 'must not alias to a batch-mate the DB already retired as superseded');
    assert.deepEqual(old1Result.contentAliases, []);
  });

  test('a cache hit against a REAL debt_embeddings row deserializes the pgvector text literal correctly (Gemini gate G1)', async () => {
    const pool = await getPool();
    // `pg` has no built-in type parser for the custom `vector` extension
    // type, so this row's `embedding` column comes back from a real SELECT
    // as the text literal "[1,0,0,...]", not a number[] — the exact shape
    // every mocked-pool unit test cannot reproduce. Seed it with the SAME
    // hash `processEntry` will independently compute, so its cache lookup
    // actually HITS this row rather than falling through to `embed()`.
    const entry = {
      topicId: 'cache-hit', category: 'god-module', section: 'src/x.js:1',
      detailSnapshot: 'a sufficiently long detail snapshot for the cache-hit integration test',
      contentAliases: [],
    };
    const snapshotHash = debtAliasInternals.sha256(debtAliasInternals.buildEmbedText(entry));
    const { toVectorLiteral } = await import('../scripts/lib/semantic-suppression.mjs');
    await pool.query(
      `INSERT INTO debt_embeddings (repo_id, topic_id, embedding, embedding_model, dimension, snapshot_hash)
       VALUES ($1, $2, $3::vector, $4, $5, $6)
       ON CONFLICT (repo_id, topic_id) DO UPDATE SET embedding = EXCLUDED.embedding, snapshot_hash = EXCLUDED.snapshot_hash`,
      [repoIdA, entry.topicId, toVectorLiteral(vec(1, 0, 0)), SPACE.provenanceId, SPACE.dim, snapshotHash],
    );
    // A second, textually-different entry (its own cache miss, so it still
    // calls embed()) should in-batch-match the cached one — that match only
    // works if the CACHED embedding was PARSED into a real number[] before
    // reaching cosineSimilarity.
    let embedCallCount = 0;
    const embed = async () => { embedCallCount++; return vec(1, 0, 0); };
    const { entries: result } = await populateContentAliases([
      entry,
      { topicId: 'new-tp', category: 'god-module', section: 'src/x.js:1',
        detailSnapshot: 'a textually different but similar-enough detail for matching', contentAliases: [] },
    ], { repoId: repoIdA, pool, embed, embeddingSpace: SPACE, threshold: 0.9 });
    assert.equal(embedCallCount, 1, 'the cache hit must be reused (no embed call) — only the OTHER, uncached entry calls embed()');
    const cacheHitEntry = result.find(e => e.topicId === 'cache-hit');
    const newEntry = result.find(e => e.topicId === 'new-tp');
    assert.deepEqual(cacheHitEntry.contentAliases, ['new-tp']);
    assert.deepEqual(newEntry.contentAliases, ['cache-hit']);
  });

  test('populateContentAliases end to end against real Postgres, fake embed provider', async () => {
    const pool = await getPool();
    await seedDebtTopic(repoIdA, 'existing-tp', vec(1, 0, 0));
    // A deterministic fake embed — this test proves the SQL/scoping path,
    // not a real embedding provider (no live API key needed).
    const embed = async () => vec(0.99, 0.01, 0);
    const entries = [{
      topicId: 'new-topic-live',
      category: 'god-module',
      section: 'src/x.js:1',
      detailSnapshot: 'a sufficiently long detail snapshot for the live integration test',
      contentAliases: [],
    }];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: repoIdA, pool, embed, embeddingSpace: SPACE, threshold: 0.9,
    });
    assert.deepEqual(result[0].contentAliases, ['existing-tp']);
  });
});
