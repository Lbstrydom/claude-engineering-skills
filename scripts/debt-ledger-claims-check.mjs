#!/usr/bin/env node
/**
 * @fileoverview Local maintenance check — verifies that any `docs/plans/*.md`
 * claim of the shape "captured to / named in the debt ledger" carries a
 * `topicId` that actually resolves in `.audit/tech-debt.json`. Sibling to
 * `debt-health-check.mjs` (reads the same ledger, and this file's `debt-*.mjs`
 * naming follows its convention deliberately — see the Naming note below) and
 * `check-accepted-debt.mjs` (same "checked vs. explicitly unverifiable"
 * discipline). Full scope, exclusions, and why this never blocks a push:
 * `scripts/lib/debt-ledger-claim-check.mjs`'s module header.
 *
 * **Naming — `debt-ledger-claims-check.mjs`, not `check-debt-ledger-claims.mjs`.**
 * The latter is the natural name (and was this file's first draft) but
 * `scripts/check-*.mjs` domain-maps to `install`, while this file's own
 * dependencies (`lib/debt-ledger-claim-check.mjs`, `lib/debt-ledger.mjs`)
 * domain-map to `tech-debt` via `scripts/lib/debt-*.mjs` — an undeclared
 * `install -> tech-debt` edge, caught by `tests/arm-vocabulary-layering.test.mjs`
 * only once the file was tracked (a `git ls-files`-driven oracle can't see an
 * untracked file — see that test's own docstring on the vacuous-pass risk this
 * is a live instance of). `scripts/debt-*.mjs` already domain-maps to
 * `tech-debt`, matching `debt-health-check.mjs`'s own name; renaming to match
 * puts this file in the same domain as what it imports, with no
 * `allowedDeps` edit needed — refactor over retag over declare, per this
 * repo's own stated preference order.
 *
 * `main()` is a thin process adapter over the pure `executeCheck()` — it is
 * the only piece that touches `process.argv`, reads the plans directory and
 * the ledger from disk, and reports the outcome.
 *
 * Exit codes:
 *   0 — clean (no unresolvable claims), or the ledger isn't available
 *       locally (reported plainly as unverifiable, never as "clean")
 *   1 — attention (a claim's topicId isn't in the ledger)
 *   2 — op error (plans dir unreadable, corrupt ledger, unknown flag)
 *
 * Usage:
 *   node scripts/debt-ledger-claims-check.mjs [--json] [--out <path>]
 *
 * @module scripts/debt-ledger-claims-check
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError, argOption, hasFlag, finishAndExit } from './lib/cli-io.mjs';
import { executeCheck, readPlanDocs, DEFAULT_PLANS_DIR } from './lib/debt-ledger-claim-check.mjs';
import { readDebtLedger, DEFAULT_DEBT_LEDGER_PATH } from './lib/debt-ledger.mjs';
import { findRepoRootFromScript } from './lib/assert-repo-root.mjs';

const KNOWN_FLAGS = ['--json', '--out', '--help', '-h'];

function parseArgs(argv) {
  const args = argv.slice(2);
  const outFlagPresent = args.some((a) => a === '--out' || a.startsWith('--out='));
  const outFile = argOption('out');
  return {
    jsonMode: hasFlag('json'),
    outFile,
    help: hasFlag('help') || args.includes('-h'),
    outFlagWithoutValue: outFlagPresent && !outFile,
  };
}

function printUsage() {
  process.stderr.write(`Usage: node scripts/debt-ledger-claims-check.mjs [options]

Verify that "captured to / named in the debt ledger" claims in docs/plans/*.md
carry a topicId that actually resolves in .audit/tech-debt.json. Local-only —
never blocks a push (the ledger is gitignored, machine-local state, absent in
the pre-push clean-checkout sandbox).

Options:
  --json         Machine-readable JSON envelope to stdout
  --out <file>   Write the selected rendering to file instead of stdout
  --help         Show this message

Exit codes: 0=clean or unverifiable, 1=attention, 2=op-error
`);
}

function renderHuman(result) {
  const lines = [];
  lines.push('Debt-ledger claim check (scripts/debt-ledger-claims-check.mjs)');
  lines.push('');

  if (!result.ledgerAvailable) {
    lines.push(`· ${result.claimingDocs} document(s) make a ledger-capture claim — UNVERIFIABLE (no local ${DEFAULT_DEBT_LEDGER_PATH}).`);
    lines.push('  Not reported as clean: nothing was checked. Run again where the ledger is present to verify.');
    for (const r of result.results) lines.push(`  · ${r.relPath} — ${r.claims.length} claim line(s)`);
    lines.push('');
    lines.push('✓ Exit 0 — unverifiable, never blocks.');
    return lines.join('\n');
  }

  lines.push(`${result.claimingDocs} document(s) make a ledger-capture claim; ${result.violations.length} unresolved.`);
  lines.push('');
  if (result.violations.length > 0) {
    lines.push('Attention — claim(s) with no resolvable topicId in the ledger:');
    for (const v of result.violations) {
      lines.push(`  ✗ ${v.relPath}`);
      for (const c of v.claims) lines.push(`      L${c.line}: ${c.snippet}`);
    }
    lines.push('');
  }
  const resolved = result.results.filter((r) => r.resolvable);
  if (resolved.length > 0) {
    lines.push(`Resolved (${resolved.length}):`);
    for (const r of resolved) lines.push(`  ✓ ${r.relPath} — cites ${r.citedValidIds.join(', ')}`);
    lines.push('');
  }
  lines.push(result.ok
    ? '✓ Clean — every ledger-capture claim resolves (local-only, not wired into pre-push).'
    : '✗ Attention needed — see above (local-only, not wired into pre-push).');
  return lines.join('\n');
}

function safeErrorClass(err) {
  return err?.constructor?.name || 'Error';
}

async function main() {
  let opts;
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'debt-ledger-claims-check' });
    opts = parseArgs(process.argv);
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await finishAndExit(2); return; }
    throw err;
  }
  if (opts.help) { printUsage(); await finishAndExit(0); return; }
  if (opts.outFlagWithoutValue) {
    process.stderr.write('debt-ledger-claims-check: --out requires a file path argument\n');
    await finishAndExit(2);
    return;
  }

  const repoRoot = findRepoRootFromScript(import.meta.url);
  if (repoRoot && path.resolve(repoRoot) !== path.resolve(process.cwd())) {
    process.chdir(repoRoot);
  }

  let docs;
  try {
    docs = readPlanDocs(DEFAULT_PLANS_DIR);
  } catch (err) {
    process.stderr.write(`debt-ledger-claims-check: ${DEFAULT_PLANS_DIR} unreadable: ${safeErrorClass(err)}: ${err.message}\n`);
    await finishAndExit(2);
    return;
  }

  // fs.existsSync checked explicitly (not inferred from an empty ledger),
  // same as debt-health-check.mjs — "ledger absent" and "ledger present with
  // 0 entries" must not be conflated: the latter is a real finding.
  const ledgerAvailable = fs.existsSync(path.resolve(DEFAULT_DEBT_LEDGER_PATH));
  let validTopicIds = new Set();
  if (ledgerAvailable) {
    let ledger;
    try {
      ledger = readDebtLedger({ events: [] });
    } catch (err) {
      process.stderr.write(`debt-ledger-claims-check: ledger corrupt: ${err.message}\n`);
      await finishAndExit(2);
      return;
    }
    validTopicIds = new Set(ledger.entries.map((e) => String(e.topicId || '').toLowerCase()).filter(Boolean));
  }

  const result = executeCheck({ docs, ledgerAvailable, validTopicIds });
  const exitCode = !result.ledgerAvailable ? 0 : (result.ok ? 0 : 1);
  const envelope = { ...result, exitCode };
  const outputText = opts.jsonMode ? JSON.stringify(envelope) : renderHuman(result);

  if (opts.outFile) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(opts.outFile)), { recursive: true });
      fs.writeFileSync(opts.outFile, `${outputText}\n`, 'utf-8');
    } catch (err) {
      process.stderr.write(`debt-ledger-claims-check: failed to write --out: ${err.message}\n`);
      await finishAndExit(2);
      return;
    }
  } else {
    process.stdout.write(`${outputText}\n`);
  }

  await finishAndExit(exitCode);
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (isMain) main();
