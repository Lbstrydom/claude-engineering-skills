#!/usr/bin/env node
/**
 * @fileoverview First-run setup wizard for claude-engineering-skills.
 *
 * Run once after cloning this repo. Configures:
 *   1. API keys (.env in this repo)
 *   2. Learning database (none / SQLite / Supabase / Postgres)
 *   3. Global skill installation (~/.claude/skills/ — works in every repo)
 *   4. Auto-update git hook (skills update when you git pull)
 *   5. npm dependencies (in this repo)
 *
 * Usage:
 *   node setup.mjs              # Interactive wizard
 *   node setup.mjs --headless   # Non-interactive (use existing .env, defaults)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFileSync } from 'node:child_process';
import readline from 'readline';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

const B = '\x1b[1m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';
function ok(msg) { console.log(`  ${G}✓${X} ${msg}`); }
function warn(msg) { console.log(`  ${Y}⚠${X} ${msg}`); }
function fail(msg) { console.log(`  ${R}✗${X} ${msg}`); }

// ── Step 1: Prerequisites ───────────────────────────────────────────────────

function checkPrereqs() {
  const major = parseInt(process.version.slice(1));
  if (major < 18) { fail(`Node.js ${process.version} — need v18+`); return false; }
  ok(`Node.js ${process.version}`);
  try {
    const v = execSync('npm --version', { encoding: 'utf-8' }).trim();
    ok(`npm ${v}`);
  } catch { fail('npm not found'); return false; }
  return true;
}

// ── Step 2: API Keys ────────────────────────────────────────────────────────

const API_KEYS = [
  { name: 'OPENAI_API_KEY', required: true, desc: 'GPT-5.4 auditing' },
  { name: 'GEMINI_API_KEY', required: false, desc: 'Gemini final review + A/B pipeline' },
  { name: 'ANTHROPIC_API_KEY', required: false, desc: 'Claude Opus fallback review' },
];

async function setupApiKeys(headless) {
  const envPath = path.join(SELF_DIR, '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  let modified = false;

  for (const key of API_KEYS) {
    if (content.match(new RegExp(`^${key.name}=.+`, 'm'))) {
      ok(`${key.name} already configured`);
      continue;
    }
    if (headless) {
      if (key.required) warn(`${key.name} not set — you must add it to .env before running audits`);
      continue;
    }
    const label = key.required ? `${R}required${X}` : `${D}optional${X}`;
    const value = await ask(`  ${key.name} (${key.desc}, ${label}): `);
    if (value?.trim()) {
      content += `\n${key.name}=${value.trim()}`;
      modified = true;
      ok(`${key.name} saved`);
    } else if (key.required) {
      warn(`${key.name} skipped — add it to .env before running audits`);
      content += `\n# ${key.name}=  # ${key.desc}`;
      modified = true;
    }
  }
  if (modified) fs.writeFileSync(envPath, content.trim() + '\n');
}

// ── Step 3: Database Selection ──────────────────────────────────────────────

const DB_OPTIONS = [
  { key: '1', name: 'None', desc: 'Local JSON files only (default, zero setup)', env: {} },
  { key: '2', name: 'SQLite', desc: 'Local database at ~/.audit-loop/shared.db', env: { AUDIT_STORE: 'sqlite' } },
  { key: '3', name: 'Supabase', desc: 'Cloud — free tier available at supabase.com', env: { AUDIT_STORE: 'supabase' }, extraKeys: ['SUPABASE_AUDIT_URL', 'SUPABASE_AUDIT_ANON_KEY'] },
  { key: '4', name: 'Postgres', desc: 'Self-hosted PostgreSQL', env: { AUDIT_STORE: 'postgres' }, extraKeys: ['AUDIT_POSTGRES_URL'] },
];

async function setupDatabase(headless) {
  if (headless) { ok('Database: using existing .env config'); return; }

  console.log('');
  console.log(`  Learning database stores audit outcomes, bandit arms, and FP patterns.`);
  console.log(`  Data accumulates over time and makes future audits smarter.\n`);
  for (const opt of DB_OPTIONS) {
    console.log(`    ${B}${opt.key}${X}) ${opt.name} — ${opt.desc}`);
  }
  console.log('');

  const choice = await ask(`  Choose (1-4, default 1): `);
  const selected = DB_OPTIONS.find(o => o.key === choice?.trim()) || DB_OPTIONS[0];
  ok(`Database: ${selected.name}`);

  const envPath = path.join(SELF_DIR, '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';

  // Set AUDIT_STORE
  for (const [k, v] of Object.entries(selected.env)) {
    if (!content.includes(`${k}=`)) {
      content += `\n${k}=${v}`;
    }
  }

  // Prompt for extra keys (Supabase URL, Postgres URL, etc.)
  if (selected.extraKeys) {
    for (const key of selected.extraKeys) {
      if (content.match(new RegExp(`^${key}=.+`, 'm'))) {
        ok(`${key} already configured`);
        continue;
      }
      const value = await ask(`  ${key}: `);
      if (value?.trim()) {
        content += `\n${key}=${value.trim()}`;
        ok(`${key} saved`);
      } else {
        warn(`${key} skipped — add to .env before running audits`);
        content += `\n# ${key}=`;
      }
    }
  }

  fs.writeFileSync(envPath, content.trim() + '\n');
}

// ── Step 4: Install Skills Globally ─────────────────────────────────────────

function installSkills() {
  try {
    // Build manifest first
    execFileSync('node', ['scripts/build-manifest.mjs'], { cwd: SELF_DIR, stdio: 'pipe' });

    // Install to ~/.claude/skills/ (global — works in every repo)
    execFileSync('node', ['scripts/install-skills.mjs', '--local', '--surface', 'claude', '--force'], {
      cwd: SELF_DIR, stdio: 'pipe'
    });
    ok('Skills installed to ~/.claude/skills/ (available in every repo)');
  } catch (err) {
    warn(`Skill install failed: ${err.message?.slice(0, 100)}`);
    console.log(`  Run manually: node scripts/install-skills.mjs --local --surface claude --force`);
  }
}

// ── Step 5: npm Dependencies ────────────────────────────────────────────────

function installDeps() {
  try {
    execFileSync('npm', ['install'], { cwd: SELF_DIR, stdio: 'pipe', timeout: 120000 });
    ok('npm dependencies installed');
  } catch {
    warn('npm install failed — run manually: npm install');
  }
}

// ── Step 6: Git Hook for Auto-Update ────────────────────────────────────────

function installGitHook() {
  const hooksDir = path.join(SELF_DIR, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) { warn('No .git/hooks — skip git hook'); return; }

  const hookPath = path.join(hooksDir, 'post-merge');
  const hookContent = `#!/bin/sh
# Auto-update skills after git pull
# Installed by setup.mjs — remove this file to disable

echo "  [post-merge] Updating skills..."
node scripts/build-manifest.mjs 2>/dev/null
node scripts/install-skills.mjs --local --surface claude --force 2>/dev/null
echo "  [post-merge] Skills updated."
`;

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (existing.includes('install-skills.mjs')) {
      ok('Post-merge hook already installed');
      return;
    }
    // Append to existing hook
    fs.appendFileSync(hookPath, '\n' + hookContent.split('\n').slice(1).join('\n'));
    ok('Post-merge hook updated (appended skill update)');
  } else {
    fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
    ok('Post-merge hook installed — skills auto-update on git pull');
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const headless = process.argv.includes('--headless');

  console.log(`
${B}╔══════════════════════════════════════════════════════════╗
║  Engineering Skills — First-Time Setup                   ║
║  Multi-model audit: Claude + GPT-5.4 + Gemini 3.1 Pro   ║
╚══════════════════════════════════════════════════════════╝${X}
`);

  console.log(`${B}Step 1 — Prerequisites${X}`);
  if (!checkPrereqs()) { process.exit(1); }

  console.log(`\n${B}Step 2 — API Keys${X}`);
  await setupApiKeys(headless);

  console.log(`\n${B}Step 3 — Learning Database${X}`);
  await setupDatabase(headless);

  console.log(`\n${B}Step 4 — Dependencies${X}`);
  installDeps();

  console.log(`\n${B}Step 5 — Install Skills${X}`);
  installSkills();

  console.log(`\n${B}Step 6 — Auto-Update Hook${X}`);
  installGitHook();

  // Summary
  console.log(`
${B}╔══════════════════════════════════════════════════════════╗
║  Setup Complete                                          ║
╚══════════════════════════════════════════════════════════╝${X}

  ${G}Skills are now available in every repo you open in VS Code.${X}

  ${B}How it works:${X}
    - Skills live in ~/.claude/skills/ (global to your machine)
    - Open any repo in VS Code → type /audit-loop → it works
    - Run ${D}git pull${X} in this repo to get updates (auto-installs via hook)

  ${B}Usage:${X}
    ${D}In any repo:${X}
      /audit-loop code docs/plans/my-feature.md
      /audit-loop plan docs/plans/my-feature.md
      /plan-backend <description>
      /plan-frontend <description>
      /audit <plan-file>

    ${D}From this repo (CLI):${X}
      node scripts/audit-loop.mjs code <plan-file>
      node scripts/openai-audit.mjs code <plan-file>
      node scripts/bandit.mjs stats

  ${B}To update:${X}
    cd ${SELF_DIR}
    git pull   ${D}# hook auto-reinstalls skills${X}

  ${B}To add skills to a specific repo${X} (Copilot/Cursor/Agents):
    node scripts/install-skills.mjs --local --target /path/to/repo --force
`);

  rl.close();
}

main().catch(err => { console.error(`Setup failed: ${err.message}`); process.exit(1); });
