#!/usr/bin/env node
/**
 * @fileoverview CLI metrics dashboard for the audit-loop system.
 *
 * Queries Supabase for pass effectiveness, model performance, and learning velocity.
 * Falls back to local outcomes.jsonl when cloud is unavailable.
 *
 * Usage:
 *   node scripts/audit-metrics.mjs                # show key metrics (last 30 days)
 *   node scripts/audit-metrics.mjs --json         # machine-readable
 *   node scripts/audit-metrics.mjs --days 7       # custom window
 *
 * @module scripts/audit-metrics
 */

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { loadOutcomes } from './lib/findings-outcomes.mjs';
import { many } from './lib/db/query.mjs';
import { getPool } from './lib/db/client.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

// ── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const DAYS = Number.parseInt(args[args.indexOf('--days') + 1] || '30', 10) || 30;

// ── Data Fetching ───────────────────────────────────────────────────────────

/**
 * Fetch audit metrics from the cloud store. Exported so the dashboard
 * telemetry collector can reuse it.
 *
 * M4 — migrated off `@supabase/supabase-js` to the new pg seam. The
 * legacy `sb` parameter is kept for backwards compat with importing
 * callers but is now ignored — connectivity is gated on `AUDIT_DB_URL`
 * via `getPool()` returning non-null. Errors propagate as exceptions
 * (matching the post-Gemini-G1 contract: no silent empty-result on
 * transport failure).
 *
 * @param {*} _sb - legacy positional arg, ignored under the pg path
 * @param {number} days lookback window
 * @returns {Promise<{runs,passStats,findings,labeled}|null>} null when no DB pool
 */
export async function fetchCloudMetrics(_sb, days) {
  const pool = await getPool();
  if (!pool) return null;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [runs, passStats, findings] = await Promise.all([
    many(`SELECT * FROM audit_runs WHERE created_at >= $1`, [since]),
    many(`SELECT * FROM audit_pass_stats WHERE created_at >= $1`, [since]),
    many(
      `SELECT severity, adjudication_outcome, pass_name
         FROM audit_findings WHERE created_at >= $1`,
      [since]
    ),
  ]);

  const labeled = runs.filter((r) => r.labeled);

  return { runs, passStats, findings, labeled };
}

/**
 * Compute audit metrics from the local `.audit/outcomes.jsonl`. Exported
 * for reuse by the dashboard telemetry collector.
 * @param {number} days lookback window
 */
export function computeLocalMetrics(days) {
  const outcomes = loadOutcomes('.audit/outcomes.jsonl');
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = outcomes.filter(o => (o.timestamp || 0) > cutoff);
  const withOutcome = recent.filter(o => o.accepted !== null && o.accepted !== undefined);

  const byPass = {};
  for (const o of withOutcome) {
    const pass = o.pass || 'unknown';
    if (!byPass[pass]) byPass[pass] = { accepted: 0, dismissed: 0, total: 0 };
    byPass[pass].total++;
    if (o.accepted) byPass[pass].accepted++;
    else byPass[pass].dismissed++;
  }

  return { total: recent.length, labeled: withOutcome.length, byPass };
}

// ── Display ─────────────────────────────────────────────────────────────────

function displayMetrics(cloud, local) {
  const line = '═'.repeat(50);

  console.log(`\n${B}${line}`);
  console.log(`  AUDIT LOOP METRICS — Last ${DAYS} days`);
  console.log(`${line}${X}\n`);

  // Run summary
  if (cloud) {
    const { runs, labeled, passStats } = cloud;
    const avgRounds = runs.length > 0
      ? (runs.reduce((s, r) => s + (r.rounds || 0), 0) / runs.length).toFixed(1)
      : 'n/a';
    const avgDuration = runs.filter(r => r.total_duration_ms > 0).length > 0
      ? (runs.filter(r => r.total_duration_ms > 0).reduce((s, r) => s + r.total_duration_ms, 0) / runs.filter(r => r.total_duration_ms > 0).length / 60000).toFixed(1)
      : 'n/a';

    console.log(`  Runs: ${B}${runs.length}${X} | Labeled: ${labeled.length}/${runs.length} | Avg rounds: ${avgRounds} | Avg time: ${avgDuration} min`);
    console.log(`  Data: ${labeled.length > 0 ? G : Y}${labeled.length} labeled runs${X} ${labeled.length < 20 ? `${Y}(need 20+ for predictions)${X}` : ''}\n`);

    // Pass effectiveness from cloud
    const byPass = {};
    for (const ps of passStats) {
      if (!byPass[ps.pass_name]) byPass[ps.pass_name] = { runs: 0, raised: 0, accepted: 0, dismissed: 0, latency: 0, tokens: 0 };
      const p = byPass[ps.pass_name];
      p.runs++;
      p.raised += ps.findings_raised || 0;
      p.accepted += ps.findings_accepted || 0;
      p.dismissed += ps.findings_dismissed || 0;
      p.latency += ps.latency_ms || 0;
      p.tokens += (ps.input_tokens || 0) + (ps.output_tokens || 0);
    }

    if (Object.keys(byPass).length > 0) {
      console.log(`  ${B}PASS EFFECTIVENESS${X}`);
      console.log(`  ${'Pass'.padEnd(16)}${'Runs'.padStart(6)}${'Raised'.padStart(8)}${'Accept'.padStart(8)}${'Dismiss'.padStart(8)}${'Rate'.padStart(8)}${'AvgTime'.padStart(10)}`);
      for (const [pass, p] of Object.entries(byPass).sort((a, b) => b[1].runs - a[1].runs)) {
        const rate = p.accepted + p.dismissed > 0
          ? Math.round(p.accepted / (p.accepted + p.dismissed) * 100) + '%'
          : (p.raised > 0 ? `${D}unlabeled${X}` : 'n/a');
        const avgTime = (p.latency / p.runs / 1000).toFixed(0) + 's';
        console.log(`  ${pass.padEnd(16)}${String(p.runs).padStart(6)}${String(p.raised).padStart(8)}${String(p.accepted).padStart(8)}${String(p.dismissed).padStart(8)}${rate.padStart(8)}${avgTime.padStart(10)}`);
      }
      console.log('');
    }
  }

  // Local outcomes
  if (local && local.labeled > 0) {
    console.log(`  ${B}LOCAL OUTCOMES${X} (from .audit/outcomes.jsonl)`);
    console.log(`  Total: ${local.total} | With triage result: ${local.labeled}`);
    for (const [pass, counts] of Object.entries(local.byPass).sort((a, b) => b[1].total - a[1].total)) {
      const rate = counts.total > 0 ? Math.round(counts.accepted / counts.total * 100) + '%' : 'n/a';
      console.log(`    ${pass.padEnd(20)} accept: ${rate.padEnd(5)} (${counts.accepted}/${counts.total})`);
    }
    console.log('');
  } else if (!cloud) {
    console.log(`  ${Y}No cloud store configured and no local outcomes with triage data.${X}`);
    console.log(`  ${D}Run an audit with outcome-sync wired to start collecting labeled data.${X}\n`);
  }

  // Status summary
  const totalLabeled = cloud?.labeled?.length ?? local?.labeled ?? 0;
  if (totalLabeled >= 20) {
    console.log(`  ${G}Predictions: ACTIVE${X} — ${totalLabeled} labeled runs (threshold: 20)`);
  } else {
    console.log(`  ${Y}Predictions: INACTIVE${X} — ${totalLabeled}/20 labeled runs needed`);
  }
  console.log('');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // `fetchCloudMetrics` now THROWS on a DB error (so the dashboard
  // collector can classify it) — but this CLI must still degrade
  // gracefully to local-only output rather than crash.
  let cloud = null;
  try {
    cloud = await fetchCloudMetrics(null, DAYS);
  } catch (err) {
    process.stderr.write(`  ${Y}cloud metrics unavailable — showing local only: ${err.message}${X}\n`);
  }
  const local = computeLocalMetrics(DAYS);

  if (JSON_MODE) {
    console.log(JSON.stringify({ cloud, local, days: DAYS }, null, 2));
  } else {
    displayMetrics(cloud, local);
  }
}

// Only run the CLI when invoked directly — `fetchCloudMetrics` /
// `computeLocalMetrics` are also imported by the dashboard telemetry
// collector, and importing must not trigger the CLI.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
