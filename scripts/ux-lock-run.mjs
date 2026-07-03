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
  resolveRepoRoot, exitCodeForStatus, RUN_STATUS, mapCriteriaToItems,
} from './lib/playwright-runner.mjs';
import { parseAcceptanceCriteria } from './lib/plan-criteria-parser.mjs';
import { emit } from './lib/cli-io.mjs';
import {
  initLearningStore, isCloudEnabled, resolveRepoForStore,
  recordRegressionSpec, recordRegressionSpecRun,
  recordPlanVerificationRun, recordPlanVerificationItems,
} from './learning-store.mjs';

const [subcommand, ...rest] = process.argv.slice(2);

function opt(name) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? (rest[i + 1] ?? null) : null;
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

// ── spec subcommand (lock mode) ─────────────────────────────────────────────

async function cmdSpec() {
  const specArg = opt('spec');
  const specsArg = opt('specs');
  const commit = opt('commit');
  const url = opt('url');
  // Must satisfy the regression_spec_runs run_context CHECK constraint —
  // an invalid value silently dropped the row ('ux-lock' was never allowed).
  const RUN_CONTEXTS = new Set(['ship-gate', 'ci', 'manual', 'ux-lock-verify']);
  const runContext = opt('run-context') || 'manual';
  if (!RUN_CONTEXTS.has(runContext)) {
    process.stderr.write(`  [ux-lock-run] invalid --run-context '${runContext}' — allowed: ${[...RUN_CONTEXTS].join(', ')}\n`);
    process.exit(2);
  }
  const sourceKind = opt('source-kind') || 'manual';
  const noRegister = flag('no-register');

  const specPaths = [specArg, specsArg].filter(Boolean);
  if (specPaths.length === 0) {
    return fail('BAD_INPUT', '--spec <path> (or --specs <glob>) is required');
  }
  const repoRoot = resolveRepoRoot();
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
    recorded: cloud, hint: cloud ? undefined : 'AUDIT_DB_URL unset — ran specs, skipped recording',
  });
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
      });
      if (runId) await recordPlanVerificationItems(runId, planId, items);
    } else {
      process.stderr.write('  [ux-lock-run] no --plan-id — recorded nothing (plan_verification_* require a plan id)\n');
    }
  }

  emit({
    ok: true, mode: 'verify', cloud, runId,
    totalCriteria: items.length, passedCount, failedCount, skippedCount,
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
    + '  verify --plan <plan.md> --spec <verify-spec> [--plan-id <id>] [--commit <sha>] [--url <u>]\n');
  process.exit(2);
}

main().catch((err) => { process.stderr.write(`${err.stack || err.message}\n`); process.exit(3); });
