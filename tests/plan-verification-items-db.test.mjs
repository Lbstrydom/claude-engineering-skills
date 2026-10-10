/**
 * @fileoverview plan_verification_items — the MULTI-row write, against real
 * Postgres (upstream report 512cf1c9).
 *
 * `/ux-lock verify` recorded its run row and then lost every per-criterion row
 * with `column "run_id" is of type uuid but expression is of type text`
 * (SQLSTATE 42804), while the command exited 0. The cause was in
 * `buildOwnedInsert`: it joined rows with `SELECT $n, … UNION ALL SELECT …`, and
 * a set operation resolves untyped bind parameters to `text` BEFORE the INSERT
 * target can coerce them. A single row never hits that path — which is exactly
 * why `tests/store-ownership-db.test.mjs` (one row) stayed green throughout.
 * Every case here therefore writes AT LEAST TWO items, with a one-row control.
 *
 * It also drives `persistAndReportVerify` (the post-run half of `ux-lock-run.mjs
 * verify`) with the REAL writers, so the exit code the CLI returns is asserted
 * against what Postgres actually accepted — not against a stub's opinion.
 *
 * ENROLMENT IS TWO EDITS (AGENTS.md): `scripts/db-test-container.mjs`
 * (`ISOLATED_SUITE_FILES`) **and** `.github/workflows/postgres-parity.yml`.
 *
 * @module tests/plan-verification-items-db
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { one, many } from '../scripts/lib/db/query.mjs';
import {
  recordPlanVerificationRun, recordPlanVerificationItems,
} from '../scripts/lib/store/plan-verification.mjs';
import { persistAndReportVerify, VERIFY_PERSIST_FAILED_EXIT } from '../scripts/ux-lock-run.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

const REPO = randomUUID();
const PLAN = randomUUID();

/** Criterion items in the shape `mapCriteriaToItems` produces. */
function makeItems(n) {
  return Array.from({ length: n }, (_, i) => ({
    criterionHash: `pvi-db-hash-${i}`,
    criterionIndex: i,
    severity: i === 0 ? 'P0' : 'P1',
    category: 'other',
    description: `plan-verification-items-db criterion ${i}`,
    passed: i % 2 === 0,
    skipped: false,
    errorMessage: i % 2 === 0 ? null : 'boom',
    durationMs: 100 + i,
  }));
}

const countsFor = (items) => ({
  totalCriteria: items.length,
  passedCount: items.filter((i) => i.passed).length,
  failedCount: items.filter((i) => !i.passed).length,
  skippedCount: 0,
});

describe('plan_verification_items — multi-row write against Postgres (upstream 512cf1c9)', { skip }, () => {
  let savedUrl;
  // Set only once the disposable guard has passed AND the env points at the
  // test DSN. Teardown touches the database only when it is set, so a guard
  // that throws can never be followed by cleanup against whatever
  // AUDIT_DB_URL still names (INC-002's class).
  let guarded = false;

  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    // Fail-closed BEFORE any pool reset — the 2026-07-14 wipe-incident guard
    // (INC-002). "Disposable" is an ALLOWLIST of loopback hosts.
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    guarded = true;
    const pool = await getPool();
    assert.ok(pool, 'pool must exist');
    await pool.query('INSERT INTO audit_repos (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [REPO, 'test/plan-verification-items-db']);
    await pool.query(
      'INSERT INTO plans (id, repo_id, path, skill) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [PLAN, REPO, `docs/plans/pvi-db-${PLAN.slice(0, 8)}.md`, 'plan'],
    );
  });

  after(async () => {
    // Every cleanup statement is attempted; failures are COLLECTED and reported
    // after the environment is restored, never swallowed — a silent teardown
    // failure is how fixture rows leak into the next suite unnoticed.
    const errors = [];
    try {
      if (guarded) {
        const pool = await getPool();
        for (const [sql, params] of [
          ['DELETE FROM plan_verification_items WHERE plan_id = $1', [PLAN]],
          ['DELETE FROM plan_verification_runs WHERE plan_id = $1', [PLAN]],
          ['DELETE FROM plans WHERE id = $1', [PLAN]],
          ['DELETE FROM audit_repos WHERE id = $1', [REPO]],
        ]) {
          try { await pool.query(sql, params); } catch (err) { errors.push(err); }
        }
      }
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
      await closePool();
      await _resetForTest();
    }
    if (errors.length) throw new AggregateError(errors, `teardown: ${errors.length} cleanup statement(s) failed`);
  });

  const newRun = async (items) => {
    const run = await recordPlanVerificationRun({ planId: PLAN, runContext: 'manual', ...countsFor(items) });
    assert.equal(run.ok, true, `the parent run must land first — got ${run.reason}: ${run.message}`);
    return run.runId;
  };

  it('a ONE-row write lands (the control — the shape that always worked)', async () => {
    const items = makeItems(1);
    const runId = await newRun(items);
    const res = await recordPlanVerificationItems(runId, PLAN, items);
    assert.equal(res.ok, true, `got ${res.reason}`);
    assert.equal(res.inserted, 1);
  });

  it('a THREE-row write lands, every column typed by the table (was 42804 uuid/text)', async () => {
    const items = makeItems(3);
    const runId = await newRun(items);
    const res = await recordPlanVerificationItems(runId, PLAN, items);
    assert.equal(res.ok, true, `multi-row write must succeed — got: ${res.reason}`);
    assert.equal(res.inserted, 3);

    const rows = await many(
      `SELECT run_id, plan_id, criterion_hash, criterion_index, severity, passed, skipped,
              error_message, duration_ms
         FROM plan_verification_items WHERE run_id = $1 ORDER BY criterion_index`,
      [runId],
    );
    assert.equal(rows.length, 3, 'the rows must be in the table, not merely counted by the CTE');
    rows.forEach((row, i) => {
      assert.equal(row.run_id, runId);
      assert.equal(row.plan_id, PLAN, 'plan_id comes from the parent run');
      assert.equal(row.criterion_hash, `pvi-db-hash-${i}`);
      // Typed values, not strings: an int column read back as a JS number and a
      // boolean column as a boolean prove the INSERT target did the coercion.
      assert.strictEqual(row.criterion_index, i);
      assert.strictEqual(row.passed, i % 2 === 0);
      assert.strictEqual(row.skipped, false);
      assert.strictEqual(row.duration_ms, 100 + i);
    });
  });

  it('a multi-row write against a DANGLING run writes nothing and reports parent-not-found', async () => {
    const res = await recordPlanVerificationItems(randomUUID(), PLAN, makeItems(2));
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'parent-not-found');
  });

  it('persistAndReportVerify with the REAL writers: recorded run exits 0 with itemsInserted = items', async () => {
    const items = makeItems(4);
    const { envelope, exitCode } = await persistAndReportVerify({
      items, orphanTests: [], policyTotal: 0, cloud: true, planId: PLAN,
      commit: null, url: null,
    });
    assert.equal(exitCode, 0, `expected a recorded run — envelope: ${JSON.stringify(envelope.error ?? envelope)}`);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.itemsInserted, 4);
    assert.ok(envelope.runId, 'a run id must come back');
    const row = await one('SELECT count(*)::int AS n FROM plan_verification_items WHERE run_id = $1', [envelope.runId]);
    assert.equal(row.n, 4);
  });

  it('persistAndReportVerify with the REAL writers: a run that cannot be recorded exits non-zero', async () => {
    const items = makeItems(2);
    const { envelope, exitCode } = await persistAndReportVerify({
      items, orphanTests: [], policyTotal: 0, cloud: true, planId: randomUUID(),
      commit: null, url: null,
    });
    assert.equal(exitCode, VERIFY_PERSIST_FAILED_EXIT);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.code, 'PERSIST_FAILED');
    assert.equal(envelope.persistFailed, 'run');
    // The report is still complete — a recording failure must not hide results.
    assert.equal(envelope.totalCriteria, 2);
    assert.equal(envelope.items.length, 2);
  });
});
