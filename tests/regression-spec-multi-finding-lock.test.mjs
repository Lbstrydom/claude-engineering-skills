/**
 * @fileoverview One test file may lock MANY findings.
 *
 * THE DEFECT this pins (reported from wine-cellar-app, 2026-08-01).
 * `regression_specs` carried `UNIQUE (repo_id, spec_path)` and
 * `recordRegressionSpec` upserted on exactly that target, so locking a second
 * finding to a test file that already held one REASSIGNED the existing row
 * instead of adding one. The previously-locked finding silently returned to
 * `unlocked_fixes` while BOTH calls returned `{"ok":true,"locked":true}` — a
 * batch sweep reported full success having locked one finding per file.
 * Measured before the fix: 16 rows across 16 distinct paths from ~31 lock
 * invocations in one consumer repo.
 *
 * Under /ux-lock the constraint was correct — one authored Playwright spec pins
 * one fix. `source_kind = 'unit-test'` (20260729140000) broke that assumption:
 * a unit/integration suite routinely covers several related findings, and the
 * identity of such a lock is WHICH FINDING it pins, not the file.
 *
 * Two layers, because neither alone catches a reinstatement:
 *   1. the committed schema fixture — a total unique index on (repo_id,
 *      spec_path) coming back is the regression, statable without a DB;
 *   2. a real two-lock round-trip, env-gated on AUDIT_DB_TEST_URL — the only
 *      thing that proves the arbiter and the index agree. The bug was invisible
 *      at the call site precisely because the writer reported success, so a
 *      source-shape assertion alone would not have caught it.
 *
 * @module tests/regression-spec-multi-finding-lock
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { many } from '../scripts/lib/db/query.mjs';
import { recordRegressionSpec } from '../scripts/lib/store/plans-ship.mjs';

// ── Layer 1: the committed schema fixture (always runs, no DB) ─────────────

const fixture = JSON.parse(fs.readFileSync(
  path.resolve(import.meta.dirname, 'fixtures/expected-schema.json'), 'utf8'));

const specIndexes = fixture.indexes.filter((i) => i.tablename === 'regression_specs');
const specConstraints = fixture.constraints.filter(
  (c) => c.table_name === 'regression_specs' || c.table === 'regression_specs');

describe('regression_specs uniqueness is scoped by lock kind', () => {
  it('no TOTAL unique index on (repo_id, spec_path) exists — that one is the bug', () => {
    const total = specIndexes.filter((i) => /UNIQUE/.test(i.indexdef)
      && /\(repo_id, spec_path\)/.test(i.indexdef)
      && !/WHERE/.test(i.indexdef));
    assert.deepEqual(total, [],
      'a table-wide UNIQUE (repo_id, spec_path) makes every unit-test lock evict the previous one');
  });

  it('unit-test rows are keyed on (repo_id, spec_path, source_finding_id)', () => {
    const hit = specIndexes.find((i) => i.indexname === 'idx_regression_specs_unit_test_lock');
    assert.ok(hit, 'the unit-test arbiter index must exist');
    assert.match(hit.indexdef, /UNIQUE/);
    assert.match(hit.indexdef, /\(repo_id, spec_path, source_finding_id\)/,
      'the finding is part of the key — that is what lets one file lock several');
    assert.match(hit.indexdef, /WHERE \(source_kind = 'unit-test'/,
      'partial, so the browser-spec kinds keep their one-row-per-path identity');
  });

  it('non-unit-test rows KEEP one row per path — the relaxation is scoped, not global', () => {
    // /ux-lock re-run on the same fix must still update in place, not accrue a
    // row per invocation. Widening the relaxation to every kind would trade one
    // silent-eviction bug for a silent-duplication one.
    const hit = specIndexes.find((i) => i.indexname === 'idx_regression_specs_path_nonunit');
    assert.ok(hit, 'the non-unit arbiter index must exist');
    assert.match(hit.indexdef, /UNIQUE/);
    assert.match(hit.indexdef, /\(repo_id, spec_path\)/);
    assert.match(hit.indexdef, /source_kind <> 'unit-test'/);
  });

  it('a unit-test row without a finding is refused by CHECK — it would pin nothing', () => {
    const hit = specConstraints.find((c) => JSON.stringify(c).includes('regression_specs_unit_test_finding_check'));
    assert.ok(hit, 'the identity precondition for the three-column key must be enforced');
    assert.match(JSON.stringify(hit), /source_finding_id IS NOT NULL/);
  });
});

describe('the writer sends a predicate matching each partial arbiter', () => {
  // Every arbiter is now partial, and Postgres cannot infer a partial index
  // without a matching WHERE — it raises 42P10 instead. The writer's catch
  // swallows that into a `null` return, so a missing predicate would degrade
  // to "silently records nothing", the same invisible-failure shape as the bug.
  // RETARGETED (command-registry Cluster E): the regression-spec domain moved
  // out of plans-ship.mjs, now a re-export barrel. The conflict targets asserted
  // below are literals in the writer, so the scan has to read the writer's file.
  const src = fs.readFileSync(
    path.resolve(import.meta.dirname, '../scripts/lib/store/regression-specs.mjs'), 'utf8');

  it("the unit-test branch carries source_finding_id in its conflict target", () => {
    assert.match(src, /onConflict = \['repo_id', 'spec_path', 'source_finding_id'\]/);
  });

  it('each of the two branches sets a conflictWhere', () => {
    // Was three. The candidate arbiter (candidate_fingerprint IS NOT NULL) went
    // with the consistency candidate/promotion path on 2026-08-11, along with
    // the column and the partial index it inferred — migration 20260811150000.
    assert.match(src, /conflictWhere = "source_kind = 'unit-test'"/);
    assert.match(src, /conflictWhere = "source_kind <> 'unit-test' AND spec_path IS NOT NULL"/);
    assert.doesNotMatch(
      src, /candidate_fingerprint/,
      'the retired candidate arbiter must not linger in the writer — it would '
      + 'reference a dropped column and 42P10 into the swallowing catch',
    );
  });
});

// ── Layer 2: the real two-lock round-trip (env-gated) ──────────────────────

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

const SPEC_PATH = 'tests/unit/public/multiLockFixture.test.js';
const FINDING_A = '11111111-1111-4111-8111-111111111111';
const FINDING_B = '22222222-2222-4222-8222-222222222222';
const REPO_ID   = '33333333-3333-4333-8333-333333333333';

describe('two findings, one test file — both locks survive', { skip }, () => {
  let savedUrl;

  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    // Fail-closed BEFORE any pool reset — 2026-07-14 wipe-incident guard.
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    const pool = await getPool();
    assert.ok(pool, 'pool must exist');
    await pool.query(
      `INSERT INTO audit_repos (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [REPO_ID, 'test/multi-finding-lock']);
  });

  after(async () => {
    try {
      const pool = await getPool();
      if (pool) {
        await pool.query(`DELETE FROM regression_specs WHERE repo_id = $1`, [REPO_ID]).catch(() => {});
        await pool.query(`DELETE FROM audit_repos WHERE id = $1`, [REPO_ID]).catch(() => {});
      }
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
      await closePool();
      await _resetForTest();
    }
  });

  // §2b F2 (2026-08-12): recordRegressionSpec returns {ok, cloud, specId, reason}
  // instead of a bare id, so a DB outage is no longer indistinguishable from the
  // five input refusals and the unverified upsert that all returned the same
  // null. This helper unwraps, so the assertions below stay about the BEHAVIOUR
  // they were written for (two findings, one path, both rows survive) — and it
  // asserts `ok` on the way through, so a failed write surfaces as a named
  // failure here instead of as an undefined id three lines later.
  const lock = async (findingId, description) => {
    const res = await recordRegressionSpec(REPO_ID, {
      specPath: SPEC_PATH,
      description,
      sourceKind: 'unit-test',
      sourceFindingId: findingId,
      sourceFindingType: 'audit',
      assertionCount: 0,
      domContractTypes: [],
    });
    assert.equal(res.ok, true, `lock failed: ${res.reason} — ${res.message}`);
    return res.specId;
  };

  it('the second lock ADDS a row instead of evicting the first', async () => {
    const idA = await lock(FINDING_A, 'pins the first finding');
    assert.ok(idA, 'first lock must persist');
    const idB = await lock(FINDING_B, 'pins the second finding');
    assert.ok(idB, 'second lock must persist');
    assert.notEqual(idA, idB, 'a reassigned row would return the SAME id — that is the bug');

    const rows = await many(
      `SELECT source_finding_id::text AS f FROM regression_specs
        WHERE repo_id = $1 AND spec_path = $2 ORDER BY 1`, [REPO_ID, SPEC_PATH]);
    assert.deepEqual(rows.map((r) => r.f), [FINDING_A, FINDING_B],
      'both findings must remain locked to the shared path');
  });

  it('re-locking the SAME (path, finding) still updates in place — no duplicate accrual', async () => {
    const first = await lock(FINDING_A, 'original description');
    const again = await lock(FINDING_A, 'revised description');
    assert.equal(first, again, 'the same pair must resolve to one row');
    const rows = await many(
      `SELECT description FROM regression_specs WHERE repo_id = $1 AND source_finding_id = $2`,
      [REPO_ID, FINDING_A]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].description, 'revised description', 'the upsert must still update');
  });

  it('a unit-test lock naming no finding is refused, not written with a NULL key', async () => {
    const res = await recordRegressionSpec(REPO_ID, {
      specPath: SPEC_PATH, description: 'pins nothing', sourceKind: 'unit-test',
      sourceFindingType: 'audit', assertionCount: 0, domContractTypes: [],
    });
    // The refusal is NAMED now. `null` alone was the whole answer before §2b F2,
    // which is exactly why it read the same as a store outage.
    assert.equal(res.ok, false, 'a lock that names no finding asserts nothing');
    assert.equal(res.specId, null);
    assert.equal(res.reason, 'invalid-input');
    assert.match(res.message, /sourceFindingId/);
  });
});
