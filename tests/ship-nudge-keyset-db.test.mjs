/**
 * @fileoverview The SQL half of keyset paging for the /ship-nudge readers
 * (`getUnlockedFixes`, `getUnremediatedAcceptances`) — against real Postgres.
 *
 * The defect (audit finding 5fbd8fec): /ship's workflow closes rows between
 * page reads, and `OFFSET` counts positions in a set that has since shrunk, so
 * page 2 skipped one unread row per row closed on page 1. The cursor predicate
 * continues strictly after the last row READ, which a removed row cannot move.
 *
 * Pinned both ways on one seeded fixture: the offset read DOES skip (the
 * instrument can see a skip — without that, "the cursor read skipped nothing"
 * would be vacuous), and the cursor read does not. Ties are deliberate: several
 * findings share one run, so they share `fixed_at`/`accepted_at` and only the
 * `audit_finding_id` tiebreak orders them — the case a timestamp-only cursor
 * gets wrong.
 *
 * Every SQL literal branch is exercised (repo-scoped and all-repos, windowed and
 * `allAges`): each binds the cursor at different `$n` positions.
 *
 * INC-002: gated on `assertDisposableDbUrl`, never on "is AUDIT_DB_TEST_URL set".
 * Two edits, always — enrolled in db-test-container.mjs AND postgres-parity.yml.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

describe('nudge readers — keyset paging survives rows closed between reads (disposable DB)', { skip }, () => {
  let pool, nudges, ship, savedUrl, repoId;

  /** One run (shared timestamp) holding `n` findings of the given shape. */
  async function seedRun({ ageDays, n, severity, outcome = 'accepted', remediation = null }) {
    const { rows: [run] } = await pool.query(
      `INSERT INTO audit_runs (repo_id, mode, plan_file, commit_sha, created_at)
       VALUES ($1, 'code', 'docs/plans/keyset-fixture.md', $2, now() - ($3 || ' days')::interval) RETURNING id`,
      [repoId, crypto.randomUUID().slice(0, 12), String(ageDays)],
    );
    for (let i = 0; i < n; i++) {
      await pool.query(
        `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, primary_file,
           detail_snapshot, adjudication_outcome, remediation_state)
         VALUES ($1, $2, 'backend', $3, 'keyset', 'a.mjs', 'd', $4, $5)`,
        [run.id, crypto.randomUUID().slice(0, 8), severity, outcome, remediation],
      );
    }
  }

  const ids = (rows) => rows.map((r) => r.audit_finding_id);
  const cursorOf = (kind, row) => ship.decodeNudgeCursor(kind, ship.encodeNudgeCursor(kind, row));

  before(async () => {
    const client = await import('../scripts/lib/db/client.mjs');
    savedUrl = process.env.AUDIT_DB_URL;
    client.assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await client._resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    pool = await client.getPool();
    nudges = await import('../scripts/lib/store/ship-nudges.mjs');
    ship = await import('../scripts/lib/cross-skill/commands/ship.mjs');
    const { upsertRepoByUuid } = await import('../scripts/lib/store/repo.mjs');
    repoId = (await upsertRepoByUuid({ repoUuid: `keyset-${crypto.randomUUID()}`, name: 'keyset-test-repo', fingerprint: null })).id;
    // Inside both windows (unlocked: < 14d recent; unremediated: past the 7d floor).
    await seedRun({ ageDays: 10, n: 4, severity: 'HIGH', remediation: 'fixed' });
    await seedRun({ ageDays: 11, n: 3, severity: 'HIGH', remediation: 'fixed' });
    await seedRun({ ageDays: 10, n: 3, severity: 'HIGH' });
    await seedRun({ ageDays: 11, n: 3, severity: 'MEDIUM' });
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM audit_findings WHERE run_id IN (SELECT id FROM audit_runs WHERE repo_id = $1)`, [repoId]);
    await pool.query(`DELETE FROM audit_runs WHERE repo_id = $1`, [repoId]);
    await pool.query(`DELETE FROM audit_repos WHERE id = $1`, [repoId]);
    const client = await import('../scripts/lib/db/client.mjs');
    await client.closePool();
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = savedUrl;
  });

  for (const allAges of [false, true]) {
    it(`unremediated (${allAges ? 'allAges' : 'windowed'}): closing page 1 makes OFFSET skip; the cursor does not`, async () => {
      const read = (opts) => nudges.getUnremediatedAcceptances({ repoId }, { limit: 2, allAges, ...opts });
      const before = ids(await nudges.getUnremediatedAcceptances({ repoId }, { limit: 200, allAges }));
      assert.equal(before.length, 6, 'fixture: six open acceptances (3 HIGH, 3 MEDIUM)');
      const page1 = await read({});
      assert.deepEqual(ids(page1), before.slice(0, 2));
      // Before any close: the cursor really continues (a reader that IGNORED
      // `after` would pass the post-close assertion below by returning the new
      // first page, which happens to be the right answer there).
      assert.deepEqual(ids(await read({ after: cursorOf('unremediated', page1[1]) })), before.slice(2, 4));
      // Close page 1 the way /ship does — the rows leave the view.
      await pool.query(`UPDATE audit_findings SET remediation_state = 'fixed' WHERE id = ANY($1::uuid[])`, [ids(page1)]);
      try {
        const viaOffset = ids(await read({ offset: 2 }));
        assert.deepEqual(viaOffset, before.slice(4, 6), 'control: OFFSET skips the two rows that moved up');
        const viaCursor = ids(await read({ after: cursorOf('unremediated', page1[1]) }));
        assert.deepEqual(viaCursor, before.slice(2, 4), 'the cursor continues exactly after the last row read');
      } finally {
        await pool.query(`UPDATE audit_findings SET remediation_state = NULL WHERE id = ANY($1::uuid[])`, [ids(page1)]);
      }
    });

    it(`unremediated all-repos (${allAges ? 'allAges' : 'windowed'}): page 2 by cursor is the next slice of one long read`, async () => {
      const full = await nudges.getUnremediatedAcceptances({ allRepos: true }, { limit: 200, allAges });
      assert.ok(full.length >= 4, 'fixture rows are visible across all repos');
      const p2 = await nudges.getUnremediatedAcceptances({ allRepos: true }, { limit: 2, allAges, after: cursorOf('unremediated', full[1]) });
      assert.deepEqual(ids(p2), ids(full.slice(2, 4)));
    });

    it(`unlocked (${allAges ? 'allAges' : 'windowed'}): closing page 1 makes OFFSET skip; the cursor does not — across a fixed_at tie`, async () => {
      const read = (opts) => nudges.getUnlockedFixes({ repoId }, { limit: 3, allAges, ...opts });
      const before = ids(await nudges.getUnlockedFixes({ repoId }, { limit: 200, allAges }));
      assert.equal(before.length, 7, 'fixture: seven unlocked HIGH fixes in two runs');
      const page1 = await read({});
      assert.deepEqual(ids(await read({ after: cursorOf('unlocked', page1[2]) })), before.slice(3, 6),
        'before any close: the cursor continues inside the tie');
      await pool.query(`UPDATE audit_findings SET remediation_state = 'regressed' WHERE id = ANY($1::uuid[])`, [ids(page1)]);
      try {
        assert.deepEqual(ids(await read({ offset: 3 })), before.slice(6, 7), 'control: OFFSET skips');
        assert.deepEqual(ids(await read({ after: cursorOf('unlocked', page1[2]) })), before.slice(3, 6),
          'page 1 ended INSIDE the four-way fixed_at tie; the cursor resumes on the id tiebreak');
      } finally {
        await pool.query(`UPDATE audit_findings SET remediation_state = 'fixed' WHERE id = ANY($1::uuid[])`, [ids(page1)]);
      }
    });
  }

  it('unlocked all-repos: page 2 by cursor is the next slice of one long read', async () => {
    const full = await nudges.getUnlockedFixes({ allRepos: true }, { limit: 200, allAges: true });
    const p2 = await nudges.getUnlockedFixes({ allRepos: true }, { limit: 2, allAges: true, after: cursorOf('unlocked', full[1]) });
    assert.deepEqual(ids(p2), ids(full.slice(2, 4)));
  });

  // A REAL failed query, no stub: an out-of-domain cursor member (which `decodeNudgeCursor` would
  // refuse, so it can only arrive here from a caller that skips it) makes Postgres reject the
  // cast with 22007. By default the reader swallows that into `[]` — the nudge callers want the
  // never-throw degrade — but to a cursor walk `[]` is indistinguishable from the end of the
  // list, so `strict` must surface it.
  const BAD_TS = 'not-a-timestamp';
  const FAILING = [
    ['getUnlockedFixes', { fixedAt: BAD_TS, findingId: '11111111-1111-4111-8111-111111111111' }],
    ['getUnremediatedAcceptances', { severityRank: 0, acceptedAt: BAD_TS, findingId: '11111111-1111-4111-8111-111111111111' }],
  ];
  for (const [reader, after] of FAILING) {
    it(`${reader}: a failed query degrades to [] by default (the nudge contract)…`, async () => {
      const { captureStderr } = await import('./helpers/capture-stderr.mjs');
      const { result, text } = await captureStderr(() => nudges[reader]({ repoId }, { limit: 2, after }));
      assert.deepEqual(result, []);
      assert.match(text, new RegExp(`${reader} failed`), 'the degrade is still LOUD on stderr');
    });

    it(`${reader}: …and with strict it THROWS, so a paging caller cannot read it as the end of the list`, async () => {
      const { captureStderr } = await import('./helpers/capture-stderr.mjs');
      let thrown;
      await captureStderr(async () => {
        try { await nudges[reader]({ repoId }, { limit: 2, after, strict: true }); } catch (e) { thrown = e; }
      });
      assert.ok(thrown, 'strict must rethrow the Postgres error');
      assert.equal(thrown.code, '22007', 'the real SQLSTATE for an invalid timestamp reaches the caller');
    });
  }
});
