/**
 * @fileoverview Where `own-model-coverage.mjs` finds its three inputs, by LAYOUT.
 *
 * The CLI reads a floors config, the expected-schema fixture and the migrations
 * directory. In this repo they sit at their SOURCE paths; a consumer gets them
 * relocated by the sync (`sync-path-map`: `.audit-loop/...`), and the CLI itself
 * lands two directories deep (`scripts/.claude-skills/`). Counting `..` from the
 * script resolves to `<consumer>/scripts` there, so every input missed. The
 * answer is derived from the one map the sync writes with (`sourceRelToDestRel`),
 * never a second hand-kept list: a path the sync moves cannot be spelled wrong here.
 *
 * `report.mjs` (telemetry-export --report) reads the same config, so both call
 * this one resolver.
 *
 * @module scripts/lib/telemetry/coverage-inputs
 */
import fs from 'node:fs';
import path from 'node:path';
import { detectLayout } from '../tooling-layout.mjs';
import { sourceRelToDestRel, LAYOUT_CONSTANTS } from '../sync-path-map.mjs';
import { validateConfig } from './coverage.mjs';

/** The three inputs at their SOURCE paths (the migrations entry carries a trailing slash: the map keys on a prefix). */
export const COVERAGE_INPUT_SOURCES = Object.freeze({
  config: LAYOUT_CONSTANTS.OWN_MODEL_COVERAGE_SRC,
  schema: LAYOUT_CONSTANTS.EXPECTED_SCHEMA_SRC,
  migrations: LAYOUT_CONSTANTS.MIGRATIONS_SRC_PREFIX,
});

/** An input the layout expects is absent. Carries the repo-relative path so the message names it. */
export class CoverageInputMissingError extends Error {
  constructor(kind, rel, problem = 'missing') {
    super(problem === 'missing'
      ? `missing ${kind}: ${rel} (expected relative to the repo root)`
      : `invalid ${kind}: ${rel} (${problem})`);
    this.name = 'CoverageInputMissingError';
    this.code = 'COVERAGE_INPUT_MISSING';
    this.kind = kind;
    this.rel = rel;
    this.problem = problem;
  }
}

/**
 * Resolve the three inputs for a layout. PURE: `layout` and `root` arrive as arguments.
 *
 * @param {string} root - absolute repo root
 * @param {'source'|'consumer'} layout
 * @returns {{layout: string, root: string, config: {rel: string, abs: string}, schema: {rel: string, abs: string}, migrations: {rel: string, abs: string}}}
 */
export function resolveCoverageInputs(root, layout) {
  const one = (src) => {
    const mapped = layout === 'consumer' ? sourceRelToDestRel(src) : src;
    const rel = mapped.replace(/\/$/, '');
    return { rel, abs: path.join(root, ...rel.split('/')) };
  };
  return {
    layout,
    root,
    config: one(COVERAGE_INPUT_SOURCES.config),
    schema: one(COVERAGE_INPUT_SOURCES.schema),
    migrations: one(COVERAGE_INPUT_SOURCES.migrations),
  };
}

/** The layout a module file is installed under + its inputs, resolved against `root`. */
export function resolveCoverageInputsFor(root, moduleFilePath) {
  return resolveCoverageInputs(root, detectLayout(moduleFilePath));
}

/**
 * Read an input as text, or throw {@link CoverageInputMissingError} naming the mapped path.
 *
 * @param {{rel: string, abs: string}} input
 * @param {string} kind
 * @returns {string}
 */
export function readCoverageInput(input, kind) {
  try {
    return fs.readFileSync(input.abs, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') throw new CoverageInputMissingError(kind, input.rel);
    // Present but unreadable (EACCES, EISDIR, ...): a different fact from "not valid JSON" or "missing", and said so.
    throw new CoverageInputMissingError(kind, input.rel, 'could not read');
  }
}

/** Load + parse the floors config from the resolved inputs. */
export function loadCoverageConfig(inputs) {
  return JSON.parse(readCoverageInput(inputs.config, 'coverage config'));
}

/** Table/view → column-name set from the expected-schema fixture. */
export function loadSchemaColumns(inputs) {
  const invalid = (why) => new CoverageInputMissingError('schema fixture', inputs.schema.rel, why);
  let fx;
  try { fx = JSON.parse(readCoverageInput(inputs.schema, 'schema fixture')); } catch (err) {
    if (err instanceof CoverageInputMissingError) throw err;
    throw invalid('not valid JSON');
  }
  // An empty or mis-shaped fixture would make every tracked column read as "not in the schema": a wrong answer, not an error.
  if (!Array.isArray(fx?.tables) || fx.tables.length === 0) throw invalid('tables must be a non-empty array');
  const colName = (c) => (typeof c === 'string' ? c : c?.column_name);
  const goodName = (c) => typeof colName(c) === 'string' && colName(c).length > 0;
  for (const t of fx.tables) {
    if (!t || typeof t.table_name !== 'string' || t.table_name.length === 0 || !Array.isArray(t.columns)) throw invalid('every table needs a table_name and a columns array');
    // `tables[].columns[]` are objects with a `column_name` in the real fixture; a bare string is accepted, a nameless entry is not.
    if (!t.columns.every(goodName)) throw invalid('every column needs a non-empty column_name');
  }
  // Views carry a `definition` and no column list in the real fixture; where a list IS given it is held to the same rule.
  if (fx.views !== undefined && !Array.isArray(fx.views)) throw invalid('views must be an array');
  for (const v of fx.views ?? []) {
    const viewName = v?.view_name ?? v?.table_name;
    if (!v || typeof v !== 'object' || typeof viewName !== 'string' || viewName.length === 0) throw invalid('every view needs a view_name');
    if (v.columns !== undefined && !(Array.isArray(v.columns) && v.columns.every(goodName))) throw invalid('every view column needs a non-empty column_name');
  }
  const m = new Map();
  // The SAME accessor the validator used, so a bare-string column the validator accepted maps to its name (R3 H1).
  for (const t of fx.tables ?? []) m.set(t.table_name, new Set((t.columns ?? []).map(colName)));
  for (const v of fx.views ?? []) m.set(v.view_name ?? v.table_name, new Set((v.columns ?? []).map(colName)));
  return m;
}

/** The migrations, `{name, sql}` sorted by name. */
export function loadMigrations(inputs) {
  let names;
  try {
    names = fs.readdirSync(inputs.migrations.abs);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') throw new CoverageInputMissingError('migrations directory', inputs.migrations.rel);
    throw new CoverageInputMissingError('migrations directory', inputs.migrations.rel, 'could not read');
  }
  // A migration that cannot be read is the same typed failure as an unreadable directory (final gate L), never a raw throw.
  return names.filter((f) => f.endsWith('.sql')).sort().map((f) => {
    try {
      return { name: f, sql: fs.readFileSync(path.join(inputs.migrations.abs, f), 'utf8') };
    } catch {
      throw new CoverageInputMissingError('migrations directory', inputs.migrations.rel, 'could not read');
    }
  });
}

/**
 * The floors config for a REPORT, which must degrade rather than throw: a missing or invalid config is
 * `{config: null, problem}` with a closed reason, and the report prints the coverage group as unmeasured.
 *
 * @param {ReturnType<typeof resolveCoverageInputs>} inputs
 * @returns {{config: object|null, problem: 'config-missing'|'config-unreadable'|'config-invalid'|null}}
 */
export function tryLoadCoverageConfig(inputs) {
  let config;
  try {
    config = loadCoverageConfig(inputs);
  } catch (err) {
    if (err instanceof CoverageInputMissingError) return { config: null, problem: err.problem === 'missing' ? 'config-missing' : 'config-unreadable' };
    return { config: null, problem: 'config-invalid' };
  }
  return validateConfig(config).length === 0 ? { config, problem: null } : { config: null, problem: 'config-invalid' };
}
