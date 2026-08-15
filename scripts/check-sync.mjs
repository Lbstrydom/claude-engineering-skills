#!/usr/bin/env node
/**
 * @fileoverview Check whether this repo is syncing audit data to the Supabase cloud store.
 * Reports: env config, connection status, repo record, audit run history, and learning state.
 *
 * Usage:  node scripts/check-sync.mjs [--json]
 */

import './lib/load-env.mjs';
import path from 'node:path';
import { generateRepoProfile } from './lib/context.mjs';

const JSON_MODE = process.argv.includes('--json');

// ── Helpers ────────────────────────────────────────────────────────────────────

function log(msg) { if (!JSON_MODE) process.stdout.write(msg + '\n'); }

function pass(label) { log(`  [PASS] ${label}`); }
function fail(label) { log(`  [FAIL] ${label}`); }
function info(label) { log(`  [INFO] ${label}`); }

// ── Main ───────────────────────────────────────────────────────────────────────

async function checkSync() {
  const report = {
    timestamp: new Date().toISOString(),
    repoName: path.basename(path.resolve('.')),
    env: { url: false, key: false },
    connection: false,
    repo: null,
    runs: { total: 0, recent: [] },
    learning: { banditArms: 0, fpPatterns: 0 },
    verdict: 'NOT_SYNCING',
  };

  log('');
  log('═══════════════════════════════════════');
  log('  SUPABASE SYNC CHECK');
  log('═══════════════════════════════════════');
  log('');

  // 1. Check env vars — M4: AUDIT_DB_URL replaces the legacy SUPABASE_AUDIT_*
  // triplet for runtime persistence; the URL + anon key remain for any
  // remaining PostgREST callers (none after M4).
  log('  1. Environment Variables');
  report.env.url = !!process.env.AUDIT_DB_URL;

  if (report.env.url) pass('AUDIT_DB_URL is set');
  else fail('AUDIT_DB_URL is not set');

  if (!report.env.url) {
    log('');
    fail('Missing AUDIT_DB_URL — add it to your .env file (Supabase Dashboard → Connect → Session pooler)');
    log('');
    report.verdict = 'NOT_CONFIGURED';
    return finish(report);
  }

  // 2. Connection (M4 — pg seam, not supabase-js)
  log('');
  log('  2. Postgres Connection');
  const { many, one } = await import('./lib/db/query.mjs');
  try {
    await one(`SELECT 1 FROM audit_repos LIMIT 1`);
    report.connection = true;
    pass('Connected to Postgres');
  } catch (err) {
    fail(`Connection failed: ${err.message}`);
    report.verdict = 'CONNECTION_FAILED';
    return finish(report);
  }

  // 3. Repo record
  log('');
  log('  3. Repo Record');
  const profile = generateRepoProfile();
  const fingerprint = profile.repoFingerprint;
  info(`Fingerprint: ${fingerprint}`);

  const repoRow = await one(
    `SELECT id, name, fingerprint, last_audited_at, stack
       FROM audit_repos WHERE fingerprint = $1 LIMIT 1`,
    [fingerprint]
  );

  if (repoRow) {
    report.repo = repoRow;
    pass(`Found: "${repoRow.name}" (id: ${repoRow.id})`);
    info(`Last audited: ${repoRow.last_audited_at || 'never'}`);
    info(`Stack: ${JSON.stringify(repoRow.stack)}`);
  } else {
    fail('Repo not found in Postgres — run an audit to register it');
    report.verdict = 'NOT_REGISTERED';
    return finish(report);
  }

  // 4. Audit runs
  log('');
  log('  4. Audit Runs');
  const runCountRow = await one(
    `SELECT COUNT(*)::int AS c FROM audit_runs WHERE repo_id = $1`,
    [repoRow.id]
  );
  report.runs.total = runCountRow?.c ?? 0;
  info(`Total runs: ${report.runs.total}`);

  const recentRuns = await many(
    `SELECT id, plan_file, mode, created_at, gemini_verdict, rounds, total_findings
       FROM audit_runs
      WHERE repo_id = $1
      ORDER BY created_at DESC
      LIMIT 5`,
    [repoRow.id]
  );

  if (recentRuns.length) {
    report.runs.recent = recentRuns;
    log('');
    log('  Recent runs:');
    for (const r of recentRuns) {
      const date = r.created_at ? new Date(r.created_at).toLocaleDateString() : '?';
      const plan = r.plan_file ? path.basename(r.plan_file) : '?';
      log(`    ${date}  ${r.mode || '?'}  ${plan}  R:${r.rounds ?? '?'}  F:${r.total_findings ?? '?'}  ${r.gemini_verdict || ''}`);
    }
  } else {
    info('No audit runs recorded yet');
  }

  // 5. Learning state
  log('');
  log('  5. Learning State');

  // `bandit_arms` is GLOBAL, not repo-scoped — its identity is
  // (pass_name, variant_id, context_bucket) and it has no `repo_id` column at
  // all (see lib/store/bandit-fp.mjs, whose loader reads `SELECT * FROM
  // bandit_arms` with no predicate). This counted `WHERE repo_id = $1`, a
  // guaranteed 42703 that the top-level catch turned into a bare
  // `[ERROR] column "repo_id" does not exist` + exit 3 — aborting the check
  // before the FP-pattern count and the VERDICT, for every registered repo.
  // Guarded by tests/check-sync-schema-columns.test.mjs.
  const armCountRow = await one(`SELECT COUNT(*)::int AS c FROM bandit_arms`);
  report.learning.banditArms = armCountRow?.c ?? 0;

  const fpCountRow = await one(
    `SELECT COUNT(*)::int AS c FROM false_positive_patterns WHERE repo_id = $1`,
    [repoRow.id]
  );
  report.learning.fpPatterns = fpCountRow?.c ?? 0;

  info(`Bandit arms: ${report.learning.banditArms} (global — not repo-scoped)`);
  info(`FP patterns: ${report.learning.fpPatterns}`);

  // 6. Verdict
  report.verdict = report.runs.total > 0 ? 'SYNCING' : 'CONNECTED_NO_RUNS';

  return finish(report);
}

function finish(report) {
  if (!JSON_MODE) {
    log('');
    log('═══════════════════════════════════════');
    const icon = report.verdict === 'SYNCING' ? 'SYNCING' : report.verdict;
    log(`  Verdict: ${icon}`);
    if (report.verdict === 'NOT_CONFIGURED') {
      log('  Fix: Add AUDIT_DB_URL to .env (Supabase Dashboard → Connect → Session pooler)');
    } else if (report.verdict === 'CONNECTION_FAILED') {
      log('  Fix: Check your Supabase URL and anon key');
    } else if (report.verdict === 'NOT_REGISTERED') {
      log('  Fix: Run an audit to register this repo');
    } else if (report.verdict === 'CONNECTED_NO_RUNS') {
      log('  Connected but no audit runs yet — run an audit');
    }
    log('═══════════════════════════════════════');
    log('');
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }

  const exitCode = report.verdict === 'SYNCING' ? 0 : 1;
  process.exit(exitCode);
}

checkSync().catch(err => {
  // stderr UNCONDITIONALLY, never through `log()` — that helper is a no-op under
  // --json, so routing the crash diagnostic through it left a --json caller with
  // empty stdout, a bare exit 3, and nothing naming what failed. stderr also
  // keeps stdout clean for the JSON envelope, per the project's --out convention.
  process.stderr.write(`\n  [ERROR] ${err.message}\n\n`);
  process.exit(3);
});
