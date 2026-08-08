/**
 * @fileoverview Side-effect-free inventory of files-to-sync per consumer.
 *
 * Extracts the existing bundleForRepo/REPOS logic from sync-to-repos.mjs into
 * a library module so tests + the verifier CLI can import it without running
 * the sync main.  Plan §7 (R2 H2 fix).
 *
 * @module scripts/lib/sync-inventory
 */

import fs from 'node:fs';
import path from 'node:path';
import { enumerateSkillFiles, listSkillNames } from './skill-packaging.mjs';
import { CONSUMER_REPOS } from './consumer-repos.mjs';
import { collectImportClosure } from './module-graph.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

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
  // The unknown-flag gate + its npm `--`-swallow sibling. Authoritative list
  // is sync-to-repos.mjs; keep in lock-step.
  'scripts/check-cli-flags.mjs',
  'scripts/check-npm-run-args.mjs',
  'scripts/brainstorm-round.mjs',
  'scripts/explain-history.mjs',
  'scripts/skills-help.mjs',
  'scripts/skills-fit-check.mjs',
  'scripts/requirements.mjs',
  'scripts/audit-metrics.mjs',
  'scripts/write-code-outcomes.mjs',
  // Final-review transcript builder for the two MANDATORY gates, the ledger
  // writer both Step 3.5s run, and Step 5.0b's detector census (an entry point
  // nothing imports, so the walker never finds it). Authoritative list is
  // sync-to-repos.mjs; keep in lock-step.
  'scripts/build-audit-transcript.mjs',
  'scripts/write-ledger-entries.mjs',
  'scripts/lib/audit/detector.mjs',
  'scripts/build-dashboard.mjs',
  'scripts/setup-postgres.mjs',
  // Companion RLS-exposure diagnostic — same lib/db/ closure as
  // setup-postgres.mjs. Authoritative list lives in sync-to-repos.mjs;
  // keep in lock-step (see plan §7 R2 H2 — single-source-of-truth intent).
  'scripts/check-rls.mjs',
  // Standalone operator CLIs nothing imports (branch-protection ratchet,
  // audit_repos identity reconcile, tiered-shadow report reader). Authoritative
  // list is sync-to-repos.mjs; keep in lock-step.
  'scripts/ensure-branch-protection.mjs',
  'scripts/reconcile-repo-identity.mjs',
  'scripts/tiered-shadow-report.mjs',
  '.claude/hooks/quickfix-scan.mjs',
  'scripts/persona-consistency-run.mjs',
  'scripts/persona-consistency-promote.mjs',
  // Deterministic /ux-lock runner (WS2). Authoritative list is sync-to-repos.mjs;
  // keep in lock-step. Walker pulls in lib/playwright-runner.mjs +
  // lib/plan-criteria-parser.mjs.
  'scripts/ux-lock-run.mjs',
  // Consumer-invoked surfaces.json builder (validates against our
  // SurfaceManifestSchema). Authoritative list is sync-to-repos.mjs; keep
  // in lock-step. Walker pulls in its lib/persona-test/schemas.mjs import.
  'scripts/build-surfaces-manifest.mjs',
  // /nav-audit CLI entry — walker pulls in scripts/lib/nav/** closure.
  // Authoritative list is sync-to-repos.mjs; keep in lock-step.
  'scripts/nav-audit.mjs',
  // /visual-audit CLI entry — walker pulls in lib/visual/** closure.
  // Authoritative list is sync-to-repos.mjs; keep in lock-step.
  'scripts/visual-audit.mjs',
  // GREEN≠REALIZED Cluster A efficacy-lints CLI — walker pulls in lib/efficacy-lints.mjs +
  // its model-resolver / glob-match / sensitive-paths closure. Keep in lock-step with sync-to-repos.mjs.
  'scripts/efficacy-lints-check.mjs',
  // Citation re-resolver (see the entry's rationale in sync-to-repos.mjs, which
  // is authoritative for this list).
  'scripts/check-doc-citations.mjs',
  // Local weekly-maintenance replica of the (now 7) GH Actions / opt-in
  // checks — opt-in, default-OFF, invoked opportunistically from the
  // pre-push hook. maintenance-checks.mjs spawns the other four as
  // subprocesses, so all five must ship together. Authoritative list is
  // sync-to-repos.mjs; keep in lock-step (a prior drift here produced a
  // live MODULE_NOT_FOUND when a consumer first enabled the opt-in — see
  // sync-to-repos.mjs's comment).
  'scripts/maintenance-checks.mjs',
  'scripts/memory-health.mjs',
  'scripts/check-model-freshness.mjs',
  'scripts/context-staleness.mjs',
  'scripts/debt-health-check.mjs',
  // Deterministic /ship commit helper (AI-* provenance trailers). Authoritative
  // list is sync-to-repos.mjs; keep in lock-step. Walker pulls in
  // lib/commit-trailers.mjs + sensitive-paths closure.
  'scripts/ship-commit.mjs',
];

// CORE_NON_IMPORTABLE lists modules that are documented runtime injection
// points (callers `import()` them dynamically) so the static import-graph
// walker cannot reach them. Authoritative list is sync-to-repos.mjs; keep in
// lock-step.
//
// NOTE: this used to also carry a `./lib/redact.mjs` entry (relative-form
// duplicate of the absolute `scripts/lib/redact.mjs` below), on the theory
// that different callers use each form. sync-to-repos.mjs's CORE_ENTRY only
// ever lists the absolute form — and a bare `./lib/redact.mjs` entry point
// normalises (in collectImportClosure) to the nonexistent repo-root path
// `lib/redact.mjs`, which silently entered every consumer's file list as a
// phantom entry (readFile returns null, but the path stays in `visited`,
// so it surfaced in `files` and in `bundleDeps()`'s external-package scan
// with nothing to read). Removed; the closure reaches redact.mjs's own
// dynamic imports via the entries below regardless.
const CORE_NON_IMPORTABLE = [
  'scripts/lib/redact.mjs',
  // Arm-eval framework — reached only via dynamic imports in cross-skill.mjs
  // and openai-audit.mjs, so the walker cannot follow. Authoritative list is
  // sync-to-repos.mjs; keep in lock-step.
  'scripts/lib/arm-eval/run.mjs',
  'scripts/lib/arm-eval/decision.mjs',
  'scripts/lib/arm-eval/toggle.mjs',
  'scripts/lib/store/arm-eval.mjs',
  'scripts/lib/persona-test/semantic-compare.mjs',
  // Bash-shelled from persona-test/click-test SKILL.mds (`node
  // scripts/lib/device-presets.mjs prep|prep-matrix`) — never statically
  // imported, so the walker can't reach it. Mirrors sync-to-repos.mjs.
  'scripts/lib/device-presets.mjs',
];

const LEARNING_ENTRY = [
  'scripts/refine-prompts.mjs',
  'scripts/evolve-prompts.mjs',
  'scripts/meta-assess.mjs',
];

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
  'scripts/lib/arch-intent/adapters/js-ts.mjs',
  'scripts/lib/arch-intent/adapters/java.mjs',
  'scripts/lib/arch-intent/adapters/python.mjs',
  'scripts/lib/arch-intent/adapters/postgres.mjs',
];

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

// New (Phase 1): the sync-isolation infrastructure scripts/libs themselves
// need to ship to consumers so the verifier + migration helpers exist
// post-hydration.
const SYNC_ISOLATION_ENTRY = [
  'scripts/lib/sync-path-map.mjs',
  'scripts/lib/sync-rewriter.mjs',
  'scripts/lib/sync-gitignore.mjs',
  // sync-inventory.mjs is source-only (imports consumer-repos.mjs which
  // computes paths relative to the source-repo parent dir; not meaningful
  // on the consumer side). See the matching note in sync-to-repos.mjs.
  'scripts/lib/sync-isolation-verify.mjs',
  'scripts/lib/npm-script-enumerator.mjs',
  'scripts/lib/remove-legacy-synced.mjs',
];

function syncMigrations() {
  const dir = path.join(REPO_ROOT, 'supabase', 'migrations');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => `supabase/migrations/${f}`);
  } catch {
    return [];
  }
}

function buildSkillFiles() {
  const out = [];
  const skillsDir = path.join(REPO_ROOT, 'skills');
  for (const name of listSkillNames(skillsDir)) {
    const skillDir = path.join(skillsDir, name);
    const files = enumerateSkillFiles(skillDir, { strict: true });
    for (const rel of files) {
      out.push(`.claude/skills/${name}/${rel}`);
    }
  }
  return out;
}

const EDITOR_FILES = ['.vscode/mcp.json'];
const CLAUDE_CODE_FILES = [
  '.claude/hooks/arch-memory-check.sh',
  '.claude/settings.json',
];

const CORE_ASSETS = [
  'scripts/.sync-manifest.json',
  'scripts/lib/dashboard/flows.json',
  'scripts/lib/dashboard/assets/dashboard.css',
  'scripts/lib/dashboard/assets/dashboard.js',
  'docs/reference/consistency-contract.md',
  // Tiered-pipeline OSS call budgets — read via a module-relative fs read
  // (`new URL('./oss-call-policy.json', import.meta.url)`), so the import
  // walker never sees it. Authoritative list is sync-to-repos.mjs; keep in
  // lock-step.
  'scripts/lib/oss-call-policy.json',
  'scripts/lib/db/compat-bootstrap.sql',
  // `--adopt`'s schema contract, fs-read by setup-postgres.mjs. Authoritative
  // list is sync-to-repos.mjs; keep in lock-step.
  'tests/fixtures/expected-schema.json',
];

function buildFileUniverse() {
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
    const dir = path.join(REPO_ROOT, top);
    if (fs.existsSync(dir)) walk(dir, top);
  }
  return out;
}

let _fileUniverseCache = null;
function getFileUniverse() {
  if (!_fileUniverseCache) _fileUniverseCache = buildFileUniverse();
  return _fileUniverseCache;
}

function readSource(rel) {
  try { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'); }
  catch { return null; }
}

function resolveBundle(entryPoints, assets = []) {
  const { files, unresolved, external } = collectImportClosure({
    entryPoints,
    repoFiles: getFileUniverse(),
    readFile: readSource,
  });
  return { files: [...new Set([...files, ...assets])], unresolved, external };
}

// @duplicate-justification: target=scripts/sync-to-repos.mjs:bundleForRepo reason=deliberate mirror per this module's own header ("Extracts the existing bundleForRepo/REPOS logic from sync-to-repos.mjs into a library module so tests + the verifier CLI can import it without running the sync main") — sync-to-repos.mjs is the authoritative CLI entry point and cannot be imported as a library without triggering its own main(), so this is a source-only, side-effect-free re-implementation, kept in lock-step by tests/sync-inventory-parity.test.mjs's array-equality assertions rather than by sharing code.
function bundleForRepo() {
  const entries = [
    ...CORE_ENTRY, ...CORE_NON_IMPORTABLE, ...LEARNING_ENTRY, ...ARCH_ENTRY,
    ...SYNC_ISOLATION_ENTRY, ...DEBT_ENTRY,
  ];
  const assets = [...CORE_ASSETS, ...syncMigrations()];
  const { files, unresolved, external } = resolveBundle(entries, assets);
  const skillFiles = buildSkillFiles();
  const nonCode = [...skillFiles, ...EDITOR_FILES, ...CLAUDE_CODE_FILES];
  return { files: [...files, ...nonCode], unresolved, external };
}

/**
 * Return the full source-relative file list for the named consumer.
 *
 * @param {string} aliasOrName — 'ai' / 'wine' / 'ai-organiser' / 'wine-cellar-app'
 * @returns {{files: string[], unresolved: Array<{from:string,specifier:string}>, external: Array<{from:string,specifier:string,pkg:string}>, name: string, alias: string}}
 */
export function getSyncInventoryForRepo(aliasOrName) {
  const repo = CONSUMER_REPOS.find((r) => r.alias === aliasOrName || r.name === aliasOrName);
  if (!repo) throw new Error(`getSyncInventoryForRepo: unknown consumer "${aliasOrName}". Known: ${CONSUMER_REPOS.map((r) => r.alias).join(', ')}`);
  const { files, unresolved, external } = bundleForRepo();
  return { files, unresolved, external, name: repo.name, alias: repo.alias };
}

/**
 * Return inventories for ALL consumers, keyed by alias.
 *
 * @returns {Map<string, {files: string[], unresolved: Array<{from:string,specifier:string}>, external: Array<{from:string,specifier:string,pkg:string}>, name: string, alias: string}>}
 */
export function getAllConsumerInventories() {
  const out = new Map();
  for (const repo of CONSUMER_REPOS) {
    const inv = getSyncInventoryForRepo(repo.alias);
    out.set(repo.alias, inv);
  }
  return out;
}

export const _internals = {
  CORE_ENTRY, CORE_NON_IMPORTABLE, LEARNING_ENTRY, ARCH_ENTRY, DEBT_ENTRY,
  SYNC_ISOLATION_ENTRY, CORE_ASSETS, EDITOR_FILES, CLAUDE_CODE_FILES,
  bundleForRepo, syncMigrations, buildSkillFiles,
  REPO_ROOT,
};
