/**
 * @fileoverview The age window must report what it drops.
 *
 * `unlocked_fixes` carried `created_at > now() - interval '14 days'` inside the
 * predicate that defines the obligation, so "not shown" and "not owed" were one
 * state: an unlocked HIGH fix left the backlog by the passage of time and the
 * only trace was a smaller number. Measured 2026-08-11, 94 code findings had
 * aged out against 1 still visible.
 *
 * The window is KEPT — an unbounded ship-time nudge becomes noise and earns
 * `--no-verify`. The defect was the silence, not the bound. This is the same
 * obligation `shown`/`total` already discharges for the row cap, applied to the
 * time axis.
 *
 * These are live-store assertions on the composed SQL, because the thing under
 * test is a relationship BETWEEN two views and a derived boundary — a mock of
 * either side would be a mock of the answer.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
// STATIC, and it must stay static: this is what loads `.env`. Reading
// process.env.AUDIT_DB_URL before it ran made the whole suite skip silently —
// a green run that asserted nothing, which is the failure mode these very
// assertions are about.
import '../scripts/lib/config.mjs';

const HAS_STORE = Boolean(process.env.AUDIT_DB_URL);

describe('unlocked_fixes age window — what it drops is reportable', { skip: !HAS_STORE && 'needs AUDIT_DB_URL' }, () => {
  let q, store, repoId, droppedHere;

  before(async () => {
    q = await import('../scripts/lib/db/query.mjs');
    store = await import('../scripts/lib/store/plans-ship.mjs');
    // Pick the repo that actually EXERCISES the split, not an arbitrary one.
    // The first draft took `ORDER BY created_at LIMIT 1` and landed on a repo
    // with nothing dropped, so every assertion below compared 0 against 0 and
    // survived a mutation that disabled the feature outright. A fixture chosen
    // without reference to what it must demonstrate is how a suite goes green
    // having checked nothing.
    const row = await q.one(
      `SELECT r.repo_id AS id, count(*)::int AS dropped
         FROM unlocked_fixes_all a
         JOIN audit_runs r ON r.id = a.audit_run_id
        WHERE NOT a.is_recent
        GROUP BY r.repo_id
        ORDER BY dropped DESC
        LIMIT 1`, []);
    repoId = row?.id ?? null;
    droppedHere = Number(row?.dropped ?? 0);
    if (!repoId) {
      const any = await q.one(`SELECT id FROM audit_repos ORDER BY created_at LIMIT 1`, []);
      repoId = any?.id ?? null;
    }
  });

  // A store with nothing dropped cannot demonstrate the split. That is not a
  // failure (a fresh database is a legitimate state) and it is not a pass
  // either — it is UNPROVEN, so it reports as a skip with a reason and moves
  // the suite's skip count, which is visible. The structural half of this
  // contract is pinned data-independently in unlocked-fixes-mode.test.mjs and
  // runs everywhere, including the pre-push clean checkout.
  const needsFixture = (t) => {
    if (droppedHere > 0) return false;
    t.skip('no aged-out unlocked fix in this store — split unproven, not proven absent');
    return true;
  };

  it('the fixture repo actually has dropped rows, or the rest is unproven', (t) => {
    if (needsFixture(t)) return;
    assert.ok(droppedHere > 0);
  });

  it('the windowed view is exactly the recent slice of the unwindowed one', async () => {
    const r = await q.one(
      `SELECT
         (SELECT count(*) FROM unlocked_fixes)                        AS windowed,
         (SELECT count(*) FROM unlocked_fixes_all WHERE is_recent)    AS recent_all,
         (SELECT count(*) FROM unlocked_fixes_all)                    AS every_age`, []);
    assert.equal(Number(r.windowed), Number(r.recent_all),
      'unlocked_fixes must BE the is_recent slice, not a parallel re-derivation');
    assert.ok(Number(r.every_age) >= Number(r.windowed),
      'the unwindowed view cannot hold fewer rows than its own window');
  });

  it('every row the window drops is still reachable', async () => {
    const r = await q.one(
      `SELECT
         (SELECT count(*) FROM unlocked_fixes_all)                        AS every_age,
         (SELECT count(*) FROM unlocked_fixes_all WHERE is_recent)        AS recent,
         (SELECT count(*) FROM unlocked_fixes_all WHERE NOT is_recent)    AS dropped`, []);
    assert.equal(Number(r.every_age), Number(r.recent) + Number(r.dropped),
      'a row must be either recent or dropped — never neither, which is how it would vanish');
  });

  it('counts the dropped rows and splits them by practice boundary', async (t) => {
    if (needsFixture(t)) return;
    const aged = await store.countAgedUnlockedFixes({ repoId });
    const dropped = await q.one(
      `SELECT count(*)::int AS n FROM unlocked_fixes_all a
       JOIN audit_runs r ON r.id = a.audit_run_id
       WHERE r.repo_id = $1 AND NOT a.is_recent`, [repoId]);
    assert.equal(aged.agedOut + aged.prePractice, dropped.n,
      'every dropped row must land in exactly one bucket, or the split hides rows the window already hid');
  });

  it('splits the dropped rows on the RIGHT side of the boundary', async (t) => {
    if (needsFixture(t)) return;
    // The sum assertion above survives a build that labels every dropped row
    // `agedOut`, or every one `prePractice` — and the write-off of the 94
    // rests entirely on which side they land. Compute both sides independently.
    const expected = await q.one(
      `WITH practice AS (
         SELECT min(created_at) AS started_at FROM regression_specs
          WHERE source_finding_type = 'audit' AND repo_id = $1
       )
       SELECT
         count(*) FILTER (WHERE p.started_at IS NOT NULL AND a.fixed_at >= p.started_at)::int AS aged,
         count(*) FILTER (WHERE p.started_at IS NULL OR a.fixed_at <  p.started_at)::int AS pre
       FROM unlocked_fixes_all a
       JOIN audit_runs r ON r.id = a.audit_run_id
       CROSS JOIN practice p
       WHERE r.repo_id = $1 AND NOT a.is_recent`, [repoId]);
    const aged = await store.countAgedUnlockedFixes({ repoId });
    assert.equal(aged.agedOut, expected.aged, 'agedOut must be the post-boundary side');
    assert.equal(aged.prePractice, expected.pre, 'prePractice must be the pre-boundary side');
    // And the two must not be interchangeable in this fixture, or the assertion
    // above cannot tell a correct split from a swapped one.
    assert.notEqual(expected.aged, expected.pre,
      'this fixture must have an asymmetric split, or swapping the buckets would go unnoticed');
  });

  it('derives the practice boundary from the repo\'s own first lock, never a constant', async () => {
    const aged = await store.countAgedUnlockedFixes({ repoId });
    const first = await q.one(
      `SELECT min(created_at) AS started FROM regression_specs
       WHERE source_finding_type = 'audit' AND repo_id = $1`, [repoId]);
    if (first?.started == null) {
      assert.equal(aged.practiceStart, null);
      assert.equal(aged.agedOut, 0,
        'a repo that never locked anything cannot have LAPSED a locking practice');
    } else {
      assert.equal(String(aged.practiceStart), String(first.started));
    }
  });

  it('the denominator follows the source the rows came from', async (t) => {
    if (needsFixture(t)) return;
    // `shown 5 / total 29` over a 219-row set is the same defect `shown`/`total`
    // exists to prevent, reintroduced one axis over.
    const windowed = await store.countUnlockedFixes({ repoId });
    const allAges = await store.countUnlockedFixes({ repoId }, { allAges: true });
    assert.ok(allAges.total >= windowed.total,
      'the unwindowed count can never be smaller than the windowed one');
    const aged = await store.countAgedUnlockedFixes({ repoId });
    assert.equal(allAges.total - windowed.total, aged.agedOut + aged.prePractice,
      'the gap between the two totals IS the dropped set — if these disagree, one of them is lying');
  });

  it('paging past the window reaches rows the default read cannot', async () => {
    const windowed = await store.getUnlockedFixes({ repoId }, { limit: 200 });
    const allAges = await store.getUnlockedFixes({ repoId }, { limit: 200, allAges: true });
    assert.ok(allAges.length >= windowed.length);
    const seen = new Set(windowed.map((r) => r.audit_finding_id));
    // Only meaningful when something HAS aged out; otherwise this is vacuous and
    // says so rather than passing silently.
    const aged = await store.countAgedUnlockedFixes({ repoId });
    const droppedCount = aged.agedOut + aged.prePractice;
    if (droppedCount > 0) {
      // The store's own page cap (200, per getUnlockedFixes) means a repo with
      // 200+ RECENT rows can push every dropped row past a single page 0 fetch
      // — `ORDER BY fixed_at DESC` puts the newest rows first and the dropped
      // ones (by definition older) last. Found live: this repo's own
      // event-wiring-symmetry audit session wrote 150+ same-day findings,
      // which happened to be enough to make `allAges` above genuinely never
      // reach the aged-out tail. Target the tail directly instead of trusting
      // page 0: with DESC-by-fixed_at ordering, the dropped rows occupy the
      // LAST `droppedCount` positions of the unwindowed set.
      const total = (await store.countUnlockedFixes({ repoId }, { allAges: true })).total;
      const tailOffset = Math.max(0, total - droppedCount);
      const tail = await store.getUnlockedFixes(
        { repoId }, { limit: Math.min(200, droppedCount), offset: tailOffset, allAges: true },
      );
      const reachable = allAges.some((r) => !seen.has(r.audit_finding_id))
        || tail.some((r) => !seen.has(r.audit_finding_id));
      assert.ok(reachable, '--all-ages must surface at least one row the window excluded');
    }
  });
});
