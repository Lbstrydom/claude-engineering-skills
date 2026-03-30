#!/usr/bin/env node
/**
 * @fileoverview One-command installer for claude-audit-loop.
 *
 * Usage:
 *   npx github:Lbstrydom/claude-audit-loop
 *   node install.mjs
 *   node install.mjs /path/to/project
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', B = '\x1b[1m', D = '\x1b[2m', X = '\x1b[0m';

const REPO = 'https://github.com/Lbstrydom/claude-audit-loop.git';
const SCRIPTS = ['openai-audit.mjs','shared.mjs','gemini-review.mjs','bandit.mjs','refine-prompts.mjs','learning-store.mjs','phase7-check.mjs'];
const DEPS = ['openai','zod','dotenv','@google/genai','@anthropic-ai/sdk','@supabase/supabase-js'];
const KEYS = [
  { name: 'OPENAI_API_KEY', req: true, hint: 'GPT-5.4 auditing (required)' },
  { name: 'GEMINI_API_KEY', req: false, hint: 'Gemini 3.1 Pro final review' },
  { name: 'ANTHROPIC_API_KEY', req: false, hint: 'Claude Haiku context briefs' },
  { name: 'SUPABASE_AUDIT_URL', req: false, hint: 'Cloud learning store URL' },
  { name: 'SUPABASE_AUDIT_ANON_KEY', req: false, hint: 'Cloud learning store key' }
];

async function main() {
  console.log(`
${B}══════════════════════════════════════════════════
  Claude Audit Loop — Install
  3 models · 7 phases · adaptive learning
══════════════════════════════════════════════════${X}
`);

  // 1. Get target directory
  let target = process.argv[2];
  if (target === '--help' || target === '-h') {
    console.log('Usage: npx github:Lbstrydom/claude-audit-loop <project-directory>');
    console.log('       node install.mjs <project-directory>');
    rl.close();
    return;
  }
  if (!target || target.startsWith('-')) {
    target = await ask(`  Project directory: `);
  }
  target = path.resolve(target);

  if (!fs.existsSync(target)) {
    console.log(`${R}✗${X} Directory not found: ${target}`);
    process.exit(1);
  }
  console.log(`  Target: ${B}${target}${X}\n`);

  // 2. Clone to temp dir
  const tmp = path.join(os.tmpdir(), `claude-audit-loop-${Date.now()}`);
  console.log(`${D}  Fetching latest from GitHub...${X}`);
  try {
    execSync(`git clone --depth 1 ${REPO} "${tmp}"`, { stdio: 'pipe' });
    console.log(`${G}✓${X} Downloaded latest version\n`);
  } catch (err) {
    console.log(`${R}✗${X} Clone failed: ${err.message}`);
    process.exit(1);
  }

  // 3. Copy scripts
  console.log(`${B}Scripts${X}`);
  const scriptsDir = path.join(target, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const s of SCRIPTS) {
    const src = path.join(tmp, 'scripts', s);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(scriptsDir, s));
      console.log(`  ${G}✓${X} scripts/${s}`);
    }
  }

  // 4. Install skills (all platforms)
  console.log(`\n${B}Skills${X}`);
  const skillSrc = path.join(tmp, '.claude', 'skills', 'audit-loop', 'SKILL.md');
  if (fs.existsSync(skillSrc)) {
    const skill = fs.readFileSync(skillSrc, 'utf-8');

    // Claude Code
    const claudeDir = path.join(target, '.claude', 'skills', 'audit-loop');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'SKILL.md'), skill);
    console.log(`  ${G}✓${X} Claude Code`);

    // VS Code Copilot / Cursor / Windsurf / JetBrains
    const ghDir = path.join(target, '.github', 'skills', 'audit-loop');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'SKILL.md'), skill);
    console.log(`  ${G}✓${X} VS Code Copilot / Cursor / Windsurf / JetBrains`);

    // Cursor .cursor/rules (if .cursor exists)
    const cursorDir = path.join(target, '.cursor', 'rules');
    if (fs.existsSync(path.join(target, '.cursor'))) {
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.writeFileSync(path.join(cursorDir, 'audit-loop.md'), skill);
      console.log(`  ${G}✓${X} Cursor rules`);
    }
  }

  // 5. Dependencies
  console.log(`\n${B}Dependencies${X}`);
  const pkgPath = path.join(target, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    execSync('npm init -y', { cwd: target, stdio: 'pipe' });
    console.log(`  ${Y}⚠${X} Created package.json`);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const needed = DEPS.filter(d => !allDeps[d]);

  if (needed.length > 0) {
    console.log(`  Installing: ${needed.join(', ')}`);
    try {
      execSync(`npm install ${needed.join(' ')}`, { cwd: target, stdio: 'pipe' });
      console.log(`  ${G}✓${X} ${needed.length} packages installed`);
    } catch { console.log(`  ${R}✗${X} npm install failed — run manually: npm install ${needed.join(' ')}`); }
  } else {
    console.log(`  ${G}✓${X} All dependencies present`);
  }

  if (pkg.type !== 'module') {
    console.log(`  ${Y}⚠${X} Add "type": "module" to package.json for ES module support`);
  }

  // 6. API keys
  console.log(`\n${B}API Keys${X}`);
  const envPath = path.join(target, '.env');
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  let envChanged = false;

  for (const k of KEYS) {
    if (env.includes(`${k.name}=`) && !env.includes(`# ${k.name}=`)) {
      console.log(`  ${G}✓${X} ${k.name} already set`);
      continue;
    }
    const label = k.req ? `${R}required${X}` : `${D}optional${X}`;
    const val = await ask(`  ${k.name} (${k.hint}, ${label}): `);
    if (val?.trim()) {
      env += `\n${k.name}=${val.trim()}`;
      envChanged = true;
    } else {
      env += `\n# ${k.name}=  # ${k.hint}`;
      envChanged = true;
      if (k.req) console.log(`  ${Y}⚠${X} Required — set before running audits`);
    }
  }

  if (envChanged) {
    fs.writeFileSync(envPath, env.trim() + '\n');
    console.log(`  ${G}✓${X} .env updated`);
  }

  // Ensure .gitignore
  const giPath = path.join(target, '.gitignore');
  if (fs.existsSync(giPath)) {
    let gi = fs.readFileSync(giPath, 'utf-8');
    let giChanged = false;
    if (!gi.includes('.env')) { gi += '\n.env'; giChanged = true; }
    if (!gi.includes('.audit/')) { gi += '\n.audit/'; giChanged = true; }
    if (giChanged) fs.writeFileSync(giPath, gi);
  }

  // 7. Cleanup
  fs.rmSync(tmp, { recursive: true, force: true });

  // Done
  console.log(`
${B}══════════════════════════════════════════════════
  ✓ Installed!
══════════════════════════════════════════════════${X}

  ${D}Claude Code:${X}  /audit-loop plan docs/plans/X.md
  ${D}Copilot:${X}      /audit-loop (in chat)
  ${D}Terminal:${X}      node scripts/openai-audit.mjs code docs/plans/X.md
  ${D}Bandit:${X}        node scripts/bandit.mjs stats
  ${D}Phase 7:${X}       node scripts/phase7-check.mjs
`);

  rl.close();
}

main().catch(err => { console.error('Install failed:', err.message); process.exit(1); });
