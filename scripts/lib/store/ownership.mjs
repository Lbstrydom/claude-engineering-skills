/**
 * @fileoverview Parent-ownership for child writes — the shared join-clause
 * builder and the CLOSED parent-table allowlist
 * (docs/plans/cross-skill-command-registry.md D7, Phase 7).
 *
 * **The join lives in the WRITER's SQL, never in a caller-side pre-check.**
 * That is the whole decision (audit R2-H3): a `SELECT` followed by an `INSERT`
 * has a TOCTOU window and, worse, is a check a future caller can simply forget
 * to perform. One statement per write means the enforcement cannot be bypassed
 * by a caller that does not know it exists.
 *
 * The shape, and why it counts two things instead of returning rows:
 *
 * ```sql
 * WITH parent AS (SELECT id, repo_id FROM <parent> WHERE id = $1),
 *      ins AS (INSERT INTO <child> (…) SELECT … FROM parent
 *              WHERE ($2::uuid IS NULL OR parent.repo_id = $2) RETURNING id)
 * SELECT (SELECT count(*) FROM parent) AS parent_found,
 *        (SELECT count(*) FROM ins)    AS inserted;
 * ```
 *
 * A bare join returns zero rows for *parent not found* and *parent not owned*
 * alike, losing the very distinction this design promises (audit R3-H4). The
 * two counts keep them apart: `parent_found = 0` → `PARENT_NOT_FOUND`;
 * `parent_found = 1, inserted = 0` → `PARENT_NOT_OWNED`.
 *
 * **The repo predicate relaxes when scope is unresolvable; the EXISTENCE join
 * never does.** `$2 IS NULL` drops only the tenant match — a dangling parent
 * uuid still writes nothing and still reports `PARENT_NOT_FOUND`. The earlier
 * draft's "skip the check entirely when scope is absent" degrade is gone.
 *
 * **Threat model, stated so the design is not mistaken for more than it is:**
 * this is a single-tenant store whose DSN *is* the secret. The target is
 * DEFECTS — a wrong id threaded through, a command run from the wrong checkout
 * — not an attacker who already holds the DSN and can write SQL directly. That
 * bounds the design (no signatures, no session binding) without weakening it
 * against the defects it is for.
 *
 * @module scripts/lib/store/ownership
 */

/**
 * The closed allowlist of parent tables.
 *
 * Closed on purpose: a child write may only be scoped through a parent named
 * here, so adding one is a deliberate edit rather than a string a caller can
 * pass. `buildOwnedInsert` throws on an unknown key, which makes a typo a
 * loud failure instead of an unscoped write.
 *
 * **`repoVia` exists because the plan's assumption was wrong.** D7 was written
 * as though every parent carries `repo_id`; `plan_verification_runs` does not
 * (measured against the committed schema fixture — it has `plan_id` and
 * `spec_id` only). Its tenant lives one hop further, in `plans`. Rather than
 * silently exempting that one child from the repo predicate — which would make
 * the weakest link invisible — the hop is declared and joined.
 */
export const PARENT_TABLES = Object.freeze({
  regression_specs: { idColumn: 'id', repoColumn: 'repo_id' },
  plans: { idColumn: 'id', repoColumn: 'repo_id' },
  persona_test_sessions: { idColumn: 'id', repoColumn: 'repo_id' },
  plan_verification_runs: {
    idColumn: 'id',
    // No repo_id of its own — reach it through the plan the run belongs to.
    repoVia: { table: 'plans', localColumn: 'plan_id', foreignColumn: 'id', repoColumn: 'repo_id' },
  },
});

/** Identifier guard — every table/column below is repo-authored, never caller-supplied. */
const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name, what) {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`ownership: unsafe ${what} identifier ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Build the parent-joined INSERT for one or more child rows.
 *
 * @param {object} a
 * @param {string} a.parentTable  key in PARENT_TABLES
 * @param {string} a.childTable   the child table being written
 * @param {string[]} a.columns    child columns, in order
 * @param {Array<Array<unknown>>} a.rows  one array of values per row, matching `columns`
 * @param {string} a.parentId     the parent uuid
 * @param {string|null} a.repoId  tenant scope, or null to relax the tenant predicate
 * @param {Record<string,string>} [a.fromParent]  child column → PARENT column.
 *   Values for these come out of the joined parent row instead of from the
 *   caller. Added after the Phase-7 audit: `recordPlanVerificationItems` joined
 *   its parent on `runId` but then wrote the caller's separately-supplied
 *   `planId` into every child, so a run and its criterion rows could name
 *   DIFFERENT plans — the ownership join proved one thing and the row recorded
 *   another. Taking the value from the parent makes that unrepresentable rather
 *   than merely checked.
 * @returns {{text: string, values: unknown[]}}
 */
export function buildOwnedInsert({
  parentTable, childTable, columns, rows, parentId, repoId = null, fromParent = {},
}) {
  const spec = PARENT_TABLES[parentTable];
  if (!spec) {
    throw new Error(
      `ownership: "${parentTable}" is not an allowed parent table. `
      + `Allowed: ${Object.keys(PARENT_TABLES).join(', ')}. `
      + 'The allowlist is closed so a child write cannot be scoped through an arbitrary table.',
    );
  }
  ident(childTable, 'child table');
  columns.forEach((c) => ident(c, 'child column'));
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('ownership: rows must be a non-empty array');

  // Child columns whose value comes from the PARENT row, not the caller.
  for (const [child, parentCol] of Object.entries(fromParent)) {
    ident(parentCol, 'parent-sourced column');
    if (!columns.includes(child)) {
      throw new Error(`ownership: fromParent names "${child}", which is not in the child column list`);
    }
  }
  const parentExtra = [...new Set(Object.values(fromParent))];

  const values = [parentId, repoId];
  // $1 = parent id, $2 = repoId (nullable). Row values follow.
  const idCol = ident(spec.idColumn, 'parent id column');
  const parentCte = spec.repoVia
    ? `SELECT p.${idCol} AS id, f.${ident(spec.repoVia.repoColumn, 'repo column')} AS repo_id`
      + `${parentExtra.map((c) => `, p.${c}`).join('')} `
      + `FROM ${ident(parentTable, 'parent table')} p `
      + `LEFT JOIN ${ident(spec.repoVia.table, 'via table')} f `
      + `ON f.${ident(spec.repoVia.foreignColumn, 'via column')} = p.${ident(spec.repoVia.localColumn, 'local column')} `
      + `WHERE p.${idCol} = $1`
    : `SELECT ${idCol} AS id, ${ident(spec.repoColumn, 'repo column')} AS repo_id`
      + `${parentExtra.map((c) => `, ${c}`).join('')} `
      + `FROM ${ident(parentTable, 'parent table')} WHERE ${idCol} = $1`;

  const rowSelects = rows.map((row) => {
    const exprs = columns.map((col, i) => {
      // A parent-sourced column reads from the joined row; everything else is a
      // bound placeholder. Reading it from the parent is what makes a
      // run/plan mismatch UNREPRESENTABLE rather than merely checked.
      if (fromParent[col]) return `parent.${fromParent[col]}`;
      values.push(row[i]);
      return `$${values.length}`;
    });
    return `SELECT ${exprs.join(', ')} FROM parent WHERE ($2::uuid IS NULL OR parent.repo_id = $2)`;
  });

  const text =
    `WITH parent AS (${parentCte}), `
    + `ins AS (INSERT INTO ${childTable} (${columns.map((c) => `"${c}"`).join(', ')}) `
    + `${rowSelects.join(' UNION ALL ')} RETURNING id) `
    + 'SELECT (SELECT count(*) FROM parent)::int AS parent_found, '
    + '(SELECT count(*) FROM ins)::int AS inserted, '
    // The inserted id comes OUT of the CTE. The first version read it back with
    // a separate `SELECT … ORDER BY created_at DESC LIMIT 1`, which returns a
    // CONCURRENT invocation's row whenever two verify runs for one plan overlap
    // — a race the audit caught, and a plain semantic shortcut around the
    // RETURNING the statement already had.
    + '(SELECT id FROM ins LIMIT 1) AS inserted_id';

  return { text, values };
}

/**
 * The transaction-scoped form: prove the parent exists and is owned, from
 * INSIDE the transaction that then writes the child.
 *
 * **Use `buildOwnedInsert` unless you cannot.** D7's objection to
 * check-then-write is two-fold — the TOCTOU window, and a check a *caller* can
 * forget — and the join form removes both. This form removes the first only
 * (the check and the write commit or roll back together), and removes the
 * second by living inside the writer rather than at a call site.
 *
 * **Why one writer needs it.** `recordPersonaAuditCorrelation` is an UPSERT
 * whose two conflict targets are PARTIAL unique indexes, and it reaches them
 * through the shared `upsert()` helper. `scripts/lib/lint/on-conflict.mjs`
 * detects upsert sites by CALLEE NAME (`UPSERT_CALLEES = {'upsert'}`), so
 * rewriting that writer as raw CTE SQL would remove the store's
 * highest-leverage write from the scope-column lint entirely — trading one
 * guard for another rather than adding one. The trade is recorded here rather
 * than left for a reader to infer from its absence.
 *
 * @param {{parentTable: string, parentId: string, repoId?: string|null}} a
 * @param {(text: string, values: unknown[]) => Promise<object|null>} queryOne
 *   a single-row query bound to the CALLER'S transaction — passing a
 *   pool-level query would reopen the window this form exists to close.
 */
export async function assertParentOwnership({ parentTable, parentId, repoId = null }, queryOne) {
  const spec = PARENT_TABLES[parentTable];
  if (!spec) {
    throw new Error(
      `ownership: "${parentTable}" is not an allowed parent table. `
      + `Allowed: ${Object.keys(PARENT_TABLES).join(', ')}.`,
    );
  }
  const repoExpr = spec.repoVia
    ? `(SELECT f.${ident(spec.repoVia.repoColumn, 'repo column')} `
      + `FROM ${ident(spec.repoVia.table, 'via table')} f `
      + `WHERE f.${ident(spec.repoVia.foreignColumn, 'via column')} = p.${ident(spec.repoVia.localColumn, 'local column')})`
    : `p.${ident(spec.repoColumn, 'repo column')}`;
  const row = await queryOne(
    `SELECT ${repoExpr} AS repo_id FROM ${ident(parentTable, 'parent table')} p `
    + `WHERE p.${ident(spec.idColumn, 'parent id column')} = $1`,
    [parentId],
  );
  if (!row) {
    return {
      ok: false, reason: 'parent-not-found',
      message: 'the parent row does not exist — the write was refused rather than attached to nothing',
    };
  }
  // The tenant predicate relaxes when scope is unresolvable; EXISTENCE above
  // never does. Same asymmetry as the join form, for the same reason.
  if (repoId != null && row.repo_id !== repoId) {
    return {
      ok: false, reason: 'parent-not-owned',
      message: 'the parent row belongs to a different repository — refusing a cross-tenant write',
    };
  }
  return { ok: true };
}

/**
 * A tenant predicate for a READ addressed by an opaque row id.
 *
 * **Why reads needed their own answer.** D7 scoped child WRITES; the read path
 * was deferred, and a census then found **15** id-addressed readers with no
 * repo predicate — not the two an audit had named. But they are not one class,
 * and treating them alike would have been wrong in both directions:
 *
 *  - **Scope-DERIVING reads** (`resolveLabelTarget` selects `repo_id` from the
 *    session it was handed) establish the tenant FROM the id. Adding a predicate
 *    there is circular — you would be asking the caller for the answer the
 *    function exists to compute.
 *  - **Reporting reads** (`readPlanSatisfaction`, `readCorrelationsForRun`)
 *    return rows with no repo anywhere, and the caller presents them as its
 *    own. That is the 207-vs-0 shape: a number belonging to another repository,
 *    reported as this one's, indistinguishable from a real measurement.
 *
 * Only the second kind takes this. The asymmetry with writes is deliberate and
 * bounded: a cross-tenant WRITE corrupts the store irreversibly, so it is
 * refused in SQL that a caller cannot bypass; a cross-tenant READ misinforms one
 * caller, so an OPTIONAL predicate that relaxes when scope is unresolvable is
 * proportionate. `null` relaxes the tenant match; the EXISTS still requires the
 * parent row, exactly as on the write side.
 *
 * @param {{parentTable: string, idColumnInQuery: string, idParam: number, repoParam: number}} a
 * @returns {string} a SQL fragment for a WHERE clause
 */
export function ownedReadPredicate({ parentTable, idColumnInQuery, idParam, repoParam }) {
  const spec = PARENT_TABLES[parentTable];
  if (!spec) {
    throw new Error(
      `ownership: "${parentTable}" is not an allowed parent table. `
      + `Allowed: ${Object.keys(PARENT_TABLES).join(', ')}.`,
    );
  }
  ident(idColumnInQuery, 'query id column');
  const repoExpr = spec.repoVia
    ? `(SELECT f.${ident(spec.repoVia.repoColumn, 'repo column')} `
      + `FROM ${ident(spec.repoVia.table, 'via table')} f `
      + `WHERE f.${ident(spec.repoVia.foreignColumn, 'via column')} = p.${ident(spec.repoVia.localColumn, 'local column')})`
    : `p.${ident(spec.repoColumn, 'repo column')}`;
  return `EXISTS (SELECT 1 FROM ${ident(parentTable, 'parent table')} p `
    + `WHERE p.${ident(spec.idColumn, 'parent id column')} = ${idColumnInQuery} `
    + `AND ($${repoParam}::uuid IS NULL OR ${repoExpr} = $${repoParam}))`;
}

/**
 * Map the statement's two counts to a discriminated outcome.
 *
 * Kept separate from the builder so a writer can classify a result it obtained
 * any way it likes, and so the mapping is unit-testable without a database —
 * the DB-gated suite proves the SQL, this proves the reading of it.
 *
 * @param {{parent_found?: number, inserted?: number}} row
 * @param {number} requested  how many child rows the caller asked to write
 */
export function classifyOwnedWrite(row, requested) {
  const parentFound = Number(row?.parent_found ?? 0);
  const inserted = Number(row?.inserted ?? 0);
  if (parentFound === 0) {
    return {
      ok: false, inserted: 0, reason: 'parent-not-found',
      message: 'the parent row does not exist — the write was refused rather than attached to nothing',
    };
  }
  if (inserted === 0) {
    return {
      ok: false, inserted: 0, reason: 'parent-not-owned',
      message: 'the parent row belongs to a different repository — refusing a cross-tenant write',
    };
  }
  if (inserted !== requested) {
    return {
      ok: false, inserted, reason: 'row-count-mismatch',
      message: `INSERT affected ${inserted} of ${requested} row(s)`,
    };
  }
  return { ok: true, inserted };
}
