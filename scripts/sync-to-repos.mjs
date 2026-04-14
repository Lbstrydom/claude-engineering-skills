#!/usr/bin/env node
/**
 * @fileoverview Sync canonical audit-loop scripts + SKILL.md files from this
 * source repo to consumer repos (wine-cellar-app, ai-organiser).
 *
 * Sync is one-directional: source (claude-audit-loop) → targets.
 * Files that don't exist in the target are created; existing files are overwritten.
 * Wine-cellar-app-specific or ai-organiser-specific scripts are never touched.
 *
 * Usage:
 *   node scripts/sync-to-repos.mjs               # sync all repos
 *   node scripts/sync-to-repos.mjs --dry-run      # show what would change, no writes
 *   node scripts/sync-to-repos.mjs --target wine  # sync wine-cellar-app only
 *   node scripts/sync-to-repos.mjs --target ai    # sync ai-organiser only
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const DRY_RUN = process.argv.includes('--dry-run');
const targetFilter = (() => {
  const idx = process.argv.indexOf('--target');
  return idx === -1 ? null : process.argv[idx + 1];
})();

const SOURCE_ROOT = path.resolve(import.meta.dirname, '..');

// ANSI colours
const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

// ── Canonical file sets ────────────────────────────────────────────────────

/**
 * Core audit runtime scripts shared across all consumer repos.
 * These are the files that must stay in sync — audits won't work correctly
 * without them. Ordered: top-level scripts first, then lib/.
 */
const CORE_SCRIPTS = [
  // Top-level audit scripts
  'scripts/openai-audit.mjs',
  'scripts/gemini-review.mjs',
  'scripts/bandit.mjs',
  'scripts/learning-store.mjs',
  'scripts/phase7-check.mjs',
  'scripts/shared.mjs',
  'scripts/check-sync.mjs',
  'scripts/check-setup.mjs',
  // lib/ core modules
  'scripts/lib/schemas.mjs',
  'scripts/lib/file-io.mjs',
  'scripts/lib/ledger.mjs',
  'scripts/lib/code-analysis.mjs',
  'scripts/lib/context.mjs',
  'scripts/lib/findings.mjs',
  'scripts/lib/config.mjs',
  'scripts/lib/llm-auditor.mjs',
  'scripts/lib/llm-wrappers.mjs',
  'scripts/lib/language-profiles.mjs',
  'scripts/lib/rng.mjs',
  'scripts/lib/robustness.mjs',
  'scripts/lib/sanitizer.mjs',
  'scripts/lib/secret-patterns.mjs',
  'scripts/lib/suppression-policy.mjs',
  'scripts/lib/backfill-parser.mjs',
  'scripts/lib/owner-resolver.mjs',
  'scripts/lib/rule-metadata.mjs',
  'scripts/lib/file-store.mjs',
];

/**
 * Learning + prompt-refinement scripts (full suite only).
 */
const LEARNING_SCRIPTS = [
  'scripts/refine-prompts.mjs',
  'scripts/evolve-prompts.mjs',
  'scripts/meta-assess.mjs',
  'scripts/lib/prompt-registry.mjs',
  'scripts/lib/prompt-seeds.mjs',
  'scripts/lib/linter.mjs',
];

/**
 * Debt-tracking scripts (full suite only).
 */
const DEBT_SCRIPTS = [
  'scripts/debt-auto-capture.mjs',
  'scripts/debt-backfill.mjs',
  'scripts/debt-budget-check.mjs',
  'scripts/debt-pr-comment.mjs',
  'scripts/debt-resolve.mjs',
  'scripts/debt-review.mjs',
  'scripts/lib/debt-capture.mjs',
  'scripts/lib/debt-events.mjs',
  'scripts/lib/debt-git-history.mjs',
  'scripts/lib/debt-ledger.mjs',
  'scripts/lib/debt-memory.mjs',
  'scripts/lib/debt-review-helpers.mjs',
];

/** SKILL.md files installed to both Claude Code (.claude/) and GitHub Copilot (.github/) */
const SKILL_FILES = [
  '.claude/skills/audit-loop/SKILL.md',
  '.github/skills/audit-loop/SKILL.md',
  '.claude/skills/persona-test/SKILL.md',
  '.github/skills/persona-test/SKILL.md',
];

/** Editor config files — MCP server wiring for VSCode Copilot Chat */
const EDITOR_FILES = [
  '.vscode/mcp.json',
];

// ── Repo configuration ─────────────────────────────────────────────────────

const REPOS = [
  {
    name: 'wine-cellar-app',
    alias: 'wine',
    path: path.resolve(SOURCE_ROOT, '../wine-cellar-app'),
    files: [...CORE_SCRIPTS, ...LEARNING_SCRIPTS, ...DEBT_SCRIPTS, ...SKILL_FILES, ...EDITOR_FILES],
  },
  {
    name: 'ai-organiser',
    alias: 'ai',
    path: path.resolve(SOURCE_ROOT, '../ai-organiser'),
    // Full suite — ai-organiser was bootstrapped minimally (only openai-audit.mjs)
    // Sync full core + learning so audits actually work (lib/ deps were missing).
    files: [...CORE_SCRIPTS, ...LEARNING_SCRIPTS, ...SKILL_FILES, ...EDITOR_FILES],
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

function unifiedDiff(srcPath, dstPath, relFile) {
  try {
    // Use git diff --no-index for a proper unified diff
    const result = execSync(
      `git diff --no-index --unified=3 "${dstPath}" "${srcPath}"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result;
  } catch (err) {
    // git diff --no-index exits 1 when files differ (that's normal)
    if (err.stdout) return err.stdout;
    return `  (diff unavailable: ${err.message})`;
  }
}

// ── Helpers (continued) ───────────────────────────────────────────────────

/**
 * Deep merge two plain objects. Source keys overwrite target keys at every
 * level. Arrays are replaced (not concatenated). Non-object values use source.
 * Used to safely sync JSON config files without destroying local additions.
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)
        && typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

let totalNew = 0;
let totalUpdated = 0;
let totalUnchanged = 0;
let totalErrors = 0;

const targetRepos = targetFilter
  ? REPOS.filter(r => r.name === targetFilter || r.alias === targetFilter)
  : REPOS;

if (targetFilter && targetRepos.length === 0) {
  console.error(`${R}Unknown target: "${targetFilter}"${X}`);
  const knownTargets = REPOS.map(r => r.name + ' (' + r.alias + ')').join(', ');
  console.error(`  Known: ${knownTargets}`);
  process.exit(1);
}

const dryRunSuffix = DRY_RUN ? ' ' + Y + '[DRY RUN]' + X : '';
console.log(B + 'Audit-Loop Sync' + X + dryRunSuffix);
console.log(`  Source: ${SOURCE_ROOT}`);
console.log('');

for (const repo of targetRepos) {
  if (!fs.existsSync(repo.path)) {
    console.log(`${Y}Skipping ${repo.name}${X}: directory not found at ${repo.path}`);
    console.log('');
    continue;
  }

  let repoNew = 0, repoUpdated = 0, repoUnchanged = 0, repoErrors = 0;

  console.log(`${B}→ ${repo.name}${X} (${repo.path})`);

  for (const relFile of repo.files) {
    const srcPath = path.join(SOURCE_ROOT, relFile);
    const dstPath = path.join(repo.path, relFile);

    // Source must exist
    if (!fs.existsSync(srcPath)) {
      console.log(`  ${Y}skip${X}  ${relFile} ${D}(not in source)${X}`);
      continue;
    }

    const srcSha = sha256(srcPath);
    const dstSha = sha256(dstPath);

    if (srcSha === dstSha) {
      repoUnchanged++;
      totalUnchanged++;
      // Quiet for unchanged — only show in verbose mode
      continue;
    }

    const isNew = dstSha === null;
    const label = isNew ? `${G}new${X}  ` : `${Y}upd${X}  `;

    console.log(`  ${label} ${relFile}`);

    if (DRY_RUN && !isNew) {
      const diff = unifiedDiff(srcPath, dstPath, relFile);
      // Show at most 40 lines of diff to keep output manageable
      const lines = diff.split('\n');
      const preview = lines.slice(0, 40).join('\n');
      const truncated = lines.length > 40;
      // Indent each diff line
      console.log(preview.split('\n').map(l => '    ' + l).join('\n'));
      if (truncated) console.log(`    ${D}... ${lines.length - 40} more lines${X}`);
    }

    if (!DRY_RUN) {
      try {
        // Ensure parent directory exists
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        // JSON config files: merge instead of overwrite to preserve local customizations
        if (relFile.endsWith('.json') && !isNew) {
          const src = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
          const dst = JSON.parse(fs.readFileSync(dstPath, 'utf-8'));
          // Deep merge: source keys take precedence within shared objects (e.g. servers/mcpServers)
          const merged = deepMerge(dst, src);
          fs.writeFileSync(dstPath, JSON.stringify(merged, null, 2) + '\n');
        } else {
          fs.copyFileSync(srcPath, dstPath);
        }
      } catch (err) {
        console.log(`  ${R}ERR${X}  ${relFile}: ${err.message}`);
        repoErrors++;
        totalErrors++;
        continue;
      }
    }

    if (isNew) { repoNew++; totalNew++; }
    else { repoUpdated++; totalUpdated++; }
  }

  const parts = [];
  if (repoNew > 0) parts.push(`${G}+${repoNew} new${X}`);
  if (repoUpdated > 0) parts.push(`${Y}~${repoUpdated} updated${X}`);
  if (repoUnchanged > 0) parts.push(`${D}${repoUnchanged} unchanged${X}`);
  if (repoErrors > 0) parts.push(`${R}${repoErrors} errors${X}`);
  console.log(`  ${parts.join('  ')}`);

  // Post-sync setup check — skip in dry-run (nothing was written)
  if (!DRY_RUN) {
    try {
      execSync(
        `node "${path.join(SOURCE_ROOT, 'scripts/check-setup.mjs')}" --repo-path "${repo.path}"`,
        { stdio: 'inherit', timeout: 30000 }
      );
    } catch {
      // check-setup exits 1 on failures — already printed the report, just continue
    }
  }
  console.log('');
}

// Summary
console.log('─'.repeat(40));
if (DRY_RUN) {
  console.log(`${Y}DRY RUN complete${X} — no files written`);
  console.log(`  Would create: ${totalNew}  update: ${totalUpdated}  unchanged: ${totalUnchanged}`);
  if (totalNew + totalUpdated > 0) {
    console.log(`\nRun without --dry-run to apply.`);
  }
} else {
  if (totalErrors > 0) {
    console.log(`${R}Sync completed with errors${X}`);
  } else {
    console.log(`${G}Sync complete${X}`);
  }
  console.log(`  Created: ${totalNew}  Updated: ${totalUpdated}  Unchanged: ${totalUnchanged}  Errors: ${totalErrors}`);
}

process.exit(totalErrors > 0 ? 1 : 0);
