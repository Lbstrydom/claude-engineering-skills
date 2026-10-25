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
import {
  CORE_ENTRY as CORE_ENTRY_ALL, LEARNING_ENTRY, ARCH_ENTRY, SYNC_ISOLATION_ENTRY, DEBT_ENTRY,
} from './sync-entry-lists.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');


// CORE_NON_IMPORTABLE lists modules that are documented runtime injection
// points (callers `import()` them dynamically) so the static import-graph
// walker cannot reach them. They are a SUBSET of the shared CORE_ENTRY
// (sync-entry-lists.mjs, the one list); this array only marks which of them the
// static walker cannot follow.
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
  // Loaded by .claude/hooks/legacy-surface-advisory.mjs through a COMPUTED
  // two-layout candidate path (path.join + pathToFileURL), so the static import
  // walker cannot reach it. Without this entry the hook ships but its inspector
  // does not, and loadInspector() returns null -- the advisory is silently dead,
  // which is the exact failure being fixed. Keep in lock-step across both files.
  'scripts/lib/install/legacy-surfaces.mjs',
];

// The importable half is DERIVED from the one shared list (sync-entry-lists.mjs): everything the
// static walker can reach. Only the dynamic-import-only subset above is declared here, and
// tests/sync-inventory-parity.test.mjs asserts it is a subset of the shared CORE_ENTRY.
const CORE_ENTRY = CORE_ENTRY_ALL.filter((e) => !CORE_NON_IMPORTABLE.includes(e));





function syncMigrations() {
  const dir = path.join(REPO_ROOT, 'supabase', 'migrations');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => `supabase/migrations/${f}`);
  } catch (err) {
    // ENOENT is the NORMAL case — a repo without migrations legitimately has no
    // such directory. Every other errno is not: EACCES on an existing directory,
    // an I/O failure, or a mis-resolved REPO_ROOT all previously returned `[]`,
    // which is indistinguishable from "no migrations" and ships a bundle with
    // the schema silently missing. Same expected-absence-vs-real-failure split
    // as audit-clean.mjs's BENIGN_FS_CODES.
    if (err.code === 'ENOENT') return [];
    throw new Error(
      `syncMigrations: cannot read ${dir} (${err.code || err.message}). Refusing to report an empty `
      + 'migration set — that would ship a bundle whose schema is silently absent.',
      { cause: err },
    );
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
  // Authoritative list is sync-to-repos.mjs; keep in lock-step.
  '.claude/hooks/install-cloud-deps.sh',
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
  // The bundle's own npm-dependency declaration, generated by
  // `generate-bundle-deps.mjs` from the import graph. An ASSET rather than a
  // walker discovery: it is JSON read by `check-setup.mjs` via a
  // module-relative fs read, so nothing imports it and the closure walk
  // cannot find it. Authoritative list is sync-to-repos.mjs; keep in lock-step.
  'scripts/lib/bundle-deps.json',
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

export function readSource(rel) {
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
/**
 * The bundle every consumer receives, independent of which consumer.
 *
 * `bundleForRepo()` has never varied by repo — `getSyncInventoryForRepo` uses
 * the alias only to stamp `name`/`alias` onto the result. A gate that must run
 * in the pre-push sandbox cannot go through the alias path at all: the consumer
 * registry lives in the gitignored `consumer-repos.local.json`, so asking for
 * one by name makes the answer depend on whose machine it is. This export is
 * the same closure as a pure function of committed source.
 *
 * Paths are SOURCE-relative (`scripts/foo.mjs`), not destination-relative —
 * use `sourceRelToDestRel` when you need where it lands in a consumer.
 *
 * @returns {{files: string[], unresolved: object[], external: object[]}}
 */
export function getSyncClosure() {
  return bundleForRepo();
}

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
