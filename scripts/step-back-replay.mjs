#!/usr/bin/env node
/**
 * @fileoverview CLI — the step-back replay harness and its dataset freezer
 * (docs/plans/verification-lessons.md §2.4). A PAID run needs --confirm-spend, --max-usd and --results (a JSONL file
 * every paid call is appended to BEFORE scoring); --dry-run prints the planned calls and the preflight cost bound and makes none.
 * The bound is conservative, not absolute: characters cannot truly upper-bound tokens, so the hard stop is enforced on METERED
 * actuals after each call. A paid run REFUSES an existing --results path (it never truncates); a resume is `score` only.
 *
 *   node scripts/step-back-replay.mjs export --branches a,b --since 2026-11-19 --out .audit/step-back-export.json   (READ-ONLY SELECTs, filtered by repo_id)
 *   node scripts/step-back-replay.mjs propose --export .audit/step-back-export.json        (PROPOSES run-id lists per branch; pins nothing)
 *   node scripts/step-back-replay.mjs freeze --export .audit/step-back-export.json --spec docs/research/step-back-replay-spec.json --out <dataset.json>
 *   node scripts/step-back-replay.mjs run --dataset <dataset.json> --arms none,same,different,higher --dry-run
 *   node scripts/step-back-replay.mjs run --dataset <dataset.json> --arms same,different --max-usd 20 --confirm-spend --results .audit/sbr-calls.jsonl --out .audit/sbr-results.json
 *   node scripts/step-back-replay.mjs score --dataset <dataset.json> --results .audit/sbr-calls.jsonl [--out <scores.json>]
 *
 * The spec PINS, per PR, the exact ordered `audit_runs.id` list (`runIds`); `propose` prints candidate lists (runs on the
 * branch, mode=code, contiguous with no gap over 3h) and the operator writes the chosen one into the spec.
 * Run a paid replay from a `npm run fixture:create` worktree (a spend-bearing run pins its revision).
 *
 * Exit: 0 ok, 2 argument error, 5 stopped by --max-usd (results still written), 1 failure.
 *
 * @module scripts/step-back-replay
 */
import './lib/load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { readFlagValue } from './lib/audit/round-cap.mjs';
import { freezeDataset, scoringPathFor } from './lib/audit/step-back-dataset.mjs';
import { exportRows, freezeFromExport, proposeRuns } from './lib/audit/step-back-export.mjs';
import { claudeAvailability } from './lib/anthropic-client.mjs';
import { runReplay, scoreReplay, renderDryRun, renderScoreTable, readResultsJsonl, verifyDatasetInputs, sha256Hex, REPLAY_ARMS } from './lib/audit/step-back-replay.mjs';

const KNOWN_FLAGS = ['--spec', '--out', '--dataset', '--arms', '--max-usd', '--dry-run', '--confirm-spend', '--branches', '--since', '--export', '--results', '--repo-id', '--json', '--selfcheck-relocation'];
export const EXIT_BUDGET_STOP = 5;

const writeJson = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`); };

/** READ-ONLY repo id lookup (a plain SELECT; never `resolveRepoForStoreResult`, which can INSERT a repo row). */
async function defaultRepoId(query) {
  const { resolveRepoIdentity } = await import('./lib/repo-identity.mjs');
  const { repoUuid } = resolveRepoIdentity(process.cwd());
  const r = await query('SELECT id FROM audit_repos WHERE repo_uuid = $1 LIMIT 1', [repoUuid]);
  const rows = Array.isArray(r) ? r : r.rows;
  if (!rows[0]?.id) throw new Error('this repo has no audit_repos row in the store; pass --repo-id');
  return rows[0].id;
}

/** One pooled connection for the export transaction (BEGIN..COMMIT must share it); released in all cases. */
async function withOneConnection(fn) {
  const pool = await (await import('./lib/db/client.mjs')).getPool();
  if (!pool) throw new Error('no audit store configured (AUDIT_DB_URL)');
  const client = await pool.connect();
  try { return await fn((sql, params) => client.query(sql, params)); } finally { client.release(); }
}

function scoreFrom({ datasetPath, resultsPath, arms, deps }) {
  const parsed = readResultsJsonl(fs.readFileSync(resultsPath, 'utf8'));
  // Ground truth is read ONLY here, after every call, and only from the results file's perspective.
  const truth = (deps.readScoring || ((p) => JSON.parse(fs.readFileSync(p, 'utf8'))))(scoringPathFor(datasetPath)).truth;
  return { parsed, score: scoreReplay({ calls: parsed.calls, truth, arms: arms || parsed.arms || REPLAY_ARMS, plan: parsed.plan, unmeasured: parsed.unmeasured }) };
}

const summaryOf = (score) => Object.entries(score.arms).map(([a, s]) => `${a}: ${s.verdict} (early ${s.earlyStops}, false ${s.falseStops}, invalid ${s.invalidOutputs}, truncated ${s.truncated ?? 0})`).join(' | ');
const modelsOf = (parsed) => Object.fromEntries((parsed.plan || []).map((p) => [p.arm, p.model]));

/** @returns {Promise<number>} the exit code */
export async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); return 0; }
  const cmd = argv.find((a) => !a.startsWith('--')) || 'run';
  const flag = (f) => readFlagValue(argv, f).value;
  const query = deps.query || (async (sql, params) => { const pool = await (await import('./lib/db/client.mjs')).getPool(); if (!pool) throw new Error('no audit store configured (AUDIT_DB_URL)'); return pool.query(sql, params); });

  if (cmd === 'export') {
    const branches = (flag('--branches') || '').split(',').map((b) => b.trim()).filter(Boolean);
    const since = flag('--since'); const out = flag('--out');
    if (!branches.length || !since || !out) throw new ArgvError('step-back-replay export: --branches <csv>, --since <date> and --out are required.');
    if (Number.isNaN(Date.parse(since))) throw new ArgvError('step-back-replay export: --since must be a date.');
    const repoId = flag('--repo-id') || await defaultRepoId(query);
    // READ-ONLY: SELECTs only, inside ONE REPEATABLE READ READ ONLY transaction on one connection (EXPORT_SQL, EXPORT_TX).
    const exp = deps.query ? await exportRows({ branches, since, repoId, query }) : await withOneConnection(async (q) => exportRows({ branches, since, repoId, query: q }));
    writeJson(out, exp);
    console.log(`step-back-replay export: ${exp.runs.length} runs, ${exp.findings.length} findings, ${exp.events.length} events for ${branches.length} branch(es) -> ${out}`);
    return 0;
  }
  if (cmd === 'propose') {
    const exportPath = flag('--export');
    if (!exportPath) throw new ArgvError('step-back-replay propose: --export is required.');
    const exp = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    for (const branch of exp.branches) {
      const groups = proposeRuns(exp, branch);
      console.log(`${branch}: ${groups.length} contiguous group(s)${groups.length === 1 ? '' : ' - AMBIGUOUS, choose one'}`);
      groups.forEach((g, i) => console.log(`  [${i + 1}] ${g.count} runs ${g.from} .. ${g.to} (${g.shas} with audited_sha)\n      "runIds": ${JSON.stringify(g.runIds)}`));
    }
    console.log('Nothing was pinned. Copy the chosen "runIds" into the spec for each PR; freeze refuses a PR without them.');
    return 0;
  }
  if (cmd === 'freeze') {
    const specPath = flag('--spec'); const out = flag('--out');
    if (!specPath || !out) throw new ArgvError('step-back-replay freeze: --spec and --out are required.');
    const exportPath = flag('--export');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const { dataset, scoring } = exportPath
      ? freezeFromExport({
        exp: JSON.parse(fs.readFileSync(exportPath, 'utf8')), spec, exportPath,
        inputs: { exportSha256: sha256Hex(fs.readFileSync(exportPath)), specPath, specSha256: sha256Hex(fs.readFileSync(specPath)) },
      })
      : freezeDataset({ spec });
    writeJson(out, dataset); writeJson(scoringPathFor(out), scoring);
    const rec = dataset.prs.filter((p) => p.status === 'recoverable').length;
    console.log(`step-back-replay freeze: ${rec} recoverable, ${dataset.prs.length - rec} unrecoverable -> ${out} (+ ${scoringPathFor(out)})`);
    for (const p of dataset.prs.filter((x) => x.status !== 'recoverable')) console.log(`  unrecoverable #${p.pr}: ${p.reason}`);
    return 0;
  }
  if (cmd === 'score') {
    const datasetPath = flag('--dataset'); const resultsPath = flag('--results');
    if (!datasetPath || !resultsPath) throw new ArgvError('step-back-replay score: --dataset and --results are required.');
    const { parsed, score } = scoreFrom({ datasetPath, resultsPath, deps });
    const out = flag('--out');
    if (out) {
      const forbidden = [datasetPath, scoringPathFor(datasetPath), resultsPath, parsed.dataset?.exportPath, flag('--spec')].filter(Boolean).map((p) => path.resolve(p));
      if (forbidden.includes(path.resolve(out))) throw new ArgvError('step-back-replay score: --out must not be the results file or any input (dataset, scoring, export, spec).');
    }
    if (out) writeJson(out, { version: 1, dataset: datasetPath, results: resultsPath, spentUsd: parsed.spentUsd, stopped: parsed.stopped, score });
    console.log(`step-back-replay score: spent $${parsed.spentUsd.toFixed(4)} - ${summaryOf(score)}${out ? ` -> ${out}` : ''}\n${renderScoreTable(score, modelsOf(parsed))}`);
    return 0;
  }
  if (cmd !== 'run') throw new ArgvError(`step-back-replay: unknown command "${cmd}" (export|propose|freeze|run|score).`);

  const datasetPath = flag('--dataset');
  if (!datasetPath) throw new ArgvError('step-back-replay run: --dataset is required.');
  const arms = (flag('--arms') || 'none,same,different').split(',').map((s) => s.trim()).filter(Boolean);
  const badArm = arms.find((a) => !REPLAY_ARMS.includes(a));
  if (badArm) throw new ArgvError(`step-back-replay: unknown arm "${badArm}" (${REPLAY_ARMS.join('|')}).`);
  const dryRun = argv.includes('--dry-run');
  const maxRaw = flag('--max-usd');
  const maxUsd = maxRaw == null ? null : Number(maxRaw);
  if (maxRaw != null && !(Number.isFinite(maxUsd) && maxUsd > 0)) throw new ArgvError('step-back-replay: --max-usd must be a positive number.');
  const resultsPath = flag('--results');
  if (!dryRun && (maxUsd == null || !argv.includes('--confirm-spend') || !resultsPath)) {
    throw new ArgvError('step-back-replay: a paid run needs --max-usd <n>, --confirm-spend and --results <file.jsonl> (use --dry-run to see the plan and cost).');
  }
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  verifyDatasetInputs(dataset, deps.readBytes || ((p) => fs.readFileSync(p)));
  if (!dryRun) {
    // Never truncate: an existing results file may hold paid output. Refuse it, and refuse any path that is also an input.
    const target = path.resolve(resultsPath);
    const inputPaths = [datasetPath, scoringPathFor(datasetPath), dataset.exportPath, dataset.inputs?.specPath, flag('--out')].filter(Boolean).map((p) => path.resolve(p));
    if (inputPaths.includes(target)) throw new ArgvError('step-back-replay: --results must not be the dataset, scoring, export, spec or --out path.');
    if (fs.existsSync(target)) throw new ArgvError(`step-back-replay: --results ${resultsPath} already exists; a paid run never overwrites or appends to it (resume with the score subcommand).`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '', { flag: 'wx' });
  }
  // Every record is appended (and flushed by the synchronous write) as it is produced: a later failure cannot lose paid output.
  const onRecord = dryRun ? undefined : (rec) => fs.appendFileSync(resultsPath, `${JSON.stringify(rec)}\n`);
  const res = await runReplay({ dataset, arms, maxUsd, dryRun, deps: { ...deps, onRecord } });
  if (dryRun) {
    // The pinned-sdk question, asked of the one oracle (isClaudeAvailableFor('sdk') via claudeAvailability); never an env var.
    const sdkAvailable = deps.sdkAvailable ?? claudeAvailability('sdk').available;
    console.log(renderDryRun({ ...res, maxUsd, sdkAvailable }));
    return 0;
  }

  const { parsed, score } = scoreFrom({ datasetPath, resultsPath, arms, deps });
  const out = flag('--out');
  if (out) writeJson(out, { version: 1, dataset: datasetPath, results: resultsPath, arms, maxUsd, spentUsd: parsed.spentUsd, stopped: res.stopped, unrecoverable: res.unrecoverable, unmeasured: res.unmeasured, models: modelsOf(parsed), score });
  console.log(argv.includes('--json') ? JSON.stringify({ spentUsd: parsed.spentUsd, stopped: res.stopped, score }, null, 2)
    : `step-back-replay: spent $${parsed.spentUsd.toFixed(4)} of $${maxUsd}${res.stopped ? ` - STOPPED (${res.stopped.reason})` : ''} - ${summaryOf(score)}${out ? ` -> ${out}` : ''}\n${renderScoreTable(score, modelsOf(parsed))}`);
  return res.stopped ? EXIT_BUDGET_STOP : 0;
}

if (isInvokedAsScript(import.meta.url)) {
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'step-back-replay' });
    await finishAndExit(await main());
  } catch (err) {
    if (err instanceof ArgvError) { console.error(err.message); await finishAndExit(2); }
    console.error(`step-back-replay: ${err?.message || err}`);
    await finishAndExit(1);
  }
}
