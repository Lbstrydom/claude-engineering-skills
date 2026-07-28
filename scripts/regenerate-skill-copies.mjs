#!/usr/bin/env node
/**
 * @fileoverview One-way generation: byte-copy skills from the authoritative
 * `skills/` tree to `.claude/skills/`.
 *
 * - The top-level `skills/` directory is the ONLY place authors edit.
 * - `.claude/skills/` is always generated — never edited directly.
 * - `.github/skills/` is **deprecated** as of Phase 4 of ai-context-sync.
 *   VS Code Copilot Agent Skills DOES discover it (and wins on a name
 *   collision against `.claude/skills/` — see
 *   `scripts/check-stale-skill-surface.mjs`'s fileoverview), which is
 *   exactly why this generator no longer just warns about it: a
 *   pre-existing `.github/skills/` tree is **actively removed** on every
 *   run (respecting `--dry-run`/`--check`, which report the would-be
 *   removal without touching disk). Removed 2026-07-28
 *   (docs/plans/refactor-skill-governance.md): this generator no longer
 *   supports writing that surface at all.
 * - Prunes files in the destination that are no longer in the source so
 *   destinations exactly mirror source.
 *
 * Uses `scripts/lib/skill-packaging.mjs` for the file allowlist — non-markdown
 * and dotfile files never propagate.
 *
 * Usage:
 *   node scripts/regenerate-skill-copies.mjs           # regenerate .claude/skills/; remove stale .github/skills/
 *   node scripts/regenerate-skill-copies.mjs --dry-run # report, no writes
 *   node scripts/regenerate-skill-copies.mjs --check   # exit 1 if out of sync
 *
 * Exit codes:
 *   0 = success (or --check: in sync)
 *   1 = --check: destinations differ from source; or a stale .github/skills/
 *       removal failed (permissions, locked file) — halts before any copy
 *   2 = bad input / allowlist violation
 *
 * @module scripts/regenerate-skill-copies
 */
import fs from 'node:fs';
import path from 'node:path';
import { enumerateSkillFiles, listSkillNames } from './lib/skill-packaging.mjs';
import { sha, assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_ROOT = path.join(ROOT, 'skills');

const DEST_ROOTS = [path.join(ROOT, '.claude', 'skills')];

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', X = '\x1b[0m', D = '\x1b[2m', B = '\x1b[1m';


// ── main() helpers — keep main() under cognitive-complexity 15 ────────────

/** Thrown by `removeStaleGithubSkills` on a real removal failure — caught at
 * the `isMain` boundary, mirroring the existing `ArgvError` pattern below, so
 * the failure path is a plain throw (testable in-process) rather than a
 * `process.exit` buried inside a helper. */
class GithubSkillsRemovalError extends Error {
  constructor(message) {
    super(message);
    this.code = 'GITHUB_SKILLS_REMOVAL_FAILED';
    this.name = 'GithubSkillsRemovalError';
  }
}

/**
 * Actively remove a pre-existing `.github/skills/` tree. This is a required
 * PRECONDITION — called before any `.claude/skills/` copy step runs, never
 * interleaved with it, so a failure here halts before any write, rather than
 * leaving a half-deleted stale tree next to a half-copied live one.
 *
 * `--dry-run`/`--check` report the would-be removal and never call `rmSync`,
 * matching every other mutation in this script. A missing directory is a
 * silent no-op success (idempotent, not an error). A real removal failure
 * (locked file, permissions) throws `GithubSkillsRemovalError` — never
 * silently swallowed, never allowed to proceed to the copy step.
 *
 * **Audit-code round-1 H4/M4/H8 (real bug, fixed)**: the inspection step
 * used to be `if (!fs.existsSync(ghSkillsDir)) return 0`, but `existsSync`
 * converts EVERY stat failure — including `EACCES`/`EPERM` — into `false`,
 * identically to a genuinely-absent path. That would silently treat an
 * unreadable `.github/skills/` as "nothing to remove," bypassing this whole
 * function's stated precondition — the exact same class of bug already
 * fixed in `check-stale-skill-surface.mjs`'s `listSurfaceNames`. Fixed by
 * probing with `lstatSync` in a try/catch: `ENOENT` is the genuine-absence
 * case; any other code throws `GithubSkillsRemovalError` before any copy
 * step, same as a real removal failure.
 *
 * @returns {number} delete count to fold into `stats.deletes` (0 or 1 — the
 *   whole-tree removal is one unit, matching `--check`'s exit-1-on-pending-
 *   changes contract: it must count, or a pending removal reads as "in sync").
 */
function removeStaleGithubSkills(opts, {
  rmSyncFn = fs.rmSync,
  lstatFn = fs.lstatSync,
  ghSkillsDir = path.join(ROOT, '.github', 'skills'), // injectable so tests never touch the real repo's .github/
} = {}) {
  try {
    lstatFn(ghSkillsDir);
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw new GithubSkillsRemovalError(
      `cannot inspect deprecated ${path.relative(ROOT, ghSkillsDir)}: ${err.message} — ` +
      `check filesystem permissions, then retry.`,
    );
  }

  if (opts.dryOrCheck) {
    process.stdout.write(`${R}-${X} ${path.relative(ROOT, ghSkillsDir)}/ ${D}(deprecated — would remove)${X}\n`);
    return 1;
  }

  try {
    rmSyncFn(ghSkillsDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (err) {
    throw new GithubSkillsRemovalError(
      `failed to remove deprecated ${path.relative(ROOT, ghSkillsDir)}: ${err.message} — ` +
      `close any program holding a file open under that path, or check filesystem permissions, then retry.`,
    );
  }
  process.stdout.write(`${R}-${X} ${path.relative(ROOT, ghSkillsDir)}/ ${D}(removed deprecated .github/skills)${X}\n`);
  return 1;
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

/**
 * Gemini gate shadow finding #1 (real bug, fixed): `removeStaleGithubSkills`
 * ran as the FIRST step in `main()` — before this validation existed in that
 * position, a repo with a missing/empty `skills/` tree, or a single skill
 * containing a disallowed file, would permanently `rmSync -r` the deprecated
 * `.github/skills/` tree and only THEN discover the source problem and exit
 * 2 — destroying the deprecated surface while writing nothing new. Every
 * skill's allowlist is validated (read-only — `enumerateSkillFiles` performs
 * no writes) before ANY destructive or write step runs.
 */
function validateAllSkillsOrDie(skills, srcRoot = SRC_ROOT) {
  const violations = [];
  for (const name of skills) {
    try {
      enumerateSkillFiles(path.join(srcRoot, name), { strict: true });
    } catch (err) {
      violations.push(`${name}: ${err.message}`);
    }
  }
  if (violations.length > 0) {
    for (const v of violations) process.stderr.write(`${R}${v}${X}\n`);
    process.exit(2);
  }
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
 * Every flag this CLI reads. No flag here takes a value; both are booleans.
 */
const KNOWN_FLAGS = ['--dry-run', '--check'];

function main() {
  // This CLI OVERWRITES the generated `.claude/skills/` tree by default, so
  // `--dry-run`/`--check` are safety flags over a mutating default: a dropped
  // `--dry-runn` runs the real regeneration. Guard before any side effect.
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'regenerate-skill-copies' });

  const DRY = process.argv.includes('--dry-run');
  const CHECK = process.argv.includes('--check');
  const opts = { dryOrCheck: DRY || CHECK };

  const stats = { writes: 0, deletes: 0, unchanged: 0 };

  // Gemini gate shadow finding #1 — the SOURCE must be validated before ANY
  // destructive step. loadSkillsOrDie (does skills/ exist, non-empty?) and
  // validateAllSkillsOrDie (does every skill's allowlist pass?) both run
  // BEFORE removeStaleGithubSkills, so a bad source tree is never discovered
  // only after the deprecated surface has already been destroyed.
  const skills = loadSkillsOrDie();
  validateAllSkillsOrDie(skills);

  // Required precondition — before any copy step; halts (exit 1) on a real
  // removal failure rather than proceeding into a half-deleted/half-copied state.
  stats.deletes += removeStaleGithubSkills(opts);

  const violations = [];

  for (const name of skills) {
    const r = syncSkillToDests(name, opts);
    if (r.violation) violations.push(r.violation);
    stats.writes += r.writes;
    stats.unchanged += r.unchanged;
    stats.deletes += r.deletes;
  }

  stats.deletes += pruneOrphanSkillDirs(new Set(skills), opts);

  emitVerdict(stats, violations, CHECK);
  process.exit(0);
}

// Test-only exports (mirrors the project's `_internals` convention). The
// underscore signals private; `copyFileIfChanged` is the seam where a dropped
// `--dry-run` once still ran fs.mkdirSync — guarded by
// tests/regenerate-skill-copies.test.mjs.
export const _internals = Object.freeze({ copyFileIfChanged, pruneFilesNotInSource, removeStaleGithubSkills, validateAllSkillsOrDie });

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
    // A real removal failure — halted before any copy step (main() has no
    // try/catch around removeStaleGithubSkills, so this throw never reached
    // loadSkillsOrDie()/the copy loop). Print the message alone, no stack.
    if (err instanceof GithubSkillsRemovalError || err?.code === 'GITHUB_SKILLS_REMOVAL_FAILED') {
      process.stderr.write(`${R}[regenerate] ${err.message}${X}\n`);
      process.exit(1);
    }
    throw err;
  }
}
