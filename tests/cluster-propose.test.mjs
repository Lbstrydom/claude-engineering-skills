import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeClusters, dupHashClusters } from '../scripts/lib/solo-control/cluster-propose.mjs';

function allIndicesCoveredOnce(clusters, n) {
  const seen = new Set();
  for (const idxs of Object.values(clusters)) for (const i of idxs) { assert.equal(seen.has(i), false, `index ${i} duplicated`); seen.add(i); }
  assert.equal(seen.size, n, 'every input row must appear in exactly one cluster');
}

test('no client → deterministic dupHash fallback (degraded, never blocks)', async () => {
  const rows = [
    { category: 'x', file: 'a.js', detail: 'bug one' },
    { category: 'x', file: 'a.js', detail: 'bug one' },  // exact dup
    { category: 'y', file: 'b.js', detail: 'bug two' },
  ];
  const r = await proposeClusters(rows, {});
  assert.equal(r.mode, 'duphash-degraded');
  allIndicesCoveredOnce(r.clusters, 3);
});

test('sensitive-path row is NEVER sent to the client, still clustered (egress H3)', async () => {
  let sentPayload = null;
  const spy = { messages: { create: async (params) => { sentPayload = params.messages[0].content; return { content: [{ type: 'text', text: '{"clusters":[[0]]}' }] }; } } };
  const rows = [
    { category: 'c', file: 'src/app.js', detail: 'normal finding' },
    { category: 'c', file: '.env', detail: 'SECRET_KEY usage in env file' }, // sensitive path → excluded
  ];
  const r = await proposeClusters(rows, { client: spy });
  assert.equal(r.excludedSensitive, 1);
  assert.match(sentPayload, /normal finding/);
  assert.doesNotMatch(sentPayload, /\.env/);           // the sensitive row never left
  allIndicesCoveredOnce(r.clusters, 2);                // both still clustered
});

test('over-split: an index the LLM drops becomes its own singleton (never lost)', async () => {
  // LLM returns only [0], dropping index 1 → it must reappear as a singleton.
  const spy = { messages: { create: async () => ({ content: [{ type: 'text', text: '{"clusters":[[0]]}' }] }) } };
  const rows = [
    { category: 'a', file: 'x.js', detail: 'one' },
    { category: 'b', file: 'y.js', detail: 'two' },
  ];
  const r = await proposeClusters(rows, { client: spy });
  allIndicesCoveredOnce(r.clusters, 2);
});

test('malformed LLM output → dupHash fallback (never trust an unparseable partition)', async () => {
  const spy = { messages: { create: async () => ({ content: [{ type: 'text', text: 'not json at all' }] }) } };
  const rows = [{ category: 'a', file: 'x.js', detail: 'one' }, { category: 'b', file: 'y.js', detail: 'two' }];
  const r = await proposeClusters(rows, { client: spy });
  assert.equal(r.mode, 'duphash-degraded');
  allIndicesCoveredOnce(r.clusters, 2);
});

test('dupHashClusters groups exact dups together', () => {
  const rows = [{ category: 'a', file: 'x', detail: 'd' }, { category: 'a', file: 'x', detail: 'd' }, { category: 'b', file: 'y', detail: 'e' }];
  const g = Object.values(dupHashClusters(rows));
  assert.equal(g.length, 2);
});

// ── internal sub-batching (found live: a ~300-row single-commit batch silently
// degraded to near-1:1 clusters — one LLM call cannot emit a full index-partition
// of hundreds of items within its output budget) ────────────────────────────────

test('a batch far larger than one call can handle still fully clusters via internal chunking', async () => {
  // 120 rows (well over MAX_ROWS_PER_CALL=50) → must be split into >=3 chunks.
  // Each chunk's mock groups [0,1] and leaves the rest singleton, so we can verify
  // BOTH that every row is covered exactly once AND that real (non-singleton)
  // grouping happened per chunk (proof clustering isn't silently degrading).
  let calls = 0;
  const spy = {
    messages: {
      create: async (params) => {
        calls++;
        const text = params.messages[0].content;
        const n = Number(text.match(/Group these (\d+) findings/)[1]);
        const clusters = [[0, 1], ...Array.from({ length: n - 2 }, (_, i) => [i + 2])];
        return { content: [{ type: 'text', text: JSON.stringify({ clusters }) }] };
      },
    },
  };
  const rows = Array.from({ length: 120 }, (_, i) => ({ category: 'x', file: `f${i}.js`, detail: `finding ${i}` }));
  const r = await proposeClusters(rows, { client: spy });
  assert.equal(r.mode, 'llm');
  assert.ok(calls >= 3, `expected >=3 chunked calls for 120 rows, got ${calls}`);
  allIndicesCoveredOnce(r.clusters, 120);
  // Each chunk merged its [0,1] pair → at least one real (size>1) cluster per chunk.
  const multiClusters = Object.values(r.clusters).filter((idxs) => idxs.length > 1);
  assert.ok(multiClusters.length >= calls, `expected >=${calls} multi-row clusters (one per chunk), got ${multiClusters.length}`);
});

test('mixed chunk outcomes report llm+duphash-degraded, not a misleading pure mode', async () => {
  // First chunk (rows 0-49) succeeds via LLM; second chunk (50-99) returns garbage
  // and must fall back — the OVERALL mode must reflect the mix, not silently
  // report "llm" when part of the batch actually degraded.
  let call = 0;
  const spy = {
    messages: {
      create: async (params) => {
        call++;
        if (call === 1) {
          const n = Number(params.messages[0].content.match(/Group these (\d+) findings/)[1]);
          return { content: [{ type: 'text', text: JSON.stringify({ clusters: Array.from({ length: n }, (_, i) => [i]) }) }] };
        }
        return { content: [{ type: 'text', text: 'not json' }] };
      },
    },
  };
  const rows = Array.from({ length: 100 }, (_, i) => ({ category: 'x', file: `f${i}.js`, detail: `d${i}` }));
  const r = await proposeClusters(rows, { client: spy });
  assert.equal(r.mode, 'llm+duphash-degraded');
  allIndicesCoveredOnce(r.clusters, 100);
});
