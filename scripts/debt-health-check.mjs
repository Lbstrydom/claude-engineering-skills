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
 *   0 — ledger present and empty, or all entries within TTL/recurrence/budget,
 *       OR the ledger was UNAVAILABLE (reported `unverifiable`, never clean)
 *   1 — stale and/or recurring and/or budget-violating entries present
 *   2 — op error (corrupt ledger, unknown flag)
 *
 * Usage:
 *   node scripts/debt-health-check.mjs [--json] [--out <path.md>]
 *                                       [--ledger <path>]
 *
 * @module scripts/debt-health-check
 */

import './lib/load-env.mjs';

import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, ArgvError, argOption } from './lib/cli-io.mjs';
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

const KNOWN_FLAGS = ['--ledger', '--json', '--out', '--help', '-h', '--selfcheck-relocation'];

function parseArgs(argv) {
  const args = argv.slice(2);
  // The shared `argOption` from cli-io, not a hand-rolled reader: it handles
  // `--name=value`, refuses to swallow a FOLLOWING FLAG as a value, and stops
  // at `--`. This script kept its own copy while its siblings were migrated in
  // the same change — an inconsistent partial fix the final gate called out,
  // and rightly: the utility was already in use two files away.
  for (const flag of ['--ledger', '--out']) {
    const i = args.indexOf(flag);
    if (i !== -1 && (args[i + 1] === undefined || args[i + 1].startsWith('-'))) {
      throw new ArgvError(`debt-health-check: ${flag} requires a value.`);
    }
  }
  return {
    ledgerPath: argOption('ledger', DEFAULT_DEBT_LEDGER_PATH),
    jsonMode: args.includes('--json'),
    outFile: argOption('out', null),
    help: args.includes('--help') || args.includes('-h'),
  };
}

/**
 * Write `--out`, creating the directory and reporting a failure.
 *
 * An unguarded `writeFileSync` crashes with a raw stack on a missing directory
 * or a permissions error. Both sibling checks already handle this identically
 * (`debt-capture-trail-check.mjs:187-195`); this one did not, which is the
 * inconsistency the final gate flagged — the same fix, applied in the same
 * change, to two of three scripts.
 */
function writeOut(outFile, text) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, text, 'utf-8');
  } catch (err) {
    process.stderr.write(`debt-health: failed to write --out: ${err.message}\n`);
    process.exit(2);
  }
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
  // An UNAVAILABLE ledger is not a healthy one.
  //
  // This printed `Tech-debt ledger: 0 open entries (oldest: 0d)` for an ABSENT
  // ledger, because `readDebtLedger` returned an empty ledger on ENOENT and
  // this file's exit contract documented "ledger absent/empty" as one state.
  // `.audit/` is gitignored, so a fresh clone, CI, or a linked worktree took
  // that path BY DEFAULT and read as a clean bill of health.
  //
  // Both sibling checks already distinguished the two and credited THIS file
  // with the discipline it lacked (debt-ledger-claims-check.mjs:151-154 —
  // "same as debt-health-check.mjs"). Vocabulary matches
  // check-stale-skill-surface.mjs:203-206.
  if (summary.available === false) {
    lines.push(`Tech-debt ledger: UNVERIFIABLE — ${summary.reason}.`);
    lines.push('  Not reported as clean: nothing was read. Run where the ledger exists,');
    lines.push('  or `node scripts/debt-reconcile.mjs` to compare against the private store.');
    return lines.join('\n');
  }
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
  // CLI smoke contract (AGENTS.md): proves the module's imports survive
  // relocation to a consumer's scripts/.claude-skills/. Required now that
  // this script is in the sync bundle.
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
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
    available: ledger.available !== false,
    reason: ledger.reason ?? null,
    totalEntries: ledger.entries.length,
    oldestEntryDays: oldestEntryDays(ledger.entries, now),
    bySeverity,
    stale: findStaleEntries(ledger.entries, TTL_DAYS, now),
    recurring: findRecurringEntries(ledger.entries, RECURRENCE_THRESHOLD).map((e) => e.topicId),
    violations: findBudgetViolations(ledger.entries, budgets),
  };
  summary.triggered = summary.stale.length > 0 || summary.recurring.length > 0 || summary.violations.length > 0;

  if (opts.jsonMode) {
    // `ok:false` when nothing was measured — a machine consumer reading `ok`
    // must not get a green for an unread ledger, which is the human-output
    // defect restated in JSON. Exit stays 0: this is an advisory maintenance
    // nudge (maintenance-checks.mjs `attention` semantics), and an
    // unverifiable input must not start gating what a clean one never gated.
    const measured = summary.available !== false;
    const out = JSON.stringify({
      ok: measured ? !summary.triggered : false,
      verdict: !measured ? 'unverifiable' : (summary.triggered ? 'attention' : 'ok'),
      ...summary,
      totalEntries: measured ? summary.totalEntries : null,
      oldestEntryDays: measured ? summary.oldestEntryDays : null,
    }) + '\n';
    if (opts.outFile) writeOut(opts.outFile, out);
    else process.stdout.write(out);
  } else {
    const out = renderHuman(summary);
    if (opts.outFile) writeOut(opts.outFile, `${out}\n`);
    else process.stdout.write(`${out}\n`);
  }

  // Unavailable never escalates: it is not an "attention" state, it is the
  // absence of a measurement.
  process.exit(summary.available !== false && summary.triggered ? 1 : 0);
}

main();
