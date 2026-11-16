/**
 * Harness retro — recurrence ranking (plan §2 c6).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSessions, rankCandidates, KIND_WEIGHTS, strengthOf } from '../scripts/lib/friction/retro/aggregate.mjs';

const fps = {
  aaaaaaaaaaaaaaaa: { kind: 'tool_error', tool: 'Bash', label: 'Error: Cannot find module X' },
  bbbbbbbbbbbbbbbb: { kind: 'user_correction', tool: 'Edit', label: 'correction after Edit' },
  cccccccccccccccc: { kind: 'tool_error', tool: 'Bash', label: 'one-off failure' },
};
const s = (key, repo, counts, day = '2026-11-10') => ({ sessionKey: key, repoUuid: repo, origin: 'interactive', startedAt: `${day}T10:00:00Z`, counts });

describe('aggregateSessions + rankCandidates', () => {
  const sessions = [
    s('1', 'r1', { aaaaaaaaaaaaaaaa: 2, bbbbbbbbbbbbbbbb: 1, cccccccccccccccc: 1 }),
    s('2', 'r1', { aaaaaaaaaaaaaaaa: 1, bbbbbbbbbbbbbbbb: 1 }, '2026-11-11'),
    s('3', 'r2', { aaaaaaaaaaaaaaaa: 1, bbbbbbbbbbbbbbbb: 1 }, '2026-11-12'),
  ];
  const agg = aggregateSessions(sessions, fps);

  it('counts sessions, occurrences, repos and days per fingerprint', () => {
    const a = agg.get('aaaaaaaaaaaaaaaa');
    assert.equal(a.sessions, 3); assert.equal(a.occurrences, 4); assert.equal(a.repos.size, 2); assert.equal(a.days.size, 3);
  });

  it('a one-off is counted, never ranked', () => {
    const r = rankCandidates(agg);
    assert.equal(r.oneOffs, 1);
    assert.ok(!r.candidates.some((c) => c.fingerprint === 'cccccccccccccccc'));
  });

  it('kind weight keeps a correction below an error of equal recurrence', () => {
    const r = rankCandidates(agg);
    assert.deepEqual(r.candidates.map((c) => c.fingerprint), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
    assert.ok(KIND_WEIGHTS.user_correction < KIND_WEIGHTS.tool_error);
    assert.equal(r.candidates[0].strength, 'strong');
  });

  it('enforced and rejected fingerprints leave the ranking', () => {
    const decisions = new Map([['aaaaaaaaaaaaaaaa', { decision: 'enforced' }], ['bbbbbbbbbbbbbbbb', { decision: 'rejected' }]]);
    const r = rankCandidates(agg, { decisions });
    assert.equal(r.candidates.length, 0);
    assert.equal(r.enforced.length, 1); assert.equal(r.previouslyRejected.length, 1);
  });

  it('order is deterministic on ties', () => {
    const tie = aggregateSessions([s('1', 'r', { ffffffffffffffff: 1, eeeeeeeeeeeeeeee: 1 }), s('2', 'r', { ffffffffffffffff: 1, eeeeeeeeeeeeeeee: 1 })], {});
    assert.deepEqual(rankCandidates(tie).candidates.map((c) => c.fingerprint), ['eeeeeeeeeeeeeeee', 'ffffffffffffffff']);
  });

  it('strength thresholds', () => {
    assert.equal(strengthOf(1), 'one-off'); assert.equal(strengthOf(2), 'weak'); assert.equal(strengthOf(3), 'strong');
  });
});

describe('canonicalSessions — one duplicate policy everywhere', async () => {
  const { canonicalSessions } = await import('../scripts/lib/friction/retro/aggregate.mjs');
  it('a later row for the same session supersedes the earlier one', () => {
    const rows = [s('1', 'r', { aaaaaaaaaaaaaaaa: 1 }), s('1', 'r', { aaaaaaaaaaaaaaaa: 5 }), s('2', 'r', { aaaaaaaaaaaaaaaa: 1 })];
    assert.deepEqual(canonicalSessions(rows).map((r) => r.counts.aaaaaaaaaaaaaaaa), [5, 1]);
    const a = aggregateSessions(rows, fps).get('aaaaaaaaaaaaaaaa');
    assert.equal(a.sessions, 2); assert.equal(a.occurrences, 6);
  });
});
