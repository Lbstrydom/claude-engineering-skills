#!/usr/bin/env node
/**
 * @fileoverview Check installed skills for staleness (local drift + remote).
 *
 * Usage:
 *   node scripts/check-skill-updates.mjs [--json] [--no-cache]
 */
import path from 'node:path';
import { findRepoRoot, receiptPath, managedFileAbsPath } from './lib/install/surface-paths.mjs';
import { readReceipt } from './lib/install/receipt.mjs';
import { computeFileSha } from './lib/install/conflict-detector.mjs';
import { checkAuditGitignore, ensureAuditGitignore } from './lib/install/gitignore.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';

function parseArgs(argv) {
  const targetIdx = argv.indexOf('--target');
  return {
    json: argv.includes('--json'),
    noCache: argv.includes('--no-cache'),
    target: targetIdx !== -1 && argv[targetIdx + 1] ? path.resolve(argv[targetIdx + 1]) : null,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = args.target || findRepoRoot();

  // BOTH receipts, because there are two surfaces. Reading only the repo one
  // made this command's success path lie: a `--surface claude` install writes
  // ONLY the global receipt, so a fully-installed bundle reported
  // "No install detected" and exited 0 — and in the mixed case it printed
  // "All N managed files are up-to-date" while never looking at
  // ~/.claude/skills, the surface Claude Code actually reads.
  const receipts = [
    { scope: 'repo', file: receiptPath('repo', repoRoot) },
    { scope: 'global', file: receiptPath('global', repoRoot) },
  ].map(r => ({ ...r, ...readReceipt(r.file) }));

  const failed = receipts.find(r => r.error);
  if (failed) {
    console.error(`${R}Error${X}: ${failed.error} (${failed.file})`);
    process.exit(1);
  }

  const present = receipts.filter(r => r.receipt);
  if (present.length === 0) {
    if (args.json) {
      console.log(JSON.stringify({ installed: false, message: 'No install detected' }));
    } else {
      console.log(`${Y}No install receipt found${X} — run the installer first.`);
    }
    process.exit(0);
  }

  // Prefer the repo receipt for run-level metadata, else the global one.
  const receipt = present[0].receipt;
  const managedFiles = present.flatMap(r => r.receipt.managedFiles);

  // Local drift detection
  const driftResults = [];
  let driftCount = 0;
  let matchCount = 0;
  let missingCount = 0;

  for (const f of managedFiles) {
    // Scope-aware: global entries are absolute, repo entries repo-relative.
    const absPath = managedFileAbsPath(f, repoRoot);

    const actual = computeFileSha(absPath);
    const expected = f.sha || f.blockSha;

    if (!actual) {
      driftResults.push({ path: f.path, status: 'missing', expected, actual: null });
      missingCount++;
    } else if (actual === expected) {
      driftResults.push({ path: f.path, status: 'match', expected, actual });
      matchCount++;
    } else {
      driftResults.push({ path: f.path, status: 'drifted', expected, actual });
      driftCount++;
    }
  }

  // Check .gitignore coverage (report-only — use --fix to mutate)
  const fixGitignore = process.argv.includes('--fix');
  const giCheck = checkAuditGitignore(repoRoot);
  if (giCheck.missing.length > 0 && fixGitignore) {
    ensureAuditGitignore(repoRoot);
  }

  // Recompute gitignore status after potential fix so output reflects actual state
  const giFinal = fixGitignore && giCheck.missing.length > 0
    ? checkAuditGitignore(repoRoot)
    : giCheck;

  if (args.json) {
    console.log(JSON.stringify({
      installed: true,
      bundleVersion: receipt.bundleVersion,
      installedAt: receipt.installedAt,
      surface: receipt.surface,
      files: { total: driftResults.length, match: matchCount, drifted: driftCount, missing: missingCount },
      drift: driftResults.filter(r => r.status !== 'match'),
      gitignore: { missing: giFinal.missing, ok: giFinal.missing.length === 0, fixed: fixGitignore && giCheck.missing.length > 0 },
    }, null, 2));
  } else {
    console.log(`${D}Bundle version:${X} ${receipt.bundleVersion}`);
    console.log(`${D}Installed:${X} ${receipt.installedAt}`);
    console.log(`${D}Surface:${X} ${receipt.surface}`);
    console.log('');

    if (driftCount === 0 && missingCount === 0) {
      console.log(`${G}All ${matchCount} managed files are up-to-date${X}`);
    } else {
      if (driftCount > 0) {
        console.log(`${Y}${driftCount} file(s) locally modified:${X}`);
        for (const r of driftResults.filter(d => d.status === 'drifted')) {
          console.log(`  ${Y}~${X} ${r.path}`);
        }
      }
      if (missingCount > 0) {
        console.log(`${R}${missingCount} file(s) missing:${X}`);
        for (const r of driftResults.filter(d => d.status === 'missing')) {
          console.log(`  ${R}x${X} ${r.path}`);
        }
      }
      console.log(`\nTo restore: node .audit-loop/bootstrap.mjs install --surface ${receipt.surface} --force`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`${R}Check error${X}: ${err.message}`);
  process.exit(1);
}
