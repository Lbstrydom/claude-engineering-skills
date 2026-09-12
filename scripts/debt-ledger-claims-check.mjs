#!/usr/bin/env node
/**
 * @fileoverview Local maintenance check — verifies that any `docs/plans/*.md`
 * claim of the shape "captured to / named in the debt ledger" carries a
 * `topicId` that actually resolves in the debt ledger — the LOCAL
 * `.audit/tech-debt.json` **or the cloud store**, whichever this machine can
 * reach (2026-09-12; see `scripts/lib/debt-ledger-claim-check.mjs`'s "Validity
 * evidence is local ∪ cloud" note for why checking local alone produced false
 * positives on true claims). Sibling to `debt-health-check.mjs` (reads the
 * same local ledger, and this file's `debt-*.mjs` naming follows its
 * convention deliberately — see the Naming note below) and
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
 *   0 — clean (no unresolvable claims), or no evidence was reachable at all
 *       — neither store (reported plainly as unverifiable, never as "clean")
 *   1 — attention (a claim's topicId isn't in the local ledger OR the cloud store)
 *   2 — op error (plans dir unreadable, corrupt ledger, unknown flag)
 *
 * Usage:
 *   node scripts/debt-ledger-claims-check.mjs [--json] [--out <path>] [--local-only]
 *
 * @module scripts/debt-ledger-claims-check
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './lib/load-env.mjs';
import { assertKnownFlags, ArgvError, argOption, hasFlag, finishAndExit } from './lib/cli-io.mjs';
import {
  executeCheck, readPlanDocs, DEFAULT_PLANS_DIR, mergeTopicIdEvidence,
} from './lib/debt-ledger-claim-check.mjs';
import { readDebtLedger, DEFAULT_DEBT_LEDGER_PATH } from './lib/debt-ledger.mjs';
import { findRepoRootFromScript } from './lib/assert-repo-root.mjs';
import {
  initLearningStore, isCloudEnabled, resolveRepoForStoreResult, readDebtEntriesCloud,
} from './learning-store.mjs';

const KNOWN_FLAGS = ['--json', '--out', '--local-only', '--help', '-h', '--selfcheck-relocation'];

function parseArgs(argv) {
  const args = argv.slice(2);
  const outFlagPresent = args.some((a) => a === '--out' || a.startsWith('--out='));
  const outFile = argOption('out');
  return {
    jsonMode: hasFlag('json'),
    outFile,
    localOnly: hasFlag('local-only'),
    help: hasFlag('help') || args.includes('-h'),
    outFlagWithoutValue: outFlagPresent && !outFile,
  };
}

function printUsage() {
  process.stderr.write(`Usage: node scripts/debt-ledger-claims-check.mjs [options]

Verify that "captured to / named in the debt ledger" claims in docs/plans/*.md
carry a topicId that actually resolves — in the LOCAL .audit/tech-debt.json,
OR in the cloud store when this machine can reach it (a topicId captured on a
different machine/session is real evidence even if never mirrored to this
disk's ledger). Local-only mode is available for an offline check. Never
blocks a push (the local ledger is gitignored, machine-local state, absent in
the pre-push clean-checkout sandbox, and cloud is never assumed reachable there
either).

Options:
  --json         Machine-readable JSON envelope to stdout
  --out <file>   Write the selected rendering to file instead of stdout
  --local-only   Skip the cloud store; validate against the local ledger only
  --help         Show this message

Exit codes: 0=clean or unverifiable, 1=attention, 2=op-error
`);
}

function describeSources(sources) {
  const local = sources.local ? 'local ledger' : 'no local ledger';
  const cloud = sources.cloud ? 'cloud store' : (sources.cloudSkipped ? 'cloud skipped (--local-only)' : 'cloud unreachable');
  return `${local} + ${cloud}`;
}

function renderHuman(result, sources) {
  const lines = [];
  lines.push('Debt-ledger claim check (scripts/debt-ledger-claims-check.mjs)');
  lines.push(`Evidence checked: ${describeSources(sources)}`);
  lines.push('');

  if (!result.ledgerAvailable) {
    lines.push(`· ${result.claimingDocs} document(s) make a ledger-capture claim — UNVERIFIABLE (no local ${DEFAULT_DEBT_LEDGER_PATH} and no reachable cloud store).`);
    lines.push('  Not reported as clean: nothing was checked. Run again where at least one evidence source is reachable.');
    for (const r of result.results) lines.push(`  · ${r.relPath} — ${r.claims.length} claim line(s)`);
    lines.push('');
    lines.push('✓ Exit 0 — unverifiable, never blocks.');
    return lines.join('\n');
  }

  lines.push(`${result.claimingDocs} document(s) make a ledger-capture claim; ${result.violations.length} unresolved.`);
  lines.push('');
  if (result.violations.length > 0) {
    lines.push('Attention — claim(s) with no resolvable topicId in either evidence source:');
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
    ? '✓ Clean — every ledger-capture claim resolves (advisory, not wired into pre-push).'
    : '✗ Attention needed — see above (advisory, not wired into pre-push).');
  return lines.join('\n');
}

function safeErrorClass(err) {
  return err?.constructor?.name || 'Error';
}

async function main() {
  // CLI smoke contract (AGENTS.md): proves the module's imports survive
  // relocation to a consumer's scripts/.claude-skills/. Required now that
  // this script is in the sync bundle.
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
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
  const localAvailable = fs.existsSync(path.resolve(DEFAULT_DEBT_LEDGER_PATH));
  let localTopicIds = new Set();
  if (localAvailable) {
    let ledger;
    try {
      ledger = readDebtLedger({ events: [] });
    } catch (err) {
      process.stderr.write(`debt-ledger-claims-check: ledger corrupt: ${err.message}\n`);
      await finishAndExit(2);
      return;
    }
    localTopicIds = new Set(ledger.entries.map((e) => String(e.topicId || '').toLowerCase()).filter(Boolean));
  }

  // Cloud is real evidence, not merely a mirror: a topicId captured on a
  // different machine/session and never mirrored down is still a TRUE claim
  // (see this file's module header). Checking local alone made a true, cited
  // claim (`vcs-parsing-and-rmsync-scope-hardening-audit-summary.md`, among
  // others) read as an author overclaim. `--local-only` opts back out for an
  // offline check; a failed cloud read degrades to local-only evidence rather
  // than crashing, but is REPORTED as unreachable, never silently treated as
  // "cloud checked and clean" (the sandbox-honesty rule this repo enforces
  // elsewhere for exactly this class of read).
  let cloudAvailable = false;
  let cloudTopicIds = new Set();
  if (!opts.localOnly) {
    await initLearningStore().catch(() => {});
    if (await isCloudEnabled()) {
      // No `profile` — this is a pure identity lookup, not an audit run, and
      // must not bump `last_audited_at` (resolveRepoForStoreResult's own
      // docstring).
      const repo = await resolveRepoForStoreResult({});
      if (repo.kind === 'resolved') {
        try {
          const rows = await readDebtEntriesCloud(repo.repoRowId);
          cloudTopicIds = new Set(rows.map((e) => String(e.topicId || '').toLowerCase()).filter(Boolean));
          cloudAvailable = true;
        } catch (err) {
          process.stderr.write(`  [debt-ledger-claims-check] cloud read failed, continuing with local evidence only: ${err.message}\n`);
        }
      } else if (repo.kind !== 'cloud-off') {
        process.stderr.write(`  [debt-ledger-claims-check] repo identity ${repo.kind}${repo.error ? `: ${repo.error}` : ''} — continuing with local evidence only\n`);
      }
    }
  }

  const { validTopicIds, evidenceAvailable, sources } = mergeTopicIdEvidence({
    localAvailable, localIds: localTopicIds, cloudAvailable, cloudIds: cloudTopicIds,
  });
  const sourcesReport = { ...sources, cloudSkipped: opts.localOnly };

  const result = executeCheck({ docs, ledgerAvailable: evidenceAvailable, validTopicIds });
  const exitCode = !result.ledgerAvailable ? 0 : (result.ok ? 0 : 1);
  // Make `ok` agree with renderHuman, which already says UNVERIFIABLE and
  // "Not reported as clean: nothing was checked" for this state. The envelope
  // emitted `ok:true` beside `ledgerAvailable:false`, so a machine consumer
  // read a green the human output explicitly denies. Exit stays 0 — advisory.
  const envelope = {
    ...result,
    sources: sourcesReport,
    ok: result.ledgerAvailable ? result.ok : false,
    verdict: !result.ledgerAvailable ? 'unverifiable' : (result.ok ? 'ok' : 'attention'),
    exitCode,
  };
  const outputText = opts.jsonMode ? JSON.stringify(envelope) : renderHuman(result, sourcesReport);

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
