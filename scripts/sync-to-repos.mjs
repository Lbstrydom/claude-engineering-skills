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
import { writeManifest } from './lib/sync-manifest.mjs';
import { collectImportClosure } from './lib/module-graph.mjs';

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
//
// The audit-loop deployment is NOT a hand-maintained file list. Each bundle
// declares only its ENTRY POINTS — scripts invoked directly (CLIs, hooks)
// plus the few modules reached solely via a *computed* dynamic import, which
// static analysis cannot follow. Every lib/* dependency is auto-resolved by
// walking the ESM import graph (see resolveBundle / collectImportClosure).
//
// Why: a new lib module imported by a synced script used to need a manual
// CORE_SCRIPTS entry, or the consumer repo broke at runtime with
// ERR_MODULE_NOT_FOUND. The walker eliminates that drift — the first static
// or string-literal `import` of a module pulls it into every bundle that
// reaches it, with no edit here.
//
// ASSETS are non-importable leaves (read via fs, or generated): they carry
// no import edges, so the walker cannot discover them — listed explicitly.

/**
 * Core audit-runtime entry points — directly-invoked scripts + the quickfix
 * hook. Their transitive import closure is the shared core every consumer
 * repo needs.
 */
const CORE_ENTRY = [
  'scripts/openai-audit.mjs',
  'scripts/gemini-review.mjs',
  'scripts/bandit.mjs',
  'scripts/learning-store.mjs',
  'scripts/cross-skill.mjs',
  'scripts/phase7-check.mjs',
  'scripts/shared.mjs',
  'scripts/check-sync.mjs',
  'scripts/check-setup.mjs',
  'scripts/check-audit-tool-version.mjs',
  'scripts/cache-hitrate-check.mjs',
  'scripts/brainstorm-round.mjs',
  'scripts/explain-history.mjs',
  'scripts/skills-help.mjs',
  'scripts/requirements.mjs',
  'scripts/audit-metrics.mjs',
  'scripts/write-code-outcomes.mjs',
  'scripts/build-dashboard.mjs',
  '.claude/hooks/quickfix-scan.mjs',
];

/**
 * Non-importable core assets — read via fs or generated, never `import`ed,
 * so the import-graph walker cannot reach them.
 */
const CORE_ASSETS = [
  // Regenerated at the start of every `npm run sync` (see writeManifest);
  // consumer repos read it to detect stale audit-tool files vs upstream.
  'scripts/.sync-manifest.json',
  // fs-read by lib/dashboard/collect-reference.mjs (flows.json) and
  // lib/dashboard/load-assets.mjs (css/js) — never imported.
  'scripts/lib/dashboard/flows.json',
  'scripts/lib/dashboard/assets/dashboard.css',
  'scripts/lib/dashboard/assets/dashboard.js',
];

/**
 * Learning + prompt-refinement entry points (full suite only).
 */
const LEARNING_ENTRY = [
  'scripts/refine-prompts.mjs',
  'scripts/evolve-prompts.mjs',
  'scripts/meta-assess.mjs',
];

/**
 * Architectural-memory entry points (per docs/completed/architectural-memory.md):
 * ts-morph symbol extraction, dep-cruiser layering, Haiku summaries, Gemini
 * embeddings, drift sweep, retention prune, plus security-incident memory.
 *
 * Consumer needs: `dependency-cruiser` + `ts-morph` devDependencies,
 * SUPABASE_AUDIT_SERVICE_ROLE_KEY in .env, and one `npm run arch:refresh:full`
 * to populate. See the architectural-memory plan §8 Adoption.
 */
const ARCH_ENTRY = [
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
  'scripts/arch-intent-bootstrap.mjs',
  'scripts/security-memory/parse-strategy.mjs',
  'scripts/security-memory/incident-status.mjs',
  'scripts/security-memory/refresh-incidents.mjs',
  // arch-intent language adapters are loaded via `import(`./adapters/${k}.mjs`)`
  // in adapter-contract.mjs — a computed specifier the import-graph walker
  // cannot follow, so each adapter seeds the closure as its own entry point
  // (its transitive deps are then walked normally).
  'scripts/lib/arch-intent/adapters/js-ts.mjs',
  'scripts/lib/arch-intent/adapters/java.mjs',
  'scripts/lib/arch-intent/adapters/python.mjs',
  'scripts/lib/arch-intent/adapters/postgres.mjs',
];

/**
 * Debt-tracking entry points (full suite only).
 */
const DEBT_ENTRY = [
  'scripts/setup-permissions.mjs',
  'scripts/write-plan-outcomes.mjs',
  'scripts/write-ledger-r1.mjs',
  'scripts/debt-auto-capture.mjs',
  'scripts/debt-backfill.mjs',
  'scripts/debt-budget-check.mjs',
  'scripts/debt-pr-comment.mjs',
  'scripts/debt-resolve.mjs',
  'scripts/debt-review.mjs',
];

// ── Import-graph resolution ────────────────────────────────────────────────

/**
 * Build the repo-relative path universe under scripts/ and .claude/ — the
 * file set `resolveSpecifier` probes for extension/index resolution.
 * @param {string} root
 * @returns {Set<string>}
 */
function buildFileUniverse(root) {
  const out = new Set();
  const SKIP = new Set(['node_modules', '.git', '.audit', '.audit-loop']);
  const walk = (dir, base) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else out.add(rel);
    }
  };
  for (const top of ['scripts', '.claude']) {
    const dir = path.join(root, top);
    if (fs.existsSync(dir)) walk(dir, top);
  }
  return out;
}

const FILE_UNIVERSE = buildFileUniverse(SOURCE_ROOT);
const readSource = (rel) => {
  try { return fs.readFileSync(path.join(SOURCE_ROOT, rel), 'utf-8'); }
  catch { return null; }
};

/**
 * Resolve a bundle to its full file list: the transitive import closure of
 * its entry points, plus its non-importable assets.
 * @param {string[]} entryPoints
 * @param {string[]} [assets]
 * @returns {{files: string[], unresolved: Array<{from:string,specifier:string}>}}
 */
function resolveBundle(entryPoints, assets = []) {
  const { files, unresolved } = collectImportClosure({
    entryPoints, repoFiles: FILE_UNIVERSE, readFile: readSource,
  });
  return { files: [...new Set([...files, ...assets])], unresolved };
}

/**
 * `unresolved` entries worth surfacing — a path-like specifier that didn't
 * resolve to a repo file is a genuinely missing dependency. Specifiers
 * carrying `${`, backticks or whitespace are template-literal parser noise
 * (a regex catching a string fragment of source) and are filtered out.
 * @param {Array<{from:string,specifier:string}>} unresolved
 * @returns {Array<{from:string,specifier:string}>}
 */
function realMissingDeps(unresolved) {
  return (unresolved || []).filter(u =>
    !/[\s`${}]/.test(u.specifier)
    && (u.specifier.startsWith('./') || u.specifier.startsWith('../'))
  );
}

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

// Non-code surfaces — skills, Copilot prompt shims, editor + Claude Code
// config. Not importable, so appended after the import-graph closure.
const NON_CODE_FILES = [
  ...SKILL_FILES, ...COPILOT_PROMPT_FILES, ...EDITOR_FILES, ...CLAUDE_CODE_FILES,
];

/**
 * Compute the synced file list for one consumer repo: the import-graph
 * closure of its entry-point bundles + core assets + non-code surfaces.
 * wine-cellar-app gets the debt suite; ai-organiser does not.
 *
 * Repo identity (name/alias/path) lives in lib/consumer-repos.mjs as the
 * single source of truth — only the file-set composition is sync-specific.
 *
 * @param {string} repoName
 * @returns {{files: string[], unresolved: Array<{from:string,specifier:string}>}}
 */
function bundleForRepo(repoName) {
  const entries = [
    ...CORE_ENTRY, ...LEARNING_ENTRY, ...ARCH_ENTRY,
    ...(repoName === 'wine-cellar-app' ? DEBT_ENTRY : []),
  ];
  const { files, unresolved } = resolveBundle(entries, CORE_ASSETS);
  return { files: [...files, ...NON_CODE_FILES], unresolved };
}

export const REPOS = CONSUMER_REPOS.map(r => {
  const { files, unresolved } = bundleForRepo(r.name);
  return { ...r, files, unresolved };
});

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

// Regenerate the sync manifest BEFORE copying — its hash content needs to
// reflect what we're about to ship to consumers.  The manifest is itself
// in CORE_ASSETS so it gets included in the file copy below.
if (!DRY_RUN) {
  // Version-contract files = the core + arch import closure. These are the
  // files consumers must keep in lockstep. Other bundles (learning/debt)
  // are optional per-repo additions and not part of the version contract.
  const { files: manifestFiles } = resolveBundle(
    [...CORE_ENTRY, ...ARCH_ENTRY], CORE_ASSETS,
  );
  const { manifest } = writeManifest(SOURCE_ROOT, manifestFiles, {
    repo: 'Lbstrydom/claude-engineering-skills',
  });
  console.log(`  ${G}manifest${X}  scripts/.sync-manifest.json @ ${manifest.commitSha?.slice(0, 7) || '?'} (${Object.keys(manifest.files).length} files)`);
  console.log('');
}

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

  // Surface genuinely-unresolved imports — a path-like specifier the graph
  // walker could not resolve is a real missing dependency that would crash
  // the consumer repo at runtime. Non-fatal (it may be a deliberate
  // optional-dep guard), but loud so it doesn't go unnoticed.
  const missing = realMissingDeps(repo.unresolved);
  if (missing.length) {
    console.log(`  ${Y}⚠ ${missing.length} unresolved import(s)${X} ${D}— possible missing dependency:${X}`);
    for (const m of missing.slice(0, 8)) {
      console.log(`    ${D}${m.from} → ${m.specifier}${X}`);
    }
  }

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
