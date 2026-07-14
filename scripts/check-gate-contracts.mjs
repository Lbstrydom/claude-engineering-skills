#!/usr/bin/env node
/**
 * @fileoverview `skills:check` member — validates every skill's
 * `gate-contract.json` against the shared policy (schema.mjs), so contract rot is a pre-push
 * failure, not a test-time surprise. Deliberately validate-don't-generate
 * (plan §F2.7): this does NOT write anything into SKILL.md.
 *
 * Exit codes: 0 = all contracts valid (uncontracted skills listed, not a
 * failure); 1 = at least one contract has a divergence.
 *
 * @module scripts/check-gate-contracts
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGateContracts, formatSummaryLines } from './lib/gate-honesty/loader.mjs';

function main() {
  // process.exitCode (not process.exit()) throughout: lets buffered
  // stdout/stderr writes drain naturally before the process terminates —
  // process.exit() can truncate output when stdout/stderr is a pipe (CI
  // logs, `| tee`) rather than a TTY.
  if (process.argv.includes('--selfcheck-relocation')) {
    console.log('OK');
    return;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const skillsRoot = path.join(repoRoot, 'skills');
  const { contracted, uncontracted, divergences } = loadGateContracts({ skillsRoot, repoRoot });

  if (divergences.length > 0) {
    process.stderr.write('check-gate-contracts: FAILED\n');
    for (const d of divergences) process.stderr.write(`  ${d}\n`);
    process.exitCode = 1;
    return;
  }

  const lines = formatSummaryLines({ contracted, uncontracted });
  process.stdout.write(`${lines.join('\n')}\n`);
}

main();
