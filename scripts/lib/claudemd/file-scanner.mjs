/**
 * @fileoverview Discover instruction files in a repo (CLAUDE.md, AGENTS.md, SKILL.md).
 * Mandatory exclusions prevent scanning into node_modules, .git, etc.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Paths the repo does NOT own: ignored AND untracked.
 *
 * Why this and not a longer `MANDATORY_EXCLUDES` (upstream 5b67666e, filed from
 * a consumer 2026-08-04): a consumer that vendors third-party skills gets
 * directories the checker has no business judging. There, `npx skills add`
 * produced `.agents/skills/<vendor>/CLAUDE.md` whose entire body is the literal
 * string "AGENTS.md" — a third-party pointer file, gitignored, not part of the
 * consumer's context topology — and it raised `[HIGH] ctx/missing-import`, so
 * `context:check --strict` exited 1 on a repo whose real topology was clean.
 * That is the cried-wolf shape: a gate red on arrival for a reason the operator
 * cannot fix stops being read. A hardcoded list would have to grow once per
 * vendoring tool; "does this repo own the file" does not.
 *
 * The predicate is ignored AND UNTRACKED, deliberately — not merely ignored.
 * `git check-ignore` reports a TRACKED file as ignored whenever a pattern
 * matches it, so filtering on ignore-status alone would silently stop judging a
 * committed CLAUDE.md that happens to match one (this repo tracks files under
 * ignored patterns today). `git ls-files --others --ignored --exclude-standard`
 * is exactly the "untracked and ignored" set and cannot make that mistake.
 *
 * Degrades to the empty set when git is unavailable or this is not a work tree,
 * leaving prior behaviour untouched — a scanner that throws because it is being
 * run outside git is a worse failure than one that scans slightly too much.
 *
 * @param {string} repoRoot
 * @returns {Set<string>} repo-relative POSIX paths to skip
 */
function ignoredUntrackedPaths(repoRoot) {
  const r = spawnSync('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], {
    cwd: repoRoot, encoding: 'utf-8', windowsHide: true,
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return new Set();
  return new Set(r.stdout.split('\0').filter(Boolean).map((p) => p.replaceAll(/\\/g, '/')));
}

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
  const disowned = options.respectGitignore === false ? new Set() : ignoredUntrackedPaths(repoRoot);
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
