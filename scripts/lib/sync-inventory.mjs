/**
 * @fileoverview The ONE owner of "which files does a consumer receive" — the
 * bundle inventory — consumed by BOTH the sync (`sync-to-repos.mjs`) and every
 * library/verifier caller (isolation verifier, relocation guard, dependency
 * derivation, `getSyncClosure`).
 *
 * It used to exist twice: this module held a hand-kept mirror of lists that
 * `sync-to-repos.mjs` also declared, with "keep in lock-step" comments and a
 * parity test as the only thing standing between two independently editable
 * copies of deployment inventory (debt 3627c83a). The sync is a source-only CLI
 * and this module is side-effect free, so the dependency runs one way: the CLI
 * imports from here. There is no second copy to drift.
 *
 * FAIL-CLOSED READS (debt 8e5974a92c98). `readSource` used to turn EVERY
 * filesystem error into `null`, and the closure walker treats `null` as "no
 * imports" — so an unreadable entry silently dropped its whole import subtree
 * from the bundle, and the next sync's GC then deleted that subtree from every
 * consumer. A file the walker visits is, by construction, a member of the
 * universe enumerated from disk a moment earlier, so a read failure on it is a
 * race or a fault, never a retirement: it throws. A declared entry point that
 * is not on disk throws too (`MissingEntryPointError`).
 *
 * @module scripts/lib/sync-inventory
 */

import fs from 'node:fs';
import path from 'node:path';
import { enumerateSkillFiles, listSkillNames } from './skill-packaging.mjs';
import { CONSUMER_REPOS } from './consumer-repos.mjs';
import { collectImportClosure } from './module-graph.mjs';
import { ignoredUntrackedPaths } from './disowned-paths.mjs';
import { listShippableMigrations } from './migration-ownership.mjs';
import {
  CORE_ENTRY, LEARNING_ENTRY, ARCH_ENTRY, SYNC_ISOLATION_ENTRY, DEBT_ENTRY,
} from './sync-entry-lists.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

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
  'docs/reference/consistency-contract.md',
  // Tiered-pipeline OSS call budgets. `lib/oss-call-policy.mjs` reads this via
  // `new URL('./oss-call-policy.json', import.meta.url)` — a module-relative fs
  // read, so the import walker never sees it and it did not ship. The reader
  // deliberately THROWS rather than falling back to a default budget, so in a
  // consumer the tiered shadow died with
  // `[oss-call-policy] failed to read .../scripts/.claude-skills/lib/oss-call-policy.json: ENOENT`
  // and every affected run recorded `fallback_legacy` — 15 wasted observations
  // in the Phase-14 window before the cause was traced (2026-07-18).
  'scripts/lib/oss-call-policy.json',
  // The symbol index's Python parser stage. `lib/symbol-index/python-extract.mjs`
  // runs it via `new URL('./python-ast-helper.py', import.meta.url)` — a
  // module-relative path, so the import walker never sees it. Without this
  // entry a consumer's probe reports `helper-missing` and every .py file is
  // counted unparseable (docs/plans/python-arch-memory-indexing.md §2.4).
  'scripts/lib/symbol-index/python-ast-helper.py',
  // The bundle's npm-dependency declaration (generate-bundle-deps.mjs). JSON
  // fs-read by check-setup, so the import walker cannot discover it.
  'scripts/lib/bundle-deps.json',
  // Which audit-store views are time-windowed — same fs-read blind spot as the two
  // above (`lib/store/windowed-views.mjs` reads it). Without it the Home dashboard
  // reads every queue as `windowed: 'unknown'` and all five chips lose their delta,
  // Q3/debt/upstream included, which are not windowed. It describes the SHARED
  // store's views, so it is one declaration everywhere, not per-repo config; root
  // rather than `.audit-loop/`, whose isolation guards against `supabase db push`.
  '.windowed-views.json',
  // postgres-parity M4 — setup-postgres.mjs reads compat-bootstrap.sql via
  // fs (the import-graph walker can't follow fs reads). Migrations are
  // similarly fs-read; ship the whole directory so `--migrate` works on
  // consumer repos without them needing this repo cloned.
  'scripts/lib/db/compat-bootstrap.sql',
  // `--adopt`'s schema contract. Same fs-read blind spot as the two above, but
  // it failed differently: `runAdopt` hard-aborts at its entrypoint when the
  // manifest is missing, so `--adopt` — the documented one-time bootstrap for a
  // pre-provisioned DB — could not run in ANY consumer repo. It lives under
  // `tests/fixtures/` here because that is where it is generated and asserted;
  // for a consumer it is pure runtime. The sync loop remaps it to
  // `.audit-loop/expected-schema.json` via sync-path-map.
  'tests/fixtures/expected-schema.json',
  // `own-model-coverage.mjs` reads its floors from this dotfile via fs, which the
  // import walker cannot follow. Remapped to `.audit-loop/own-model-coverage.json`
  // by sync-path-map; without it `check --static` has no config in a consumer.
  '.own-model-coverage.json',
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
export function syncMigrations() {
  return syncMigrationsReport().files;
}

/**
 * The migration source set AND what was refused: `{files, untracked}`.
 *
 * **The set is what git TRACKS under `supabase/migrations/`, never the directory listing** (incident 2026-11-22: a mirror
 * checkout held three untracked, `.git/info/exclude`d migrations; the sync copied them into six consumers, which committed
 * them). An untracked file is never shipped and is returned in `untracked` so the sync names it. If git cannot answer the
 * question this THROWS - an unverifiable set is not a clean one.
 *
 * ENOENT is the NORMAL case - a repo without migrations legitimately has no such directory. Every other errno is not:
 * EACCES on an existing directory, an I/O failure, or a mis-resolved REPO_ROOT all previously returned `[]`, which is
 * indistinguishable from "no migrations" and ships a bundle with the schema silently missing.
 *
 * @param {{repoRoot?: string, spawn?: Function, listDir?: (dir: string) => string[]}} [opts] injectable for tests
 * @returns {{files: string[], untracked: string[]}}
 */
export function syncMigrationsReport({ repoRoot = REPO_ROOT, ...io } = {}) {
  const dir = path.join(repoRoot, 'supabase', 'migrations');
  const r = listShippableMigrations({ repoRoot, migrationsDir: dir, ...io });
  if (r.status !== 'ok') {
    throw new Error(
      `syncMigrations: cannot establish the tracked migration set of ${dir} (${r.reason}). Refusing to report an empty migration set or `
      + 'an untrusted one — shipping a directory listing is how untracked files reached every consumer.',
    );
  }
  if (r.missingOnDisk.length) {
    throw new Error(`syncMigrations: ${r.missingOnDisk.length} migration(s) are tracked by git but absent from ${dir} (${r.missingOnDisk.join(', ')}). Refusing an incomplete source inventory - restore them, or git rm them if the retirement is intended.`);
  }
  return { files: r.shippable.map((f) => `supabase/migrations/${f}`), untracked: r.untracked.map((f) => `supabase/migrations/${f}`) };
}

/**
 * The per-target report of source migrations the sync REFUSED (untracked), as printable lines, plus whether the tracked set
 * could not be established at all (`failed`: git could not answer - the target's sync fails closed).
 *
 * @param {string} repoName
 * @param {{R: string, D: string, X: string}} colors
 * @param {() => {untracked: string[]}} [report] injectable for tests
 * @returns {{lines: string[], failed: boolean}}
 */
export function describeUntrackedMigrations(repoName, { R, D, X }, report = syncMigrationsReport) {
  try {
    const { untracked } = report();
    if (!untracked.length) return { lines: [], failed: false };
    return {
      failed: false,
      lines: [
        `  ${R}refused${X}  ${untracked.length} UNTRACKED source migration(s) not shipped to ${repoName} ${D}(git does not own them; delete them, or git add + commit upstream):${X}`,
        ...untracked.map((f) => `    ${R}?${X} ${f}`),
      ],
    };
  } catch (err) {
    return { lines: [`  ${R}ABORT${X}  cannot establish the tracked migration set: ${err.message}`], failed: true };
  }
}

// ── Import-graph resolution ────────────────────────────────────────────────

/** A bundle file the walker visited could not be read — never reported as "no imports". */
export class SourceReadError extends Error {
  constructor(rel, cause) {
    super(`sync inventory: cannot read ${rel} (${cause?.code || cause?.message}). Refusing to resolve a bundle `
      + 'that silently omits its import subtree — that subtree would then be deleted from every consumer by GC.', { cause });
    this.name = 'SourceReadError';
    this.path = rel;
    this.code = cause?.code ?? null;
  }
}

/** A declared entry point is not on disk — its whole subtree would vanish from the bundle. */
export class MissingEntryPointError extends Error {
  constructor(missing) {
    super(`sync inventory: ${missing.length} declared entry point(s) are not on disk: ${missing.join(', ')}. `
      + 'Fix the entry list (scripts/lib/sync-entry-lists.mjs) or restore the file; refusing to ship a bundle without them.');
    this.name = 'MissingEntryPointError';
    this.missing = missing;
  }
}

/**
 * Build the repo-relative path universe under scripts/ and .claude/ — the
 * file set `resolveSpecifier` probes for extension/index resolution.
 *
 * **The corpus is the repo, not the disk.** The walk goes level by level and asks the ONE ownership oracle
 * (`ignoredUntrackedPaths`: ignored AND untracked) about each level's entries before descending, so a gitignored
 * directory (`.claude/tmp/`, `.claude/worktrees/`) is never listed: its files cannot enter a consumer's bundle, and a
 * parallel process deleting a copy there cannot make this walk die with ENOENT. ENOENT is deliberately NOT caught: an
 * OWNED directory vanishing mid-walk is a fault that must stay loud. The oracle fails open and loud (a degraded answer
 * warns on stderr and leaves the candidates unfiltered), which is the pre-fix behaviour, never a silent narrowing.
 * @param {{root?: string, fsImpl?: Pick<typeof fs, 'readdirSync'|'existsSync'>}} [opts] injectable for tests
 * @returns {Set<string>}
 */
function buildFileUniverse({ root = REPO_ROOT, fsImpl = fs } = {}) {
  const out = new Set();
  const SKIP = new Set(['node_modules', '.git', '.audit', '.audit-loop']);
  let level = [];
  for (const top of ['scripts', '.claude']) {
    const dir = path.join(root, top);
    if (fsImpl.existsSync(dir)) level.push({ abs: dir, rel: top });
  }
  while (level.length) {
    const entries = [];
    for (const d of level) {
      for (const entry of fsImpl.readdirSync(d.abs, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        entries.push({ abs: path.join(d.abs, entry.name), rel: `${d.rel}/${entry.name}`, dir: entry.isDirectory() });
      }
    }
    // A directory is asked with its trailing slash, so a directory-only pattern (`.claude/tmp/`) matches it.
    const key = (e) => (e.dir ? `${e.rel}/` : e.rel);
    const disowned = ignoredUntrackedPaths(root, entries.map(key)).paths;
    level = [];
    for (const e of entries) {
      if (disowned.has(key(e))) continue;
      if (e.dir) level.push({ abs: e.abs, rel: e.rel }); else out.add(e.rel);
    }
  }
  return out;
}

let _fileUniverseCache = null;
function getFileUniverse() {
  if (!_fileUniverseCache) _fileUniverseCache = buildFileUniverse();
  return _fileUniverseCache;
}

/**
 * Read one bundle source file. THROWS `SourceReadError` on every failure,
 * ENOENT included (see the module header for why absence is not a valid answer
 * for a file the walker visits).
 * @param {string} rel
 * @param {{read?: (abs: string) => string}} [opts]
 * @returns {string}
 */
export function readSource(rel, { read = (abs) => fs.readFileSync(abs, 'utf-8') } = {}) {
  try { return read(path.join(REPO_ROOT, rel)); } catch (err) { throw new SourceReadError(rel, err); }
}

/**
 * Resolve a bundle to its full file list: the transitive import closure of
 * its entry points, plus its non-importable assets.
 * @param {string[]} entryPoints
 * @param {string[]} [assets]
 * @param {{exists?: (abs: string) => boolean, readFile?: (rel: string) => string}} [seams]
 * @returns {{files: string[], unresolved: Array<{from:string,specifier:string}>, external: Array<{from:string,specifier:string,pkg:string}>}}
 */
export function resolveBundle(entryPoints, assets = [], { exists = fs.existsSync, readFile = readSource } = {}) {
  const missing = entryPoints.filter((e) => !exists(path.join(REPO_ROOT, e)));
  if (missing.length) throw new MissingEntryPointError(missing);
  const { files, unresolved, external } = collectImportClosure({
    entryPoints, repoFiles: getFileUniverse(), readFile,
  });
  return { files: [...new Set([...files, ...assets])], unresolved, external };
}

/**
 * `unresolved` entries worth surfacing — a path-like specifier that didn't
 * resolve to a repo file is a genuinely missing dependency. Specifiers
 * carrying `${`, backticks or whitespace are template-literal parser noise
 * (a regex catching a string fragment of source) and are filtered out.
 * @param {Array<{from:string,specifier:string}>} unresolved
 * @returns {Array<{from:string,specifier:string}>}
 */
export function realMissingDeps(unresolved) {
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
 * Phase 4 of ai-context-sync dropped the .github/skills/ surface from the
 * default; the `--keep-github-skills` escape hatch that could still opt a
 * sync back into mirroring it was removed entirely 2026-07-28
 * (docs/plans/refactor-skill-governance.md) — this function now only ever
 * produces `.claude/skills/` entries.
 */
export function buildSkillFiles() {
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
  // SessionStart dependency install for cloud sessions (npm/pnpm/yarn by
  // lockfile, + Playwright's browser only when the repo declares it as a
  // dependency). A cloud "Setup script" runs before repo checkout and fails
  // there with ENOENT on package.json; this hook runs after checkout instead
  // and is a no-op outside CLAUDE_CODE_REMOTE. Zero imports, fully portable.
  // Authoritative list is sync-to-repos.mjs; keep sync-inventory.mjs in lock-step.
  '.claude/hooks/install-cloud-deps.sh',
  '.claude/settings.json',
];

// ── Repo configuration ─────────────────────────────────────────────────────

// Non-code surfaces — skills, editor + Claude Code config. Not importable,
// so appended after the import-graph closure. (The .github/prompts/ Copilot
// prompt-shim surface was RETIRED 2026-07-21: Copilot Agent Skills are GA and
// read .claude/skills natively, and since VS Code 1.109 skills surface as
// /name slash commands in the SAME namespace as prompt files — same-basename
// shims collided with their own skills. See the Copilot-compat audit.)
// (composed in bundleForRepo: skills + editor + Claude Code config)

/**
 * Compute the synced file list for one consumer repo: the import-graph
 * closure of its entry-point bundles + core assets + non-code surfaces.
 * Every consumer gets every bundle — see the DEBT_ENTRY comment above for
 * why the previous per-repo carve-out was removed.
 *
 * Repo identity (name/alias/path) lives in lib/consumer-repos.mjs as the
 * single source of truth — only the file-set composition is sync-specific.
 *
 * @returns {{files: string[], unresolved: Array<{from:string,specifier:string}>}}
 */
export function bundleForRepo() {
  const entries = [
    ...CORE_ENTRY, ...LEARNING_ENTRY, ...ARCH_ENTRY, ...SYNC_ISOLATION_ENTRY, ...DEBT_ENTRY,
  ];
  const assets = [...CORE_ASSETS, ...syncMigrations()];
  const { files, unresolved, external } = resolveBundle(entries, assets);
  const nonCode = [...buildSkillFiles(), ...EDITOR_FILES, ...CLAUDE_CODE_FILES];
  return { files: [...files, ...nonCode], unresolved, external };
}

/**
 * The version-contract subset: the core + arch closure plus the same assets
 * (migrations included). These are the files consumers must keep in lockstep;
 * the learning/debt bundles are optional additions and not part of it.
 * @returns {{files: string[], unresolved: object[], external: object[]}}
 */
export function versionContractBundle() {
  return resolveBundle([...CORE_ENTRY, ...ARCH_ENTRY], [...CORE_ASSETS, ...syncMigrations()]);
}

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
  CORE_ENTRY, LEARNING_ENTRY, ARCH_ENTRY, DEBT_ENTRY,
  SYNC_ISOLATION_ENTRY, CORE_ASSETS, EDITOR_FILES, CLAUDE_CODE_FILES,
  bundleForRepo, syncMigrations, syncMigrationsReport, buildSkillFiles, buildFileUniverse,
  REPO_ROOT,
};
