/**
 * @fileoverview Existence check of `on-conflict.mjs`'s `SCOPE_COLUMNS` list
 * against the committed, authoritative schema fixture
 * (`tests/fixtures/expected-schema.json`, regenerated on every schema change
 * via `npm run db:local:regen`).
 *
 * `SCOPE_COLUMNS` is hand-maintained with no drift detection of its own
 * (docs/plans/refactor-static-analysis.md §2.3, §1.2 "3b"). The census that
 * motivated this test found the hand list is EXACTLY correct today — zero
 * tenancy-shaped columns in the 71-table schema are unenforced, zero listed
 * columns are phantom — so a derivation engine has no current requirement.
 * What this test catches instead is the failure mode that actually breaks a
 * gate: a column RENAMED OR DROPPED by a migration, leaving a `SCOPE_COLUMNS`
 * entry that matches nothing — the `omitted-scope-identity` rule then
 * silently enforces nothing for that scope while still *appearing* to.
 *
 * A pure set-membership question against authoritative committed metadata —
 * no heuristic, no name-morphology regex (an earlier draft's tenancy-shape
 * regex was withdrawn, audit R1-H3 — see the plan for why). Discovering NEW
 * tenancy columns is a deliberately separate, deferred concern (§2.3 "Out of
 * Scope"); this test only asserts the list's members are real, not that the
 * list is complete.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SCOPE_COLUMNS } from '../scripts/lib/lint/on-conflict.mjs';

const FIXTURE_PATH = path.resolve(import.meta.dirname, 'fixtures/expected-schema.json');

/**
 * Load and validate the schema fixture. Hard-fails (throws) on anything
 * short of a well-formed, non-empty `tables` array — a missing, unparseable,
 * or empty fixture must never let this test read green having checked
 * nothing (gate-honesty, AGENTS.md).
 */
function loadSchemaFixture() {
  let raw;
  try {
    raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  } catch (err) {
    throw new Error(`on-conflict-scope-columns: could not read the schema fixture at ${FIXTURE_PATH} — ${err.message}`);
  }
  let schema;
  try {
    schema = JSON.parse(raw);
  } catch (err) {
    throw new Error(`on-conflict-scope-columns: ${FIXTURE_PATH} is not valid JSON — ${err.message}`);
  }
  if (!Array.isArray(schema.tables) || schema.tables.length === 0) {
    throw new Error(
      `on-conflict-scope-columns: ${FIXTURE_PATH} has no tables — the fixture is missing, empty, or stale. `
      + 'Run `npm run db:local:regen` to regenerate it before trusting this check.',
    );
  }
  return schema;
}

/** @returns {Map<string, string[]>} column name -> the table names carrying it */
function buildColumnTableIndex(schema) {
  const index = new Map();
  for (const table of schema.tables) {
    for (const column of table.columns || []) {
      if (!index.has(column.column_name)) index.set(column.column_name, []);
      index.get(column.column_name).push(table.table_name);
    }
  }
  return index;
}

test('the schema fixture is well-formed and non-empty (fails closed, never skips)', () => {
  const schema = loadSchemaFixture();
  assert.ok(schema.tables.length > 0);
});

test('every SCOPE_COLUMNS entry exists as a real column in the committed schema', () => {
  const schema = loadSchemaFixture();
  const columnTableIndex = buildColumnTableIndex(schema);
  const coverage = {};
  const missing = [];

  for (const col of SCOPE_COLUMNS) {
    const tables = columnTableIndex.get(col) || [];
    coverage[col] = tables.length;
    if (tables.length === 0) missing.push(col);
  }

  assert.deepEqual(
    missing, [],
    missing
      .map((col) => `"${col}" is in SCOPE_COLUMNS but exists in no table of the committed schema (${FIXTURE_PATH}) — `
        + 'a migration renamed or dropped it, so the omitted-scope-identity rule now enforces nothing for that '
        + 'scope. Update SCOPE_COLUMNS, or re-run `npm run db:local:regen` if the fixture is stale.')
      .join('\n'),
  );

  // Reported for context (today: repo_id 33, user_id 9, repo_name 5) — never
  // asserted as an exact count, since that would couple this test to
  // production schema churn this plan doesn't own.
  process.stderr.write(`  [on-conflict-scope-columns] per-column table coverage: ${JSON.stringify(coverage)}\n`);
});

test('SCOPE_COLUMNS itself is non-empty (a vacuously-passing empty set would defeat the whole check)', () => {
  assert.ok(SCOPE_COLUMNS.size > 0);
});
