/**
 * Determinism follow-ups WS2 — deterministic /ux-lock runner.
 *
 * Hermetic coverage of the runner seam (no real Playwright, no DB): the
 * subprocess outcome classification (the R1-H4 "non-zero exit + valid report
 * still records" trap), the Playwright-status map (R1-L1), report flattening
 * incl. criterion_hash annotations + flaky-retry-last-wins, spec_path
 * normalization, and the CLI argument validation. `runPlaywrightJson` takes an
 * injectable `_spawn`, so the whole parse/classify path runs without spawning
 * `npx playwright test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  runPlaywrightJson, flattenReport, statusToPassed, normalizeSpecPath,
  exitCodeForStatus, RUN_STATUS, mapCriteriaToItems, resolvePlaywrightCli,
} from '../scripts/lib/playwright-runner.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURE_REPORT = {
  suites: [{
    file: 'tests/e2e/foo.spec.js',
    specs: [
      { file: 'tests/e2e/foo.spec.js', title: 'criterion A passes',
        tests: [{ annotations: [{ type: 'criterion_hash', description: 'aaa111' }],
          results: [{ status: 'passed', duration: 100 }] }] },
      { file: 'tests/e2e/foo.spec.js', title: 'criterion B fails',
        tests: [{ annotations: [{ type: 'criterion_hash', description: 'bbb222' }],
          results: [{ status: 'failed', duration: 50, error: { message: 'boom' } }] }] },
      { file: 'tests/e2e/foo.spec.js', title: 'flaky then green',
        tests: [{ annotations: [{ type: 'criterion_hash', description: 'ccc333' }],
          results: [{ status: 'failed', duration: 20 }, { status: 'passed', duration: 30 }] }] },
    ],
  }],
};

/** Build an injectable spawn that writes the report to the env path + returns `status`. */
function fakeSpawn(report, { status = 0, writeReport = true, error = null } = {}) {
  return (_bin, _args, options) => {
    if (writeReport && report != null) {
      fs.writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(report));
    }
    return { status, error, stderr: '' };
  };
}

/**
 * Stand in for `@playwright/test/cli` resolving successfully — this SOURCE
 * repo does not have `@playwright/test` as a real dependency (only
 * consumers running `/ux-lock` specs do), so the outcome-classification
 * tests below need this to reach `_spawn` at all.
 */
const resolvableCli = () => '/fake/node_modules/@playwright/test/cli.js';

// ── runPlaywrightJson outcome classification ────────────────────────────────

describe('runPlaywrightJson — outcome classification', () => {
  it('non-zero exit WITH a valid report → OK (R1-H4: failing tests are still recorded)', () => {
    const r = runPlaywrightJson({
      specPaths: ['tests/e2e/foo.spec.js'], cwd: repoRoot, _resolveCli: resolvableCli,
      _spawn: fakeSpawn(FIXTURE_REPORT, { status: 1 }),
    });
    assert.equal(r.status, RUN_STATUS.OK);
    assert.ok(r.report, 'report parsed despite non-zero exit');
    assert.equal(r.exitCode, 1);
  });

  it('spawn ENOENT → PLAYWRIGHT_MISSING (exit 5)', () => {
    const r = runPlaywrightJson({
      specPaths: ['x.spec.js'], cwd: repoRoot, _resolveCli: resolvableCli,
      _spawn: fakeSpawn(null, { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
    });
    assert.equal(r.status, RUN_STATUS.PLAYWRIGHT_MISSING);
    assert.equal(exitCodeForStatus(r.status), 5);
  });

  it('non-zero exit with NO parseable report → REPORT_UNREADABLE (hard error, exit 3)', () => {
    const r = runPlaywrightJson({
      specPaths: ['x.spec.js'], cwd: repoRoot, _resolveCli: resolvableCli,
      _spawn: fakeSpawn(null, { status: 1, writeReport: false }),
    });
    assert.equal(r.status, RUN_STATUS.REPORT_UNREADABLE);
    assert.equal(exitCodeForStatus(r.status), 3);
  });

  it('empty specPaths → SPAWN_FAILED (never spawns)', () => {
    const r = runPlaywrightJson({ specPaths: [], cwd: repoRoot, _spawn: () => { throw new Error('should not spawn'); } });
    assert.equal(r.status, RUN_STATUS.SPAWN_FAILED);
  });

  it('H1 (round-1 audit, 2026-08-15): @playwright/test unresolvable → PLAYWRIGHT_MISSING with NO spawn attempt', () => {
    // The regression this guards: an earlier version fell back to spawning the
    // repo's package-manager `exec`/`npx` here, which for npm can silently
    // fetch-and-run a fresh copy from the registry when nothing is installed
    // locally — the opposite of "Playwright must be a pinned dependency."
    // There must now be no fallback spawn at all.
    const r = runPlaywrightJson({
      specPaths: ['x.spec.js'], cwd: repoRoot,
      _resolveCli: () => { throw new Error('Cannot find module \'@playwright/test/cli\''); },
      _spawn: () => { throw new Error('must not spawn anything when the CLI is unresolvable'); },
    });
    assert.equal(r.status, RUN_STATUS.PLAYWRIGHT_MISSING);
    assert.match(r.error, /@playwright\/test is not installed/);
  });

  it('H3 (round-2 audit, 2026-08-15): falls back to the base `playwright` package, not just @playwright/test', () => {
    // The regression this guards: fixing H1 by REMOVING the exec fallback also
    // removed the only path that ever ran the base `playwright` package's own
    // CLI — but `scripts/lib/install/deps.mjs` OPTIONAL_DEPS provisions
    // exactly `playwright`, not `@playwright/test` (dropped 2026-08-11). This
    // repo's own node_modules is a real, unmocked instance of that exact
    // shape (only the base package installed) — resolvePlaywrightCli must not
    // throw against it.
    const cli = resolvePlaywrightCli(repoRoot);
    assert.ok(fs.existsSync(cli), `resolved path must exist: ${cli}`);
    assert.match(cli, /playwright[\\/]cli\.js$/, 'must be the base package CLI, not @playwright/test');

    // And runPlaywrightJson reaches `_spawn` using the REAL default resolver
    // (not injected) — proving the fallback is wired end-to-end, not just
    // unit-testable in isolation.
    const r = runPlaywrightJson({
      specPaths: ['tests/e2e/foo.spec.js'], cwd: repoRoot,
      _spawn: fakeSpawn(FIXTURE_REPORT, { status: 0 }),
    });
    assert.equal(r.status, RUN_STATUS.OK);
  });

  it('H3 (round-4 audit, 2026-08-15): a relative cwd is normalized before CLI resolution', () => {
    // The regression this guards: `cwd` used to pass straight through as
    // `repoRoot`, so a relative value would resolve against whatever
    // process.cwd() happened to be at call time rather than the caller's
    // intended directory. Prove it by handing a relative path and checking
    // the resolver received an absolute one.
    const relative = path.relative(process.cwd(), repoRoot) || '.';
    let seenRoot = null;
    const r = runPlaywrightJson({
      specPaths: ['x.spec.js'], cwd: relative,
      _resolveCli: (root) => { seenRoot = root; return resolvableCli(root); },
      _spawn: fakeSpawn(FIXTURE_REPORT, { status: 0 }),
    });
    assert.equal(r.status, RUN_STATUS.OK);
    assert.ok(path.isAbsolute(seenRoot), `expected an absolute root, got: ${seenRoot}`);
  });
});

// ── status map (R1-L1) ──────────────────────────────────────────────────────

describe('statusToPassed — full Playwright status map', () => {
  it('passed/expected → true', () => {
    assert.equal(statusToPassed('passed').passed, true);
    assert.equal(statusToPassed('expected').passed, true);
  });
  it('failed/unexpected/timedOut/interrupted → false', () => {
    for (const s of ['failed', 'unexpected', 'timedOut', 'interrupted']) {
      assert.equal(statusToPassed(s).passed, false, `${s} should be false`);
    }
  });
  it('skipped → false with a "skipped" note', () => {
    const r = statusToPassed('skipped');
    assert.equal(r.passed, false);
    assert.equal(r.note, 'skipped');
  });
});

// ── flattenReport (incl criterion_hash + flaky-retry last-wins) ─────────────

describe('flattenReport', () => {
  const flat = flattenReport(FIXTURE_REPORT);

  it('flattens every spec test with its criterion_hash annotation', () => {
    assert.equal(flat.length, 3);
    const hashes = flat.map(t => t.criterionHash).sort();
    assert.deepEqual(hashes, ['aaa111', 'bbb222', 'ccc333']);
  });

  it('flaky retry that ends green resolves to passed (last attempt wins)', () => {
    const flaky = flat.find(t => t.criterionHash === 'ccc333');
    assert.equal(flaky.status, 'passed');
    assert.equal(statusToPassed(flaky.status).passed, true);
  });

  it('carries the error message of a failed test', () => {
    const failed = flat.find(t => t.criterionHash === 'bbb222');
    assert.equal(failed.status, 'failed');
    assert.match(failed.errorMessage, /boom/);
  });
});

// ── normalizeSpecPath ───────────────────────────────────────────────────────

describe('normalizeSpecPath', () => {
  it('makes an absolute report file repo-relative + POSIX', () => {
    const abs = path.join(repoRoot, 'tests', 'e2e', 'foo.spec.js');
    assert.equal(normalizeSpecPath(abs, repoRoot), 'tests/e2e/foo.spec.js');
  });
  it('leaves a repo-relative path as POSIX', () => {
    assert.equal(normalizeSpecPath('tests/e2e/bar.spec.js', repoRoot), 'tests/e2e/bar.spec.js');
  });
});

// ── mapCriteriaToItems — verify coverage algorithm (plan §2.3 R1-H5/R2-H4) ──

describe('mapCriteriaToItems — every expected criterion accounted for', () => {
  const crit = (hash, over = {}) => ({ hash, severity: 'P0', category: 'visibility', description: `c-${hash}`, ...over });

  it('a matched criterion takes pass/fail from the test status', () => {
    const { items } = mapCriteriaToItems(
      [crit('h1'), crit('h2')],
      [{ criterionHash: 'h1', status: 'passed', durationMs: 10, errorMessage: null, title: 't1' },
       { criterionHash: 'h2', status: 'failed', durationMs: 5, errorMessage: 'boom', title: 't2' }],
    );
    assert.equal(items.find(i => i.criterionHash === 'h1').passed, true);
    const f = items.find(i => i.criterionHash === 'h2');
    assert.equal(f.passed, false);
    assert.match(f.errorMessage, /boom/);
  });

  it('a criterion with NO matching test → passed:false "no matching test result"', () => {
    const { items } = mapCriteriaToItems([crit('h1'), crit('missing')],
      [{ criterionHash: 'h1', status: 'passed', durationMs: 1, errorMessage: null, title: 't' }]);
    const m = items.find(i => i.criterionHash === 'missing');
    assert.equal(m.passed, false);
    assert.equal(m.errorMessage, 'no matching test result');
    assert.equal(items.length, 2, 'every expected criterion still produces an item');
  });

  it('multiple matches for one hash → fail if ANY failed', () => {
    const { items } = mapCriteriaToItems([crit('h1')],
      [{ criterionHash: 'h1', status: 'passed', durationMs: 1, errorMessage: null, title: 'a' },
       { criterionHash: 'h1', status: 'failed', durationMs: 2, errorMessage: 'x', title: 'b' }]);
    assert.equal(items.length, 1);
    assert.equal(items[0].passed, false);
  });

  it('duplicate expected criterion_hash → recorded once', () => {
    const { items } = mapCriteriaToItems([crit('dup'), crit('dup'), crit('h2')],
      [{ criterionHash: 'dup', status: 'passed', durationMs: 1, errorMessage: null, title: 't' }]);
    assert.equal(items.filter(i => i.criterionHash === 'dup').length, 1);
  });

  it('an orphan test (no expected criterion) is returned separately, NOT an item', () => {
    const { items, orphanTests } = mapCriteriaToItems([crit('h1')],
      [{ criterionHash: 'h1', status: 'passed', durationMs: 1, errorMessage: null, title: 'real' },
       { criterionHash: 'ghost', status: 'failed', durationMs: 1, errorMessage: null, title: 'orphan-test' }]);
    assert.equal(items.length, 1, 'only the expected criterion is an item');
    assert.deepEqual(orphanTests, ['orphan-test']);
  });
});

// ── CLI argument validation ─────────────────────────────────────────────────

function runCli(args) {
  try {
    const out = execFileSync(process.execPath, ['scripts/ux-lock-run.mjs', ...args], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: out, status: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', status: err.status ?? 1 };
  }
}
function lastJson(stdout) {
  const lines = stdout.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* skip banner */ }
  }
  return null;
}

describe('ux-lock-run CLI — arg validation', () => {
  it('selfcheck-relocation prints OK and exits 0', () => {
    const { stdout, status } = runCli(['--selfcheck-relocation']);
    assert.match(stdout, /OK/);
    assert.equal(status, 0);
  });
  it('spec without --spec → BAD_INPUT, non-zero exit', () => {
    const { stdout, status } = runCli(['spec']);
    const json = lastJson(stdout);
    assert.equal(json?.error?.code, 'BAD_INPUT');
    assert.notEqual(status, 0);
  });
  it('verify without --plan → BAD_INPUT, non-zero exit', () => {
    const { stdout, status } = runCli(['verify', '--spec', 'x.spec.js']);
    const json = lastJson(stdout);
    assert.equal(json?.error?.code, 'BAD_INPUT');
    assert.notEqual(status, 0);
  });

  // Regression: finding f38a0a34. opt()'s scalar-option reader used
  // `rest.indexOf` alone, so a repeated flag silently kept the FIRST value
  // with no diagnostic (`--commit old --commit new` used `old`) instead of
  // refusing the ambiguous double-specification.
  it('a scalar option supplied TWICE is refused, not silently resolved to the first value', () => {
    const { stdout, status } = runCli(['spec', '--spec', 'x.spec.js', '--commit', 'old', '--commit', 'new']);
    const json = lastJson(stdout);
    assert.equal(json?.error?.code, 'BAD_INPUT');
    assert.match(json?.error?.message ?? '', /--commit was supplied 2 times/);
    assert.notEqual(status, 0);
  });

  it('a scalar option supplied ONCE still works normally (no false positive)', () => {
    // spec without --commit fails earlier on BAD_INPUT for other reasons in this
    // harness (no real repo/spec), so assert on --url instead, which reaches the
    // same opt() path — the point is a single occurrence must not trip the guard.
    const { stdout } = runCli(['spec', '--spec', 'x.spec.js', '--url', 'http://localhost:3000']);
    const json = lastJson(stdout);
    assert.notEqual(json?.error?.code, 'BAD_INPUT_DUPLICATE');
    assert.doesNotMatch(json?.error?.message ?? '', /was supplied \d+ times/);
  });
});

// ── selector-policy wiring (plan: docs/plans/ux-lock-selector-policy.md) ────

import os from 'node:os';
import { insertRunRowWithPolicyFallback } from '../scripts/lib/store/plans-ship.mjs';

function runCliFull(args) {
  try {
    const out = execFileSync(process.execPath, ['scripts/ux-lock-run.mjs', ...args], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: out, stderr: '', status: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', status: err.status ?? 1 };
  }
}

function tmpSpec(content, name = 'fixture.spec.js') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxlock-selpol-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('ux-lock-run CLI — selector-policy lint', () => {
  it('--strict-selectors blocks pre-run on an unjustified structural selector (exit 6)', () => {
    const spec = tmpSpec(`import { test, expect } from '@playwright/test';\ntest('x', async ({ page }) => { await page.locator('#add-btn').click(); });\n`);
    const { stdout, stderr, status } = runCliFull(['spec', '--spec', spec, '--strict-selectors', '--no-register']);
    assert.equal(status, 6);
    const json = lastJson(stdout);
    assert.equal(json?.error?.code, 'SELECTOR_POLICY_STRICT');
    assert.match(stderr, /structural-selector/);
  });

  it('a justified structural selector passes strict pre-run (proceeds to Playwright)', () => {
    const spec = tmpSpec([
      `import { test, expect } from '@playwright/test';`,
      `test('x', async ({ page }) => {`,
      `  // selector-policy: structural — vendor widget renders no roles or testids`,
      `  await page.locator('#vendor-root').click();`,
      `});`,
    ].join('\n'));
    const { stdout, status } = runCliFull(['spec', '--spec', spec, '--strict-selectors', '--no-register']);
    const json = lastJson(stdout);
    // Scan passed — any failure now comes from the Playwright stage, not the lint.
    assert.notEqual(json?.error?.code, 'SELECTOR_POLICY_STRICT');
    assert.notEqual(status, 6);
  });

  it('default (warn) mode prints the SELECTOR POLICY block but does not exit 6', () => {
    const spec = tmpSpec(`import { test } from '@playwright/test';\ntest('x', async ({ page }) => { await page.locator('.legacy').click(); });\n`);
    const { stderr, status } = runCliFull(['spec', '--spec', spec, '--no-register']);
    assert.match(stderr, /SELECTOR POLICY/);
    assert.match(stderr, /structural-selector/);
    assert.notEqual(status, 6);
  });

  it('unreadable --spec fails closed (exit 2, SELECTOR_SCAN_INCOMPLETE)', () => {
    const { stdout, status } = runCliFull(['spec', '--spec', path.join(os.tmpdir(), 'uxlock-nope', 'missing.spec.js'), '--no-register']);
    assert.equal(status, 2);
    assert.equal(lastJson(stdout)?.error?.code, 'SELECTOR_SCAN_INCOMPLETE');
  });

  it('app-module-import in the spec is flagged (strict → exit 6)', () => {
    const spec = tmpSpec(`import { app } from '../../src/app.js';\nimport { test } from '@playwright/test';\n`);
    const { stdout, stderr, status } = runCliFull(['spec', '--spec', spec, '--strict-selectors', '--no-register']);
    assert.equal(status, 6);
    assert.equal(lastJson(stdout)?.error?.code, 'SELECTOR_POLICY_STRICT');
    assert.match(stderr, /app-module-import/);
  });
});

describe('insertRunRowWithPolicyFallback — 42703-only discrimination', () => {
  const row = { spec_id: 's1', passed: true, selector_policy_violations: 3 };

  it('42703 → retries ONCE without the column', async () => {
    const calls = [];
    const insertFn = async (table, r) => {
      calls.push(r);
      if ('selector_policy_violations' in r) {
        throw Object.assign(new Error('column "selector_policy_violations" does not exist'), { code: '42703' });
      }
      return { id: 'row1' };
    };
    const out = await insertRunRowWithPolicyFallback('regression_spec_runs', { ...row }, undefined, insertFn);
    assert.equal(out.id, 'row1');
    assert.equal(calls.length, 2);
    assert.ok(!('selector_policy_violations' in calls[1]));
  });

  it('any other error code propagates (no swallow, no retry)', async () => {
    let calls = 0;
    const insertFn = async () => { calls++; throw Object.assign(new Error('boom'), { code: '23505' }); };
    await assert.rejects(
      () => insertRunRowWithPolicyFallback('regression_spec_runs', { ...row }, undefined, insertFn),
      /boom/,
    );
    assert.equal(calls, 1);
  });

  it('42703 on a row WITHOUT the column propagates (a real schema bug, not our fallback)', async () => {
    const insertFn = async () => { throw Object.assign(new Error('other col'), { code: '42703' }); };
    await assert.rejects(
      () => insertRunRowWithPolicyFallback('regression_spec_runs', { spec_id: 's1', passed: true }, undefined, insertFn),
      /other col/,
    );
  });
});

describe('ux-lock-run CLI — strict mode refuses unresolved aliases (audit R1-H6)', () => {
  it('unmapped alias import under --strict-selectors → exit 6', () => {
    const spec = tmpSpec(`import x from '~/shell/app.js';\nimport { test } from '@playwright/test';\n`);
    const { stdout, status } = runCliFull(['spec', '--spec', spec, '--strict-selectors', '--no-register']);
    assert.equal(status, 6);
    assert.equal(lastJson(stdout)?.error?.code, 'SELECTOR_POLICY_UNRESOLVED_ALIAS');
  });

  it('warn mode keeps the unresolved alias as a non-fatal warning', () => {
    const spec = tmpSpec(`import x from '~/shell/app.js';\nimport { test } from '@playwright/test';\n`);
    const { stderr, status } = runCliFull(['spec', '--spec', spec, '--no-register']);
    assert.match(stderr, /unresolved-alias-import/);
    assert.notEqual(status, 6);
  });
});

describe('ux-lock-run CLI — strict mode refuses unresolvable globs (audit R2-M4)', () => {
  it('--strict-selectors + --specs glob → fail closed before any execution', () => {
    const { stdout, status } = runCliFull(['spec', '--specs', 'tests/e2e/*.spec.js', '--strict-selectors', '--no-register']);
    assert.equal(status, 2);
    assert.equal(lastJson(stdout)?.error?.code, 'SELECTOR_STRICT_GLOB_UNRESOLVED');
  });
});

// ── mapCriteriaToItems: skipped vs failed (store-hardening #7) ──────────────

describe('mapCriteriaToItems — skipped is distinct from failed', () => {
  const crit = (hash, severity = 'P1') => ({ hash, severity, category: 'x', description: hash });

  it('a criterion whose only test was skipped → skipped:true, passed:false', () => {
    const { items } = mapCriteriaToItems([crit('h1')],
      [{ criterionHash: 'h1', status: 'skipped', durationMs: 0, errorMessage: null, title: 't' }]);
    assert.equal(items[0].skipped, true);
    assert.equal(items[0].passed, false);
  });

  it('a genuinely failed criterion is NOT skipped', () => {
    const { items } = mapCriteriaToItems([crit('h1')],
      [{ criterionHash: 'h1', status: 'failed', durationMs: 5, errorMessage: 'boom', title: 't' }]);
    assert.equal(items[0].skipped, false);
    assert.equal(items[0].passed, false);
  });

  it('a criterion with NO matching test is a coverage gap, not skipped', () => {
    const { items } = mapCriteriaToItems([crit('h1')], []);
    assert.equal(items[0].skipped, false);
    assert.equal(items[0].passed, false);
    assert.equal(items[0].errorMessage, 'no matching test result');
  });

  it('mixed skipped + failed matches → not skipped (a real failure dominates)', () => {
    const { items } = mapCriteriaToItems([crit('h1')], [
      { criterionHash: 'h1', status: 'skipped', durationMs: 0, errorMessage: null, title: 'a' },
      { criterionHash: 'h1', status: 'failed', durationMs: 3, errorMessage: 'x', title: 'b' },
    ]);
    assert.equal(items[0].skipped, false);
    assert.equal(items[0].passed, false);
  });

  it('a passed criterion is neither skipped nor failed', () => {
    const { items } = mapCriteriaToItems([crit('h1')],
      [{ criterionHash: 'h1', status: 'passed', durationMs: 2, errorMessage: null, title: 't' }]);
    assert.equal(items[0].skipped, false);
    assert.equal(items[0].passed, true);
  });
});
