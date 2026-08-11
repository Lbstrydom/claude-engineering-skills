/**
 * @fileoverview The two age bounds must report what they exclude — separately.
 *
 * Sibling of tests/unlocked-fixes-aged-visibility.test.mjs, with the difference
 * that makes this view its own problem: `unremediated_acceptances` carried TWO
 * time bounds doing OPPOSITE jobs, and both presented as "not shown".
 *
 *   - the 7-day floor is a MATURITY delay — the row appears on its own later;
 *   - the 30-day ceiling is a FORGETTING mechanism — the row never appears again.
 *
 * Reporting them as one number would be the specific error this view invites,
 * so the assertions below pin that they stay separate and that `notYetDue` is
 * never folded into `agedOut`.
 *
 * Measured 2026-08-11: agedOut 0, but 201 live obligations with the first 31
 * (8 HIGH) due to expire five days later. Instrumented before the first loss,
 * unlike the sibling, where 94 rows had already gone.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
// STATIC — this is what loads `.env`. Reading process.env before it ran made
// the sibling suite skip silently, asserting nothing.
import '../scripts/lib/config.mjs';

const HAS_STORE = Boolean(process.env.AUDIT_DB_URL);

describe('unremediated_acceptances age bounds — floor and ceiling are not the same thing',
  { skip: !HAS_STORE && 'needs AUDIT_DB_URL' }, () => {
    let q, store, repoId, excludedHere;

    before(async () => {
      q = await import('../scripts/lib/db/query.mjs');
      store = await import('../scripts/lib/store/plans-ship.mjs');
      // Pick the repo that actually exercises the split — an arbitrary one
      // compares 0 against 0 and survives a mutation disabling the feature.
      const row = await q.one(
        `SELECT repo_id AS id, count(*)::int AS excluded
           FROM unremediated_acceptances_all
          WHERE NOT (is_mature AND is_recent)
          GROUP BY repo_id ORDER BY excluded DESC LIMIT 1`, []);
      repoId = row?.id ?? null;
      excludedHere = Number(row?.excluded ?? 0);
      if (!repoId) {
        const any = await q.one(`SELECT id FROM audit_repos ORDER BY created_at LIMIT 1`, []);
        repoId = any?.id ?? null;
      }
    });

    const needsFixture = (t) => {
      if (excludedHere > 0) return false;
      t.skip('no excluded row in this store — split unproven, not proven absent');
      return true;
    };

    // A SECOND, stricter fixture requirement. `excludedHere` counts under-floor
    // rows too, and on 2026-08-11 this store had 60 of those and ZERO over the
    // ceiling — so the practice-boundary assertions compared 0 against 0 and
    // would have survived swapping the buckets outright. A guard that admits a
    // fixture which cannot demonstrate the property is the vacuous pass, one
    // level up from the assertion.
    let overCeilingHere = null;
    const needsOverCeiling = async (t) => {
      if (overCeilingHere === null) {
        const r = await q.one(
          `SELECT count(*)::int AS n FROM unremediated_acceptances_all
            WHERE repo_id = $1 AND is_mature AND NOT is_recent`, [repoId]);
        overCeilingHere = Number(r?.n ?? 0);
      }
      if (overCeilingHere > 0) return false;
      t.skip('no row has passed the 30-day ceiling yet — practice split unproven, not proven correct');
      return true;
    };

    it('the fixture repo actually has excluded rows, or the rest is unproven', (t) => {
      if (needsFixture(t)) return;
      assert.ok(excludedHere > 0);
    });

    it('the visible view is exactly the mature-AND-recent slice', async () => {
      const r = await q.one(
        `SELECT
           (SELECT count(*) FROM unremediated_acceptances)                            AS visible,
           (SELECT count(*) FROM unremediated_acceptances_all
             WHERE is_mature AND is_recent)                                           AS both,
           (SELECT count(*) FROM unremediated_acceptances_all)                        AS every_age`, []);
      assert.equal(Number(r.visible), Number(r.both),
        'unremediated_acceptances must BE the slice, not a parallel re-derivation');
      assert.ok(Number(r.every_age) >= Number(r.visible));
    });

    it('every excluded row is still reachable, and lands in exactly one bucket', async (t) => {
      if (needsFixture(t)) return;
      const r = await q.one(
        `SELECT
           count(*)::int AS every_age,
           count(*) FILTER (WHERE is_mature AND is_recent)::int      AS visible,
           count(*) FILTER (WHERE NOT is_mature)::int                AS under_floor,
           count(*) FILTER (WHERE is_mature AND NOT is_recent)::int  AS over_ceiling
         FROM unremediated_acceptances_all WHERE repo_id = $1`, [repoId]);
      assert.equal(r.every_age, r.visible + r.under_floor + r.over_ceiling,
        'a row must be visible, under the floor, or over the ceiling — never none of them');
    });

    it('the floor is NOT counted as a loss', async (t) => {
      if (needsFixture(t)) return;
      const aged = await store.countAgedUnremediatedAcceptances({ repoId });
      const under = await q.one(
        `SELECT count(*)::int AS n FROM unremediated_acceptances_all
          WHERE repo_id = $1 AND NOT is_mature`, [repoId]);
      assert.equal(aged.notYetDue, under.n, 'notYetDue must be exactly the under-floor set');
      // The whole point: a maturity delay is not a forgetting mechanism.
      const overCeiling = await q.one(
        `SELECT count(*)::int AS n FROM unremediated_acceptances_all
          WHERE repo_id = $1 AND is_mature AND NOT is_recent`, [repoId]);
      assert.equal(aged.agedOut + aged.prePractice, overCeiling.n,
        'agedOut+prePractice must be exactly the over-ceiling set — the floor must not leak in');
      if (under.n > 0 && overCeiling.n === 0) {
        assert.equal(aged.agedOut, 0,
          'rows under the floor were counted as aged out — the two bounds have been conflated');
      }
    });

    it('splits the over-ceiling rows on the RIGHT side of the practice boundary', async (t) => {
      if (needsFixture(t)) return;
      if (await needsOverCeiling(t)) return;
      const expected = await q.one(
        `WITH practice AS (
           SELECT min(e.created_at) AS started_at
             FROM finding_adjudication_events e
             JOIN audit_findings f2 ON f2.id = e.finding_id
             JOIN audit_runs r2 ON r2.id = f2.run_id
            WHERE e.remediation_state IN ('fixed','verified') AND r2.repo_id = $1
         )
         SELECT
           count(*) FILTER (WHERE p.started_at IS NOT NULL AND a.accepted_at >= p.started_at)::int AS aged,
           count(*) FILTER (WHERE p.started_at IS NULL OR a.accepted_at < p.started_at)::int AS pre
         FROM unremediated_acceptances_all a CROSS JOIN practice p
         WHERE a.repo_id = $1 AND a.is_mature AND NOT a.is_recent`, [repoId]);
      const aged = await store.countAgedUnremediatedAcceptances({ repoId });
      assert.equal(aged.agedOut, expected.aged);
      assert.equal(aged.prePractice, expected.pre);
    });

    it('derives the practice boundary from recorded remediations, never a constant', async () => {
      const aged = await store.countAgedUnremediatedAcceptances({ repoId });
      const first = await q.one(
        `SELECT min(e.created_at) AS started
           FROM finding_adjudication_events e
           JOIN audit_findings f2 ON f2.id = e.finding_id
           JOIN audit_runs r2 ON r2.id = f2.run_id
          WHERE e.remediation_state IN ('fixed','verified') AND r2.repo_id = $1`, [repoId]);
      if (first?.started == null) {
        assert.equal(aged.practiceStart, null);
        assert.equal(aged.agedOut, 0,
          'a repo that never recorded a remediation cannot have LAPSED the practice');
      } else {
        assert.equal(String(aged.practiceStart), String(first.started));
      }
    });

    it('the denominator follows the source the rows came from', async (t) => {
      if (needsFixture(t)) return;
      const windowed = await store.countUnremediatedAcceptances({ repoId });
      const allAges = await store.countUnremediatedAcceptances({ repoId }, { allAges: true });
      assert.ok(allAges.total >= windowed.total);
      const aged = await store.countAgedUnremediatedAcceptances({ repoId });
      assert.equal(allAges.total - windowed.total, aged.agedOut + aged.prePractice + aged.notYetDue,
        'the gap between the two totals IS the excluded set — if these disagree, one is lying');
    });

    it('--all-ages reaches rows the default read cannot', async (t) => {
      if (needsFixture(t)) return;
      const windowed = await store.getUnremediatedAcceptances({ repoId }, { limit: 400 });
      const allAges = await store.getUnremediatedAcceptances({ repoId }, { limit: 400, allAges: true });
      assert.ok(allAges.length >= windowed.length);
      const seen = new Set(windowed.map((r) => r.audit_finding_id));
      assert.ok(allAges.some((r) => !seen.has(r.audit_finding_id)),
        '--all-ages must surface at least one row the bounds excluded');
    });
  });
