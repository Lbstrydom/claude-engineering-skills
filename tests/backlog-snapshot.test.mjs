/**
 * @fileoverview Cluster C / Phase 10 — the backlog snapshot line.
 *
 * The two failure modes this pins are both real wrong numbers from this repo's
 * history: reading a CAPPED reader's `rows.length` as a total (once reported
 * "20" against a real 232), and rendering an unasked question as `0` (an
 * unmeasured queue reading as good news).
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md §2 snapshot grammar.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderBacklogSnapshot, isMeasured, UNMEASURED } from '../scripts/lib/store/backlog-snapshot.mjs';

const AT = new Date('2026-09-04T09:14:32.000Z');

const q1 = {
  ok: true, cloud: true, measured: true, scope: { mode: 'repo' },
  // 20 capped rows against a true total of 51 — the trap.
  rows: new Array(20).fill({}),
  byMode: { total: 51, code: 26, plan: 25 }, agedOut: 190,
};
const q2 = {
  ok: true, cloud: true, measured: true, scope: { mode: 'repo' },
  rows: new Array(20).fill({}),
  total: 168, byMode: { total: 168, code: 80, plan: 88 },
  byDisposition: { open: 168, acceptedPermanent: 50 },
};
const q3 = {
  state: 'ready', cloud: true,
  items: new Array(10).fill({}), // capped at 10
  counts: { unadjudicated: 449, acceptedUnfixed: 34, fixedUnlabelled: 3, regressed: 0, totalActionable: 486 },
};
const debt = { ok: true, verdict: 'measured', cloudTotal: 173, localTotal: 106, undrainedSpills: 0 };
const upstream = { ok: true, cloud: true, rows: [] };

describe('renderBacklogSnapshot', () => {
  test('renders every dimension from the COUNT fields, never rows.length', () => {
    const line = renderBacklogSnapshot({ q1, q2, q3, debt, upstream, at: AT });
    assert.equal(
      line,
      'Backlog 2026-09-04T09:14Z: Q1 26c/25p (+190 aged) · Q2 80c/88p (50 perm) · Q3 486 · debt 173 cloud/106 local (0 spilled) · upstream 0',
    );
    assert.doesNotMatch(line, /\b20\b/, 'the capped rows.length must never reach the line');
    assert.doesNotMatch(line, /Q3 10\b/, 'Q3 must come from counts, not the 10 capped items');
  });

  test('code and plan counts stay DISTINCT — a subset must not print as a total', () => {
    const line = renderBacklogSnapshot({ q1, q2, q3, debt, upstream, at: AT });
    assert.match(line, /Q1 26c\/25p/);
    assert.match(line, /Q2 80c\/88p/);
  });

  test('an unmeasured envelope renders `unmeasured`, NEVER 0', () => {
    const line = renderBacklogSnapshot({
      q1: { ok: true, cloud: true, measured: false, scope: { mode: 'repo' } },
      q2: { ok: true, cloud: false },
      q3: { state: 'disabled' },
      debt: { ok: false, verdict: 'unverifiable' },
      upstream: { ok: false },
      at: AT,
    });
    assert.equal(line, `Backlog 2026-09-04T09:14Z: Q1 ${UNMEASURED} · Q2 ${UNMEASURED} · Q3 ${UNMEASURED} · debt ${UNMEASURED} · upstream ${UNMEASURED}`);
    assert.doesNotMatch(line, /\b0\b/, 'an unasked question must not render as good news');
  });

  test('a non-repo scope is unmeasured — the two-repo-ids trap', () => {
    const line = renderBacklogSnapshot({
      q1: { ok: true, cloud: true, measured: true, scope: { mode: 'global' }, byMode: { code: 5, plan: 5 } },
      at: AT,
    });
    assert.match(line, new RegExp(`Q1 ${UNMEASURED}`));
  });

  test('missing envelopes entirely are unmeasured, not zero', () => {
    const line = renderBacklogSnapshot({ at: AT });
    assert.doesNotMatch(line, /\b0\b/);
    assert.match(line, /Q1 unmeasured · Q2 unmeasured · Q3 unmeasured/);
  });

  test('a non-zero spill count is surfaced — the open loss window', () => {
    const line = renderBacklogSnapshot({
      debt: { ok: true, verdict: 'measured', cloudTotal: 173, localTotal: 110, undrainedSpills: 4 },
      at: AT,
    });
    assert.match(line, /debt 173 cloud\/110 local \(4 spilled\)/);
  });
});

describe('isMeasured', () => {
  test('rejects every not-actually-answered shape', () => {
    assert.equal(isMeasured(null), false);
    assert.equal(isMeasured(undefined), false);
    assert.equal(isMeasured({ ok: false }), false);
    assert.equal(isMeasured({ cloud: false }), false);
    assert.equal(isMeasured({ measured: false }), false);
    assert.equal(isMeasured({ scope: { mode: 'global' } }), false);
  });

  test('accepts a repo-scoped measured envelope', () => {
    assert.equal(isMeasured({ ok: true, cloud: true, measured: true, scope: { mode: 'repo' } }), true);
  });
});
