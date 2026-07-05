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
