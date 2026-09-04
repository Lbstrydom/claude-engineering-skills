#!/usr/bin/env node
/**
 * @fileoverview Local maintenance check — verifies that every `ruling:
 * 'defer'` entry across `.audit/*-ledger.json` (round adjudication ledgers,
 * SKILL.md Step 3.5) has a matching entry in `.audit/tech-debt.json` (Step
 * 3.6, `scripts/debt-auto-capture.mjs`). Sibling to `debt-health-check.mjs`
 * (reads the debt ledger's OWN health — staleness/recurrence/budget — but
 * never the round ledgers, so it can't see a ruling that was never captured)
 * and `debt-ledger-claims-check.mjs` (same "checked vs. explicitly
 * unverifiable" discipline, same local-only reasoning). Full scope + why this
 * never blocks a push: `scripts/lib/debt-capture-trail.mjs`'s module header.
 *
 * `main()` is a thin process adapter over the pure `executeCheck()` — it is
 * the only piece that touches `process.argv`, reads `.audit/` and the debt
 * ledger from disk, and reports the outcome.
 *
 * Exit codes:
 *   0 — no round-ledger `ruling: 'defer'` entries found, or every one has a
 *       matching debt-ledger entry
 *   1 — attention (an uncaptured deferral, or a round ledger that failed to
 *       parse and so couldn't be verified)
 *   2 — op error (debt ledger itself corrupt, unknown flag)
 *
 * Usage:
 *   node scripts/debt-capture-trail-check.mjs [--json] [--out <path>]
 *                                              [--audit-dir <dir>] [--ledger <path>]
 *
 * @module scripts/debt-capture-trail-check
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError, argOption, hasFlag, finishAndExit } from './lib/cli-io.mjs';
import {
  DEFAULT_AUDIT_DIR, findRoundLedgers, readDeferredEntries, collectDebtIdentities, executeCheck,
  auditDirAvailable as auditDirAvailableFn,
} from './lib/debt-capture-trail.mjs';
import { readDebtLedger, DEFAULT_DEBT_LEDGER_PATH } from './lib/debt-ledger.mjs';

const KNOWN_FLAGS = ['--json', '--out', '--audit-dir', '--ledger', '--help', '-h', '--selfcheck-relocation'];

function parseArgs() {
  const args = process.argv.slice(2);
  const outFlagPresent = args.some((a) => a === '--out' || a.startsWith('--out='));
  const outFile = argOption('out');
  return {
    jsonMode: hasFlag('json'),
    auditDir: argOption('audit-dir', DEFAULT_AUDIT_DIR),
    ledgerPath: argOption('ledger', DEFAULT_DEBT_LEDGER_PATH),
    outFile,
    help: hasFlag('help') || args.includes('-h'),
    outFlagWithoutValue: outFlagPresent && !outFile,
  };
}

function printUsage() {
  process.stderr.write(`Usage: node scripts/debt-capture-trail-check.mjs [options]

Verify that every ruling:'defer' entry across .audit/*-ledger.json has a
matching entry in .audit/tech-debt.json (Step 3.6 debt capture). Local-only —
never blocks a push (.audit/ is gitignored, machine-local state, absent in
the pre-push clean-checkout sandbox).

Options:
  --json             Machine-readable JSON envelope to stdout
  --out <file>       Write the selected rendering to file instead of stdout
  --audit-dir <dir>  Directory holding round ledgers (default: .audit)
  --ledger <path>    Debt ledger path (default: .audit/tech-debt.json)
  --help             Show this message

Exit codes: 0=clean or nothing to verify, 1=attention, 2=op-error
`);
}

function renderHuman(result, ledgerPath) {
  const lines = [];
  lines.push('Debt-capture trail check (scripts/debt-capture-trail-check.mjs)');
  lines.push('');

  // "The audit directory does not exist" is not "there were no deferrals".
  // `findRoundLedgers` returns [] for both, and `.audit/` is gitignored — so in
  // a fresh clone, CI, or a linked worktree this printed "nothing to verify —
  // clean" having enumerated nothing. That is the state this check was created
  // to expose in OTHER tools (517 uncaptured deferrals found live 2026-08-27),
  // reproduced in the check itself.
  if (result.auditDirAvailable === false) {
    lines.push(`· UNVERIFIABLE — no audit directory at ${result.auditDir ?? '.audit'}.`);
    lines.push('  No round ledgers were enumerated, so "nothing to verify" cannot be claimed.');
    return lines.join('\n');
  }

  if (result.deferredTotal === 0 && result.corruptLedgers.length === 0) {
    lines.push('· No round-ledger `ruling: \'defer\'` entries found — nothing to verify.');
    lines.push('');
    lines.push('✓ Exit 0 — clean.');
    return lines.join('\n');
  }

  lines.push(`${result.deferredTotal} deferred entr${result.deferredTotal === 1 ? 'y' : 'ies'} across round ledgers; ${result.uncaptured.length} uncaptured.`);
  lines.push('');
  if (result.uncaptured.length > 0) {
    lines.push(`Attention — deferred but never captured to ${ledgerPath}:`);
    for (const u of result.uncaptured) {
      lines.push(`  ✗ ${u.topicId} (${u.severity || 'unknown'}, ${u.category || 'uncategorised'}) — from ${u.ledgerPath}`);
      if (u.detailSnapshot) lines.push(`      ${u.detailSnapshot}`);
    }
    lines.push('');
    lines.push('  Recapture with: node scripts/debt-auto-capture.mjs --ledger <round-ledger-path> --run <sid>');
    lines.push('');
  }
  if (result.corruptLedgers.length > 0) {
    lines.push('Attention — round ledger(s) could not be parsed (unverifiable, not clean):');
    for (const c of result.corruptLedgers) lines.push(`  ✗ ${c.path} — ${c.error}`);
    lines.push('');
  }
  if (!result.debtLedgerAvailable && result.deferredTotal > 0) {
    lines.push(`Note: ${ledgerPath} itself is absent — every deferred entry above is necessarily uncaptured.`);
    lines.push('');
  }
  lines.push(result.ok
    ? '✓ Clean — every deferred entry resolves in the debt ledger (local-only, not wired into pre-push).'
    : '✗ Attention needed — see above (local-only, not wired into pre-push).');
  return lines.join('\n');
}

async function main() {
  // CLI smoke contract (AGENTS.md): proves the module's imports survive
  // relocation to a consumer's scripts/.claude-skills/. Required now that
  // this script is in the sync bundle.
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  let opts;
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'debt-capture-trail-check' });
    opts = parseArgs();
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await finishAndExit(2); return; }
    throw err;
  }
  if (opts.help) { printUsage(); await finishAndExit(0); return; }
  if (opts.outFlagWithoutValue) {
    process.stderr.write('debt-capture-trail-check: --out requires a file path argument\n');
    await finishAndExit(2);
    return;
  }

  // Enumerability is asked separately from emptiness: `findRoundLedgers`
  // returns [] both for "no round ledgers here" and "no such directory".
  const auditDirAvailable = auditDirAvailableFn(opts.auditDir);
  const roundLedgerPaths = findRoundLedgers(opts.auditDir);
  const roundLedgers = roundLedgerPaths.map(readDeferredEntries);

  // "absent" and "present with 0 entries" are distinct, same discipline as
  // debt-health-check.mjs / debt-ledger-claims-check.mjs — the latter is a
  // real (if boring) finding, not the same as never having a ledger at all.
  const debtLedgerAvailable = fs.existsSync(path.resolve(opts.ledgerPath));
  let debtIdentities = new Set();
  if (debtLedgerAvailable) {
    let ledger;
    try {
      ledger = readDebtLedger({ ledgerPath: opts.ledgerPath, events: [] });
    } catch (err) {
      process.stderr.write(`debt-capture-trail-check: debt ledger corrupt: ${err.message}\n`);
      await finishAndExit(2);
      return;
    }
    debtIdentities = collectDebtIdentities(ledger.entries);
  }

  const result = {
    ...executeCheck({ roundLedgers, debtLedgerAvailable, debtIdentities }),
    auditDirAvailable,
    auditDir: opts.auditDir,
  };
  const exitCode = result.ok ? 0 : 1;
  // `ok:false` when the audit directory could not be enumerated: nothing was
  // examined, so 'clean' is not a claim this run earned. Exit stays 0 —
  // advisory, per maintenance-checks.mjs `attention` semantics.
  const envelope = {
    ...result,
    ok: auditDirAvailable ? result.ok : false,
    verdict: !auditDirAvailable ? 'unverifiable' : (result.ok ? 'ok' : 'attention'),
    exitCode,
  };
  const outputText = opts.jsonMode ? JSON.stringify(envelope) : renderHuman(result, opts.ledgerPath);

  if (opts.outFile) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(opts.outFile)), { recursive: true });
      fs.writeFileSync(opts.outFile, `${outputText}\n`, 'utf-8');
    } catch (err) {
      process.stderr.write(`debt-capture-trail-check: failed to write --out: ${err.message}\n`);
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
