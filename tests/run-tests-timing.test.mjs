/**
 * @fileoverview Per-file test timing (scripts/lib/test-timing-reporter.mjs and its use in
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
import testTimingReporter, {
  TIMING_REPORT_ENV,
  TIMING_REPORT_VERSION,
  accumulateFileTimes,
  fileIdentity,
  parseTimingReport,
  ranFiles,
  summariseTiming,
} from '../scripts/lib/test-timing-reporter.mjs';
import { CHILD_NODE_FLAGS, adjudicateRun, buildReporterArgs, finishRun, scrubChildEnv } from '../scripts/run-tests.mjs';

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
  const report = (files) => JSON.stringify({ version: TIMING_REPORT_VERSION, files, totalMs: files.reduce((n, x) => n + x.ms, 0), ignored: 0 });

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

  it('every unusable report is "timing unavailable" with its reason', () => {
    const bad = {
      'no report': null,
      unparseable: 'not json',
      'wrong version': JSON.stringify({ version: 'test-timing/v0', files: [], totalMs: 0 }),
      'no files array': JSON.stringify({ version: TIMING_REPORT_VERSION, totalMs: 0 }),
      'bad totalMs': JSON.stringify({ version: TIMING_REPORT_VERSION, files: [], totalMs: -1 }),
      'non-finite ms': JSON.stringify({ version: TIMING_REPORT_VERSION, files: [{ file: 'a', ms: null, tests: 1 }], totalMs: 0 }),
      'empty file name': JSON.stringify({ version: TIMING_REPORT_VERSION, files: [{ file: '', ms: 1, tests: 1 }], totalMs: 1 }),
      'string tests': JSON.stringify({ version: TIMING_REPORT_VERSION, files: [{ file: 'a', ms: 1, tests: '1' }], totalMs: 1 }),
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

  it('a failing source stream still reports what it gathered, and never throws', async () => {
    await withTmpAsync(async (d) => {
      const target = path.join(d, 't.json');
      process.env[TIMING_REPORT_ENV] = target;
      try { await drain(testTimingReporter(events(sample, { throwAfter: true }))); } finally { delete process.env[TIMING_REPORT_ENV]; }
      assert.equal(ranFiles(fs.readFileSync(target, 'utf8')).size, 1);
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
    invalid: JSON.stringify({ version: TIMING_REPORT_VERSION, files: [{}], totalMs: 1 }),
    valid: JSON.stringify({ version: TIMING_REPORT_VERSION, files: [{ file: 'a', ms: 5, tests: 1 }], totalMs: 5, ignored: 0 }),
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

  it('our pairs keep their destinations when a caller forwards a reporter WITHOUT one', () => {
    // The runner splices our fragment BEFORE the forwarded flags, so the caller's later reporter
    // is the one left unpaired (it defaults to stdout); ours are never shifted.
    const forwarded = ['--test-reporter', 'dot'];
    const argv = ['--test', ...buildReporterArgs(forwarded, { isTTY: false, reportPath: '/r.json', timingEnabled: true }), ...forwarded];
    const pairs = pairReporters(argv);
    const by = (re) => pairs.find(([r]) => re.test(r));
    assert.equal(by(/test-guard-reporter/)[1], '/r.json');
    assert.equal(by(/test-timing-reporter/)[1], 'stdout');
    assert.deepEqual(by(/^dot$/), ['dot', 'stdout(default)']);
  });
});

// ── the node warning a third reporter provokes ──────────────────────────────

describe('MaxListenersExceededWarning (three reporters trip the default listener limit)', () => {
  const WARN = /MaxListenersExceededWarning/;
  const spawnTree = (flags) => withTmp((tmp) => {
    const reportPath = path.join(tmp, 'guard.json');
    const argv = [...flags, '--test', ...buildReporterArgs([], { isTTY: false, reportPath, timingEnabled: true }), FIX('healthy')];
    return spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', env: { ...scrubChildEnv(process.env), [TIMING_REPORT_ENV]: path.join(tmp, 't.json') } });
  });

  it('MIRROR (the hazard): without the flag, tap + timing + guard really does print it', () => {
    // If node ever raises the limit this fails, and the flag (and this test) should be deleted.
    assert.match(spawnTree([]).stderr, WARN, 'the hazard is gone: remove CHILD_NODE_FLAGS');
  });

  it('with the runner flags the same run is quiet, and ONLY that warning code is silenced', () => {
    assert.deepEqual(CHILD_NODE_FLAGS, ['--disable-warning=MaxListenersExceededWarning']);
    assert.doesNotMatch(spawnTree(CHILD_NODE_FLAGS).stderr, WARN);
  });

  it('through the real runner the stderr carries the timing summary and no listener warning', () => {
    const r = spawnSync(process.execPath, [RUNNER, FIX('healthy')], { cwd: ROOT, encoding: 'utf8', env: scrubChildEnv(process.env) });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARN);
    assert.match(r.stderr, /Slowest test files/);
  });
});
