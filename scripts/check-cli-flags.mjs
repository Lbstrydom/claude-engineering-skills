#!/usr/bin/env node
/**
 * @fileoverview `cli:flags:gate` — every flag-parsing CLI must REJECT unknown
 * flags rather than ignore them.
 *
 * Why this exists (2026-07-20): `symbol-index/refresh.mjs` parsed flags with an
 * if/else-if chain and no `else`, so an unrecognised flag was silently dropped.
 * `refresh.mjs --full --dry-run`, meant as a costing dry run, discarded
 * `--dry-run` and executed a REAL full refresh against the live store. It was
 * killed before publish, but it stranded a `running` row holding the per-repo
 * lock that blocks every later refresh. `prune.mjs` (which DELETES rows) and
 * `render-mermaid.mjs` (which OVERWRITES a committed artifact) had the same
 * shape. Each was found by hand, one at a time, three separate times — this
 * check exists so there is no fourth.
 *
 * **Drift-only gate, seeded with a baseline.** 24 CLIs were unguarded when this
 * landed. A check that fails on 24 existing files is a wall, not a ratchet, and
 * a cried-wolf gate gets `--no-verify`'d — so baselined files do NOT fail the
 * run. Only a NET-NEW unguarded CLI does. Same mechanism as
 * `check-docs-refs.mjs`; pay the baseline down whenever, but it cannot grow.
 *
 * **Detection is helper-OR-text, deliberately.** The one-off survey that found
 * this class checked only for the literal error TEXT, so once the shared
 * `assertKnownFlags` helper existed, every CLI that correctly delegated to it
 * read as unfixed — the survey reported `prune.mjs` and `render-mermaid.mjs` as
 * broken while both demonstrably exit 2. A detector that misreports the fixed
 * state trains people to ignore it.
 *
 * Usage:
 *   node scripts/check-cli-flags.mjs            # report-only census
 *   node scripts/check-cli-flags.mjs --gating   # drift-gate (pre-push)
 *   node scripts/check-cli-flags.mjs --json
 *
 * Exit codes: 0 — ok (or report-only) · 1 — scanner failure, or net-new drift
 * under `--gating`.
 *
 * @module scripts/check-cli-flags
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

/**
 * CLIs that were already ignoring unknown flags when this gate landed
 * (2026-07-20). Accepted debt, NOT approval: shrink this list, never grow it.
 * Removing an entry after fixing its CLI is the intended direction of travel.
 *
 * Grew 24 → 61 when `parsesFlags` learned the `process.argv.includes('--flag')`
 * spelling — the 37 additions were ALWAYS unguarded, they were merely invisible
 * to the detector. Widening detection without extending the baseline in the same
 * commit would have hard-failed 37 net-new entries on the next push: a wall, not
 * a ratchet, and the exact shape that gets a gate `--no-verify`'d. Nothing
 * regressed here; the census got honest.
 */
export const BASELINE = new Set([
  'scripts/arch-coverage-gate.mjs',
  'scripts/audit-clean.mjs',
  'scripts/audit-full.mjs',
  'scripts/azure-doctor.mjs',
  'scripts/build-manifest.mjs',
  'scripts/cache-hitrate-check.mjs',
  'scripts/cheap-triager-validate.mjs',
  'scripts/check-audit-tool-version.mjs',
  'scripts/check-context-drift.mjs',
  'scripts/check-docs-placement.mjs',
  'scripts/check-docs-refs.mjs',
  'scripts/check-gate-contracts.mjs',
  'scripts/check-isolation-inventory.mjs',
  'scripts/check-model-freshness.mjs',
  'scripts/check-plan-status.mjs',
  'scripts/check-rls.mjs',
  'scripts/check-setup.mjs',
  'scripts/check-skill-updates.mjs',
  'scripts/check-stale-skill-surface.mjs',
  'scripts/check-sync.mjs',
  'scripts/context-staleness.mjs',
  'scripts/cross-skill.mjs',
  'scripts/debt-resolve.mjs',
  'scripts/defect-harvest.mjs',
  'scripts/efficacy-lints-check.mjs',
  'scripts/friction-log.mjs',
  'scripts/generate-plans-index.mjs',
  'scripts/learning/replay.mjs',
  'scripts/ledger-decompose.mjs',
  'scripts/lib/arch-memory/calibrate.mjs',
  'scripts/lib/sync-isolation-verify.mjs',
  'scripts/lint-plan-mermaid.mjs',
  'scripts/maintenance-checks.mjs',
  'scripts/memory-health.mjs',
  'scripts/model-eval-adjudicator.mjs',
  'scripts/model-eval-auditor.mjs',
  'scripts/model-eval-discovery.mjs',
  'scripts/nav-audit.mjs',
  'scripts/on-conflict-lint.mjs',
  'scripts/persona-consistency-promote.mjs',
  'scripts/persona-consistency-run.mjs',
  'scripts/postgres-parity/generate-expected-schema.mjs',
  'scripts/prepush-check.mjs',
  'scripts/reconcile-repo-identity.mjs',
  'scripts/regenerate-skill-copies.mjs',
  'scripts/requirements.mjs',
  'scripts/security-memory/refresh-incidents.mjs',
  'scripts/setup-cloud.mjs',
  'scripts/skills-fit-check.mjs',
  'scripts/solo-control-audit.mjs',
  'scripts/symbol-index/drift.mjs',
  'scripts/symbol-index/duplicates.mjs',
  'scripts/symbol-index/extract.mjs',
  'scripts/sync-shared-audit-refs.mjs',
  'scripts/sync-to-repos.mjs',
  'scripts/tiered-shadow-report.mjs',
  'scripts/ux-lock-run.mjs',
  'scripts/verify-anchor-contract.mjs',
  'scripts/visual-audit.mjs',
  'scripts/write-code-outcomes.mjs',
  'scripts/write-plan-outcomes.mjs',
]);

/**
 * Does this source parse `--flags` at all? (Non-CLI libraries are out of scope.)
 *
 * `process.argv.includes('--flag')` is listed because omitting it hid 37 CLIs
 * from this gate entirely — more than the original baseline. A file matching no
 * `readsArgv` spelling is skipped BEFORE `rejectsUnknownFlags` runs, so it can
 * never be a finding and never be drift: the gate reported green over it. Among
 * the 37 were `sync-to-repos.mjs` (writes into consumer repos),
 * `regenerate-skill-copies.mjs` (overwrites a generated tree) and
 * `audit-clean.mjs` (deletes) — the mutating-default shape this gate exists for.
 * Add a spelling here whenever a new one appears; a missed one is silent.
 *
 * Quote style is matched as `['"]`, not a hardcoded `'`. The first draft of this
 * fix wrote `includes\('--` and a throwaway CLI using `includes("--force")` sailed
 * through the gate during verification. A detector that only recognises one
 * quote character is a detector with a hole in it.
 */
export function parsesFlags(src) {
  const readsArgv = /function parseArgs|for \(let i = 2; i < argv\.length|process\.argv\.slice\(2\)|process\.argv\.includes\(/.test(src);
  if (!readsArgv) return false;
  return /--[a-z]/.test(src) && /(startsWith\(['"]--['"]\)|=== ['"]--|process\.argv\.includes\(['"]--)/.test(src);
}

/**
 * Does it reject unknown flags? Either route counts:
 *   - delegating to `assertKnownFlags` (the shared helper), or
 *   - carrying its own explicit unknown-flag diagnostic.
 * Checking only the second is what made the original survey misreport every
 * CLI that had been fixed via the helper.
 */
export function rejectsUnknownFlags(src) {
  if (/assertKnownFlags/.test(src)) return true;
  return /unknown flag|unknown option|unrecognis|unrecogniz|Unknown argument/i.test(src);
}

/** Enumerate candidate script files via git (tracked + untracked-not-ignored). */
export function discoverScripts(repoRoot) {
  const out = execFileSync('git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'scripts/*.mjs', 'scripts/*/*.mjs'],
    { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * @param {{repoRoot:string, files:string[], gating?:boolean, baseline?:Set<string>}} opts
 * @returns {{ok:boolean, failures:object[], findings:string[], drift:string[],
 *   baselined:number, staleBaseline:string[], scanned:number}}
 */
export function runCheck({ repoRoot, files, gating = false, baseline = BASELINE } = {}) {
  const failures = [];
  const findings = [];
  let scanned = 0;

  // "Audit your success paths": an empty scan set is not a clean run, it is a
  // broken discovery reporting zero because it looked at nothing.
  if (!files || files.length === 0) {
    failures.push({ rule: 'scan/empty-scan-set', message: 'no scripts discovered — refusing to report a green' });
    return { ok: false, failures, findings: [], drift: [], baselined: 0, staleBaseline: [], scanned: 0 };
  }

  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch (err) {
      failures.push({ rule: 'scanner/stat-failed', file: rel, message: err.message });
      continue;
    }
    // A symlink is refused, never followed — an innocent-looking name can
    // resolve anywhere (INC-001's class).
    if (st.isSymbolicLink()) {
      failures.push({ rule: 'scanner/symlink-refused', file: rel, message: 'symlink refused' });
      continue;
    }
    if (!st.isFile()) continue;

    let src;
    try {
      src = fs.readFileSync(abs, 'utf-8');
    } catch (err) {
      failures.push({ rule: 'scanner/read-failed', file: rel, message: err.message });
      continue;
    }
    scanned++;
    if (!parsesFlags(src)) continue;
    if (rejectsUnknownFlags(src)) continue;
    findings.push(rel);
  }

  const drift = findings.filter((f) => !baseline.has(f));
  const baselined = findings.length - drift.length;
  // A baseline entry that is fixed (or gone) is a stale claim that the file is
  // broken. Report-only: failing a push BECAUSE something was fixed is hostile,
  // but leaving it silent lets the baseline rot into fiction.
  const found = new Set(findings);
  const staleBaseline = [...baseline].filter((b) => !found.has(b));

  return {
    ok: failures.length === 0 && (!gating || drift.length === 0),
    failures, findings, drift, baselined, staleBaseline, scanned,
  };
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) {
    console.log('OK');
    process.exit(0);
  }
  const gating = process.argv.includes('--gating');
  const json = process.argv.includes('--json');
  const repoRoot = process.cwd();

  let files;
  try {
    files = discoverScripts(repoRoot);
  } catch (err) {
    console.error(`${R}cli:flags: discovery failed${X} — ${err.message}`);
    process.exit(1);
  }

  const r = runCheck({ repoRoot, files, gating });

  if (json) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  console.log(`${B}CLI unknown-flag gate${X} — ${r.scanned} script(s) scanned, ` +
    `${r.findings.length} still ignore unknown flags (${r.baselined} baselined, ${r.drift.length} net-new)`);

  if (r.failures.length > 0) {
    console.error(`\n${R}${B}Scanner failures${X} (${r.failures.length}) — the scan is NOT trustworthy:`);
    for (const f of r.failures) console.error(`  ${R}${f.rule}${X} ${f.file ?? ''} — ${f.message}`);
  }

  if (r.staleBaseline.length > 0) {
    console.log(`\n${G}baseline can shrink${X} (${r.staleBaseline.length}) — fixed or gone, remove from BASELINE:`);
    for (const f of r.staleBaseline) console.log(`  ${f}`);
  }

  if (gating) {
    if (r.drift.length > 0) {
      console.error(`\n${R}${B}DRIFT${X} (${r.drift.length}) — CLI(s) that parse flags but ignore unknown ones:`);
      for (const f of r.drift) console.error(`  ${R}${f}${X}`);
      console.error(`\n${D}Add \`assertKnownFlags(argv, KNOWN_FLAGS, { cli: '<name>' })\` from scripts/lib/cli-io.mjs.${X}`);
      console.error(`${D}An ignored flag on a mutating command silently does more than the operator asked for.${X}`);
    } else {
      console.log(`\n${G}drift-gate: clean${X} — ${r.baselined} in the accepted baseline, 0 net-new.`);
    }
  } else if (r.findings.length > 0) {
    console.log(`\n${Y}report-only${X} — findings do not fail the run (pass --gating for the drift-gate).`);
  }

  process.exit(r.ok ? 0 : 1);
}

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) main();
