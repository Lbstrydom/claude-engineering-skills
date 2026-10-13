#!/usr/bin/env node
/**
 * @fileoverview Move a tech-debt ledger from the legacy single file
 * (`.audit/tech-debt.json`) to one file per entry (`.audit/tech-debt/`), or
 * reconcile a stale branch's legacy file after that move.
 *
 * Writers migrate an UNTRACKED ledger by themselves. A ledger committed to git
 * is never moved by a writer — a writer runs inside a feature branch, and
 * deleting a committed file in N parallel branches is the conflict storm this
 * format exists to end — so it moves here, once, in one commit on the default
 * branch. docs/plans/debt-ledger-per-entry-files.md §2.5; upstream d338aa8a.
 *
 * Never touches the git index: it prints the one staging command instead.
 *
 * Exit codes: 0 migrated / reconciled / nothing to do · 1 refused (unresolved
 * conflicts, an ignored destination, no baseline, missing --stale-ref) ·
 * 2 operational error (bad arguments, corrupt ledger, lock timeout).
 */

import './lib/load-env.mjs';

import { migrateLegacyLedger } from './lib/debt-ledger-migration.mjs';
import { DEFAULT_DEBT_LEDGER_PATH } from './lib/debt-ledger.mjs';
import { assertKnownFlags, ArgvError, finishAndExit, hasFlag } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';

const KNOWN_FLAGS = ['--ledger', '--dry-run', '--prefer', '--stale-ref', '--json', '--help'];

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = args.indexOf(flag);
    if (i === -1) return null;
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new ArgvError(`debt-ledger-migrate: ${flag} needs a value`);
    return v;
  };
  const prefer = get('--prefer');
  if (prefer !== null && prefer !== 'dir' && prefer !== 'legacy') {
    throw new ArgvError(`debt-ledger-migrate: --prefer must be "dir" or "legacy" (got "${prefer}")`);
  }
  return {
    ledgerPath: get('--ledger') || DEFAULT_DEBT_LEDGER_PATH,
    prefer,
    staleRef: get('--stale-ref'),
    dryRun: hasFlag('dry-run'),
    json: hasFlag('json'),
    help: hasFlag('help', { short: 'h' }),
  };
}

function printUsage() {
  process.stderr.write(`Usage: node debt-ledger-migrate.mjs [options]

Move the tech-debt ledger to one file per entry, so two branches that record
debt never conflict. Run ONCE, on your default branch, and commit the result.

Options:
  --ledger <path>        Ledger location (default: ${DEFAULT_DEBT_LEDGER_PATH}; either spelling)
  --dry-run              Report what would happen; write nothing
  --prefer dir|legacy    Resolve records that differ between the two forms
  --stale-ref <rev>      After merging a branch cut BEFORE the migration that
                         still carried the legacy file: that branch's pre-merge
                         tip: HEAD^2 if it was merged into main, HEAD^1 if main
                         was merged into it (see the consumer-adoption runbook)
  --json                 Machine-readable report on stdout
  --help                 Show this message

Exit codes: 0 done or nothing to do, 1 refused (see the report), 2 error.
`);
}

function render(report) {
  const lines = [];
  const verb = { migrated: 'Migrated', reconciled: 'Reconciled', 'nothing-to-do': 'Nothing to do', refused: 'REFUSED' }[report.action] || report.action;
  lines.push(`${verb}${report.mode ? ` (${report.mode})` : ''}${report.dryRun ? ' — dry run, nothing written' : ''}`);
  if (report.reason) lines.push(`  reason: ${report.reason}`);
  if (report.action === 'migrated' || report.action === 'reconciled') {
    lines.push(`  entries written: ${report.written.length} · already present: ${report.unchanged} · deleted: ${report.deleted.length}`);
    lines.push(`  legacy file: ${report.legacy}`);
  }
  for (const c of report.conflicts) lines.push(`  conflict: ${c.topicId} — ${c.reason}`);
  for (const p of report.ignored) lines.push(`  would be IGNORED by git: ${p}`);
  if (report.ignored.length) {
    lines.push('  Remedy: re-include the ledger directory. In a consumer of the synced bundle, add to');
    lines.push('  .sync-overrides.json:  "gitignoreExtra": [{ "pattern": "!.audit/tech-debt/", "reason": "debt ledger is committed" }]');
    lines.push('  and re-run the sync, then this command.');
  }
  if (report.stageCommand && report.ok && !report.dryRun && report.action !== 'nothing-to-do') {
    lines.push(`  Stage it (one commit):  ${report.stageCommand}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  // CLI smoke contract (AGENTS.md): proves this module's imports survive
  // relocation to a consumer's scripts/.claude-skills/.
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  let opts;
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'debt-ledger-migrate' });
    opts = parseArgs(process.argv);
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await finishAndExit(2); return; }
    throw err;
  }
  if (opts.help) { printUsage(); await finishAndExit(0); return; }

  let report;
  try {
    report = await migrateLegacyLedger(opts.ledgerPath, {
      prefer: opts.prefer, staleRef: opts.staleRef, dryRun: opts.dryRun,
    });
  } catch (err) {
    process.stderr.write(`debt-ledger-migrate: ${err.message}\n`);
    await finishAndExit(2);
    return;
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stdout.write(render(report));
  await finishAndExit(report.ok ? 0 : 1);
}

if (isInvokedAsScript(import.meta.url)) main();
