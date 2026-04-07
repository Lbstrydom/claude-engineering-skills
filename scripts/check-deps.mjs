#!/usr/bin/env node
/**
 * @fileoverview Pre-flight dependency check for audit-loop scripts.
 *
 * Validates that required npm packages are installed and API keys are set.
 * Run before `openai-audit.mjs` or `gemini-review.mjs` to surface setup
 * issues early with clear remediation steps.
 *
 * Usage:
 *   node scripts/check-deps.mjs           # Human-readable output
 *   node scripts/check-deps.mjs --json    # Machine-readable JSON
 *   node scripts/check-deps.mjs --fix     # Attempt to install missing packages
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';

/**
 * Required packages — the audit loop won't function without these.
 * Each entry: [package-name, what-needs-it, is-required]
 */
const REQUIRED_PACKAGES = [
  ['openai', 'GPT-5.4 auditor (openai-audit.mjs)', true],
  ['zod', 'Schema validation', true],
  ['dotenv', 'Environment variable loading', true],
  ['micromatch', 'Glob matching for --exclude-paths', true],
];

/**
 * Optional packages — audit runs without them but with reduced capability.
 */
const OPTIONAL_PACKAGES = [
  ['@google/genai', 'Gemini final review + brief generation', 'GEMINI_API_KEY'],
  ['@anthropic-ai/sdk', 'Claude Opus fallback for Gemini', 'ANTHROPIC_API_KEY'],
  ['@supabase/supabase-js', 'Cloud learning store', 'SUPABASE_AUDIT_URL'],
  ['proper-lockfile', 'Atomic writes for debt ledger', null],
];

/**
 * Environment variables — checked but not required (graceful degradation).
 */
const ENV_VARS = [
  ['OPENAI_API_KEY', 'GPT-5.4 auditor', true],
  ['GEMINI_API_KEY', 'Gemini final review (Step 7)', false],
  ['ANTHROPIC_API_KEY', 'Claude Opus fallback', false],
  ['SUPABASE_AUDIT_URL', 'Cloud learning store', false],
  ['SUPABASE_AUDIT_ANON_KEY', 'Cloud learning store', false],
];

function canResolve(pkg) {
  try {
    const require = createRequire(import.meta.url);
    require.resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

function loadEnv() {
  // Try to load .env from CWD
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const fixMode = args.includes('--fix');

  loadEnv();

  const results = { required: [], optional: [], env: [], allOk: true };

  // Check required packages
  for (const [pkg, purpose, required] of REQUIRED_PACKAGES) {
    const installed = canResolve(pkg);
    results.required.push({ package: pkg, installed, purpose, required });
    if (!installed) results.allOk = false;
  }

  // Check optional packages
  for (const [pkg, purpose, envGate] of OPTIONAL_PACKAGES) {
    const installed = canResolve(pkg);
    const envSet = envGate ? !!process.env[envGate] : true;
    results.optional.push({ package: pkg, installed, purpose, envGate, envSet });
  }

  // Check env vars
  for (const [key, purpose, required] of ENV_VARS) {
    const set = !!process.env[key];
    results.env.push({ key, set, purpose, required });
    if (required && !set) results.allOk = false;
  }

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(results.allOk ? 0 : 1);
  }

  // Human-readable output
  console.log(`\n${D}Audit-loop dependency check${X}\n`);

  // Required packages
  console.log('Required packages:');
  const missingRequired = [];
  for (const r of results.required) {
    const icon = r.installed ? `${G}✓${X}` : `${R}✗${X}`;
    console.log(`  ${icon} ${r.package} — ${r.purpose}`);
    if (!r.installed) missingRequired.push(r.package);
  }

  // Optional packages
  console.log('\nOptional packages:');
  const missingOptional = [];
  for (const r of results.optional) {
    const icon = r.installed ? `${G}✓${X}` : `${Y}○${X}`;
    const note = !r.installed && r.envGate && !r.envSet
      ? ` ${D}(${r.envGate} not set — not needed)${X}`
      : !r.installed ? ` ${Y}(missing — ${r.purpose} will degrade)${X}` : '';
    console.log(`  ${icon} ${r.package} — ${r.purpose}${note}`);
    if (!r.installed && (r.envSet || !r.envGate)) missingOptional.push(r.package);
  }

  // Environment variables
  console.log('\nEnvironment:');
  for (const r of results.env) {
    const icon = r.set ? `${G}✓${X}` : r.required ? `${R}✗${X}` : `${Y}○${X}`;
    const note = !r.set && !r.required ? ` ${D}(optional)${X}` : '';
    console.log(`  ${icon} ${r.key} — ${r.purpose}${note}`);
  }

  // Summary
  console.log('');
  if (missingRequired.length > 0) {
    console.log(`${R}Missing required packages:${X} ${missingRequired.join(', ')}`);
    console.log(`  Run: npm install ${missingRequired.join(' ')}`);
  }
  if (missingOptional.length > 0) {
    console.log(`${Y}Missing optional packages:${X} ${missingOptional.join(', ')}`);
    console.log(`  Run: npm install ${missingOptional.join(' ')}`);
  }

  if (fixMode && (missingRequired.length > 0 || missingOptional.length > 0)) {
    const toInstall = [...missingRequired, ...missingOptional];
    console.log(`\n${D}Installing: ${toInstall.join(' ')}${X}`);
    try {
      execFileSync('npm', ['install', ...toInstall], { stdio: 'inherit', timeout: 60000 });
      console.log(`${G}✓ Installed successfully${X}`);
    } catch (err) {
      console.error(`${R}Install failed${X}: ${err.message}`);
      console.log(`  Try manually: npm install ${toInstall.join(' ')}`);
    }
  }

  if (results.allOk) {
    console.log(`${G}All checks passed${X} — ready to run audit-loop`);
  }
  process.exit(results.allOk ? 0 : 1);
}

main();
