/**
 * @fileoverview docs/plans/debt-ledger-persisted-record-contract.md §2 Fix C.
 * Unit tests for `findNearDuplicateDebtTopic`/`populateContentAliases` —
 * mocked pool, no live Postgres (see tests/debt-alias-integration.test.mjs
 * for the real-Postgres cosine-query proof).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { findNearDuplicateDebtTopic, populateContentAliases } from '../scripts/lib/debt-alias.mjs';

const SPACE = { provenanceId: 'gemini-embedding-001', dim: 3 };

/** Pool whose `.query` returns canned row-sets in call order. */
function queueMockPool(responses) {
  const queue = [...responses];
  return { query: async () => ({ rows: queue.length ? queue.shift() : [] }) };
}

function makeEntry(overrides = {}) {
  return {
    topicId: 't1',
    category: 'god-module',
    section: 'src/x.js:1',
    detailSnapshot: 'a sufficiently long detail snapshot describing the defect in question',
    contentAliases: [],
    ...overrides,
  };
}

const echoEmbed = async () => [1, 0, 0];

describe('findNearDuplicateDebtTopic', () => {
  test('returns the match when above threshold', async () => {
    const pool = queueMockPool([[{ topic_id: 'other', cosine: 0.97 }]]);
    const r = await findNearDuplicateDebtTopic(pool, {
      repoId: 'r1', embedding: [1, 0, 0], embeddingSpace: SPACE, threshold: 0.92,
    });
    assert.deepEqual(r, { topicId: 'other', cosine: 0.97 });
  });

  test('returns null below threshold', async () => {
    const pool = queueMockPool([[{ topic_id: 'other', cosine: 0.5 }]]);
    const r = await findNearDuplicateDebtTopic(pool, {
      repoId: 'r1', embedding: [1, 0, 0], embeddingSpace: SPACE, threshold: 0.92,
    });
    assert.equal(r, null);
  });

  test('returns null with no repoId or empty embedding', async () => {
    const pool = queueMockPool([[{ topic_id: 'other', cosine: 0.99 }]]);
    assert.equal(await findNearDuplicateDebtTopic(pool, { embedding: [1, 0, 0], embeddingSpace: SPACE, threshold: 0.5 }), null);
    assert.equal(await findNearDuplicateDebtTopic(pool, { repoId: 'r1', embedding: [], embeddingSpace: SPACE, threshold: 0.5 }), null);
  });
});

describe('populateContentAliases — fail-open paths', () => {
  test('no pool, no repoId, or no embed function leaves entries unchanged', async () => {
    const entries = [makeEntry()];
    const a = await populateContentAliases(entries, {});
    assert.deepEqual(a.entries, entries);
    assert.deepEqual(a.embeddingsByTopicId, {});
  });

  test('a query error on one entry is fail-open — that entry is left unchanged, no throw', async () => {
    const pool = { query: async () => { throw new Error('db down'); } };
    const entries = [makeEntry()];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE,
    });
    assert.deepEqual(result[0].contentAliases, []);
  });

  test('below-30-char text is skipped — never embedded or queried', async () => {
    let embedCalled = false;
    const embed = async () => { embedCalled = true; return [1, 0, 0]; };
    const pool = queueMockPool([]);
    const entries = [makeEntry({ category: '', section: '', detailSnapshot: 'short' })];
    await populateContentAliases(entries, { repoId: 'r1', pool, embed, embeddingSpace: SPACE });
    assert.equal(embedCalled, false);
  });

  test('a raw secret-shaped string is redacted before ever reaching embed() (H2)', async () => {
    let seenText = null;
    const embed = async (text) => { seenText = text; return [1, 0, 0]; };
    // No cache hit, no DB match — two queries: cache-check, nearest-neighbour.
    const pool = queueMockPool([[], []]);
    const entries = [makeEntry({
      detailSnapshot: 'AKIAABCDEFGHIJKLMNOP is embedded in this long enough detail snapshot text',
    })];
    await populateContentAliases(entries, { repoId: 'r1', pool, embed, embeddingSpace: SPACE });
    assert.ok(seenText, 'embed() must have been called');
    assert.doesNotMatch(seenText, /AKIA[A-Z0-9]{16}/, 'a raw AWS-shaped key must never reach embed()');
  });

  test('above-threshold DB match aliases the new entry to the existing topic', async () => {
    // cache-check (miss) then nearest-neighbour (hit)
    const pool = queueMockPool([[], [{ topic_id: 'existing-tp', cosine: 0.95 }]]);
    const entries = [makeEntry()];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92,
    });
    assert.deepEqual(result[0].contentAliases, ['existing-tp']);
  });

  test('a matched topicId longer than the 12-char contentAliases contract is skipped, not aliased (H3)', async () => {
    const pool = queueMockPool([[], [{ topic_id: 'this-topic-id-is-too-long', cosine: 0.95 }]]);
    const entries = [makeEntry()];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92,
    });
    assert.deepEqual(result[0].contentAliases, []);
  });

  test('the RECIPROCAL in-batch alias update is ALSO length-checked (round-2 GPT audit H2/H3, corrected per round-3 GPT audit M1/M3)', async () => {
    // The forward direction (aliasing THIS entry to the match) was already
    // guarded; the reciprocal direction (aliasing the OTHER entry back to
    // THIS one) appends entry.topicId, which carries no schema-level max
    // length of its own. To exercise ONLY the reciprocal guard (not have the
    // forward guard mask it), the SHORT topicId must be processed FIRST
    // (so it is the `matchTopicId` the long entry finds — short, so the
    // forward guard passes) and the LONG topicId SECOND (so it is
    // `entry.topicId` in applyOutcome — long, so only the reciprocal guard
    // can reject it). The round-2 draft of this test had the order reversed,
    // which let the forward guard alone account for the whole result.
    const pool = queueMockPool([[], [], [], []]);
    const longTopicId = 'this-topic-id-is-way-too-long-for-an-alias';
    const entries = [
      makeEntry({ topicId: 'short', detailSnapshot: 'the exact same defect described one way in enough detail' }),
      makeEntry({ topicId: longTopicId, detailSnapshot: 'the exact same defect described one way in enough detail' }),
    ];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92,
    });
    const short = result.find(e => e.topicId === 'short');
    const long = result.find(e => e.topicId === longTopicId);
    // Forward direction succeeds: the long entry aliases to the short match.
    assert.deepEqual(long.contentAliases, ['short']);
    // Reciprocal direction is rejected: 'short' must NOT receive the
    // over-length topicId as one of its own aliases.
    assert.deepEqual(short.contentAliases, []);
  });

  test('a processEntry call that loses the timeout race never mutates state after Promise.race resolves (round-2 GPT audit H1/M1)', async () => {
    // A "slow" embed() that resolves AFTER the timeout must not be able to
    // write into embeddingsByTopicId or the returned entries once
    // populateContentAliases has already moved on / returned.
    let slowEmbedResolve;
    const slowEmbed = () => new Promise((resolve) => { slowEmbedResolve = resolve; });
    const pool = queueMockPool([[], []]);
    const entries = [makeEntry({ topicId: 'a' })];
    const resultPromise = populateContentAliases(entries, {
      repoId: 'r1', pool, embed: slowEmbed, embeddingSpace: SPACE, deadlineMs: 20,
    });
    const { entries: result, embeddingsByTopicId } = await resultPromise;
    // The function must already have returned (deadline was 20ms) without
    // this entry's embedding — the slow embed() call is still pending.
    assert.equal(Object.keys(embeddingsByTopicId).length, 0);
    assert.deepEqual(result[0].contentAliases, []);
    // Resolving the slow embed() AFTER the fact must not retroactively
    // mutate anything this test already read.
    slowEmbedResolve([1, 0, 0]);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(Object.keys(embeddingsByTopicId).length, 0, 'a late resolution must never mutate the already-returned result');
  });

  test('below-threshold DB match does NOT alias — negative control', async () => {
    const pool = queueMockPool([[], [{ topic_id: 'existing-tp', cosine: 0.10 }]]);
    const entries = [makeEntry()];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92,
    });
    assert.deepEqual(result[0].contentAliases, []);
  });

  test('an intra-batch near-duplicate aliases BOTH entries to each other (Gemini gate round-1 G4)', async () => {
    // Neither entry has a cache hit or a DB match — only the in-batch check
    // (pure in-memory cosine) can find this pair.
    const pool = queueMockPool([[], [], [], []]); // cache-miss + db-miss, twice
    const entries = [
      makeEntry({ topicId: 'a', detailSnapshot: 'the exact same defect described one way in enough detail' }),
      makeEntry({ topicId: 'b', detailSnapshot: 'the exact same defect described one way in enough detail' }),
    ];
    // Both entries embed to an IDENTICAL vector via echoEmbed — cosine 1.0.
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92,
    });
    const a = result.find(e => e.topicId === 'a');
    const b = result.find(e => e.topicId === 'b');
    assert.deepEqual(a.contentAliases, ['b']);
    assert.deepEqual(b.contentAliases, ['a']);
  });

  test('a batch-mate already marked supersededBy is never offered as an in-batch alias target (round-4 GPT audit H1)', async () => {
    const pool = queueMockPool([[], [], [], []]);
    const entries = [
      makeEntry({ topicId: 'retired', supersededBy: 'somewhere-else', detailSnapshot: 'the exact same defect described one way in enough detail' }),
      makeEntry({ topicId: 'fresh', detailSnapshot: 'the exact same defect described one way in enough detail' }),
    ];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92,
    });
    const fresh = result.find(e => e.topicId === 'fresh');
    assert.deepEqual(fresh.contentAliases, [], 'must not alias to a batch-mate that is already superseded');
  });

  test('a batch-mate superseded by an EARLIER write is excluded even though its OWN DTO carries no supersededBy (round-5 GPT audit H1)', async () => {
    // 'old1' was superseded in a prior write; `upsertDebtEntries` deliberately
    // never overwrites `superseded_by` on re-upsert, so a re-captured DTO for
    // 'old1' in THIS batch carries no `supersededBy` field at all — only the
    // one leading persisted-lookup query (below) knows it is retired.
    const pool = queueMockPool([
      [{ topic_id: 'old1' }], // persisted-superseded lookup (batch-wide, once)
      [], [],                  // old1: cache-miss, db-miss
      [], [],                  // entry2: cache-miss, db-miss
    ]);
    const entries = [
      makeEntry({ topicId: 'old1', detailSnapshot: 'the exact same defect described one way in enough detail' }),
      makeEntry({ topicId: 'entry2', detailSnapshot: 'the exact same defect described one way in enough detail' }),
    ];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92,
    });
    const old1 = result.find(e => e.topicId === 'old1');
    const entry2 = result.find(e => e.topicId === 'entry2');
    assert.deepEqual(entry2.contentAliases, [], 'must not alias to a batch-mate persistence already retired as superseded');
    assert.deepEqual(old1.contentAliases, []);
  });

  test('a superseded entry (DTO-declared) processed AFTER a live batch-mate must not pollute the live entry with a reciprocal alias (Gemini gate G2)', async () => {
    // Every prior fix excluded a superseded CANDIDATE from being matched TO;
    // none excluded a superseded entry from being the match SOURCE. 'live'
    // is processed FIRST (enters embeddingsByTopicId while healthy), then
    // 'retired' (its own DTO carries supersededBy) is processed SECOND —
    // the in-batch loop for 'retired' would find 'live' as a candidate (not
    // itself superseded, so none of the candidate-side guards fire) and the
    // reciprocal update would append 'retired' to LIVE's own contentAliases.
    const pool = queueMockPool([[], [], [], []]);
    const entries = [
      makeEntry({ topicId: 'live', detailSnapshot: 'the exact same defect described one way in enough detail' }),
      makeEntry({ topicId: 'retired', supersededBy: 'somewhere-else', detailSnapshot: 'the exact same defect described one way in enough detail' }),
    ];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92,
    });
    const live = result.find(e => e.topicId === 'live');
    const retired = result.find(e => e.topicId === 'retired');
    assert.deepEqual(live.contentAliases, [], 'a live topic must never gain an alias to a superseded batch-mate');
    assert.deepEqual(retired.contentAliases, []);
  });

  test('a superseded entry (DB-persisted, no DTO field) processed AFTER a live batch-mate must not pollute it either (Gemini gate G2, persisted variant)', async () => {
    const pool = queueMockPool([
      [{ topic_id: 'retired' }], // persisted-superseded lookup
      [], [],                     // 'live': cache-miss, db-miss
                                   // 'retired' is skipped entirely — no queries
    ]);
    const entries = [
      makeEntry({ topicId: 'live', detailSnapshot: 'the exact same defect described one way in enough detail' }),
      makeEntry({ topicId: 'retired', detailSnapshot: 'the exact same defect described one way in enough detail' }),
    ];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92,
    });
    const live = result.find(e => e.topicId === 'live');
    const retired = result.find(e => e.topicId === 'retired');
    assert.deepEqual(live.contentAliases, [], 'a live topic must never gain an alias to a DB-persisted-superseded batch-mate');
    assert.deepEqual(retired.contentAliases, []);
  });

  test('a persisted-supersession preflight FAILURE disables in-batch matching entirely — never falls back to "assume nothing superseded" (round-6 GPT audit H2)', async () => {
    // The preflight query throws; two textually-identical entries would
    // otherwise match in-batch. If the failure degraded to an empty Set (the
    // round-5 behaviour this test guards against), they would still alias to
    // each other despite the check being UNAVAILABLE, not confirmed-clear.
    let call = 0;
    const pool = {
      query: async () => {
        call++;
        if (call === 1) throw new Error('db down for the preflight'); // persisted-lookup
        return { rows: [] }; // cache-miss / db-miss for both entries thereafter
      },
    };
    const entries = [
      makeEntry({ topicId: 'a', detailSnapshot: 'the exact same defect described one way in enough detail' }),
      makeEntry({ topicId: 'b', detailSnapshot: 'the exact same defect described one way in enough detail' }),
    ];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92,
    });
    const a = result.find(e => e.topicId === 'a');
    const b = result.find(e => e.topicId === 'b');
    assert.deepEqual(a.contentAliases, [], 'must not in-batch-match while the preflight is unavailable');
    assert.deepEqual(b.contentAliases, []);
  });

  test('a persisted-supersession preflight that HANGS is cut off at the remaining budget, not allowed to block the batch (round-6 GPT audit H1)', async () => {
    const pool = { query: () => new Promise(() => {}) }; // never resolves
    const entries = [
      makeEntry({ topicId: 'a', detailSnapshot: 'the exact same defect described one way in enough detail' }),
      makeEntry({ topicId: 'b', detailSnapshot: 'the exact same defect described one way in enough detail' }),
    ];
    const start = Date.now();
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92, deadlineMs: 50,
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `expected the preflight timeout to fire near 50ms, took ${elapsed}ms`);
    assert.deepEqual(result[0].contentAliases, []);
    assert.deepEqual(result[1].contentAliases, []);
  });

  test('a successful (empty) preflight still allows in-batch matching normally — negative control for the two tests above', async () => {
    const pool = queueMockPool([[], [], [], []]); // preflight, then cache/db miss twice
    const entries = [
      makeEntry({ topicId: 'a', detailSnapshot: 'the exact same defect described one way in enough detail' }),
      makeEntry({ topicId: 'b', detailSnapshot: 'the exact same defect described one way in enough detail' }),
    ];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92,
    });
    const a = result.find(e => e.topicId === 'a');
    const b = result.find(e => e.topicId === 'b');
    assert.deepEqual(a.contentAliases, ['b']);
    assert.deepEqual(b.contentAliases, ['a']);
  });

  test('a single-entry batch never issues the persisted-superseded lookup (nothing could match in-batch anyway)', async () => {
    let queryCount = 0;
    const pool = {
      query: async () => { queryCount++; return { rows: [] }; },
    };
    const entries = [makeEntry()];
    await populateContentAliases(entries, { repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92 });
    // cache-check + nearest-neighbour only — no leading batch-wide query.
    assert.equal(queryCount, 2);
  });

  test('an entry never aliases to itself', async () => {
    const pool = queueMockPool([[], []]);
    const entries = [makeEntry({ topicId: 'self' })];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92,
    });
    assert.deepEqual(result[0].contentAliases, []);
  });

  test('maxEntries bound stops enrichment mid-batch — remaining entries unchanged', async () => {
    const pool = queueMockPool([[], [], [], []]);
    const entries = [makeEntry({ topicId: 'a' }), makeEntry({ topicId: 'b' }), makeEntry({ topicId: 'c' })];
    const { entries: result, embeddingsByTopicId } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, maxEntries: 1,
    });
    assert.equal(Object.keys(embeddingsByTopicId).length, 1);
    assert.deepEqual(result.map(e => e.contentAliases), [[], [], []]);
  });

  test('deadlineMs bound stops enrichment mid-batch (refuses to START after expiry)', async () => {
    const pool = queueMockPool([[], [], [], []]);
    const entries = [makeEntry({ topicId: 'a' }), makeEntry({ topicId: 'b' })];
    const { embeddingsByTopicId } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, deadlineMs: -1,
    });
    assert.equal(Object.keys(embeddingsByTopicId).length, 0);
  });

  test('a single slow embed() call is cut off at the remaining budget, not allowed to consume the whole batch (H5)', async () => {
    // A between-iteration-only check would let ONE hung call block forever.
    // This proves the budget is enforced DURING an entry's own async work.
    const pool = queueMockPool([[], []]);
    const hangingEmbed = () => new Promise(() => {}); // never resolves
    const entries = [makeEntry({ topicId: 'a' })];
    const start = Date.now();
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: hangingEmbed, embeddingSpace: SPACE, deadlineMs: 50,
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `expected the per-entry timeout to fire near 50ms, took ${elapsed}ms`);
    assert.deepEqual(result[0].contentAliases, []);
  });

  test('a cached embedding returned as a pgvector TEXT LITERAL (real-Postgres shape) is parsed, not used as-is (Gemini gate G1)', async () => {
    // `pg` has no built-in type parser for the custom `vector` extension
    // type, so a real Postgres cache hit returns `embedding` as the STRING
    // "[1,0,0]", never a number[] — every prior test here used a mocked
    // pool that just echoed back whatever array it was told to return,
    // masking this. cosineSimilarity must still find the in-batch match.
    const pool = queueMockPool([
      [{ embedding: '[1,0,0]', embedding_model: SPACE.provenanceId, dimension: SPACE.dim }], // cache hit, TEXT shape
      [],                                                                                     // 'a': db-miss
      [], [],                                                                                 // 'b': cache-miss, db-miss
    ]);
    const entries = [
      makeEntry({ topicId: 'a', detailSnapshot: 'the exact same defect described one way in enough detail' }),
      makeEntry({ topicId: 'b', detailSnapshot: 'the exact same defect described one way in enough detail' }),
    ];
    const { entries: result } = await populateContentAliases(entries, {
      repoId: 'r1', pool, embed: echoEmbed, embeddingSpace: SPACE, threshold: 0.92,
    });
    const a = result.find(e => e.topicId === 'a');
    const b = result.find(e => e.topicId === 'b');
    assert.deepEqual(a.contentAliases, ['b'], 'a string-shaped cached vector must still compare correctly against a real array');
    assert.deepEqual(b.contentAliases, ['a']);
  });

  test('a snapshot_hash cache hit in the SAME embedding_model/dimension reuses the vector without calling embed()', async () => {
    let embedCalled = false;
    const embed = async () => { embedCalled = true; return [9, 9, 9]; };
    const pool = queueMockPool([
      [{ embedding: [1, 0, 0], embedding_model: SPACE.provenanceId, dimension: SPACE.dim }], // cache hit
      [], // nearest-neighbour, no match
    ]);
    const entries = [makeEntry()];
    await populateContentAliases(entries, { repoId: 'r1', pool, embed, embeddingSpace: SPACE, threshold: 0.92 });
    assert.equal(embedCalled, false);
  });

  test('a snapshot_hash cache hit in a DIFFERENT embedding space is treated as a miss and re-embeds (round-2 GPT audit H4)', async () => {
    let embedCalled = false;
    const embed = async () => { embedCalled = true; return [1, 0, 0]; };
    const pool = queueMockPool([
      [{ embedding: [1, 0, 0], embedding_model: 'retired-model', dimension: 512 }], // stale-space cache row
      [], // nearest-neighbour, no match
    ]);
    const entries = [makeEntry()];
    await populateContentAliases(entries, { repoId: 'r1', pool, embed, embeddingSpace: SPACE, threshold: 0.92 });
    assert.equal(embedCalled, true, 'a snapshot_hash match against a retired space must not be reused');
  });
});
