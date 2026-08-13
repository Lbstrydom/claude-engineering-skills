/**
 * @fileoverview Parent-ownership for child writes (plan D7 / Phase 7).
 *
 * TWO TIERS, deliberately:
 *
 *  1. **Pure** — the SQL the builder emits and the reading of its two counts.
 *     Runs everywhere, needs no database, and covers the part most likely to
 *     rot: a builder that quietly stops emitting the repo predicate produces a
 *     statement that still works and no longer enforces anything.
 *  2. **DB-gated** (`AUDIT_DB_TEST_URL`) — the refusals against real Postgres,
 *     red-then-green. A dangling parent and a cross-repo parent must each be
 *     refused with their OWN reason, and a legitimate write must still land.
 *     Enrolment is TWO edits (`db-test-container.mjs` + `postgres-parity.yml`);
 *     `npm run db:enrolment:gate` fails if either is missing, because a
 *     DB-gated suite no runner names has never run.
 *
 * The pure tier cannot prove the SQL is VALID — only the DB tier can, and that
 * asymmetry is why both exist. A green pure tier over a syntactically broken
 * statement is exactly the shape this repo audits for.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PARENT_TABLES, buildOwnedInsert, classifyOwnedWrite, assertParentOwnership, ownedReadPredicate,
} from '../scripts/lib/store/ownership.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('the allowlist is closed', () => {
  it('rejects a parent table it does not know', () => {
    assert.throws(
      () => buildOwnedInsert({
        parentTable: 'audit_repos', childTable: 'x', columns: ['a'], rows: [[1]], parentId: 'p',
      }),
      /not an allowed parent table/,
    );
  });

  it('names every allowed table in the refusal, so the fix is obvious', () => {
    try {
      buildOwnedInsert({ parentTable: 'nope', childTable: 'x', columns: ['a'], rows: [[1]], parentId: 'p' });
      assert.fail('must throw');
    } catch (err) {
      for (const t of Object.keys(PARENT_TABLES)) assert.match(err.message, new RegExp(t));
    }
  });

  it('every entry declares either a repo column or a documented hop to one', () => {
    // The hop exists because `plan_verification_runs` has no `repo_id` of its
    // own — measured against the committed schema fixture. An entry with
    // NEITHER would silently produce a statement whose tenant predicate
    // compares against nothing.
    for (const [table, spec] of Object.entries(PARENT_TABLES)) {
      assert.ok(spec.idColumn, `${table}: needs idColumn`);
      assert.ok(spec.repoColumn || spec.repoVia,
        `${table}: needs repoColumn, or repoVia naming the table its tenant lives in`);
      if (spec.repoVia) {
        for (const k of ['table', 'localColumn', 'foreignColumn', 'repoColumn']) {
          assert.ok(spec.repoVia[k], `${table}.repoVia needs ${k}`);
        }
      }
    }
  });
});

describe('the emitted statement keeps BOTH guarantees visible', () => {
  const build = (over = {}) => buildOwnedInsert({
    parentTable: 'regression_specs',
    childTable: 'regression_spec_runs',
    columns: ['spec_id', 'passed'],
    rows: [['spec-1', true]],
    parentId: 'spec-1',
    repoId: 'repo-1',
    ...over,
  });

  it('selects FROM the parent — the existence join, not a bare INSERT', () => {
    assert.match(build().text, /INSERT INTO regression_spec_runs[\s\S]*SELECT [\s\S]*FROM parent/);
  });

  it('carries the tenant predicate, guarded so a null repoId relaxes it', () => {
    // `$2::uuid IS NULL OR …` is the whole of the "relax the TENANT predicate,
    // never the existence join" rule. Losing the left half would refuse every
    // unscoped write; losing the right half would accept every cross-repo one.
    assert.match(build().text, /\$2::uuid IS NULL OR parent\.repo_id = \$2/);
  });

  it('returns two counts, not rows — that is what separates the refusals', () => {
    // A bare join returns zero rows for not-found and not-owned alike. The
    // counts are the only thing that tells them apart (audit R3-H4).
    assert.match(build().text, /count\(\*\) FROM parent\)::int AS parent_found/);
    assert.match(build().text, /count\(\*\) FROM ins\)::int AS inserted/);
  });

  it('binds the parent id and repo id as $1/$2, values after', () => {
    const { values } = build();
    assert.equal(values[0], 'spec-1');
    assert.equal(values[1], 'repo-1');
    assert.deepEqual(values.slice(2), ['spec-1', true]);
  });

  it('emits one SELECT per row for a multi-row write, all parent-joined', () => {
    const { text, values } = build({ rows: [['a', true], ['b', false], ['c', true]] });
    assert.equal((text.match(/FROM parent WHERE/g) || []).length, 3,
      'every row must go through the parent — one unjoined row is an unowned write');
    assert.equal(values.length, 2 + 6);
  });

  it('reaches the tenant through the declared hop when the parent has no repo_id', () => {
    const { text } = buildOwnedInsert({
      parentTable: 'plan_verification_runs',
      childTable: 'plan_verification_items',
      columns: ['run_id'], rows: [['r1']], parentId: 'r1', repoId: 'repo-1',
    });
    assert.match(text, /LEFT JOIN plans f ON f\.id = p\.plan_id/);
    assert.match(text, /f\.repo_id AS repo_id/);
  });

  it('refuses an identifier that is not a plain lowercase name', () => {
    // Every identifier here is repo-authored, never caller-supplied — this is
    // defence in depth against a future caller threading one through, not a
    // claim that user input reaches it.
    assert.throws(() => buildOwnedInsert({
      parentTable: 'plans', childTable: 'x; DROP TABLE y', columns: ['a'], rows: [[1]], parentId: 'p',
    }), /unsafe child table identifier/);
    assert.throws(() => buildOwnedInsert({
      parentTable: 'plans', childTable: 'x', columns: ['a"b'], rows: [[1]], parentId: 'p',
    }), /unsafe child column identifier/);
  });

  it('returns the inserted id FROM the statement — not via a follow-up SELECT', () => {
    // The first version read the id back with
    // `SELECT id FROM <child> WHERE plan_id = $1 ORDER BY created_at DESC LIMIT 1`,
    // which hands back a CONCURRENT invocation's row whenever two verify runs
    // for the same plan overlap. Caught by the Phase-7 audit; it was a shortcut
    // around a RETURNING the statement already performed.
    assert.match(build().text, /\(SELECT id FROM ins LIMIT 1\) AS inserted_id/);
  });

  it('a parent-sourced column reads from the JOIN, and its caller value is never bound', () => {
    // recordPlanVerificationItems joined its parent on runId and then wrote the
    // caller's separately-supplied planId into every child row — so a run and
    // its criterion rows could name different plans. The join proved one thing
    // and the row recorded another. Sourcing the column from the parent makes
    // the mismatch unrepresentable rather than merely unchecked.
    const { text, values } = buildOwnedInsert({
      parentTable: 'plan_verification_runs',
      childTable: 'plan_verification_items',
      columns: ['run_id', 'plan_id'],
      rows: [['r1', 'CALLER-SUPPLIED'], ['r1', 'CALLER-SUPPLIED']],
      parentId: 'r1', repoId: 'repo-1',
      fromParent: { plan_id: 'plan_id' },
    });
    assert.match(text, /SELECT \$3, parent\.plan_id FROM parent/);
    assert.ok(!values.includes('CALLER-SUPPLIED'),
      'the caller-supplied value must not be bound at all — it cannot disagree with the parent if it is never sent');
    assert.match(text, /SELECT p\.id AS id, f\.repo_id AS repo_id, p\.plan_id/,
      'the parent CTE must actually select the column it sources');
  });

  it('refuses a fromParent naming a column the child insert does not have', () => {
    assert.throws(() => buildOwnedInsert({
      parentTable: 'plans', childTable: 'x', columns: ['a'], rows: [[1]],
      parentId: 'p', fromParent: { not_a_column: 'repo_id' },
    }), /not in the child column list/);
  });

  it('refuses an empty row set rather than emitting a statement that writes nothing', () => {
    assert.throws(() => buildOwnedInsert({
      parentTable: 'plans', childTable: 'x', columns: ['a'], rows: [], parentId: 'p',
    }), /non-empty array/);
  });
});

describe('reading the two counts', () => {
  it('parent_found 0 → parent-not-found', () => {
    assert.deepEqual(classifyOwnedWrite({ parent_found: 0, inserted: 0 }, 1).reason, 'parent-not-found');
  });

  it('parent found but nothing inserted → parent-not-owned', () => {
    // The distinction the design exists for: these two produce identical row
    // counts from a bare join, and mean completely different things.
    assert.deepEqual(classifyOwnedWrite({ parent_found: 1, inserted: 0 }, 1).reason, 'parent-not-owned');
  });

  it('a SHORT write is neither refusal — it is a row-count mismatch', () => {
    const r = classifyOwnedWrite({ parent_found: 1, inserted: 2 }, 3);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'row-count-mismatch');
    assert.match(r.message, /2 of 3/);
  });

  it('all rows written → ok', () => {
    assert.deepEqual(classifyOwnedWrite({ parent_found: 1, inserted: 3 }, 3), { ok: true, inserted: 3 });
  });

  it('a missing/undefined row is a refusal, never an accidental success', () => {
    // `pool.query` returning no rows must not read as "wrote everything".
    assert.equal(classifyOwnedWrite(undefined, 1).ok, false);
    assert.equal(classifyOwnedWrite({}, 1).reason, 'parent-not-found');
  });
});

describe('ownedReadPredicate — the read-path tenancy close-out', () => {
  it('requires the parent row to exist AND (optionally) to match the repo', () => {
    const p = ownedReadPredicate({
      parentTable: 'plans', idColumnInQuery: 'plan_id', idParam: 1, repoParam: 2,
    });
    assert.match(p, /EXISTS \(SELECT 1 FROM plans p WHERE p\.id = plan_id/);
    assert.match(p, /\$2::uuid IS NULL OR p\.repo_id = \$2/,
      'a null repoId relaxes the TENANT match; the EXISTS never relaxes — same asymmetry as the write side');
  });

  it('reaches the tenant through the declared hop for a parent with no repo_id', () => {
    const p = ownedReadPredicate({
      parentTable: 'plan_verification_runs', idColumnInQuery: 'run_id', idParam: 1, repoParam: 2,
    });
    assert.match(p, /SELECT f\.repo_id FROM plans f WHERE f\.id = p\.plan_id/);
  });

  it('rejects a parent off the closed allowlist, like every other entry point', () => {
    assert.throws(() => ownedReadPredicate({
      parentTable: 'audit_repos', idColumnInQuery: 'x', idParam: 1, repoParam: 2,
    }), /not an allowed parent table/);
  });

  it('refuses an unsafe column identifier', () => {
    assert.throws(() => ownedReadPredicate({
      parentTable: 'plans', idColumnInQuery: 'x; DROP TABLE y', idParam: 1, repoParam: 2,
    }), /unsafe query id column/);
  });
});

describe('the reporting readers carry the predicate', () => {
  // A census found FIFTEEN id-addressed readers with no repo predicate — not
  // the two an audit named. They are not one class, and the source assertion
  // below is about the ones that REPORT rows as the caller's. The
  // scope-DERIVING readers (resolveLabelTarget selects repo_id from the session
  // it was handed) must NOT take one: asking the caller for the tenant is
  // circular when computing it is the function's whole job.
  const read = (rel) => fs.readFileSync(path.resolve(HERE, '..', rel), 'utf8');

  for (const [file, fn] of [
    ['scripts/lib/store/plan-verification.mjs', 'readPlanSatisfaction'],
    ['scripts/lib/store/plan-verification.mjs', 'readPersistentPlanFailures'],
    ['scripts/lib/store/persona-correlations.mjs', 'readCorrelationsForRun'],
  ]) {
    it(`${fn} takes an optional repoId and uses it as a predicate`, () => {
      const src = read(file);
      const start = src.indexOf(`export async function ${fn}(`);
      assert.ok(start > -1, `${fn} not found — the anchor is stale`);
      const body = src.slice(start, src.indexOf('\nexport ', start + 1));
      assert.match(body, /\{ repoId = null \} = \{\}/, `${fn} must accept an optional repoId`);
      assert.match(body, /ownedReadPredicate\(/, `${fn} must apply the predicate, not merely accept the argument`);
    });
  }

  it('resolveLabelTarget does NOT take one — it DERIVES the repo', () => {
    const src = read('scripts/lib/store/persona-outcomes.mjs');
    const start = src.indexOf('export async function resolveLabelTarget(');
    const body = src.slice(start, src.indexOf('\nexport ', start + 1));
    assert.ok(!/ownedReadPredicate\(/.test(body),
      'a scope-deriving read must not ask the caller for the scope it computes');
    assert.match(body, /repo_id/, 'it establishes the tenant FROM the row');
  });
});

describe('assertParentOwnership — the transaction-scoped form', () => {
  const q = (row) => async () => row;

  it('a missing parent row is parent-not-found', async () => {
    const r = await assertParentOwnership(
      { parentTable: 'persona_test_sessions', parentId: 's1', repoId: 'repo-1' }, q(null));
    assert.equal(r.reason, 'parent-not-found');
  });

  it('a parent in another repo is parent-not-owned', async () => {
    const r = await assertParentOwnership(
      { parentTable: 'persona_test_sessions', parentId: 's1', repoId: 'repo-1' }, q({ repo_id: 'repo-2' }));
    assert.equal(r.reason, 'parent-not-owned');
  });

  it('a null repoId relaxes the TENANT check but not the existence check', async () => {
    const relaxed = await assertParentOwnership(
      { parentTable: 'persona_test_sessions', parentId: 's1', repoId: null }, q({ repo_id: 'repo-2' }));
    assert.equal(relaxed.ok, true, 'unresolvable scope must not refuse a legitimate write');
    const missing = await assertParentOwnership(
      { parentTable: 'persona_test_sessions', parentId: 's1', repoId: null }, q(null));
    assert.equal(missing.reason, 'parent-not-found',
      'existence is checked even with no scope — that is the half that never relaxes');
  });

  it('a matching repo is ok', async () => {
    const r = await assertParentOwnership(
      { parentTable: 'persona_test_sessions', parentId: 's1', repoId: 'repo-1' }, q({ repo_id: 'repo-1' }));
    assert.equal(r.ok, true);
  });

  it('reaches the tenant through the hop for a parent with no repo_id', async () => {
    let seen = '';
    await assertParentOwnership(
      { parentTable: 'plan_verification_runs', parentId: 'r1', repoId: 'repo-1' },
      async (text) => { seen = text; return { repo_id: 'repo-1' }; },
    );
    assert.match(seen, /SELECT f\.repo_id FROM plans f WHERE f\.id = p\.plan_id/);
  });

  it('rejects a table off the allowlist, same as the join builder', async () => {
    await assert.rejects(
      () => assertParentOwnership({ parentTable: 'audit_repos', parentId: 'x' }, q(null)),
      /not an allowed parent table/,
    );
  });
});
