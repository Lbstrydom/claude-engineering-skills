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
  exitCodeForStatus, RUN_STATUS, mapCriteriaToItems,
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

// ── runPlaywrightJson outcome classification ────────────────────────────────

describe('runPlaywrightJson — outcome classification', () => {
  it('non-zero exit WITH a valid report → OK (R1-H4: failing tests are still recorded)', () => {
    const r = runPlaywrightJson({
      specPaths: ['tests/e2e/foo.spec.js'], cwd: repoRoot,
      _spawn: fakeSpawn(FIXTURE_REPORT, { status: 1 }),
    });
    assert.equal(r.status, RUN_STATUS.OK);
    assert.ok(r.report, 'report parsed despite non-zero exit');
    assert.equal(r.exitCode, 1);
  });

  it('spawn ENOENT → PLAYWRIGHT_MISSING (exit 5)', () => {
    const r = runPlaywrightJson({
      specPaths: ['x.spec.js'], cwd: repoRoot,
      _spawn: fakeSpawn(null, { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
    });
    assert.equal(r.status, RUN_STATUS.PLAYWRIGHT_MISSING);
    assert.equal(exitCodeForStatus(r.status), 5);
  });

  it('non-zero exit with NO parseable report → REPORT_UNREADABLE (hard error, exit 3)', () => {
    const r = runPlaywrightJson({
      specPaths: ['x.spec.js'], cwd: repoRoot,
      _spawn: fakeSpawn(null, { status: 1, writeReport: false }),
    });
    assert.equal(r.status, RUN_STATUS.REPORT_UNREADABLE);
    assert.equal(exitCodeForStatus(r.status), 3);
  });

  it('empty specPaths → SPAWN_FAILED (never spawns)', () => {
    const r = runPlaywrightJson({ specPaths: [], cwd: repoRoot, _spawn: () => { throw new Error('should not spawn'); } });
    assert.equal(r.status, RUN_STATUS.SPAWN_FAILED);
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
    const out = execFileSync('node', ['scripts/ux-lock-run.mjs', ...args], {
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
});
