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
 * Asked of the CANDIDATES, never of the repo (fixed 2026-08-10). Materialising
 * the whole ignored-and-untracked universe to classify ~40 walked files meant
 * `git ls-files --others --ignored` enumerating every path under `node_modules`:
 * 28,193 entries here, 49,768 in the consumer that reported it, both far past
 * spawnSync's 1 MiB default `maxBuffer`. ENOBUFS surfaces as `r.error`, the
 * guard below returned the empty set, and the exclusion was silently OFF — so
 * the vendored-skill false positive above came back in a repo where the fix was
 * supposedly shipped, and had never once worked in a repo with dependencies
 * installed. The predicate is unchanged; only the side being enumerated is. It
 * is now bounded by the candidate count, which is what the answer depends on.
 *
 * Degrades to the empty set when git is unavailable or this is not a work tree,
 * leaving prior behaviour untouched — a scanner that throws because it is being
 * run outside git is a worse failure than one that scans slightly too much. That
 * degradation is now WARNED about on stderr rather than taken silently: losing
 * the filter turns owned-file judgements into unowned-file noise, and the 2026-08
 * recurrence was invisible precisely because nothing said the filter was off.
 *
 * @param {string} repoRoot
 * @param {string[]} candidates repo-relative paths the walk actually found
 * @returns {Set<string>} repo-relative POSIX paths to skip
 */
function ignoredUntrackedPaths(repoRoot, candidates) {
  const paths = [...new Set(candidates.map((p) => p.replaceAll(/\\/g, '/')))];
  if (paths.length === 0) return new Set();

  // Both queries take the candidate list on STDIN, so neither the output size
  // nor the Windows ~32K argv limit scales with repo size.
  const git = (args, input) => spawnSync('git', args, {
    cwd: repoRoot, input, encoding: 'utf-8', windowsHide: true,
  });
  const nulList = paths.join('\0');
  const split = (out) => (typeof out === 'string' ? out.split('\0').filter(Boolean) : []);

  // `check-ignore` exits 0 when at least one path is ignored, 1 when none are —
  // 1 is a legitimate answer, not a failure. Anything else (128 = not a work
  // tree, spawn error) means we could not determine ownership.
  const ign = git(['check-ignore', '-z', '--stdin'], nulList);
  if (ign.error || (ign.status !== 0 && ign.status !== 1)) {
    process.stderr.write(
      '[file-scanner] WARN: could not determine gitignore status '
      + `(${ign.error ? ign.error.code || ign.error.message : `git exit ${ign.status}`}) — `
      + 'scanning vendored/ignored instruction files too; findings may name files this repo does not own.\n',
    );
    return new Set();
  }
  const ignored = split(ign.stdout);
  if (ignored.length === 0) return new Set();

  // Ignored is not enough: git reports a TRACKED file as ignored whenever a
  // pattern matches it. Subtract the tracked ones to get "ignored AND untracked".
  // `ls-files` has no `--stdin`, so these go on argv — chunked, because argv is
  // the one bound that does not care how small our result set is.
  const tracked = new Set();
  for (let i = 0; i < ignored.length; i += 200) {
    const trk = git(['ls-files', '-z', '--', ...ignored.slice(i, i + 200)]);
    if (trk.error || trk.status !== 0) {
      process.stderr.write(
        '[file-scanner] WARN: could not determine tracked status '
        + `(${trk.error ? trk.error.code || trk.error.message : `git exit ${trk.status}`}) — `
        + 'scanning vendored/ignored instruction files too; findings may name files this repo does not own.\n',
      );
      return new Set();
    }
    for (const p of split(trk.stdout)) tracked.add(p.replaceAll(/\\/g, '/'));
  }

  return new Set(ignored.map((p) => p.replaceAll(/\\/g, '/')).filter((p) => !tracked.has(p)));
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
  const disowned = options.respectGitignore === false ? new Set() : ignoredUntrackedPaths(repoRoot, found);
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
