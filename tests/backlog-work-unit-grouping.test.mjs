/**
 * @fileoverview One work-unit grouper, three backlog readers
 * (docs/plans/backlog-tooling-honesty.md §7 — `scripts/lib/cross-skill/work-unit-grouping.mjs`).
 *
 * Pins: (1) each reader names its own recency column through `dateKey` and an
 * unknown key is refused, never guessed; (2) the honesty fields (`partial`,
 * `unclustered`) survive the move out of ship.mjs; (3) `--work-unit` filters on
 * `audit_finding_id`; (4) EGRESS — the members handed to the labeller carry no
 * `detail` / `detail_snapshot` even when the rows do, and `--no-llm-labels`
 * makes zero labeller calls. (5) The three commands are actually wired to it.
 *
 * @module tests/backlog-work-unit-grouping
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { groupIntoWorkUnits, wantsWorkUnits, WORK_UNIT_DATE_KEYS } from '../scripts/lib/cross-skill/work-unit-grouping.mjs';
import { listUnlockedFixesCmd, listUnremediatedAcceptancesCmd } from '../scripts/lib/cross-skill/commands/ship.mjs';
import { finalReviewPendingCmd } from '../scripts/lib/cross-skill/commands/final-review.mjs';

/** Unit vectors in the plane — cosine is exactly cos(theta). */
const at = (deg) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];

/**
 * Five rows: A/B/C share a vector (one unit of 3), D is orthogonal (a
 * singleton unit), E has no embedding (unclustered). Every row carries a
 * SENSITIVE-looking `detail_snapshot` so the egress assertion has something
 * to catch.
 */
// `salt` makes the member ids — and so the unit KEY the label cache is keyed on —
// unique per call, so a labeller assertion cannot be satisfied by a cache hit
// left by an earlier test or an earlier run.
const ROWS = (dateKey, salt = '') => ['A', 'B', 'C', 'D', 'E'].map((id) => ({
  audit_finding_id: `id-${id}${salt}`,
  primary_file: `src/${id}.mjs`,
  category: '[Sustainability] Coupling Concern',
  severity: id === 'A' ? 'HIGH' : 'MEDIUM',
  detail_snapshot: `AKIAIOSFODNN7EXAMPLE secret-looking prose for ${id}`,
  [dateKey]: `2026-09-0${['A', 'B', 'C', 'D', 'E'].indexOf(id) + 1}T00:00:00Z`,
}));
const VECTORS = { get: (id) => ({ A: at(0), B: at(0), C: at(0), D: at(90) }[id.replace(/^id-/, '')[0]] ) };

function makeCtx({ flags = {}, labeller = undefined, deps = {} } = {}) {
  const seen = [];
  return {
    seen,
    cloud: { enabled: true },
    flag: (name) => flags[name] ?? null,
    hasFlag: (name) => flags[name] === true,
    payload: () => ({}),
    resolveScope: async () => ({ kind: 'scoped', repoId: 'repo-1', slug: 'owner/repo' }),
    deps: {
      getFindingEmbeddings: async () => VECTORS,
      workUnitLabeller: labeller ?? (async (unit) => { seen.push(unit); return 'a model-written label'; }),
      resolveNudgePage: () => ({ limit: 20, offset: 0 }),
      ...deps,
    },
  };
}

describe('groupIntoWorkUnits — one grouper, three date keys', () => {
  it('refuses an undeclared dateKey instead of guessing a column', async () => {
    await assert.rejects(
      () => groupIntoWorkUnits(makeCtx(), ROWS('fixed_at'), { total: 5, dateKey: 'updated_at' }),
      (e) => e instanceof TypeError && /dateKey must be one of/.test(e.message),
    );
    assert.deepEqual([...WORK_UNIT_DATE_KEYS], ['accepted_at', 'fixed_at', 'created_at']);
  });

  for (const dateKey of WORK_UNIT_DATE_KEYS) {
    it(`groups a ${dateKey} page: 3 identical rows form one unit, the orthogonal row is a singleton, the unembedded row is unclustered`, async () => {
      const ctx = makeCtx();
      const out = await groupIntoWorkUnits(ctx, ROWS(dateKey), { total: 5, dateKey });
      assert.equal(out.grouping.basis, 'work-unit');
      assert.equal(out.grouping.dateKey, dateKey);
      assert.equal(out.grouping.population, 5);
      assert.equal(out.grouping.clustered, 4);
      assert.equal(out.grouping.unclustered, 1);
      assert.deepEqual(out.grouping.unclusteredIds, ['id-E']);
      assert.equal(out.grouping.partial, false);
      const big = out.workUnits.find((u) => u.size === 3);
      assert.ok(big, 'the three identical vectors must share one unit');
      assert.deepEqual([...big.memberIds].sort(), ['id-A', 'id-B', 'id-C']);
      assert.deepEqual(big.severities, { HIGH: 1, MEDIUM: 2 });
      assert.equal(out.grouping.multiRowUnits, 1);
    });
  }

  it('partial is true when the page is smaller than the total — a short page must not read as the whole grouping', async () => {
    const out = await groupIntoWorkUnits(makeCtx(), ROWS('accepted_at'), { total: 40, dateKey: 'accepted_at' });
    assert.equal(out.grouping.partial, true);
  });

  it('--work-unit filters the rows to that unit by audit_finding_id, and reports an unknown key as not found', async () => {
    const all = await groupIntoWorkUnits(makeCtx(), ROWS('fixed_at'), { total: 5, dateKey: 'fixed_at' });
    const key = all.workUnits.find((u) => u.size === 3).key;
    const one = await groupIntoWorkUnits(makeCtx(), ROWS('fixed_at'), { total: 5, wantUnit: key, dateKey: 'fixed_at' });
    assert.deepEqual(one.rows.map((r) => r.audit_finding_id).sort(), ['id-A', 'id-B', 'id-C']);
    assert.equal(one.shown, 3);
    assert.deepEqual(one.workUnitFilter, { key, found: true, label: 'a model-written label' });

    const none = await groupIntoWorkUnits(makeCtx(), ROWS('fixed_at'), { total: 5, wantUnit: 'nope', dateKey: 'fixed_at' });
    assert.deepEqual(none.rows, []);
    assert.deepEqual(none.workUnitFilter, { key: 'nope', found: false });
  });
});

describe('groupIntoWorkUnits — label egress', () => {
  it('members handed to the labeller carry NO detail / detail_snapshot, even though every row has one', async () => {
    const ctx = makeCtx();
    const salt = `-${Date.now().toString(36)}-${process.pid}`;
    await groupIntoWorkUnits(ctx, ROWS('created_at', salt), { total: 5, dateKey: 'created_at' });
    assert.ok(ctx.seen.length >= 1, 'the multi-row unit must reach the labeller');
    for (const unit of ctx.seen) {
      for (const m of unit.members) {
        assert.equal('detail' in m, false, `member ${m.id} must not carry detail`);
        assert.equal('detail_snapshot' in m, false, `member ${m.id} must not carry detail_snapshot`);
        assert.deepEqual(Object.keys(m).sort(), ['category', 'createdAt', 'embedding', 'id', 'primaryFile', 'severity']);
      }
    }
    const text = JSON.stringify(ctx.seen);
    assert.equal(text.includes('AKIAIOSFODNN7EXAMPLE'), false, 'the sensitive prose must not reach the labeller in any field');
  });

  it('--no-llm-labels makes zero labeller calls and reports reason "disabled"', async () => {
    const ctx = makeCtx({ flags: { 'no-llm-labels': true } });
    const out = await groupIntoWorkUnits(ctx, ROWS('created_at'), { total: 5, dateKey: 'created_at' });
    assert.equal(ctx.seen.length, 0);
    assert.equal(out.grouping.labels.reason, 'disabled');
    assert.equal(out.grouping.labels.llm, 0);
  });
});

describe('wantsWorkUnits — the shared flag tail', () => {
  it('is null without flags, on for --group-by work-unit, and --work-unit implies it', () => {
    assert.equal(wantsWorkUnits(makeCtx()), null);
    assert.deepEqual(wantsWorkUnits(makeCtx({ flags: { 'group-by': 'work-unit' } })), { wantUnit: null });
    assert.deepEqual(wantsWorkUnits(makeCtx({ flags: { 'work-unit': 'k1' } })), { wantUnit: 'k1' });
    assert.equal(wantsWorkUnits(makeCtx({ flags: { 'group-by': 'file' } })), null);
  });
});

describe('all three readers are wired to the ONE grouper, each with its own dateKey', () => {
  const rowsFor = (dateKey) => ROWS(dateKey);

  it('list-unlocked-fixes → fixed_at', async () => {
    const ctx = makeCtx({ flags: { 'group-by': 'work-unit' }, deps: {
      getUnlockedFixes: async () => rowsFor('fixed_at'),
      countUnlockedFixes: async () => ({ total: 5, code: 5, plan: 0 }),
      countAgedUnlockedFixes: async () => ({ agedOut: 0, byMode: { code: 0, plan: 0 }, prePractice: 0, practiceStart: null }),
      getRecordedSpecPaths: async () => [],
    } });
    const out = await listUnlockedFixesCmd(ctx);
    assert.equal(out.grouping.basis, 'work-unit');
    assert.equal(out.grouping.dateKey, 'fixed_at');
    assert.equal(out.workUnits.some((u) => u.size === 3), true);
  });

  it('list-unremediated-acceptances → accepted_at', async () => {
    const ctx = makeCtx({ flags: { 'group-by': 'work-unit' }, deps: {
      getUnremediatedAcceptances: async () => rowsFor('accepted_at'),
      countUnremediatedAcceptances: async () => ({ total: 5, code: 5, plan: 0 }),
      countAgedUnremediatedAcceptances: async () => ({ agedOut: 0, byMode: { code: 0, plan: 0 }, bySeverity: {}, notYetDue: 0, prePractice: 0, practiceStart: null }),
      countAcceptedPermanent: async () => 0,
    } });
    const out = await listUnremediatedAcceptancesCmd(ctx);
    assert.equal(out.grouping.dateKey, 'accepted_at');
    assert.equal(out.workUnits.some((u) => u.size === 3), true);
  });

  it('final-review-pending → created_at, over the ACTIONABLE rows of the page', async () => {
    const queue = rowsFor('created_at').map((r, i) => ({
      ...r, run_id: 'run-1', finding_fingerprint: `fp${i}`, bucket: 'shadow-only',
      user_action: null, remediation_state: null, severity_rank: r.severity === 'HIGH' ? 3 : 2,
      created_at_cursor: r.created_at,
    }));
    const ctx = makeCtx({ flags: { repo: 'owner/repo', 'group-by': 'work-unit' }, deps: {
      getFinalReviewStats: async () => ({ ok: true, pendingQueue: queue, actionablePairs: [{ user_action: null, remediation_state: null, n: 5 }] }),
    } });
    const out = await finalReviewPendingCmd(ctx);
    assert.equal(out.state, 'ready');
    assert.equal(out.grouping.dateKey, 'created_at');
    assert.equal(out.grouping.population, 5);
    assert.equal(out.workUnits.some((u) => u.size === 3), true);
  });
});
