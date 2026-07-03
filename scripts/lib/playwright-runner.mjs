/**
 * @fileoverview Shared Playwright subprocess runner (Determinism follow-ups WS2
 * Phase 4). Runs `npx playwright test --reporter=json` as a NON-throwing
 * subprocess, captures the machine report from a FILE (never stdout), and
 * classifies the outcome with a closed status enum.
 *
 * The critical trap (plan §2.3 R1-H4): `npx playwright test` exits NON-ZERO
 * when tests FAIL. A naive `execFileSync` throws on non-zero exit → failing
 * runs would never be recorded (the exact inverse of WS2's goal). So we use
 * `spawnSync` (never throws on exit code), then read `status` + the JSON report
 * file INDEPENDENTLY:
 *   - a valid report parsed  → OK regardless of exit code (non-zero + valid
 *     report = "tests failed", recorded as passed:false);
 *   - Playwright binary / package missing → PLAYWRIGHT_MISSING;
 *   - spawn failure → SPAWN_FAILED;
 *   - non-zero exit AND unparseable/empty report → REPORT_UNREADABLE (hard
 *     error; no silent empty result).
 *
 * JSON capture is from a dedicated temp FILE via `PLAYWRIGHT_JSON_OUTPUT_NAME`
 * (plan §2.3 R2-M3) — stdout carries install prompts / warnings / runner
 * chatter and must never be scraped. `--url` is exported to the child as
 * `E2E_BASE_URL` (R1-M5 — the env var the existing ux-lock spec templates
 * already read), NOT a new `PLAYWRIGHT_BASE_URL`.
 *
 * The temp report file lives in `os.tmpdir()` (Category-A artifact — never a
 * tracked, regenerated-on-run file).
 *
 * @module scripts/lib/playwright-runner
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Closed outcome status — also imported by tests to assert without spawning. */
export const RUN_STATUS = Object.freeze({
  OK:                 'ok',                  // ran; report parsed (tests pass OR fail)
  PLAYWRIGHT_MISSING: 'playwright-missing',  // npm package / browser binary absent
  SPAWN_FAILED:       'spawn-failed',        // could not spawn the subprocess
  REPORT_UNREADABLE:  'report-unreadable',   // ran but no parseable JSON report
});

/** Map a RUN_STATUS to the CLI process exit code (closed contract). */
export function exitCodeForStatus(status, { testsPassed } = {}) {
  switch (status) {
    case RUN_STATUS.OK:                 return testsPassed ? 0 : 1;
    case RUN_STATUS.PLAYWRIGHT_MISSING: return 5;
    case RUN_STATUS.SPAWN_FAILED:       return 3;
    case RUN_STATUS.REPORT_UNREADABLE:  return 3;
    default:                            return 3;
  }
}

/** Heuristic: does a spawn error / output indicate Playwright itself is absent? */
function looksLikePlaywrightMissing(err, stderr) {
  if (err && (err.code === 'ENOENT')) return true;
  const s = `${stderr || ''}`;
  return /Cannot find module .*playwright|Executable doesn't exist|playwright install|command not found.*playwright|is not recognized as an internal/i.test(s);
}

/**
 * Walk up from `startDir` to the nearest directory containing `.git`; falls
 * back to `startDir`. Relocation-safe repo-root resolution (R1-M5) — the same
 * approach `persona-consistency-run.mjs` uses, NOT `process.cwd()`.
 * @param {string} [startDir]
 * @returns {string}
 */
export function resolveRepoRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

/**
 * Normalize a Playwright report `file` (absolute or cwd-relative) to a
 * repo-relative POSIX path, so it can be grouped by / matched against a
 * `regression_specs.spec_path` (plan §2.3 R2-M4).
 * @param {string} file
 * @param {string} repoRoot
 * @returns {string}
 */
export function normalizeSpecPath(file, repoRoot) {
  if (!file) return file;
  const abs = path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

/**
 * Run one or more Playwright spec files and return the parsed JSON report.
 *
 * @param {object} opts
 * @param {string[]} opts.specPaths  spec files to run (repo-relative or absolute)
 * @param {string} [opts.baseUrl]    exported to the child as E2E_BASE_URL
 * @param {string} [opts.cwd]        working dir for the subprocess (default: repo root)
 * @param {number} [opts.timeoutMs]  subprocess timeout (default 180000)
 * @param {(cmd:string,args:string[],options:object)=>{status:number|null,error?:Error,stderr?:Buffer|string}} [opts._spawn]
 *        injectable spawn (tests) — defaults to spawnSync.
 * @returns {{ status: string, report: object|null, exitCode: number|null, error: string|null }}
 */
export function runPlaywrightJson(opts) {
  const {
    specPaths, baseUrl, cwd, timeoutMs = 180000, _spawn = spawnSync,
  } = opts || {};
  if (!Array.isArray(specPaths) || specPaths.length === 0) {
    return { status: RUN_STATUS.SPAWN_FAILED, report: null, exitCode: null, error: 'no spec paths provided' };
  }
  const repoRoot = cwd || resolveRepoRoot();
  const reportFile = path.join(os.tmpdir(), `ux-lock-pw-${randomUUID()}.json`);

  const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile };
  if (baseUrl) env.E2E_BASE_URL = baseUrl;

  // Prefer the repo's installed Playwright CLI run by the CURRENT Node binary —
  // no npx shim, no shell. Node >=22.19 EINVALs spawning .cmd files without
  // shell:true (CVE-2024-27980 hardening), which broke the old
  // 'npx.cmd' path on Windows; shell:true would reopen quoting pitfalls.
  // Fall back to npx only when @playwright/test isn't resolvable from the repo
  // (then PLAYWRIGHT_MISSING classification still applies as before).
  let bin;
  let args;
  try {
    const req = createRequire(path.join(repoRoot, 'package.json'));
    const cliPath = req.resolve('@playwright/test/cli');
    bin = process.execPath;
    args = [cliPath, 'test', ...specPaths, '--reporter=json'];
  } catch {
    bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    args = ['playwright', 'test', ...specPaths, '--reporter=json'];
  }

  let res;
  try {
    res = _spawn(bin, args, { cwd: repoRoot, env, encoding: 'utf8', timeout: timeoutMs });
  } catch (err) {
    return { status: RUN_STATUS.SPAWN_FAILED, report: null, exitCode: null, error: err.message };
  }

  if (res.error) {
    if (looksLikePlaywrightMissing(res.error, res.stderr)) {
      return { status: RUN_STATUS.PLAYWRIGHT_MISSING, report: null, exitCode: res.status ?? null, error: res.error.message };
    }
    return { status: RUN_STATUS.SPAWN_FAILED, report: null, exitCode: res.status ?? null, error: res.error.message };
  }

  // Read + parse the report FILE independently of the exit code.
  let report = null;
  try {
    const raw = fs.readFileSync(reportFile, 'utf8');
    report = JSON.parse(raw);
  } catch {
    report = null;
  } finally {
    try { fs.unlinkSync(reportFile); } catch { /* best-effort cleanup */ }
  }

  if (report) {
    return { status: RUN_STATUS.OK, report, exitCode: res.status ?? null, error: null };
  }
  // No parseable report. If Playwright looked missing, say so; else hard-fail.
  if (looksLikePlaywrightMissing(null, res.stderr)) {
    return { status: RUN_STATUS.PLAYWRIGHT_MISSING, report: null, exitCode: res.status ?? null, error: 'playwright not installed' };
  }
  return {
    status: RUN_STATUS.REPORT_UNREADABLE, report: null, exitCode: res.status ?? null,
    error: `no parseable JSON report (exit ${res.status}); stderr: ${String(res.stderr || '').slice(0, 300)}`,
  };
}

/**
 * Flatten a Playwright JSON report into per-test results. Walks the
 * suites→specs→tests tree and returns one entry per test with its source file,
 * final status (last attempt wins for flaky retries), duration, and any
 * `criterion_hash` annotation.
 * @param {object} report  parsed Playwright JSON report
 * @returns {Array<{file:string, title:string, status:string, durationMs:number, criterionHash:string|null, errorMessage:string|null}>}
 */
export function flattenReport(report) {
  const out = [];
  const walkSuite = (suite, fileHint) => {
    const file = suite.file || fileHint || null;
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const results = test.results || [];
        const last = results[results.length - 1] || {};
        const ann = (test.annotations || spec.annotations || [])
          .find(a => a.type === 'criterion_hash');
        out.push({
          file: spec.file || file,
          title: spec.title || test.title || '',
          status: last.status || test.status || 'unknown',
          durationMs: results.reduce((s, r) => s + (r.duration || 0), 0),
          criterionHash: ann ? (ann.description || ann.value || null) : null,
          errorMessage: last.error?.message ? String(last.error.message).slice(0, 500) : null,
        });
      }
    }
    for (const child of suite.suites || []) walkSuite(child, file);
  };
  for (const suite of report?.suites || []) walkSuite(suite, null);
  return out;
}

/**
 * Map parsed plan criteria against flattened test results — the verify-mode
 * coverage algorithm (plan §2.3 R1-H5 / R2-H4), extracted as a PURE function so
 * it is unit-testable independent of the CLI / Playwright / the store.
 *
 * Every EXPECTED criterion yields exactly one item:
 *   - no matching test  → passed:false, "no matching test result";
 *   - one match         → passed from the status map;
 *   - multiple matches  → passed:false if ANY failed (records the failing msg);
 *   - duplicate expected criterion_hash → recorded ONCE (later dupes skipped).
 * A test whose criterion_hash matches no expected criterion is an ORPHAN —
 * returned separately (logged + counted by the caller) but never an item, so
 * the per-criterion table is strictly per-expected-criterion.
 *
 * @param {Array<{hash:string, severity:string, category:string, description:string, setup?:string, assertion?:string}>} criteria
 * @param {Array<{criterionHash:string|null, status:string, durationMs:number, errorMessage:string|null, title:string}>} tests
 * @returns {{ items: object[], orphanTests: string[] }}
 */
export function mapCriteriaToItems(criteria, tests) {
  const expectedHashes = new Set((criteria || []).map(c => c.hash));
  const byHash = new Map();
  const orphanTests = [];
  for (const t of tests || []) {
    // An orphan is a test with NO criterion_hash annotation OR one whose hash
    // matches no EXPECTED criterion — both are logged + counted but never an
    // item (plan §2.3 R2-H4: the per-criterion table is strictly
    // per-expected-criterion).
    if (!t.criterionHash || !expectedHashes.has(t.criterionHash)) { orphanTests.push(t.title); continue; }
    if (!byHash.has(t.criterionHash)) byHash.set(t.criterionHash, []);
    byHash.get(t.criterionHash).push(t);
  }
  const items = [];
  const seen = new Set();
  for (let i = 0; i < (criteria || []).length; i++) {
    const c = criteria[i];
    if (seen.has(c.hash)) continue; // duplicate expected hash — recorded once
    seen.add(c.hash);
    const matches = byHash.get(c.hash) || [];
    let passed, errorMessage, durationMs = 0;
    if (matches.length === 0) {
      passed = false; errorMessage = 'no matching test result';
    } else {
      passed = matches.every(m => statusToPassed(m.status).passed);
      durationMs = matches.reduce((s, m) => s + (m.durationMs || 0), 0);
      const failing = matches.find(m => !statusToPassed(m.status).passed);
      errorMessage = failing ? (failing.errorMessage || statusToPassed(failing.status).note) : null;
    }
    items.push({
      criterionHash: c.hash, criterionIndex: i,
      severity: c.severity, category: c.category, description: c.description,
      setupText: c.setup || null, assertText: c.assertion || null,
      passed, errorMessage, durationMs,
    });
  }
  return { items, orphanTests };
}

/**
 * Map a Playwright test status to the boolean `passed` contract (plan §2.3
 * status map). `passed`/`expected` → true; failure/timeout/interrupt/skip →
 * false. A flaky retry that ends green is `passed:true` (last attempt wins —
 * already resolved in flattenReport).
 * @param {string} status
 * @returns {{passed: boolean, note: string|null}}
 */
export function statusToPassed(status) {
  switch (status) {
    case 'passed':
    case 'expected':
      return { passed: true, note: null };
    case 'skipped':
      return { passed: false, note: 'skipped' };
    case 'timedOut':
      return { passed: false, note: 'timedOut' };
    case 'interrupted':
      return { passed: false, note: 'interrupted' };
    case 'failed':
    case 'unexpected':
      return { passed: false, note: null };
    default:
      return { passed: false, note: status || 'unknown' };
  }
}
