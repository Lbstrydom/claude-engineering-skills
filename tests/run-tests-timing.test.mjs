/**
 * @fileoverview Per-file test timing (scripts/lib/test-timing-report.mjs, the reporter in test-timing-reporter.mjs, and their use in
 * scripts/run-tests.mjs). Plan: docs/plans/gate-cost-slice-1.md.
 *
 * THE GUARANTEE THAT MATTERS: telemetry cannot change a verdict. It is proved against the
 * right baseline: the SAME fixture run through `node --test` WITHOUT the timing reporter,
 * compared by exit code and by a canonical TAP (durations removed, nothing else), including
 * with an unwritable timing path. Comparing `finishRun` with `adjudicateRun` alone would
 * compare the verdict with itself.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { GUARD_REPORT_VERSION } from '../scripts/lib/test-guard-reporter.mjs';
import testTimingReporter from '../scripts/lib/test-timing-reporter.mjs';
import {
  TIMING_REPORT_ENV,
  TIMING_REPORT_VERSION,
  accumulateFileTimes,
  fileIdentity,
  parseTimingReport,
  ranFiles,
  ranFilesUnavailableReason,
  summariseTiming,
} from '../scripts/lib/test-timing-report.mjs';
import { adjudicateRun, buildReporterArgs, extractReporterFlags, finishRun, partitionArgs, scrubChildEnv } from '../scripts/run-tests.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const FIX = (name) => path.join(ROOT, 'tests', 'fixtures', 'test-guard', `${name}.fixture.mjs`);
const RUNNER = path.join(ROOT, 'scripts', 'run-tests.mjs');

const ev = (type, file, duration, nesting = 0) => ({ type, data: { nesting, file, name: 'n', details: { duration_ms: duration } } });
const withTmp = (fn) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-timing-'));
  try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
};
const withTmpAsync = async (fn) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-timing-'));
  try { return await fn(d); } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
};
const goodGuard = JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [] });

// ── the event contract ──────────────────────────────────────────────────────

describe('accumulateFileTimes — the event contract', () => {
  const root = path.join(os.tmpdir(), 'repo');
  const f = (n) => path.join(root, 'tests', n);

  it('counts nesting-0 pass and fail events once each and sums per file', () => {
    const r = accumulateFileTimes([
      ev('test:pass', f('a.test.mjs'), 100), ev('test:fail', f('a.test.mjs'), 50), ev('test:pass', f('b.test.mjs'), 10),
    ], { root });
    assert.deepEqual(r.files, [{ file: 'tests/a.test.mjs', ms: 150, tests: 2 }, { file: 'tests/b.test.mjs', ms: 10, tests: 1 }]);
    assert.equal(r.totalMs, 160);
    assert.equal(r.version, TIMING_REPORT_VERSION);
  });

  it('ignores nested events (a suite already covers its subtests), other event types, and fileless events', () => {
    const r = accumulateFileTimes([
      ev('test:pass', f('a.test.mjs'), 100, 1), ev('test:start', f('a.test.mjs'), 5), ev('test:diagnostic', f('a.test.mjs'), 5),
      { type: 'test:pass', data: { nesting: 0, details: { duration_ms: 9 } } }, { type: 'test:pass', data: null }, null, undefined, 42,
    ], { root });
    assert.deepEqual(r.files, []);
    assert.equal(r.totalMs, 0);
  });

  it('a non-finite, negative or missing duration still counts the event, as 0 ms, and is tallied', () => {
    const r = accumulateFileTimes([
      ev('test:pass', f('a.test.mjs'), Number.NaN), ev('test:pass', f('a.test.mjs'), -3), ev('test:pass', f('a.test.mjs'), undefined),
      ev('test:pass', f('a.test.mjs'), Infinity), ev('test:pass', f('a.test.mjs'), 7),
    ], { root });
    assert.deepEqual(r.files, [{ file: 'tests/a.test.mjs', ms: 7, tests: 5 }]);
    assert.equal(r.ignored, 4);
  });

  it('an event whose accessors throw is counted as ignored, never thrown', () => {
    const hostile = { type: 'test:pass', get data() { throw new Error('boom'); } };
    assert.doesNotThrow(() => accumulateFileTimes([hostile, ev('test:pass', f('a.test.mjs'), 1)], { root }));
    assert.equal(accumulateFileTimes([hostile], { root }).ignored, 1);
  });

  it('file identity is repo-relative with forward slashes; a path outside the root stays absolute', () => {
    assert.equal(fileIdentity(path.join(root, 'tests', 'claudemd', 'x.test.mjs'), root), 'tests/claudemd/x.test.mjs');
    assert.equal(fileIdentity(path.join(os.tmpdir(), 'elsewhere', 'y.test.mjs'), root).includes('..'), false);
  });

  it('a file-level failure (an import error) is a normal entry, with whatever duration node gave it', () => {
    const r = accumulateFileTimes([ev('test:fail', f('broken.test.mjs'), 12)], { root });
    assert.deepEqual(r.files, [{ file: 'tests/broken.test.mjs', ms: 12, tests: 1 }]);
  });
});

// ── the reader ──────────────────────────────────────────────────────────────

describe('summariseTiming', () => {
  const report = (files, complete = true) => JSON.stringify({ version: TIMING_REPORT_VERSION, complete, files, totalMs: files.reduce((n, x) => n + x.ms, 0), ignored: 0 });

  it('prints the slowest first with shares, names the unit, and caps at top-N', () => {
    const text = report([{ file: 'tests/big.test.mjs', ms: 90_000, tests: 5 }, { file: 'tests/small.test.mjs', ms: 10_000, tests: 1 }, { file: 'tests/tiny.test.mjs', ms: 0, tests: 1 }]);
    const out = summariseTiming(text, { top: 2 });
    assert.equal(out.ok, true);
    assert.match(out.lines[0], /2 of 3.*test-body time as node reports it, not process wall time.*total 100\.0 s/);
    assert.match(out.lines[1], /90\.0 s\s+90%\s+tests\/big\.test\.mjs/);
    assert.match(out.lines[2], /10\.0 s\s+10%\s+tests\/small\.test\.mjs/);
    assert.equal(out.lines.length, 3);
  });

  it('N larger than the file count shows them all', () => {
    const out = summariseTiming(report([{ file: 'a', ms: 1000, tests: 1 }]), { top: 50 });
    assert.match(out.lines[0], /1 of 1/);
  });

  it('no files, or a zero total, reads "no timing recorded" — never a table of zeros', () => {
    assert.deepEqual(summariseTiming(report([])).lines, ['No test timing recorded.']);
    assert.deepEqual(summariseTiming(report([{ file: 'a', ms: 0, tests: 1 }])).lines, ['No test timing recorded.']);
  });

  it('a PARTIAL report says so above the table, and is not evidence of which files ran (audit round 1, M3)', () => {
    const text = report([{ file: 'tests/a.test.mjs', ms: 5000, tests: 1 }], false);
    const out = summariseTiming(text);
    assert.equal(out.ok, true);
    assert.match(out.lines[0], /PARTIAL.*understate/);
    assert.match(out.lines[1], /Slowest test files/);
    assert.equal(ranFiles(text), null, 'a list that may be missing files must not be taken as the set that ran');
    assert.equal(ranFilesUnavailableReason(text), 'the timing report is partial (its event stream failed before the end)');
    assert.deepEqual(summariseTiming(report([], false)).lines.slice(0, 2).map((l) => l.slice(0, 20)), ['Test timing is PARTI', 'No test timing recor']);
    assert.equal(ranFilesUnavailableReason(report([])), null, 'a complete report has no reason to give');
  });

  it('every unusable report is "timing unavailable" with its reason', () => {
    const bad = {
      'no report': null,
      unparseable: 'not json',
      'wrong version': JSON.stringify({ version: 'test-timing/v0', complete: true, files: [], totalMs: 0 }),
      'no complete flag': JSON.stringify({ version: TIMING_REPORT_VERSION, files: [], totalMs: 0 }),
      'complete is not a boolean': JSON.stringify({ version: TIMING_REPORT_VERSION, complete: 'yes', files: [], totalMs: 0 }),
      'no files array': JSON.stringify({ version: TIMING_REPORT_VERSION, complete: true, totalMs: 0 }),
      'bad totalMs': JSON.stringify({ version: TIMING_REPORT_VERSION, complete: true, files: [], totalMs: -1 }),
      'non-finite ms': JSON.stringify({ version: TIMING_REPORT_VERSION, complete: true, files: [{ file: 'a', ms: null, tests: 1 }], totalMs: 0 }),
      'empty file name': JSON.stringify({ version: TIMING_REPORT_VERSION, complete: true, files: [{ file: '', ms: 1, tests: 1 }], totalMs: 1 }),
      'string tests': JSON.stringify({ version: TIMING_REPORT_VERSION, complete: true, files: [{ file: 'a', ms: 1, tests: '1' }], totalMs: 1 }),
    };
    for (const [name, text] of Object.entries(bad)) {
      const out = summariseTiming(text);
      assert.equal(out.ok, false, name);
      assert.match(out.lines[0], /^Test timing unavailable \(.+\)\.$/, name);
      assert.equal(ranFiles(text), null, `${name}: ranFiles must not trust it either`);
      assert.equal(parseTimingReport(text).ok, false, name);
    }
  });
});

// ── the reporter: contained at the source ───────────────────────────────────

async function* events(list, { throwAfter = false } = {}) {
  for (const e of list) yield e;
  if (throwAfter) throw new Error('stream failed');
}
const drain = async (gen) => { const out = []; for await (const x of gen) out.push(x); return out; };

describe('testTimingReporter — best-effort, yields nothing', () => {
  const sample = [ev('test:pass', path.join(process.cwd(), 'tests', 'x.test.mjs'), 5)];

  it('writes its report to TEST_TIMING_REPORT and yields nothing', async () => {
    await withTmpAsync(async (d) => {
      const target = path.join(d, 't.json');
      process.env[TIMING_REPORT_ENV] = target;
      try { assert.deepEqual(await drain(testTimingReporter(events(sample))), []); } finally { delete process.env[TIMING_REPORT_ENV]; }
      assert.deepEqual(ranFiles(fs.readFileSync(target, 'utf8')), new Set(['tests/x.test.mjs']));
    });
  });

  it('an unwritable destination (a directory) is swallowed', async () => {
    await withTmpAsync(async (d) => {
      process.env[TIMING_REPORT_ENV] = d;
      try { assert.deepEqual(await drain(testTimingReporter(events(sample))), []); } finally { delete process.env[TIMING_REPORT_ENV]; }
    });
  });

  it('a failing source stream still writes what it gathered, MARKED PARTIAL, and never throws', async () => {
    await withTmpAsync(async (d) => {
      const target = path.join(d, 't.json');
      process.env[TIMING_REPORT_ENV] = target;
      try { await drain(testTimingReporter(events(sample, { throwAfter: true }))); } finally { delete process.env[TIMING_REPORT_ENV]; }
      const written = fs.readFileSync(target, 'utf8');
      assert.equal(parseTimingReport(written).report.files.length, 1, 'what it gathered is still there');
      assert.equal(parseTimingReport(written).report.complete, false, 'but it must not read as the whole run');
      assert.equal(ranFiles(written), null);
    });
  });

  it('a stream that ends normally is written complete', async () => {
    await withTmpAsync(async (d) => {
      const target = path.join(d, 't.json');
      process.env[TIMING_REPORT_ENV] = target;
      try { await drain(testTimingReporter(events(sample))); } finally { delete process.env[TIMING_REPORT_ENV]; }
      assert.equal(parseTimingReport(fs.readFileSync(target, 'utf8')).report.complete, true);
    });
  });

  it('with no destination configured it writes nothing and does not throw', async () => {
    delete process.env[TIMING_REPORT_ENV];
    assert.deepEqual(await drain(testTimingReporter(events(sample))), []);
  });
});

// ── verdict independence ────────────────────────────────────────────────────

describe('finishRun — the exit code is adjudicateRun\'s on the same inputs, whatever the timing text', () => {
  const timings = {
    null: null,
    garbage: '{{{',
    'wrong version': JSON.stringify({ version: 'x', files: [], totalMs: 0 }),
    invalid: JSON.stringify({ version: TIMING_REPORT_VERSION, complete: true, files: [{}], totalMs: 1 }),
    partial: JSON.stringify({ version: TIMING_REPORT_VERSION, complete: false, files: [{ file: 'a', ms: 5, tests: 1 }], totalMs: 5, ignored: 0 }),
    valid: JSON.stringify({ version: TIMING_REPORT_VERSION, complete: true, files: [{ file: 'a', ms: 5, tests: 1 }], totalMs: 5, ignored: 0 }),
  };
  const verdicts = {
    'pass': { status: 0, reportText: goodGuard },
    'child failed': { status: 1, reportText: goodGuard },
    'killed': { status: null, reportText: goodGuard },
    'guard report missing (fails closed)': { status: 0, reportText: null },
    'guard report unparseable': { status: 0, reportText: 'nope' },
  };
  for (const [vname, v] of Object.entries(verdicts)) {
    for (const [tname, timingText] of Object.entries(timings)) {
      it(`${vname} × timing ${tname}`, () => {
        assert.equal(finishRun({ ...v, timingText }).exitCode, adjudicateRun(v).exitCode);
      });
    }
  }

  it('the guard message still leads the output', () => {
    const out = finishRun({ status: 0, reportText: null, timingText: timings.valid });
    assert.match(out.lines[0], /test-guard:/);
    assert.match(out.lines.join('\n'), /Slowest test files/);
  });
});

// ── instrumented versus baseline, against real runs ─────────────────────────

/** TAP with ONLY the volatile duration fields removed. Everything else must match exactly. */
const canonicalTap = (text) => text.replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*duration_ms: [\d.]+\s*$/.test(l) && !/^# duration_ms [\d.]+\s*$/.test(l)).join('\n');

function runNodeTest(fixture, { timingEnabled, timingEnv }, tmp) {
  const reportPath = path.join(tmp, `guard-${timingEnabled}.json`);
  const argv = ['--test', ...buildReporterArgs([], { isTTY: false, reportPath, timingEnabled }), fixture];
  const env = { ...scrubChildEnv(process.env) };
  if (timingEnv !== undefined) env[TIMING_REPORT_ENV] = timingEnv;
  const r = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, guard: fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : null };
}

describe('canonicalTap — the comparison instrument', () => {
  const a = 'TAP version 13\nok 1 - x\n  ---\n  duration_ms: 1.5\n  ...\n1..1\n# duration_ms 40.2\n';
  it('accepts two outputs that differ only in durations', () => {
    assert.equal(canonicalTap(a), canonicalTap(a.replace('1.5', '999.1').replace('40.2', '7')));
  });
  it('REJECTS a differing outcome, name or count (a normaliser that hides those is not an instrument)', () => {
    assert.notEqual(canonicalTap(a), canonicalTap(a.replace('ok 1 - x', 'not ok 1 - x')));
    assert.notEqual(canonicalTap(a), canonicalTap(a.replace('- x', '- y')));
    assert.notEqual(canonicalTap(a), canonicalTap(a.replace('1..1', '1..2')));
  });
});

describe('instrumented run versus baseline run (the same fixture, without the timing reporter)', () => {
  for (const name of ['healthy', 'construction-failure', 'failing-todo']) {
    it(`${name}: same exit code, same guard report, same canonical TAP, even with an unwritable timing path`, () => {
      withTmp((tmp) => {
        const base = runNodeTest(FIX(name), { timingEnabled: false }, tmp);
        const timed = runNodeTest(FIX(name), { timingEnabled: true, timingEnv: path.join(tmp, 'timing.json') }, tmp);
        const unwritable = runNodeTest(FIX(name), { timingEnabled: true, timingEnv: tmp }, tmp); // a directory
        for (const [label, run] of [['timed', timed], ['unwritable', unwritable]]) {
          assert.equal(run.status, base.status, `${label}: exit code moved`);
          assert.equal(run.guard, base.guard, `${label}: the guard report moved`);
          assert.equal(canonicalTap(run.stdout), canonicalTap(base.stdout), `${label}: the TAP moved (the reporter must add no output)`);
        }
        // vacuous-pass guard: the timed run really did write a usable report naming the fixture
        const written = ranFiles(fs.readFileSync(path.join(tmp, 'timing.json'), 'utf8'));
        assert.ok(written && [...written].some((x) => x.endsWith(`${name}.fixture.mjs`)), `no usable timing for ${name}: ${[...(written ?? [])]}`);
      });
    });
  }
});

describe('the real runner end to end (reusing the guard fixtures)', () => {
  const run = (fixture) => spawnSync(process.execPath, [RUNNER, fixture], { cwd: ROOT, encoding: 'utf8', env: scrubChildEnv(process.env) });

  it('a healthy file exits 0 and the summary names it', () => {
    const r = run(FIX('healthy'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Slowest test files/);
    assert.match(r.stderr, /healthy\.fixture\.mjs/, 'vacuous-pass guard: the probe found the file it ran');
  });

  it('TEST_TIMING_KEEP keeps the full report; an unwritable keep path is a note, not a verdict', () => {
    withTmp((tmp) => {
      const keep = path.join(tmp, 'kept.json');
      const ok = spawnSync(process.execPath, [RUNNER, FIX('healthy')], { cwd: ROOT, encoding: 'utf8', env: { ...scrubChildEnv(process.env), TEST_TIMING_KEEP: keep } });
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(parseTimingReport(fs.readFileSync(keep, 'utf8')).ok, true);
      assert.ok([...ranFiles(fs.readFileSync(keep, 'utf8'))].some((x) => x.endsWith('healthy.fixture.mjs')));
      const bad = spawnSync(process.execPath, [RUNNER, FIX('healthy')], { cwd: ROOT, encoding: 'utf8', env: { ...scrubChildEnv(process.env), TEST_TIMING_KEEP: tmp } }); // a directory
      assert.equal(bad.status, 0, 'an unwritable keep path moved the verdict');
      assert.match(bad.stderr, /TEST_TIMING_KEEP: could not write/);
    });
  });

  it('a nested runner does not inherit TEST_TIMING_KEEP (the scrub list carries it)', () => {
    const env = scrubChildEnv({ TEST_TIMING_KEEP: '/operator/path.json', NODE_TEST_CONTEXT: 'child-v8', KEEP_ME: '1' });
    assert.equal('TEST_TIMING_KEEP' in env, false);
    assert.equal('NODE_TEST_CONTEXT' in env, false);
    assert.equal(env.KEEP_ME, '1');
  });

  it('a construction failure still exits 1 and the summary is still printed', () => {
    const r = run(FIX('construction-failure'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /test-guard:|construction-failure\.fixture\.mjs/);
    assert.match(r.stderr, /Slowest test files/);
  });
});

// ── argv order (the audit's debt item G1) ───────────────────────────────────

/** Node's positional pairing: the i-th reporter gets the i-th destination, if any. */
function pairReporters(argv) {
  const reporters = [];
  const dests = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--test-reporter') reporters.push(argv[++i]);
    else if (a.startsWith('--test-reporter=')) reporters.push(a.slice('--test-reporter='.length));
    else if (a === '--test-reporter-destination') dests.push(argv[++i]);
    else if (a.startsWith('--test-reporter-destination=')) dests.push(a.slice('--test-reporter-destination='.length));
  }
  return reporters.map((r, i) => [r, dests[i] ?? 'stdout(default)']);
}

describe('buildReporterArgs with the timing reporter', () => {
  it('keeps the guard pair contiguous and LAST in the fragment, with timing before it', () => {
    const args = buildReporterArgs(['--test-reporter=dot'], { isTTY: false, reportPath: '/r.json', timingEnabled: true });
    assert.deepEqual(args.slice(-4), ['--test-reporter', args.at(-3), '--test-reporter-destination', '/r.json']);
    assert.match(args.at(-3), /test-guard-reporter\.mjs$/);
    assert.ok(args.findIndex((a) => /test-timing-reporter\.mjs$/.test(a)) < args.length - 4);
  });

  it('timing off adds nothing (the existing default stays byte-identical)', () => {
    const off = buildReporterArgs([], { isTTY: false, reportPath: '/r.json' });
    assert.equal(off.some((a) => /timing/.test(a)), false);
  });

  it('a caller reporter without a destination is paired by extractReporterFlags, not left for node to reject', () => {
    // The previous version of this test modelled node as "a reporter with no destination defaults to
    // stdout". It does not: node refuses (ERR_INVALID_ARG_VALUE) any run whose reporter and
    // destination counts differ, except exactly one reporter. The real-run test below pins that.
    const { pairs, others } = extractReporterFlags(['--test-reporter', 'dot', 'tests/x.test.mjs']);
    assert.deepEqual(pairs, ['--test-reporter', 'dot', '--test-reporter-destination', 'stdout']);
    assert.deepEqual(others, ['tests/x.test.mjs']);
    const argv = ['--test', ...buildReporterArgs(pairs, { isTTY: false, reportPath: '/r.json', timingEnabled: true }), ...pairs];
    const paired = pairReporters(argv);
    assert.equal(paired.find(([r]) => /test-guard-reporter/.test(r))[1], '/r.json');
    assert.equal(paired.find(([r]) => /test-timing-reporter/.test(r))[1], 'stdout');
    assert.deepEqual(paired.find(([r]) => r === 'dot'), ['dot', 'stdout']);
    assert.equal(argv.filter((a) => a === '--test-reporter').length, argv.filter((a) => a === '--test-reporter-destination').length, 'counts must balance');
  });
});

describe('extractReporterFlags — node needs equal reporter and destination counts', () => {
  const D = '--test-reporter-destination';
  it('balances every spelling and keeps the caller\'s own destinations', () => {
    assert.deepEqual(extractReporterFlags(['--test-reporter=dot']).pairs, ['--test-reporter', 'dot', D, 'stdout']);
    assert.deepEqual(extractReporterFlags(['--test-reporter', 'dot', D, 'out.txt']).pairs, ['--test-reporter', 'dot', D, 'out.txt']);
    assert.deepEqual(extractReporterFlags([`${D}=out.txt`, '--test-reporter=dot']).pairs, ['--test-reporter', 'dot', D, 'out.txt'], 'order of the two flags is irrelevant, as in node');
    assert.deepEqual(extractReporterFlags(['--test-reporter=a', '--test-reporter=b', `${D}=x`]).pairs, ['--test-reporter', 'a', D, 'x', '--test-reporter', 'b', D, 'stdout'], 'pairing is by index, the last reporter takes the default');
  });
  it('touches nothing else, and a reporter flag with no value is left for node to reject', () => {
    assert.deepEqual(extractReporterFlags(['--test-name-pattern', 'x', 'tests/a.test.mjs']), { pairs: [], others: ['--test-name-pattern', 'x', 'tests/a.test.mjs'] });
    assert.deepEqual(extractReporterFlags(['--test-reporter']).others, ['--test-reporter']);
    assert.deepEqual(extractReporterFlags([]), { pairs: [], others: [] });
  });
  it('a destination with no reporter stays unmatched so node reports the caller\'s mistake', () => {
    assert.deepEqual(extractReporterFlags([`${D}=x`]).pairs, [D, 'x']);
  });

  it('REAL RUN: a caller\'s reporter with no destination used to be refused by node; through the runner it runs (audit round 1, H1)', () => {
    // MIRROR: raw node, with the same shape the runner used to build, really does refuse.
    const raw = spawnSync(process.execPath, ['--test', '--test-reporter', 'tap', '--test-reporter-destination', 'stdout', '--test-reporter', 'dot', FIX('healthy')], { cwd: ROOT, encoding: 'utf8', env: scrubChildEnv(process.env) });
    assert.notEqual(raw.status, 0);
    assert.match(raw.stderr, /ERR_INVALID_ARG_VALUE/, 'the hazard is gone: extractReporterFlags is no longer needed');
    for (const forwarded of [['--test-reporter=dot'], ['--test-reporter', 'dot']]) {
      const r = spawnSync(process.execPath, [RUNNER, ...forwarded, FIX('healthy')], { cwd: ROOT, encoding: 'utf8', env: scrubChildEnv(process.env) });
      assert.equal(r.status, 0, `${forwarded.join(' ')}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /ERR_INVALID_ARG_VALUE/);
      assert.match(r.stderr, /Slowest test files/, 'the guard and the timing reporter still ran alongside the caller\'s');
    }
  });

  it('REAL RUN: the guard still catches a construction failure when the caller names a reporter', () => {
    const r = spawnSync(process.execPath, [RUNNER, '--test-reporter=dot', FIX('construction-failure')], { cwd: ROOT, encoding: 'utf8', env: scrubChildEnv(process.env) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /test-guard:/);
  });

  it('a forward that is ONLY reporter flags leaves no file argument behind, which main() reads as "use the default set"', () => {
    // Before, `npm test -- --test-reporter=dot` counted as "the caller named something" and handed node
    // no files, so node ran its own discovery instead of the three default globs. Pinned at the seam
    // (a real run would be the whole suite): after extraction nothing is left, so the defaults apply.
    assert.deepEqual(extractReporterFlags(['--test-reporter=dot', '--test-reporter-destination=out.txt']).others, []);
    assert.deepEqual(extractReporterFlags(['--test-reporter=dot', 'tests/one.test.mjs']).others, ['tests/one.test.mjs']);
  });
});

describe('partitionArgs — options are read only before a `--` terminator (audit round 1, M2)', () => {
  it('splits at the first terminator and keeps it, and what follows, untouched', () => {
    assert.deepEqual(partitionArgs(['--preflight', 'a', '--', '--preflight', '--test-reporter=dot']), { head: ['--preflight', 'a'], tail: ['--', '--preflight', '--test-reporter=dot'] });
    assert.deepEqual(partitionArgs(['a', 'b']), { head: ['a', 'b'], tail: [] });
    assert.deepEqual(partitionArgs([]), { head: [], tail: [] });
    assert.deepEqual(partitionArgs(['--', '--']), { head: [], tail: ['--', '--'] });
  });
  it('the reporter flags after a terminator are not extracted', () => {
    const { head, tail } = partitionArgs(['--', '--test-reporter=dot']);
    assert.deepEqual(extractReporterFlags(head), { pairs: [], others: [] });
    assert.deepEqual(tail, ['--', '--test-reporter=dot']);
  });
});

// ── the node warning a third reporter provokes ──────────────────────────────

describe('MaxListenersExceededWarning (three reporters trip node\'s default listener limit of 10)', () => {
  const WARN = /MaxListenersExceededWarning/;
  const tapx3 = ['--test-reporter', 'tap', '--test-reporter-destination', 'stdout'].flatMap((x, i, a) => (i === 0 ? [...a, ...a, ...a] : []));

  it('MIRROR (the hazard): three plain reporters really do print it on this node', () => {
    // If node ever raises the limit this fails, and the ceiling module (and this block) should be deleted.
    const r = spawnSync(process.execPath, ['--test', ...tapx3, FIX('healthy')], { cwd: ROOT, encoding: 'utf8', env: scrubChildEnv(process.env) });
    assert.match(r.stderr, WARN, 'the hazard is gone: remove test-runner-listener-ceiling.mjs');
  });

  it('through the real runner the run is quiet and the stderr carries the timing summary', () => {
    const r = spawnSync(process.execPath, [RUNNER, FIX('healthy')], { cwd: ROOT, encoding: 'utf8', env: scrubChildEnv(process.env) });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARN);
    assert.match(r.stderr, /Slowest test files/);
  });

  it('but a TEST FILE\'s own listener warning still reaches the developer through the runner (audit round 1, M7/M8)', () => {
    // The first version silenced the warning with a node flag that every test file's process
    // inherits, hiding a real leak. The ceiling is raised in the runner process only.
    const r = spawnSync(process.execPath, [RUNNER, FIX('listener-leak')], { cwd: ROOT, encoding: 'utf8', env: scrubChildEnv(process.env) });
    assert.equal(r.status, 0, r.stderr);
    // a test file's stderr reaches the developer through the TAP stream (stdout), the runner's own through stderr
    const seen = r.stdout + r.stderr;
    assert.match(seen, WARN, 'the runner is hiding a warning raised inside a test file');
    assert.match(seen, /11 \w+ listeners added to \[EventEmitter\]/);
    // and it is the same under plain node, so the runner changed nothing about it
    const plain = spawnSync(process.execPath, ['--test', FIX('listener-leak')], { cwd: ROOT, encoding: 'utf8', env: scrubChildEnv(process.env) });
    assert.match(plain.stdout + plain.stderr, WARN);
  });

  it('the ceiling module raises the default in a runner-like process and does nothing in a test-file process', () => {
    const probe = "import('./scripts/lib/test-runner-listener-ceiling.mjs').then(async () => { const { EventEmitter } = await import('node:events'); process.stdout.write(String(EventEmitter.defaultMaxListeners)); });";
    const env = scrubChildEnv(process.env);
    const runnerLike = spawnSync(process.execPath, ['-e', probe], { cwd: ROOT, encoding: 'utf8', env });
    assert.equal(runnerLike.stdout, '20');
    const testFileLike = spawnSync(process.execPath, ['-e', probe], { cwd: ROOT, encoding: 'utf8', env: { ...env, NODE_TEST_CONTEXT: 'child-v8' } });
    assert.equal(testFileLike.stdout, '10', 'it changed the ceiling inside a test-file process');
  });

  it('only the REPORTER module raises the ceiling; the pure report module is free of side effects on import (code audit round 2, M1)', () => {
    // The runner wrapper and the tests import the reader. Importing a utility must not mutate
    // process-wide state in whoever imported it, so the side effect lives in the node entry point only.
    const probeOf = (specifier) => `import('${specifier}').then(async () => { const { EventEmitter } = await import('node:events'); process.stdout.write(String(EventEmitter.defaultMaxListeners)); });`;
    const env = scrubChildEnv(process.env);
    const run = (specifier) => spawnSync(process.execPath, ['-e', probeOf(specifier)], { cwd: ROOT, encoding: 'utf8', env }).stdout;
    assert.equal(run('./scripts/lib/test-timing-report.mjs'), '10', 'importing the reader changed the ceiling');
    assert.equal(run('./scripts/run-tests.mjs'), '10', 'importing the runner module changed the ceiling');
    assert.equal(run('./scripts/lib/test-timing-reporter.mjs'), '20', 'the reporter no longer raises the ceiling: the runner will warn');
  });
});
