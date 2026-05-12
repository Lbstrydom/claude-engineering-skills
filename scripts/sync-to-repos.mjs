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
import { enumerateSkillFiles, listSkillNames } from './lib/skill-packaging.mjs';
import { ensureAuditDeps } from './lib/install/deps.mjs';
import { CONSUMER_REPOS } from './lib/consumer-repos.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const KEEP_GITHUB_SKILLS = process.argv.includes('--keep-github-skills');
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
  'scripts/cross-skill.mjs',
  'scripts/phase7-check.mjs',
  'scripts/shared.mjs',
  'scripts/check-sync.mjs',
  'scripts/check-setup.mjs',
  'scripts/cache-hitrate-check.mjs',
  // lib/ core modules
  'scripts/lib/schemas.mjs',
  'scripts/lib/file-io.mjs',
  'scripts/lib/ledger.mjs',
  'scripts/lib/code-analysis.mjs',
  'scripts/lib/context.mjs',
  'scripts/lib/findings.mjs',
  'scripts/lib/findings-format.mjs',
  'scripts/lib/findings-tracker.mjs',
  'scripts/lib/findings-outcomes.mjs',
  'scripts/lib/findings-tasks.mjs',
  'scripts/lib/outcome-sync.mjs',
  'scripts/lib/config.mjs',
  'scripts/lib/model-resolver.mjs',
  'scripts/lib/llm-auditor.mjs',
  'scripts/lib/llm-wrappers.mjs',
  'scripts/lib/language-profiles.mjs',
  'scripts/lib/rng.mjs',
  'scripts/lib/audit-scope.mjs',
  'scripts/lib/diff-annotation.mjs',
  'scripts/lib/plan-paths.mjs',
  'scripts/lib/plan-fp-tracker.mjs',
  'scripts/lib/predictive-strategy.mjs',
  'scripts/lib/robustness.mjs',
  'scripts/lib/sanitizer.mjs',
  'scripts/lib/repo-stack.mjs',
  'scripts/lib/secret-patterns.mjs',
  'scripts/lib/suppression-policy.mjs',
  'scripts/lib/backfill-parser.mjs',
  'scripts/lib/owner-resolver.mjs',
  'scripts/lib/rule-metadata.mjs',
  'scripts/lib/file-store.mjs',
  // Brainstorm helper (concept-level multi-LLM rounds — see /brainstorm)
  'scripts/brainstorm-round.mjs',
  'scripts/lib/brainstorm/prompt.mjs',
  'scripts/lib/brainstorm/schemas.mjs',
  'scripts/lib/brainstorm/pricing.mjs',
  'scripts/lib/brainstorm/openai-adapter.mjs',
  'scripts/lib/brainstorm/gemini-adapter.mjs',
  // Brainstorm v1.x extensions (debate / depth / continue-from / save / session-store)
  'scripts/lib/brainstorm/depth-config.mjs',
  'scripts/lib/brainstorm/provider-limits.mjs',
  'scripts/lib/brainstorm/file-lock.mjs',
  'scripts/lib/brainstorm/session-store.mjs',
  'scripts/lib/brainstorm/insight-store.mjs',
  'scripts/lib/brainstorm/resume-context.mjs',
  'scripts/lib/brainstorm/debate-prompt.mjs',
  'scripts/lib/brainstorm/id-validator.mjs',
  // Quickfix detection — prospective hook + retrospective audit pass
  'scripts/lib/quickfix-patterns.mjs',
  '.claude/hooks/quickfix-scan.mjs',
  // /explain --history aggregator (cross-source "did we already solve this?")
  'scripts/explain-history.mjs',
  // /skills quick-reference helper (reads SKILL.md frontmatter)
  'scripts/skills-help.mjs',
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
 * Architectural-memory scripts (per docs/plans/architectural-memory.md).
 * Adds: ts-morph symbol extraction, dep-cruiser layering graph, Haiku
 * purpose summaries, Gemini embeddings, snapshot-isolated refresh,
 * weekly drift sweep + retention prune. Required for /plan-* skills'
 * "Neighbourhood considered" callout and /audit-code --scope=full
 * symbol catalogue. Cloud-off path is graceful (skills emit a hint
 * without failing).
 *
 * Consumer needs: `dependency-cruiser` + `ts-morph` devDependencies,
 * SUPABASE_AUDIT_SERVICE_ROLE_KEY in .env, and one `npm run arch:refresh:full`
 * to populate. See architectural-memory plan §8 Adoption.
 */
const ARCH_MEMORY_SCRIPTS = [
  'scripts/lib/symbol-index.mjs',
  'scripts/lib/symbol-index-contracts.mjs',
  'scripts/lib/repo-identity.mjs',
  'scripts/lib/sensitive-egress-gate.mjs',
  'scripts/lib/neighbourhood-query.mjs',
  'scripts/lib/arch-render.mjs',
  'scripts/symbol-index/extract.mjs',
  'scripts/symbol-index/summarise.mjs',
  'scripts/symbol-index/embed.mjs',
  'scripts/symbol-index/refresh.mjs',
  'scripts/symbol-index/render-mermaid.mjs',
  'scripts/symbol-index/drift.mjs',
  'scripts/symbol-index/duplicates.mjs',
  'scripts/symbol-index/prune.mjs',
  'scripts/symbol-index/spike-extract.mjs',
  'scripts/symbol-index/summarise-domains.mjs',
  // Domain tagger — path-based mapping into .audit-loop/domain-map.json,
  // wired into refresh.mjs to populate domainTag instead of leaving null.
  'scripts/lib/symbol-index/domain-tagger.mjs',
  // Audit prompt-builder — SSoT for the cache-stable 3-message structure
  // used by all audit-pass calls in openai-audit.mjs.  Required by the
  // call-site migration; without this file, audit calls throw on import.
  'scripts/lib/audit/prompt-builder.mjs',
  // Architecture-intent framework (PR-A 2026-05-11).  Whole subtree synced
  // explicitly here; add new files under scripts/lib/arch-intent/ to this
  // list as they're created.  See domain.architecture-intent in the plan.
  'scripts/lib/arch-intent/errors.mjs',
  'scripts/lib/arch-intent/domain-resolver.mjs',
  'scripts/lib/arch-intent/semantic-validator.mjs',
  'scripts/lib/arch-intent/load-config.mjs',
  'scripts/lib/arch-intent/intent-doc-parser.mjs',
  'scripts/lib/arch-intent/adapter-contract.mjs',
  'scripts/lib/arch-intent/adapters/js-ts.mjs',
  'scripts/arch-intent-bootstrap.mjs',
  // Dead-code phase 1 (2026-05-12, commit 6c6be92) — orphan-introduced pass.
  // openai-audit.mjs imports all 5 of these at module-init; if any is
  // missing the consumer-side audit-loop crashes with ERR_MODULE_NOT_FOUND
  // (hit wine-cellar-app PR 39 + 55 + 56 because sync allowlist forgot them).
  'scripts/lib/audit/orphan-introduced.mjs',
  'scripts/lib/audit/diff-scope-resolver.mjs',
  'scripts/lib/audit/findings-pipeline.mjs',
  'scripts/lib/audit/orphan-metrics.mjs',
  'scripts/lib/audit/glob-match.mjs',
  // findings-pipeline.mjs imports parseAcceptV1Markers from this file.
  // Pre-existing in claude-engineering-skills (learning system phase 1) but
  // never added to the sync allowlist — exposed by phase-1 dead-code import.
  'scripts/lib/audit/deferral-classifier.mjs',
  // Adaptive-learning runtime — required by openai-audit.mjs (decision-logger
  // is a top-level import at line 63), cross-skill.mjs (lazy-loads
  // quickfix-stats), and the audit pipeline's quickfix telemetry path.
  // Missing these files caused ERR_MODULE_NOT_FOUND on consumer-repo audit
  // runs after the prompt-cache deploy exposed the pre-existing sync gap.
  'scripts/lib/learning/decision-logger.mjs',
  'scripts/lib/learning/quickfix-stats.mjs',
  'scripts/lib/learning/beta-posterior.mjs',
  'scripts/lib/learning/cold-start.mjs',
  'scripts/lib/learning/replay.mjs',
  // Security memory v1 — incident-log-driven proactive memory.
  // Markdown SoT in consumer's docs/security-strategy.md (consumer-owned,
  // committed by user). These scripts are the synced runtime.
  'scripts/security-memory/parse-strategy.mjs',
  'scripts/security-memory/incident-status.mjs',
  'scripts/security-memory/refresh-incidents.mjs',
];

/**
 * Debt-tracking scripts (full suite only).
 */
const DEBT_SCRIPTS = [
  'scripts/setup-permissions.mjs',
  'scripts/write-plan-outcomes.mjs',
  'scripts/write-ledger-r1.mjs',
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

/**
 * Skill files synced to Claude Code (.claude/skills/). Phase B.2: replaced
 * the hardcoded SKILL.md list with allowlist-based enumeration — new skills
 * + references/ + examples/ auto-register without editing this file.
 *
 * Phase 4 of ai-context-sync: dropped the .github/skills/ surface from the
 * default since no documented tool reads it. Pass --keep-github-skills to
 * keep mirroring during the deprecation window (one minor release).
 */
function buildSkillFiles() {
  const out = [];
  const skillsDir = path.join(SOURCE_ROOT, 'skills');
  for (const name of listSkillNames(skillsDir)) {
    const skillDir = path.join(skillsDir, name);
    const files = enumerateSkillFiles(skillDir, { strict: true });
    for (const rel of files) {
      out.push(`.claude/skills/${name}/${rel}`);
      if (KEEP_GITHUB_SKILLS) out.push(`.github/skills/${name}/${rel}`);
    }
  }
  return out;
}
const SKILL_FILES = buildSkillFiles();

if (!KEEP_GITHUB_SKILLS) {
  process.stderr.write(
    '[sync] DEPRECATION: .github/skills/ surface is no longer mirrored to consumer repos.\n' +
    '  Pass --keep-github-skills to preserve mirroring during the deprecation window.\n' +
    '  Existing .github/skills/ directories in consumer repos are NOT deleted by this sync.\n'
  );
}

/** Editor config files — MCP server wiring for VSCode Copilot Chat */
const EDITOR_FILES = [
  '.vscode/mcp.json',
];

/**
 * Claude Code project hooks + settings. The arch-memory-check hook
 * auto-fires the architectural-memory pre-fix consultation on every
 * UserPromptSubmit when an intent verb is detected. Settings are
 * deep-merged into the consumer's existing .claude/settings.json (so
 * local permissions/dirs are preserved) — only the `hooks` key is
 * added/updated.
 */
const CLAUDE_CODE_FILES = [
  '.claude/hooks/arch-memory-check.sh',
  '.claude/settings.json',
];

/**
 * Copilot prompt-file shims — generated by `npm run skills:regenerate` from
 * each skill's SKILL.md frontmatter + the registry in
 * `scripts/lib/install/copilot-prompts.mjs`. Phase 3 of ai-context-sync.
 */
function buildCopilotPromptFiles() {
  const out = [];
  const promptsDir = path.join(SOURCE_ROOT, '.github', 'prompts');
  if (!fs.existsSync(promptsDir)) return out;
  for (const f of fs.readdirSync(promptsDir)) {
    if (f.endsWith('.prompt.md')) out.push(`.github/prompts/${f}`);
  }
  return out;
}
const COPILOT_PROMPT_FILES = buildCopilotPromptFiles();

// ── Repo configuration ─────────────────────────────────────────────────────

// Per-repo file sets — kept here because they're sync-specific (the file
// lists differ per repo).  The repo identity (name/alias/path) lives in
// scripts/lib/consumer-repos.mjs as the single source of truth.
const REPO_FILE_SETS = {
  'wine-cellar-app': [...CORE_SCRIPTS, ...LEARNING_SCRIPTS, ...DEBT_SCRIPTS, ...ARCH_MEMORY_SCRIPTS, ...SKILL_FILES, ...COPILOT_PROMPT_FILES, ...EDITOR_FILES, ...CLAUDE_CODE_FILES],
  // Full suite — ai-organiser was bootstrapped minimally (only openai-audit.mjs)
  // Sync full core + learning + architectural-memory so audits + plan
  // skills work end-to-end (lib/ deps were missing in initial bootstrap).
  'ai-organiser':    [...CORE_SCRIPTS, ...LEARNING_SCRIPTS, ...ARCH_MEMORY_SCRIPTS, ...SKILL_FILES, ...COPILOT_PROMPT_FILES, ...EDITOR_FILES, ...CLAUDE_CODE_FILES],
};

export const REPOS = CONSUMER_REPOS.map(r => ({
  ...r,
  files: REPO_FILE_SETS[r.name] || [],
}));

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

  // Post-sync: ensure audit-loop npm deps are installed. Idempotent — no-op
  // when the target already has everything. Without this step, sync can keep
  // skill + script files current forever while the scripts silently fail to
  // import at runtime because devDeps were never installed.
  if (!DRY_RUN) {
    try {
      ensureAuditDeps(repo.path, { dryRun: false, quiet: false });
    } catch (err) {
      console.log(`  ${R}deps check failed${X}: ${err.message?.slice(0, 120)}`);
    }
  }

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
