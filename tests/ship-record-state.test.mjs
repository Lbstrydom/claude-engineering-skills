/**
 * @fileoverview The ship record catch-up's ONE oracle (scripts/lib/ship-record/state.mjs).
 * Plan: docs/plans/ship-record-catchup.md §2.1. Properties: recorded needs evidence naming THIS PR; unmeasured is never 0;
 * a floor excludes by number, never by timestamp alone; two floors stop everything.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRecordState, parseFloorMarker, renderFloorMarker, prNumberFromEntryName, isFloorEntryName, parsePrMarkers, listingStart, RECHECK_DAYS,
} from '../scripts/lib/ship-record/state.mjs';

const sha = (c) => c.repeat(40);
const FLOOR = { file: '2026-11-10-000000-record-floor.md', ok: true, mergedThrough: '2026-11-10T00:00:00Z', covered: [10, 11] };
const pr = (number, mergedAt, c) => ({ number, mergedAt, mergeCommit: c ? sha(c) : null, headRefName: 'b', url: '' });
const base = (extra = {}) => ({ markerPresent: true, floors: [FLOOR], merged: { ok: true, complete: true, prs: [] }, baseMarkers: [], inBand: new Map(), ...extra });

describe('parseFloorMarker / renderFloorMarker', () => {
  it('round-trips the one grammar (writer → reader)', () => {
    const m = renderFloorMarker({ mergedThrough: '2026-11-10T05:24:25.000Z', covered: [12, 3, 7] });
    assert.deepEqual(parseFloorMarker(`## x\n${m}\n`), { ok: true, mergedThrough: '2026-11-10T05:24:25.000Z', covered: [3, 7, 12] });
    assert.deepEqual(parseFloorMarker(renderFloorMarker({ mergedThrough: '2026-11-10T00:00:00Z', covered: [] })).covered, []);
  });
  it('rejects malformed timestamps, lists, duplicates and two markers — each with its reason', () => {
    const m = (t, c) => `<!-- ship-record-floor v1 merged-through=${t} covered=${c} -->`;
    assert.match(parseFloorMarker(m('2026-11-10', '1')).reason, /ISO-8601/);
    assert.match(parseFloorMarker(m('2026-11-10T00:00:00+02:00', '1')).reason, /ISO-8601/);
    assert.match(parseFloorMarker(m('2026-11-10T00:00:00Z', '')).reason ?? 'no marker', /no floor marker|covered/);
    assert.match(parseFloorMarker(m('2026-11-10T00:00:00Z', '3,2')).reason, /ascending/);
    assert.match(parseFloorMarker(m('2026-11-10T00:00:00Z', '2,2')).reason, /ascending/);
    assert.match(parseFloorMarker(m('2026-11-10T00:00:00Z', '0')).reason, /positive/);
    assert.match(parseFloorMarker(`${m('2026-11-10T00:00:00Z', '1')}\n${m('2026-11-10T00:00:00Z', '2')}`).reason, /more than one/);
    assert.throws(() => renderFloorMarker({ mergedThrough: 'yesterday', covered: [1] }));
  });
  it('parses entry names and PR markers', () => {
    assert.equal(prNumberFromEntryName('2026-11-16-091244-pr-372.md'), 372);
    assert.equal(prNumberFromEntryName('2026-11-16-091244-pr-0.md'), null);
    assert.equal(prNumberFromEntryName('2026-11-16-091244-fix-pr-372.md'), null);
    assert.ok(isFloorEntryName('2026-11-16-091244-record-floor.md'));
    assert.deepEqual(parsePrMarkers(`<!-- ship-record v1 pr=5 merge=${sha('a')} -->`), [{ pr: 5, merge: sha('a') }]);
    assert.equal(listingStart(FLOOR), new Date(Date.parse(FLOOR.mergedThrough) - RECHECK_DAYS * 86_400_000).toISOString());
  });
});

describe('classifyRecordState', () => {
  it('records only on evidence naming THIS PR: a marker with its number AND sha, or its own added entry', () => {
    const st = classifyRecordState(base({
      merged: { ok: true, complete: true, prs: [pr(20, '2026-11-11T00:00:00Z', 'a'), pr(21, '2026-11-11T01:00:00Z', 'b'), pr(22, '2026-11-11T02:00:00Z', 'c'), pr(23, '2026-11-11T03:00:00Z', 'd')] },
      baseMarkers: [{ pr: 20, merge: sha('a') }, { pr: 23, merge: sha('e') }], // 23's marker names another sha: not evidence
      inBand: new Map([[sha('b'), true], [sha('c'), false], [sha('d'), false]]),
    }));
    assert.deepEqual(st.prs.map((p) => [p.number, p.status, p.by]), [[20, 'recorded', 'marker'], [21, 'recorded', 'in-band'], [22, 'unrecorded', null], [23, 'unrecorded', null]]);
    assert.equal(st.state, 'measured');
    assert.deepEqual(st.counts, { merged: 4, recorded: 2, unrecorded: 2, unknown: 0 });
  });
  it('excludes by the floor\'s covered NUMBERS, keeps a late arrival before the cutoff, drops what predates the recheck window', () => {
    const st = classifyRecordState(base({ merged: { ok: true, complete: true, prs: [
      pr(10, '2026-11-09T00:00:00Z', 'a'),            // covered
      pr(12, '2026-11-09T12:00:00Z', 'b'),            // before the cutoff, NOT covered: a late search result — recorded
      pr(11, '2026-11-10T00:00:00Z', 'c'),            // covered, at the cutoff instant
      pr(13, '2026-11-10T00:00:00Z', 'd'),            // same instant, not covered — kept (never excluded by timestamp)
      pr(9, '2026-10-01T00:00:00Z', 'e'),             // before the recheck window
    ] }, inBand: new Map([[sha('b'), false], [sha('d'), false]]) }));
    assert.deepEqual(st.prs.map((p) => p.number), [12, 13]);
  });
  it('an unknown merge is partial, never unrecorded', () => {
    const st = classifyRecordState(base({ merged: { ok: true, complete: true, prs: [pr(30, '2026-11-12T00:00:00Z', 'f'), pr(31, '2026-11-12T00:00:00Z', null)] }, inBand: new Map([[sha('f'), null]]) }));
    assert.equal(st.state, 'partial');
    assert.deepEqual(st.counts, { merged: 2, recorded: 0, unrecorded: 0, unknown: 2 });
    assert.match(st.reason, /git fetch/);
  });
  it('an incomplete listing is partial with its reason', () => {
    const st = classifyRecordState(base({ merged: { ok: true, complete: false, partialReason: '2026-11-12 window full', prs: [] } }));
    assert.equal(st.state, 'partial');
    assert.match(st.reason, /window full/);
  });
  it('every non-measured state carries unrecorded:null — never 0', () => {
    const cases = [
      base({ markerPresent: false }),
      base({ floors: [] }),
      base({ floors: [FLOOR, { ...FLOOR, file: 'b' }] }),
      base({ floors: [{ file: 'x', ok: false, reason: 'bad' }] }),
      base({ merged: { ok: false, reason: 'gh not installed' } }),
    ];
    assert.deepEqual(cases.map((c) => classifyRecordState(c).state), ['no-marker', 'no-floor', 'ambiguous-floor', 'unmeasured', 'unmeasured']);
    for (const c of cases) assert.equal(classifyRecordState(c).counts.unrecorded, null);
  });
});
