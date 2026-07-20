#!/usr/bin/env node
/**
 * @fileoverview Comprehensive setup health check for any repo using the audit-loop skills.
 *
 * Validates env vars and Postgres tables for every active feature. Post-M4 all
 * features share one Postgres store via AUDIT_DB_URL (no supabase-js / separate
 * persona project):
 *   - audit-loop (AUDIT_DB_URL + tables)
 *   - persona-test (AUDIT_DB_URL + persona tables)
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
import {
  resolveCloudConfig, sharedEnvPath, discoverLocalEnvPath,
} from './lib/shared-cloud-config.mjs';

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

// ── Postgres helpers (M4 — migrated off supabase-js) ──────────────────────────

/**
 * Probe each table+view via information_schema. Returns
 * `{name, exists}[]`.  Pure Postgres reads through the new pg seam.
 */
async function checkTables(_unused, tableNames) {
  const { many } = await import('./lib/db/query.mjs');
  const present = await many(
    `SELECT table_name AS name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [tableNames]
  );
  const presentSet = new Set(present.map((r) => r.name));
  return tableNames.map((name) => ({ name, exists: presentSet.has(name) }));
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
  // Azure work profile (docs/runbooks/azure-work-profile.md): AZURE_OPENAI_ENDPOINT
  // active means the GPT auditor authenticates via AZURE_OPENAI_API_KEY —
  // OPENAI_API_KEY is not used at all, so failing on its absence here told
  // a correctly-configured corporate install its setup was broken
  // (2026-07-14 fresh-installer audit).
  const azureActive = !!(env.AZURE_OPENAI_ENDPOINT || '').trim();
  if (azureActive) {
    if (env.AZURE_OPENAI_API_KEY) {
      report.pass('Azure work profile', `GPT via ${env.AZURE_OPENAI_ENDPOINT}`);
    } else {
      report.fail('AZURE_OPENAI_API_KEY missing',
        'AZURE_OPENAI_ENDPOINT is set but the key is not — the Azure profile is half-configured',
        'Add AZURE_OPENAI_API_KEY=... to .env (or unset AZURE_OPENAI_ENDPOINT for the public profile)');
    }
    // Read-only, LOCAL check (audit M1) — no network. The embed deployment default
    // (`text-embedding-3-large`) is a guess that often isn't the deployment a
    // resource actually has (→ opaque 400 on every embedding call). Flag the
    // guess-path with the SAME absent/empty/whitespace predicate config uses
    // (audit M6), and point at the doctor, which probes + locks in the real one.
    if ((env.AZURE_OPENAI_EMBED_DEPLOYMENT || '').trim() === '') {
      report.warn('AZURE_OPENAI_EMBED_DEPLOYMENT not set',
        'Azure embeddings will use the default guess "text-embedding-3-large", which may not be deployed',
        'Run `npm run azure:doctor -- --fix` to probe your resource and lock in the real deployment name');
    }
  } else if (env.OPENAI_API_KEY) {
    report.pass('OPENAI_API_KEY', 'GPT-5.4 audit');
  } else {
    report.fail('OPENAI_API_KEY missing', 'required for all audits',
      'Add OPENAI_API_KEY=sk-... to .env');
  }

  if (env.GEMINI_API_KEY) {
    report.pass('GEMINI_API_KEY', 'Step 7 final review');
  } else if (azureActive && (env.AZURE_AI_ENDPOINT || '').trim()) {
    report.pass('Step 7 reviewer', 'Foundry Claude (Azure profile) — Gemini not needed');
  } else if (env.ANTHROPIC_API_KEY) {
    report.warn('GEMINI_API_KEY not set', 'ANTHROPIC_API_KEY present — Claude Opus used as Step 7 fallback');
  } else {
    report.warn('GEMINI_API_KEY not set',
      'optional — Step 7 skipped without it or ANTHROPIC_API_KEY',
      'Add GEMINI_API_KEY=... to .env (or ANTHROPIC_API_KEY for Claude Opus fallback)');
  }
}

async function checkAuditSupabase(env, report) {
  // M4 — AUDIT_DB_URL is the new runtime persistence env. The legacy
  // SUPABASE_AUDIT_URL + ANON_KEY pair is sunset for runtime; we still
  // surface them as informational (other tooling may read them during
  // the transition).
  // Plan: docs/plans/shared-cloud-config.md — evaluate EFFECTIVE merged
  // config so the warn correctly reflects whether ~/.audit-loop.env is
  // providing the value. process.env first (genuine externals), then local
  // .env via worktree-safe discovery, then ~/.audit-loop.env.
  const cloud = resolveCloudConfig({
    processEnv: env,                                     // env from loadEnv() — the target repo's local .env contents
    localEnvPath: discoverLocalEnvPath(REPO_PATH),
  });
  if (cloud.AUDIT_DB_URL.source === 'unset') {
    if (fs.existsSync(sharedEnvPath())) {
      report.warn('AUDIT_DB_URL not set anywhere',
        '~/.audit-loop.env exists but does not contain AUDIT_DB_URL — check the shared file');
    } else {
      report.warn('AUDIT_DB_URL not set',
        'run `npm run setup:cloud` from your claude-engineering-skills install to inherit it');
    }
    return;
  }
  if (cloud.AUDIT_DB_URL.source === 'shared') {
    report.pass('AUDIT_DB_URL  (inherited from ~/.audit-loop.env)');
  } else if (cloud.AUDIT_DB_URL.source === 'process-env') {
    report.pass('AUDIT_DB_URL  (set via shell export — not in any .env file)');
  } else {
    report.pass('AUDIT_DB_URL');
  }

  const REQUIRED = ['audit_repos', 'audit_runs', 'audit_findings', 'audit_pass_stats',
    'bandit_arms', 'false_positive_patterns', 'debt_entries'];
  const VIEWS = ['debt_summary'];

  let tableResults;
  try {
    tableResults = await checkTables(null, [...REQUIRED, ...VIEWS]);
  } catch (err) {
    report.fail('Postgres connection / table query failed', err.message.slice(0, 80));
    return;
  }

  const missingTables = [];
  for (const { name, exists } of tableResults) {
    const label = VIEWS.includes(name) ? `View: ${name}` : `Table: ${name}`;
    if (exists) {
      report.pass(label);
    } else if (VIEWS.includes(name)) {
      report.fail(`${label} missing`, '',
        `Apply the migrations via: AUDIT_DB_URL=… node scripts/setup-postgres.mjs --migrate`);
      report.info('SQL (if you need to add this view by hand):', DEBT_SUMMARY_SQL);
    } else {
      report.fail(`${label} missing`);
      missingTables.push(name);
    }
  }

  if (missingTables.length > 0) {
    report.info(`${missingTables.length} missing table(s) — run \`node scripts/setup-postgres.mjs --migrate\` to apply the migrations`);
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

  // M4: persona session memory lives in the SAME Postgres store as the audit
  // loop (AUDIT_DB_URL), reached through the shared `getPool()` — see
  // scripts/lib/store/persona.mjs ("no special client"). There is no separate
  // Supabase project or supabase-js client anymore; the legacy
  // PERSONA_TEST_SUPABASE_URL / _ANON_KEY vars are read by NO runtime code.
  // Probe the persona tables through the same pg seam the audit tables use.
  if (env.PERSONA_TEST_REPO_NAME) {
    report.pass('PERSONA_TEST_REPO_NAME', env.PERSONA_TEST_REPO_NAME);
  } else {
    report.warn('PERSONA_TEST_REPO_NAME not set', 'audit-loop cross-references will not work',
      `Add PERSONA_TEST_REPO_NAME=${REPO_NAME} to .env`);
  }

  // DSN is injected by injectResolvedDbEnv() in main(). Absent → cloud is off;
  // persona memory degrades to local-only just like the audit loop.
  if (!process.env.AUDIT_DB_URL) {
    report.warn('AUDIT_DB_URL not set — persona tables not checked',
      'persona session memory shares the audit-loop Postgres store; configure AUDIT_DB_URL (see Audit-Loop section)');
    return;
  }

  const TABLES = ['personas', 'persona_test_sessions'];
  const VIEWS  = ['persona_dashboard'];

  let tableResults;
  try {
    tableResults = await checkTables(null, [...TABLES, ...VIEWS]);
  } catch (err) {
    report.fail('Postgres connection / table query failed', err.message.slice(0, 80));
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
      'Create missing persona tables — apply the migrations to your Postgres store:',
      `node scripts/setup-postgres.mjs --migrate\n\n(or apply the SQL below directly)\n\n${PERSONA_TEST_SQL}`
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

// ── Consistency-mode (Phase 6.5 — Playwright bootstrap probe) ────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

/**
 * ESM dynamic-import probe — repo is ESM-only, NO require() (resolves R4-M4).
 * Returns `{ available: boolean, version: string|null, browserBinary: boolean, reason?: string }`.
 *
 * Same helper is used by persona-consistency-run.mjs at startup so all three
 * code paths (setup-check, runner, sync-to-repos) share one resolution.
 */
export async function checkPlaywrightAvailable() {
  try {
    await import('playwright');
  } catch (err) {
    return { available: false, version: null, browserBinary: false, reason: `node_modules: ${err.message}` };
  }
  let version = null;
  try {
    const { stdout } = await execFileAsync('npx', ['playwright', '--version'], { timeout: 10_000, shell: process.platform === 'win32' });
    version = stdout.trim();
  } catch (err) {
    return { available: true, version: null, browserBinary: false, reason: `npx playwright --version failed: ${err.message}` };
  }
  // Probe for the chromium binary for real.
  //
  // This used to `return { browserBinary: true }` unconditionally, deferring to
  // "the runner emits exit 5 at first run". The runners DO fail loudly (verified
  // 2026-07-20: nav-audit exits 2, visual-audit exits 2 via NO_CHROMIUM,
  // persona-consistency reports BROKEN) — but that made this health check, whose
  // whole job is telling you whether your setup works, structurally unable to
  // report the one dependency four skills cannot run without. Measured with the
  // browsers hidden, check-setup printed NOTHING about Playwright and exited 0:
  // a clean bill of health for an install where /persona-test, /click-test,
  // /nav-audit --verify and /visual-audit are all dead.
  //
  // `chromium.executablePath()` resolves the path Playwright WOULD launch (it
  // honours PLAYWRIGHT_BROWSERS_PATH) without spawning anything, so this is an
  // offline existence check rather than a launch — no network, no subprocess,
  // no timeout to tune.
  try {
    const { chromium } = await import('playwright');
    const exe = chromium.executablePath();
    if (!exe || !fs.existsSync(exe)) {
      return {
        available: true, version, browserBinary: false,
        reason: 'playwright is installed but its chromium binary is not downloaded',
      };
    }
  } catch (err) {
    // Resolution itself failed — report it rather than assuming either way.
    return {
      available: true, version, browserBinary: false,
      reason: `could not resolve the chromium binary: ${err.message}`,
    };
  }
  return { available: true, version, browserBinary: true };
}

async function checkConsistencyMode(env, report) {
  report.section('Consistency-Mode (Phase 6.5)');

  // Manifest is optional — only report if the repo has adopted consistency mode.
  const manifestPaths = [
    path.join(REPO_PATH, '.persona-test', 'surfaces.json'),
    path.join(REPO_PATH, 'persona-test-manifest.json'),
    path.join(REPO_PATH, 'src', 'persona-test-surfaces.json'),
  ];
  const manifest = manifestPaths.find((p) => fs.existsSync(p));

  if (!manifest) {
    report.warn(
      'No surfaces.json detected',
      'consistency mode is opt-in; this repo has not adopted it',
      'See docs/reference/consistency-contract.md to bootstrap',
    );
    return;
  }
  report.pass('surfaces.json', path.relative(REPO_PATH, manifest));

  // Canaries directory — if present, count them.
  const canariesDir = path.join(REPO_PATH, '.persona-test', 'canaries');
  if (fs.existsSync(canariesDir)) {
    const canaries = fs.readdirSync(canariesDir).filter((f) => f.endsWith('.json'));
    report.pass(`Canaries (${canaries.length})`, canaries.join(', ') || '(none)');
  } else {
    report.warn('No .persona-test/canaries/ directory',
      'consistency mode needs at least one canary',
      'mkdir -p .persona-test/canaries && add <canary>.json — see docs/reference/consistency-contract.md');
  }

}

/**
 * Browser prerequisite — its OWN section, deliberately not nested.
 *
 * This probe used to live at the end of checkConsistencyMode(), which returns
 * early when no surfaces.json is found. Consistency mode is opt-in and most
 * repos (including this one) have not adopted it, so the browser check was
 * unreachable for exactly the repos most likely to need telling. Measured
 * 2026-07-20 with the browsers hidden: check-setup printed NOTHING about
 * Playwright and exited 0.
 *
 * Playwright is a prerequisite for FOUR skills — /persona-test, /click-test,
 * /nav-audit --verify, /visual-audit — none of which require consistency mode.
 * Scoping its health check to a fifth, opt-in feature was the wrong home.
 *
 * WARN, not FAIL: a backend-only consumer that never runs a UX lens is
 * correctly configured without a browser, and failing them would be the same
 * false-alarm class as the Azure/OPENAI_API_KEY fix above. The exit code stays
 * 0; the operator gets told.
 */
async function checkBrowser(report) {
  report.section('Browser (UX lenses)');
  const pw = await checkPlaywrightAvailable();
  if (!pw.available) {
    report.warn(
      'Playwright unavailable',
      `${pw.reason} — /persona-test, /click-test, /nav-audit --verify and /visual-audit cannot run`,
      'npm install playwright && npx playwright install chromium',
    );
    return;
  }
  report.pass('Playwright', pw.version || '(version unknown — first install)');
  if (!pw.browserBinary) {
    report.warn(
      'Chromium binary not detected',
      `${pw.reason} — the four browser-driven lenses will exit non-zero at first run`,
      'npx playwright install chromium',
    );
    return;
  }
  report.pass('Chromium binary', 'present');
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Make the pg probes test what the report says PASS.
 *
 * `getPool()` / `db/client.mjs` read `AUDIT_DB_URL` + `AUDIT_DB_SSL_MODE`
 * straight from `process.env`. But `loadEnv()` deliberately keeps the target
 * repo's `.env` out of `process.env` (isolation), and this CLI never imports
 * `config.mjs` — whose import side-effect is what loads `~/.audit-loop.env`.
 * So `getPool()` would see an empty `process.env` and return null ("No DB
 * pool") even when `resolveCloudConfig` found a perfectly good DSN. Resolve the
 * EFFECTIVE config (target repo `.env` layered over `~/.audit-loop.env`) and
 * inject it. main() runs once for a single `--repo-path`, so there is no
 * cross-repo leak.
 *
 * `AUDIT_DB_SSL_MODE` is load-bearing, not optional: `client.mjs` defaults to
 * strict `require`, which fails TLS against Supabase session poolers (internal
 * CA). Personal/public profiles run on Supabase (`no-verify`); a work install
 * runs on its own Postgres. Injecting both makes the probe correct for either.
 * Never clobber a genuine shell export (`process.env[key] === undefined` guard).
 */
function injectResolvedDbEnv(env) {
  const cloud = resolveCloudConfig({
    processEnv: env,
    localEnvPath: discoverLocalEnvPath(REPO_PATH),
  });
  for (const key of ['AUDIT_DB_URL', 'AUDIT_DB_SSL_MODE']) {
    const v = cloud[key]?.value;
    if (v != null && v !== '' && process.env[key] === undefined) {
      process.env[key] = v;
    }
  }
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  const env = loadEnv(REPO_PATH);
  injectResolvedDbEnv(env);
  const report = new Report();

  await checkAuditLoop(env, report);
  await checkPersonaTest(env, report);
  await checkConsistencyMode(env, report);
  await checkBrowser(report);

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
