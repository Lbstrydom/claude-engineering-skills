/**
 * @fileoverview Argv-to-call glue for the Pilot 1 commands of `step-back-replay.mjs` (bodies: step-back-pilot-cli.mjs).
 * Exit: 0 ok, 2 argument error, 5 stopped by --max-usd, 1 failure. Output is one line plus files.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/step-back-pilot-dispatch
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgvError } from '../cli-io.mjs';
import {
  runFreeze, runContinue, runReconcile, runCalibrateDraw, runCalibrateScore, runNovelty, buildWorksheet, parseWorksheetLabels, scorePilot,
  loadDataset, readRunRows,
} from './step-back-pilot-cli.mjs';

export const PILOT_COMMANDS = Object.freeze(['freeze', 'continue', 'reconcile', 'calibrate-draw', 'calibrate-score', 'novelty', 'worksheet', 'score']);
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${JSON.stringify(o, null, 2)}\n`); };
const DEFAULT_AUDIT_SCRIPT = fileURLToPath(new URL('../../openai-audit.mjs', import.meta.url));

/** @returns {Promise<number>} exit code */
export async function runPilotCommand({ cmd, argv, flag }) {
  const need = (f) => { const v = flag(f); if (!v) throw new ArgvError(`step-back-replay ${cmd}: ${f} is required.`); return v; };
  const maxRaw = flag('--max-usd'); const maxUsd = maxRaw == null ? null : Number(maxRaw);
  if (maxRaw != null && !(Number.isFinite(maxUsd) && maxUsd > 0)) throw new ArgvError('step-back-replay: --max-usd must be a positive number.');
  if (cmd === 'freeze') {
    const d = runFreeze({ exports: need('--export').split(',').map((s) => s.trim()).filter(Boolean), reposFile: need('--repos-file'), seed: need('--seed'), out: need('--out') });
    console.log(`step-back-replay freeze --pilot meta-ab: ${d.counts.recoverable} recoverable points, ${d.counts.unrecoverable} unrecoverable; sets ${JSON.stringify(d.counts.bySet)}; hash ${d.datasetHash}`);
    return 0;
  }
  if (cmd === 'continue') {
    const set = need('--set');
    const reps = flag('--replicates') ? Number(flag('--replicates')) : (set === 'rehearsal' ? 1 : 2);
    const r = await runContinue({ datasetPath: need('--dataset'), set, replicates: reps, maxUsd, confirmSpend: argv.includes('--confirm-spend'), resultsPath: flag('--results'), dryRun: argv.includes('--dry-run'), only: flag('--point')?.split(','), auditScript: flag('--audit-script') || DEFAULT_AUDIT_SCRIPT });
    if (r.dryRun) {
      console.log(`step-back-replay continue DRY RUN - no provider call: ${r.planned} runs over ${r.points.length} points (dataset ${r.datasetHash.slice(0, 12)})`);
      for (const p of r.points) console.log(`  ${p.ok ? 'ok ' : 'BAD'} ${p.pointId} ${p.repo} ${p.mode} ${p.trigger}${p.ok ? '' : ` - ${p.reason}`}`);
      return r.points.every((p) => p.ok) ? 0 : 1;
    }
    console.log(`step-back-replay continue: ${r.rows.length} runs (${r.rows.filter((x) => x.valid).length} valid), spent $${r.spentUsd.toFixed(4)} of $${maxUsd} (metered)${r.stopped ? ` - STOPPED (${r.stopped.reason}: ${r.stopped.detail})` : ''}`);
    return r.exitCode;
  }
  if (cmd === 'reconcile') {
    await runReconcile({ ledger: need('--ledger'), callId: need('--call-id'), evidence: flag('--evidence'), costUsd: need('--cost-usd') });
    console.log('step-back-replay reconcile: recorded');
    return 0;
  }
  if (cmd === 'calibrate-draw') {
    const r = runCalibrateDraw({ datasetPath: need('--dataset'), seed: need('--seed'), outDir: need('--out-dir') });
    console.log(`step-back-replay calibrate-draw: ${r.pairs} pairs + ${r.recall} filter-recall findings from ${r.findings} findings / ${r.ledger} ledger entries; shortfalls ${JSON.stringify(r.shortfalls)} -> ${flag('--out-dir')}`);
    return 0;
  }
  if (cmd === 'calibrate-score') {
    if (!maxUsd || !argv.includes('--confirm-spend')) throw new ArgvError('step-back-replay calibrate-score: a paid run needs --max-usd and --confirm-spend.');
    const r = await runCalibrateScore({ dir: need('--out-dir'), labelsFile: need('--labels'), maxUsd });
    console.log(`step-back-replay calibrate-score: ${r.decision.toUpperCase()}; spent $${r.spentUsd.toFixed(4)} of $${maxUsd} (metered)`);
    return r.decision === 'accept' ? 0 : 1;
  }
  const datasetPath = need('--dataset'); const resultsPath = need('--results');
  if (cmd === 'novelty') {
    const r = await runNovelty({ datasetPath, resultsPath });
    console.log(`step-back-replay novelty: ${Object.keys(r.byFinding).length} findings judged by both judges${r.incomplete ? ' - INCOMPLETE (a pair was not judged)' : ''}`);
    return 0;
  }
  const { dataset } = loadDataset(datasetPath);
  const rows = readRunRows(resultsPath); const novelty = JSON.parse(fs.readFileSync(`${resultsPath}.novelty.json`, 'utf8'));
  if (cmd === 'worksheet') {
    const { markdown, key } = buildWorksheet({ rows, novelty, seed: need('--seed'), dataset });
    const dir = need('--out-dir'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pilot1-worksheet.md'), markdown); writeJson(path.join(dir, 'pilot1-worksheet.key.json'), key);
    console.log(`step-back-replay worksheet: ${Object.keys(key.items).length} findings to label -> ${dir} (the key file stays with the operator, never the labeller)`);
    return 0;
  }
  // score --pilot meta-ab
  const dir = need('--out-dir');
  const key = JSON.parse(fs.readFileSync(path.join(dir, 'pilot1-worksheet.key.json'), 'utf8'));
  const labelsById = parseWorksheetLabels(fs.readFileSync(need('--labels'), 'utf8'));
  const planned = new Set(rows.map((r) => `${r.pointId}#${r.rep}`)).size;
  const res = scorePilot({ rows, novelty, key, labelsById, plannedPairs: planned });
  writeJson(path.join(dir, 'pilot1-score.json'), res);
  console.log(`step-back-replay score --pilot meta-ab: ${String(res.decision.outcome).toUpperCase()} (${res.decision.why})`);
  return 0;
}
