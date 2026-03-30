#!/usr/bin/env node
/**
 * @fileoverview Interactive setup script for claude-audit-loop.
 *
 * Installs the full adaptive audit intelligence system into any project.
 * Supports: Claude Code, VS Code Copilot, Cursor, Windsurf, JetBrains, and raw terminal.
 *
 * Usage:
 *   node setup.mjs                     # Install into current project
 *   node setup.mjs --target <dir>      # Install into specific project
 *   node setup.mjs --scripts-only      # Only copy scripts (skip skills, env)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}⚠${RESET} ${msg}`); }
function fail(msg) { console.log(`${RED}✗${RESET} ${msg}`); }
function heading(msg) { console.log(`\n${BOLD}${msg}${RESET}\n`); }

const SCRIPTS = [
  'scripts/openai-audit.mjs',
  'scripts/shared.mjs',
  'scripts/gemini-review.mjs',
  'scripts/bandit.mjs',
  'scripts/refine-prompts.mjs',
  'scripts/learning-store.mjs',
  'scripts/phase7-check.mjs'
];

const DEPS = [
  'openai',
  'zod',
  'dotenv',
  '@google/genai',
  '@anthropic-ai/sdk',
  '@supabase/supabase-js'
];

const API_KEYS = [
  { name: 'OPENAI_API_KEY', prefix: 'sk-', required: true, desc: 'GPT-5.4 auditing (required)' },
  { name: 'GEMINI_API_KEY', prefix: 'AIza', required: false, desc: 'Gemini 3.1 Pro final review (recommended)' },
  { name: 'ANTHROPIC_API_KEY', prefix: 'sk-ant-', required: false, desc: 'Claude Haiku context briefs (recommended)' },
  { name: 'SUPABASE_AUDIT_URL', prefix: 'https://', required: false, desc: 'Cloud learning store URL (optional)' },
  { name: 'SUPABASE_AUDIT_ANON_KEY', prefix: '', required: false, desc: 'Cloud learning store anon key (optional)' }
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function checkNode() {
  const major = parseInt(process.version.slice(1));
  if (major >= 18) { ok(`Node.js ${process.version}`); return true; }
  fail(`Node.js ${process.version} — need v18+ for ES modules`);
  return false;
}

function checkNpm() {
  try {
    ok(`npm ${execSync('npm --version', { encoding: 'utf-8' }).trim()}`);
    return true;
  } catch { fail('npm not found'); return false; }
}

// ── Install scripts ───────────────────────────────────────────────────────────

function installScripts(targetDir, sourceDir) {
  const scriptsDir = path.join(targetDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  let installed = 0, skipped = 0;
  for (const script of SCRIPTS) {
    const src = path.join(sourceDir, script);
    const dest = path.join(targetDir, script);
    if (!fs.existsSync(src)) { warn(`Source missing: ${script}`); continue; }

    if (fs.existsSync(dest)) {
      const existing = fs.readFileSync(dest, 'utf-8');
      const incoming = fs.readFileSync(src, 'utf-8');
      if (existing === incoming) { skipped++; continue; }
    }
    fs.copyFileSync(src, dest);
    installed++;
  }
  ok(`${installed} script(s) installed, ${skipped} already up to date`);
}

// ── Install skills (all platforms) ────────────────────────────────────────────

function installSkills(targetDir, sourceDir) {
  const platforms = [
    // Claude Code (CLI + VS Code extension + desktop app)
    { dir: '.claude/skills/audit-loop', name: 'Claude Code' },
    // VS Code Copilot / GitHub Copilot
    { dir: '.github/skills/audit-loop', name: 'VS Code Copilot' },
    // Cursor uses .cursor/rules or .cursorrules — skill goes in .github
    // Windsurf uses .windsurfrules — skill goes in .github
    // JetBrains uses .github/copilot-instructions.md — skill goes in .github
  ];

  const skillSrc = path.join(sourceDir, '.claude', 'skills', 'audit-loop', 'SKILL.md');
  if (!fs.existsSync(skillSrc)) { warn('SKILL.md source not found'); return; }

  for (const platform of platforms) {
    const destDir = path.join(targetDir, platform.dir);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(skillSrc, path.join(destDir, 'SKILL.md'));
    ok(`${platform.name} skill → ${platform.dir}/SKILL.md`);
  }

  // Cursor: also create .cursor/rules reference if .cursor dir exists
  const cursorDir = path.join(targetDir, '.cursor');
  if (fs.existsSync(cursorDir)) {
    const rulesDir = path.join(cursorDir, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.copyFileSync(skillSrc, path.join(rulesDir, 'audit-loop.md'));
    ok('Cursor skill → .cursor/rules/audit-loop.md');
  }

  // Windsurf: create .windsurfrules reference if it exists
  const windsurfRules = path.join(targetDir, '.windsurfrules');
  if (fs.existsSync(windsurfRules)) {
    const content = fs.readFileSync(windsurfRules, 'utf-8');
    if (!content.includes('audit-loop')) {
      fs.appendFileSync(windsurfRules, '\n\n# Audit Loop skill — see .github/skills/audit-loop/SKILL.md\n');
      ok('Windsurf .windsurfrules updated with audit-loop reference');
    }
  }
}

// ── Dependencies ──────────────────────────────────────────────────────────────

function checkDependencies(targetDir) {
  const pkgPath = path.join(targetDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    warn('No package.json — creating one');
    execSync('npm init -y', { cwd: targetDir, stdio: 'pipe' });
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const needed = [];

  for (const dep of DEPS) {
    if (allDeps[dep]) {
      ok(`${dep} ✓`);
    } else {
      needed.push(dep);
    }
  }

  if (pkg.type !== 'module') {
    warn('package.json missing "type": "module" — audit scripts use ES modules');
  }

  return needed;
}

// ── API Keys ──────────────────────────────────────────────────────────────────

async function setupEnv(targetDir) {
  const envPath = path.join(targetDir, '.env');
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  let modified = false;

  for (const key of API_KEYS) {
    if (envContent.includes(`${key.name}=`)) {
      ok(`${key.name} already in .env`);
      continue;
    }

    const reqLabel = key.required ? `${RED}required${RESET}` : `${DIM}optional${RESET}`;
    const value = await ask(`  ${key.name} (${key.desc}, ${reqLabel}): `);

    if (value && value.trim()) {
      envContent += `\n${key.name}=${value.trim()}`;
      modified = true;
      ok(`${key.name} added`);
    } else if (key.required) {
      warn(`${key.name} skipped — you MUST set this before running audits`);
      envContent += `\n# ${key.name}=  # ${key.desc}`;
      modified = true;
    } else {
      envContent += `\n# ${key.name}=  # ${key.desc}`;
      modified = true;
    }
  }

  if (modified) {
    fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf-8');
    ok('.env updated');
  }

  // Ensure .env in .gitignore
  const giPath = path.join(targetDir, '.gitignore');
  if (fs.existsSync(giPath)) {
    const gi = fs.readFileSync(giPath, 'utf-8');
    if (!gi.includes('.env')) {
      fs.appendFileSync(giPath, '\n.env\n.audit/\n');
      ok('.env + .audit/ added to .gitignore');
    } else if (!gi.includes('.audit/')) {
      fs.appendFileSync(giPath, '\n.audit/\n');
      ok('.audit/ added to .gitignore');
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
${BOLD}╔══════════════════════════════════════════════════════════╗
║  Claude Audit Loop — Adaptive Audit Intelligence Setup  ║
║  3 models: Claude + GPT-5.4 + Gemini 3.1 Pro           ║
║  7 phases: R2+ efficiency → predictive strategy         ║
╚══════════════════════════════════════════════════════════╝${RESET}
`);

  const args = process.argv.slice(2);
  const scriptsOnly = args.includes('--scripts-only');
  const targetIdx = args.indexOf('--target');
  const targetArg = targetIdx >= 0 ? args[targetIdx + 1] : null;

  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  let targetDir = targetArg ? path.resolve(targetArg) : findProjectRoot(process.cwd()) ?? process.cwd();

  // ── Prerequisites
  heading('Step 1 — Prerequisites');
  if (!checkNode() || !checkNpm()) { fail('Missing prerequisites.'); process.exit(1); }

  // ── Target
  heading('Step 2 — Target project');
  console.log(`  Installing into: ${BOLD}${targetDir}${RESET}`);
  if (!fs.existsSync(targetDir)) { fail(`Directory not found: ${targetDir}`); process.exit(1); }
  const confirm = await ask('  Correct? (Y/n) ');
  if (confirm.toLowerCase() === 'n') {
    targetDir = path.resolve(await ask('  Enter target directory: '));
  }

  // ── Dependencies
  heading('Step 3 — Dependencies');
  const needed = checkDependencies(targetDir);
  if (needed.length > 0) {
    console.log(`\n  Installing: ${needed.join(', ')}`);
    try {
      execSync(`npm install ${needed.join(' ')}`, { cwd: targetDir, stdio: 'inherit' });
      ok('Dependencies installed');
    } catch { fail('npm install failed — run manually: npm install ' + needed.join(' ')); }
  }

  // ── Scripts
  heading('Step 4 — Audit scripts');
  installScripts(targetDir, sourceDir);

  // ── Skills (all platforms)
  if (!scriptsOnly) {
    heading('Step 5 — Platform skills');
    installSkills(targetDir, sourceDir);
  }

  // ── API Keys
  if (!scriptsOnly) {
    heading('Step 6 — API keys');
    await setupEnv(targetDir);
  }

  // ── Summary
  heading('Setup complete!');
  console.log('  Scripts:');
  for (const s of SCRIPTS) {
    const exists = fs.existsSync(path.join(targetDir, s));
    console.log(`    ${exists ? GREEN + '✓' : RED + '✗'}${RESET} ${s}`);
  }

  console.log('\n  Platforms:');
  console.log(`    ${GREEN}✓${RESET} Claude Code       (.claude/skills/audit-loop/)`);
  console.log(`    ${GREEN}✓${RESET} VS Code Copilot   (.github/skills/audit-loop/)`);
  console.log(`    ${GREEN}✓${RESET} Cursor            (.github/skills/ or .cursor/rules/)`);
  console.log(`    ${GREEN}✓${RESET} Windsurf          (.github/skills/)`);
  console.log(`    ${GREEN}✓${RESET} JetBrains         (.github/skills/)`);
  console.log(`    ${GREEN}✓${RESET} Terminal           (node scripts/openai-audit.mjs)`);

  console.log('\n  Usage:');
  console.log(`    ${DIM}Claude Code:${RESET}  /audit-loop plan docs/plans/my-feature.md`);
  console.log(`    ${DIM}Claude Code:${RESET}  /audit-loop code docs/plans/my-feature.md`);
  console.log(`    ${DIM}Copilot:${RESET}      /audit-loop (in Copilot Chat)`);
  console.log(`    ${DIM}Terminal:${RESET}      node scripts/openai-audit.mjs code <plan>`);
  console.log(`    ${DIM}Bandit:${RESET}        node scripts/bandit.mjs stats`);
  console.log(`    ${DIM}Refine:${RESET}        node scripts/refine-prompts.mjs backend --suggest`);
  console.log(`    ${DIM}Phase 7:${RESET}       node scripts/phase7-check.mjs`);

  console.log('');
  rl.close();
}

main().catch(err => { console.error('Setup failed:', err.message); process.exit(1); });
