/**
 * Snapshot construction, orchestration and CLI tests in throwaway git repos: the PR adds a registered file, deletes one,
 * edits package.json and edits a module in the import closure of a gate. Each asserts what the VERDICT run would see.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sanitizeGitEnv } from '../scripts/lib/git-env-sanitize.mjs';
import { buildSnapshot, loadSide, computeProtected } from '../scripts/lib/gate-provenance/snapshot.mjs';

const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
const REG = {
  version: 1,
  files: [
    { path: 'caps.json', kind: 'numeric-cap' }, { path: 'extra-baseline.json', kind: 'numeric-cap' },
    { path: 'gc/*.json', kind: 'contract-set' }, { path: 'package.json', kind: 'opaque' }, { path: '.gate-files.json', kind: 'opaque' },
    { path: 'scripts/gate.mjs', kind: 'opaque' },
  ],
  gates: [{ id: 'g', argv: ['scripts/gate.mjs'] }],
};

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-test-'));
  const env = sanitizeGitEnv(dir);
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  const commit = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
  return { dir, git, put, commit, rmFile: (rel) => fs.unlinkSync(path.join(dir, rel)), cleanup: () => rm(dir) };
}

function baseFixture(r) {
  r.put('.gate-files.json', JSON.stringify(REG, null, 2));
  r.put('caps.json', JSON.stringify({ limit: 10 }));
  r.put('gc/one.json', JSON.stringify({ version: 1, gates: [] }));
  r.put('package.json', JSON.stringify({ name: 'base-pkg' }));
  r.put('scripts/gate.mjs', 'import { v } from "./lib/helper.mjs";\nconsole.log(v);\n');
  r.put('scripts/lib/helper.mjs', 'export const v = "base-helper";\n');
  r.put('src/app.mjs', 'export const app = 1;\n');
  return r.commit('base');
}

test('snapshot: PR adds a registered file, deletes one, edits package.json and a closure module', () => {
  const r = makeRepo();
  try {
    const base = baseFixture(r);
    r.put('extra-baseline.json', JSON.stringify({ n: 1 }));              // PR adds a registered baseline
    r.rmFile('caps.json');                                               // PR deletes a registered baseline
    r.put('package.json', JSON.stringify({ name: 'pr-pkg' }));           // PR edits install inputs
    r.put('scripts/lib/helper.mjs', 'export const v = "pr-helper";\n');  // PR edits a module in the gate closure
    r.put('src/app.mjs', 'export const app = 2;\n');                     // PR edits an unprotected file
    const head = r.commit('pr');
    const snap = buildSnapshot({ repoRoot: r.dir, base, head, install: false });
    try {
      const at = (p) => path.join(snap.dir, p);
      const read = (p) => fs.readFileSync(at(p), 'utf8');
      assert.equal(fs.existsSync(at('extra-baseline.json')), false, 'a protected path absent at base is removed from disk');
      const tracked = execFileSync('git', ['ls-files'], { cwd: snap.dir, encoding: 'utf8', env: sanitizeGitEnv(snap.dir) }).split('\n');
      assert.ok(!tracked.includes('extra-baseline.json'), 'and from the index');
      assert.equal(read('caps.json'), JSON.stringify({ limit: 10 }), 'a deleted protected path is restored from base');
      assert.ok(tracked.includes('caps.json'), 'and tracked again');
      assert.equal(JSON.parse(read('package.json')).name, 'base-pkg', 'package.json is the base version');
      assert.match(read('scripts/lib/helper.mjs'), /base-helper/, 'the import closure of a gate entry point is the base version');
      assert.match(read('src/app.mjs'), /app = 2/, 'everything unprotected is the PR version');
      assert.deepEqual(snap.inventories.removed, ['extra-baseline.json']);
      assert.ok(snap.inventories.restored.includes('caps.json'));
      assert.ok(snap.inventories.protectedPaths.includes('scripts/lib/helper.mjs'));
      assert.equal(snap.nodeModules, 'unmeasured');
      // The snapshot actually runs the gate with BASE code.
      const out = execFileSync(process.execPath, ['scripts/gate.mjs'], { cwd: snap.dir, encoding: 'utf8' });
      assert.equal(out.trim(), 'base-helper');
    } finally { snap.cleanup(); }
    assert.equal(r.git('worktree', 'list').split('\n').length, 1, 'worktrees are removed in cleanup');
    assert.equal(r.git('rev-parse', 'HEAD'), head, 'the main checkout is untouched');
  } finally { r.cleanup(); }
});

test('snapshot: the dependency install runs in a separate base worktree and is linked in', () => {
  const r = makeRepo();
  try {
    const base = baseFixture(r);
    r.put('package.json', JSON.stringify({ name: 'pr-pkg' }));
    const head = r.commit('pr');
    const seen = [];
    const installDeps = (dir) => {
      seen.push(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name);
      fs.mkdirSync(path.join(dir, 'node_modules', 'marker'), { recursive: true });
      return { ok: true };
    };
    const snap = buildSnapshot({ repoRoot: r.dir, base, head, install: true, installDeps });
    try {
      assert.deepEqual(seen, ['base-pkg'], 'npm ci would see the base manifest, never the PR one');
      assert.equal(snap.nodeModules, 'linked');
      assert.ok(fs.existsSync(path.join(snap.dir, 'node_modules', 'marker')));
    } finally { snap.cleanup(); }
    assert.equal(r.git('worktree', 'list').split('\n').length, 1);
    const failed = buildSnapshot({ repoRoot: r.dir, base, head, installDeps: () => ({ ok: false, reason: 'offline' }) });
    try { assert.equal(failed.nodeModules, 'unmeasured'); assert.match(failed.nodeModulesReason, /offline/); } finally { failed.cleanup(); }
  } finally { r.cleanup(); }
});

test('computeProtected: closure is derived from the base, install inputs always protected', () => {
  const r = makeRepo();
  try {
    const base = baseFixture(r);
    const side = loadSide(r.dir, base);
    const p = computeProtected(side, side);
    assert.ok(p.closure.includes('scripts/lib/helper.mjs'));
    for (const f of ['package.json', 'package-lock.json', '.npmrc']) assert.ok(p.protectedPaths.includes(f));
    assert.equal(p.protectedPaths.includes('src/app.mjs'), false);
  } finally { r.cleanup(); }
});

// ── authorization ──────────────────────────────────────────────────────────────────────────────────────────────────
import { hasApproval, evaluateLoosening, fetchPrFacts } from '../scripts/lib/gate-provenance/authorize.mjs';
import { analyze, summaryLine } from '../scripts/lib/gate-provenance/analyze.mjs';

const okFacts = { measured: true, labels: ['gate-loosening'], reviews: [{ user: 'Lbstrydom', state: 'APPROVED' }] };

test('authorization: needs registered-only files AND the label AND a standing approval by the owner', () => {
  const reg = new Set(['caps.json']);
  assert.equal(evaluateLoosening({ changedFiles: ['caps.json'], registeredPaths: reg, facts: okFacts }).state, 'authorized');
  const outside = evaluateLoosening({ changedFiles: ['caps.json', 'src/app.mjs'], registeredPaths: reg, facts: okFacts });
  assert.equal(outside.state, 'not-authorized');
  assert.match(outside.reasons.join(), /non-registered files: src\/app.mjs/);
  assert.match(evaluateLoosening({ changedFiles: ['caps.json'], registeredPaths: reg, facts: { ...okFacts, labels: [] } }).reasons.join(), /missing label gate-loosening/);
  assert.match(evaluateLoosening({ changedFiles: ['caps.json'], registeredPaths: reg, facts: { ...okFacts, reviews: [] } }).reasons.join(), /no standing approving review/);
  assert.match(evaluateLoosening({ changedFiles: ['caps.json'], registeredPaths: reg, facts: { ...okFacts, reviews: [{ user: 'someone-else', state: 'APPROVED' }] } }).reasons.join(), /Lbstrydom/);
});

test('authorization: a later changes-requested review voids an earlier approval; comments do not', () => {
  assert.equal(hasApproval([{ user: 'Lbstrydom', state: 'APPROVED' }, { user: 'Lbstrydom', state: 'CHANGES_REQUESTED' }]), false);
  assert.equal(hasApproval([{ user: 'Lbstrydom', state: 'CHANGES_REQUESTED' }, { user: 'Lbstrydom', state: 'APPROVED' }]), true);
  assert.equal(hasApproval([{ user: 'Lbstrydom', state: 'APPROVED' }, { user: 'Lbstrydom', state: 'COMMENTED' }]), true);
});

test('authorization: unreadable facts are unmeasured, never authorized and never refused', () => {
  const r = evaluateLoosening({ changedFiles: [], registeredPaths: new Set(), facts: { measured: false, reason: 'gh missing' } });
  assert.equal(r.state, 'unmeasured');
  assert.equal(fetchPrFacts({ repo: 'o/r', pr: '5', run: () => ({ status: null, stdout: '' }) }).measured, false);
  assert.equal(fetchPrFacts({ repo: 'not a repo', pr: '5' }).measured, false);
  assert.equal(fetchPrFacts({ repo: 'o/r', pr: 'abc' }).measured, false);
  const calls = [];
  const facts = fetchPrFacts({
    repo: 'o/r', pr: 7,
    run: (args) => {
      calls.push(args[1]);
      return { status: 0, stdout: args[1].endsWith('/reviews?per_page=100') ? '[{"user":{"login":"Lbstrydom"},"state":"APPROVED"}]' : '{"labels":[{"name":"gate-loosening"}]}' };
    },
  });
  assert.deepEqual(facts, { measured: true, labels: ['gate-loosening'], reviews: [{ user: 'Lbstrydom', state: 'APPROVED' }] });
  assert.deepEqual(calls, ['repos/o/r/pulls/7', 'repos/o/r/pulls/7/reviews?per_page=100']);
});

// ── orchestration ──────────────────────────────────────────────────────────────────────────────────────────────────
const fakeInstall = (dir) => { fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true }); return { ok: true }; };

function scenario(mutate) {
  const r = makeRepo();
  const base = baseFixture(r);
  mutate(r);
  return { r, base, head: r.commit('pr') };
}

test('analyze: tightening-only PR is clean and both runs are reported', () => {
  const { r, base, head } = scenario((x) => x.put('caps.json', JSON.stringify({ limit: 5 })));
  try {
    const rep = analyze({ repoRoot: r.dir, base, head, mode: 'observe', deps: { installDeps: fakeInstall, runGate: ({ cwd }) => ({ exit: 0, cwd }) } });
    assert.equal(rep.state, 'clean');
    assert.equal(rep.classification.verdict, 'tightening');
    assert.equal(rep.gateRuns.state, 'measured');
    assert.equal(rep.gateRuns.runs[0].id, 'g');
    assert.notEqual(rep.gateRuns.runs[0].verdict.cwd, rep.gateRuns.runs[0].shadow.cwd, 'verdict runs in the snapshot, shadow in the PR tree');
    assert.equal(rep.gateRuns.runs[0].shadow.cwd, r.dir);
    assert.match(summaryLine(rep), /state=clean/);
  } finally { r.cleanup(); }
});

test('analyze: a raised cap without label and approval is a violation; with both it is authorized', () => {
  const { r, base, head } = scenario((x) => x.put('caps.json', JSON.stringify({ limit: 99 })));
  try {
    const go = (facts) => analyze({ repoRoot: r.dir, base, head, mode: 'observe', gateRuns: false, deps: { facts } });
    const bad = go({ measured: true, labels: [], reviews: [] });
    assert.equal(bad.state, 'violation');
    assert.equal(bad.classification.verdict, 'loosening');
    assert.equal(go(okFacts).state, 'authorized');
    const blind = go({ measured: false, reason: 'gh missing' });
    assert.equal(blind.state, 'unmeasured');
    assert.match(blind.reason, /gh missing/);
  } finally { r.cleanup(); }
});

test('analyze: a PR that fails a gate under the base protected set is a violation even with a clean diff', () => {
  const { r, base, head } = scenario((x) => x.put('src/app.mjs', 'export const app = 3;\n'));
  try {
    const rep = analyze({ repoRoot: r.dir, base, head, mode: 'observe', deps: { installDeps: fakeInstall, runGate: ({ cwd }) => ({ exit: cwd === r.dir ? 0 : 1 }) } });
    assert.equal(rep.classification.verdict, 'unchanged');
    assert.equal(rep.state, 'violation');
    assert.equal(rep.gateRuns.runs[0].diverges, true);
  } finally { r.cleanup(); }
});

test('analyze: bootstrap (base has no registry) is UNMEASURED, never clean', () => {
  const r = makeRepo();
  try {
    r.put('a.txt', 'x');
    const base = r.commit('no registry');
    r.put('.gate-files.json', JSON.stringify(REG));
    const head = r.commit('adds registry');
    const boot = analyze({ repoRoot: r.dir, base, head, mode: 'observe' });
    assert.equal(boot.state, 'unmeasured');
    assert.match(boot.reason, /bootstrap/);
    assert.equal(boot.classification, null);
  } finally { r.cleanup(); }
});

test('analyze: skipped gate runs and a failed base install are named UNMEASURED, and cleanup still happens', () => {
  const { r, base, head } = scenario((x) => x.put("src/app.mjs", "export const app = 9;"));
  try {
    const skipped = analyze({ repoRoot: r.dir, base, head, mode: 'observe', gateRuns: false });
    assert.equal(skipped.gateRuns.state, 'unmeasured');
    assert.match(summaryLine(skipped), /gateRuns=unmeasured/);
    const rep = analyze({ repoRoot: r.dir, base, head, mode: 'observe', deps: { installDeps: () => ({ ok: false, reason: 'registry unreachable' }), runGate: () => { throw new Error('must not run'); } } });
    assert.equal(rep.gateRuns.state, 'unmeasured');
    assert.match(rep.gateRuns.reason, /registry unreachable/);
    assert.equal(rep.state, 'clean', 'the diff itself is judged; the unmeasured run is named, not hidden');
    assert.equal(r.git('worktree', 'list').split('\n').length, 1);
  } finally { r.cleanup(); }
});

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';

const CLI = path.resolve(import.meta.dirname, '..', 'scripts', 'gate-provenance.mjs');
const cli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: sanitizeGitEnv(cwd) });

test('cli: --selfcheck-relocation, unknown flag and missing --base behave as contracted', () => {
  assert.equal(cli(['--selfcheck-relocation'], os.tmpdir()).stdout.trim(), 'OK');
  const bad = cli(['--bogus'], os.tmpdir());
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown flag/);
  assert.equal(cli([], os.tmpdir()).status, 2);
  assert.equal(cli(['--base', 'abc', '--mode', 'strict'], os.tmpdir()).status, 2);
});

test('cli: observe mode exits 0 with clean JSON on stdout and the notice on stderr, even for a violation', () => {
  const { r, base } = scenario((x) => x.put('caps.json', JSON.stringify({ limit: 99 })));
  try {
    const res = cli(['--repo-root', r.dir, '--base', base, '--no-gate-runs', '--json'], r.dir);
    assert.equal(res.status, 0, res.stderr);
    const rep = JSON.parse(res.stdout);
    assert.equal(rep.classification.verdict, 'loosening');
    assert.match(res.stderr, /::notice title=audit-loop-gate-provenance::state=/);
  } finally { r.cleanup(); }
});

test('cli: enforce exits 3 on an unmeasured state and 0 on a clean one; a bad base is unmeasured, not a crash', () => {
  const { r, base } = scenario((x) => x.put('caps.json', JSON.stringify({ limit: 5 })));
  try {
    const clean = cli(['--repo-root', r.dir, '--base', base, '--no-gate-runs', '--mode', 'enforce', '--json'], r.dir);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(JSON.parse(clean.stdout).state, 'clean');
    const missing = cli(['--repo-root', r.dir, '--base', '0123456789abcdef0123456789abcdef01234567', '--mode', 'enforce', '--json'], r.dir);
    assert.equal(missing.status, 3);
    assert.equal(JSON.parse(missing.stdout).state, 'unmeasured');
    const observe = cli(['--repo-root', r.dir, '--base', '0123456789abcdef0123456789abcdef01234567', '--json'], r.dir);
    assert.equal(observe.status, 0);
    assert.equal(JSON.parse(observe.stdout).state, 'unmeasured');
  } finally { r.cleanup(); }
});
