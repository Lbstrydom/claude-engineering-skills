#!/usr/bin/env node
/**
 * @fileoverview First-run setup: merge audit-loop permission patterns into
 * Claude Code settings so the audit loop runs with minimal approval prompts.
 *
 * Updates TWO locations:
 *   1. Project-level:  .claude/settings.json  (committed, shared with team)
 *   2. User-level:     ~/.claude/settings.json (personal, all repos)
 *
 * Safe to run multiple times — only adds missing rules, never duplicates.
 *
 * Usage:
 *   node scripts/setup-permissions.mjs              # interactive (prompts before writing)
 *   node scripts/setup-permissions.mjs --yes         # auto-approve all changes
 *   node scripts/setup-permissions.mjs --project     # project-level only
 *   node scripts/setup-permissions.mjs --user        # user-level only
 *   node scripts/setup-permissions.mjs --dry-run     # show what would change
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

// ── ANSI ────────────────────────────────────────────────────────────────────

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

// ── Permission templates ────────────────────────────────────────────────────

/** Rules for project-level .claude/settings.json */
const PROJECT_RULES = [
  'Bash(node scripts/*)',
  'Bash(node --input-type=module *)',
  'Bash(node -e *)',
  'Bash(npm test*)',
  'Bash(npm run *)',
  'Bash(npx *)',
  'Bash(git *)',
  'Bash(ls *)',
  'Bash(cat *)',
  'Bash(wc *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(echo *)',
  'Bash(file *)',
  'Bash(grep *)',
  'Bash(mv *)',
  'Bash(cp *)',
  'Bash(mkdir *)',
  'Bash(SID=*)',
  'Bash(python3 *)',
  'Bash(OPENAI_AUDIT_TIMEOUT_MS=*)',
  'Bash(DOTENV_CONFIG_PATH=*)',
  'Read(*)',
  'Edit(*)',
];

/** Rules for user-level ~/.claude/settings.json (broader — applies everywhere) */
const USER_RULES = [
  'Bash(node *)',
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(git *)',
  'Bash(ls *)',
  'Bash(cat *)',
  'Bash(wc *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(echo *)',
  'Bash(file *)',
  'Bash(find *)',
  'Bash(grep *)',
  'Bash(sort *)',
  'Bash(mv *)',
  'Bash(cp *)',
  'Bash(mkdir *)',
  'Bash(chmod *)',
  'Bash(sed *)',
  'Bash(python3 *)',
  'Bash(bash *)',
  'Bash(gh *)',
  'Bash(SID=*)',
  'Read(*)',
  'Edit(*)',
  'WebSearch',
  'WebFetch(*)',
];

const USER_DENY = [
  'Bash(rm -rf /)',
  'Bash(rm -rf ~)',
  'Bash(rm -rf /*)',
];

// ── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const AUTO_YES = args.includes('--yes') || args.includes('-y');
const DRY_RUN = args.includes('--dry-run');
const PROJECT_ONLY = args.includes('--project');
const USER_ONLY = args.includes('--user');

// ── Helpers ─────────────────────────────────────────────────────────────────

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

async function confirm(message) {
  if (AUTO_YES) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${message} [Y/n] `, answer => {
      rl.close();
      resolve(!answer || answer.toLowerCase().startsWith('y'));
    });
  });
}

/**
 * Merge rules into a settings object. Returns { settings, added } where
 * added is the list of rules that were missing.
 */
function mergeRules(settings, rules, denyRules = []) {
  if (!settings) settings = {};
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];

  const existing = new Set(settings.permissions.allow);
  const added = rules.filter(r => !existing.has(r));
  settings.permissions.allow = [...new Set([...settings.permissions.allow, ...rules])];

  // Clean up one-off rules that are now covered by wildcards
  const wildcardPatterns = rules.filter(r => r.includes('*'));
  const cleaned = [];
  let removed = 0;
  for (const rule of settings.permissions.allow) {
    // Keep wildcards and non-Bash rules
    if (wildcardPatterns.includes(rule) || !rule.startsWith('Bash(')) {
      cleaned.push(rule);
      continue;
    }
    // Check if this specific rule is covered by a wildcard
    const ruleCmd = rule.slice(5, -1); // strip "Bash(" and ")"
    const coveredByWildcard = wildcardPatterns.some(w => {
      const wCmd = w.slice(5, -1);
      if (!wCmd.endsWith('*')) return false;
      const prefix = wCmd.slice(0, -1); // everything before the *
      return ruleCmd.startsWith(prefix);
    });
    if (coveredByWildcard) {
      removed++;
    } else {
      cleaned.push(rule);
    }
  }
  settings.permissions.allow = cleaned;

  // Merge deny rules
  if (denyRules.length > 0) {
    if (!settings.permissions.deny) settings.permissions.deny = [];
    const existingDeny = new Set(settings.permissions.deny);
    for (const r of denyRules) {
      if (!existingDeny.has(r)) settings.permissions.deny.push(r);
    }
  }

  return { settings, added, removed };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${B}Audit-Loop Permission Setup${X}\n`);
  console.log(`This script adds wildcard permission rules to Claude Code settings`);
  console.log(`so the audit loop runs with minimal approval prompts.\n`);

  const projectPath = path.resolve('.claude', 'settings.json');
  const userPath = path.join(os.homedir(), '.claude', 'settings.json');

  let totalAdded = 0;
  let totalRemoved = 0;

  // ── Project-level ─────────────────────────────────────────────────────

  if (!USER_ONLY) {
    console.log(`${B}1. Project-level${X} ${D}(${projectPath})${X}`);
    const existing = readJson(projectPath);
    const { settings, added, removed } = mergeRules(existing || {}, PROJECT_RULES);

    if (added.length === 0 && removed === 0) {
      console.log(`   ${G}✓${X} All ${PROJECT_RULES.length} rules already present\n`);
    } else {
      if (added.length > 0) {
        console.log(`   ${Y}+${added.length} rules to add:${X}`);
        for (const r of added.slice(0, 8)) console.log(`     ${G}+${X} ${r}`);
        if (added.length > 8) console.log(`     ${D}... and ${added.length - 8} more${X}`);
      }
      if (removed > 0) {
        console.log(`   ${Y}-${removed} one-off rules cleaned up${X} (covered by wildcards)`);
      }

      if (DRY_RUN) {
        console.log(`   ${D}(dry run — no changes written)${X}\n`);
      } else if (await confirm(`   Apply changes?`)) {
        writeJson(projectPath, settings);
        console.log(`   ${G}✓${X} Written\n`);
        totalAdded += added.length;
        totalRemoved += removed;
      } else {
        console.log(`   ${D}Skipped${X}\n`);
      }
    }
  }

  // ── User-level ────────────────────────────────────────────────────────

  if (!PROJECT_ONLY) {
    console.log(`${B}2. User-level${X} ${D}(${userPath})${X}`);
    const existing = readJson(userPath);
    const { settings, added, removed } = mergeRules(existing || {}, USER_RULES, USER_DENY);

    // Also suggest defaultMode: auto if not set
    const needsAutoMode = !settings.permissions.defaultMode;
    if (needsAutoMode) {
      settings.permissions.defaultMode = 'auto';
    }

    if (added.length === 0 && removed === 0 && !needsAutoMode) {
      console.log(`   ${G}✓${X} All ${USER_RULES.length} rules already present\n`);
    } else {
      if (added.length > 0) {
        console.log(`   ${Y}+${added.length} rules to add:${X}`);
        for (const r of added.slice(0, 8)) console.log(`     ${G}+${X} ${r}`);
        if (added.length > 8) console.log(`     ${D}... and ${added.length - 8} more${X}`);
      }
      if (removed > 0) {
        console.log(`   ${Y}-${removed} one-off rules cleaned up${X} (covered by wildcards)`);
      }
      if (needsAutoMode) {
        console.log(`   ${Y}+${X} defaultMode: "auto" (AI safety classifier for uncovered commands)`);
      }

      console.log(`\n   ${D}User-level rules apply to ALL repos you open in Claude Code.${X}`);
      console.log(`   ${D}Deny rules block: rm -rf /, rm -rf ~, rm -rf /*${X}`);

      if (DRY_RUN) {
        console.log(`   ${D}(dry run — no changes written)${X}\n`);
      } else if (await confirm(`\n   Apply changes?`)) {
        writeJson(userPath, settings);
        console.log(`   ${G}✓${X} Written\n`);
        totalAdded += added.length;
        totalRemoved += removed;
      } else {
        console.log(`   ${D}Skipped${X}\n`);
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────

  if (DRY_RUN) {
    console.log(`${D}Dry run complete — no files were modified.${X}\n`);
  } else if (totalAdded > 0 || totalRemoved > 0) {
    console.log(`${G}Done${X} — added ${totalAdded} rules, cleaned ${totalRemoved} one-offs.`);
    console.log(`${D}Restart Claude Code for changes to take effect.${X}\n`);
  } else {
    console.log(`${G}Everything already configured${X} — no changes needed.\n`);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
