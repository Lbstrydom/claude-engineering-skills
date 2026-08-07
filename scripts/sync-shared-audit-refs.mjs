#!/usr/bin/env node
/**
 * @fileoverview Sync shared audit-loop reference files from a single
 * canonical source under `docs/audit/shared-references/` to each consuming
 * skill's `references/` directory.
 *
 * Why: Phase 1 of audit-loop-skill-split ships two reference files
 * (ledger-format.md, gemini-gate.md) that are SHARED between /audit-plan
 * and /audit-code. Without a single source of truth, edits to one would
 * silently drift from the other. This script enforces byte-equality.
 *
 * Discovery is automatic: each consumer skill that wants a shared ref simply
 * has a file at `skills/<name>/references/<canonical-basename>`. The script
 * walks `skills/*\/references/` and overwrites any matching file from the
 * canonical. Skills that don't have the file are unaffected.
 *
 * Usage:
 *   node scripts/sync-shared-audit-refs.mjs              # sync canonical → targets
 *   node scripts/sync-shared-audit-refs.mjs --check      # exit 1 on any drift
 *   node scripts/sync-shared-audit-refs.mjs --dry-run    # report, no writes
 *
 * Exit codes:
 *   0  success (sync mode) OR no drift (check mode)
 *   1  drift detected (check mode)
 *   2  canonical source missing or unreadable
 *
 * @module scripts/sync-shared-audit-refs
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha, assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CANONICAL_DIR = path.join(ROOT, 'docs', 'audit', 'shared-references');
const SKILLS_DIR = path.join(ROOT, 'skills');

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', X = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m';


/**
 * Expected consumers per canonical file. Skills listed here MUST have the
 * canonical reference at `skills/<skill>/references/<basename>`; --check mode
 * fails if any expected target is missing. Other skills that happen to have
 * the file are also auto-discovered and synced (so unregistered consumers
 * stay current without registry edits).
 *
 * Update this map when a new skill needs a shared audit reference; the
 * sync will then bootstrap the file on first run rather than silently
 * skipping (this closes the gap raised by Gemini final review).
 */
export const EXPECTED_CONSUMERS = Object.freeze({
  'ledger-format.md': ['audit-plan', 'audit-code'],
  'gemini-gate.md': ['audit-plan', 'audit-code'],
  'verification-discipline.md': [
    'investigate', 'audit-code', 'ux-lock', 'ship', 'explain', 'plan', 'audit-plan',
  ],
});

/**
 * For each canonical file, return the (canonical, target) pairs to sync.
 *
 * Two sources combined:
 *   1. EXPECTED_CONSUMERS — skills that must have the file. Always returned,
 *      even when the target file does not yet exist (bootstrap case).
 *   2. Auto-discovery — any other `skills/<skill>/references/<basename>`
 *      already on disk. Keeps unregistered consumers in sync.
 *
 * Each pair carries `expected: true|false` so callers can distinguish the
 * bootstrap targets from the opportunistic ones.
 */
export function findSyncTargets(rootDir = ROOT) {
  const canonicalDir = path.join(rootDir, 'docs', 'audit', 'shared-references');
  const skillsDir = path.join(rootDir, 'skills');
  if (!fs.existsSync(canonicalDir)) return [];

  // Sort for deterministic output across runs / OSes.
  const canonicals = fs.readdirSync(canonicalDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => ({ basename: f, abs: path.join(canonicalDir, f) }));

  const pairs = [];
  const seen = new Set();

  // Step 1: registry-driven targets (always emit, even if missing on disk)
  for (const c of canonicals) {
    const expectedSkills = EXPECTED_CONSUMERS[c.basename] || [];
    for (const skill of expectedSkills) {
      const target = path.join(skillsDir, skill, 'references', c.basename);
      pairs.push({ canonical: c.abs, target, skill, basename: c.basename, expected: true });
      seen.add(target);
    }
  }

  // Step 2: auto-discover other consumers (existing files only)
  if (fs.existsSync(skillsDir)) {
    const allSkills = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
    for (const skill of allSkills) {
      const refsDir = path.join(skillsDir, skill, 'references');
      if (!fs.existsSync(refsDir)) continue;
      for (const c of canonicals) {
        const target = path.join(refsDir, c.basename);
        if (seen.has(target)) continue;
        if (fs.existsSync(target)) {
          pairs.push({ canonical: c.abs, target, skill, basename: c.basename, expected: false });
        }
      }
    }
  }

  return pairs;
}

/**
 * Every flag this CLI reads. Declared beside `main()` and asserted inside it —
 * this module is imported by `tests/sync-shared-audit-refs.test.mjs` for its
 * exports, so throwing at module scope would break that import.
 *
 * Neither flag takes a value; both are booleans.
 */
const KNOWN_FLAGS = ['--check', '--dry-run'];

/**
 * Apply (or report on) a set of canonical→target pairs.
 *
 * Split out of `main()` so the BOOTSTRAP path is directly testable against a
 * temp repo: `main()` resolves pairs from the module-level `ROOT`, which is
 * pinned to this checkout, so nothing could previously exercise a first-run
 * write. That is precisely how the bug below shipped undetected.
 *
 * **The bug this encodes a fix for.** `findSyncTargets` emits registry-driven
 * pairs "even if missing on disk" — that is what makes registering a new
 * consumer bootstrap its file, exactly as this module's header promises. But
 * the old loop called `fs.readFileSync(target)` unconditionally, so the first
 * missing target threw ENOENT and killed the run before anything was written.
 * The documented bootstrap had never once executed, and `--check` crashed
 * rather than reporting DRIFT. A missing target is now an EMPTY buffer — i.e.
 * drift, which every branch already handled correctly.
 *
 * @param {Array<{canonical:string,target:string,skill:string,basename:string}>} pairs
 * @param {{check?:boolean, dry?:boolean}} [opts]
 * @returns {{writes:number, unchanged:number, drift:number, bootstrapped:number, lines:string[]}}
 */
export function syncPairs(pairs, { check = false, dry = false } = {}) {
  let writes = 0, unchanged = 0, drift = 0, bootstrapped = 0;
  const lines = [];

  for (const { canonical, target, skill, basename } of pairs) {
    const srcBuf = fs.readFileSync(canonical);
    const exists = fs.existsSync(target);
    const dstBuf = exists ? fs.readFileSync(target) : Buffer.alloc(0);
    if (exists && sha(srcBuf) === sha(dstBuf)) {
      unchanged++;
      continue;
    }
    drift++;
    if (!exists) bootstrapped++;
    if (check) {
      lines.push(`${R}~${X} skills/${skill}/references/${basename} ${D}${
        exists ? 'drifted from canonical' : 'MISSING — never bootstrapped'}${X}\n`);
    } else if (dry) {
      lines.push(`${Y}~${X} skills/${skill}/references/${basename} ${D}(would ${
        exists ? 'update from canonical' : 'bootstrap'})${X}\n`);
    } else {
      // `skills/<skill>/references/` may not exist at all when this is a
      // skill's FIRST shared reference (true for explain and audit-plan).
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, srcBuf);
      writes++;
      // A first write and a re-sync are different events; say which.
      lines.push(`${G}+${X} skills/${skill}/references/${basename} ${D}(${
        exists ? 'synced from canonical' : 'bootstrapped'})${X}\n`);
    }
  }

  return { writes, unchanged, drift, bootstrapped, lines };
}

function main() {
  // The default path OVERWRITES each consumer skill's reference file from the
  // canonical, so `--check`/`--dry-run` are safety flags over a mutating
  // default: a dropped `--chek` performs the real sync. Guard first.
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'sync-shared-audit-refs' });

  const DRY = process.argv.includes('--dry-run');
  const CHECK = process.argv.includes('--check');

  if (!fs.existsSync(CANONICAL_DIR)) {
    process.stderr.write(`${R}canonical dir missing: ${CANONICAL_DIR}${X}\n`);
    process.exit(2);
  }

  const pairs = findSyncTargets(ROOT);
  const { writes, unchanged, drift, lines } = syncPairs(pairs, { check: CHECK, dry: DRY });
  for (const line of lines) process.stdout.write(line);

  const verdict = drift === 0 ? 'IN SYNC' : (CHECK ? 'DRIFT' : 'CHANGES');
  process.stdout.write(
    `\n${B}sync-shared-audit-refs:${X} ${pairs.length} pair(s), ${writes} write, ${unchanged} unchanged, ${drift} drifted — ${verdict}\n`,
  );

  if (CHECK && drift > 0) {
    process.stderr.write(
      `${R}Shared reference drift detected. Run: node scripts/sync-shared-audit-refs.mjs${X}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const invokedDirectly = (() => {
  try {
    const metaPath = new URL(import.meta.url).pathname.toLowerCase();
    const argvPath = process.argv[1] ? new URL(`file://${process.argv[1].replaceAll(/\\/g, '/')}`).pathname.toLowerCase() : '';
    return metaPath.endsWith('/sync-shared-audit-refs.mjs') && argvPath.endsWith('/sync-shared-audit-refs.mjs');
  } catch { return false; }
})();

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    // A usage mistake is not a crash: print the flag diagnostic alone (no
    // stack) and exit 2, matching the other guarded CLIs.
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}
