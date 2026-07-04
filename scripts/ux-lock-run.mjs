#!/usr/bin/env node
/**
 * @fileoverview Deterministic /ux-lock runner (Determinism follow-ups WS2).
 *
 * `/ux-lock` AUTHORS a Playwright spec (creative — the model writes selectors
 * from the DOM contract / acceptance criteria). This CLI makes the RECORDING
 * deterministic: it executes the authored spec(s) and persists the run rows in
 * ONE call, replacing three model-remembered steps (run `npx playwright test`,
 * hand-parse the JSON, call the record-* CLIs) that left
 * `regression_spec_runs` / `plan_verification_*` empty or wrong when missed.
 *
 * Subcommands:
 *   spec   — run authored regression spec(s), record one regression_spec_runs
 *            row per spec_path (lock mode).
 *   verify — run a verify spec, map each test back to its criterion via the
 *            criterion_hash annotation, record plan_verification_run + items.
 *
 * Graceful: cloud off → run + print pass/fail, skip recording with a hint;
 * Playwright missing → exit 5; malformed/empty report on a non-zero exit →
 * hard-fail (exit 3, never a silent empty result).
 *
 * @module scripts/ux-lock-run
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

import {
  runPlaywrightJson, flattenReport, statusToPassed, normalizeSpecPath,
  resolveRepoRoot, exitCodeForStatus, RUN_STATUS, RUN_CONTEXTS, mapCriteriaToItems,
} from './lib/playwright-runner.mjs';
import { parseAcceptanceCriteria } from './lib/plan-criteria-parser.mjs';
import { emit } from './lib/cli-io.mjs';
import {
  initLearningStore, isCloudEnabled, resolveRepoForStore,
  recordRegressionSpec, recordRegressionSpecRun,
  recordPlanVerificationRun, recordPlanVerificationItems,
} from './learning-store.mjs';
import {
  scanSpecClosure, resolveTestRoot, readAliasMapFromTsconfig, readPlaywrightTestDirs,
} from './lib/ux-lock/selector-policy.mjs';

const [subcommand, ...rest] = process.argv.slice(2);

function opt(name) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? (rest[i + 1] ?? null) : null;
}
function optAll(name) {
  const out = [];
  rest.forEach((a, i) => { if (a === `--${name}` && rest[i + 1] != null) out.push(rest[i + 1]); });
  return out;
}
function flag(name) {
  return rest.includes(`--${name}`);
}

function fail(code, message, exitCode = 2) {
  emit({ ok: false, error: { code, message } });
  process.exit(exitCode);
}

/** Resolve the cloud repo row id, or null when cloud is off / unresolved. */
async function resolveRepoId() {
  const ref = await resolveRepoForStore({}).catch(() => null);
  return ref?.repoRowId ?? null;
}

// ── selector-policy lint (plan: docs/completed/ux-lock-selector-policy.md) ──────

/**
 * Scan spec files (plus their local-helper import closure) for selector-policy
 * violations. Fail-closed on unreadable files / unresolvable closure imports.
 * Warn by default; `--strict-selectors` exits 6 on unjustified violations.
 *
 * Returns { counts: Map<absPath, number>, total, scannedFiles }.
 * The tracker map is keyed by the SPEC file — closure violations attribute to
 * the importing spec (per-spec-row attribution, Gemini-R3-G1).
 */
function scanSelectorPolicy(specFiles, {
  repoRoot, strict, phase,
  // Explicit inputs (audit R3-M7): callers pass CLI state in rather than the
  // helper reaching into ambient opt()/optAll() — keeps the scan wrapper pure
  // over its arguments.
  testRootFlag = opt('test-root'),
  aliasArgs = optAll('alias'),
}) {
  const aliasMap = buildAliasMap(repoRoot, aliasArgs);
  const configTestDirs = readPlaywrightTestDirs(repoRoot);
  const counts = new Map();
  let total = 0;
  let justifiedTotal = 0;
  const allViolations = [];
  const allStale = [];
  const allAliases = [];
  const failures = [];
  let scannedFiles = 0;

  for (const specFile of specFiles) {
    const abs = path.resolve(repoRoot, specFile);
    const testRoot = resolveTestRoot(abs, { flag: testRootFlag, configTestDirs, repoRoot });
    const r = scanSpecClosure(abs, { testRoot, aliasMap });
    scannedFiles += r.files.length;
    counts.set(abs, r.violations.length);
    total += r.violations.length;
    justifiedTotal += r.justifiedCount;
    allViolations.push(...r.violations);
    allStale.push(...r.staleMarkers);
    allAliases.push(...r.unresolvedAliases);
    failures.push(...r.failures);
  }

  // Fail-closed: an unreadable spec or unresolvable closure import means the
  // scan did NOT cover what Playwright will execute — never report clean.
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  [selector-policy] FAIL-CLOSED (${f.reason}): ${f.file}\n`);
    fail('SELECTOR_SCAN_INCOMPLETE', `selector-policy scan could not cover ${failures.length} file(s) — see stderr`, 2);
  }
  if (scannedFiles === 0) {
    fail('SELECTOR_SCAN_EMPTY', 'selector-policy scan resolved zero files — refusing to report "0 violations" for scanning nothing', 2);
  }

  if (allViolations.length || allStale.length || allAliases.length) {
    process.stderr.write(`  ── SELECTOR POLICY (${phase}) ─ ${allViolations.length} unjustified violation(s), ${justifiedTotal} justified, ${allStale.length} stale marker(s) ──\n`);
    for (const v of allViolations) {
      process.stderr.write(`  [selector-policy] ${v.class} ${path.relative(repoRoot, v.file)}:${v.line}  ${v.snippet}\n`);
    }
    for (const s of allStale) {
      process.stderr.write(`  [selector-policy] stale-marker ${path.relative(repoRoot, s.file)}:${s.line} — ${s.reason}\n`);
    }
    for (const a of allAliases) {
      process.stderr.write(`  [selector-policy] unresolved-alias-import ${path.relative(repoRoot, a.file)}:${a.line} '${a.specifier}' — pass --alias ${a.specifier.split('/')[0]}/=<dir> to resolve (not counted)\n`);
    }
    process.stderr.write('  [selector-policy] ladder: getByRole > getByLabel/Placeholder > getByText > getByTestId > justified CSS (// selector-policy: structural — <reason>)\n');
  }

  if (strict && total > 0) {
    fail('SELECTOR_POLICY_STRICT', `${total} unjustified selector-policy violation(s) with --strict-selectors`, 6);
  }
  // Strict = "prove the spec clean": an UNRESOLVED alias might be an app import
  // the scan couldn't see, so strict mode refuses it (configure --alias or
  // tsconfig paths). Warn mode keeps the non-counting warning — fail-closed
  // there would break legitimate alias suites (plan Gemini-R1-G2 + audit R1-H6).
  if (strict && allAliases.length > 0) {
    fail('SELECTOR_POLICY_UNRESOLVED_ALIAS', `${allAliases.length} unresolved alias import(s) under --strict-selectors — configure --alias prefix=dir (or tsconfig paths) so the scan can prove them clean`, 6);
  }
  return { counts, total, scannedFiles };
}

function buildAliasMap(repoRoot, aliasArgs = optAll('alias')) {
  const map = readAliasMapFromTsconfig(repoRoot) || {};
  for (const kv of aliasArgs) {
    const eq = kv.indexOf('=');
    if (eq <= 0) { process.stderr.write(`  [selector-policy] ignoring malformed --alias '${kv}' (want prefix=dir)\n`); continue; }
    map[kv.slice(0, eq)] = path.resolve(repoRoot, kv.slice(eq + 1));
  }
  return Object.keys(map).length ? map : null;
}

// ── spec subcommand (lock mode) ─────────────────────────────────────────────

async function cmdSpec() {
  const specArg = opt('spec');
  const specsArg = opt('specs');
  const commit = opt('commit');
  const url = opt('url');
  // Must satisfy the regression_spec_runs run_context CHECK constraint —
  // an invalid value silently dropped the row ('ux-lock' was never allowed).
  // RUN_CONTEXTS is the shared constant mirroring that DB CHECK.
  const runContext = opt('run-context') || 'manual';
  if (!RUN_CONTEXTS.includes(runContext)) {
    process.stderr.write(`  [ux-lock-run] invalid --run-context '${runContext}' — allowed: ${RUN_CONTEXTS.join(', ')}\n`);
    process.exit(2);
  }
  const sourceKind = opt('source-kind') || 'manual';
  const noRegister = flag('no-register');

  const specPaths = [specArg, specsArg].filter(Boolean);
  if (specPaths.length === 0) {
    return fail('BAD_INPUT', '--spec <path> (or --specs <glob>) is required');
  }
  const repoRoot = resolveRepoRoot();
  const strictSelectors = flag('strict-selectors');

  // Selector-policy pre-run scan on exact --spec paths (a --specs GLOB is
  // expanded by Playwright, so glob-matched files are reconciled POST-run from
  // the report's executed set — scanner coverage ≡ executed set either way).
  // Under --strict-selectors a pre-run violation blocks before Playwright runs.
  // Strict + glob is REFUSED (audit R2-M4 ruling): strict's contract is "no
  // spec executes before enforcement", and the runner cannot pre-resolve
  // Playwright's glob semantics faithfully — so it fails closed as unverified
  // rather than letting a prohibited spec run first. Warn mode keeps the
  // post-run reconcile as coverage telemetry.
  if (strictSelectors && specsArg) {
    return fail('SELECTOR_STRICT_GLOB_UNRESOLVED',
      '--strict-selectors cannot pre-verify a --specs glob (Playwright owns its expansion) — pass explicit --spec path(s) under strict mode, or drop --strict-selectors for warn-mode telemetry', 2);
  }
  let policy = { counts: new Map(), total: 0 };
  if (specArg) {
    policy = scanSelectorPolicy([specArg], { repoRoot, strict: strictSelectors, phase: 'pre-run' });
  }
  const result = runPlaywrightJson({ specPaths, baseUrl: url, cwd: repoRoot });

  if (result.status === RUN_STATUS.PLAYWRIGHT_MISSING) {
    emit({ ok: false, status: result.status, error: { code: 'PLAYWRIGHT_MISSING', message: 'Playwright not installed — run: npx playwright install chromium' } });
    process.exit(exitCodeForStatus(result.status));
  }
  if (result.status !== RUN_STATUS.OK) {
    emit({ ok: false, status: result.status, error: { code: 'RUN_FAILED', message: result.error } });
    process.exit(exitCodeForStatus(result.status));
  }

  // Group test results by repo-relative spec_path (plan §2.3 R2-M4).
  const tests = flattenReport(result.report);
  const bySpec = new Map();
  const orphans = [];
  // Filter the report to EXACT --spec paths only. A --specs GLOB is expanded by
  // Playwright, so the glob STRING must never enter `requested` (it matches no
  // concrete report file → every test dropped as an orphan, audit H4/H6). When
  // a glob is present — even ALONGSIDE an exact --spec (Gemini edge) — we skip
  // the exact filter entirely: the report is already scoped to what Playwright
  // ran, so accept every file and group by its real spec_path. `requested`
  // empty ⇒ no filter.
  const requested = specsArg
    ? new Set()
    : new Set([specArg].filter(Boolean).map(p => normalizeSpecPath(p, repoRoot)));
  // Report file paths are relative to the report's rootDir (Playwright emits
  // testDir-relative paths — bare basenames for a nested testDir), NOT the
  // repo root; resolving against repoRoot orphaned every test on such repos.
  const reportRootDir = result.report?.config?.rootDir || repoRoot;
  for (const t of tests) {
    const sp = normalizeSpecPath(path.resolve(reportRootDir, t.file), repoRoot);
    if (requested.size > 0 && !requested.has(sp)) { orphans.push(sp); continue; }
    if (!bySpec.has(sp)) bySpec.set(sp, []);
    bySpec.get(sp).push(t);
  }
  // A requested spec that produced no test results still gets a row (it ran).
  for (const sp of requested) if (!bySpec.has(sp)) bySpec.set(sp, []);

  // Post-run selector-policy reconcile: scan any EXECUTED spec file the
  // pre-run pass didn't cover (the --specs glob case). This keeps scanner
  // coverage ≡ executed set by construction; under --strict-selectors a
  // glob-discovered violation still fails the call (exit 6) after recording.
  const unscanned = [...bySpec.keys()]
    .map(sp => path.resolve(repoRoot, sp))
    .filter(abs => !policy.counts.has(abs));
  if (unscanned.length > 0) {
    const post = scanSelectorPolicy(unscanned, { repoRoot, strict: false, phase: 'post-run' });
    for (const [k, v] of post.counts) policy.counts.set(k, v);
    policy.total += post.total;
  }
  if (bySpec.size === 0 && policy.counts.size === 0) {
    return fail('SELECTOR_SCAN_EMPTY', 'no spec files were executed or scanned — refusing to report a clean run for nothing', 2);
  }

  await initLearningStore().catch(() => {});
  const cloud = await isCloudEnabled();
  const repoId = cloud ? await resolveRepoId() : null;

  const specSummaries = [];
  for (const [specPath, specTests] of bySpec) {
    const passed = specTests.length > 0 && specTests.every(t => statusToPassed(t.status).passed);
    const durationMs = specTests.reduce((s, t) => s + (t.durationMs || 0), 0);
    const summary = { specPath, tests: specTests.length, passed, durationMs };
    specSummaries.push(summary);

    if (!cloud) continue;
    // Auto-register safety (plan §2.3 R2-M3): recordRegressionSpec upserts by
    // (repo_id, spec_path) and REQUIRES sourceKind + description — supply both
    // or the register call no-ops. --no-register skips registration entirely.
    let specId = null;
    if (!noRegister) {
      specId = await recordRegressionSpec(repoId, {
        sourceKind,
        specPath,
        description: `Regression spec ${path.basename(specPath)}`,
        commitSha: commit,
        assertionCount: specTests.length,
      });
    }
    if (specId) {
      await recordRegressionSpecRun(specId, {
        commitSha: commit, passed, durationMs, runContext,
        // Per-spec attribution (this spec + its helper closure) — NEVER the
        // run-global total, which would inflate an N-spec suite ×N in the DB.
        selectorPolicyViolations: policy.counts.get(path.resolve(repoRoot, specPath)) ?? null,
      });
    }
  }
  if (orphans.length) {
    process.stderr.write(`  [ux-lock-run] ${orphans.length} orphan test file(s) not in requested specs (spec-authoring smell): ${[...new Set(orphans)].join(', ')}\n`);
  }

  const allPassed = specSummaries.every(s => s.passed);
  emit({
    ok: true, mode: 'spec', cloud, runContext,
    specs: specSummaries, orphans: [...new Set(orphans)],
    selectorPolicyViolations: policy.total,
    recorded: cloud, hint: cloud ? undefined : 'AUDIT_DB_URL unset — ran specs, skipped recording',
  });
  if (strictSelectors && policy.total > 0) {
    // Glob-discovered (post-run) violations under --strict-selectors: the run
    // + recording happened, but the call still fails loudly.
    process.exit(6);
  }
  process.exit(exitCodeForStatus(RUN_STATUS.OK, { testsPassed: allPassed }));
}

// ── verify subcommand ───────────────────────────────────────────────────────

async function cmdVerify() {
  const planPath = opt('plan');
  const specArg = opt('spec');
  const commit = opt('commit');
  const url = opt('url');
  if (!planPath || !specArg) {
    return fail('BAD_INPUT', '--plan <plan.md> and --spec <verify-spec> are required');
  }
  let planMd;
  try { planMd = fs.readFileSync(path.resolve(planPath), 'utf8'); }
  catch (e) { return fail('BAD_INPUT', `cannot read --plan (${planPath}): ${e.message}`); }

  const { criteria } = parseAcceptanceCriteria(planMd);
  if (!criteria || criteria.length === 0) {
    return fail('NO_CRITERIA', `no acceptance criteria parsed from ${planPath} (is there a Section 9/10?)`);
  }

  const repoRoot = resolveRepoRoot();
  // Selector-policy scan (verify mode) — same ladder + lint as lock mode.
  // Pre-run + strict blocks before Playwright runs; verify's exit-0 report
  // contract is unchanged for criteria failures.
  const policy = scanSelectorPolicy([specArg], {
    repoRoot, strict: flag('strict-selectors'), phase: 'pre-run',
  });
  const result = runPlaywrightJson({ specPaths: [specArg], baseUrl: url, cwd: repoRoot });
  if (result.status === RUN_STATUS.PLAYWRIGHT_MISSING) {
    emit({ ok: false, status: result.status, error: { code: 'PLAYWRIGHT_MISSING', message: 'Playwright not installed — run: npx playwright install chromium' } });
    process.exit(exitCodeForStatus(result.status));
  }
  if (result.status !== RUN_STATUS.OK) {
    emit({ ok: false, status: result.status, error: { code: 'RUN_FAILED', message: result.error } });
    process.exit(exitCodeForStatus(result.status));
  }

  // Resolve every EXPECTED criterion + collect orphan tests (plan §2.3 coverage
  // algorithm — extracted to a pure, unit-tested function).
  const tests = flattenReport(result.report);
  const { items, orphanTests } = mapCriteriaToItems(criteria, tests);
  if (orphanTests.length) {
    process.stderr.write(`  [ux-lock-run] ${orphanTests.length} test(s) had no matching expected criterion (not recorded as items): ${orphanTests.slice(0, 5).join('; ')}\n`);
  }

  const passedCount = items.filter(i => i.passed).length;
  const failedCount = items.filter(i => !i.passed && i.errorMessage !== 'skipped').length;
  const skippedCount = items.filter(i => i.errorMessage === 'skipped').length;
  const durationMs = items.reduce((s, i) => s + (i.durationMs || 0), 0);

  await initLearningStore().catch(() => {});
  const cloud = await isCloudEnabled();
  let runId = null;
  if (cloud) {
    // The plan id is resolved by the caller (plans table); pass via --plan-id when known.
    const planId = opt('plan-id');
    if (planId) {
      runId = await recordPlanVerificationRun({
        planId, commitSha: commit, url,
        totalCriteria: items.length, passedCount, failedCount, skippedCount,
        durationMs, runContext: 'ux-lock-verify',
        // One row per run → the run total is the correct granularity here.
        selectorPolicyViolations: policy.total,
      });
      if (runId) await recordPlanVerificationItems(runId, planId, items);
    } else {
      process.stderr.write('  [ux-lock-run] no --plan-id — recorded nothing (plan_verification_* require a plan id)\n');
    }
  }

  emit({
    ok: true, mode: 'verify', cloud, runId,
    totalCriteria: items.length, passedCount, failedCount, skippedCount,
    selectorPolicyViolations: policy.total,
    orphanTests: orphanTests.length,
    items: items.map(i => ({ hash: i.criterionHash, severity: i.severity, passed: i.passed, error: i.errorMessage })),
    hint: cloud ? undefined : 'AUDIT_DB_URL unset — ran spec, skipped recording',
  });
  // VERIFY is a REPORT, not a blocker — it exits 0 even when criteria fail (the
  // established /ux-lock verify contract; /ship gates via the status rubric +
  // plan_satisfaction view, not this exit code). Non-zero is reserved for
  // "could not run" (PLAYWRIGHT_MISSING → 5, RUN_FAILED → 3, handled above).
  process.exit(0);
}

// ── dispatch ────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  if (subcommand === 'spec') return cmdSpec();
  if (subcommand === 'verify') return cmdVerify();
  process.stderr.write('Usage: node scripts/ux-lock-run.mjs <spec|verify> [options]\n'
    + '  spec   --spec <path> [--specs <glob>] [--commit <sha>] [--url <u>] [--run-context <ctx>] [--source-kind <k>] [--no-register]\n'
    + '  verify --plan <plan.md> --spec <verify-spec> [--plan-id <id>] [--commit <sha>] [--url <u>]\n'
    + '  selector-policy options (both): [--strict-selectors] [--test-root <dir>] [--alias prefix=dir]...\n'
    + '    lints spec + local-helper closure for unjustified structural selectors / app imports\n'
    + '    (warn by default; strict → exit 6; scan failure → exit 2, never a silent clean)\n');
  process.exit(2);
}

main().catch((err) => { process.stderr.write(`${err.stack || err.message}\n`); process.exit(3); });
