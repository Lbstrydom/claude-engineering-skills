import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decompose, renderMarkdown } from '../scripts/ledger-decompose.mjs';

// Fixture rowset — inject a fake `query` (M4 DI). Weights: LOW=1, MEDIUM=3, HIGH=8.
function fakeQuery(rows) {
  return async () => ({ rows });
}

test('decompose: accepted value by round + round-1 share (severity-weighted)', async () => {
  const rows = [
    { round_raised: 1, stage: null, severity: 'HIGH', adjudication_outcome: 'accepted' },   // 8, r1
    { round_raised: 1, stage: null, severity: 'LOW', adjudication_outcome: 'accepted' },     // 1, r1
    { round_raised: 2, stage: null, severity: 'MEDIUM', adjudication_outcome: 'accepted' },  // 3, r2+
    { round_raised: 3, stage: null, severity: 'HIGH', adjudication_outcome: 'dismissed' },   // not accepted
  ];
  const d = await decompose({}, { query: fakeQuery(rows) });
  assert.equal(d.acceptedCount, 3);
  assert.equal(d.totalAcceptedValue, 12);            // 8+1+3
  assert.equal(d.acceptedValueByRound['1'], 9);      // 8+1
  assert.equal(d.acceptedValueByRound['2+'], 3);
  assert.equal(d.acceptedValueRound1Share, 0.75);    // 9/12
  assert.equal(d.acceptedHighByRound['1'], 1);
});

test('decompose: gate marginal value = acceptance rate of gate-raised findings', async () => {
  const rows = [
    { round_raised: 1, stage: 'gemini', severity: 'HIGH', adjudication_outcome: 'accepted' },
    { round_raised: 1, stage: 'gemini', severity: 'LOW', adjudication_outcome: 'dismissed' },
    { round_raised: 1, stage: 'gemini', severity: 'LOW', adjudication_outcome: 'dismissed' },
    { round_raised: 1, stage: null, severity: 'HIGH', adjudication_outcome: 'accepted' },   // not gate
  ];
  const d = await decompose({}, { query: fakeQuery(rows) });
  assert.equal(d.gateMarginalValue.raised, 3);
  assert.equal(d.gateMarginalValue.accepted, 1);
  assert.equal(d.gateMarginalValue.acceptanceRate, 0.333);
});

test('decompose: empty ledger → totals zero, null share (no divide-by-zero)', async () => {
  const d = await decompose({}, { query: fakeQuery([]) });
  assert.equal(d.total, 0);
  assert.equal(d.acceptedCount, 0);
  assert.equal(d.acceptedValueRound1Share, null);
  assert.equal(d.gateMarginalValue.acceptanceRate, null);
});

test('renderMarkdown: includes the survivorship caveat + the P1 gate levers', async () => {
  const d = await decompose({}, { query: fakeQuery([{ round_raised: 1, stage: null, severity: 'HIGH', adjudication_outcome: 'accepted' }]) });
  const md = renderMarkdown(d);
  assert.match(md, /[Ss]urvivorship/);
  assert.match(md, /acceptedValueRound1Share/);
  assert.match(md, /marginal value/i);
});
