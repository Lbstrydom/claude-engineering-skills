#!/usr/bin/env node
/**
 * @fileoverview Comprehensive setup health check for any repo using the audit-loop skills.
 *
 * Validates env vars and Supabase tables for every active feature:
 *   - audit-loop (SUPABASE_AUDIT_URL + tables)
 *   - persona-test (PERSONA_TEST_SUPABASE_URL + tables)
 *
 * Usage:
 *   node scripts/check-setup.mjs                     # check current repo
 *   node scripts/check-setup.mjs --repo-path <dir>   # check another repo
 *   node scripts/check-setup.mjs --json              # machine-readable output
 *   node scripts/check-setup.mjs --fix               # show fix commands for each failure
 *
 * Exit codes:
 *   0 — all checks pass (warnings allowed)
 *   1 — one or more failures
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const JSON_MODE  = args.includes('--json');
const SHOW_FIXES = args.includes('--fix');
const repoPathArg = (() => {
  const i = args.indexOf('--repo-path');
  return i === -1 ? null : args[i + 1];
})();

const REPO_PATH = path.resolve(repoPathArg || '.');
const REPO_NAME = path.basename(REPO_PATH);

// ── Env loading ───────────────────────────────────────────────────────────────

/**
 * Load .env from the target repo path without polluting process.env,
 * so multiple repos can be checked in sequence.
 */
function loadEnv(repoPath) {
  const envFile = path.join(repoPath, '.env');
  if (!fs.existsSync(envFile)) return {};

  const env = {};
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replaceAll(/^["']|["']$/g, '');
    env[key] = val;
  }
  return env;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function getSupabaseClient(url, key) {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}

/**
 * Probe each table by attempting a zero-row select.
 * PostgREST doesn't expose information_schema, so we probe directly.
 * Error code 42P01 = relation does not exist.
 */
async function checkTables(sb, tableNames) {
  const results = await Promise.all(tableNames.map(async (name) => {
    const { error } = await sb.from(name).select('*').limit(0);
    const missing = error && (error.code === '42P01' || error.message?.includes('does not exist'));
    return { name, exists: !missing };
  }));
  return results;
}

// ── SQL fix templates ─────────────────────────────────────────────────────────

const PERSONA_TEST_SQL = `
CREATE TABLE IF NOT EXISTS personas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL, description TEXT NOT NULL, app_url TEXT NOT NULL,
  app_name TEXT, notes TEXT, repo_name TEXT,
  last_tested_at TIMESTAMPTZ, last_verdict TEXT, last_focus TEXT,
  test_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, app_url)
);
CREATE TABLE IF NOT EXISTS persona_test_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL UNIQUE, persona_id UUID REFERENCES personas(id),
  persona TEXT NOT NULL, url TEXT NOT NULL, focus TEXT, browser_tool TEXT,
  steps_taken INTEGER, verdict TEXT,
  p0_count INTEGER NOT NULL DEFAULT 0, p1_count INTEGER NOT NULL DEFAULT 0,
  p2_count INTEGER NOT NULL DEFAULT 0, p3_count INTEGER NOT NULL DEFAULT 0,
  avg_confidence NUMERIC(4,3), findings JSONB, report_md TEXT, debrief_md TEXT,
  repo_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE VIEW persona_dashboard AS
  SELECT p.* FROM personas p
  ORDER BY CASE WHEN p.last_tested_at IS NULL THEN 0 ELSE 1 END, p.last_tested_at ASC;
`.trim();

const DEBT_SUMMARY_SQL = `
CREATE OR REPLACE VIEW debt_summary AS
SELECT repo_id, severity, deferred_reason, COUNT(*) AS count,
  MIN(deferred_at) AS oldest, MAX(deferred_at) AS newest,
  array_agg(DISTINCT category) AS categories
FROM debt_entries
GROUP BY repo_id, severity, deferred_reason
ORDER BY CASE severity WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, count DESC;
`.trim();

// ── Report builder ────────────────────────────────────────────────────────────

class Report {
  constructor() {
    this.sections = [];
    this.failures = 0;
    this.warnings = 0;
  }

  section(title) {
    this.sections.push({ title, items: [] });
    return this;
  }

  _last() { return this.sections.at(-1); }

  pass(label, detail = '') {
    this._last().items.push({ status: 'PASS', label, detail, fix: null });
  }

  fail(label, detail = '', fix = '') {
    this._last().items.push({ status: 'FAIL', label, detail, fix });
    this.failures++;
  }

  warn(label, detail = '', fix = '') {
    this._last().items.push({ status: 'WARN', label, detail, fix });
    this.warnings++;
  }

  info(label, detail = '') {
    this._last().items.push({ status: 'INFO', label, detail, fix: null });
  }

  fix(label, detail = '') {
    this._last().items.push({ status: 'FIX', label, detail, fix: null });
  }
}

// ── Feature: Audit-Loop ───────────────────────────────────────────────────────

function checkAuditApiKeys(env, report) {
  if (env.OPENAI_API_KEY) {
    report.pass('OPENAI_API_KEY', 'GPT-5.4 audit');
  } else {
    report.fail('OPENAI_API_KEY missing', 'required for all audits',
      'Add OPENAI_API_KEY=sk-... to .env');
  }

  if (env.GEMINI_API_KEY) {
    report.pass('GEMINI_API_KEY', 'Step 7 final review');
  } else if (env.ANTHROPIC_API_KEY) {
    report.warn('GEMINI_API_KEY not set', 'ANTHROPIC_API_KEY present — Claude Opus used as Step 7 fallback');
  } else {
    report.warn('GEMINI_API_KEY not set',
      'optional — Step 7 skipped without it or ANTHROPIC_API_KEY',
      'Add GEMINI_API_KEY=... to .env (or ANTHROPIC_API_KEY for Claude Opus fallback)');
  }
}

function shortUrl(url) {
  return url.replaceAll(/^https?:\/\//g, '').slice(0, 30) + '...';
}

async function checkAuditSupabase(env, report) {
  if (!env.SUPABASE_AUDIT_URL) {
    report.warn('SUPABASE_AUDIT_URL not set', 'audit runs will be local-only (no cloud learning)');
    return;
  }
  report.pass('SUPABASE_AUDIT_URL', shortUrl(env.SUPABASE_AUDIT_URL));

  if (!env.SUPABASE_AUDIT_ANON_KEY) {
    report.fail('SUPABASE_AUDIT_ANON_KEY missing', '', 'Add SUPABASE_AUDIT_ANON_KEY=... to .env');
    return;
  }
  report.pass('SUPABASE_AUDIT_ANON_KEY');

  const REQUIRED = ['audit_repos', 'audit_runs', 'audit_findings', 'audit_pass_stats',
    'bandit_arms', 'false_positive_patterns', 'debt_entries'];
  const VIEWS = ['debt_summary'];

  let sb;
  try {
    sb = await getSupabaseClient(env.SUPABASE_AUDIT_URL, env.SUPABASE_AUDIT_ANON_KEY);
  } catch {
    report.fail('Supabase connection failed', 'check URL and anon key');
    return;
  }

  let tableResults;
  try {
    tableResults = await checkTables(sb, [...REQUIRED, ...VIEWS]);
  } catch (err) {
    report.fail('Table query failed', err.message.slice(0, 80));
    return;
  }

  const missingTables = [];
  for (const { name, exists } of tableResults) {
    const label = VIEWS.includes(name) ? `View: ${name}` : `Table: ${name}`;
    if (exists) {
      report.pass(label);
    } else if (VIEWS.includes(name)) {
      report.fail(`${label} missing`, '',
        `Save to /tmp/debt-summary.sql and run: npx supabase db query --linked -f /tmp/debt-summary.sql`);
      report.info('SQL:', DEBT_SUMMARY_SQL);
    } else {
      report.fail(`${label} missing`);
      missingTables.push(name);
    }
  }

  if (missingTables.length > 0) {
    report.info(`${missingTables.length} missing table(s) — run an audit to auto-create via learning-store.mjs`);
  }
}

async function checkAuditLoop(env, report) {
  report.section('Audit-Loop');
  checkAuditApiKeys(env, report);
  await checkAuditSupabase(env, report);
}

// ── Feature: Persona-Test ─────────────────────────────────────────────────────

async function checkPersonaTest(env, report) {
  report.section('Persona-Test');

  if (!env.PERSONA_TEST_SUPABASE_URL) {
    report.fail('PERSONA_TEST_SUPABASE_URL missing', 'required for persona session memory',
      `Add PERSONA_TEST_SUPABASE_URL=https://<ref>.supabase.co to .env`);
    return;
  }
  report.pass('PERSONA_TEST_SUPABASE_URL', shortUrl(env.PERSONA_TEST_SUPABASE_URL));

  if (!env.PERSONA_TEST_SUPABASE_ANON_KEY) {
    report.fail('PERSONA_TEST_SUPABASE_ANON_KEY missing', '',
      'Add PERSONA_TEST_SUPABASE_ANON_KEY=... to .env');
    return;
  }
  report.pass('PERSONA_TEST_SUPABASE_ANON_KEY');

  if (env.PERSONA_TEST_REPO_NAME) {
    report.pass('PERSONA_TEST_REPO_NAME', env.PERSONA_TEST_REPO_NAME);
  } else {
    report.warn('PERSONA_TEST_REPO_NAME not set', 'audit-loop cross-references will not work',
      `Add PERSONA_TEST_REPO_NAME=${REPO_NAME} to .env`);
  }

  const TABLES = ['personas', 'persona_test_sessions'];
  const VIEWS  = ['persona_dashboard'];

  let sb;
  try {
    sb = await getSupabaseClient(env.PERSONA_TEST_SUPABASE_URL, env.PERSONA_TEST_SUPABASE_ANON_KEY);
  } catch {
    report.fail('Supabase connection failed', 'check PERSONA_TEST_SUPABASE_URL and anon key');
    return;
  }

  let tableResults;
  try {
    tableResults = await checkTables(sb, [...TABLES, ...VIEWS]);
  } catch (err) {
    report.fail('Table query failed', err.message.slice(0, 80));
    return;
  }

  const missing = tableResults.filter(r => !r.exists).map(r => r.name);
  for (const { name, exists } of tableResults) {
    const label = VIEWS.includes(name) ? `View: ${name}` : `Table: ${name}`;
    if (exists) report.pass(label);
    else report.fail(`${label} missing`);
  }

  if (missing.length > 0) {
    report.fix(
      'Create missing tables — save SQL to /tmp/persona-test-schema.sql then run:',
      `npx supabase db query --linked -f /tmp/persona-test-schema.sql\n\n${PERSONA_TEST_SQL}`
    );
  }
}

// ── Output ────────────────────────────────────────────────────────────────────

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';
const C = '\x1b[36m';

function statusIcon(status) {
  switch (status) {
    case 'PASS': return `${G}PASS${X}`;
    case 'FAIL': return `${R}FAIL${X}`;
    case 'WARN': return `${Y}WARN${X}`;
    case 'INFO': return `${C}INFO${X}`;
    case 'FIX':  return `${C} FIX${X}`;
    default:     return status;
  }
}

function verdictLine(report) {
  if (report.failures > 0 && report.warnings > 0) {
    return `${R}${report.failures} failure(s)${X}, ${Y}${report.warnings} warning(s)${X}`;
  }
  if (report.failures > 0) {
    return `${R}${report.failures} failure(s)${X}`;
  }
  if (report.warnings > 0) {
    return `${Y}${report.warnings} warning(s) — non-blocking${X}`;
  }
  return `${G}All checks passed${X}`;
}

function printReport(report) {
  const hasEnv = fs.existsSync(path.join(REPO_PATH, '.env'));
  console.log('');
  console.log(`${B}═══════════════════════════════════════${X}`);
  console.log(`${B}  SETUP CHECK — ${REPO_NAME}${X}`);
  console.log(`${B}═══════════════════════════════════════${X}`);
  console.log(`  ${D}Path: ${REPO_PATH}${X}`);
  console.log(`  ${D}.env: ${hasEnv ? 'found' : 'NOT FOUND — all checks will fail'}${X}`);
  console.log('');

  for (const section of report.sections) {
    console.log(`  ${B}${section.title}${X}`);
    for (const item of section.items) {
      const icon = statusIcon(item.status);
      const detail = item.detail ? `  ${D}${item.detail}${X}` : '';
      console.log(`  [${icon}] ${item.label}${detail}`);
      if (SHOW_FIXES && item.fix) {
        console.log(`         ${C}Fix: ${item.fix}${X}`);
      }
    }
    console.log('');
  }

  console.log(`${B}═══════════════════════════════════════${X}`);
  console.log(`  Verdict: ${verdictLine(report)}`);
  if (report.failures > 0 && !SHOW_FIXES) {
    console.log(`  ${D}Re-run with --fix to see fix commands${X}`);
  }
  console.log(`${B}═══════════════════════════════════════${X}`);
  console.log('');
}

function printJsonReport(report) {
  const out = {
    repo: REPO_NAME,
    path: REPO_PATH,
    hasEnv: fs.existsSync(path.join(REPO_PATH, '.env')),
    failures: report.failures,
    warnings: report.warnings,
    sections: report.sections,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv(REPO_PATH);
  const report = new Report();

  await checkAuditLoop(env, report);
  await checkPersonaTest(env, report);

  if (JSON_MODE) printJsonReport(report);
  else printReport(report);

  process.exit(report.failures > 0 ? 1 : 0);
}

try {
  await main();
} catch (err) {
  console.error(`check-setup failed: ${err.message}`);
  process.exit(1);
}
