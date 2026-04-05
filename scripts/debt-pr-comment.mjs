#!/usr/bin/env node
/**
 * @fileoverview Phase D.6 — generate GitHub PR comment body surfacing debt
 * that overlaps the PR's changed files.
 *
 * Reads the committed debt ledger from the base branch + computes the intersection
 * with the PR's changed files. Outputs markdown with a sticky marker so the
 * GitHub Action can update an existing comment rather than spamming.
 *
 * The comment has two sections:
 *   1. Touched-code debt: entries whose affectedFiles overlap changed files
 *   2. Recurring-debt summary (collapsed <details>): entries with
 *      distinctRunCount >= threshold, regardless of PR scope — team signal.
 *
 * Exit codes (Phase D CLI contract §2.13):
 *   0 — success (including zero-touched no-op)
 *   1 — operational error (corrupt ledger, bad input)
 *   2 — not used
 *
 * Usage:
 *   node scripts/debt-pr-comment.mjs --changed <file1,file2,...> [options]
 *   node scripts/debt-pr-comment.mjs --changed-file <path-to-list>
 *
 * Options:
 *   --changed <list>         Comma-separated changed files (from git diff)
 *   --changed-file <path>    Read changed files from newline-delimited file
 *   --ledger <path>          Debt ledger (default: .audit/tech-debt.json)
 *   --events <path>          Event log (for distinctRunCount hydration)
 *   --recurring-threshold N  Surface recurring debt ≥ N runs (default: 3)
 *   --out <file>             Write markdown to file (default: stdout)
 *   --no-op-if-empty         Exit 0 with no output when nothing to report
 *   --pr <num>               PR number (for display only)
 *
 * @module scripts/debt-pr-comment
 */

import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

import fs from 'node:fs';
import { readDebtLedger, DEFAULT_DEBT_LEDGER_PATH } from './lib/debt-ledger.mjs';
import { DEFAULT_DEBT_EVENTS_PATH } from './lib/debt-events.mjs';
import { findRecurringEntries } from './lib/debt-review-helpers.mjs';

/** Magic marker that identifies our sticky PR comment. */
export const STICKY_MARKER = '<!-- audit-loop:debt-comment -->';

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    changed: get('--changed'),
    changedFile: get('--changed-file'),
    ledgerPath: get('--ledger') || DEFAULT_DEBT_LEDGER_PATH,
    eventsPath: get('--events') || DEFAULT_DEBT_EVENTS_PATH,
    recurringThreshold: parseInt(get('--recurring-threshold') || '3', 10),
    outFile: get('--out'),
    noOpIfEmpty: args.includes('--no-op-if-empty'),
    prNumber: get('--pr'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printUsage() {
  console.error(`Usage: node scripts/debt-pr-comment.mjs --changed <files> [options]

Generate a sticky PR comment surfacing debt that overlaps the PR's changed files.

Input (one required):
  --changed <list>         Comma-separated changed files
  --changed-file <path>    Read changed files from newline-delimited file

Options:
  --ledger <path>          Debt ledger (default: .audit/tech-debt.json)
  --events <path>          Event log (default: .audit/local/debt-events.jsonl)
  --recurring-threshold N  Surface recurring debt ≥ N runs (default: 3)
  --out <file>             Write to file (default: stdout)
  --no-op-if-empty         Exit 0 with no output when nothing to report
  --pr <num>               PR number (display only)

Exit codes: 0=ok, 1=op-error
`);
}

// ── Computing touched debt ──────────────────────────────────────────────────

/**
 * Find debt entries whose affectedFiles overlap the changed set.
 * @param {object[]} entries - hydrated debt entries
 * @param {string[]} changedFiles
 * @returns {object[]}
 */
export function findTouchedDebt(entries, changedFiles) {
  if (!entries?.length || !changedFiles?.length) return [];
  const changedSet = new Set(changedFiles.map(f => f.replace(/\\/g, '/').replace(/^\.?\//, '')));
  return entries.filter(e => {
    const files = e.affectedFiles || [];
    return files.some(f => {
      const norm = String(f).replace(/\\/g, '/').replace(/^\.?\//, '');
      // Match either by equality OR substring (PR diff paths may be partial)
      return changedSet.has(norm)
        || [...changedSet].some(c => c.endsWith(norm) || norm.endsWith(c));
    });
  });
}

/** Group entries by their first affected file for display. */
function groupTouchedByFile(entries) {
  const byFile = new Map();
  for (const e of entries) {
    const primary = (e.affectedFiles || [])[0] || 'unknown';
    if (!byFile.has(primary)) byFile.set(primary, []);
    byFile.get(primary).push(e);
  }
  return byFile;
}

// ── Markdown rendering ──────────────────────────────────────────────────────

function renderEntryLine(e) {
  const sevBadge = e.severity === 'HIGH' ? 'H' : e.severity === 'MEDIUM' ? 'M' : 'L';
  const occ = (e.distinctRunCount ?? 0);
  const occText = occ > 0 ? `, occurrences: ${occ}` : '';
  const deferredAt = (e.deferredAt || '').slice(0, 10);
  const deferredDateText = deferredAt ? `, deferred ${deferredAt}` : '';
  const owner = e.owner ? ` _(${e.owner})_` : '';
  return `- \`${e.topicId.slice(0, 8)}\` ${sevBadge} — ${e.category}${owner} (${e.deferredReason}${occText}${deferredDateText})`;
}

export function renderPrComment({
  touchedDebt,
  recurringDebt,
  totalEntries,
  prNumber,
}) {
  const lines = [STICKY_MARKER];
  const touchedCount = touchedDebt.length;
  const recurringCount = recurringDebt.length;

  if (touchedCount === 0 && recurringCount === 0) {
    lines.push('## ✓ No tracked debt overlaps this PR');
    lines.push('');
    lines.push(`_(${totalEntries} entries in the debt ledger)_`);
    return lines.join('\n');
  }

  // Main section: touched debt
  if (touchedCount > 0) {
    lines.push(`## 📋 Touched code has ${touchedCount} deferred debt ${touchedCount === 1 ? 'entry' : 'entries'}`);
    lines.push('');
    const byFile = groupTouchedByFile(touchedDebt);
    const sortedFiles = [...byFile.keys()].sort((a, b) => byFile.get(b).length - byFile.get(a).length);
    for (const file of sortedFiles) {
      const entries = byFile.get(file);
      const fileTotal = totalEntries; // could filter per-file but keep it simple
      lines.push(`**${file}** (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} touched, ${fileTotal} total across ledger)`);
      for (const e of entries) {
        lines.push(renderEntryLine(e));
      }
      lines.push('');
    }
    lines.push('> These are pre-existing concerns you may want to address as part of this PR.');
    lines.push('> Run `node scripts/debt-review.mjs --out /tmp/review.md` for a structured refactor plan.');
    lines.push('');
  } else {
    lines.push(`## ✓ No tracked debt overlaps this PR${prNumber ? ` (#${prNumber})` : ''}`);
    lines.push('');
  }

  // Secondary section (collapsed): recurring debt, regardless of PR scope
  if (recurringCount > 0) {
    lines.push(`<details>`);
    lines.push(`<summary>⚠️ Recurring debt (${recurringCount} ${recurringCount === 1 ? 'entry' : 'entries'} with ≥3 occurrences, repo-wide)</summary>`);
    lines.push('');
    lines.push('Consider a dedicated refactor pass for these:');
    for (const e of recurringDebt.slice(0, 20)) {
      lines.push(renderEntryLine(e));
    }
    if (recurringDebt.length > 20) {
      lines.push(`- _… and ${recurringDebt.length - 20} more_`);
    }
    lines.push('');
    lines.push('</details>');
  }

  return lines.join('\n');
}

// ── Input loading ───────────────────────────────────────────────────────────

function loadChangedFiles(opts) {
  if (opts.changed) {
    return opts.changed.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (opts.changedFile) {
    if (!fs.existsSync(opts.changedFile)) {
      throw new Error(`--changed-file not found: ${opts.changedFile}`);
    }
    return fs.readFileSync(opts.changedFile, 'utf-8')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
  }
  throw new Error('--changed or --changed-file required');
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printUsage(); process.exit(0); }

  let changedFiles;
  try {
    changedFiles = loadChangedFiles(opts);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  let ledger;
  try {
    ledger = readDebtLedger({ ledgerPath: opts.ledgerPath, eventsPath: opts.eventsPath });
  } catch (err) {
    console.error(`Error reading ledger: ${err.message}`);
    process.exit(1);
  }

  const touchedDebt = findTouchedDebt(ledger.entries, changedFiles);
  const recurringDebt = findRecurringEntries(ledger.entries, opts.recurringThreshold);

  if (opts.noOpIfEmpty && touchedDebt.length === 0 && recurringDebt.length === 0) {
    process.stderr.write('  [debt-pr-comment] no-op (no touched or recurring debt)\n');
    process.exit(0);
  }

  const body = renderPrComment({
    touchedDebt,
    recurringDebt,
    totalEntries: ledger.entries.length,
    prNumber: opts.prNumber,
  });

  if (opts.outFile) {
    fs.writeFileSync(opts.outFile, body + '\n', 'utf-8');
    process.stderr.write(`  [debt-pr-comment] wrote ${body.length} chars to ${opts.outFile}\n`);
  } else {
    process.stdout.write(body + '\n');
  }
  process.exit(0);
}

// Only run main() when this file is invoked directly as a CLI, not when imported
// by tests. import.meta.url is a file:// URL; process.argv[1] is the script path.
const isDirectInvocation = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
  || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isDirectInvocation) {
  main();
}
