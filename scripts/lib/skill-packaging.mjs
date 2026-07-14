/**
 * @fileoverview Allowlist-based enumeration of files that make up a skill.
 * Used by build-manifest.mjs, regenerate-skill-copies.mjs, sync-to-repos.mjs,
 * and check-sync.mjs — single source of truth for what ships.
 *
 * Packaged surfaces are pure-markdown. A colocated `gate-contract.json`
 * (plan §F2.3 — the gate-honesty suite) is repo-local gate metadata, never
 * packaged: it is TOLERATED at a skill's root (not rejected as unexpected)
 * but excluded from the returned file list, so it never reaches the
 * generated `.claude/skills/**` copies, the sync inventory, or the build
 * manifest — all four packaging consumers inherit this from this ONE
 * function. Any other non-markdown file is still rejected.
 * @module scripts/lib/skill-packaging
 */

import fs from 'node:fs';
import path from 'node:path';

/** Paths relative to a skill directory that are packageable, in order. */
export const SKILL_ALLOWED_FILES = ['SKILL.md'];
export const SKILL_ALLOWED_DIRS = ['references', 'examples'];
export const SKILL_ALLOWED_EXTENSIONS = ['.md'];

/**
 * Files tolerated at a skill's root — recognized, never rejected as
 * "unexpected", but deliberately excluded from `enumerateSkillFiles`'s
 * returned list (never packaged, never synced, never in the manifest).
 */
export const SKILL_LOCAL_FILES = ['gate-contract.json'];

export const SKILL_EXCLUDED_BASENAME_PATTERNS = [
  /^\./,                 // dotfiles (.DS_Store, .gitkeep, .foo.swp etc.)
  /\.swp$/, /\.swo$/,    // vim swap
  /\.bak$/, /~$/,        // common editor backups
  /^thumbs\.db$/i,       // Windows thumbs cache
];

/**
 * Enumerate all files that belong to a skill, relative to the skill directory.
 * Returns a sorted string array so output is deterministic across platforms.
 *
 * @param {string} skillDir — absolute path to `skills/<name>/`
 * @param {object} [options]
 * @param {boolean} [options.strict=true] — throw when unexpected files found
 * @returns {string[]} — relative paths, e.g. ['SKILL.md', 'references/foo.md']
 */
export function enumerateSkillFiles(skillDir, { strict = true } = {}) {
  if (!fs.existsSync(skillDir)) {
    throw new Error(`Skill directory does not exist: ${skillDir}`);
  }

  const results = [];
  const unexpected = [];

  for (const ent of fs.readdirSync(skillDir, { withFileTypes: true })) {
    if (isExcludedBasename(ent.name)) continue;
    const abs = path.join(skillDir, ent.name);

    if (ent.isFile()) {
      if (SKILL_ALLOWED_FILES.includes(ent.name)) {
        results.push(ent.name);
      } else if (SKILL_LOCAL_FILES.includes(ent.name)) {
        // Tolerated, not packaged — deliberately absent from `results`.
      } else {
        unexpected.push(ent.name);
      }
      continue;
    }

    if (ent.isDirectory()) {
      if (SKILL_ALLOWED_DIRS.includes(ent.name)) {
        collectDirectoryMd(abs, ent.name, results, unexpected);
      } else {
        unexpected.push(ent.name + '/');
      }
      continue;
    }

    // Symlinks, sockets, etc. — not allowed in skill dirs
    unexpected.push(ent.name);
  }

  if (strict && unexpected.length > 0) {
    throw new Error(
      `Skill "${path.basename(skillDir)}" contains files outside the allowlist: ${unexpected.join(', ')}. ` +
      `Allowed: SKILL.md, references/**/*.md, examples/**/*.md. Code belongs in scripts/ at repo root.`,
    );
  }

  return results.sort();
}

/**
 * Walk one level of subdirectories under a skill's references/ or examples/
 * directory, collecting .md files. Rejects non-markdown files.
 */
function collectDirectoryMd(absDir, relDir, results, unexpected) {
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (isExcludedBasename(ent.name)) continue;
    const rel = `${relDir}/${ent.name}`;
    const abs = path.join(absDir, ent.name);

    if (ent.isFile()) {
      if (SKILL_ALLOWED_EXTENSIONS.some(ext => ent.name.endsWith(ext))) {
        results.push(rel);
      } else {
        unexpected.push(rel);
      }
      continue;
    }

    if (ent.isDirectory()) {
      // Allow one level of nesting (e.g. references/persona-archetypes/<file>.md)
      for (const sub of fs.readdirSync(abs, { withFileTypes: true })) {
        if (isExcludedBasename(sub.name)) continue;
        const subRel = `${rel}/${sub.name}`;
        if (sub.isFile() && SKILL_ALLOWED_EXTENSIONS.some(ext => sub.name.endsWith(ext))) {
          results.push(subRel);
        } else {
          unexpected.push(subRel);
        }
      }
      continue;
    }

    unexpected.push(rel);
  }
}

function isExcludedBasename(name) {
  return SKILL_EXCLUDED_BASENAME_PATTERNS.some(re => re.test(name));
}

/**
 * Enumerate every skill directory under a root.
 * @param {string} skillsRoot — e.g. `<repo>/skills/`
 * @returns {string[]} — skill names (directory basenames), sorted
 */
export function listSkillNames(skillsRoot) {
  if (!fs.existsSync(skillsRoot)) return [];
  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => fs.existsSync(path.join(skillsRoot, name, 'SKILL.md')))
    .sort();
}
