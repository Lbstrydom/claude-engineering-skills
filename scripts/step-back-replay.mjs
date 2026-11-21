#!/usr/bin/env node
/**
 * @fileoverview CLI — the step-back replay harness and its dataset freezer
 * (docs/plans/verification-lessons.md §2.4). A PAID run needs --confirm-spend and
 * --max-usd; --dry-run prints the planned calls and the estimated cost and makes none.
 *
 *   node scripts/step-back-replay.mjs freeze --spec docs/research/step-back-replay-spec.json --out docs/research/step-back-replay-2026-11.json
 *   node scripts/step-back-replay.mjs run --dataset docs/research/step-back-replay-2026-11.json --arms none,same,different --dry-run
 *   node scripts/step-back-replay.mjs run --dataset ... --arms same,different --max-usd 20 --confirm-spend --out .audit/step-back-replay-results.json
 *
 * Run a paid replay from a `npm run fixture:create` worktree (a spend-bearing run pins its revision). The spec's
 * `storeRows` are exported from the store's audit_runs by the operator; this CLI never queries the store.
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
import { runReplay, scoreReplay, renderDryRun, REPLAY_ARMS } from './lib/audit/step-back-replay.mjs';

const KNOWN_FLAGS = ['--spec', '--out', '--dataset', '--arms', '--max-usd', '--dry-run', '--confirm-spend', '--json', '--selfcheck-relocation'];
export const EXIT_BUDGET_STOP = 5;

const writeJson = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`); };

/** @returns {Promise<number>} the exit code */
export async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); return 0; }
  const cmd = argv.find((a) => !a.startsWith('--')) || 'run';
  const flag = (f) => readFlagValue(argv, f).value;

  if (cmd === 'freeze') {
    const specPath = flag('--spec'); const out = flag('--out');
    if (!specPath || !out) throw new ArgvError('step-back-replay freeze: --spec and --out are required.');
    const { dataset, scoring } = freezeDataset({ spec: JSON.parse(fs.readFileSync(specPath, 'utf8')) });
    writeJson(out, dataset); writeJson(scoringPathFor(out), scoring);
    const rec = dataset.prs.filter((p) => p.status === 'recoverable').length;
    console.log(`step-back-replay freeze: ${rec} recoverable, ${dataset.prs.length - rec} unrecoverable -> ${out} (+ ${scoringPathFor(out)})`);
    return 0;
  }
  if (cmd !== 'run') throw new ArgvError(`step-back-replay: unknown command "${cmd}" (freeze|run).`);

  const datasetPath = flag('--dataset');
  if (!datasetPath) throw new ArgvError('step-back-replay run: --dataset is required.');
  const arms = (flag('--arms') || 'none,same,different').split(',').map((s) => s.trim()).filter(Boolean);
  const badArm = arms.find((a) => !REPLAY_ARMS.includes(a));
  if (badArm) throw new ArgvError(`step-back-replay: unknown arm "${badArm}" (${REPLAY_ARMS.join('|')}).`);
  const dryRun = argv.includes('--dry-run');
  const maxRaw = flag('--max-usd');
  const maxUsd = maxRaw == null ? null : Number(maxRaw);
  if (maxRaw != null && !(Number.isFinite(maxUsd) && maxUsd > 0)) throw new ArgvError('step-back-replay: --max-usd must be a positive number.');
  if (!dryRun && (maxUsd == null || !argv.includes('--confirm-spend'))) {
    throw new ArgvError('step-back-replay: a paid run needs both --max-usd <n> and --confirm-spend (use --dry-run to see the plan and cost).');
  }
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const res = await runReplay({ dataset, arms, maxUsd, dryRun, deps });
  if (dryRun) { console.log(renderDryRun({ ...res, maxUsd })); return 0; }

  // Ground truth is read ONLY here, after every call.
  const truth = (deps.readScoring || ((p) => JSON.parse(fs.readFileSync(p, 'utf8'))))(scoringPathFor(datasetPath)).truth;
  const score = scoreReplay({ calls: res.calls, truth, arms, plan: res.plan });
  const results = { version: 1, dataset: datasetPath, arms, maxUsd, spentUsd: res.spentUsd, stopped: res.stopped, unrecoverable: res.unrecoverable, calls: res.calls, score };
  const out = flag('--out');
  if (out) writeJson(out, results);
  const summary = Object.entries(score.arms).map(([a, s]) => `${a}: ${s.verdict} (early ${s.earlyStops}, false ${s.falseStops}, invalid ${s.invalidOutputs})`).join(' | ');
  console.log(argv.includes('--json') ? JSON.stringify(results, null, 2) : `step-back-replay: spent $${res.spentUsd.toFixed(4)} of $${maxUsd}${res.stopped ? ` - STOPPED (${res.stopped.reason})` : ''} - ${summary}${out ? ` -> ${out}` : ''}`);
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
