#!/usr/bin/env node
/**
 * @fileoverview Phase 7 readiness check — counts audit runs and notifies
 * when enough data has accumulated for predictive strategy implementation.
 */

import 'dotenv/config';
import { loadOutcomes } from './lib/findings.mjs';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';

const PHASE7_THRESHOLD = 50; // audit runs needed

async function checkReadiness() {
  const outcomes = loadOutcomes('.audit/outcomes.jsonl');

  // Count unique runs (group by timestamp proximity — within 5 min = same run)
  const runs = new Set();
  let lastTs = 0;
  let runCounter = 0;
  for (const o of outcomes) {
    if (o.timestamp - lastTs > 300000) { // 5 min gap = new run
      runCounter++;
      runs.add(runCounter);
    }
    lastTs = o.timestamp;
  }

  const runCount = runs.size;
  const progress = Math.min(100, Math.round(runCount / PHASE7_THRESHOLD * 100));

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  PHASE 7 READINESS CHECK`);
  console.log(`  Audit runs: ${runCount} / ${PHASE7_THRESHOLD}`);
  console.log(`  Progress: ${'█'.repeat(Math.floor(progress / 5))}${'░'.repeat(20 - Math.floor(progress / 5))} ${progress}%`);

  if (runCount >= PHASE7_THRESHOLD) {
    console.log(`  STATUS: ✓ READY — enough data for predictive strategy`);
    console.log(`  Action: Implement Phase 7 (ML-based pass selection)`);
  } else {
    const remaining = PHASE7_THRESHOLD - runCount;
    console.log(`  STATUS: ${remaining} more audit runs needed`);
    console.log(`  Estimated: ~${remaining} audits at current pace`);
  }
  console.log(`═══════════════════════════════════════\n`);

  // Also check cloud store if available — M4: AUDIT_DB_URL via pg seam.
  if (process.env.AUDIT_DB_URL) {
    try {
      const { many, one } = await import('./lib/db/query.mjs');
      const c = await one(`SELECT COUNT(*)::int AS c FROM audit_runs`);
      console.log(`  Cloud store: ${c?.c ?? 0} runs recorded in Postgres`);

      const repos = await many(`SELECT name, last_audited_at FROM audit_repos`);
      if (repos.length) {
        console.log(`  Repos: ${repos.map((r) => r.name).join(', ')}`);
      }
    } catch (err) {
      console.log(`  Cloud store: unavailable (${err.message})`);
    }
  }

  return { runCount, threshold: PHASE7_THRESHOLD, ready: runCount >= PHASE7_THRESHOLD };
}

async function main() {
  assertRepoRoot(import.meta.url);
  return checkReadiness();
}

main();
