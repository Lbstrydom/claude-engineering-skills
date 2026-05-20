#!/usr/bin/env node
/**
 * @fileoverview `skills:fit-check` — one-shot diagnostic that labels each
 * skill in the bundle as FITS / PARTIAL / MISMATCH for the current repo's
 * shape. No LLM, no network, no Supabase — pure filesystem inspection.
 *
 * Auto-fired once after a fresh `sync-to-repos` (sync writes a sentinel;
 * if the sentinel is missing the runner prints the card to stdout). Can
 * be re-run any time after stack changes: `npm run skills:fit-check`.
 *
 * Exit codes:
 *   0 — diagnostic ran successfully (FITS/PARTIAL/MISMATCH labels printed)
 *   1 — runtime error reading the repo
 *
 * @module scripts/skills-fit-check
 */

import fs from 'node:fs';
import path from 'node:path';
import { detectShape } from './lib/fit-check/detect.mjs';
import { applyRules, groupByLabel } from './lib/fit-check/rules.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';

const FIT_CHECK_REPORT_PATH = '.skills-fit-check.json';

export function parseArgs(argv) {
  const args = { repoRoot: process.cwd(), json: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo-root') args.repoRoot = argv[++i] || args.repoRoot;
    else if (a === '--json')  args.json = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const HELP = `Usage: skills-fit-check [options]

Diagnostic that labels each skill in the bundle as FITS / PARTIAL / MISMATCH
for the current repo's shape.

Options:
  --repo-root <path>   Repository root (default: cwd)
  --json               Emit machine-readable JSON to stdout instead of the card
  --quiet              Suppress the human-readable card (useful with --json)
  -h, --help           Print this help and exit

Writes a JSON report to ${FIT_CHECK_REPORT_PATH} in the repo root for
downstream tooling (dashboards, CI gates).
`;

export function runFitCheck(args) {
  const repoRoot = path.resolve(args.repoRoot);
  if (!fs.existsSync(repoRoot)) {
    return { exitCode: 1, error: `repo-root not found: ${repoRoot}` };
  }
  const profile = detectShape(repoRoot);
  const verdicts = applyRules(profile);
  const groups = groupByLabel(verdicts);

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoRoot,
    profile,
    verdicts,
    summary: {
      fits:     groups.fits.length,
      partial:  groups.partial.length,
      mismatch: groups.mismatch.length,
    },
  };

  try {
    atomicWriteFileSync(path.join(repoRoot, FIT_CHECK_REPORT_PATH), JSON.stringify(report, null, 2));
  } catch (e) {
    // Report-write is best-effort — never block the stdout output.
    process.stderr.write(`[skills-fit-check] could not persist report: ${e.message}\n`);
  }

  return { exitCode: 0, report };
}

export function renderCard(report) {
  const { profile, verdicts } = report;
  const groups = groupByLabel(verdicts);
  const lines = [];

  const bar = '═'.repeat(63);
  lines.push(bar);
  lines.push('  Skills fit-check — your repo profile');
  lines.push(bar);
  lines.push(`  Stack:         ${profile.stack}${profile.pythonFramework ? ` (${profile.pythonFramework})` : ''}`);
  lines.push(`  Framework:     ${profile.framework}`);
  lines.push(`  UI routes:     ${yn(profile.hasUiRoutes)}`);
  lines.push(`  HTTP boundary: ${yn(profile.hasHttpBoundary)}`);
  lines.push(`  Playwright:    ${yn(profile.hasPlaywright)}`);
  lines.push(`  Test runner:   ${profile.testRunner || '(none detected)'}`);
  lines.push(`  Plans dir:     ${yn(profile.hasPlansDir)}`);
  lines.push(`  Consistency:   manifest=${yn(profile.hasPersonaTestManifest)}  annotations=${yn(profile.hasEngineClaimAnnotations)}`);
  lines.push(bar);

  if (groups.fits.length) {
    lines.push('');
    lines.push('✓ FITS (use directly):');
    for (const v of groups.fits) lines.push(`    ${v.skill.padEnd(42)}  ${v.reason}`);
  }
  if (groups.partial.length) {
    lines.push('');
    lines.push('⚠ PARTIAL (needs setup):');
    for (const v of groups.partial) {
      lines.push(`    ${v.skill}`);
      lines.push(`        ${v.reason}`);
      if (v.setup) lines.push(`        Setup: ${v.setup}`);
    }
  }
  if (groups.mismatch.length) {
    lines.push('');
    lines.push('✗ MISMATCH (skill does not apply to this shape):');
    for (const v of groups.mismatch) {
      lines.push(`    ${v.skill}`);
      lines.push(`        ${v.reason}`);
    }
  }
  lines.push('');
  lines.push('────');
  lines.push(`Wrote ${FIT_CHECK_REPORT_PATH} for downstream tooling.`);
  lines.push('Re-run after stack changes: npm run skills:fit-check');
  return lines.join('\n');
}

function yn(b) { return b ? 'yes' : 'no'; }

// ─── CLI entry ─────────────────────────────────────────────────────────────
const isMain = import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/').split('/').pop() || '');
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const { exitCode, report, error } = runFitCheck(args);
  if (error) {
    process.stderr.write(`[skills-fit-check] ${error}\n`);
    process.exit(exitCode);
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (!args.quiet) {
    process.stdout.write(renderCard(report) + '\n');
  }
  process.exit(exitCode);
}
