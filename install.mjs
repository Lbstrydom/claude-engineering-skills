#!/usr/bin/env node
/**
 * @fileoverview One-command installer for claude-engineering-skills.
 *
 * Usage:
 *   npx github:Lbstrydom/claude-engineering-skills
 *   node install.mjs
 *   node install.mjs /path/to/project
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createPrompter } from './scripts/lib/install/prompt.mjs';

const { rl, ask } = createPrompter();

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', B = '\x1b[1m', D = '\x1b[2m', X = '\x1b[0m';

const REPO = 'https://github.com/Lbstrydom/claude-engineering-skills.git';
const SCRIPTS = ['openai-audit.mjs','shared.mjs','gemini-review.mjs','bandit.mjs','refine-prompts.mjs','learning-store.mjs','phase7-check.mjs'];
// M4 — `@supabase/supabase-js` removed; `pg` (the Postgres driver) is the
// new cloud-store dependency. Anyone running the audit-loop now needs `pg`,
// not supabase-js.
const DEPS = ['openai','zod','dotenv','@google/genai','@anthropic-ai/sdk','pg'];
const KEYS = [
  { name: 'OPENAI_API_KEY', req: true, hint: 'GPT-5.4 auditing (required)' },
  { name: 'GEMINI_API_KEY', req: false, hint: 'Gemini 3.1 Pro final review' },
  { name: 'ANTHROPIC_API_KEY', req: false, hint: 'Claude Haiku context briefs' },
  { name: 'AUDIT_DB_URL', req: false, hint: 'audit-loop cloud store Postgres DSN (Supabase Connect → Session pooler)' },
  { name: 'PERSONA_TEST_APP_URL', req: false, hint: 'default app URL for /persona-test list (e.g. https://myapp.railway.app)' },
  { name: 'PERSONA_TEST_REPO_NAME', req: false, hint: 'repo name for cross-referencing audit findings (e.g. wine-cellar-app)' }
];

async function main() {
  console.log(`
${B}══════════════════════════════════════════════════
  Claude Engineering Skills — Install
  3 models · 7 phases · adaptive learning
══════════════════════════════════════════════════${X}
`);

  // 1. Get target directory
  let target = process.argv[2];
  if (target === '--help' || target === '-h') {
    console.log('Usage: npx github:Lbstrydom/claude-engineering-skills <project-directory>');
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
  const tmp = path.join(os.tmpdir(), `claude-engineering-skills-${Date.now()}`);
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
  const skillNames = ['audit-loop', 'persona-test'];
  for (const skillName of skillNames) {
    const skillSrc = path.join(tmp, '.claude', 'skills', skillName, 'SKILL.md');
    if (!fs.existsSync(skillSrc)) {
      console.log(`  ${Y}⚠${X} ${skillName}/SKILL.md not found in bundle — skipping`);
      continue;
    }
    const skill = fs.readFileSync(skillSrc, 'utf-8');

    // Claude Code
    const claudeDir = path.join(target, '.claude', 'skills', skillName);
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'SKILL.md'), skill);

    // VS Code Copilot / Cursor / Windsurf / JetBrains
    const ghDir = path.join(target, '.github', 'skills', skillName);
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'SKILL.md'), skill);

    // Cursor .cursor/rules (if .cursor exists)
    if (fs.existsSync(path.join(target, '.cursor'))) {
      const cursorDir = path.join(target, '.cursor', 'rules');
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.writeFileSync(path.join(cursorDir, `${skillName}.md`), skill);
    }
    console.log(`  ${G}✓${X} ${skillName} → Claude Code + VS Code Copilot + Cursor + Windsurf`);
  }

  // 4b. Install pre-push hook for continuous skill sync
  console.log(`\n${B}Git Hooks${X}`);
  const hooksDir = path.join(target, '.git', 'hooks');
  if (fs.existsSync(hooksDir)) {
    const hookContent = `#!/bin/bash
# Auto-sync skill files to consumer repos before every push.
# Non-blocking — sync warnings never stop the push.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
SYNC_SCRIPT="$REPO_ROOT/scripts/sync-to-repos.mjs"
if [ ! -f "$SYNC_SCRIPT" ]; then exit 0; fi
echo "→ Syncing skills to consumer repos..."
node "$SYNC_SCRIPT" 2>&1
SYNC_EXIT=$?
[ $SYNC_EXIT -ne 0 ] && echo "⚠  Sync completed with warnings — push continues"
[ $SYNC_EXIT -eq 0 ] && echo "✓  Sync complete"
exit 0
`;
    const hookPath = path.join(hooksDir, 'pre-push');
    fs.writeFileSync(hookPath, hookContent);
    fs.chmodSync(hookPath, 0o755);
    console.log(`  ${G}✓${X} pre-push hook installed — skills auto-sync on every push`);
  } else {
    console.log(`  ${Y}⚠${X} No .git/hooks dir found — install in a git repo to enable auto-sync`);
  }

  // 4c. Claude Code permissions (minimize approval prompts)
  console.log(`\n${B}Claude Code Permissions${X}`);
  const setupPerms = path.join(tmp, 'scripts', 'setup-permissions.mjs');
  if (fs.existsSync(setupPerms)) {
    const doPerms = await ask(`  Set up permission rules to minimize audit-loop prompts? [Y/n] `);
    if (!doPerms || doPerms.toLowerCase().startsWith('y')) {
      try {
        // Copy the script to target first so it can find the project dir
        const targetScript = path.join(scriptsDir, 'setup-permissions.mjs');
        fs.copyFileSync(setupPerms, targetScript);
        execSync(`node "${targetScript}" --yes`, { cwd: target, stdio: 'inherit' });
      } catch {
        console.log(`  ${Y}⚠${X} Permission setup had issues — run manually: node scripts/setup-permissions.mjs`);
      }
    } else {
      console.log(`  ${D}Skipped — run later: node scripts/setup-permissions.mjs${X}`);
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

  // 6b. Weekly local maintenance (optional, default off)
  // Opt-in replica of the 5 weekly GH Actions cron workflows (architectural
  // drift, migration drift, model freshness, memory health, learning weekly
  // review), run opportunistically from the pre-push hook — for consumers
  // whose org blocks GitHub-hosted Actions runners, or who just want the
  // signal without standing up separate CI. See docs/runbooks/local-maintenance-checks.md.
  //
  // LEARNING_REPO_NAME must be the owner/repo slug (matches audit_repos.name,
  // itself derived from the git origin URL) — NOT the bare directory name.
  // Found 2026-07-22: every consumer that ever set this by hand used the bare
  // name (matching this file's own PERSONA_TEST_REPO_NAME hint two sections
  // up, which uses a different, bare-name convention on a different table),
  // so learning-weekly-review silently read {posted:false, reason:
  // 'unknown-repo'} forever. Derive it automatically here instead of asking —
  // it's the same value resolveRepoIdentity() already computes for the DB
  // write path, so there's nothing for the operator to get wrong.
  if (!env.match(/^AUDIT_LOOP_WEEKLY_MAINTENANCE=1/m)) {
    console.log(`\n${B}Weekly maintenance checks${X}`);
    console.log(`  Runs a local replica of 5 weekly GH Actions checks (architectural drift,`);
    console.log(`  migration drift, model freshness, memory health, learning review)`);
    console.log(`  opportunistically from your pre-push hook.\n`);
    const wantMaintenance = await ask(`  Schedule weekly local maintenance checks? [y/N]: `);
    if (/^y(es)?$/i.test(wantMaintenance?.trim() || '')) {
      const { resolveRepoIdentity } = await import('./scripts/lib/repo-identity.mjs');
      const { name: repoName } = resolveRepoIdentity(target);
      env += `\nAUDIT_LOOP_WEEKLY_MAINTENANCE=1\nLEARNING_REPO_NAME=${repoName}`;
      fs.writeFileSync(envPath, env.trim() + '\n');
      console.log(`  ${G}✓${X} Weekly maintenance enabled (LEARNING_REPO_NAME=${repoName})`);
    }
  }

  // Ensure audit-loop artifacts are gitignored
  const { ensureAuditGitignore } = await import('./scripts/lib/install/gitignore.mjs');
  ensureAuditGitignore(target);

  // 7. Cleanup
  fs.rmSync(tmp, { recursive: true, force: true });

  // Done
  console.log(`
${B}══════════════════════════════════════════════════
  ✓ Installed!
══════════════════════════════════════════════════${X}

  ${D}Audit:${X}         /audit-loop plan docs/plans/<name>.md
  ${D}Persona test:${X}  /persona-test "first-time user" https://myapp.railway.app
  ${D}List personas:${X} /persona-test list
  ${D}Ship:${X}          /ship (includes UX P0 gate)
  ${D}Terminal:${X}      node scripts/openai-audit.mjs code docs/plans/<name>.md
  ${D}Sync skills:${X}   node scripts/sync-to-repos.mjs (also runs on git push)
  ${D}Bandit:${X}        node scripts/bandit.mjs stats
  ${D}Phase 7:${X}       node scripts/phase7-check.mjs
`);

  rl.close();
}

main().catch(err => { console.error('Install failed:', err.message); process.exit(1); });
