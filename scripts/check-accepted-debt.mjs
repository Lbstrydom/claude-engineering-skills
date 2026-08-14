#!/usr/bin/env node
/**
 * @fileoverview Local maintenance check verifying the AGENTS.md "Accepted
 * Technical Debt" table's revisit-trigger claims against repo state — a
 * sibling to `debt-health-check.mjs`, NOT a duplicate (that check covers
 * `.audit/tech-debt.json`'s TTL/recurrence-based audit-capture ledger; this
 * one covers AGENTS.md's condition-based hand-written debt table — see
 * docs/plans/accepted-debt-table-verification.md §1 "Neighbourhood").
 *
 * `main()` is a thin process adapter over the pure `executeCheck()` — it is
 * the only piece that touches `process.argv`, reads AGENTS.md from disk, and
 * loads the registry, all inside its own error boundary. Never blocks a
 * push; opt-in via `scripts/maintenance-checks.mjs`, same non-blocking
 * shape as `debt-health-check.mjs`.
 *
 * **Source-repo-only — deliberately NOT synced to consumers** (GPT
 * Quickfix M7, round 2): `ACCEPTED_DEBT_ROWS` is hardcoded to THIS repo's
 * own 6 AGENTS.md rows, their exact prose, and source-specific predicate
 * config (`scripts/lib/file-io.mjs`, `scripts/shared.mjs`). Running it
 * against a consumer's own AGENTS.md would report every row unregistered —
 * a permanent, meaningless "attention" that trains operators to ignore
 * maintenance failures. Same category as `model-eval-auditor.mjs` /
 * `verify-anchor-contract.mjs` (see `sync-isolation-verify.mjs`'s
 * `CLI_SMOKE_SET` comment): excluded from `CLI_SMOKE_SET`,
 * `sync-to-repos.mjs`, and `sync-inventory.mjs` on purpose. The
 * `maintenance-checks.mjs` CHECKS entry that spawns this script IS synced
 * (it's the shared orchestrator) but is gated `sourceRepoOnly: true`, so a
 * consumer's copy skips it rather than hitting `MODULE_NOT_FOUND`.
 *
 * Exit codes:
 *   0 — clean (every checked predicate holds, registry/table in full parity)
 *   1 — attention (a predicate is contradicted/unknown, or a parity mismatch)
 *   2 — op error (AGENTS.md unreadable, table malformed, registry invalid,
 *       or a failed --out write)
 *
 * Usage:
 *   node scripts/check-accepted-debt.mjs [--json] [--out <path>]
 *
 * @module scripts/check-accepted-debt
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError, argOption, hasFlag, finishAndExit } from './lib/cli-io.mjs';
import { checkAll } from './lib/accepted-debt-check.mjs';
import { loadRegistry } from './lib/accepted-debt-registry.mjs';
import { findRepoRootFromScript } from './lib/assert-repo-root.mjs';

// No --selfcheck-relocation handler: this script is never relocated (it's
// deliberately excluded from the sync manifest — see the module header), so
// the CLI smoke contract doesn't apply here.
const AGENTS_MD_PATH = 'AGENTS.md';
const KNOWN_FLAGS = ['--json', '--out', '--help', '-h'];

function safeErrorClass(err) {
  return err?.constructor?.name || 'Error';
}

/**
 * @returns {{jsonMode: boolean, outFile: string|null, help: boolean, outFlagWithoutValue: boolean}}
 */
function parseArgs(argv) {
  // `--out` present but with no usable value (bare `--out` at end of argv,
  // its value swallowed by a following flag per argOption's own guard, or an
  // explicit empty `--out=`) must be a hard error, not a silent fall-through
  // to stdout — GPT be-services M2, round 3: `--json --out` looked like it
  // wrote the file while actually writing to stdout instead.
  //
  // Deliberately NOT `hasFlag('out')` for the presence check: hasFlag is a
  // BOOLEAN-flag helper whose falsy-spellings list treats `--out=` (empty
  // string) as "flag is OFF" (Gemini gate G1, round 2 — the first attempt
  // used hasFlag('out') && !outFile, which never fires for `--out=` because
  // hasFlag itself already reports `false` for it, before !outFile is even
  // evaluated). A value-bearing flag's presence has no "off" spelling, so
  // presence is checked directly against argv instead.
  const outFlagPresent = argv.some((a) => a === '--out' || a.startsWith('--out='));
  const outFile = argOption('out');
  return {
    jsonMode: hasFlag('json'),
    outFile,
    help: hasFlag('help') || argv.includes('-h'),
    outFlagWithoutValue: outFlagPresent && !outFile,
  };
}

function printUsage() {
  process.stderr.write(`Usage: node scripts/check-accepted-debt.mjs [options]

Verify the AGENTS.md "Accepted Technical Debt" table's revisit-trigger
claims against repo state. Local-only — never blocks a push. Only the one
row whose trigger is mechanically checkable (readFileOrDie's "library
context" claim) gets real verification; the other five are reported as
explicitly unverifiable, never silently trusted.

Options:
  --json         Machine-readable JSON envelope to stdout
  --out <file>   Write the selected rendering to file instead of stdout
  --help         Show this message

Exit codes: 0=clean, 1=attention, 2=op-error
`);
}

/**
 * Load AGENTS.md from the repo root, as a discriminated result — mirrors
 * `registryLoadResult`'s shape so `executeCheck()` has one path for every
 * handled outcome and `main()` cannot bypass the seam on a read failure.
 * Carries the real `err.message` (not just the error class) — this repo's
 * error-rewrapping convention requires preserving the actionable cause
 * rather than collapsing to a generic class-level message.
 * @returns {{ok: true, markdown: string} | {ok: false, errorClass: string, message: string}}
 */
function loadAgentsMd(agentsPath) {
  try {
    return { ok: true, markdown: fs.readFileSync(agentsPath, 'utf-8') };
  } catch (err) {
    return { ok: false, errorClass: safeErrorClass(err), message: err.message };
  }
}

function renderError(msg) {
  return `✗ ${msg}`;
}

function describePredicateState(row) {
  if (row.predicateState === 'holds') return 'holds (no invocation found outside allowed scope)';
  if (row.predicateState === 'contradicted') {
    const ev = row.evidence?.[0];
    return `CONTRADICTED — ${ev?.file ?? '?'}${ev?.line ? `:${ev.line}` : ''} — ${ev?.reason ?? ''}`;
  }
  if (row.predicateState === 'unknown') {
    const parts = (row.evidence || []).map((e) => e.file || e.reason).slice(0, 3);
    return `unknown — ${parts.join('; ')}`;
  }
  return 'not evaluated';
}

function renderHuman(summary, clean) {
  const lines = [];
  lines.push('Accepted Technical Debt — verification report (scripts/check-accepted-debt.mjs)');
  lines.push('');

  const checked = summary.rows.filter((r) => r.verificationMode === 'checked');
  const unverifiable = summary.rows.filter((r) => r.verificationMode === 'unverifiable');
  const parityIssues = summary.rows.filter((r) => r.registryStatus !== 'registered');

  lines.push(`AGENTS.md table: ${summary.rows.length} row(s) — ${checked.length} mechanically checked, ${unverifiable.length} unverifiable by design`);
  lines.push('');

  if (checked.length > 0) {
    lines.push('Mechanically checked:');
    for (const r of checked) {
      const mark = r.predicateState === 'holds' ? '✓' : (r.predicateState === 'contradicted' ? '✗' : '?');
      lines.push(`  ${mark} ${r.anchor} — ${describePredicateState(r)}`);
    }
    lines.push('');
  }

  if (unverifiable.length > 0) {
    lines.push(`Not mechanically verifiable (${unverifiable.length}) — by design, not a silent pass:`);
    for (const r of unverifiable) {
      lines.push(`  · ${r.anchor} — ${r.reason ?? '(no reason recorded)'}`);
    }
    lines.push('');
  }

  if (parityIssues.length > 0) {
    lines.push('Registry/table parity issues:');
    for (const r of parityIssues) {
      lines.push(`  ⚠ ${r.anchor} — ${r.registryStatus}`);
    }
    lines.push('');
  }

  lines.push(clean
    ? '✓ Clean — nothing needs attention (local-only, not wired into pre-push).'
    : '✗ Attention needed — see above (local-only, not wired into pre-push).');
  return lines.join('\n');
}

/**
 * Run the check as a pure function of its inputs — the fixture-driven test
 * seam. `main()` is the only caller that assembles real `agentsLoadResult`/
 * `registryLoadResult`; tests inject fixtures directly.
 * @param {{agentsLoadResult: {ok:true,markdown:string}|{ok:false,errorClass:string}, registryLoadResult: {ok:true,rows:object[]}|{ok:false,error:string}, deps?: object}} args
 * @returns {{ok: boolean, code: string, exitCode: 0|1|2, summary: object|null, rendering: string}}
 */
export function executeCheck({ agentsLoadResult, registryLoadResult, deps = {} } = {}) {
  if (!agentsLoadResult?.ok) {
    const detail = agentsLoadResult?.message ?? agentsLoadResult?.errorClass ?? 'unknown error';
    return {
      ok: false,
      code: 'agents_unreadable',
      exitCode: 2,
      summary: null,
      rendering: renderError(`AGENTS.md unreadable: ${detail}`),
    };
  }
  if (!registryLoadResult?.ok) {
    return {
      ok: false,
      code: 'registry_invalid',
      exitCode: 2,
      summary: null,
      rendering: renderError(`registry invalid: ${registryLoadResult?.error ?? 'unknown error'}`),
    };
  }

  // `deps` is spread BEFORE the validated fields (not after) so an injected
  // deps.agentsMarkdown/deps.registry can never silently override the
  // values that were actually validated above (GPT be-services L2).
  const result = checkAll({
    ...deps,
    agentsMarkdown: agentsLoadResult.markdown,
    registry: registryLoadResult.rows,
  });

  if (!result.ok) {
    return {
      ok: false,
      code: 'table_malformed',
      exitCode: 2,
      summary: null,
      rendering: renderError(`AGENTS.md "Accepted Technical Debt" table malformed: ${result.error}`),
    };
  }

  const clean = !result.triggered;
  return {
    ok: clean,
    code: clean ? 'clean' : 'attention',
    exitCode: clean ? 0 : 1,
    summary: result.summary,
    rendering: renderHuman(result.summary, clean),
  };
}

async function main() {
  let opts;
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'check-accepted-debt' });
    opts = parseArgs(process.argv);
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await finishAndExit(2); return; }
    throw err;
  }
  if (opts.help) { printUsage(); await finishAndExit(0); return; }
  if (opts.outFlagWithoutValue) {
    process.stderr.write('check-accepted-debt: --out requires a file path argument\n');
    await finishAndExit(2);
    return;
  }

  // Anchor to the repo root regardless of the caller's cwd (GPT be-services
  // M1, round 3) — AGENTS_MD_PATH and every predicate dependency below
  // (git ls-files, provenance-module reads) are repo-relative strings, so
  // running this from a subdirectory would silently inspect the wrong repo
  // state. The only real caller (maintenance-checks.mjs) already sets
  // `cwd: REPO_ROOT`, so this is a no-op there; it only matters for a
  // developer invoking the script by hand from elsewhere. Best-effort: if
  // the root can't be determined, proceed with the caller's cwd unchanged
  // (no worse than before this fix).
  const repoRoot = findRepoRootFromScript(import.meta.url);
  if (repoRoot && path.resolve(repoRoot) !== path.resolve(process.cwd())) {
    process.chdir(repoRoot);
  }

  const agentsLoadResult = loadAgentsMd(AGENTS_MD_PATH);
  const registryLoadResult = loadRegistry();
  const result = executeCheck({ agentsLoadResult, registryLoadResult });

  const outputText = opts.jsonMode ? JSON.stringify(result) : result.rendering;

  if (opts.outFile) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(opts.outFile)), { recursive: true });
      fs.writeFileSync(opts.outFile, `${outputText}\n`, 'utf-8');
    } catch (err) {
      process.stderr.write(`check-accepted-debt: failed to write --out: ${err.message}\n`);
      await finishAndExit(2);
      return;
    }
  } else {
    process.stdout.write(`${outputText}\n`);
  }

  // finishAndExit (not a bare process.exit) drains stdout first — on Windows
  // a piped stdout is async, and process.exit() would discard whatever
  // hadn't flushed yet (cli-io.mjs's own documented failure mode).
  await finishAndExit(result.exitCode);
}

// path.resolve(argv[1]) vs fileURLToPath(import.meta.url): both are OS-native
// decoded paths, so a checkout path needing URL-encoding (e.g. containing a
// space) can never desync them the way a raw string/URL comparison could.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (isMain) main();
