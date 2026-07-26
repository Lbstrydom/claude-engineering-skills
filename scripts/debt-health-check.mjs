#!/usr/bin/env node
/**
 * @fileoverview debt-health — local maintenance check reporting the
 * tech-debt ledger's health (open count, staleness, recurrence, budget
 * violations) with no LLM call and no required env var. Mirrors
 * memory-health.mjs's shape (numeric thresholds via env, --json/--out,
 * 0/1/2 exit contract) so scripts/maintenance-checks.mjs can spawn it
 * exactly like its siblings.
 *
 * Exists because Step 3.6 of /audit-code (`references/debt-capture.md`)
 * captures out-of-scope findings into `.audit/tech-debt.json`
 * automatically on every audit, but nothing ever surfaced the backlog
 * back to an operator: `debt-review.mjs` (clustering) and
 * `debt-budget-check.mjs` (policy gate) were built, tested, and synced
 * to consumers, but referenced by no skill step, no CI gate, and no
 * maintenance check — undiscoverable unless someone reads the CLI source
 * directly. This check is the missing periodic nudge; it never blocks a
 * push (see maintenance-checks.mjs's `attention` semantics).
 *
 * Exit codes:
 *   0 — ledger absent/empty, or all entries within TTL/recurrence/budget
 *   1 — stale and/or recurring and/or budget-violating entries present
 *   2 — op error (corrupt ledger, unknown flag)
 *
 * Usage:
 *   node scripts/debt-health-check.mjs [--json] [--out <path.md>]
 *                                       [--ledger <path>]
 *
 * @module scripts/debt-health-check
 */

import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { readDebtLedger, DEFAULT_DEBT_LEDGER_PATH } from './lib/debt-ledger.mjs';
import {
  findStaleEntries, oldestEntryDays, findRecurringEntries, findBudgetViolations,
} from './lib/debt-review-helpers.mjs';

// Parse a numeric env var, falling back to the default on absent/garbage —
// mirrors memory-health.mjs's numEnv (a bare `Number(x) || fallback` treats
// a genuine 0 threshold as falsy and silently substitutes the default).
function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    process.stderr.write(`debt-health: WARNING — ${name}="${raw}" is not a finite number; using ${fallback}\n`);
    return fallback;
  }
  return n;
}

const TTL_DAYS = numEnv('DEBT_HEALTH_TTL_DAYS', 180);
const RECURRENCE_THRESHOLD = numEnv('DEBT_HEALTH_RECURRENCE_THRESHOLD', 3);

const KNOWN_FLAGS = ['--ledger', '--json', '--out', '--help', '-h'];

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    ledgerPath: get('--ledger') || DEFAULT_DEBT_LEDGER_PATH,
    jsonMode: args.includes('--json'),
    outFile: get('--out'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printUsage() {
  process.stderr.write(`Usage: node scripts/debt-health-check.mjs [options]

Report tech-debt ledger health: open count, staleness, recurrence, budget
violations. No LLM call, no required env — safe to run in any repo state.

Options:
  --ledger <path>   Debt ledger path (default: .audit/tech-debt.json)
  --json            Machine-readable JSON output to stdout
  --out <file>      Write markdown report to file (default: stdout/human)
  --help            Show this message

Tunables (env):
  DEBT_HEALTH_TTL_DAYS               Stale-entry age threshold (default: 180)
  DEBT_HEALTH_RECURRENCE_THRESHOLD   distinctRunCount considered "recurring" (default: 3)

Exit codes: 0=healthy, 1=attention (stale/recurring/over-budget), 2=op-error
`);
}

function renderHuman(summary) {
  const lines = [];
  lines.push(`Tech-debt ledger: ${summary.totalEntries} open entries (oldest: ${summary.oldestEntryDays}d)`);
  if (summary.totalEntries === 0) return lines.join('\n');
  const bySeverity = Object.entries(summary.bySeverity).map(([k, v]) => `${k}:${v}`).join(' ');
  lines.push(`  Severity — ${bySeverity}`);
  lines.push(`  Stale (>${TTL_DAYS}d): ${summary.stale.length}`);
  lines.push(`  Recurring (>=${RECURRENCE_THRESHOLD} runs): ${summary.recurring.length}`);
  if (summary.violations.length > 0) {
    lines.push(`  Budget violations: ${summary.violations.length}`);
    for (const v of summary.violations) {
      lines.push(`    ${v.path}: ${v.count}/${v.budget} (over by ${v.count - v.budget})`);
    }
  }
  if (summary.triggered) {
    lines.push('');
    lines.push('  Run `node scripts/debt-review.mjs --local-only` to cluster into refactor candidates,');
    lines.push('  or `node scripts/debt-resolve.mjs <topicId> --rationale "..."` to close entries that are fixed.');
  }
  return lines.join('\n');
}

function main() {
  let opts;
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'debt-health-check' });
    opts = parseArgs(process.argv);
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  if (opts.help) { printUsage(); process.exit(0); }

  let ledger;
  try {
    ledger = readDebtLedger({ ledgerPath: opts.ledgerPath });
  } catch (err) {
    process.stderr.write(`debt-health: corrupt ledger: ${err.message}\n`);
    process.exit(2);
  }

  const now = new Date();
  const bySeverity = {};
  for (const e of ledger.entries) bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;

  // Budgets are opt-in policy stored on the raw ledger file (not part of the
  // hydrated HydratedDebtEntry shape readDebtLedger returns) — same read as
  // debt-budget-check.mjs's loadBudgets().
  let budgets = {};
  const resolvedLedgerPath = path.resolve(opts.ledgerPath);
  if (fs.existsSync(resolvedLedgerPath)) {
    try {
      budgets = JSON.parse(fs.readFileSync(resolvedLedgerPath, 'utf-8')).budgets || {};
    } catch { /* already surfaced above by readDebtLedger if truly corrupt */ }
  }

  const summary = {
    totalEntries: ledger.entries.length,
    oldestEntryDays: oldestEntryDays(ledger.entries, now),
    bySeverity,
    stale: findStaleEntries(ledger.entries, TTL_DAYS, now),
    recurring: findRecurringEntries(ledger.entries, RECURRENCE_THRESHOLD).map((e) => e.topicId),
    violations: findBudgetViolations(ledger.entries, budgets),
  };
  summary.triggered = summary.stale.length > 0 || summary.recurring.length > 0 || summary.violations.length > 0;

  if (opts.jsonMode) {
    const out = JSON.stringify({ ok: !summary.triggered, ...summary }) + '\n';
    if (opts.outFile) fs.writeFileSync(opts.outFile, out, 'utf-8');
    else process.stdout.write(out);
  } else {
    const out = renderHuman(summary);
    if (opts.outFile) fs.writeFileSync(opts.outFile, out + '\n', 'utf-8');
    else process.stdout.write(out + '\n');
  }

  process.exit(summary.triggered ? 1 : 0);
}

main();
