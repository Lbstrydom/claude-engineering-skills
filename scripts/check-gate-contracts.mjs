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
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const skillsRoot = path.join(repoRoot, 'skills');
  const { contracted, uncontracted, divergences } = loadGateContracts({ skillsRoot, repoRoot });

  if (divergences.length > 0) {
    process.stderr.write('check-gate-contracts: FAILED\n');
    for (const d of divergences) process.stderr.write(`  ${d}\n`);
    process.exit(1);
  }

  const lines = formatSummaryLines({ contracted, uncontracted });
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

main();
