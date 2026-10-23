/**
 * @fileoverview The consumer pre-push hook's code-audit step: an audit that did not run must not pass, and an audit that already
 * covered this exact tree is not redone (Tier 3: consumer hook contract - this change ships to repos nobody here can observe).
 *
 * Incidents (2026-10-23): (a) a storyline push of ~60 files timed out at the flat 600s budget although 3 GPT rounds + Gemini had
 * already passed that tree; (b) a storyline push (#427) whose audit died with an UNCAUGHT Node error was reported as
 * "config/key error -> noise" and went through unchecked.
 *
 * What the reproduction found (case D): with NO provider credentials reachable the audit does not crash - it refuses at its key gate,
 * exit 1 - and with `~/.audit-loop.env` reachable the keys resolve INSIDE the CLI (config.mjs -> load-shared-env.mjs), so the shell
 * exporting nothing is not the failure. What IS a failure is the hook's reading of the outcome: the audit exits 0 for ANY completed
 * run (findings live in its --out envelope, never its exit code), so every non-zero exit - the key gate, an uncaught throw such as
 * the A1 integrity guard, INCOMPLETE's exit 3 - means "no verdict", and the hook called all of them noise.
 *
 * Cases:
 *   A. classifyAuditOutcome / decideAuditGate: every outcome kind, both directions, override recorded, BLOCK only gates findings.
 *   B. decideAuditReuse + auditReuseLine against REAL git: a matching tree reuses, a tree differing by one byte re-runs.
 *   C. auditBudgetSec / parseNumstatZ: scales with the diff, floors, caps, unknown keeps the floor.
 *   D. the real audit CLI with no credentials, and the in-CLI resolution of the shared env file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  classifyAuditOutcome, decideAuditGate, decideAuditReuse, auditBudgetSec, parseNumstatZ, BUDGET, UNMEASURED_OVERRIDE_ENV,
} from '../scripts/lib/prepush-audit-gate.mjs';
import { auditOutcomeExit, auditReuseLine, auditBudgetLine } from '../scripts/prepush-step.mjs';
import { git } from './lib/hook-test-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

// ── A. classification and decision ────────────────────────────────────────────────────────────────────────────────────────────────
describe('classifyAuditOutcome - did the audit MEASURE anything?', () => {
  const PASS = { verdict: 'PASS', findings: [] };
  it('RAN CLEAN: exit 0 with a PASS envelope', () => {
    assert.deepEqual(classifyAuditOutcome({ exitCode: 0, report: PASS }), { kind: 'clean', cause: null, verdict: 'PASS', counts: { high: 0, medium: 0, low: 0 } });
  });
  it('RAN WITH FINDINGS: exit 0 with NEEDS_FIXES / SIGNIFICANT_ISSUES - findings never change the exit code', () => {
    const r = classifyAuditOutcome({ exitCode: 0, report: { verdict: 'SIGNIFICANT_ISSUES', findings: [{ severity: 'HIGH' }, { severity: 'MEDIUM' }, { severity: 'LOW' }] } });
    assert.equal(r.kind, 'findings');
    assert.deepEqual(r.counts, { high: 1, medium: 1, low: 1 });
    assert.equal(classifyAuditOutcome({ exitCode: 0, report: { verdict: 'NEEDS_FIXES', findings: [] } }).kind, 'findings');
  });
  it('a PASS that still carries a MEDIUM finding is findings, not clean; LOW alone stays clean', () => {
    assert.equal(classifyAuditOutcome({ exitCode: 0, report: { verdict: 'PASS', findings: [{ severity: 'MEDIUM' }] } }).kind, 'findings');
    assert.equal(classifyAuditOutcome({ exitCode: 0, report: { verdict: 'PASS', findings: [{ severity: 'LOW' }] } }).kind, 'clean');
  });
  it('DID NOT RUN: every non-zero exit is unmeasured and names its cause - 1 (crash/key gate), 2 (argv), 3 (INCOMPLETE), signal, none', () => {
    const causes = new Map();
    for (const exitCode of [1, 2, 3, 7, 137, null]) {
      // A leftover/forged envelope next to a non-zero exit must not rescue it: the exit contract wins.
      const r = classifyAuditOutcome({ exitCode, report: PASS });
      assert.equal(r.kind, 'unmeasured', `exit ${exitCode}`);
      causes.set(exitCode, r.cause);
    }
    assert.match(causes.get(3), /INCOMPLETE \(exit 3\)/);
    assert.match(causes.get(1), /errored before producing a verdict \(exit 1\)/);
    assert.match(causes.get(2), /refused its arguments \(exit 2\)/);
    assert.match(causes.get(137), /killed by a signal/);
    assert.match(causes.get(null), /no exit status/);
  });
  it('malformed evidence is never counted as zero findings: a missing/non-array findings list or an unrecognised severity is unmeasured', () => {
    for (const findings of [null, undefined, 'x', {}, [{ severity: 'CRITICAL' }], [{}], [null], [{ severity: 'HIGH' }, { severity: 7 }]]) {
      const r = classifyAuditOutcome({ exitCode: 0, report: { verdict: 'PASS', findings } });
      assert.equal(r.kind, 'unmeasured', JSON.stringify(findings));
      assert.match(r.cause, /no readable findings list/);
    }
    assert.equal(classifyAuditOutcome({ exitCode: 0, report: { verdict: 'PASS', findings: [{ severity: 'low' }] } }).kind, 'clean', 'severity is case-insensitive');
  });
  it('LOW-only is clean BY POLICY and never gates, even under AUDIT_PREPUSH_BLOCK=1; one MEDIUM does', () => {
    const low = classifyAuditOutcome({ exitCode: 0, report: { verdict: 'PASS', findings: [{ severity: 'LOW' }, { severity: 'LOW' }] } });
    assert.equal(low.kind, 'clean');
    assert.deepEqual(low.counts, { high: 0, medium: 0, low: 2 });
    assert.equal(decideAuditGate({ outcome: low, env: { AUDIT_PREPUSH_BLOCK: '1' } }).allow, true);
    const med = classifyAuditOutcome({ exitCode: 0, report: { verdict: 'PASS', findings: [{ severity: 'MEDIUM' }] } });
    assert.equal(decideAuditGate({ outcome: med, env: { AUDIT_PREPUSH_BLOCK: '1' } }).allow, false);
  });
  it('exit 0 is a measurement only when the envelope carries a RECOGNISED verdict', () => {
    for (const report of [null, undefined, 'x', {}, { verdict: 'MAYBE', findings: [] }, { verdict: 'INCOMPLETE', findings: [] }]) {
      const r = classifyAuditOutcome({ exitCode: 0, report });
      assert.equal(r.kind, 'unmeasured', JSON.stringify(report));
      assert.ok(r.cause);
    }
    assert.match(classifyAuditOutcome({ exitCode: 0, report: null }).cause, /no result envelope/);
    assert.match(classifyAuditOutcome({ exitCode: 0, report: { verdict: 'INCOMPLETE', findings: [] } }).cause, /INCOMPLETE/);
    assert.match(classifyAuditOutcome({ exitCode: 0, report: { verdict: 'MAYBE', findings: [] } }).cause, /unrecognised verdict "MAYBE"/);
  });
});

describe('decideAuditGate - the push decision', () => {
  const unmeasured = classifyAuditOutcome({ exitCode: 1, report: null });
  const findings = classifyAuditOutcome({ exitCode: 0, report: { verdict: 'NEEDS_FIXES', findings: [{ severity: 'MEDIUM' }] } });
  const clean = classifyAuditOutcome({ exitCode: 0, report: { verdict: 'PASS', findings: [] } });

  it('unmeasured REFUSES by default, names the cause and the one override, and never calls it noise', () => {
    const d = decideAuditGate({ outcome: unmeasured, env: {} });
    assert.equal(d.allow, false);
    const text = d.lines.join('\n');
    assert.match(text, /UNMEASURED: the code audit did NOT run to a verdict - the audit CLI errored/);
    assert.match(text, /AUDIT_PREPUSH_ALLOW_UNMEASURED=1/);
    assert.doesNotMatch(text, /noise/i);
  });
  it('AUDIT_PREPUSH_BLOCK=1 does not rescue an unmeasured audit and the override value must be exactly 1', () => {
    assert.equal(decideAuditGate({ outcome: unmeasured, env: { AUDIT_PREPUSH_BLOCK: '1' } }).allow, false);
    for (const v of ['0', 'true', '', 'yes']) assert.equal(decideAuditGate({ outcome: unmeasured, env: { [UNMEASURED_OVERRIDE_ENV]: v } }).allow, false, v);
  });
  it('the named override lets it through - and says so in the output, so the push is never silently unchecked', () => {
    const d = decideAuditGate({ outcome: unmeasured, env: { [UNMEASURED_OVERRIDE_ENV]: '1' } });
    assert.equal(d.allow, true);
    assert.match(d.lines.join('\n'), /push ALLOWED UNMEASURED because AUDIT_PREPUSH_ALLOW_UNMEASURED=1/);
    assert.match(d.lines.join('\n'), /UNMEASURED: the code audit did NOT run/);
  });
  it('findings stay advisory unless AUDIT_PREPUSH_BLOCK=1', () => {
    assert.equal(decideAuditGate({ outcome: findings, env: {} }).allow, true);
    assert.match(decideAuditGate({ outcome: findings, env: {} }).lines.join('\n'), /advisory/);
    const blocked = decideAuditGate({ outcome: findings, env: { AUDIT_PREPUSH_BLOCK: '1' } });
    assert.equal(blocked.allow, false);
    assert.match(blocked.lines.join('\n'), /push BLOCKED/);
  });
  it('clean passes, and says it ran', () => {
    const d = decideAuditGate({ outcome: clean, env: {} });
    assert.equal(d.allow, true);
    assert.match(d.lines.join('\n'), /ran clean/);
  });
});

describe('auditOutcomeExit - the CLI the hook calls: a failure of the classifier itself is a refusal', () => {
  const dir = tmpDir('audit-outcome-');
  const write = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
  const run = (opts) => { const lines = []; const rc = auditOutcomeExit({ ...opts, write: (l) => lines.push(l) }); return { rc, text: lines.join('\n') }; };
  it('reads the envelope file, refuses an unparseable one, and shows the capture tail only for an unmeasured run', () => {
    try {
      const pass = write('pass.json', JSON.stringify({ verdict: 'PASS', findings: [] }));
      const capture = write('capture.txt', 'a\nb\nError: OPENAI_API_KEY environment variable required\n');
      assert.equal(run({ exitArg: '0', reportFile: pass, captureFile: capture, env: {} }).rc, 0);
      assert.doesNotMatch(run({ exitArg: '0', reportFile: pass, captureFile: capture, env: {} }).text, /OPENAI_API_KEY/, 'a clean run shows no capture');
      const bad = run({ exitArg: '0', reportFile: write('bad.json', '{not json'), captureFile: capture, env: {} });
      assert.equal(bad.rc, 1);
      assert.match(bad.text, /no result envelope/);
      const crash = run({ exitArg: '1', reportFile: path.join(dir, 'absent.json'), captureFile: capture, env: {} });
      assert.equal(crash.rc, 1);
      assert.match(crash.text, /\| Error: OPENAI_API_KEY environment variable required/, 'the human sees why');
      assert.equal(run({ exitArg: 'banana', reportFile: pass, captureFile: capture, env: {} }).rc, 1, 'a garbled exit argument is unmeasured, never clean');
      assert.equal(run({ exitArg: null, reportFile: pass, captureFile: capture, env: {} }).rc, 1);
    } finally { rmrf(dir); }
  });
});

// ── B. reuse ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('decideAuditReuse - tree identity ONLY', () => {
  const TREE = 'a'.repeat(40);
  const marker = { runId: 'audit-run-0001', auditedTree: TREE };
  const conv = { roundConvergedAfter: 2 };
  it('same tree + converged run -> reuse, naming the run and the round', () => {
    assert.deepEqual(decideAuditReuse({ marker, pushedTree: TREE, convergence: conv }), { reuse: true, runId: 'audit-run-0001', round: 2, auditedTree: TREE });
  });
  it('a tree that differs by ONE hex digit re-runs - the same branch, the same run id, the same minute do not matter', () => {
    const off = `${'a'.repeat(39)}b`;
    const r = decideAuditReuse({ marker: { ...marker, ts: new Date().toISOString(), auditedBranch: 'main' }, pushedTree: off, convergence: conv });
    assert.equal(r.reuse, false);
    assert.match(r.reason, /not the pushed tree/);
  });
  it('same tree but the run did not converge, or cannot be verified, re-runs (a marker proves an audit RAN, not that it PASSED)', () => {
    assert.match(decideAuditReuse({ marker, pushedTree: TREE, convergence: { roundConvergedAfter: null } }).reason, /did not converge/);
    const un = decideAuditReuse({ marker, pushedTree: TREE, convergence: null, convergenceWhy: 'cloud store is off' });
    assert.equal(un.reuse, false);
    assert.match(un.reason, /cannot be verified \(cloud store is off\)/);
  });
  it('no marker, a marker without a tree, or an unresolvable pushed tree never reuse', () => {
    assert.equal(decideAuditReuse({ marker: null, pushedTree: TREE, convergence: conv }).reuse, false);
    assert.equal(decideAuditReuse({ marker: { runId: 'audit-run-0001' }, pushedTree: TREE, convergence: conv }).reuse, false);
    assert.equal(decideAuditReuse({ marker: { runId: 'audit-run-0001', auditedTree: 'not-a-tree' }, pushedTree: TREE, convergence: conv }).reuse, false);
    assert.equal(decideAuditReuse({ marker, pushedTree: null, convergence: conv }).reuse, false);
    assert.equal(decideAuditReuse({ marker: { auditedTree: TREE }, pushedTree: TREE, convergence: conv }).reuse, false);
  });
});

describe('auditReuseLine - against REAL git', () => {
  function repoWithTwoCommits() {
    const dir = tmpDir('audit-reuse-');
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'a@example.invalid'], dir);
    git(['config', 'user.name', 'A'], dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(['add', '.'], dir);
    git(['commit', '-q', '-m', 'one'], dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    git(['commit', '-q', '-am', 'two'], dir);
    return dir;
  }
  const marker = (dir, tree) => {
    fs.mkdirSync(path.join(dir, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.audit', 'last-audit-run.json'), JSON.stringify({ runId: 'audit-run-0002', auditedTree: tree, ts: new Date().toISOString() }));
  };
  const rangeEnv = (dir) => ({ AUDIT_PUSH_RANGE_BASE: git(['rev-parse', 'HEAD~1'], dir), AUDIT_PUSH_RANGE_HEAD: git(['rev-parse', 'HEAD'], dir) });
  const converged = async () => ({ convergence: { roundConvergedAfter: 3 }, why: null });

  it('the marker\'s audited tree IS the pushed commit\'s tree -> reuse, and the run is named', async () => {
    const dir = repoWithTwoCommits();
    try {
      const tree = git(['rev-parse', 'HEAD^{tree}'], dir);
      marker(dir, tree);
      const line = await auditReuseLine({ env: rangeEnv(dir), cwd: dir, readConvergence: converged });
      assert.equal(line, `reuse audit-run-0002 3 ${tree.slice(0, 12)}`);
    } finally { rmrf(dir); }
  });
  it('the SAME marker after a one-byte change to the pushed commit -> none: the audit re-runs', async () => {
    const dir = repoWithTwoCommits();
    try {
      marker(dir, git(['rev-parse', 'HEAD^{tree}'], dir));
      fs.writeFileSync(path.join(dir, 'a.txt'), 'twp\n'); // one byte
      git(['commit', '-q', '-am', 'three'], dir);
      let asked = false;
      const line = await auditReuseLine({ env: rangeEnv(dir), cwd: dir, readConvergence: async () => { asked = true; return converged(); } });
      assert.match(line, /^none the last audited tree \([0-9a-f]{12}\) is not the pushed tree \([0-9a-f]{12}\)$/);
      assert.equal(asked, false, 'a different tree is never worth a store round trip');
    } finally { rmrf(dir); }
  });
  it('reuse is keyed on the commit being PUSHED, not on what is checked out: a marker for the checked-out tree does not cover an earlier pushed commit', async () => {
    const dir = repoWithTwoCommits();
    try {
      marker(dir, git(['rev-parse', 'HEAD^{tree}'], dir));
      const env = { AUDIT_PUSH_RANGE_BASE: git(['rev-parse', 'HEAD~1'], dir), AUDIT_PUSH_RANGE_HEAD: git(['rev-parse', 'HEAD~1'], dir) };
      assert.match(await auditReuseLine({ env, cwd: dir, readConvergence: converged }), /^none /);
    } finally { rmrf(dir); }
  });
  it('a matching tree whose convergence cannot be read, hangs, or throws still re-runs, with the reason', async () => {
    const dir = repoWithTwoCommits();
    try {
      marker(dir, git(['rev-parse', 'HEAD^{tree}'], dir));
      const env = rangeEnv(dir);
      assert.match(await auditReuseLine({ env, cwd: dir, readConvergence: async () => ({ convergence: null, why: 'cloud store is off' }) }), /^none .*cannot be verified \(cloud store is off\)/);
      assert.match(await auditReuseLine({ env, cwd: dir, readConvergence: async () => { throw new Error('ECONNREFUSED'); } }), /^none .*store lookup failed/);
      const t0 = Date.now();
      assert.match(await auditReuseLine({ env, cwd: dir, lookupMs: 50, readConvergence: () => new Promise(() => {}) }), /^none .*store lookup exceeded/);
      assert.ok(Date.now() - t0 < 5000, 'a hung store cannot hang the hook');
    } finally { rmrf(dir); }
  });
  it('no push range from git (a tty, a manual run) -> none: an inferred range may not name the commit', async () => {
    const dir = repoWithTwoCommits();
    try {
      marker(dir, git(['rev-parse', 'HEAD^{tree}'], dir));
      assert.match(await auditReuseLine({ env: {}, cwd: dir, readConvergence: converged }), /^none /);
    } finally { rmrf(dir); }
  });
  it('no marker, or a malformed one -> none', async () => {
    const dir = repoWithTwoCommits();
    try {
      assert.match(await auditReuseLine({ env: rangeEnv(dir), cwd: dir, readConvergence: converged }), /^none no recorded audit run/);
      fs.mkdirSync(path.join(dir, '.audit'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.audit', 'last-audit-run.json'), '{oops');
      assert.match(await auditReuseLine({ env: rangeEnv(dir), cwd: dir, readConvergence: converged }), /^none no recorded audit run/);
    } finally { rmrf(dir); }
  });
});

// ── C. budget ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('auditBudgetSec - scales with the diff, bounded', () => {
  it('a small diff keeps the old 600s floor', () => {
    assert.equal(auditBudgetSec({ files: 3, lines: 80 }).budgetSec, BUDGET.floorSec);
  });
  it('the incident\'s ~60-file push gets more than the 600s that refused it, and more files never means less time', () => {
    const big = auditBudgetSec({ files: 60, lines: 6000 });
    assert.ok(big.budgetSec > 600, `got ${big.budgetSec}`);
    assert.match(big.basis, /60 file\(s\), 6000 changed line\(s\)/);
    let prev = 0;
    for (const files of [1, 10, 30, 60, 90]) { const b = auditBudgetSec({ files, lines: files * 100 }).budgetSec; assert.ok(b >= prev); prev = b; }
  });
  it('is capped, and says so', () => {
    const huge = auditBudgetSec({ files: 5000, lines: 900000 });
    assert.equal(huge.budgetSec, BUDGET.capSec);
    assert.match(huge.basis, /capped at/);
  });
  it('an unknown size keeps the floor and says it is unknown', () => {
    for (const size of [{}, { files: null, lines: null }, { files: NaN, lines: 4 }, { files: -1, lines: 4 }]) {
      const r = auditBudgetSec(size);
      assert.equal(r.budgetSec, BUDGET.floorSec);
      assert.equal(r.basis, 'diff size unknown');
    }
  });
});

describe('parseNumstatZ', () => {
  it('counts files and changed lines, a binary entry as a file with no lines, and a rename once', () => {
    const z = ['3\t1\ta.txt', '-\t-\timg.png', '0\t0\t', 'old/name.txt', 'new/name.txt', '10\t0\tz.txt', ''].join('\0');
    assert.deepEqual(parseNumstatZ(z), { files: 4, lines: 14 });
    assert.deepEqual(parseNumstatZ(''), { files: 0, lines: 0 });
  });
  it('auditBudgetLine reads the real pushed range and narrows to the branch\'s own files', () => {
    const dir = tmpDir('audit-budget-');
    try {
      git(['init', '-q', '-b', 'main'], dir);
      git(['config', 'user.email', 'a@example.invalid'], dir);
      git(['config', 'user.name', 'A'], dir);
      fs.writeFileSync(path.join(dir, 'seed.txt'), 's\n');
      git(['add', '.'], dir);
      git(['commit', '-q', '-m', 'seed'], dir);
      for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, `${n}.txt`), 'x\ny\n');
      git(['add', '.'], dir);
      git(['commit', '-q', '-m', 'three files'], dir);
      const env = { AUDIT_PUSH_RANGE_BASE: git(['rev-parse', 'HEAD~1'], dir), AUDIT_PUSH_RANGE_HEAD: git(['rev-parse', 'HEAD'], dir) };
      assert.match(auditBudgetLine({ env, cwd: dir }), /^600 3 file\(s\), 6 changed line\(s\)$/);
      assert.match(auditBudgetLine({ env, cwd: dir, files: 'a.txt' }), /1 file\(s\), 2 changed line\(s\)/);
      assert.match(auditBudgetLine({ env: {}, cwd: dir }), /^600 diff size unknown$/, 'no range from git -> the floor');
    } finally { rmrf(dir); }
  });
});

// ── D. the real audit CLI, no credentials ─────────────────────────────────────────────────────────────────────────────────────────
describe('the real openai-audit.mjs with no provider credentials (the reproduction)', () => {
  const SCRUB = ['OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'AUDIT_DB_URL', 'AUDIT_STORE_URL', 'DOTENV_CONFIG_PATH'];
  function hermeticEnv(home) {
    const env = { ...process.env };
    for (const k of SCRUB) delete env[k];
    return { ...env, HOME: home, USERPROFILE: home, AUDIT_ALLOW_FOREIGN_CWD: '1', AUDIT_NO_PREFLIGHT: '1' };
  }
  function scratchRepo() {
    const dir = tmpDir('audit-nokeys-');
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'a@example.invalid'], dir);
    git(['config', 'user.name', 'A'], dir);
    fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'plans', 'p.md'), '# P\n\n- **Status**: In Progress\n');
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;\n');
    git(['add', '.'], dir);
    git(['commit', '-q', '-m', 'one'], dir);
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 2;\n');
    git(['commit', '-q', '-am', 'two'], dir);
    return dir;
  }

  it('exits non-zero at its key gate - cleanly, naming the missing credential - and the hook reads that as UNMEASURED, never noise', () => {
    const home = tmpDir('audit-nokeys-home-');
    const dir = scratchRepo();
    try {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'openai-audit.mjs'), 'code', 'docs/plans/p.md', '--scope', 'diff', '--base', 'HEAD~1'], {
        cwd: dir, encoding: 'utf-8', env: hermeticEnv(home), timeout: 120_000,
      });
      assert.notEqual(r.status, 0, `the audit cannot have run:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /OPENAI_API_KEY environment variable required/);
      assert.doesNotMatch(r.stderr, /\n\s+at /, 'a clean refusal, not a stack trace');
      const outcome = classifyAuditOutcome({ exitCode: r.status, report: null });
      assert.equal(outcome.kind, 'unmeasured');
      assert.equal(decideAuditGate({ outcome, env: {} }).allow, false);
    } finally { rmrf(home); rmrf(dir); }
  });

  it('keys are resolved INSIDE the CLI from ~/.audit-loop.env (AGENTS.md shape 7): the shell exporting nothing is not the failure', () => {
    const home = tmpDir('audit-sharedenv-home-');
    const dir = scratchRepo();
    try {
      fs.writeFileSync(path.join(home, '.audit-loop.env'), 'OPENAI_API_KEY=sk-test-not-a-real-key\n');
      const probe = "import(process.argv[1]).then(() => process.stdout.write(process.env.OPENAI_API_KEY ? 'loaded' : 'absent'))";
      const configUrl = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'config.mjs')).href;
      const withShared = spawnSync(process.execPath, ['-e', probe, configUrl], { cwd: dir, encoding: 'utf-8', env: hermeticEnv(home), timeout: 60_000 });
      assert.equal(withShared.stdout, 'loaded', withShared.stderr);
      const emptyHome = tmpDir('audit-emptyhome-');
      try {
        const without = spawnSync(process.execPath, ['-e', probe, configUrl], { cwd: dir, encoding: 'utf-8', env: hermeticEnv(emptyHome), timeout: 60_000 });
        assert.equal(without.stdout, 'absent', 'the control: with no shared file there is no key');
      } finally { rmrf(emptyHome); }
    } finally { rmrf(home); rmrf(dir); }
  });
});
