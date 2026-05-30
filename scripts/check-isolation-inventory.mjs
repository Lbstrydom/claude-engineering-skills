#!/usr/bin/env node
/**
 * @fileoverview Source-side smoke check for the sync-isolation path mapper.
 *
 * Walks the inventory for every consumer, computes destinations, asserts
 * the round-trip invariant `destRelToSourceRel(sourceRelToDestRel(p)) === p`,
 * and reports per-consumer counts.
 *
 * Source-side ONLY. Does NOT ship to consumers (consumer-repos.mjs +
 * sync-inventory.mjs are source-only). See plan §10 Phase 1 step 5.
 *
 * Usage:
 *   node scripts/check-isolation-inventory.mjs
 *
 * Exit code:
 *   0  Round-trip clean for every path in every consumer inventory
 *   2  Any round-trip failure
 */
import { getAllConsumerInventories } from './lib/sync-inventory.mjs';
import { sourceRelToDestRel, destRelToSourceRel } from './lib/sync-path-map.mjs';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';

if (process.argv.includes('--selfcheck-relocation')) {
  // Defensive: this script is source-only and won't relocate, but the
  // contract is cheap to honour.
  console.log('OK');
  process.exit(0);
}

assertRepoRoot(import.meta.url);

const invs = getAllConsumerInventories();
const failures = [];
let total = 0;
for (const [alias, inv] of invs) {
  total += inv.files.length;
  for (const p of inv.files) {
    const dest = sourceRelToDestRel(p);
    const back = destRelToSourceRel(dest);
    if (back !== p) failures.push({ alias, source: p, dest, back });
  }
}

if (failures.length) {
  process.stderr.write(`Round-trip failures: ${failures.length}\n`);
  process.stderr.write(JSON.stringify(failures.slice(0, 10), null, 2) + '\n');
  process.exit(2);
}

process.stdout.write(`OK — ${invs.size} consumers, ${total} source paths, round-trip clean\n`);
process.exit(0);
