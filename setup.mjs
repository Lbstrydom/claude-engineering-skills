#!/usr/bin/env node
/**
 * @fileoverview First-run setup wizard for claude-engineering-skills.
 *
 * Run once after cloning this repo. Configures:
 *   1. API keys (.env in this repo)
 *   2. Learning database (none / SQLite / Supabase / Postgres)
 *   3. Weekly local maintenance checks (optional, default off)
 *   4. npm dependencies (in this repo)
 *   5. Skill-surface verification (this repo's .claude/skills/ is committed —
 *      nothing to install; also reports a stale machine-global tree if present)
 *
 * It does NOT install skills anywhere. Skills are repo-scoped: this repo's copy
 * is committed, and another repo gets one via
 * `npm run sync -- --target-path <dir>` or
 * `npx github:Lbstrydom/claude-engineering-skills <dir>`.
 * See docs/reference/skill-surface-ownership.md.
 *
 * Usage:
 *   node setup.mjs              # Interactive wizard
 *   node setup.mjs --headless   # Non-interactive (use existing .env, defaults)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFileSync } from 'node:child_process';
import { createPrompter } from './scripts/lib/install/prompt.mjs';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const { rl, ask } = createPrompter();

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
  { name: 'OPENAI_API_KEY', required: true, desc: 'GPT auditing' },
  { name: 'GEMINI_API_KEY', required: false, desc: 'Gemini final review + A/B pipeline' },
  { name: 'ANTHROPIC_API_KEY', required: false, desc: 'Claude Opus fallback review' },
  { name: 'OPENROUTER_API_KEY', required: false, desc: 'OSS models via OpenRouter (tiered-pipeline GLM discovery/triage, model-eval candidates)' },
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
  { key: '1', name: 'None', desc: 'Local JSON files only (default, zero setup)' },
  { key: '2', name: 'Postgres', desc: 'Cloud (Supabase pooler) or self-hosted — single DSN via AUDIT_DB_URL', extraKeys: ['AUDIT_DB_URL'] },
];

async function setupDatabase(headless) {
  if (headless) { ok('Database: using existing .env config'); return; }

  console.log('');
  console.log(`  Learning database stores audit outcomes, bandit arms, and FP patterns.`);
  console.log(`  Data accumulates over time and makes future audits smarter.\n`);
  for (const opt of DB_OPTIONS) {
    console.log(`    ${B}${opt.key}${X}) ${opt.name} — ${opt.desc}`);
  }
  // State the capability delta, not just the upside: choosing 1 is a real
  // trade-off and the operator should see it before choosing, not discover it
  // when a skill reports `{"cloud": false}` mid-audit.
  console.log('');
  console.log(`  ${D}Every skill runs either way. Plans, audit reports, adjudication ledgers${X}`);
  console.log(`  ${D}and generated specs are local files and need no database.${X}`);
  console.log(`  ${D}Without one, these stay off: cross-run learning + bandit arms,${X}`);
  console.log(`  ${D}architectural memory (near-duplicate detection before you write code),${X}`);
  console.log(`  ${D}security-incident memory, semantic + cloud FP suppression,${X}`);
  console.log(`  ${D}the memory-health gate, and persona/audit correlations.${X}`);
  console.log(`  ${D}No database software is installed either way; option 2 only stores a DSN.${X}`);
  console.log('');

  const choice = await ask(`  Choose (1-2, default 1): `);
  const selected = DB_OPTIONS.find(o => o.key === choice?.trim()) || DB_OPTIONS[0];
  ok(`Database: ${selected.name}`);

  const envPath = path.join(SELF_DIR, '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';

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

// ── Step 4: Weekly Local Maintenance (optional) ─────────────────────────────
// Opt-in replica of this repo's 5 weekly GH Actions cron workflows
// (architectural drift, migration drift, model freshness, memory health,
// learning weekly review) for operators whose org blocks GitHub-hosted
// Actions runners. Default No — a fresh clone with default answers must
// behave byte-identical to today. See docs/runbooks/local-maintenance-checks.md.

async function setupMaintenance(headless) {
  if (headless) { ok('Weekly maintenance: skipped (headless default)'); return; }

  const envPath = path.join(SELF_DIR, '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  if (content.match(/^AUDIT_LOOP_WEEKLY_MAINTENANCE=1/m)) {
    ok('Weekly maintenance already enabled');
    return;
  }

  console.log('');
  console.log(`  Runs a local replica of the 5 weekly GH Actions maintenance checks`);
  console.log(`  (architectural drift, migration drift, model freshness, memory`);
  console.log(`  health, learning review) opportunistically from your pre-push`);
  console.log(`  hook — for orgs that block GitHub-hosted Actions runners.\n`);

  const answer = await ask(`  Schedule weekly local maintenance checks? [y/N]: `);
  if (!/^y(es)?$/i.test(answer?.trim() || '')) {
    ok('Weekly maintenance: not enabled (opt in later via AUDIT_LOOP_WEEKLY_MAINTENANCE=1)');
    return;
  }

  content += `\nAUDIT_LOOP_WEEKLY_MAINTENANCE=1`;
  // LEARNING_REPO_NAME must be the owner/repo slug (matches audit_repos.name)
  // — derive it the same way the DB write path does, don't ask (found
  // 2026-07-22: every consumer that set this by hand used the bare name and
  // silently got {posted:false, reason:'unknown-repo'} forever).
  if (!content.match(/^LEARNING_REPO_NAME=/m)) {
    const { resolveRepoIdentity } = await import('./scripts/lib/repo-identity.mjs');
    const { name: repoName } = resolveRepoIdentity(SELF_DIR);
    content += `\nLEARNING_REPO_NAME=${repoName}`;
  }
  fs.writeFileSync(envPath, content.trim() + '\n');
  ok('Weekly maintenance enabled — will run opportunistically via the pre-push hook');
}

// ── Step 5: Verify this repo's own skill surface ─────────────────────────────

/**
 * This repo's skills need no installation step at all.
 *
 * `.claude/skills/**` is a committed Category-B artifact, so `git clone` already
 * delivered it and Claude Code picks it up as a project skill here. What used to
 * live at this step — `install-skills.mjs --local --surface claude --force` —
 * wrote a MACHINE-GLOBAL copy to `~/.claude/skills/`, which was the bug:
 * a SKILL.md's runner paths are a function of the deployment layout
 * (`scripts/X.mjs` here, `scripts/.claude-skills/X.mjs` in a consumer), and one
 * machine-wide directory shared by every repo cannot carry either correctly.
 * It also shipped 15 skill-name collisions into a Copilot-discovered personal
 * root — the exact hazard AGENTS.md forbids.
 *
 * So this step now VERIFIES rather than installs, which is the honest operation:
 * it tells the operator whether the committed surface is intact, and points at
 * the cleanup command if a stale global tree is still on the machine.
 *
 * To install into ANOTHER repo: `npm run sync -- --target-path <dir>`.
 * See docs/reference/skill-surface-ownership.md.
 */
async function verifySkillSurface() {
  const skillsDir = path.join(SELF_DIR, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) {
    fail('.claude/skills/ is missing — run `npm run skills:regenerate`');
  } else {
    const count = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory()).length;
    ok(`${count} skills available in this repo (.claude/skills/, committed)`);
  }

  // A stale global tree from a pre-retirement install still shadows the repo copy
  // in EVERY repo on this machine, so surfacing it here is the whole point.
  try {
    const { inspectLegacySurfaces, describeLegacySurfaces } =
      await import('./scripts/lib/install/legacy-surfaces.mjs');
    const legacy = inspectLegacySurfaces({ repoRoot: SELF_DIR });
    if (legacy.overall !== 'absent') {
      for (const line of describeLegacySurfaces(legacy)) warn(line);
      console.log(`  ${D}Remove it: node scripts/install-skills.mjs --uninstall-legacy${X}`);
    }
  } catch (err) {
    warn(`could not inspect retired skill surfaces: ${err.message?.slice(0, 120)}`);
  }
}

// ── Step 6: npm Dependencies ────────────────────────────────────────────────

function installDeps() {
  try {
    execFileSync('npm', ['install'], { cwd: SELF_DIR, stdio: 'pipe', timeout: 120000 });
    ok('npm dependencies installed');
  } catch {
    warn('npm install failed — run manually: npm install');
  }
}

// ── Step 7 (removed): the auto-update post-merge hook ───────────────────────
//
// There is nothing left for it to do, so it is gone rather than rewritten.
//
// It ran two commands after every `git pull`:
//   node scripts/build-manifest.mjs                                → writes skills.manifest.json
//   node scripts/install-skills.mjs --local --surface claude --force → wrote ~/.claude/skills/
//
// Both artifacts are COMMITTED Category-B files, so `git pull` has already
// delivered them and `npm run skills:check` proves they are fresh — the hook's
// only real effect was creating the machine-global skills tree that this change
// retires. A hook that regenerates committed, freshness-verified artifacts is
// pure churn at best; here it was actively producing the defect.
//
// `.githooks/post-merge` is deleted for the same reason. Nothing replaces it: if
// staleness is ever observed, the honest fix is a check (which exists), not a
// hook that writes.

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

  console.log(`\n${B}Step 4 — Weekly Maintenance (optional)${X}`);
  await setupMaintenance(headless);

  console.log(`\n${B}Step 5 — Dependencies${X}`);
  installDeps();

  console.log(`\n${B}Step 6 — Skill Surface${X}`);
  await verifySkillSurface();

  // Summary
  console.log(`
${B}╔══════════════════════════════════════════════════════════╗
║  Setup Complete                                          ║
╚══════════════════════════════════════════════════════════╝${X}

  ${G}This repo is ready.${X}

  ${B}How it works:${X}
    - Skills are REPO-SCOPED, never machine-global: this repo's live in
      ${D}.claude/skills/${X} and are committed, so a ${D}git pull${X} is the whole update
    - Claude Code reads them as project skills; VS Code Copilot (1.109+),
      Cursor and Windsurf all discover ${D}.claude/skills/${X} in the workspace too
    - Why not global: a SKILL.md's runner paths depend on the deployment
      layout, so one machine-wide copy cannot be correct in two repos
      (${D}docs/reference/skill-surface-ownership.md${X})

  ${B}Usage:${X}
    ${D}In any repo:${X}
      /plan <description>
      /audit-plan docs/plans/<name>.md
      /audit-code docs/plans/<name>.md
      /cycle <description>

    ${D}From this repo (CLI):${X}
      node scripts/audit-loop.mjs code <plan-file>
      node scripts/openai-audit.mjs code <plan-file>
      node scripts/bandit.mjs stats

  ${B}To update this repo:${X}
    cd ${SELF_DIR}
    git pull   ${D}# .claude/skills/** is committed — that's the whole update${X}

  ${B}To install the bundle into ANOTHER repo:${X}
    npm run sync -- --target-path /path/to/repo   ${D}# from here${X}
    npm run sync                                  ${D}# all registered consumers${X}

  ${B}If a stale machine-global copy is still on this machine:${X}
    node scripts/install-skills.mjs --uninstall-legacy
`);

  rl.close();
}

main().catch(err => { console.error(`Setup failed: ${err.message}`); process.exit(1); });
