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
import { assertRepoRoot } from './lib/assert-repo-root.mjs';
import { sourceRelToDestRel, LAYOUT_CONSTANTS } from './lib/sync-path-map.mjs';
import { rewriteCommandSurface, buildOwnedSourceTails } from './lib/sync-rewriter.mjs';
import { injectUpstreamBanner } from './lib/sync-banner.mjs';
import { updateManagedBlock, parseGitignoreState } from './lib/sync-gitignore.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const KEEP_GITHUB_SKILLS = process.argv.includes('--keep-github-skills');
const NO_PROMPT = process.argv.includes('--no-prompt');
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
  // One-shot fit-check diagnostic — labels each skill FITS/PARTIAL/MISMATCH
  // for the consumer's repo shape. Auto-fires once after first sync (see
  // post-sync hook); re-runnable any time as `npm run skills:fit-check`.
  // Walker pulls in the lib/fit-check/ closure automatically.
  'scripts/skills-fit-check.mjs',
  'scripts/requirements.mjs',
  'scripts/audit-metrics.mjs',
  'scripts/write-code-outcomes.mjs',
  'scripts/build-dashboard.mjs',
  // postgres-parity M4 — setup CLI ships to consumer repos so downstream
  // users can apply the schema to their own DB without cloning this repo.
  // Walker pulls in the lib/db/ closure (client.mjs / query.mjs / rpc.mjs /
  // errors.mjs) automatically.
  'scripts/setup-postgres.mjs',
  // Companion diagnostic — list public tables without RLS enabled. Useful
  // for consumer repos to audit their Supabase project's exposure after a
  // migration. Same lib/db/ closure as setup-postgres.mjs.
  'scripts/check-rls.mjs',
  '.claude/hooks/quickfix-scan.mjs',
  // Persona-test consistency mode CLIs (docs/plans/persona-test-consistency-mode.md).
  // Both are user-invoked CLIs; the import-graph walker pulls in their
  // transitive lib closure (scripts/lib/persona-test/* + scripts/lib/ux-lock/*)
  // automatically.
  'scripts/persona-consistency-run.mjs',
  'scripts/persona-consistency-promote.mjs',
  // Consumer-invoked CLI: builds a consumer's .persona-test/surfaces.json from
  // colocated *.persona-test.json fragments, validated against our
  // SurfaceManifestSchema. Lives upstream so every consumer shares one merge +
  // collision-detection + validation impl; the walker pulls in its
  // lib/persona-test/schemas.mjs import automatically.
  'scripts/build-surfaces-manifest.mjs',
  // Reached only via `await import('./lib/redact.mjs')` in cross-skill.mjs
  // + learning-store.mjs (dynamic specifier — walker cannot follow).
  // Required at runtime for candidate-write redaction.
  'scripts/lib/redact.mjs',
  // Documented injection point — consumers wire their preferred provider
  // adapter at runtime; no static caller in this repo so the walker
  // doesn't pull it in. Ship explicitly.
  'scripts/lib/persona-test/semantic-compare.mjs',
  // CLI-invoked from skills/persona-test/SKILL.md Phase 1a and
  // skills/click-test/SKILL.md Phase 3 as `node scripts/lib/device-presets.mjs
  // prep|prep-matrix ...` — bash-shelled, not statically imported, so the
  // walker cannot reach it. Required at runtime for device-profile
  // emulation (the contracts both SKILL.mds tell the LLM to consume verbatim).
  'scripts/lib/device-presets.mjs',
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
  // Authoritative HTML-attribute contract for persona-test consistency mode.
  // Referenced by skills/persona-test/SKILL.md Phase 3b + references/consistency-mode.md;
  // consumer-app frontend devs read it to author their data-engine-* annotations.
  'docs/consistency-contract.md',
  // postgres-parity M4 — setup-postgres.mjs reads compat-bootstrap.sql via
  // fs (the import-graph walker can't follow fs reads). Migrations are
  // similarly fs-read; ship the whole directory so `--migrate` works on
  // consumer repos without them needing this repo cloned.
  'scripts/lib/db/compat-bootstrap.sql',
  ...syncMigrations(),
];

/**
 * Enumerate `supabase/migrations/*.sql` at sync time so newly-added
 * migrations ship to consumer repos automatically. Returns an empty
 * array if the directory doesn't exist (graceful — running in a
 * non-canonical repo).
 *
 * Important — destination path is `.audit-loop/migrations/<f>` in the
 * consumer repo, NOT `supabase/migrations/<f>`. This isolates audit-loop
 * infrastructure migrations from any consumer-app Supabase product
 * migrations: a careless `supabase db push` from the consumer won't pick
 * them up and apply them against the wrong Supabase project (see
 * `reference_supabase_project.md` — audit-loop uses a dedicated project).
 * The src path remap is handled by the sync loop (search for
 * `.audit-loop/migrations` in the loop body).
 */
function syncMigrations() {
  const dir = path.join(SOURCE_ROOT, 'supabase', 'migrations');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => `supabase/migrations/${f}`);
  } catch {
    return [];
  }
}

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
 * Sync-isolation infrastructure (Phase 1 of the scripts/.claude-skills/
 * isolation work). These modules ship to consumers so the verifier and
 * migration helper exist at the post-hydration path. Without this, the
 * consumer can't run `sync-isolation-verify` or `remove-legacy-synced`.
 */
const SYNC_ISOLATION_ENTRY = [
  'scripts/lib/sync-path-map.mjs',
  'scripts/lib/sync-rewriter.mjs',
  'scripts/lib/sync-gitignore.mjs',
  // NOTE: sync-inventory.mjs intentionally OMITTED — it imports
  // consumer-repos.mjs which uses `path.resolve(import.meta.dirname, '..', '..')`
  // to find the source repo's parent directory. That's source-only logic
  // (consumers don't have ai-organiser as a sibling). The verifier's
  // --selfcheck-inventory mode is source-side only and never runs on the
  // consumer; the runtime gates use buildOwnedSourceTailsFromConsumerManifest
  // from sync-rewriter.mjs to derive ownership without source-side state.
  'scripts/lib/sync-isolation-verify.mjs',
  'scripts/lib/npm-script-enumerator.mjs',
  'scripts/lib/remove-legacy-synced.mjs',
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
    ...CORE_ENTRY, ...LEARNING_ENTRY, ...ARCH_ENTRY, ...SYNC_ISOLATION_ENTRY,
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

async function main() {
  assertRepoRoot(import.meta.url);

  if (!KEEP_GITHUB_SKILLS) {
    process.stderr.write(
      '[sync] DEPRECATION: .github/skills/ surface is no longer mirrored to consumer repos.\n' +
      '  Pass --keep-github-skills to preserve mirroring during the deprecation window.\n' +
      '  Existing .github/skills/ directories in consumer repos are NOT deleted by this sync.\n'
    );
  }

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
    let repoRemaps = 0, repoRewrites = 0, repoGcDeletions = 0;

    console.log(`${B}→ ${repo.name}${X} (${repo.path})`);

    // ── Pre-flight: ownership-aware preflight + gitignore validation ───────
    // Build ownership set from the source-side inventory. The verifier on the
    // consumer side derives an equivalent set from the manifest; for sync
    // itself we use the source paths directly.
    const ownedSourceTails = buildOwnedSourceTails(repo.files);
    const rewriteConfig = { ownedSourceTails };

    // Read the consumer's prior manifest BEFORE any write. Used for both
    // ownership preflight (collision detection) and GC (deletions).
    const priorManifestPath = path.join(repo.path, LAYOUT_CONSTANTS.MANIFEST_PATH);
    let priorManifest = null;
    try {
      if (fs.existsSync(priorManifestPath)) {
        priorManifest = JSON.parse(fs.readFileSync(priorManifestPath, 'utf-8'));
      }
    } catch { /* corrupt prior manifest — treat as missing */ }
    const priorLayout = priorManifest?.layout || 'legacy';
    const priorFiles = priorManifest?.files || {};

    // Pre-flight #1: gitignore managed-block well-formedness. Abort BEFORE
    // any write if the block is in a malformed state — fail-fast prevents
    // a half-installed tree paired with stale ignores.
    const giPath = path.join(repo.path, '.gitignore');
    let priorGitignore = null;
    try {
      priorGitignore = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf-8') : null;
    } catch { priorGitignore = null; }
    const giPreview = updateManagedBlock(
      priorGitignore,
      [
        LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR + '/',
        // Generated ephemera our synced tooling produces in consumers — ignored
        // so they don't nag as untracked (Category A artifacts; never committed).
        // consumer-deployment-hardening. Precise paths (not blanket dirs) so a
        // consumer's own dashboard/ or logs/ isn't swept.
        'dashboard/index.html',
        'dashboard/telemetry.html',
        '.brainstorm/',
        '.skills-fit-check.json',
        'logs/mcp-*.log',
        'logs/mcp-*.log.gz',
      ],
    );
    if (giPreview.action === 'abort') {
      console.log(`  ${R}ABORT${X}  .gitignore preflight: ${giPreview.error}`);
      totalErrors++;
      console.log('');
      continue;
    }

    // Pre-flight #2: ownership scan. For each destination we intend to write
    // OR delete, ensure no foreign file is at that destination. Foreign =
    // exists on disk AND not present in the prior manifest under any layout
    // (legacy or isolated).
    const intendedWrites = new Map(); // dstRel → srcRel
    for (const srcRel of repo.files) {
      const dstRel = sourceRelToDestRel(srcRel);
      intendedWrites.set(dstRel, srcRel);
    }
    const inProgressJournalPath = path.join(repo.path, LAYOUT_CONSTANTS.IN_PROGRESS_JOURNAL);
    let journalDestinations = new Set();
    if (fs.existsSync(inProgressJournalPath)) {
      try {
        const journal = JSON.parse(fs.readFileSync(inProgressJournalPath, 'utf-8'));
        if (Array.isArray(journal.destinations)) {
          for (const d of journal.destinations) journalDestinations.add(d);
        }
      } catch { /* malformed journal — treat as empty */ }
    }
    const collisions = [];
    const inventoryOwned = []; // non-relocating managed surfaces absent from prior manifest
    for (const [dstRel] of intendedWrites) {
      const dstAbsPath = path.join(repo.path, dstRel);
      if (!fs.existsSync(dstAbsPath)) continue;
      // Layout-aware ownership lookup: check both the destination key
      // (isolated layout) and the source-derived legacy key.
      const ownedAsIsolated = Object.prototype.hasOwnProperty.call(priorFiles, dstRel);
      const ownedAsLegacyMap = priorLayout === 'legacy' &&
        Object.prototype.hasOwnProperty.call(priorFiles, intendedWrites.get(dstRel));
      const ownedByInterruptedRun = journalDestinations.has(dstRel);
      // Inventory-ownership (root fix for incomplete legacy manifests): a file
      // we intend to write whose dest == src (a NON-relocating managed surface
      // — .claude/skills/**, .github/prompts/**, editor configs, the manifest
      // itself) is ours by namespace definition. Older sync versions never
      // recorded these in the manifest, so the prior-manifest test
      // false-positives on the first isolated migration. This is safe: those
      // paths are our exclusive managed namespace, and the two genuinely
      // co-owned configs (.claude/settings.json, .vscode/mcp.json) are written
      // via deepMerge, which preserves consumer keys regardless of this claim.
      // The relocating namespace (scripts/.claude-skills/**, dst != src) is NOT
      // covered — a foreign file there still aborts, preserving real collision
      // protection.
      const ownedByInventoryNonRelocating =
        !ownedAsIsolated && !ownedAsLegacyMap && dstRel === intendedWrites.get(dstRel);
      if (!ownedAsIsolated && !ownedAsLegacyMap && !ownedByInterruptedRun) {
        if (ownedByInventoryNonRelocating) inventoryOwned.push(dstRel);
        else collisions.push(dstRel);
      }
    }
    if (inventoryOwned.length && !DRY_RUN) {
      console.log(`  ${Y}note${X}  ${inventoryOwned.length} managed-surface file(s) not in prior manifest — treating as owned (legacy manifest predates skill/prompt tracking).`);
    }
    if (collisions.length && !DRY_RUN) {
      console.log(`  ${R}ABORT${X}  ${collisions.length} unowned collision(s); will not overwrite.`);
      for (const c of collisions.slice(0, 10)) console.log(`    ${R}collide${X}  ${c}`);
      if (collisions.length > 10) console.log(`    ${D}... ${collisions.length - 10} more${X}`);
      totalErrors++;
      console.log('');
      continue;
    }

    // Pre-flight passed; write the in-progress journal so a crash here on
    // first-migration can be recognised next run.
    if (!DRY_RUN) {
      try {
        atomicWriteFileSync(
          inProgressJournalPath,
          JSON.stringify({
            startedAt: new Date().toISOString(),
            destinations: [...intendedWrites.keys()],
          }, null, 2) + '\n',
        );
      } catch (err) {
        console.log(`  ${Y}journal write failed${X}: ${err.message?.slice(0, 100)}`);
      }
    }

    // ── Per-file writes ────────────────────────────────────────────────────
    for (const srcRel of repo.files) {
      const dstRel = sourceRelToDestRel(srcRel);
      const srcPath = path.join(SOURCE_ROOT, srcRel);
      const dstPath = path.join(repo.path, dstRel);

      if (!fs.existsSync(srcPath)) {
        console.log(`  ${Y}skip${X}  ${srcRel} ${D}(not in source)${X}`);
        continue;
      }

      if (dstRel !== srcRel) repoRemaps++;

      // Read source content; apply ownership-aware command rewriter where
      // applicable. JSON files: merge with existing consumer content first,
      // then rewrite the merged tree. Text files: rewrite directly.
      let srcContent;
      try { srcContent = fs.readFileSync(srcPath, 'utf-8'); }
      catch (err) {
        console.log(`  ${R}ERR${X}  ${srcRel}: read failed: ${err.message?.slice(0, 100)}`);
        repoErrors++; totalErrors++;
        continue;
      }

      let outContent = srcContent;
      const isJson = dstRel.endsWith('.json');
      const dstExists = fs.existsSync(dstPath);

      if (isJson && dstExists) {
        // Existing deepMerge behaviour preserved for JSON; rewriter runs
        // AFTER merge on the final value (plan §2 KD #9 + Gemini v3 G4 fix).
        try {
          const src = JSON.parse(srcContent);
          const dst = JSON.parse(fs.readFileSync(dstPath, 'utf-8'));
          const merged = deepMerge(dst, src);
          outContent = JSON.stringify(merged, null, 2) + '\n';
        } catch (err) {
          console.log(`  ${R}ERR${X}  ${dstRel}: JSON merge failed: ${err.message?.slice(0, 100)}`);
          repoErrors++; totalErrors++;
          continue;
        }
      }

      const rewriteResult = rewriteCommandSurface({
        relPath: dstRel,
        content: outContent,
        config: rewriteConfig,
      });
      outContent = rewriteResult.rewritten;
      if (rewriteResult.changed) repoRewrites++;

      // Inject the "UPSTREAM-OWNED — do not edit" banner into relocated,
      // comment-capable tooling (scripts/.claude-skills/**) so an agent can't
      // open the synced copy to patch it without being told to fix upstream +
      // re-sync (consumer-deployment-hardening). No-op for tracked
      // skills/prompts and JSON. Runs BEFORE the hash so the manifest matches
      // what we write (idempotent — source is banner-free, so re-sync is a
      // no-op "unchanged").
      outContent = injectUpstreamBanner(outContent, dstRel);

      // Compute hashes against final outbound content (so the manifest's
      // hashes match what we actually write).
      const srcHash = crypto.createHash('sha256').update(outContent).digest('hex');
      const dstHash = dstExists
        ? crypto.createHash('sha256').update(fs.readFileSync(dstPath)).digest('hex')
        : null;

      if (srcHash === dstHash) {
        repoUnchanged++; totalUnchanged++;
        continue;
      }

      const isNew = dstHash === null;
      const remappedLabel = dstRel !== srcRel ? ` ${D}(was ${srcRel})${X}` : '';
      const rewriteLabel = rewriteResult.hits ? ` ${D}[${rewriteResult.hits} rewrites]${X}` : '';
      const label = isNew ? `${G}new${X}  ` : `${Y}upd${X}  `;
      console.log(`  ${label} ${dstRel}${remappedLabel}${rewriteLabel}`);

      if (DRY_RUN) {
        if (!isNew) {
          const lines = unifiedDiff(srcPath, dstPath, dstRel).split('\n');
          const preview = lines.slice(0, 40).join('\n');
          const truncated = lines.length > 40;
          console.log(preview.split('\n').map((l) => '    ' + l).join('\n'));
          if (truncated) console.log(`    ${D}... ${lines.length - 40} more lines${X}`);
        }
      } else {
        try {
          fs.mkdirSync(path.dirname(dstPath), { recursive: true });
          atomicWriteFileSync(dstPath, outContent);
        } catch (err) {
          console.log(`  ${R}ERR${X}  ${dstRel}: ${err.message}`);
          repoErrors++; totalErrors++;
          continue;
        }
      }

      if (isNew) { repoNew++; totalNew++; }
      else { repoUpdated++; totalUpdated++; }
    }

    // ── GC: delete files removed from upstream (Gemini v3 G3 fix) ──────────
    // Compute set diff: priorFiles' isolated keys MINUS intendedWrites.
    const intendedDests = new Set(intendedWrites.keys());
    const gcDeletions = [];
    for (const priorDestRel of Object.keys(priorFiles)) {
      if (!priorDestRel.startsWith(`${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/`)) continue;
      if (intendedDests.has(priorDestRel)) continue;
      gcDeletions.push(priorDestRel);
    }
    if (gcDeletions.length) {
      if (DRY_RUN) {
        console.log(`  ${D}gc dry-run: ${gcDeletions.length} file(s) would be deleted${X}`);
      } else {
        for (const dRel of gcDeletions) {
          const abs = path.join(repo.path, dRel);
          try { fs.unlinkSync(abs); repoGcDeletions++; }
          catch (err) {
            if (err.code !== 'ENOENT') {
              console.log(`  ${Y}gc warn${X}  ${dRel}: ${err.message?.slice(0, 80)}`);
            }
          }
        }
        if (repoGcDeletions) console.log(`  ${D}gc: removed ${repoGcDeletions} stale file(s)${X}`);
      }
    }

    // ── Commit point: write per-consumer manifest with layout: 'isolated' ──
    if (!DRY_RUN) {
      try {
        // For consumer-side: compute hashes of the actual DESTINATION files
        // (post-rewrite). The source-side `.sync-manifest.json` produced
        // earlier is independent and stays.
        const consumerFileMap = {};
        for (const dstRel of intendedDests) {
          const abs = path.join(repo.path, dstRel);
          if (!fs.existsSync(abs)) continue;
          const buf = fs.readFileSync(abs);
          consumerFileMap[dstRel] = 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
        }
        const consumerManifest = {
          generatedAt: new Date().toISOString(),
          repo: 'Lbstrydom/claude-engineering-skills',
          branch: 'main',
          commitSha: null,
          files: consumerFileMap,
          layout: 'isolated',
        };
        atomicWriteFileSync(priorManifestPath, JSON.stringify(consumerManifest, null, 2) + '\n');
      } catch (err) {
        console.log(`  ${R}manifest write failed${X}: ${err.message?.slice(0, 120)}`);
      }
    }

    // ── Apply managed .gitignore block (preflight already validated) ───────
    if (!DRY_RUN && giPreview.action !== 'noop') {
      try {
        atomicWriteFileSync(giPath, giPreview.content);
      } catch (err) {
        console.log(`  ${R}.gitignore write failed${X}: ${err.message?.slice(0, 120)}`);
      }
    }

    // ── Last step: delete the in-progress journal (sync complete) ──────────
    if (!DRY_RUN) {
      try { fs.unlinkSync(inProgressJournalPath); }
      catch (err) { if (err.code !== 'ENOENT') { /* leave dangling — next run will reconcile */ } }
    }

    const parts = [];
    if (repoNew > 0) parts.push(`${G}+${repoNew} new${X}`);
    if (repoUpdated > 0) parts.push(`${Y}~${repoUpdated} updated${X}`);
    if (repoUnchanged > 0) parts.push(`${D}${repoUnchanged} unchanged${X}`);
    if (repoRemaps > 0) parts.push(`${D}${repoRemaps} remapped${X}`);
    if (repoRewrites > 0) parts.push(`${D}${repoRewrites} rewritten${X}`);
    if (repoGcDeletions > 0) parts.push(`${D}${repoGcDeletions} gc-deleted${X}`);
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

    // First-sync skills fit-check — fires once per consumer when the
    // sentinel report (`.skills-fit-check.json` in the consumer root) is
    // absent. Subsequent syncs skip it silently; adopters re-run any time
    // with `npm run skills:fit-check`. Best-effort, never blocks sync.
    if (!DRY_RUN) {
      const fitCheckSentinel = path.join(repo.path, '.skills-fit-check.json');
      if (!fs.existsSync(fitCheckSentinel)) {
        console.log('');
        console.log(`  ${B}First sync — running skills fit-check${X}`);
        try {
          execSync(
            `node "${path.join(SOURCE_ROOT, 'scripts/skills-fit-check.mjs')}" --repo-root "${repo.path}"`,
            { stdio: 'inherit', timeout: 15000 }
          );
        } catch {
          // Advisory diagnostic — never block the sync flow.
        }
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

  // D2b — sync-time shared-cloud-config trigger. Skip on dry-run, errors,
  // non-TTY, or --no-prompt. Silent on `already_current`; prompts on
  // create/update divergence. Never overwrites without operator Y.
  // Plan: docs/plans/shared-cloud-config.md §2 #5.
  // Gemini-r3 G2: stdin.isTTY added to the gate. stdout-only is unsafe in
  // CI pipelines where stdout is a pseudo-TTY (e.g. wrapped by a job
  // runner) but stdin is closed/piped — the readline prompt would hang
  // forever. Both streams must be interactive for the prompt to be safe.
  if (!DRY_RUN && totalErrors === 0 && process.stdout.isTTY && process.stdin.isTTY && !NO_PROMPT) {
    try {
      await maybePromptSharedCloudUpdate({ sourceRepoDir: SOURCE_ROOT, stdio: process.stderr });
    } catch (err) {
      // Trigger is advisory — never fail the sync over it.
      process.stderr.write(`[sync] shared-cloud-config trigger errored: ${err.message}\n`);
    }
  }

  // Dashboard reference page is no longer committed (2026-06): it embedded a
  // "built from <SHA>" banner, so rebuilding it on every push only ever
  // re-dirtied a tracked file that the hook never committed — perpetual churn
  // for an artifact nobody reads from git. It's now a local-only build (Category
  // A, gitignored), rebuilt on demand by `npm run dashboard` (serve rebuilds
  // both pages). No pre-push rebuild needed. See docs/completed/local-dashboard.md
  // §2.1 addendum + .gitignore.

  process.exit(totalErrors > 0 ? 1 : 0);
}

async function maybePromptSharedCloudUpdate({ sourceRepoDir, stdio }) {
  const { assessSharedCloudConfig, runSetupCloud, OUTCOMES } =
    await import('./lib/shared-cloud-config.mjs');
  const assessment = assessSharedCloudConfig({ sourceRepoDir });

  // Silent on `already_current` — operator only sees output when actionable.
  if (assessment.outcome === OUTCOMES.ALREADY_CURRENT) return;

  // Misconfigured → one-line advisory, never blocks sync.
  if (assessment.outcome === OUTCOMES.MISCONFIGURED) {
    stdio.write(
      `\n[sync] shared cloud config: ${assessment.reason} — skipping ` +
      `(run \`npm run setup:cloud\` for details)\n`
    );
    return;
  }

  // CREATED or UPDATED — delegate to lib's runSetupCloud, with a readline
  // prompt scoped to the sync flow.
  const readline = await import('node:readline');
  const prompt = (q) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: stdio });
    rl.question(q, (answer) => {
      rl.close();
      // R1-audit M3/M13: accept only empty (default Y) or explicit y/yes.
      const a = answer.trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
  stdio.write('\n');
  await runSetupCloud({ prompt, sourceRepoDir, stdio, autoYes: false });
}

// Test seam — exposes the sync-time D2b trigger helper so behaviour
// tests can drive it directly instead of regex-asserting source text.
export const _internals = Object.freeze({ maybePromptSharedCloudUpdate });

// Only execute when invoked as a script (canonical-path compare). When
// imported by a test, the module's exports are available without main()
// running and clobbering consumer repos.
import { pathToFileURL } from 'node:url';
const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedAsScript) {
  main().catch((err) => {
    process.stderr.write(`sync-to-repos: fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
