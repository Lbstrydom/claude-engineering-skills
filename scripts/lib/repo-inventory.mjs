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
// (The git path already excludes these via .gitignore.) Dot-directories
// are NOT blanket-skipped — `.github/` etc. are legitimate tracked content
// (audit M6/M16); `.git` itself is listed explicitly.
const WALK_SKIP_DIRS = new Set([
  'node_modules', '.git', '.audit', '.audit-loop', 'coverage',
  'dist', 'build', '.claude', 'tmp',
]);

// git ls-files output on a large repo can exceed execSync's 1 MB default
// maxBuffer; raising it prevents a silent (mis-classified) fallback to
// fs-walk (audit M5).
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function runGit(cmd, cwd) {
  return execSync(cmd, {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_MAX_BUFFER,
  })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Resolve the git work-tree root, or null when not in a git checkout. */
function gitRoot(baseDir) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: baseDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Git inventory: union of tracked + untracked-but-unignored files, MINUS
 * uncommitted deletions. Run from the repo ROOT so paths are repo-root-
 * relative even when the caller's `baseDir` is a subdirectory (audit H1).
 * Plain `git ls-files` omits newly-created files (the exact false-positive
 * the gate exists to prevent) and includes index entries already deleted
 * from the work tree (ghost files) — both corrected here (audit G3 +
 * Gemini-R2-G2).
 */
function gitInventory(root) {
  const tracked = runGit('git ls-files', root);
  const untracked = runGit('git ls-files --others --exclude-standard', root);
  const deleted = new Set(runGit('git ls-files --deleted', root));
  return [...new Set([...tracked, ...untracked])].filter((f) => !deleted.has(f));
}

/**
 * Filesystem-walk fallback for non-git checkouts / shallow clones /
 * tarball installs. Best-effort: not a full `.gitignore` parser, but it
 * skips the heavy generated dirs, and sensitive paths are excluded DURING
 * traversal — a sensitive directory is never descended into or enumerated
 * (audit M8). Legitimate dot-directories (`.github/`, …) ARE included so
 * the fallback does not silently diverge from a git checkout (audit M6).
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
        if (WALK_SKIP_DIRS.has(e.name)) continue;
        if (isSensitivePath(`${rel}/`)) continue; // never descend into a sensitive dir
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
 *   gitAvailable: boolean, complete: boolean, excludedSensitive: number,
 *   warnings: string[]}}
 *   `files` are repo-root-relative, forward-slashed, sorted, with NO
 *   sensitive path. `complete` is the machine-readable completeness flag
 *   (audit M7): false when a subtree was unreadable. `warnings` carries
 *   inventory-completeness context instead of silently swallowing it.
 */
export function listRepoFiles({ baseDir = process.cwd() } = {}) {
  const warnings = [];
  let raw;
  let inventorySource;
  let gitAvailable = true;

  const root = gitRoot(baseDir);
  if (root) {
    try {
      raw = gitInventory(root); // repo-root-relative by construction
      inventorySource = 'git';
    } catch (err) {
      gitAvailable = false;
      warnings.push(`git inventory failed (${err.code || err.message || 'ERR'}) — using fs-walk fallback`);
    }
  } else {
    gitAvailable = false;
    warnings.push('not a git work-tree — using fs-walk fallback');
  }
  if (raw === undefined) {
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
    // `complete` is false ONLY when a subtree was genuinely unreadable —
    // merely using the fs-walk fallback is not an incompleteness (M7).
    complete: !warnings.some((w) => w.includes('could not read')),
    excludedSensitive: normalised.length - files.length,
    warnings,
  };
}
