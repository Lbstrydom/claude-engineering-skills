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

/**
 * Run a `git ls-files`-family command and return pathnames VERBATIM.
 *
 * **`-z` is load-bearing, and so is the absence of `.trim()`.** Without `-z`,
 * git quotes any path carrying non-ASCII or control characters
 * (`core.quotePath` defaults on): `src/café.mjs` comes back as the literal
 * `"src/caf\303\251.mjs"`. Newline-splitting then compounds it — a pathname
 * containing a newline becomes two phantom entries — and trimming rewrites any
 * name with leading/trailing whitespace into one that does not exist.
 *
 * Every consumer treats inventory membership as PROOF (the verification gate
 * refutes "file is missing" findings on it; `extractPlanPaths` decides which
 * files the audit reads from it), so a mangled entry is wrong in both
 * directions at once: a real file reported absent, and a path that exists
 * nowhere reported present. `-z` disables quoting entirely and NUL cannot occur
 * in a pathname, making the split unambiguous. The caller passes `-z`.
 */
function runGit(cmd, cwd) {
  return execSync(cmd, {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_MAX_BUFFER,
  })
    .split('\0')
    .filter(Boolean);
}

/**
 * Resolve the git work-tree root, or null when not in a git checkout.
 *
 * Strips ONLY the command's terminating newline. A blanket `.trim()` here is
 * the same defect `runGit` carries above, one function over: it rewrites a root
 * whose directory name legitimately begins or ends with whitespace into a path
 * that does not exist, and every inventory path is then resolved relative to
 * that wrong root.
 */
function gitRoot(baseDir) {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd: baseDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\r?\n$/, '');
    return out || null;
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
  const tracked = runGit('git ls-files -z', root);
  const untracked = runGit('git ls-files --others --exclude-standard -z', root);
  const deleted = new Set(runGit('git ls-files --deleted -z', root));
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
/**
 * Resolve a CITED repo-relative path against the inventory.
 *
 * **Why this is one oracle and not two.** A plan (and a model) routinely cites
 * a path SUFFIX — `zone/zoneChat.js` for `src/services/zone/zoneChat.js` — and
 * exact membership answers "no" there. `finding-verification.mjs` learned that
 * at the OUTPUT layer (it refutes a false "missing file" finding on a unique
 * suffix hit); `extractPlanPaths` did not, at the INPUT layer, so the same path
 * was classified missing, excluded from the audited set, AND announced to the
 * model as `**Missing:** …` — which the structure pass then faithfully
 * reported. Measured 2026-08-13 on one consumer plan: 18 of 25 paths called
 * missing resolved to exactly one real file, and 8 of them were never read by
 * the audit at all. Two notions of "exists" in one pipeline is what produced a
 * finding and a coverage hole from the same defect, so both sides call this.
 *
 * Segment-boundary only (`/${cited}`): `oneChat.js` must never match
 * `zoneChat.js`. Ambiguity is NOT resolved — several hits prove nothing about
 * which file was meant, and guessing is how a false verdict is manufactured.
 *
 * @param {string} citedPath - repo-relative as written (back/forward slashes ok)
 * @param {Set<string>|string[]} repoFiles - canonical inventory (`listRepoFiles().files`)
 * @returns {{status: 'exact'|'suffix'|'ambiguous'|'absent', resolved: string|null,
 *   matchCount: number}} `resolved` is the real inventory path for `exact` and
 *   `suffix`, and null otherwise. `ambiguous` carries its `matchCount` so a
 *   caller can report why it declined rather than reporting plain absence.
 */
export function resolveUniqueSuffix(citedPath, repoFiles) {
  const norm = String(citedPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm) return { status: 'absent', resolved: null, matchCount: 0 };

  const fileSet = repoFiles instanceof Set ? repoFiles : new Set(repoFiles || []);
  if (fileSet.has(norm)) return { status: 'exact', resolved: norm, matchCount: 1 };

  // Segment-boundary suffix. Stop at 2 — the caller only distinguishes
  // "exactly one" from "more than one", so counting the rest is wasted work on
  // a large inventory.
  const suffix = `/${norm}`;
  const hits = [];
  for (const f of fileSet) {
    if (f.endsWith(suffix)) {
      hits.push(f);
      if (hits.length > 1) break;
    }
  }
  if (hits.length === 1) return { status: 'suffix', resolved: hits[0], matchCount: 1 };
  if (hits.length > 1) return { status: 'ambiguous', resolved: null, matchCount: hits.length };
  return { status: 'absent', resolved: null, matchCount: 0 };
}

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
