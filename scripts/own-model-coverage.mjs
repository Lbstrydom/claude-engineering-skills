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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDENT = /^[a-z_][a-z0-9_]*$/;

function loadConfig(p) {
  return JSON.parse(fs.readFileSync(p ?? path.join(ROOT, '.own-model-coverage.json'), 'utf8'));
}

function schemaColumns() {
  const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'expected-schema.json'), 'utf8'));
  const m = new Map();
  for (const t of fx.tables ?? []) m.set(t.table_name, new Set((t.columns ?? []).map((c) => c.column_name)));
  for (const v of fx.views ?? []) m.set(v.view_name ?? v.table_name, new Set((v.columns ?? []).map((c) => c.column_name ?? c)));
  return m;
}

function migrations() {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ name: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
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

async function main(argv) {
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); return 0; }
  const sub = argv[2];
  assertKnownFlags(argv.slice(3), ['--static', '--live', '--out', '--config', '--tables', '--all-columns'], { cli: 'own-model-coverage', from: 0 });
  if (sub !== 'check' && sub !== 'snapshot') throw new ArgvError('usage: own-model-coverage.mjs check --static|--live | snapshot [--tables a,b --all-columns] --out <file>');
  const config = loadConfig(arg(argv, '--config'));
  const cfgErrs = validateConfig(config);
  if (cfgErrs.length) { process.stderr.write(`own-model-coverage: invalid config: ${cfgErrs.join('; ')}
`); console.log(JSON.stringify({ ok: false, errors: cfgErrs })); return 1; }

  if (sub === 'check' && argv.includes('--static')) {
    const errors = checkStatic(config, schemaColumns(), migrations());
    console.log(JSON.stringify({ mode: 'static', ok: errors.length === 0, errors }));
    return errors.length ? 1 : 0;
  }
  if (sub === 'check' && !argv.includes('--live')) throw new ArgvError('check needs --static or --live');

  const { closePool } = await import('./lib/db/client.mjs');
  try {
    if (sub === 'check') {
      const results = await measureLive(config.entries, config.windowDays ?? 30);
      const code = exitCodeFor(results);
      console.log(JSON.stringify({ mode: 'live', ok: code === 0, exitCode: code, measuredAt: new Date().toISOString(), results }));
      return code;
    }
    // snapshot
    const outFile = arg(argv, '--out');
    if (!outFile) throw new ArgvError('snapshot needs --out <file>');
    const { initLearningStore } = await import('./lib/store/repo.mjs');
    if (!await initLearningStore()) { process.stderr.write('own-model-coverage: no store configured\n'); return 3; }
    const doc = { schema: 'own-model-coverage-snapshot/v1', measuredAt: new Date().toISOString(), note: 'counts and null rates only; no row content' };
    if (argv.includes('--all-columns')) {
      const tables = String(arg(argv, '--tables') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!tables.length) throw new ArgvError('--all-columns needs --tables a,b');
      doc.tables = await snapshotAllColumns(tables);
    } else {
      doc.tracked = await measureLive(config.entries, config.windowDays ?? 30);
    }
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
