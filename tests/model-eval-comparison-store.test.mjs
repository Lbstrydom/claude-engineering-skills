/**
 * D3a cohort persistence — the LIVE half against a real, disposable schema.
 *
 * `upsertComparison`/`createEvalRun`'s cohort fields/`maxComparisonArmAttempt`/
 * `getComparisonCohort` all depend on real constraints (the composite unique
 * key, the partial "one live attempt" index, the migration's new columns) that
 * a mock cannot exercise — this is the DB-suite half AGENTS.md requires for
 * exactly that reason: "A suite gated on AUDIT_DB_TEST_URL skips itself
 * without a disposable DSN, and node reports a suite that never ran as a
 * clean pass." Enrolled in db-test-container.mjs's ISOLATED_SUITE_FILES AND
 * .github/workflows/postgres-parity.yml in this same commit — two edits,
 * never one.
 *
 * `AUDIT_DB_TEST_URL` only, never `AUDIT_DB_URL` — `assertDisposableDbUrl`
 * fails closed before any connection (INC-002's lesson).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (runs under npm run db:suites:gate)';

describe('model-eval comparison cohort against a live schema', { skip }, () => {
  let client; let store; let savedUrl; let repoId;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest, getPool } = await import('../scripts/lib/db/client.mjs');
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    client = await getPool();
    store = await import('../scripts/lib/store/model-eval.mjs');

    const repo = await client.query("INSERT INTO audit_repos (name) VALUES ('model-eval-comparison-test-repo') RETURNING id");
    repoId = repo.rows[0].id;
  });

  // createEvalRun's OWN contract (round-12 audit M9) requires a NON-TERMINAL
  // status at creation — 'completed' is reached only via updateEvalRunTerminal,
  // never in one call. This helper models exactly what a real cohort arm-run
  // does: create running, then finalize — never a shortcut through the schema.
  async function createAndFinalizeArmRun({ armId, comparisonId, attempt, supersedePrior = false, status = 'completed' }) {
    const created = await store.createEvalRun({
      repoId, role: 'auditor', tier: 'screen',
      candidateRef: { candidateSpec: { kind: 'sentinel', value: 'latest-gpt' } },
      status: 'running', comparisonId, armId, attempt, supersedePrior,
    });
    const terminalBundle = status === 'completed'
      ? { status: 'completed', verdict: 'keep', nextAction: 'none' } // a real DECISION_TABLE pair, not a guess
      : { status };
    await store.updateEvalRunTerminal({ repoId, runId: created.runId, expectedStatus: 'running', terminalBundle });
    return created;
  }

  after(async () => {
    try {
      const { closePool, _resetForTest } = await import('../scripts/lib/db/client.mjs');
      await closePool();
      await _resetForTest();
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
    }
  });

  it('upsertComparison is idempotent on (repo, key, digest, lock version) — a plain re-run returns the SAME cohort', async () => {
    const a = await store.upsertComparison({
      repoId, comparisonKey: 'live-idempotence', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    const b = await store.upsertComparison({
      repoId, comparisonKey: 'live-idempotence', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    assert.ok(a.id);
    assert.equal(a.id, b.id, 're-running the SAME manifest/digest must resume the same cohort, never create a duplicate');
  });

  it('a config digest change creates a genuinely NEW cohort — D2a: prior evidence is never silently relabelled', async () => {
    const a = await store.upsertComparison({
      repoId, comparisonKey: 'live-digest-bump', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    const b = await store.upsertComparison({
      repoId, comparisonKey: 'live-digest-bump', configDigest: 'd2', lockSchemaVersion: 1, role: 'auditor',
    });
    assert.notEqual(a.id, b.id, 'a changed digest must not collide with the prior cohort');
  });

  it('a lock_schema_version bump ALSO creates a new cohort at the SAME digest — Gemini/G5', async () => {
    // The whole point of D2a: a version bump leaves config_digest
    // byte-identical. If lock_schema_version were NOT in the unique key, this
    // second call would either collide with the first (crashing the one
    // operation the column exists to enable) or silently overwrite it.
    const a = await store.upsertComparison({
      repoId, comparisonKey: 'live-version-bump', configDigest: 'same-digest', lockSchemaVersion: 1, role: 'auditor',
    });
    const b = await store.upsertComparison({
      repoId, comparisonKey: 'live-version-bump', configDigest: 'same-digest', lockSchemaVersion: 2, role: 'auditor',
    });
    assert.notEqual(a.id, b.id, 'a lock_schema_version bump at an unchanged digest must still create a distinct parallel cohort');
  });

  it('createEvalRun with cohort fields writes comparison_id/arm_id/attempt, and a plain single-candidate call still writes NONE of them', async () => {
    const cohort = await store.upsertComparison({
      repoId, comparisonKey: 'live-cohort-write', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    const cohortRun = await createAndFinalizeArmRun({ comparisonId: cohort.id, armId: 'arm-a', attempt: 1 });
    assert.ok(cohortRun.runId);

    // Not left dangling at 'running' — every row this suite creates reaches a
    // terminal status via the SAME create→finalize path a real caller uses,
    // matching createEvalRun's own contract rather than leaving a plain
    // single-candidate row in an incomplete state nothing here cleans up.
    const plainRun = await store.createEvalRun({
      repoId, role: 'auditor', tier: 'screen',
      candidateRef: { candidateSpec: { kind: 'sentinel', value: 'latest-gpt' } },
      status: 'running',
    });
    assert.ok(plainRun.runId);
    await store.updateEvalRunTerminal({
      repoId, runId: plainRun.runId, expectedStatus: 'running',
      terminalBundle: { status: 'completed', verdict: 'keep', nextAction: 'none' },
    });

    // Scoped by repoId too, not just run_id — a read that ignores the owning
    // repo cannot tell "this row belongs to THIS repo" from "a run_id
    // collision happened to match", the exact tenant-scoping question a live
    // multi-repo store must answer (Cluster B fix-gate).
    const rows = await client.query(
      'SELECT run_id, repo_id, comparison_id, arm_id, attempt FROM model_eval_runs WHERE run_id = ANY($1) AND repo_id = $2',
      [[cohortRun.runId, plainRun.runId], repoId],
    );
    assert.equal(rows.rows.length, 2, 'both rows must be visible when scoped to their OWN repo');
    const byId = Object.fromEntries(rows.rows.map((r) => [r.run_id, r]));
    assert.equal(byId[cohortRun.runId].repo_id, repoId);
    assert.equal(byId[cohortRun.runId].comparison_id, cohort.id);
    assert.equal(byId[cohortRun.runId].arm_id, 'arm-a');
    assert.equal(byId[cohortRun.runId].attempt, 1);
    assert.equal(byId[plainRun.runId].repo_id, repoId);
    assert.equal(byId[plainRun.runId].comparison_id, null, 'a plain single-candidate run must not acquire a cohort by accident');
    assert.equal(byId[plainRun.runId].arm_id, null);

    // NEGATIVE CONTROL: scoped to a DIFFERENT (nonexistent) repo, neither row
    // is visible — proves the repo_id filter above is actually restrictive,
    // not a no-op that would pass even without it.
    const wrongRepo = await client.query(
      'SELECT run_id FROM model_eval_runs WHERE run_id = ANY($1) AND repo_id = $2',
      [[cohortRun.runId, plainRun.runId], '00000000-0000-0000-0000-000000000fff'],
    );
    assert.equal(wrongRepo.rows.length, 0, 'neither row may leak into a query scoped to a different repo');
  });

  it('the partial unique index refuses a SECOND live attempt for the same (comparison, arm) without supersedePrior', async () => {
    const cohort = await store.upsertComparison({
      repoId, comparisonKey: 'live-double-insert', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    await createAndFinalizeArmRun({ comparisonId: cohort.id, armId: 'dup-arm', attempt: 1 });
    await assert.rejects(
      () => store.createEvalRun({
        repoId, role: 'auditor', tier: 'screen',
        candidateRef: { candidateSpec: { kind: 'sentinel', value: 'latest-gpt' } },
        status: 'running', comparisonId: cohort.id, armId: 'dup-arm', attempt: 1,
      }),
      (err) => err instanceof store.ComparisonArmAttemptCollisionError,
      'a second attempt=1 row for the same arm without supersedePrior must violate the unique index — this is the double-charge guard D5a exists to provide',
    );
  });

  // The defect this pins: BEFORE the fix, createEvalRun's catch block
  // converted EVERY 23505 into EvalRunAlreadyActiveError, so the assertion
  // above would have passed against the WRONG error class (both are Error
  // instances, and a looser `instanceof Error` or message-substring check
  // would never have caught it) — measured live: the actual thrown error was
  // "EvalRunAlreadyActiveError: repo … already has an active auditor run",
  // which sends an operator chasing a role-active-run problem that does not
  // exist. Pinning the negative directly: this specific collision must NOT
  // read as that error.
  it('NEGATIVE CONTROL: a cohort-attempt collision must NOT be misreported as EvalRunAlreadyActiveError', async () => {
    const cohort = await store.upsertComparison({
      repoId, comparisonKey: 'live-error-class', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    await createAndFinalizeArmRun({ comparisonId: cohort.id, armId: 'dup-arm-2', attempt: 1 });
    try {
      await store.createEvalRun({
        repoId, role: 'auditor', tier: 'screen',
        candidateRef: { candidateSpec: { kind: 'sentinel', value: 'latest-gpt' } },
        status: 'running', comparisonId: cohort.id, armId: 'dup-arm-2', attempt: 1,
      });
      assert.fail('expected createEvalRun to reject');
    } catch (err) {
      assert.ok(!(err instanceof store.EvalRunAlreadyActiveError),
        `wrong error class: got EvalRunAlreadyActiveError for a cohort-attempt collision (message: ${err.message})`);
      assert.ok(err instanceof store.ComparisonArmAttemptCollisionError);
    }
  });

  // Cluster B fix-gate (R5) — the base D3a migration declared `attempt int
  // NOT NULL DEFAULT 1` with no CHECK and no sequencing guarantee beyond what
  // createEvalRun happens to compute correctly. A later migration
  // (20260816110000) closes both gaps at the DB level; these tests bypass
  // the app-layer Zod schema (which already rejects attempt<=0) and write
  // directly against `client`, since the DB constraint is the thing under
  // test, not the schema in front of it.
  it('DB-LEVEL: attempt <= 0 is rejected by a CHECK constraint, independent of the app-layer schema', async () => {
    await assert.rejects(
      () => client.query(
        `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, attempt)
         VALUES ($1, 'auditor', 'screen', '{}', 'running', 0)`,
        [repoId],
      ),
      /model_eval_runs_attempt_positive/,
    );
  });

  it('DB-LEVEL: an attempt that skips or reuses a number is rejected by the sequencing trigger', async () => {
    const cohort = await store.upsertComparison({
      repoId, comparisonKey: 'live-attempt-sequence', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    await client.query(
      `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id, attempt)
       VALUES ($1, 'auditor', 'screen', '{}', 'running', $2, 'seq-arm', 1)`,
      [repoId, cohort.id],
    );
    await assert.rejects(
      () => client.query(
        `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id, attempt)
         VALUES ($1, 'auditor', 'screen', '{}', 'running', $2, 'seq-arm', 3)`,
        [repoId, cohort.id],
      ),
      /must be exactly one more than the prior max/,
      'skipping from 1 straight to 3 must be rejected',
    );
    await assert.rejects(
      () => client.query(
        `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id, attempt)
         VALUES ($1, 'auditor', 'screen', '{}', 'running', $2, 'seq-arm', 1)`,
        [repoId, cohort.id],
      ),
      /must be exactly one more than the prior max/,
      'reusing attempt=1 for the same arm must be rejected even though it does not collide with the unique index alone (the first row is still live)',
    );
    // NEGATIVE CONTROL: the genuine N+1 (2), inside the same supersede-then-
    // insert shape createEvalRun uses, is accepted.
    await client.query('BEGIN');
    await client.query(
      `UPDATE model_eval_runs SET superseded_at = now()
        WHERE comparison_id = $1 AND arm_id = 'seq-arm' AND superseded_at IS NULL`,
      [cohort.id],
    );
    await client.query(
      `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id, attempt)
       VALUES ($1, 'auditor', 'screen', '{}', 'running', $2, 'seq-arm', 2)`,
      [repoId, cohort.id],
    );
    await client.query('COMMIT');
    const { rows } = await client.query(
      `SELECT attempt FROM model_eval_runs WHERE comparison_id = $1 AND arm_id = 'seq-arm' AND superseded_at IS NULL`,
      [cohort.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attempt, 2);
  });

  it('NEGATIVE CONTROL: a different arm in the same comparison independently starts its own sequence at 1', async () => {
    const cohort = await store.upsertComparison({
      repoId, comparisonKey: 'live-attempt-independent-arms', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    await client.query(
      `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id, attempt)
       VALUES ($1, 'auditor', 'screen', '{}', 'running', $2, 'arm-a', 1)`,
      [repoId, cohort.id],
    );
    // A SECOND, distinct arm in the SAME comparison must not be forced to
    // continue arm-a's numbering.
    await client.query(
      `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id, attempt)
       VALUES ($1, 'auditor', 'screen', '{}', 'running', $2, 'arm-b', 1)`,
      [repoId, cohort.id],
    );
    const { rows } = await client.query(
      `SELECT arm_id, attempt FROM model_eval_runs WHERE comparison_id = $1 ORDER BY arm_id`,
      [cohort.id],
    );
    assert.deepEqual(rows, [{ arm_id: 'arm-a', attempt: 1 }, { arm_id: 'arm-b', attempt: 1 }]);
  });

  // Cluster B fix-gate (R6) — the R5 sequence trigger only fired BEFORE
  // INSERT; migration 20260816120000 extends it to BEFORE UPDATE too, making
  // comparison_id/arm_id/attempt immutable once a row exists (mirrors the
  // repo_id-immutable pattern). DELETE is deliberately untested here — no
  // application code path deletes these rows.
  it('DB-LEVEL: attempt/arm_id/comparison_id are immutable on an existing row', async () => {
    const cohort = await store.upsertComparison({
      repoId, comparisonKey: 'live-attempt-immutable', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    const ins = await client.query(
      `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id, attempt)
       VALUES ($1, 'auditor', 'screen', '{}', 'running', $2, 'immut-arm', 1) RETURNING run_id`,
      [repoId, cohort.id],
    );
    const runId = ins.rows[0].run_id;

    await assert.rejects(
      () => client.query('UPDATE model_eval_runs SET attempt = 2 WHERE run_id = $1', [runId]),
      /immutable once created/,
    );
    await assert.rejects(
      () => client.query(`UPDATE model_eval_runs SET arm_id = 'other-arm' WHERE run_id = $1`, [runId]),
      /immutable once created/,
    );
  });

  it('NEGATIVE CONTROL: the real update shapes (terminal status, supersede) are unaffected by the immutability trigger', async () => {
    const cohort = await store.upsertComparison({
      repoId, comparisonKey: 'live-attempt-immutable-negative', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    const ins = await client.query(
      `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id, attempt)
       VALUES ($1, 'auditor', 'screen', '{}', 'running', $2, 'immut-neg-arm', 1) RETURNING run_id`,
      [repoId, cohort.id],
    );
    const runId = ins.rows[0].run_id;

    // Mirrors updateEvalRunTerminal's real SET clause — status/verdict/etc only.
    await client.query(
      `UPDATE model_eval_runs SET status = 'completed', verdict = 'keep', next_action = 'none' WHERE run_id = $1`,
      [runId],
    );
    // Mirrors the real supersede flow — superseded_at only.
    await client.query('UPDATE model_eval_runs SET superseded_at = now() WHERE run_id = $1', [runId]);

    const { rows } = await client.query('SELECT status, superseded_at FROM model_eval_runs WHERE run_id = $1', [runId]);
    assert.equal(rows[0].status, 'completed');
    assert.ok(rows[0].superseded_at != null);
  });

  it('THE HEADLINE CASE (D5a resume): supersedePrior retires the failed attempt in the SAME transaction that claims N+1', async () => {
    const cohort = await store.upsertComparison({
      repoId, comparisonKey: 'live-resume', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    const failed = await createAndFinalizeArmRun({
      comparisonId: cohort.id, armId: 'flaky-arm', attempt: 1, status: 'failed_provider',
    });

    const before1 = await store.maxComparisonArmAttempt({ comparisonId: cohort.id, armId: 'flaky-arm' });
    assert.equal(before1.attempt, 1);
    assert.equal(before1.hasLiveSuccess, false, 'a failed attempt is not a live SUCCESS');

    const retry = await createAndFinalizeArmRun({
      comparisonId: cohort.id, armId: 'flaky-arm', attempt: 2, supersedePrior: true,
    });
    assert.ok(retry.runId);

    const after1 = await store.maxComparisonArmAttempt({ comparisonId: cohort.id, armId: 'flaky-arm' });
    assert.equal(after1.attempt, 2);
    assert.equal(after1.hasLiveSuccess, true, 'the retry succeeded and is now the live attempt');

    // The failed attempt stays READABLE, stamped superseded — never deleted.
    const failedRow = await client.query('SELECT superseded_at, status FROM model_eval_runs WHERE run_id = $1', [failed.runId]);
    assert.notEqual(failedRow.rows[0].superseded_at, null, 'the earlier failed attempt must be superseded, not erased');
    assert.equal(failedRow.rows[0].status, 'failed_provider', 'the evidence of what the earlier attempt produced survives unchanged');
  });

  it('getComparisonCohort includes a FAILED arm, never hides it — D3a: a half-collected cohort must not look complete', async () => {
    const cohort = await store.upsertComparison({
      repoId, comparisonKey: 'live-cohort-read', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    await createAndFinalizeArmRun({ comparisonId: cohort.id, armId: 'ok-arm', attempt: 1 });
    await createAndFinalizeArmRun({ comparisonId: cohort.id, armId: 'broken-arm', attempt: 1, status: 'failed_egress' });

    const cohortRead = await store.getComparisonCohort({ comparisonId: cohort.id });
    const armIds = cohortRead.rows.map((r) => r.arm_id).sort();
    assert.deepEqual(armIds, ['broken-arm', 'ok-arm'], 'a read that hides failures would make a half-collected comparison look complete');
    const broken = cohortRead.rows.find((r) => r.arm_id === 'broken-arm');
    assert.equal(broken.status, 'failed_egress');
  });

  it('NEGATIVE CONTROL: a cohort with no rows yet reads back empty, not an error', async () => {
    const cohort = await store.upsertComparison({
      repoId, comparisonKey: 'live-empty-cohort', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    const cohortRead = await store.getComparisonCohort({ comparisonId: cohort.id });
    assert.deepEqual(cohortRead.rows, []);
    const attempt = await store.maxComparisonArmAttempt({ comparisonId: cohort.id, armId: 'never-run' });
    assert.equal(attempt.attempt, 0);
    assert.equal(attempt.hasLiveSuccess, false);
  });

  // 20260816090000_model_eval_comparison_integrity.sql, Gap 1 — before this
  // migration, `model_eval_runs.comparison_id` was indexed but not
  // constrained: a row could reference a comparison_id that never existed in
  // `model_eval_comparisons`, and would be unrecoverable by getComparisonCohort
  // (silently vanishing from every aggregate) rather than refused up front.
  it('DB-LEVEL: a comparison_id that does not exist in model_eval_comparisons is refused by the FK', async () => {
    const bogusComparisonId = '00000000-0000-0000-0000-0000000000fe';
    await assert.rejects(
      () => client.query(
        `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id, attempt)
         VALUES ($1, 'auditor', 'screen', '{}', 'running', $2, 'fk-arm', 1)`,
        [repoId, bogusComparisonId],
      ),
      /fk_model_eval_runs_comparison_id|foreign key/i,
    );
  });

  // 20260816090000, Gap 2 — comparison_id/arm_id are independently nullable
  // columns, so Postgres's unique indexes (which treat every NULL as distinct
  // from every other NULL) cannot see a partially-identified row at all — the
  // application's Zod schema refuses exactly-one-set, but that refusal lives
  // only in scripts/lib/store/model-eval.mjs and any OTHER writer (a manual
  // INSERT, a future script) bypasses it entirely. The pairing CHECK restates
  // the same rule where it cannot be bypassed.
  it('DB-LEVEL: a partially-identified cohort row (only one of comparison_id/arm_id set) is refused by the pairing CHECK', async () => {
    const cohort = await store.upsertComparison({
      repoId, comparisonKey: 'live-pairing-check', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
    });
    await assert.rejects(
      () => client.query(
        `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id)
         VALUES ($1, 'auditor', 'screen', '{}', 'running', $2, NULL)`,
        [repoId, cohort.id],
      ),
      /chk_model_eval_runs_comparison_arm_pairing/,
      'comparison_id set with arm_id NULL must be refused',
    );
    await assert.rejects(
      () => client.query(
        `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id)
         VALUES ($1, 'auditor', 'screen', '{}', 'running', NULL, 'pairing-arm')`,
        [repoId],
      ),
      /chk_model_eval_runs_comparison_arm_pairing/,
      'arm_id set with comparison_id NULL must be refused too — the check is symmetric',
    );
    // NEGATIVE CONTROL: both-null (plain single-candidate run) and both-set
    // (a real cohort row) are exactly the legal shapes and must not be refused.
    await assert.doesNotReject(() => client.query(
      `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id)
       VALUES ($1, 'auditor', 'screen', '{}', 'running', NULL, NULL)`,
      [repoId],
    ));
    await assert.doesNotReject(() => client.query(
      `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id, attempt)
       VALUES ($1, 'auditor', 'screen', '{}', 'running', $2, 'pairing-both-set', 1)`,
      [repoId, cohort.id],
    ));
  });

  // 20260816090000's repo-scope trigger + 20260816100000's repo-immutable
  // trigger — the two-sided repo-scope integrity guard (the same "retagging
  // changes edges from BOTH directions" shape AGENTS.md documents for the
  // domain map, one layer down: a run's repo_id must match its comparison's
  // repo_id, AND the comparison's repo_id must not move out from under runs
  // that already reference it).
  describe('DB-LEVEL: repo-scope integrity is enforced from BOTH directions', () => {
    let otherRepoId;
    before(async () => {
      const other = await client.query("INSERT INTO audit_repos (name) VALUES ('model-eval-comparison-test-repo-other') RETURNING id");
      otherRepoId = other.rows[0].id;
    });

    it('a run whose repo_id does not match its comparison\'s repo_id is refused by the repo-scope trigger', async () => {
      const cohort = await store.upsertComparison({
        repoId, comparisonKey: 'live-repo-scope', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
      });
      await assert.rejects(
        () => client.query(
          `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id, attempt)
           VALUES ($1, 'auditor', 'screen', '{}', 'running', $2, 'cross-repo-arm', 1)`,
          [otherRepoId, cohort.id],
        ),
        /does not match comparison.*repo_id|may not attach to another repo/,
        'a run may not attach to another repo\'s cohort even if the comparison_id itself is real',
      );
    });

    it('NEGATIVE CONTROL: a run whose repo_id DOES match its comparison\'s repo_id is unaffected', async () => {
      const cohort = await store.upsertComparison({
        repoId, comparisonKey: 'live-repo-scope-negative', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
      });
      await assert.doesNotReject(() => client.query(
        `INSERT INTO model_eval_runs (repo_id, role, tier, candidate_ref, status, comparison_id, arm_id, attempt)
         VALUES ($1, 'auditor', 'screen', '{}', 'running', $2, 'same-repo-arm', 1)`,
        [repoId, cohort.id],
      ));
    });

    it('model_eval_comparisons.repo_id is immutable once created, even with no runs referencing it yet', async () => {
      const cohort = await store.upsertComparison({
        repoId, comparisonKey: 'live-repo-immutable', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
      });
      await assert.rejects(
        () => client.query('UPDATE model_eval_comparisons SET repo_id = $1 WHERE id = $2', [otherRepoId, cohort.id]),
        /repo_id is immutable once created/,
      );
    });

    it('NEGATIVE CONTROL: updating a comparison\'s subject_ref (the one real write path) is unaffected by the repo_id-immutable trigger', async () => {
      const cohort = await store.upsertComparison({
        repoId, comparisonKey: 'live-repo-immutable-negative', configDigest: 'd1', lockSchemaVersion: 1, role: 'auditor',
      });
      await assert.doesNotReject(() => client.query(
        `UPDATE model_eval_comparisons SET subject_ref = '{"note":"unrelated update"}' WHERE id = $1`,
        [cohort.id],
      ));
      const { rows } = await client.query('SELECT repo_id FROM model_eval_comparisons WHERE id = $1', [cohort.id]);
      assert.equal(rows[0].repo_id, repoId, 'an unrelated column update must not disturb repo_id');
    });
  });
});
