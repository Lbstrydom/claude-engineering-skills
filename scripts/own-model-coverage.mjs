#!/usr/bin/env node
/**
 * @fileoverview Null-rate coverage gate CLI (docs/plans/own-model-telemetry-pr3.md
 * decision 7). Pure logic lives in `lib/telemetry/coverage.mjs`.
 *
 *   node scripts/own-model-coverage.mjs check --static            offline; exit 0 / 1
 *   node scripts/own-model-coverage.mjs check --live             store; exit 0 ok / 1 drift or below-floor / 3 unmeasured
 *   node scripts/own-model-coverage.mjs snapshot --out f.json     dated tracked-column rates (counts only)
 *   node scripts/own-model-coverage.mjs snapshot --tables learning_decisions,fleet_events --all-columns --out f.json
 *
 * Counts and rates only: no row content ever leaves the store through this CLI.
 *
 * @module scripts/own-model-coverage
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './lib/load-env.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { assertKnownFlags, ArgvError, arg, finishAndExit } from './lib/cli-io.mjs';
import { validateConfig, buildMeasureSql, evaluateEntry, exitCodeFor, checkStatic } from './lib/telemetry/coverage.mjs';
import { ambientPopulation } from './lib/store/population-ambient.mjs';
import { renderPopulationLine } from './lib/population.mjs';
import { findRepoRootFromScript } from './lib/assert-repo-root.mjs';
import { resolveCoverageInputsFor, loadCoverageConfig, loadSchemaColumns, loadMigrations, CoverageInputMissingError } from './lib/telemetry/coverage-inputs.mjs';

const IDENT = /^[a-z_][a-z0-9_]*$/;

// Inputs resolve BY LAYOUT (lib/telemetry/coverage-inputs.mjs): counting `..` from here lands on
// `<consumer>/scripts` once the sync has relocated this file to `scripts/.claude-skills/`.
const HERE = fileURLToPath(import.meta.url);
const INPUTS = resolveCoverageInputsFor(findRepoRootFromScript(import.meta.url) || path.resolve(path.dirname(HERE), '..'), HERE);

function loadConfig(p) {
  return p ? JSON.parse(fs.readFileSync(p, 'utf8')) : loadCoverageConfig(INPUTS);
}

async function measureLive(entries, windowDays = 30) {
  const { initLearningStore } = await import('./lib/store/repo.mjs');
  const { many } = await import('./lib/db/query.mjs');
  if (!await initLearningStore()) return entries.map((e) => ({ ...e, ...evaluateEntry(e, null) }));
  const out = [];
  for (const e of entries) {
    let measured = null;
    try {
      const { sql, params } = buildMeasureSql(e, windowDays);
      const rows = await many(sql, params);
      measured = rows[0] ?? null;
    } catch (err) {
      process.stderr.write(`own-model-coverage: ${e.table}.${e.column}: ${err.code ?? err.message}\n`);
    }
    out.push({ table: e.table, column: e.column, where: e.where ?? 'all', since: e.since, expectFill: e.expectFill, baselineRate: e.baselineRate ?? null, ...evaluateEntry(e, measured) });
  }
  return out;
}

/** Every column of the named tables: fill counts since the epoch (the dated baseline of the memo's three tables). */
async function snapshotAllColumns(tables) {
  const { many } = await import('./lib/db/query.mjs');
  const out = [];
  for (const t of tables) {
    if (!IDENT.test(t)) throw new ArgvError(`bad table name: ${t}`);
    const cols = await many('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position', [t]);
    const names = cols.map((c) => c.column_name).filter((n) => IDENT.test(n));
    // ONE statement per table: the total and every column's filled count come from the same snapshot, so a
    // concurrent write cannot make them describe different states.
    const counts = (await many(`SELECT count(*)::int AS total${names.map((n, i) => `, count("${n}")::int AS c${i}`).join('')} FROM ${t}`))[0];
    const total = counts.total;
    const columns = names.map((n, i) => ({ column: n, filled: counts[`c${i}`], nullRate: total ? Number((1 - counts[`c${i}`] / total).toFixed(4)) : null }));
    out.push({ table: t, rows: total, columns });
  }
  return out;
}

/**
 * `linkage --session X [--round N]`: which calls, passes and findings belong to that session/round, and which rows
 * could not be linked. Read-only. Exit 0 when the session is known and fully placed, 1 when anything is unresolved or
 * the session is unknown (never an empty success), 3 when the store did not answer.
 */
async function linkageCommand(argv, deps = {}) {
  const session = arg(argv, '--session');
  if (!session) throw new ArgvError('linkage needs --session <id>');
  const roundRaw = arg(argv, '--round');
  const round = roundRaw == null ? null : Number(roundRaw);
  if (roundRaw != null && !(Number.isInteger(round) && round >= 1)) throw new ArgvError('--round must be a positive integer');
  const { closePool } = await import('./lib/db/client.mjs');
  try {
    const initStore = deps.initStore ?? (async () => (await import('./lib/store/repo.mjs')).initLearningStore());
    if (!await initStore()) { process.stderr.write('own-model-coverage: no store configured - nothing measured\n'); return 3; }
    const { many } = await import('./lib/db/query.mjs');
    const { columnExists } = await import('./lib/store/column-probes.mjs');
    const { isCloudEnabled } = await import('./lib/store/repo.mjs');
    const { queryLinkage } = await import('./lib/telemetry/linkage-queries.mjs');
    const hasState = await columnExists('audit_runs', 'linkage_state', many, isCloudEnabled);
    const report = await queryLinkage(many, { session, round, hasState });
    console.log(JSON.stringify({ mode: 'linkage', hasLinkageState: hasState, ...report }));
    if (!report.sessionKnown) process.stderr.write(`own-model-coverage: no runs carry session "${session}" - see unlinkedStoreWide for rows that carry none\n`);
    return report.complete ? 0 : 1;
  } finally { await closePool(); }
}

export async function main(argv, deps = {}) {
  const measure = deps.measureLive ?? measureLive;
  const initStore = deps.initStore ?? (async () => (await import('./lib/store/repo.mjs')).initLearningStore());
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); return 0; }
  const sub = argv[2];
  assertKnownFlags(argv.slice(3), ['--static', '--live', '--out', '--config', '--tables', '--all-columns', '--session', '--round'], { cli: 'own-model-coverage', from: 0 });
  if (sub === 'linkage') return linkageCommand(argv, deps);
  if (sub !== 'check' && sub !== 'snapshot') throw new ArgvError('usage: own-model-coverage.mjs check --static|--live | snapshot [--tables a,b --all-columns] --out <file> | linkage --session <id> [--round <n>]');
  if (sub === 'check' && argv.includes('--static') && argv.includes('--live')) throw new ArgvError('check takes --static OR --live, not both');
  let config;
  try { config = loadConfig(arg(argv, '--config')); } catch (err) {
    if (!(err instanceof CoverageInputMissingError)) throw err;
    process.stderr.write(`own-model-coverage: ${err.message}
`);
    return 1;
  }
  const cfgErrs = validateConfig(config);
  if (cfgErrs.length) { process.stderr.write(`own-model-coverage: invalid config: ${cfgErrs.join('; ')}
`); console.log(JSON.stringify({ ok: false, errors: cfgErrs })); return 1; }

  if (sub === 'check' && argv.includes('--static')) {
    let errors;
    try { errors = checkStatic(config, loadSchemaColumns(INPUTS), loadMigrations(INPUTS)); } catch (err) {
      if (!(err instanceof CoverageInputMissingError)) throw err;
      process.stderr.write(`own-model-coverage: ${err.message}
`);
      return 1;
    }
    console.log(JSON.stringify({ mode: 'static', ok: errors.length === 0, errors }));
    return errors.length ? 1 : 0;
  }
  if (sub === 'check' && !argv.includes('--live')) throw new ArgvError('check needs --static or --live');

  const { closePool } = await import('./lib/db/client.mjs');
  try {
    if (sub === 'check') {
      const results = await measure(config.entries, config.windowDays ?? 30);
      const code = exitCodeFor(results);
      // Store-wide: the measure SQL has no repo predicate, so every consumer on this store is in the population,
      // BUT only if the store actually answered: with no measured entry nothing was measured from it.
      const answered = results.some((r) => !String(r.status).startsWith('unmeasured'));
      const population = await ambientPopulation({ scope: 'store', answered });
      console.log(JSON.stringify({ mode: 'live', ok: code === 0, exitCode: code, measuredAt: new Date().toISOString(), population, results }));
      process.stderr.write(`${renderPopulationLine(population)}\n`);
      return code;
    }
    // snapshot
    const outFile = arg(argv, '--out');
    if (!outFile) throw new ArgvError('snapshot needs --out <file>');
    if (!await initStore()) { process.stderr.write('own-model-coverage: no store configured\n'); return 3; }
    const doc = { schema: 'own-model-coverage-snapshot/v1', measuredAt: new Date().toISOString(), note: 'counts and null rates only; no row content' };
    if (argv.includes('--all-columns')) {
      const tables = String(arg(argv, '--tables') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!tables.length) throw new ArgvError('--all-columns needs --tables a,b');
      doc.tables = await snapshotAllColumns(tables);
    } else {
      doc.tracked = await measure(config.entries, config.windowDays ?? 30);
    }
    // Same derivation as `check --live`: store-wide, and measured only if the store actually answered. The column
    // snapshot (no per-entry status) counts as answered: it would have thrown had the store not responded.
    const answered = doc.tracked ? doc.tracked.some((r) => !String(r.status).startsWith('unmeasured')) : true;
    doc.population = await ambientPopulation({ scope: 'store', answered });
    process.stderr.write(`${renderPopulationLine(doc.population)}\n`);
    fs.writeFileSync(outFile, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, out: outFile }));
    return 0;
  } finally { await closePool(); }
}

if (isInvokedAsScript(import.meta.url)) {
  main(process.argv).then((code) => finishAndExit(code), (err) => {
    process.stderr.write(`own-model-coverage: ${err.message}\n`);
    return finishAndExit(err?.code === 'ARGV_ERROR' ? 2 : 1);
  });
}
