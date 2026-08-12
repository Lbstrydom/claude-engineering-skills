/**
 * @fileoverview The D7 ownership refusals, against real Postgres.
 *
 * The pure tier (`tests/store-ownership.test.mjs`) proves the builder emits the
 * right SQL and reads its counts correctly. It cannot prove the statement is
 * VALID, and it cannot prove Postgres behaves the way the design assumes — a
 * CTE whose INSERT selects from an empty parent must write nothing rather than
 * error, and the two counts must come back distinguishable. Only a database
 * answers that, which is the whole reason this file exists beside that one.
 *
 * ENROLMENT IS TWO EDITS (AGENTS.md): `scripts/db-test-container.mjs`
 * (`*_SUITE_FILES`) **and** `.github/workflows/postgres-parity.yml`.
 * `npm run db:enrolment:gate` fails if either is missing — a DB-gated suite no
 * runner names has never run, and node reports a suite that never ran as a
 * clean pass. Fifteen suites sat in exactly that state until 2026-08-11.
 *
 * @module tests/store-ownership-db
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { one } from '../scripts/lib/db/query.mjs';
import { buildOwnedInsert, classifyOwnedWrite } from '../scripts/lib/store/ownership.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

const REPO_A = randomUUID();
const REPO_B = randomUUID();
const PLAN_A = randomUUID();
const PLAN_B = randomUUID();

describe('D7 parent-ownership — the refusals, against Postgres', { skip }, () => {
  let savedUrl;

  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    // Fail-closed BEFORE any pool reset — the 2026-07-14 wipe-incident guard.
    // "Disposable" is an ALLOWLIST of loopback hosts, never a denylist of
    // production ones.
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    const pool = await getPool();
    assert.ok(pool, 'pool must exist');
    for (const [id, name] of [[REPO_A, 'test/ownership-a'], [REPO_B, 'test/ownership-b']]) {
      await pool.query('INSERT INTO audit_repos (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, name]);
    }
    for (const [id, repo] of [[PLAN_A, REPO_A], [PLAN_B, REPO_B]]) {
      await pool.query(
        'INSERT INTO plans (id, repo_id, path, skill) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
        [id, repo, `docs/plans/ownership-${id.slice(0, 8)}.md`, 'plan'],
      );
    }
  });

  after(async () => {
    try {
      const pool = await getPool();
      if (pool) {
        await pool.query('DELETE FROM plan_verification_runs WHERE plan_id = ANY($1)', [[PLAN_A, PLAN_B]]).catch(() => {});
        await pool.query('DELETE FROM plans WHERE id = ANY($1)', [[PLAN_A, PLAN_B]]).catch(() => {});
        await pool.query('DELETE FROM audit_repos WHERE id = ANY($1)', [[REPO_A, REPO_B]]).catch(() => {});
      }
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
      await closePool();
      await _resetForTest();
    }
  });

  const writeRun = async (planId, repoId) => {
    const cols = ['plan_id', 'total_criteria', 'run_context'];
    const { text, values } = buildOwnedInsert({
      parentTable: 'plans',
      childTable: 'plan_verification_runs',
      columns: cols,
      // `run_context` is CHECK-constrained to ux-lock-verify|ci|manual. The
      // first draft passed 'ownership-db-test' and every LANDING case failed
      // with 23514 while both REFUSAL cases passed — the shape that says the
      // fixture is wrong, not the mechanism. Only the DB tier could show it.
      rows: [[planId, 1, 'manual']],
      parentId: planId,
      repoId,
    });
    return classifyOwnedWrite(await one(text, values), 1);
  };

  it('a legitimate owned write LANDS (the control — without it every refusal below is vacuous)', async () => {
    const res = await writeRun(PLAN_A, REPO_A);
    assert.equal(res.ok, true, `expected a write, got ${res.reason}: ${res.message}`);
    assert.equal(res.inserted, 1);
    const row = await one('SELECT count(*)::int AS n FROM plan_verification_runs WHERE plan_id = $1', [PLAN_A]);
    assert.equal(row.n, 1, 'the row must actually be in the table, not merely counted by the CTE');
  });

  it('a DANGLING parent id writes nothing and reports parent-not-found', async () => {
    const before = await one('SELECT count(*)::int AS n FROM plan_verification_runs', []);
    const res = await writeRun(randomUUID(), REPO_A);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'parent-not-found');
    const after = await one('SELECT count(*)::int AS n FROM plan_verification_runs', []);
    assert.equal(after.n, before.n, 'a refused write must leave the table untouched');
  });

  it("a CROSS-REPO parent writes nothing and reports parent-not-owned", async () => {
    // The distinction the design promises: this and the case above both write
    // zero rows, and a bare join could not tell them apart.
    const res = await writeRun(PLAN_B, REPO_A);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'parent-not-owned');
    const row = await one('SELECT count(*)::int AS n FROM plan_verification_runs WHERE plan_id = $1', [PLAN_B]);
    assert.equal(row.n, 0, 'the cross-repo row must not exist');
  });

  it('a NULL repoId relaxes the tenant predicate but NOT the existence join', async () => {
    // Unresolvable scope must not refuse legitimate work…
    const relaxed = await writeRun(PLAN_B, null);
    assert.equal(relaxed.ok, true, 'an unscoped write against a real parent must still land');
    // …and must still refuse a parent that does not exist.
    const missing = await writeRun(randomUUID(), null);
    assert.equal(missing.reason, 'parent-not-found',
      'the existence half never relaxes — that is what separates D7 from "skip the check when scope is absent"');
  });

  it('the hop-to-tenant parent (plan_verification_runs → plans) enforces the same two refusals', async () => {
    // plan_verification_runs carries no repo_id of its own; its tenant is
    // reached through `plans`. If the hop were wrong, this would either refuse
    // everything or accept everything — both silently.
    const parentRun = await one(
      'SELECT id FROM plan_verification_runs WHERE plan_id = $1 LIMIT 1', [PLAN_A]);
    assert.ok(parentRun?.id, 'the control write above must have produced a parent run');

    // Every NOT NULL column without a default, and both CHECK-constrained
    // enums, read off the committed schema fixture rather than guessed:
    // run_id, plan_id, criterion_hash, criterion_index, severity, category,
    // description, passed. `plan_id` comes from the PARENT (fromParent), which
    // is the H2/H7 fix — so the caller value below is deliberately never bound.
    const items = (runId, repoId) => buildOwnedInsert({
      parentTable: 'plan_verification_runs',
      childTable: 'plan_verification_items',
      columns: ['run_id', 'plan_id', 'criterion_hash', 'criterion_index', 'severity', 'category', 'description', 'passed'],
      rows: [[runId, null, 'hash-ownership-db', 0, 'P1', 'other', 'ownership-db-test criterion', true]],
      parentId: runId,
      repoId,
      fromParent: { plan_id: 'plan_id' },
    });

    const okQ = items(parentRun.id, REPO_A);
    const okRes = classifyOwnedWrite(await one(okQ.text, okQ.values), 1);
    assert.equal(okRes.ok, true,
      `the owning repo must be able to write through the hop — got ${okRes.reason}: ${okRes.message}`);

    // …and the child really carries the PARENT's plan, not the null the caller
    // supplied above. This is the H2/H7 fix observed end to end.
    const child = await one(
      'SELECT plan_id FROM plan_verification_items WHERE run_id = $1 LIMIT 1', [parentRun.id]);
    assert.equal(child.plan_id, PLAN_A, 'plan_id must come from the parent run, never from the caller');

    const badQ = items(parentRun.id, REPO_B);
    assert.equal(classifyOwnedWrite(await one(badQ.text, badQ.values), 1).reason, 'parent-not-owned',
      'a repo that does not own the PLAN must not write items to its run');

    await (await getPool()).query('DELETE FROM plan_verification_items WHERE run_id = $1', [parentRun.id]);
  });
});
