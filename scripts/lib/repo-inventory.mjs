/**
 * @fileoverview Canonical repo file inventory — the single source of
 * "what files exist" for the audit context tiers (Phase 2) and the
 * finding-verification gate (Phase 1).
 * Plan: docs/plans/adaptive-context-blast-radius.md.
 *
 * Security boundary: sensitive paths (`.env`, `*.pem`, `secrets/`, …) are
 * filtered out HERE, so they can never reach an external LLM through a
 * context block, a log line, or a verification probe. Reuses the shared
 * `isSensitivePath` denylist from `quickfix-patterns.mjs` (#1 DRY).
 *
 * @module scripts/lib/repo-inventory
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { isSensitivePath } from './quickfix-patterns.mjs';

// Directories never worth inventorying — skipped by the fs-walk fallback.
// (The git path already excludes these via .gitignore.)
const WALK_SKIP_DIRS = new Set([
  'node_modules', '.git', '.audit', '.audit-loop', 'coverage',
  'dist', 'build', '.claude', 'tmp',
]);

function runGit(cmd, baseDir) {
  return execSync(cmd, { cwd: baseDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Git inventory: union of tracked + untracked-but-unignored files, MINUS
 * uncommitted deletions. Plain `git ls-files` omits newly-created files
 * (the exact false-positive the gate exists to prevent) and includes
 * index entries already deleted from the work tree (ghost files) — both
 * are corrected here. Plan audit G3 + Gemini-R2-G2.
 */
function gitInventory(baseDir) {
  const tracked = runGit('git ls-files', baseDir);
  const untracked = runGit('git ls-files --others --exclude-standard', baseDir);
  const deleted = new Set(runGit('git ls-files --deleted', baseDir));
  return [...new Set([...tracked, ...untracked])].filter((f) => !deleted.has(f));
}

/**
 * Filesystem-walk fallback for non-git checkouts / shallow clones /
 * tarball installs. Best-effort: not a full `.gitignore` parser, but it
 * skips the heavy generated dirs AND every dot-directory (`.git`, `.ssh`,
 * `.aws`, …), and sensitive paths are excluded DURING traversal — a
 * sensitive directory is never descended into or enumerated (audit M8).
 * The non-git inventory may still diverge from a git checkout for
 * vendored/cached content; this is the documented fallback contract
 * (audit M9/M12 — accepted: a non-git environment is rare for this tool).
 */
function fsWalkInventory(baseDir, warnings) {
  const out = [];
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`fs-walk: could not read ${relDir || '.'} (${err.code || 'ERR'})`);
      return;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Skip heavy/generated dirs, all dot-dirs, and any sensitive dir
        // BEFORE descending — sensitive paths are never enumerated.
        if (WALK_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (isSensitivePath(`${rel}/`)) continue;
        walk(path.join(absDir, e.name), rel);
      } else if (e.isFile()) {
        if (!isSensitivePath(rel)) out.push(rel);
      }
    }
  };
  walk(path.resolve(baseDir), '');
  return out;
}

/**
 * Canonical sensitive-path-filtered repo file list.
 *
 * @param {{baseDir?: string}} [opts]
 * @returns {{files: string[], inventorySource: 'git'|'fs-walk',
 *   gitAvailable: boolean, excludedSensitive: number, warnings: string[]}}
 *   `files` are repo-root-relative, forward-slashed, sorted, and contain
 *   NO sensitive path. `warnings` carries inventory-completeness context
 *   (git failure reason, unreadable subtrees) instead of silently
 *   swallowing it (audit L3).
 */
export function listRepoFiles({ baseDir = process.cwd() } = {}) {
  const warnings = [];
  let raw;
  let inventorySource;
  let gitAvailable = true;
  try {
    raw = gitInventory(baseDir);
    inventorySource = 'git';
  } catch (err) {
    gitAvailable = false;
    warnings.push(`git inventory unavailable (${err.code || err.message || 'ERR'}) — using fs-walk fallback`);
    raw = fsWalkInventory(baseDir, warnings);
    inventorySource = 'fs-walk';
  }
  const normalised = raw.map((f) => f.replace(/\\/g, '/'));
  // Defence-in-depth: the git path filters here; the fs-walk path already
  // filtered during traversal, so this is idempotent for it.
  const files = normalised.filter((f) => !isSensitivePath(f)).sort();
  return {
    files,
    inventorySource,
    gitAvailable,
    excludedSensitive: normalised.length - files.length,
    warnings,
  };
}
