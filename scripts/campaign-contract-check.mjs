#!/usr/bin/env node
/**
 * @fileoverview Presence check for a `/plan --campaign` plan's Campaign Contract.
 *
 *   node scripts/campaign-contract-check.mjs <plan.md> [--json]
 *   node scripts/campaign-contract-check.mjs <plan.md> --closeout [--rev <ref>] [--json]
 *
 * Exit 0 complete · 1 problems found · 2 unreadable input / bad usage.
 * `--closeout` also requires every `evidence` / `done-evidence` path to be a committed,
 * non-empty regular file at `--rev` (default `origin/main`) and prints each one's
 * SHA-256 for the close-out record.
 *
 * The check proves the plan DECLARES each control; it cannot prove one ran — see
 * scripts/lib/campaign-contract.mjs. Plan: docs/plans/test-campaign-controls.md §2.4.
 */
import fs from 'node:fs';
import { assertKnownFlags, ArgvError, argOption, hasFlag, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { checkCampaignContract, verifyEvidenceAtRevision } from './lib/campaign-contract.mjs';

const KNOWN = ['--json', '--closeout', '--rev', '--help'];

export async function main(argv = process.argv) {
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(argv, KNOWN, { cli: 'campaign-contract-check' });
  const positional = argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--rev');
  if (hasFlag('help') || positional.length !== 1) {
    process.stderr.write('usage: campaign-contract-check <plan.md> [--closeout [--rev <ref>]] [--json]\n');
    return 2;
  }
  const planPath = positional[0];
  let md;
  try { md = fs.readFileSync(planPath, 'utf-8'); } catch (err) {
    process.stderr.write(`campaign-contract-check: cannot read ${planPath} (${err.code || err.message})\n`);
    return 2;
  }
  const presence = checkCampaignContract(md);
  const closeout = hasFlag('closeout') ? verifyEvidenceAtRevision(md, { rev: argOption('rev') || 'origin/main' }) : null;
  const problems = [...presence.problems, ...(closeout?.problems ?? [])];
  if (hasFlag('json')) {
    process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, plan: planPath, problems, ...(closeout ? { closeout: { oid: closeout.oid, artifacts: closeout.artifacts } } : {}) }, null, 2)}\n`);
  } else {
    for (const p of problems) process.stdout.write(`  ${p.id}${p.field ? ` ${p.field}` : ''}: ${p.why}\n`);
    for (const a of closeout?.artifacts ?? []) process.stdout.write(`  evidence ${a.id} ${a.path} @ ${closeout.oid.slice(0, 12)} sha256 ${a.sha256}\n`);
    process.stdout.write(problems.length === 0
      ? `campaign-contract-check: complete${closeout ? ` (close-out verified at ${closeout.oid.slice(0, 12)})` : ''} — presence only; reviewers judge adequacy\n`
      : `campaign-contract-check: ${problems.length} problem(s)\n`);
  }
  return problems.length === 0 ? 0 : 1;
}

if (isInvokedAsScript(import.meta.url)) {
  let code;
  try { code = await main(); } catch (err) {
    process.stderr.write(`${err.message}\n`);
    code = err instanceof ArgvError || err?.code === 'ARGV_ERROR' ? 2 : 1;
  }
  await finishAndExit(code);
}
