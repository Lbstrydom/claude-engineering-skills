/**
 * @fileoverview A /ship-nudge row must carry the SAME mode its own count is
 * computed from — against real Postgres.
 *
 * The defect (measured 2026-11-13 against the live store, repo
 * `6461a693-6690-4bf3-98ee-14c0385cc357`): `countUnlockedFixes` /
 * `countUnremediatedAcceptances` bucket by `EFFECTIVE_MODE_SQL` (the read-side
 * correction for rows recorded `audit_mode = 'code'` whose `primary_file` is a
 * prose section reference, not a path), while the views project the RECORDED
 * `audit_mode` and the readers passed it through unchanged. A consumer paging
 * the listing therefore had only `audit_mode` to classify by, and got a
 * different answer from the card's own count.
 *
 * Measured that day: 91 rows listed, 66 with `audit_mode === 'code'`, against
 * `byMode.code` 65. One row — `2e68fc2f`, whose `primary_file` is a comma-and-
 * em-dash prose phrase naming six skills — is `code` on the recorded axis and
 * `plan` on the effective one. `docs/plans/standing-queue-burndown.md`'s pass-3
 * record hit the same shape at 83 vs 82 and could not reconcile it.
 *
 * `ship-nudges.mjs` already warned that the count and the `--mode` FILTER "must
 * move together or not at all"; the row PROJECTION was the third place and was
 * left behind. The fix projects `effective_mode` from the one oracle, so the
 * listing is reconcilable with the count without the reader re-deriving the
 * rule.
 *
 * **Negative control, in each test**: the seeded row must still read
 * `audit_mode === 'code'`, and folding by that column must NOT reconcile.
 * Without it, a fixture whose two columns happened to agree would pass while
 * proving nothing.
 *
 * INC-002: gated on `assertDisposableDbUrl`, never on "is AUDIT_DB_TEST_URL set".
 * Two edits, always — enrolled in db-test-container.mjs AND postgres-parity.yml.
 *
 * @module tests/nudge-row-effective-mode-db
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

/** A `primary_file` the code-path pattern rejects — the real shape, prose with spaces. */
const PROSE_FILE = 'skills/plan, click-test and nav-audit - worktree preflights';
const REAL_FILE = 'scripts/lib/store/ship-nudges.mjs';

describe('nudge rows carry the effective mode their counts use (disposable DB)', { skip }, () => {
  let pool, nudges, savedUrl, repoId;

  /** One run holding one finding of the given shape, shaped for BOTH views. */
  async function seedFinding({ primaryFile, remediation }) {
    const { rows: [run] } = await pool.query(
      `INSERT INTO audit_runs (repo_id, mode, plan_file, commit_sha, created_at)
       VALUES ($1, 'code', 'docs/plans/effective-mode-fixture.md', $2, now() - interval '10 days') RETURNING id`,
      [repoId, crypto.randomUUID().slice(0, 12)],
    );
    await pool.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, primary_file,
         detail_snapshot, adjudication_outcome, remediation_state)
       VALUES ($1, $2, 'backend', 'HIGH', 'effective-mode', $3, 'd', 'accepted', $4)`,
      [run.id, crypto.randomUUID().slice(0, 8), primaryFile, remediation],
    );
  }

  before(async () => {
    const client = await import('../scripts/lib/db/client.mjs');
    savedUrl = process.env.AUDIT_DB_URL;
    client.assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await client._resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    pool = await client.getPool();
    nudges = await import('../scripts/lib/store/ship-nudges.mjs');
    const { upsertRepoByUuid } = await import('../scripts/lib/store/repo.mjs');
    repoId = (await upsertRepoByUuid({
      repoUuid: `effmode-${crypto.randomUUID()}`, name: 'effective-mode-test-repo', fingerprint: null,
    })).id;
    // `fixed` lands in unlocked_fixes (Q1); NULL remediation lands in
    // unremediated_acceptances (Q2). One prose-path and one real-path row each,
    // so both modes are populated and the split is non-degenerate.
    await seedFinding({ primaryFile: PROSE_FILE, remediation: 'fixed' });
    await seedFinding({ primaryFile: REAL_FILE, remediation: 'fixed' });
    await seedFinding({ primaryFile: PROSE_FILE, remediation: null });
    await seedFinding({ primaryFile: REAL_FILE, remediation: null });
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

  /** The reconciliation a /ship consumer performs: fold the listing, compare to the count. */
  function assertReconciles(rows, counts, label) {
    // Negative control first: the fixture must actually contain the disagreement.
    const recordedCode = rows.filter((r) => r.audit_mode === 'code');
    assert.equal(recordedCode.length, 2, `${label}: fixture has two rows recorded as code`);
    assert.ok(
      rows.some((r) => r.primary_file === PROSE_FILE),
      `${label}: fixture includes the prose-path row the two axes disagree on`,
    );
    for (const r of rows) {
      assert.ok(r.effective_mode === 'code' || r.effective_mode === 'plan',
        `${label}: every row projects an effective_mode`);
    }
    const foldedCode = rows.filter((r) => r.effective_mode === 'code').length;
    const foldedPlan = rows.filter((r) => r.effective_mode === 'plan').length;
    assert.equal(foldedCode, 1, `${label}: only the real-path row is effectively code`);
    assert.equal(foldedCode, counts.code, `${label}: the listing folds to the card's code count`);
    assert.equal(foldedPlan, counts.plan, `${label}: the listing folds to the card's plan count`);
    // And the defect's own signature: recorded-mode folding does NOT reconcile.
    assert.notEqual(recordedCode.length, counts.code,
      `${label}: audit_mode is the wrong axis to fold by — that is why effective_mode is projected`);
  }

  for (const allAges of [false, true]) {
    it(`unlocked fixes (${allAges ? 'allAges' : 'windowed'}): rows fold to byMode`, async () => {
      const rows = await nudges.getUnlockedFixes({ repoId }, { limit: 200, allAges });
      const counts = await nudges.countUnlockedFixes({ repoId }, { allAges });
      assert.equal(rows.length, 2, 'fixture: two unlocked HIGH fixes');
      assertReconciles(rows, counts, `unlocked/${allAges ? 'allAges' : 'windowed'}`);
    });

    it(`unremediated acceptances (${allAges ? 'allAges' : 'windowed'}): rows fold to byMode`, async () => {
      const rows = await nudges.getUnremediatedAcceptances({ repoId }, { limit: 200, allAges });
      const counts = await nudges.countUnremediatedAcceptances({ repoId }, { allAges });
      assert.equal(rows.length, 2, 'fixture: two open acceptances');
      assertReconciles(rows, counts, `unremediated/${allAges ? 'allAges' : 'windowed'}`);
    });
  }

  it('the --mode filter and the projected effective_mode agree', async () => {
    // The filter path moved to EFFECTIVE_MODE_SQL in 2026-08; this pins the
    // projection to the same answer, so a caller can page `--mode code`, fold
    // the result, and get one number rather than two.
    const codeRows = await nudges.getUnlockedFixes({ repoId }, { limit: 200, mode: 'code' });
    assert.equal(codeRows.length, 1, 'one effectively-code unlocked fix');
    assert.equal(codeRows[0].primary_file, REAL_FILE);
    assert.equal(codeRows[0].effective_mode, 'code');
    const planRows = await nudges.getUnlockedFixes({ repoId }, { limit: 200, mode: 'plan' });
    assert.equal(planRows.length, 1, 'one effectively-plan unlocked fix');
    assert.equal(planRows[0].primary_file, PROSE_FILE);
    assert.equal(planRows[0].effective_mode, 'plan');
    assert.equal(planRows[0].audit_mode, 'code', 'negative control: recorded as code, effectively plan');
  });
});
