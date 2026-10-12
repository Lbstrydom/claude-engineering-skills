/**
 * @fileoverview `npm run test:preflight` (scripts/run-tests.mjs: PREFLIGHT_SKIPPED_FILES,
 * selectTestArgs, expectedPreflightFiles, finishRun's selection check). Plan:
 * docs/plans/gate-cost-slice-1.md, decision D5/D6.
 *
 * The preflight is NOT the gate, so the failure to guard against is a vacuous one: a
 * selection that quietly runs nothing, runs the wrong files, or cannot be launched. Each is
 * pinned here against the REAL tree, not a mock of it:
 *   · the default set is 927 files and over 34,000 characters, past the 32,767-character
 *     Windows limit, so the selection must be globs; and the negated-glob form is an
 *     observed capability of node's glob engine, so a unit test expands it on the real tree;
 *   · after a run the files that ran are compared with the files expected.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { GUARD_REPORT_VERSION } from '../scripts/lib/test-guard-reporter.mjs';
import { TIMING_REPORT_VERSION } from '../scripts/lib/test-timing-report.mjs';
import { PREFLIGHT_SKIPPED_FILES, expectedPreflightFiles, finishRun, scrubChildEnv, selectTestArgs } from '../scripts/run-tests.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-tests.mjs');
const entry = (file, why = 'because') => ({ file, why });
const always = () => true;

describe('PREFLIGHT_SKIPPED_FILES — the one place a slow file is named', () => {
  it('is non-empty and every entry exists on the real tree, with a reason', () => {
    assert.ok(PREFLIGHT_SKIPPED_FILES.length >= 1, 'an empty list would make preflight the gate under another name');
    for (const { file, why } of PREFLIGHT_SKIPPED_FILES) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is listed but does not exist`);
      assert.ok(why && why.trim().length > 10, `${file} has no reason`);
    }
  });
});

describe('selectTestArgs', () => {
  it('without --preflight returns exactly the three default globs and skips nothing', () => {
    assert.deepEqual(selectTestArgs({ preflight: false }), {
      args: ['tests/*.test.mjs', 'tests/claudemd/*.test.mjs', 'tests/install/*.test.mjs'],
      skipped: [],
    });
  });

  it('with --preflight negates only the directory holding a skipped file and leaves the other globs alone', () => {
    const r = selectTestArgs({ preflight: true, exists: always, skipped: [entry('tests/slow.test.mjs')] });
    assert.deepEqual(r.args, ['tests/!(slow).test.mjs', 'tests/claudemd/*.test.mjs', 'tests/install/*.test.mjs']);
    assert.equal(r.skipped.length, 1);
  });

  it('several names in one directory share one negation; each directory gets its own', () => {
    const r = selectTestArgs({ preflight: true, exists: always, skipped: [entry('tests/a.test.mjs'), entry('tests/b-c.test.mjs'), entry('tests/install/z.test.mjs')] });
    assert.deepEqual(r.args, ['tests/!(a|b-c).test.mjs', 'tests/claudemd/*.test.mjs', 'tests/install/!(z).test.mjs']);
  });

  it('rejects an entry that is malformed, outside the three directories, nested deeper, or missing', () => {
    const bad = (file, re, exists = always) => assert.throws(() => selectTestArgs({ preflight: true, exists, skipped: [entry(file)] }), re, file);
    bad('scripts/x.test.mjs', /must be directly inside/);
    bad('tests/sub/x.test.mjs', /must be directly inside/);
    bad('tests/a b.test.mjs', /must be directly inside|match/);
    bad('tests/a(1).test.mjs', /match/);
    bad('tests/a|b.test.mjs', /match/);
    bad('tests/x.mjs', /match/);
    bad('tests/ghost.test.mjs', /does not exist/, () => false);
  });

  it('the launch argument list is a handful of short strings, whatever the file count', () => {
    const { args } = selectTestArgs({ preflight: true });
    assert.ok(args.join(' ').length < 2000, `${args.join(' ').length} chars`);
    assert.ok(args.length <= 3);
  });
});

describe('the selection on the REAL tree (node\'s negated glob is observed, not documented)', () => {
  // fs.globSync is experimental in node 22 and prints a warning; it is the same engine
  // `node --test` uses for its patterns, which is why it is the right instrument here.
  const expand = (patterns) => new Set(patterns.flatMap((p) => fs.globSync(p, { cwd: ROOT })).map((x) => x.replace(/\\/g, '/')));

  it('expands to exactly: every default file minus the declared ones', () => {
    const all = expand(selectTestArgs({ preflight: false }).args);
    const selected = expand(selectTestArgs({ preflight: true }).args);
    const declared = new Set(PREFLIGHT_SKIPPED_FILES.map((x) => x.file));
    assert.ok(all.size > 500, `only ${all.size} default files: the probe itself is broken`);
    for (const f of declared) {
      assert.ok(all.has(f), `${f} is not in the unskipped expansion — the vacuous-pass guard failed`);
      assert.equal(selected.has(f), false, `${f} survived the negation`);
    }
    assert.equal(selected.size, all.size - declared.size);
    assert.deepEqual([...selected].sort(), [...all].filter((f) => !declared.has(f)).sort());
  });

  it('expectedPreflightFiles agrees with the glob expansion (two independent routes to the same set)', () => {
    const viaGlob = expand(selectTestArgs({ preflight: true }).args);
    assert.deepEqual([...expectedPreflightFiles()].sort(), [...viaGlob].sort());
  });

  it('a skip list that removes every file throws instead of running nothing', () => {
    const readdir = () => ['only.test.mjs'];
    assert.throws(() => expectedPreflightFiles({ readdir, skipped: [entry('tests/only.test.mjs'), entry('tests/claudemd/only.test.mjs'), entry('tests/install/only.test.mjs')] }), /selection is empty/);
  });
});

describe('finishRun — the post-run selection check', () => {
  const guard = JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [] });
  const skipped = [entry('tests/slow.test.mjs', 'the slow one')];
  const expected = new Set(['tests/a.test.mjs', 'tests/b.test.mjs']);
  const timing = (files, complete = true) => JSON.stringify({ version: TIMING_REPORT_VERSION, complete, files: files.map((file) => ({ file, ms: 1, tests: 1 })), totalMs: files.length, ignored: 0 });
  const run = (timingText, status = 0) => finishRun({ status, reportText: guard, timingText, preflight: { skipped, expected } });

  it('ran-set equals expected: exit 0, and the output says plainly it was NOT the gate and what it skipped', () => {
    const r = run(timing(['tests/a.test.mjs', 'tests/b.test.mjs']));
    assert.equal(r.exitCode, 0);
    const text = r.lines.join('\n');
    assert.match(text, /PREFLIGHT — this was NOT the gate/);
    assert.match(text, /tests\/slow\.test\.mjs \(the slow one\)/);
    assert.match(text, /The pre-push gate runs everything/);
  });

  it('a declared-skipped file that ran fails the run and names it', () => {
    const r = run(timing(['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/slow.test.mjs']));
    assert.equal(r.exitCode, 1);
    assert.match(r.lines.join('\n'), /ran although declared skipped: tests\/slow\.test\.mjs/);
  });

  it('an expected file that did not run fails the run and names it', () => {
    const r = run(timing(['tests/a.test.mjs']));
    assert.equal(r.exitCode, 1);
    assert.match(r.lines.join('\n'), /expected but did not run: tests\/b\.test\.mjs/);
  });

  it('a selection that cannot be verified FAILS the preflight, and says why (audit round 1, H3)', () => {
    // The timing report is the only evidence of which files ran. A guard report that is clean
    // establishes that the observed tests passed, not that the right ones were observed, so a
    // preflight whose evidence is missing, unreadable or partial must not print a pass.
    const cases = {
      'no report': [null, /no report was written/],
      garbage: ['garbage', /report unparseable/],
      'wrong version': [JSON.stringify({ version: 'x', complete: true, files: [], totalMs: 0 }), /is not test-timing\/v1/],
      // a partial report that happens to LIST every expected file is still not evidence
      partial: [timing(['tests/a.test.mjs', 'tests/b.test.mjs'], false), /partial/],
    };
    for (const [name, [t, why]] of Object.entries(cases)) {
      const r = run(t);
      assert.equal(r.exitCode, 1, `${name}: a preflight with unverifiable selection passed`);
      const text = r.lines.join('\n');
      assert.match(text, /selection UNVERIFIED/, name);
      assert.match(text, why, name);
      assert.match(text, /Failing rather than reporting a pass/, name);
    }
  });

  it('a failing run stays failing with its own exit code, selection right, wrong or unverifiable', () => {
    assert.equal(run(timing(['tests/a.test.mjs', 'tests/b.test.mjs']), 3).exitCode, 3);
    assert.equal(run(timing(['tests/a.test.mjs']), 3).exitCode, 3);
    assert.equal(run(null, 3).exitCode, 3, 'the unverified-selection failure must not overwrite the run\'s own exit code');
  });

  it('without a preflight there is no banner and no selection check', () => {
    const r = finishRun({ status: 0, reportText: guard, timingText: timing(['tests/slow.test.mjs']), preflight: null });
    assert.equal(r.exitCode, 0);
    assert.doesNotMatch(r.lines.join('\n'), /PREFLIGHT|selection/);
  });
});

describe('the command line', () => {
  it('package.json defines test:preflight as the runner with --preflight, and leaves `test` alone', () => {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(p.scripts['test:preflight'], 'node scripts/run-tests.mjs --preflight');
    assert.equal(p.scripts.test, 'node scripts/run-tests.mjs');
  });

  it('--preflight with any other argument is a usage error (exit 2) that runs nothing', () => {
    const r = spawnSync(process.execPath, [RUNNER, '--preflight', 'tests/fixtures/test-guard/healthy.fixture.mjs'], { cwd: ROOT, encoding: 'utf8', env: scrubChildEnv(process.env) });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /takes no other arguments/);
    assert.doesNotMatch(r.stdout + r.stderr, /^# tests/m, 'it must not have started a run');
  });
});

describe('the flag this file owns is validated, not silently ignored', () => {
  const run = (...args) => spawnSync(process.execPath, [RUNNER, ...args], { cwd: ROOT, encoding: 'utf8', env: scrubChildEnv(process.env) });

  it('a mistyped --preflight spelling is a usage error, not handed to node', () => {
    const r = run('--preflite');
    // --preflite does not start with --preflight, so it is node's to reject; --preflightx is ours.
    assert.notEqual(r.status, 0);
    const r2 = run('--preflightx');
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /unknown flag "--preflightx"/);
  });

  it('after a `--` terminator a flag spelled like ours is node\'s argument, not ours (audit round 1, M2)', () => {
    // Read past the terminator, `--preflightx` is validated as the runner's own flag and rejected with a
    // usage error (exit 2, "unknown flag"). Read correctly it is handed to node as a file name, which
    // node cannot find. (`--preflight` itself is covered too, though `hasFlag` also stops at the
    // terminator, so only the misspelling distinguishes the two readings.)
    for (const flag of ['--preflightx', '--preflight']) {
      const r = run('tests/fixtures/test-guard/healthy.fixture.mjs', '--', flag);
      assert.doesNotMatch(r.stderr, /unknown flag|takes no other arguments|PREFLIGHT — this is NOT the gate/, flag);
      assert.notEqual(r.status, 2, `${flag} after the terminator was parsed as the runner's own flag`);
    }
  });

  it('--preflight=false means OFF: it is not forwarded to node and does not select the preflight', () => {
    const r = run('--preflight=false', 'tests/fixtures/test-guard/healthy.fixture.mjs');
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /PREFLIGHT/);
    assert.match(r.stderr, /healthy\.fixture\.mjs/, 'the explicit file ran');
  });
});
