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
 * **Triage by flag POLARITY, not list order.** The census is severity-flat, and
 * it deliberately does not try to infer intent — but the polarity of a CLI's
 * guard flag decides whether a dropped typo is harmless or destructive:
 *   - **opt-in danger** (`--apply`, `--write`, `--commit`) — the default is
 *     safe, so a typo'd flag is a no-op. Low priority.
 *   - **opt-out danger** (`--dry-run`, `--check` over a MUTATING default) — a
 *     typo'd flag means the real mutation runs. This is the class that caused
 *     all three incidents above; fix these first.
 * Working the findings list top-down does the low-value ones first. A consumer
 * repo reported (2026-07-20) that only 4 of their 10 findings were opt-out,
 * while their two worst instances weren't listed at all — see the
 * `parsesFlags` note on the `argv.includes` spelling for why.
 *
 * Usage:
 *   node scripts/check-cli-flags.mjs            # report-only census
 *   node scripts/check-cli-flags.mjs --gating   # drift-gate (pre-push)
 *   node scripts/check-cli-flags.mjs --json
 *   node scripts/check-cli-flags.mjs --baseline .cli-flags-baseline.json --gating
 *
 * **Adopting this in a consumer repo**: pass `--baseline <file>` (JSON array or
 * newline-delimited paths). Without it the gate applies the UPSTREAM baseline,
 * which lists upstream paths that do not exist in your repo — so every one
 * reports as a stale "fixed or gone" entry while none of your own files are
 * baselined. Consumers are NOT expected to import `assertKnownFlags` from the
 * synced `scripts/.claude-skills/` tree: that tree is gitignored and overwritten
 * wholesale on every sync, so an import edge into it lets a re-sync break your
 * operator scripts. Fork a local copy keeping the export NAME — the detector is
 * name-based (`/assertKnownFlags/`) precisely so a fork stays compatible.
 *
 * Exit codes: 0 — ok (or report-only) · 1 — scanner failure, unreadable
 * `--baseline`, or net-new drift under `--gating`.
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
  // 'scripts/lib/arch-memory/calibrate.mjs' — FIXED 2026-07-20, baseline paid
  // down. It should never have been baselined: `--out` feeds writeFileSync
  // against a committed artifact, so a typo'd `--outt` fell through `arg()` to
  // the default and overwrote it — the same shape as `render-mermaid.mjs`, one
  // of the three incidents in this file's header. Surfaced by a consumer repo's
  // report; the mechanism they proposed was wrong (see `discoverScripts`) but
  // the target was right.
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

  // 61 → 82 (2026-07-20, second widening). `parsesFlags` dropped the RECEIVER
  // requirement on its `includes('--x')` clause: the previous form demanded the
  // literal `process.argv.includes(`, so the extremely common
  //   const argv = process.argv.slice(2);
  //   const CHECK_ONLY = argv.includes('--check');
  // was classified not-a-CLI and skipped entirely. Reported by a consumer repo
  // whose migration runner hid in exactly this shape — `--check` was the SAFE
  // mode and the default APPLIED migrations, so a typo'd `--chek` ran them for
  // real. Most files escaped by coincidence (they happened to contain a
  // `startsWith('--')` elsewhere); files that only ever test boolean flags did
  // not. Same reasoning as the 24 → 61 growth above: these 21 were ALWAYS
  // unguarded and merely invisible, so they are baselined in the same commit
  // that made them visible. Nothing regressed; the census got honest again.
  'scripts/audit-metrics.mjs',
  'scripts/check-deps.mjs',
  'scripts/debt-backfill.mjs',
  'scripts/debt-budget-check.mjs',
  'scripts/debt-pr-comment.mjs',
  'scripts/debt-review.mjs',
  'scripts/evolve-prompts.mjs',
  'scripts/gemini-review.mjs',
  'scripts/install-prepush-hook.mjs',
  'scripts/learning/backfill-outcomes.mjs',
  'scripts/learning/weekly-review.mjs',
  'scripts/lib/learning/quickfix-stats.mjs',
  'scripts/lib/npm-script-enumerator.mjs',
  'scripts/meta-assess.mjs',
  'scripts/openai-audit.mjs',
  'scripts/postgres-parity/check-non-core-references.mjs',
  'scripts/refine-prompts.mjs',
  'scripts/security-triage.mjs',
  'scripts/setup-permissions.mjs',
  'scripts/spikes/observed-graph-discovery-spike.mjs',
  'scripts/sync-refresh.mjs',
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
  return /--[a-z]/.test(src) && /(startsWith\(['"]--['"]\)|=== ['"]--|includes\(['"]--)/.test(src);
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

/**
 * Enumerate candidate script files via git (tracked + untracked-not-ignored).
 *
 * **These pathspecs are NOT depth-limited — `*` crosses `/` in git pathspec
 * matching.** git does not use `FNM_PATHNAME`, so `scripts/*.mjs` already
 * matches at every depth (measured on this repo: 488 files — 93 at depth 1,
 * 128 at depth 2, 224 at depth 3, 43 at depth 4). `scripts/*&#47;*.mjs` is a strict
 * subset, kept only because removing it would be a behaviour change for zero
 * gain.
 *
 * This is worth stating loudly because it has now misled two readers
 * independently: a consumer repo reported "the depth-2 globs miss 55% of
 * scripts/" (2026-07-20), and the first attempt to verify that claim
 * reproduced the same error. Both had re-implemented the glob with
 * shell/minimatch semantics instead of calling this function. If you want to
 * know what is scanned, call `discoverScripts()` — do not model it.
 *
 * `.js` is included because adopters are frequently mixed-module; upstream is
 * all-ESM-`.mjs`, so this costs 4 files here and is load-bearing downstream
 * (it hid a DB-mutating backfill in a consumer repo).
 */
export function discoverScripts(repoRoot) {
  const out = execFileSync('git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--',
      'scripts/*.mjs', 'scripts/*/*.mjs', 'scripts/*.js', 'scripts/*/*.js'],
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

/**
 * Load a consumer-supplied baseline: JSON array, or newline-delimited paths
 * (`#` comments allowed). Returns a Set.
 *
 * Exists because `runCheck` has always taken a `baseline` parameter while
 * `main()` hardcoded the upstream `BASELINE` — so an adopting repo ran the gate
 * against OUR file list, reporting every upstream path as a stale
 * "fixed or gone" entry while baselining none of its own. Report-only was still
 * useful; `--gating` was not adoptable. Reported by a consumer repo 2026-07-20.
 *
 * A missing/unreadable/malformed file is a HARD failure, never a silent
 * fallback to the upstream default: silently gating against the wrong baseline
 * is the exact defect this flag fixes, and re-introducing it as an error path
 * would be worse than not having the flag.
 */
export function loadBaselineFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('baseline file is empty');
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('JSON baseline must be an array of paths');
    return new Set(parsed.map(String));
  }
  // A JSON OBJECT must be rejected explicitly, not fall through to the
  // line parser. Caught by this module's own test: `{"not":"an array"}` has no
  // leading `[`, so the newline branch happily returned a Set of JSON fragments
  // — a baseline of garbage that matches no real path, silently baselining
  // NOTHING while reporting success. A malformed baseline has to be loud; that
  // is the whole reason this loader refuses to fall back to the upstream set.
  if (trimmed.startsWith('{')) {
    throw new Error('JSON baseline must be an array of paths, not an object');
  }
  const lines = trimmed.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const malformed = lines.filter((l) => /["{}[\],]/.test(l));
  if (malformed.length) {
    throw new Error(
      `baseline is neither valid JSON nor plain paths — offending line: ${malformed[0].slice(0, 60)}`,
    );
  }
  return new Set(lines);
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) {
    console.log('OK');
    process.exit(0);
  }
  const gating = process.argv.includes('--gating');
  const json = process.argv.includes('--json');
  const repoRoot = process.cwd();

  // `--baseline <file>` / `--baseline=<file>`
  let baseline = BASELINE;
  const bIdx = process.argv.findIndex((a) => a === '--baseline' || a.startsWith('--baseline='));
  if (bIdx !== -1) {
    const arg = process.argv[bIdx];
    const val = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : process.argv[bIdx + 1];
    if (!val || val.startsWith('--')) {
      console.error(`${R}cli:flags: --baseline requires a file path${X}`);
      process.exit(1);
    }
    try {
      baseline = loadBaselineFile(path.resolve(repoRoot, val));
    } catch (err) {
      console.error(`${R}cli:flags: could not read baseline ${val}${X} — ${err.message}`);
      console.error(`${D}  refusing to fall back to the upstream baseline — that would gate your repo against our file list${X}`);
      process.exit(1);
    }
  }

  let files;
  try {
    files = discoverScripts(repoRoot);
  } catch (err) {
    console.error(`${R}cli:flags: discovery failed${X} — ${err.message}`);
    process.exit(1);
  }

  const r = runCheck({ repoRoot, files, gating, baseline });

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
