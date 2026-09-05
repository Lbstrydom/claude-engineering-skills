/**
 * @fileoverview Pure comparison of two Postgres schema catalogs.
 *
 * Split out of `scripts/setup-postgres.mjs` on 2026-09-05 (upstream report
 * 8174dc51): the three functions here are pure data transforms with no pool, no
 * filesystem and no CLI, and the CLI is over the file-size ratchet's limit.
 *
 * A "catalog" is the shape `SHARED_CATALOG_QUERIES` produces and
 * `tests/fixtures/expected-schema.json` records: `{schema, tables, functions,
 * views, policies, constraints, indexes, triggers, sequences, extensions,
 * grants, owners}`, every value an array of rows.
 *
 * @module scripts/lib/db/schema-diff
 */

/**
 * Replace each column's raw `ordinal_position` with a dense 1..N rank over the
 * columns that survive, in ascending ordinal order.
 *
 * `information_schema.columns.ordinal_position` IS pg `attnum` — physical
 * column-history state, not schema. Dropping a column leaves a permanent hole in
 * the numbering of every column that outlives it, so a DB built by REPLAYING the
 * migration sequence and a DB built from final-state DDL (a dump restore, a
 * snapshot bootstrap) carry different attnums for byte-identical schemas.
 * Measured 2026-09-05: `refresh_runs` is `1-5, 12-21` after replaying
 * `20260721150000`'s six-column drop, and `1..15` on the shared store
 * `d5a9d07b91225a93` — every other field identical, in identical order.
 * adopt-mode exists precisely to enrol a pre-existing, differently-provisioned
 * DB, so the comparison was strictest exactly where it was least likely to be
 * satisfiable, and said "drift" when the schema was identical. Report 8174dc51.
 *
 * What the rank KEEPS is what Postgres actually exposes: RELATIVE column order
 * (`SELECT *`, an `INSERT` with no column list). Dropping the field instead
 * would have retired ordering checks altogether — `canonicalise` SORTS arrays,
 * so array position carries no order information after canonicalisation and
 * this field is the comparator's only ordering assertion.
 *
 * The rank is written to `column_position`, never back onto `ordinal_position`:
 * a value that is no longer an attnum must not keep attnum's name, in a fixture
 * or in an operator-facing diff.
 *
 * @param {Record<string, unknown>} catalog - a captured or expected catalog
 * @returns {Record<string, unknown>} a copy with `tables[].columns[]` re-ranked
 */
export function denseRankColumnPositions(catalog) {
  if (!catalog || !Array.isArray(catalog.tables)) return catalog;
  return {
    ...catalog,
    tables: catalog.tables.map((table) => {
      if (!table || !Array.isArray(table.columns)) return table;
      // Rank by POSITION IN THE ARRAY, not by object identity: two columns can
      // legitimately be the same object reference in a hand-built catalog, and
      // an identity-keyed map would then hand them one shared rank.
      const rankByIndex = [];
      table.columns
        .map((col, index) => ({ index, ordinal: col?.ordinal_position ?? 0 }))
        .sort((a, b) => a.ordinal - b.ordinal)   // stable: ties keep array order
        .forEach((entry, i) => { rankByIndex[entry.index] = i + 1; });
      return {
        ...table,
        columns: table.columns.map((col, index) => {
          const { ordinal_position: _attnum, ...rest } = col;
          return { ...rest, column_position: rankByIndex[index] };
        }),
      };
    }),
  };
}

/** Recursively sort object keys so structural equality is order-independent. */
export function canonicalise(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) {
    return v.map(canonicalise).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  }
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalise(v[k]);
    return out;
  }
  return v;
}

/**
 * Diff two catalogs category by category.
 *
 * @param {Record<string, unknown>} expectedRaw - the committed manifest
 * @param {Record<string, unknown>} liveRaw - captured from the live DB
 * @returns {Array<{category:string, missingInLive:unknown[], extraInLive:unknown[], missingTotal:number, extraTotal:number}>}
 */
export function diffSchemas(expectedRaw, liveRaw) {
  // Normalise BOTH sides before anything is compared or reported, so the
  // item-level diff below can't re-introduce the attnum on the friendly path.
  const expected = denseRankColumnPositions(expectedRaw);
  const live = denseRankColumnPositions(liveRaw);
  const differences = [];
  const keys = new Set([...Object.keys(expected), ...Object.keys(live)]);
  keys.delete('schema');       // always 'public' by contract
  for (const k of keys) {
    const e = expected[k] || [];
    const l = live[k] || [];
    if (JSON.stringify(canonicalise(e)) !== JSON.stringify(canonicalise(l))) {
      // Compute item-level diff for friendlier output.
      const eSet = new Set(e.map((row) => JSON.stringify(canonicalise(row))));
      const lSet = new Set(l.map((row) => JSON.stringify(canonicalise(row))));
      const missingInLive = [...eSet].filter((s) => !lSet.has(s));
      const extraInLive = [...lSet].filter((s) => !eSet.has(s));
      differences.push({
        category: k,
        missingInLive: missingInLive.slice(0, 5).map((s) => JSON.parse(s)),
        extraInLive: extraInLive.slice(0, 5).map((s) => JSON.parse(s)),
        missingTotal: missingInLive.length,
        extraTotal: extraInLive.length,
      });
    }
  }
  return differences;
}
