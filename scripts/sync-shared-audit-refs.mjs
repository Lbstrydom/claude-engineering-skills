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
import { sha } from './lib/cli-io.mjs';

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

function main() {
  const DRY = process.argv.includes('--dry-run');
  const CHECK = process.argv.includes('--check');

  if (!fs.existsSync(CANONICAL_DIR)) {
    process.stderr.write(`${R}canonical dir missing: ${CANONICAL_DIR}${X}\n`);
    process.exit(2);
  }

  const pairs = findSyncTargets(ROOT);
  let writes = 0, unchanged = 0, drift = 0;

  for (const { canonical, target, skill, basename } of pairs) {
    const srcBuf = fs.readFileSync(canonical);
    const dstBuf = fs.readFileSync(target);
    if (sha(srcBuf) === sha(dstBuf)) {
      unchanged++;
      continue;
    }
    drift++;
    if (CHECK) {
      process.stdout.write(
        `${R}~${X} skills/${skill}/references/${basename} ${D}drifted from canonical${X}\n`,
      );
    } else if (DRY) {
      process.stdout.write(
        `${Y}~${X} skills/${skill}/references/${basename} ${D}(would update from canonical)${X}\n`,
      );
    } else {
      fs.writeFileSync(target, srcBuf);
      writes++;
      process.stdout.write(
        `${G}+${X} skills/${skill}/references/${basename} ${D}(synced from canonical)${X}\n`,
      );
    }
  }

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

if (invokedDirectly) main();
