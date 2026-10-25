#!/usr/bin/env node
/**
 * @fileoverview Operator CLI for `audit_repos.training_eligible`
 * (docs/plans/own-model-telemetry-slice-1.md gap 6). Default-deny: NULL = refused.
 *
 *   node scripts/training-eligibility.mjs list
 *   node scripts/training-eligibility.mjs set --repo Lbstrydom/claude-engineering-skills --eligible true --reason "public repo, licence checked"
 *
 * @module scripts/training-eligibility
 */
import './lib/load-env.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { assertKnownFlags, ArgvError, arg, finishAndExit } from './lib/cli-io.mjs';

async function main(argv) {
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); return 0; }
  const sub = argv[2];
  assertKnownFlags(argv.slice(3), ['repo', 'eligible', 'reason'], { cli: 'training-eligibility', from: 0 });
  const { initLearningStore } = await import('./lib/store/repo.mjs');
  const { closePool } = await import('./lib/db/client.mjs');
  const mod = await import('./lib/store/training-eligibility.mjs');
  try {
    if (!await initLearningStore()) { process.stderr.write('training-eligibility: no store configured\n'); return 1; }
    if (sub === 'list') {
      for (const r of await mod.listTrainingEligibility()) {
        console.log(`${String(r.training_eligible ?? 'UNDECIDED').padEnd(10)} ${r.name}${r.training_eligibility_reason ? `  — ${r.training_eligibility_reason}` : ''}`);
      }
      return 0;
    }
    if (sub === 'set') {
      const raw = arg(argv, '--eligible');
      if (raw !== 'true' && raw !== 'false') throw new ArgvError('--eligible must be true or false');
      const res = await mod.setTrainingEligibility({ repoName: arg(argv, '--repo'), eligible: raw === 'true', reason: arg(argv, '--reason') });
      console.log(JSON.stringify(res));
      return res.ok ? 0 : 1;
    }
    throw new ArgvError('usage: training-eligibility.mjs list | set --repo <name> --eligible true|false --reason "<why>"');
  } finally { await closePool(); }
}

if (isInvokedAsScript(import.meta.url)) {
  main(process.argv).then((code) => finishAndExit(code), (err) => {
    process.stderr.write(`training-eligibility: ${err.message}\n`);
    return finishAndExit(err?.code === 'ARGV_ERROR' ? 2 : 1);
  });
}
