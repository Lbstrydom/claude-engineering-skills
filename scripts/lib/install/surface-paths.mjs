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
 * Root of the GLOBAL (claude) install surface — `~/.claude/skills/`.
 *
 * Single source of truth: `resolveSkillTargets` writes under it, and
 * `transaction.mjs` validates journal-entry containment against it. Those two
 * MUST agree — a transaction legitimately spans both `repoRoot` and this root
 * (`install-skills.mjs` merges repo- and global-scope writes into one
 * transaction), so a containment check that recomputed the path locally could
 * drift from the writer and reject every global write.
 *
 * @returns {string} absolute path to the global skills root
 */
export function globalSurfaceRoot() {
  return path.join(os.homedir(), '.claude', 'skills');
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
export function globalJournalPath() {
  return path.join(os.homedir(), INSTALL_JOURNAL_BASENAME);
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
export function globalQuarantineDir() {
  return path.join(os.homedir(), '.audit-loop-install-quarantine');
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
 * Resolve target paths for a skill based on surface selection.
 * @param {string} skillName
 * @param {string} surface - 'claude' | 'copilot' | 'agents' | 'both'
 * @param {string} repoRoot
 * @returns {Array<{ surface: string, dir: string, filePath: string, scope: 'global'|'repo' }>}
 */
export function resolveSkillTargets(skillName, surface, repoRoot) {
  const targets = [];

  if (surface === 'claude' || surface === 'both') {
    const dir = path.join(globalSurfaceRoot(), skillName);
    targets.push({ surface: 'claude', dir, filePath: path.join(dir, 'SKILL.md'), scope: 'global' });
  }

  if (surface === 'copilot' || surface === 'both') {
    const dir = path.join(repoRoot, '.github', 'skills', skillName);
    targets.push({ surface: 'copilot', dir, filePath: path.join(dir, 'SKILL.md'), scope: 'repo' });
  }

  if (surface === 'agents' || surface === 'both') {
    const dir = path.join(repoRoot, '.agents', 'skills', skillName);
    targets.push({ surface: 'agents', dir, filePath: path.join(dir, 'SKILL.md'), scope: 'repo' });
  }

  return targets;
}

/**
 * Resolve target paths for ALL files of a multi-file skill (manifest v2).
 * Returns per-file entries so the installer can write references/ and examples/
 * content, not just SKILL.md.
 *
 * @param {string} skillName
 * @param {string} surface - 'claude' | 'copilot' | 'agents' | 'both'
 * @param {string} repoRoot
 * @param {Array<{ relPath: string, sha: string, size: number }>} files - from manifest v2 skill.files
 * @returns {Array<{ surface: string, dir: string, filePath: string, relPath: string, scope: 'global'|'repo' }>}
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
 * @param {'repo'|'global'} scope
 * @param {string} repoRoot
 * @returns {string}
 */
export function receiptPath(scope, repoRoot) {
  if (scope === 'global') {
    return path.join(os.homedir(), '.audit-loop-install-receipt.json');
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
