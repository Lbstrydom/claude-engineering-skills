/**
 * @fileoverview Cluster A / Phase 3 — the reconcile classifier, with the
 * data-loss directions pinned explicitly.
 *
 * The catastrophic outcome this suite exists to prevent: pruning a local entry
 * that was never mirrored, i.e. deleting the sole copy of a finding. Absence
 * from `debt_entries` cannot distinguish "never mirrored" from "resolved
 * remotely", and a naive "has a resolved event" test is ALSO unsafe because a
 * topic's lifecycle is not monotonic — this repo carries 34 `reopened` events.
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md §2 A8, §9.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyReconciliation,
  isProvablyResolvedRemotely,
  latestLifecycleEvent,
  evaluatePostcondition,
  CLOCK_SKEW_TOLERANCE_MS,
} from '../scripts/lib/debt-reconcile.mjs';

const JULY = '2026-07-01T00:00:00.000Z';
const AUG = '2026-08-01T00:00:00.000Z';
const SEP = '2026-09-01T00:00:00.000Z';

const entry = (topicId, deferredAt) => ({ topicId, deferredAt, severity: 'HIGH' });

describe('classifyReconciliation — the four lifecycle shapes', () => {
  test('(a) absent from the store, no events → localOnly, so it gets PUSHED', () => {
    const r = classifyReconciliation({
      localEntries: [entry('aaa', JULY)],
      cloudEntries: [],
      latestEventByTopic: new Map(),
    });
    assert.deepEqual(r.localOnly.map((e) => e.topicId), ['aaa']);
    assert.deepEqual(r.locallyResolved, [], 'an unmirrored orphan must NEVER be prunable');
  });

  test('(b) absent, latest is resolved AFTER the entry → locallyResolved, prunable', () => {
    const r = classifyReconciliation({
      localEntries: [entry('bbb', JULY)],
      cloudEntries: [],
      latestEventByTopic: new Map([['bbb', { event: 'resolved', ts: AUG }]]),
    });
    assert.deepEqual(r.locallyResolved.map((e) => e.topicId), ['bbb']);
    assert.deepEqual(r.localOnly, []);
  });

  test('(c) THE REOPEN TRAP: resolved then reopened → localOnly, never pruned', () => {
    // Resolved in July, reopened in August, re-deferred locally in September,
    // mirror failed. "Any resolved event" would delete this. It must not.
    const latest = latestLifecycleEvent([
      { event: 'resolved', ts: JULY },
      { event: 'reopened', ts: AUG },
    ]);
    assert.equal(latest.event, 'reopened');

    const r = classifyReconciliation({
      localEntries: [entry('ccc', SEP)],
      cloudEntries: [],
      latestEventByTopic: new Map([['ccc', latest]]),
    });
    assert.deepEqual(r.localOnly.map((e) => e.topicId), ['ccc']);
    assert.deepEqual(r.locallyResolved, [], 'a reopened topic is live debt, not closed');
  });

  test('(d) resolve OLDER than the entry → localOnly, never pruned', () => {
    // The resolve describes a previous lifecycle instance; this local row is a
    // later re-deferral that simply never mirrored.
    const r = classifyReconciliation({
      localEntries: [entry('ddd', SEP)],
      cloudEntries: [],
      latestEventByTopic: new Map([['ddd', { event: 'resolved', ts: JULY }]]),
    });
    assert.deepEqual(r.localOnly.map((e) => e.topicId), ['ddd']);
    assert.deepEqual(r.locallyResolved, []);
  });

  test('present in the store → both; store-only rows are reported, never deleted', () => {
    const r = classifyReconciliation({
      localEntries: [entry('shared', JULY)],
      cloudEntries: [{ topicId: 'shared' }, { topicId: 'cloudish' }],
      latestEventByTopic: new Map(),
    });
    assert.deepEqual(r.both.map((e) => e.topicId), ['shared']);
    assert.deepEqual(r.cloudOnly.map((e) => e.topicId), ['cloudish']);
  });

  test('the blunt safety assertion: a ledger of pure orphans prunes NOTHING', () => {
    const localEntries = Array.from({ length: 37 }, (_, i) => entry(`orphan-${i}`, JULY));
    const r = classifyReconciliation({
      localEntries, cloudEntries: [], latestEventByTopic: new Map(),
    });
    assert.equal(r.locallyResolved.length, 0, 'the catastrophic case: eating the 37 orphans');
    assert.equal(r.localOnly.length, 37);
  });
});

describe('isProvablyResolvedRemotely — every ambiguity keeps the data', () => {
  test('missing timestamps on either side are not evidence', () => {
    assert.equal(isProvablyResolvedRemotely(entry('x', JULY), { event: 'resolved', ts: null }), false);
    assert.equal(isProvablyResolvedRemotely(entry('x', null), { event: 'resolved', ts: AUG }), false);
  });

  test('unparseable timestamps are not evidence', () => {
    assert.equal(isProvablyResolvedRemotely(entry('x', 'not-a-date'), { event: 'resolved', ts: AUG }), false);
    assert.equal(isProvablyResolvedRemotely(entry('x', JULY), { event: 'resolved', ts: 'nope' }), false);
  });

  test('a resolve inside the clock-skew tolerance is not trusted', () => {
    const base = Date.parse(JULY);
    const justAfter = new Date(base + CLOCK_SKEW_TOLERANCE_MS - 1000).toISOString();
    assert.equal(
      isProvablyResolvedRemotely(entry('x', JULY), { event: 'resolved', ts: justAfter }),
      false,
      'within skew the ordering is not a fact',
    );
    const wellAfter = new Date(base + CLOCK_SKEW_TOLERANCE_MS + 60_000).toISOString();
    assert.equal(isProvablyResolvedRemotely(entry('x', JULY), { event: 'resolved', ts: wellAfter }), true);
  });

  test('a non-resolved latest event is never evidence', () => {
    for (const ev of ['reopened', 'surfaced', 'escalated', 'deferred']) {
      assert.equal(isProvablyResolvedRemotely(entry('x', JULY), { event: ev, ts: SEP }), false, ev);
    }
  });
});

describe('latestLifecycleEvent — deterministic tie-break', () => {
  test('at equal timestamps, reopened outranks resolved (the safe direction)', () => {
    const a = latestLifecycleEvent([{ event: 'resolved', ts: AUG }, { event: 'reopened', ts: AUG }]);
    const b = latestLifecycleEvent([{ event: 'reopened', ts: AUG }, { event: 'resolved', ts: AUG }]);
    assert.equal(a.event, 'reopened');
    assert.equal(b.event, 'reopened', 'the outcome must not depend on list order');
  });

  test('events with unparseable timestamps are skipped, not crashed on', () => {
    const r = latestLifecycleEvent([{ event: 'resolved', ts: 'garbage' }, { event: 'reopened', ts: AUG }]);
    assert.equal(r.event, 'reopened');
  });

  test('an empty or non-array input yields null', () => {
    assert.equal(latestLifecycleEvent([]), null);
    assert.equal(latestLifecycleEvent(undefined), null);
  });
});

describe('evaluatePostcondition — a spilled push is not a completed one', () => {
  test('zero orphans and zero spilled is the clean state', () => {
    assert.equal(evaluatePostcondition({ localOnly: 0, spilled: 0 }).satisfied, true);
  });

  test('localOnly === spilled is satisfied, and says the drain is pending', () => {
    const r = evaluatePostcondition({ localOnly: 3, spilled: 3 });
    assert.equal(r.satisfied, true);
    assert.match(r.detail, /awaiting drain/);
  });

  test('orphans beyond the spilled count is NOT satisfied', () => {
    assert.equal(evaluatePostcondition({ localOnly: 5, spilled: 2 }).satisfied, false);
  });
});
