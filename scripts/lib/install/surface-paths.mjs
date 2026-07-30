/**
 * @fileoverview Repo-root discovery and scope target path resolution.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Discover the repo root by walking up from cwd.
 * Looks for .git (directory or file, for worktrees).
 * @param {string} [startDir=process.cwd()]
 * @returns {string} Absolute path to repo root
 */
export function findRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;
  let outermost = null;

  while (current !== root) {
    const gitPath = path.join(current, '.git');
    if (fs.existsSync(gitPath)) {
      outermost = current; // keep walking up for outermost
    }
    current = path.dirname(current);
  }

  if (outermost) return outermost;

  // Fallback: look for package.json
  current = path.resolve(startDir);
  while (current !== root) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }

  return startDir;
}

/**
 * Root of the GLOBAL (legacy) skill surface — `~/.claude/skills/`.
 *
 * **This surface is RETIRED as an install target** (see `resolveSkillTargets`).
 * The resolver survives because the surface still has to be *inspected* and
 * *cleaned up*: `legacy-surfaces.mjs` reads it, `install-skills.mjs
 * --uninstall-legacy` deletes from it, and `transaction.mjs` validates
 * containment against it. Nothing writes skills here any more.
 *
 * Single source of truth: the uninstaller acts under this root and
 * `transaction.mjs` validates journal-entry containment against it. Those two
 * MUST agree — a transaction legitimately spans both `repoRoot` and this root,
 * so a containment check that recomputed the path locally could drift from the
 * writer and reject every global operation.
 *
 * **`homeRoot` is explicit-by-parameter for a load-bearing reason** (plan D6e):
 * `install-skills.mjs --uninstall-legacy --home <root>` promises that the delete
 * acts on the root the operator was shown. If this stayed zero-argument,
 * `transaction.mjs` — which resolves containment through here — would silently
 * keep using the ambient `os.homedir()`, satisfying the flag in syntax while
 * violating it in implementation. Defaulting to `os.homedir()` keeps every
 * pre-existing caller unchanged.
 *
 * @param {string} [homeRoot=os.homedir()] explicit home root
 * @returns {string} absolute path to the global skills root
 */
export function globalSurfaceRoot(homeRoot = os.homedir()) {
  return path.join(homeRoot, '.claude', 'skills');
}

/** Basename of the install transaction journal, at either anchor. */
export const INSTALL_JOURNAL_BASENAME = '.audit-loop-install-txn.json';

/**
 * Journal + quarantine paths for the GLOBAL anchor.
 *
 * A transaction that mutates the SHARED `~/.claude/skills/` surface must leave
 * its recovery record where EVERY repo already looks — not inside whichever
 * repo happened to start it. A repo-anchored record for a global mutation is
 * invisible to every other repo, which then installs straight over the
 * half-applied shared state (the stranded-global-journal defect).
 *
 * These live here, beside `globalSurfaceRoot`, for the same reason it does:
 * the writer (`transaction.mjs`) and the reader (`install-skills.mjs`) must
 * derive the anchor from ONE source. A locally-recomputed `os.homedir()` join
 * is exactly how the two drift apart.
 */
export function globalJournalPath(homeRoot = os.homedir()) {
  return path.join(homeRoot, INSTALL_JOURNAL_BASENAME);
}

/**
 * Quarantine directory for the GLOBAL anchor. A globally-anchored journal that
 * cannot be understood must be quarantined somewhere every repo's pre-flight
 * looks, or the block it exists to enforce silently stops applying to everyone
 * but the repo that quarantined it.
 *
 * Outside every repo by construction, so — unlike the repo-anchored
 * `.audit/quarantine/` — it needs no gitignore entry.
 */
export function globalQuarantineDir(homeRoot = os.homedir()) {
  return path.join(homeRoot, '.audit-loop-install-quarantine');
}

/** Journal path for the REPO anchor. */
export function repoJournalPath(repoRoot) {
  return path.join(repoRoot, INSTALL_JOURNAL_BASENAME);
}

/** Quarantine directory for the REPO anchor — the long-established location. */
export function repoQuarantineDir(repoRoot) {
  return path.join(repoRoot, '.audit', 'quarantine');
}

/**
 * The retired install surfaces, and where a caller should go instead.
 *
 * `copilot` (`.github/skills/`) went first, 2026-07-28
 * (docs/plans/refactor-skill-governance.md). `claude` (`~/.claude/skills/`) and
 * `agents` (`<repoRoot>/.agents/skills/`) followed
 * (docs/plans/repo-scoped-skill-surfaces-and-installer.md).
 *
 * The governing reason is one fact, and it is worth stating precisely because
 * the obvious "fix" — rewriting the copied content — does not work:
 *
 *   A SKILL.md's runner paths are a function of the DEPLOYMENT LAYOUT. There are
 *   exactly two: the source repo (`scripts/X.mjs`) and a consumer
 *   (`scripts/.claude-skills/X.mjs`, produced by sourceRelToDestRel + applied by
 *   rewriteCommandSurface). This module copies bytes VERBATIM.
 *
 * So `~/.claude/skills/` — one machine-wide directory shared by every repo — is
 * layout-agnostic by construction and NO correct content for it exists; a rewrite
 * would merely flip which repo is broken. `.agents/skills/` is repo-scoped but
 * carries the identical unrewritten-path defect, and is additionally a SECOND
 * Copilot-discovered root duplicating every name in `.claude/skills/` — the
 * collision AGENTS.md forbids ("never ship the same skill name in two discovered
 * roots").
 *
 * `.claude/skills/**` is therefore written by exactly one writer per layout:
 * `regenerate-skill-copies.mjs` in the source repo, `sync-to-repos.mjs`
 * (rewriting) in every other repo.
 */
const RETIRED_INSTALL_SURFACES = Object.freeze({
  copilot: '.github/skills/ — retired 2026-07-28, see docs/plans/refactor-skill-governance.md',
  claude: '~/.claude/skills/ — a machine-global directory cannot carry layout-dependent runner paths',
  agents: '<repo>/.agents/skills/ — unrewritten runner paths, and a second discovered root colliding with .claude/skills/',
  both: 'an alias for the retired claude + agents surfaces',
});

const REPLACEMENT_HINT =
  'Skills are installed REPO-SCOPED into <repo>/.claude/skills/, never machine-global. '
  + 'Use `npm run sync -- --target <name>` (registered consumer), '
  + '`node scripts/sync-to-repos.mjs --target-path <dir>` (any repo), or '
  + '`npx github:Lbstrydom/claude-engineering-skills <dir>`. '
  + 'To remove a previously-installed global/agents tree: '
  + '`node scripts/install-skills.mjs --uninstall-legacy`. '
  + 'See docs/reference/skill-surface-ownership.md.';

/**
 * Resolve target paths for a skill based on surface selection.
 *
 * **Every surface is now retired — this function can no longer return a write
 * target, and always throws.** It is kept (rather than deleted along with its
 * callers) because it is the one place that can state *why* a surface is refused
 * and where to go instead; a caller that gets `undefined` from a deleted export
 * learns nothing.
 *
 * Each retired surface **throws** rather than returning an empty array, for the
 * reason the original `copilot` retirement documented: a silent `[]` is
 * indistinguishable from "this surface legitimately has zero targets". Only the
 * current caller happens to map an empty array to its own loud error today, and
 * nothing in this contract would guarantee a future caller does the same — it
 * would inherit a silent no-op. `'both'` throws for the same reason and is NOT a
 * degradation-to-zero: with both member surfaces retired it is a request for two
 * retired surfaces, not a request that narrows.
 *
 * @param {string} skillName
 * @param {string} surface - any value; all are retired or unrecognized
 * @param {string} repoRoot
 * @returns {never}
 * @throws {Error & {code: string}} `RETIRED_SURFACE` for a known-but-retired
 *   surface, `UNRECOGNIZED_SURFACE` otherwise
 */
export function resolveSkillTargets(skillName, surface, repoRoot) {  // eslint-disable-line no-unused-vars
  const why = RETIRED_INSTALL_SURFACES[surface];
  if (why) {
    const err = new Error(`surface '${surface}' is retired: ${why}. ${REPLACEMENT_HINT}`);
    err.code = 'RETIRED_SURFACE';
    throw err;
  }

  // Kept co-located with the retirement guard rather than after any
  // target-pushing branch (Gemini gate round-2 shadow finding #3 on the previous
  // revision): all "reject bad surface" logic lives in one place, so a future
  // contributor re-introducing a surface cannot forget it.
  const err = new Error(
    `unrecognized surface '${surface}' — every install surface is retired. ${REPLACEMENT_HINT}`,
  );
  err.code = 'UNRECOGNIZED_SURFACE';
  throw err;
}

/**
 * Resolve target paths for ALL files of a multi-file skill (manifest v2).
 * Returns per-file entries so the installer can write references/ and examples/
 * content, not just SKILL.md.
 *
 * Delegates straight to `resolveSkillTargets` with no swallowing — a bare
 * `surface === 'copilot'` throws the same retired-surface error.
 *
 * @param {string} skillName
 * @param {string} surface - 'claude' | 'copilot' | 'agents' | 'both'
 * @param {string} repoRoot
 * @param {Array<{ relPath: string, sha: string, size: number }>} files - from manifest v2 skill.files
 * @returns {Array<{ surface: string, dir: string, filePath: string, relPath: string, scope: 'global'|'repo' }>}
 * @throws {Error} if `surface === 'copilot'`
 */
export function resolveSkillFiles(skillName, surface, repoRoot, files) {
  const surfaceTargets = resolveSkillTargets(skillName, surface, repoRoot);
  const expanded = [];
  for (const t of surfaceTargets) {
    for (const f of files) {
      expanded.push({
        surface: t.surface,
        scope: t.scope,
        dir: t.dir,
        relPath: f.relPath,
        filePath: path.join(t.dir, f.relPath),
      });
    }
  }
  return expanded;
}

/**
 * Get the receipt file path for a given scope.
 * - `global` — `~/.audit-loop-install-receipt.json` — tracks files installed
 *   to the user's `~/.claude/skills/` directory (claude surface).
 * - `repo`   — `<repoRoot>/.audit-loop-install-receipt.json` — tracks files
 *   installed into the repo (copilot + agents surfaces).
 *
 * Splitting by scope fixes the G2 bug: claude-surface files live in
 * `~/.claude/skills/` but were previously recorded in the repo receipt using
 * machine-specific `../../../../Users/<name>/...` relative paths.
 * `homeRoot` is optional for the same reason the other global resolvers take one
 * (D6e): `--uninstall-legacy --home <root>` must act on the root the operator was
 * shown, and the *receipt* is what bounds that delete. A zero-argument version
 * here would silently read the ambient home's receipt while deleting under an
 * explicit one — the delete set and the tree it acts on would come from two
 * different homes, which is worse than either mistake alone.
 *
 * @param {'repo'|'global'} scope
 * @param {string} repoRoot
 * @param {string} [homeRoot=os.homedir()] explicit home root (global scope only)
 * @returns {string}
 */
export function receiptPath(scope, repoRoot, homeRoot = os.homedir()) {
  if (scope === 'global') {
    return path.join(homeRoot, '.audit-loop-install-receipt.json');
  }
  return path.join(repoRoot, '.audit-loop-install-receipt.json');
}

/**
 * Decode a receipt entry's `path` back to an absolute path — THE single decoder.
 *
 * It pairs with the scope-keyed ENCODING the installer writes (`global` →
 * absolute, `repo` → repo-relative). Every reader needs this exact branch, so
 * it lives here once rather than being restated per call site: two independent
 * copies of a decode rule are the drift this module exists to prevent, and the
 * bug that motivated it (a schema silently stripping `scope`) was invisible
 * precisely because each reader open-coded the branch.
 *
 * A missing `scope` means repo — matching `partitionManagedFilesByScope` and
 * every pre-existing receipt.
 *
 * @param {{path: string, scope?: 'global'|'repo'}} mf
 * @param {string} repoRoot
 * @returns {string} absolute path
 */
export function managedFileAbsPath(mf, repoRoot) {
  return mf.scope === 'global' ? mf.path : path.join(repoRoot, mf.path);
}

/**
 * Partition managed-file entries by scope. Callers use this to split a single
 * install batch into two receipts (global for claude surface, repo for others).
 *
 * @param {Array<{ scope?: 'global'|'repo', path?: string, skill?: string, sha?: string, blockSha?: string, merged?: boolean }>} managedFiles
 * @returns {{ global: Array, repo: Array }}
 */
export function partitionManagedFilesByScope(managedFiles) {
  const global = [];
  const repo = [];
  for (const mf of managedFiles) {
    if (mf.scope === 'global') global.push(mf);
    else repo.push(mf);
  }
  return { global, repo };
}
