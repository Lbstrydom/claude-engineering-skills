#!/usr/bin/env node
/**
 * @fileoverview One-way generation: byte-copy skills from the authoritative
 * `skills/` tree to `.claude/skills/` (and optionally `.github/skills/`).
 *
 * - The top-level `skills/` directory is the ONLY place authors edit.
 * - `.claude/skills/` is always generated — never edited directly.
 * - `.github/skills/` is **deprecated** as of Phase 4 of ai-context-sync —
 *   no documented tool reads it. Pass `--keep-github-skills` to keep
 *   regenerating it during the deprecation window. Removed in next minor.
 * - Prunes files in the destination that are no longer in the source so
 *   destinations exactly mirror source.
 *
 * Uses `scripts/lib/skill-packaging.mjs` for the file allowlist — non-markdown
 * and dotfile files never propagate.
 *
 * Usage:
 *   node scripts/regenerate-skill-copies.mjs                     # default: only .claude/skills/
 *   node scripts/regenerate-skill-copies.mjs --keep-github-skills # also write .github/skills/
 *   node scripts/regenerate-skill-copies.mjs --dry-run           # report, no writes
 *   node scripts/regenerate-skill-copies.mjs --check             # exit 1 if out of sync
 *
 * Exit codes:
 *   0 = success (or --check: in sync)
 *   1 = --check: destinations differ from source
 *   2 = bad input / allowlist violation
 *
 * @module scripts/regenerate-skill-copies
 */
import fs from 'node:fs';
import path from 'node:path';
import { enumerateSkillFiles, listSkillNames } from './lib/skill-packaging.mjs';
import { generateAllPromptFiles } from './lib/install/copilot-prompts.mjs';
import { sha, assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_ROOT = path.join(ROOT, 'skills');

const KEEP_GITHUB_SKILLS = process.argv.includes('--keep-github-skills');

const DEST_ROOTS = [
  path.join(ROOT, '.claude', 'skills'),
  ...(KEEP_GITHUB_SKILLS ? [path.join(ROOT, '.github', 'skills')] : []),
];

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', X = '\x1b[0m', D = '\x1b[2m', B = '\x1b[1m';


// ── main() helpers — keep main() under cognitive-complexity 15 ────────────

function warnGithubSkillsDeprecation() {
  const ghSkillsDir = path.join(ROOT, '.github', 'skills');
  if (KEEP_GITHUB_SKILLS || !fs.existsSync(ghSkillsDir)) return;
  process.stderr.write(
    `${Y}[regenerate] DEPRECATION: .github/skills/ is no longer maintained ` +
    `(no documented tool reads it).\n` +
    `  Existing files at ${path.relative(ROOT, ghSkillsDir)} are not deleted ` +
    `by this run. To preserve them and keep regenerating, pass --keep-github-skills.\n` +
    `  Once confirmed unused, delete the directory manually.${X}\n`,
  );
}

function loadSkillsOrDie() {
  if (!fs.existsSync(SRC_ROOT)) {
    process.stderr.write(`${R}skills/ does not exist at ${SRC_ROOT}${X}\n`);
    process.exit(2);
  }
  const skills = listSkillNames(SRC_ROOT);
  if (skills.length === 0) {
    process.stderr.write(`${R}No skills found under ${SRC_ROOT}${X}\n`);
    process.exit(2);
  }
  return skills;
}

function copyFileIfChanged(srcAbs, dstAbs, opts) {
  const srcBuf = fs.readFileSync(srcAbs);
  const dstExists = fs.existsSync(dstAbs);
  const dstBuf = dstExists ? fs.readFileSync(dstAbs) : null;
  if (dstBuf && sha(srcBuf) === sha(dstBuf)) return 'unchanged';
  if (opts.dryOrCheck) {
    process.stdout.write(`${Y}~${X} ${path.relative(ROOT, dstAbs)} ${D}(${dstExists ? 'update' : 'create'})${X}\n`);
  } else {
    // mkdir belongs on the WRITE path only. It used to run unconditionally at
    // the head of this function, so `--dry-run` created directories — see the
    // note on the `syncSkillToDests` mkdir for what that cost.
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    fs.writeFileSync(dstAbs, srcBuf);
  }
  return 'wrote';
}

function pruneFilesNotInSource(destDir, srcSet, opts) {
  if (!fs.existsSync(destDir)) return 0;
  let deletes = 0;
  const destFiles = enumerateSkillFiles(destDir, { strict: false });
  for (const rel of destFiles) {
    if (srcSet.has(rel)) continue;
    const dstAbs = path.join(destDir, rel);
    if (opts.dryOrCheck) {
      process.stdout.write(`${R}-${X} ${path.relative(ROOT, dstAbs)} ${D}(prune)${X}\n`);
    } else {
      fs.unlinkSync(dstAbs);
    }
    deletes++;
  }
  return deletes;
}

function syncSkillToDests(name, opts) {
  const skillSrcDir = path.join(SRC_ROOT, name);
  let srcFiles;
  try {
    srcFiles = enumerateSkillFiles(skillSrcDir, { strict: true });
  } catch (err) {
    process.stderr.write(`${R}${name}: ${err.message}${X}\n`);
    return { violation: `${name}: ${err.message}`, writes: 0, unchanged: 0, deletes: 0 };
  }
  let writes = 0, unchanged = 0, deletes = 0;
  for (const destRoot of DEST_ROOTS) {
    const destDir = path.join(destRoot, name);
    // `--dry-run` must not create the destination tree. This mkdir was
    // unconditional: running `--keep-github-skills --dry-run` materialised 31
    // empty `.github/skills/<name>/` directories, which then hard-failed
    // `check-stale-skill-surface --gate` (a `.github/skills` tree shadows
    // `.claude/skills` for Copilot). A safety flag that still mutates the
    // filesystem is the same defect class as one that gets silently dropped —
    // the operator asked for "show me", and the tool did something.
    if (!opts.dryOrCheck) fs.mkdirSync(destDir, { recursive: true });
    for (const rel of srcFiles) {
      const result = copyFileIfChanged(path.join(skillSrcDir, rel), path.join(destDir, rel), opts);
      if (result === 'wrote') writes++;
      else unchanged++;
    }
    deletes += pruneFilesNotInSource(destDir, new Set(srcFiles), opts);
  }
  return { writes, unchanged, deletes };
}

function pruneOrphanSkillDirs(srcSet, opts) {
  let deletes = 0;
  for (const destRoot of DEST_ROOTS) {
    if (!fs.existsSync(destRoot)) continue;
    for (const ent of fs.readdirSync(destRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || srcSet.has(ent.name)) continue;
      const dstDir = path.join(destRoot, ent.name);
      if (opts.dryOrCheck) {
        process.stdout.write(`${R}-${X} ${path.relative(ROOT, dstDir)}/ ${D}(prune orphan skill)${X}\n`);
      } else {
        fs.rmSync(dstDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
      deletes++;
    }
  }
  return deletes;
}

function writePromptFiles(entries, opts) {
  const expected = new Set();
  let writes = 0, unchanged = 0;
  for (const entry of entries) {
    const dstAbs = path.join(ROOT, entry.relPath);
    expected.add(dstAbs);
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    const dstExists = fs.existsSync(dstAbs);
    const dstContent = dstExists ? fs.readFileSync(dstAbs, 'utf-8') : null;
    if (dstContent === entry.content) { unchanged++; continue; }
    if (opts.dryOrCheck) {
      process.stdout.write(`${Y}~${X} ${path.relative(ROOT, dstAbs)} ${D}(${dstExists ? 'update' : 'create'} prompt)${X}\n`);
    } else {
      fs.writeFileSync(dstAbs, entry.content);
    }
    writes++;
  }
  return { writes, unchanged, expected };
}

function pruneStalePrompts(promptDir, expected, opts) {
  if (!fs.existsSync(promptDir)) return 0;
  let deletes = 0;
  for (const f of fs.readdirSync(promptDir)) {
    if (!f.endsWith('.prompt.md')) continue;
    const abs = path.join(promptDir, f);
    if (expected.has(abs)) continue;
    const content = fs.readFileSync(abs, 'utf-8');
    // Only prune managed files; leave operator-authored prompts alone.
    if (!content.includes('<!-- audit-loop-bundle:prompt:start -->')) continue;
    if (opts.dryOrCheck) {
      process.stdout.write(`${R}-${X} ${path.relative(ROOT, abs)} ${D}(prune managed prompt)${X}\n`);
    } else {
      fs.unlinkSync(abs);
    }
    deletes++;
  }
  return deletes;
}

function syncCopilotPrompts(opts) {
  const promptDir = path.join(ROOT, '.github', 'prompts');
  const entries = generateAllPromptFiles(SRC_ROOT);
  const { writes, unchanged, expected } = writePromptFiles(entries, opts);
  const deletes = pruneStalePrompts(promptDir, expected, opts);
  return { writes, unchanged, deletes };
}

function computeVerdict(stats, violationsCount) {
  if (violationsCount > 0) return 'VIOLATIONS';
  if (stats.writes + stats.deletes === 0) return 'IN SYNC';
  return 'CHANGES';
}

function emitVerdict(stats, violations, check) {
  const verdict = computeVerdict(stats, violations.length);
  process.stdout.write(
    `\n${B}regenerate-skill-copies:${X} ${stats.writes} write, ${stats.deletes} prune, ${stats.unchanged} unchanged` +
    (violations.length ? `, ${R}${violations.length} violations${X}` : '') +
    ` — ${verdict}\n`,
  );
  if (violations.length > 0) process.exit(2);
  if (check && (stats.writes + stats.deletes) > 0) {
    process.stderr.write(`\n${R}Destinations differ from source. Run: node scripts/regenerate-skill-copies.mjs${X}\n`);
    process.exit(1);
  }
}

/**
 * Every flag this CLI reads. Kept adjacent to `main()` rather than beside the
 * module-scope `KEEP_GITHUB_SKILLS` constant, which evaluates on IMPORT —
 * throwing there would break any consumer that imports this module.
 *
 * No flag here takes a value; all three are booleans.
 */
const KNOWN_FLAGS = ['--keep-github-skills', '--dry-run', '--check'];

function main() {
  // This CLI OVERWRITES the generated `.claude/skills/` tree by default, so
  // `--dry-run`/`--check` are safety flags over a mutating default: a dropped
  // `--dry-runn` runs the real regeneration. Guard before any side effect.
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'regenerate-skill-copies' });

  const DRY = process.argv.includes('--dry-run');
  const CHECK = process.argv.includes('--check');
  const opts = { dryOrCheck: DRY || CHECK };

  warnGithubSkillsDeprecation();
  const skills = loadSkillsOrDie();

  const stats = { writes: 0, deletes: 0, unchanged: 0 };
  const violations = [];

  for (const name of skills) {
    const r = syncSkillToDests(name, opts);
    if (r.violation) violations.push(r.violation);
    stats.writes += r.writes;
    stats.unchanged += r.unchanged;
    stats.deletes += r.deletes;
  }

  stats.deletes += pruneOrphanSkillDirs(new Set(skills), opts);

  const promptStats = syncCopilotPrompts(opts);
  stats.writes += promptStats.writes;
  stats.unchanged += promptStats.unchanged;
  stats.deletes += promptStats.deletes;

  emitVerdict(stats, violations, CHECK);
  process.exit(0);
}

// Test-only exports (mirrors the project's `_internals` convention). The
// underscore signals private; `copyFileIfChanged` is the seam where a dropped
// `--dry-run` once still ran fs.mkdirSync — guarded by
// tests/regenerate-skill-copies.test.mjs.
export const _internals = Object.freeze({ copyFileIfChanged, pruneFilesNotInSource });

// Only run when invoked as a script. Without this guard, importing the module
// for `_internals` would execute main() against the test runner's argv — and
// main() OVERWRITES the real .claude/skills tree and calls process.exit(0), so
// the import would regenerate the tree and kill the test process. Same
// module-scope-main coupling as the sibling generate-plans-index.mjs.
const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) {
  try {
    main();
  } catch (err) {
    // A usage mistake is not a crash: print the flag diagnostic alone (no stack)
    // and exit 2, matching the other guarded CLIs.
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}
