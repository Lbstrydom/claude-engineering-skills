/**
 * @fileoverview Discover instruction files in a repo (CLAUDE.md, AGENTS.md, SKILL.md).
 * Mandatory exclusions prevent scanning into node_modules, .git, etc.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ignoredUntrackedPaths } from '../disowned-paths.mjs';

/**
 * Paths the repo does NOT own: ignored AND untracked.
 *
 * Extracted to `scripts/lib/disowned-paths.mjs` (`ignoredUntrackedPaths`) —
 * this doctor-friction plan's D4 — so this scanner and the doctor's
 * disowned-file probe share one oracle instead of two copies drifting apart.
 * See that module for the full rationale (the vendored-third-party-skill
 * false positive, the candidates-not-the-repo ENOBUFS fix, the ignored-vs-
 * untracked distinction).
 */

/** Globs that are always excluded (non-configurable). */
const MANDATORY_EXCLUDES = [
  '.git', 'node_modules', 'dist', 'build', 'coverage',
  'tests/**/fixtures', 'vendor', '.next', '__pycache__', '.venv',
];

/** Patterns to scan for instruction files. */
const INSTRUCTION_PATTERNS = [
  '**/CLAUDE.md',
  '**/AGENTS.md',
  '.claude/skills/*/SKILL.md',
  '.github/skills/*/SKILL.md',
  '.github/copilot-instructions.md',
];

/**
 * Simple recursive glob without external dependency.
 * @param {string} dir - Directory to search
 * @param {string} pattern - Filename pattern to match
 * @param {Set<string>} excludeDirs - Directory names to skip
 * @returns {string[]}
 */
function walkDir(dir, patterns, excludeDirs) {
  const results = [];
  const patternNames = patterns.map(p => path.basename(p));

  function walk(current, relPath) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        // Check for fixtures exclusion
        if (entryRel.includes('fixtures')) {
          const parts = entryRel.split('/');
          const testsIdx = parts.indexOf('tests');
          if (testsIdx >= 0 && parts.indexOf('fixtures', testsIdx) >= 0) continue;
        }
        walk(path.join(current, entry.name), entryRel);
      } else if (entry.isFile()) {
        // Match against known instruction file names
        if (patternNames.includes(entry.name)) {
          // Verify it matches one of the full patterns
          for (const p of patterns) {
            if (matchPattern(entryRel, p)) {
              results.push(entryRel);
              break;
            }
          }
        }
      }
    }
  }

  walk(dir, '');
  return results;
}

// Simple pattern matching for our known patterns.
// Supports: exact match, glob-star/name (any directory), dir/wildcard/name (one-level wildcard)
function matchPattern(filePath, pattern) {
  const norm = filePath.replaceAll(/\\/g, '/');
  const pat = pattern.replaceAll(/\\/g, '/');

  if (pat.startsWith('**/')) {
    // Match filename anywhere
    const name = pat.slice(3);
    return norm === name || norm.endsWith('/' + name);
  }

  // Handle patterns like .claude/skills/*/SKILL.md
  const patParts = pat.split('/');
  const fileParts = norm.split('/');

  if (patParts.length !== fileParts.length) return false;

  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i] === '*') continue;
    if (patParts[i] !== fileParts[i]) return false;
  }
  return true;
}

/**
 * Scan a repository for instruction files.
 * @param {string} repoRoot - Absolute path to repo root
 * @param {object} [options]
 * @param {string[]} [options.additionalExcludes] - Extra globs to exclude
 * @returns {{ files: Array<{ path: string, absPath: string, content: string, sizeBytes: number }> }}
 */
export function scanInstructionFiles(repoRoot, options = {}) {
  // Only collapse SIMPLE excludes (no `/`) into the directory-name set.
  // Glob-style entries like `tests/**/fixtures` must NOT shorten to `tests`
  // — that would skip the whole tests/ tree. The walkDir fixtures-handler
  // takes care of the nested-fixtures case via path inspection.
  const excludeDirs = new Set(
    MANDATORY_EXCLUDES.filter(e => !e.includes('/')),
  );
  if (options.additionalExcludes) {
    for (const e of options.additionalExcludes) {
      if (!e.includes('/')) excludeDirs.add(e);
    }
  }

  const found = walkDir(repoRoot, INSTRUCTION_PATTERNS, excludeDirs);
  // Drop what the repo does not own. `options.respectGitignore === false` opts
  // out for a caller that genuinely wants the raw walk (tests do).
  // This scanner is best-effort, not a gating consumer (round-3 audit M20's
  // `degraded` distinction matters for a caller that treats the result as
  // authoritative evidence — see disowned-paths.mjs's own JSDoc) — an
  // unverified empty set behaves identically to a verified one here.
  const disowned = options.respectGitignore === false
    ? new Set()
    : ignoredUntrackedPaths(repoRoot, found).paths;
  const files = [];

  for (const relPath of found) {
    if (disowned.has(relPath.replaceAll(/\\/g, '/'))) continue;
    const absPath = path.join(repoRoot, relPath);
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      files.push({
        path: relPath.replaceAll(/\\/g, '/'),
        absPath,
        content,
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
      });
    } catch { /* skip unreadable files */ }
  }

  return { files };
}

export { MANDATORY_EXCLUDES, INSTRUCTION_PATTERNS };
