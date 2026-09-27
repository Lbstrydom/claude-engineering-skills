/**
 * @fileoverview `setup-postgres.mjs --check-drift --live` — compare the LIVE
 * store's key constraints and indexes against the expected schema.
 *
 * ## The defect this closes (consumer report, 2026-09-26)
 *
 * A consumer store lost `bandit_arms_unique UNIQUE (pass_name, variant_id,
 * context_bucket)` out-of-band. Every audit then logged a 42P10 lost write, and
 * `--check-drift` read CLEAN — it compares the applied-migrations LEDGER to the
 * source files, and a ledger with zero pending migrations says nothing about
 * whether an object those migrations created still exists. The only live-schema
 * comparison was `--adopt`'s, which runs once, at bootstrap.
 *
 * ## Scope — only what the expected schema declares
 *
 * Consumers add their own objects to a shared store. An EXTRA constraint or
 * index is therefore reported for context and never fails the check; only an
 * expected object that is MISSING or ALTERED counts. Constraints are narrowed to
 * PRIMARY KEY and UNIQUE — the ones an `ON CONFLICT` target resolves against —
 * plus every index (a unique index is an arbiter too). FOREIGN KEY and CHECK
 * definitions embed cross-schema references that legitimately differ between a
 * Supabase-hosted and a self-hosted store, and would false-alarm.
 *
 * ## Never auto-applies
 *
 * Each finding carries the exact repair statement derived from the EXPECTED
 * definition. It is printed for an operator; nothing here writes.
 *
 * Pure: no pool, no filesystem. The comparison is `diffSchemas` — the same one
 * `--adopt` uses — so there is exactly one definition of "live ≠ expected".
 *
 * @module scripts/lib/db/constraint-drift
 */

import { diffSchemas } from './schema-diff.mjs';

/** Catalog categories this check reads — pass to `captureLiveSchema({only})`. */
export const LIVE_CONSTRAINT_CATEGORIES = Object.freeze(['constraints', 'indexes']);

/** Constraint types an ON CONFLICT target can resolve against. */
const KEY_CONSTRAINT_TYPES = new Set(['PRIMARY KEY', 'UNIQUE']);

const IDENT_SAFE = /^[a-z_][a-z0-9_$]*$/;

/** Quote a Postgres identifier only when it needs it. */
export function quoteIdent(name) {
  const s = String(name);
  return IDENT_SAFE.test(s) ? s : `"${s.replace(/"/g, '""')}"`;
}

function project(catalog) {
  return {
    constraints: (catalog?.constraints || []).filter((r) => KEY_CONSTRAINT_TYPES.has(r?.constraint_type)),
    indexes: catalog?.indexes || [],
  };
}

const KEY_OF = {
  constraints: (r) => `${r.table_name}.${r.constraint_name}`,
  indexes: (r) => `${r.tablename}.${r.indexname}`,
};

function tableOf(category, row) {
  return category === 'constraints' ? row.table_name : row.tablename;
}

function nameOf(category, row) {
  return category === 'constraints' ? row.constraint_name : row.indexname;
}

function definitionOf(category, row) {
  return category === 'constraints' ? row.definition : row.indexdef;
}

/**
 * The repair statement for one finding, derived from the EXPECTED definition.
 *
 * A MISSING object needs only its ADD/CREATE — there is nothing to drop. An
 * ALTERED object needs a drop then a recreate, and those two must be ONE unit:
 * printed as separate statements, a recreate that fails (duplicate rows under a
 * UNIQUE, a lock timeout) leaves the original already dropped — strictly worse
 * than the drift being repaired. Postgres DDL is transactional (and a
 * non-CONCURRENT CREATE INDEX is legal inside a transaction), so the pair is
 * wrapped in `BEGIN; … COMMIT;` and a failed recreate rolls the drop back.
 */
function repairFor(kind, category, expected) {
  const table = `public.${quoteIdent(tableOf(category, expected))}`;
  const name = quoteIdent(nameOf(category, expected));
  const [drop, create] = category === 'constraints'
    ? [`ALTER TABLE ${table} DROP CONSTRAINT ${name};`, `ALTER TABLE ${table} ADD CONSTRAINT ${name} ${expected.definition};`]
    : [`DROP INDEX public.${name};`, `${expected.indexdef};`];
  return kind === 'altered' ? `BEGIN; ${drop} ${create} COMMIT;` : create;
}

/**
 * Fail CLOSED on a vacuous expected inventory. With nothing expected,
 * `diffSchemas` has nothing to find missing, every live object lands in `extra`
 * (which never fails), and the check would print a clean pass having checked
 * nothing. An expected schema with no PRIMARY KEY / UNIQUE constraint, or no
 * index, is not a real store's schema — it is a truncated or placeholder
 * manifest, and the honest result is "not measured".
 *
 * @param {Record<string, unknown>} expected
 * @returns {string | null} the reason, or null when the inventory is usable
 */
export function vacuousInventoryReason(expected) {
  const exp = project(expected);
  const empty = [];
  if (!Array.isArray(expected?.constraints) || exp.constraints.length === 0) empty.push('PRIMARY KEY/UNIQUE constraints');
  if (!Array.isArray(expected?.indexes) || exp.indexes.length === 0) empty.push('indexes');
  if (!empty.length) return null;
  return `expected-schema manifest declares no ${empty.join(' and no ')} — a vacuous inventory `
    + 'checks nothing (truncated or placeholder manifest? re-run the sync)';
}

/**
 * Classify the difference between an expected and a live catalog's key
 * constraints and indexes.
 *
 * @param {Record<string, unknown>} expected - the expected-schema manifest
 * @param {Record<string, unknown>} live - `captureLiveSchema(pool, {only: LIVE_CONSTRAINT_CATEGORIES})`
 * @returns {{measured: true, hasDrift: boolean,
 *   missing: object[], altered: object[], extra: object[], repairs: string[]}
 *   | ReturnType<typeof unmeasuredConstraintDrift>}
 *   `missing`/`altered` fail the check; `extra` is context only. A vacuous
 *   expected inventory returns `measured:false` (see `vacuousInventoryReason`).
 */
export function assessConstraintDrift(expected, live) {
  const vacuous = vacuousInventoryReason(expected);
  if (vacuous) return unmeasuredConstraintDrift(vacuous);
  const diffs = diffSchemas(project(expected), project(live), { sampleLimit: Infinity });
  const missing = [];
  const altered = [];
  const extra = [];
  for (const d of diffs) {
    const keyOf = KEY_OF[d.category];
    if (!keyOf) continue;
    const liveByKey = new Map(d.extraInLive.map((r) => [keyOf(r), r]));
    const claimed = new Set();
    for (const exp of d.missingInLive) {
      const key = keyOf(exp);
      const base = {
        category: d.category,
        table: tableOf(d.category, exp),
        name: nameOf(d.category, exp),
        expected: definitionOf(d.category, exp),
      };
      if (liveByKey.has(key)) {
        claimed.add(key);
        altered.push({ ...base, live: definitionOf(d.category, liveByKey.get(key)), repair: repairFor('altered', d.category, exp) });
      } else {
        missing.push({ ...base, repair: repairFor('missing', d.category, exp) });
      }
    }
    for (const [key, row] of liveByKey) {
      if (claimed.has(key)) continue;
      extra.push({ category: d.category, table: tableOf(d.category, row), name: nameOf(d.category, row), live: definitionOf(d.category, row) });
    }
  }

  // A PRIMARY KEY / UNIQUE constraint owns an index of the same name, so a
  // missing constraint also shows as a missing index. Restoring the constraint
  // recreates the index; printing both repairs would make the second one fail.
  const constraintKeys = new Set([...missing, ...altered]
    .filter((f) => f.category === 'constraints').map((f) => `${f.table}.${f.name}`));
  const repairs = [];
  for (const f of [...missing, ...altered]) {
    if (f.category === 'indexes' && constraintKeys.has(`${f.table}.${f.name}`)) {
      f.repair = null;
      f.restoredBy = 'constraint';
      continue;
    }
    repairs.push(f.repair);
  }

  return { measured: true, hasDrift: missing.length + altered.length > 0, missing, altered, extra, repairs };
}

/**
 * The honest result when the check was asked for and could not run — never a
 * clean pass.
 *
 * @param {string} reason
 * @returns {{measured: false, hasDrift: false, reason: string}}
 */
export function unmeasuredConstraintDrift(reason) {
  return { measured: false, hasDrift: false, reason };
}

/**
 * Run the live check end to end: read the manifest, capture the live key
 * constraints/indexes, classify. The one impure entry point in this module —
 * its I/O is injected so the CLI wiring is testable without a database.
 *
 * Never throws for a missing manifest: that is `measured:false` with the
 * reason, because a consumer that has not synced `.audit-loop/expected-schema.json`
 * has not been checked, and must not read as clean.
 *
 * @param {object} args
 * @param {object} args.pool
 * @param {string} args.expectedSchemaPath
 * @param {(pool: object, opts: {only: readonly string[]}) => Promise<object>} args.capture - `captureLiveSchema`
 * @param {{existsSync: (p: string) => boolean, promises: {readFile: Function}}} args.fs
 */
export async function checkLiveConstraints({ pool, expectedSchemaPath, capture, fs }) {
  if (!fs.existsSync(expectedSchemaPath)) {
    return unmeasuredConstraintDrift(`expected-schema manifest not found at ${expectedSchemaPath} `
      + '(synced to .audit-loop/expected-schema.json in a consumer — re-run the sync)');
  }
  let expected;
  try {
    expected = JSON.parse(await fs.promises.readFile(expectedSchemaPath, 'utf-8'));
  } catch (err) {
    return unmeasuredConstraintDrift(`expected-schema manifest unreadable: ${err.message}`);
  }
  // Checked BEFORE the capture, so a vacuous manifest never touches the pool.
  const vacuous = vacuousInventoryReason(expected);
  if (vacuous) return unmeasuredConstraintDrift(vacuous);
  const live = await capture(pool, { only: LIVE_CONSTRAINT_CATEGORIES });
  return assessConstraintDrift(expected, live);
}

/**
 * Human report lines. PURE.
 *
 * @param {ReturnType<typeof assessConstraintDrift> | ReturnType<typeof unmeasuredConstraintDrift>} result
 * @returns {string[]}
 */
export function renderConstraintDrift(result) {
  const lines = ['', '── Live constraint/index check ──'];
  if (!result.measured) {
    lines.push(`  NOT MEASURED — ${result.reason}. This is not a clean result.`);
    return lines;
  }
  if (!result.hasDrift) {
    lines.push('  ✓ every expected PRIMARY KEY / UNIQUE constraint and index is present and unaltered');
  }
  for (const f of result.missing) {
    lines.push(`  missing ${f.category === 'constraints' ? 'constraint' : 'index'} ${f.table}.${f.name}: ${f.expected}`
      + (f.restoredBy ? ' (restored by the constraint repair)' : ''));
  }
  for (const f of result.altered) {
    lines.push(`  altered ${f.category === 'constraints' ? 'constraint' : 'index'} ${f.table}.${f.name}`);
    lines.push(`    expected: ${f.expected}`);
    lines.push(`    live:     ${f.live}`);
  }
  if (result.hasDrift && result.extra.length) {
    const touched = new Set([...result.missing, ...result.altered].map((f) => f.table));
    const near = result.extra.filter((e) => touched.has(e.table));
    for (const e of near) {
      lines.push(`  extra on the same table (possible out-of-band replacement): ${e.table}.${e.name}: ${e.live}`);
    }
  }
  if (result.extra.length) {
    lines.push(`  ${result.extra.length} extra constraint/index object(s) not in the expected schema — informational, never a failure`);
  }
  if (result.repairs.length) {
    lines.push('', '  Repair (review first — NOT applied; run with the store OWNER role).');
    lines.push('  If `--check-drift` also lists unapplied migrations, run `--migrate` first — it may restore these.');
    lines.push('  A UNIQUE constraint cannot be added while duplicate rows exist; dedupe those first.');
    for (const sql of result.repairs) lines.push(`    ${sql}`);
  }
  return lines;
}
