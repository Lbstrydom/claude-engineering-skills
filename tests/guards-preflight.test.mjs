import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DECLARED_SLOW_GATES, EXIT_CANNOT_RUN, GUARD_TESTS, STATUS_GATE, executePreflight, gateExtraArgs, planPreflight,
  staticGatesFromCheck, summarise,
} from '../scripts/lib/guards-preflight.mjs';
import { expandedCheckScript } from '../scripts/lib/check-chain.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const exists = (p) => fs.existsSync(path.join(ROOT, p));

describe('guards:preflight derives the real gates', () => {
  it('the static gates are exactly the npm-run steps of the real check script', () => {
    const gates = staticGatesFromCheck(expandedCheckScript(pkg.scripts));
    const steps = expandedCheckScript(pkg.scripts).split('&&').map((s) => s.trim());
    assert.equal(steps.at(-1), 'npm test', 'subject probe: check still ends in the suite');
    assert.deepEqual(gates, steps.slice(0, -1).map((s) => s.replace('npm run ', '')));
    for (const g of ['size:ratchet:gate', 'knip:gate', 'status:integrity:gate', 'cli:flags:gate']) assert.ok(gates.includes(g), g);
    for (const g of gates) assert.ok(pkg.scripts[g], `check names a script that does not exist: ${g}`);
  });

  it('refuses a step it cannot parse rather than skipping the gate', () => {
    assert.throws(() => staticGatesFromCheck('npm run a && node scripts/x.mjs && npm test'), /cannot derive a gate/);
    assert.throws(() => staticGatesFromCheck('npm run a && npm test && npm run b'), /cannot derive a gate/);
    assert.throws(() => staticGatesFromCheck(''), /no "check" script/);
    assert.throws(() => staticGatesFromCheck('npm test'), /no static gates/);
  });

  it('the real plan: every omission is a chain step, every guard exists, nothing selected twice', () => {
    const plan = planPreflight({ pkg, exists });
    assert.ok(plan.gates.length >= 20, 'vacuous-pass guard: a plausible gate count');
    assert.equal(plan.testFiles.length, GUARD_TESTS.length);
    assert.equal(new Set(plan.testFiles).size, plan.testFiles.length);
    const omitted = new Set(DECLARED_SLOW_GATES.map((o) => o.script));
    assert.deepEqual(plan.gates, staticGatesFromCheck(expandedCheckScript(pkg.scripts)).filter((g) => !omitted.has(g)), 'exact ordered selection');
    for (const o of DECLARED_SLOW_GATES) assert.ok(!plan.gates.includes(o.script));
  });

  it('keeps the guards that earned their place and stays out of the heavy fleet family', () => {
    const files = GUARD_TESTS.map((t) => t.file);
    for (const f of ['rmsync-retry-guard', 'dashboard-cli', 'prepush-sandbox-honesty', 'check-status-log-integrity']) {
      assert.ok(files.includes(`tests/${f}.test.mjs`), f);
    }
    assert.deepEqual(files.filter((f) => /^tests\/(fleet-|prepush-archive-lane)/.test(f)), []);
    for (const t of GUARD_TESTS) assert.ok(t.why.length > 10, `${t.file} owes a reason`);
  });
});

describe('guards:preflight negative controls', () => {
  it('a stale omission fails loudly', () => {
    assert.throws(() => planPreflight({ pkg, exists, slow: [{ script: 'no:such:gate' }] }), /not a step of "check"/);
  });
  it('an omission without evidence fails loudly (cost, date and reason are all required)', () => {
    const ok = { script: 'knip:gate', measuredS: 5, measuredAt: '2026-10-13', why: 'a long enough reason' };
    assert.doesNotThrow(() => planPreflight({ pkg, exists, slow: [ok] }), 'subject probe: a complete record is accepted');
    for (const bad of [{ measuredS: undefined }, { measuredS: 0 }, { measuredS: Infinity }, { measuredAt: 'soon' }, { measuredAt: '2026-13-45' }, { why: '' }, { why: 'short' }]) {
      assert.throws(() => planPreflight({ pkg, exists, slow: [{ ...ok, ...bad }] }), /DECLARED_SLOW_GATES entry "knip:gate" needs/, JSON.stringify(bad));
    }
  });
  it('a missing guard file fails loudly', () => {
    assert.throws(() => planPreflight({ pkg, exists, tests: [{ file: 'tests/nope.test.mjs' }] }), /does not exist/);
  });
  it('an empty selection fails instead of passing having checked nothing', () => {
    assert.throws(() => planPreflight({ pkg, exists, tests: [] }), /selection is empty/);
    assert.throws(() => planPreflight({ pkg: { scripts: { check: 'npm run a && npm test' } }, exists, tests: GUARD_TESTS, slow: [{ script: 'a', measuredS: 5, measuredAt: '2026-10-13', why: 'a long enough reason' }] }), /selection is empty/);
  });
});

describe('the status-log gate needs a base that differs from HEAD', () => {
  it('passes the merge-base when there are commits ahead', () => {
    assert.deepEqual(gateExtraArgs(STATUS_GATE, { mergeBase: 'aaa', head: 'bbb' }), { args: ['--', '--base', 'aaa'] });
  });
  it('reports unmeasured, not pass, when HEAD is the base or the base is unknown', () => {
    assert.match(gateExtraArgs(STATUS_GATE, { mergeBase: 'aaa', head: 'aaa' }).unmeasured, /no commits ahead/);
    assert.match(gateExtraArgs(STATUS_GATE, { mergeBase: null, head: 'aaa' }).unmeasured, /merge-base/);
  });
  it('leaves every other gate alone', () => {
    assert.deepEqual(gateExtraArgs('knip:gate', { mergeBase: null, head: null }), { args: [] });
  });
});

describe('summarise never spells incomplete like a pass', () => {
  const ctx = { omittedGates: [{ script: 'db:suites:gate' }], testFileCount: 3 };
  it('FAIL beats everything', () => {
    const s = summarise([{ name: 'a', status: 'pass' }, { name: 'b', status: 'fail' }, { name: 'c', status: 'unmeasured' }], ctx);
    assert.equal(s.verdict, 'FAIL');
    assert.equal(s.exitCode, 1);
  });
  it('an unmeasured step is INCOMPLETE with a non-zero exit and no PASS word', () => {
    const s = summarise([{ name: 'a', status: 'pass' }, { name: 'c', status: 'unmeasured' }], ctx);
    assert.equal(s.verdict, 'INCOMPLETE');
    assert.equal(s.exitCode, 3);
    assert.ok(!/PASS/.test(s.line));
  });
  it('PASS only when every step passed, and it says it is not the full gate', () => {
    const s = summarise([{ name: 'a', status: 'pass' }, { name: 'guard tests', status: 'pass' }], ctx);
    assert.equal(s.exitCode, 0);
    assert.match(s.line, /NOT the full gate/);
    assert.match(s.line, /db:suites:gate/);
  });
});

describe('executePreflight runs exactly the planned commands', () => {
  const plan = { gates: ['a:gate', STATUS_GATE, 'b:gate'], testFiles: ['tests/x.test.mjs', 'tests/y.test.mjs'], omittedGates: [{ script: 'slow:gate' }] };
  const io = (spawn) => {
    const calls = [];
    const logs = [];
    return { calls, logs, io: { spawn: (c, a) => { calls.push([c, ...a]); return spawn(c, a); }, npm: 'NPM', node: 'NODE', runner: 'RUNNER', log: (m) => logs.push(m) } };
  };
  const ok = () => ({ status: 0 });

  it('runs each gate through npm, forwards the status base, then the runner with the exact files', () => {
    const h = io(ok);
    const s = executePreflight(plan, { mergeBase: 'base1', head: 'head1' }, h.io);
    assert.deepEqual(h.calls, [
      ['NPM', 'run', 'a:gate'],
      ['NPM', 'run', STATUS_GATE, '--', '--base', 'base1'],
      ['NPM', 'run', 'b:gate'],
      ['NODE', 'RUNNER', '--', 'tests/x.test.mjs', 'tests/y.test.mjs'],
    ]);
    assert.equal(s.exitCode, 0);
    assert.equal(s.verdict, 'PASS');
  });

  it('a failing gate is FAIL (exit 1) and its output is surfaced; later steps still run', () => {
    const h = io((c, a) => (a[1] === 'b:gate' ? { status: 1, stdout: 'OUT', stderr: 'ERR' } : { status: 0 }));
    const s = executePreflight(plan, { mergeBase: 'base1', head: 'head1' }, h.io);
    assert.equal(s.exitCode, 1);
    assert.match(h.logs.join(''), /OUTERR/);
    assert.equal(h.calls.length, 4);
  });

  it('a spawn error is a failure, never a pass, and is named', () => {
    const h = io((c, a) => (a[1] === 'a:gate' ? { status: null, error: new Error('ENOBUFS') } : { status: 0 }));
    const s = executePreflight(plan, { mergeBase: 'base1', head: 'head1' }, h.io);
    assert.equal(s.exitCode, 1);
    assert.match(h.logs.join(''), /could not be run to completion \(ENOBUFS\)/);
  });

  it('a failing guard test run is FAIL even when every gate passed', () => {
    const h = io((c) => (c === 'NODE' ? { status: 1 } : { status: 0 }));
    assert.equal(executePreflight(plan, { mergeBase: 'base1', head: 'head1' }, h.io).exitCode, 1);
  });

  it('an unmeasured status gate runs nothing for it and ends INCOMPLETE (exit 3)', () => {
    const h = io(ok);
    const s = executePreflight(plan, { mergeBase: 'same', head: 'same' }, h.io);
    assert.ok(!h.calls.some((c) => c.includes(STATUS_GATE)));
    assert.equal(s.exitCode, 3);
    assert.equal(s.verdict, 'INCOMPLETE');
  });
});

describe('the CLI entry', () => {
  const cli = path.join(ROOT, 'scripts/guards-preflight.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, encoding: 'utf8' });

  it('--list prints the real plan without running anything', () => {
    const r = run('--list');
    assert.equal(r.status, 0);
    const plan = JSON.parse(r.stdout);
    assert.deepEqual(plan.testFiles, GUARD_TESTS.map((g) => g.file));
  });
  it('--selfcheck-relocation answers OK, and an unknown flag beside it is still refused', () => {
    const ok = run('--selfcheck-relocation');
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /OK/);
    assert.notEqual(run('--selfcheck-relocation', '--bogus').status, 0);
  });
  it('an unknown flag is refused rather than ignored', () => {
    assert.notEqual(run('--bogus').status, 0);
  });
  it('the cannot-run status is distinct from fail and incomplete', () => {
    assert.ok(![0, 1, 3].includes(EXIT_CANNOT_RUN));
  });
});
