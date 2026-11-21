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
  r.put('scripts/gate.mjs', 'import { v } from "./lib/helper.mjs";\nimport { spawnSync } from "node:child_process";\nspawnSync(process.execPath, ["scripts/spawned.mjs"]);\nconsole.log(v);\n');
  r.put('scripts/spawned.mjs', 'import "./lib/spawned-dep.mjs";\n');
  r.put('scripts/lib/spawned-dep.mjs', 'export const d = 1;\n');
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

const B = 'b'.repeat(40);
const H = 'a'.repeat(40);
const facts = (over = {}) => ({ measured: true, baseSha: B, headSha: H, labels: ['gate-loosening'], reviews: [{ user: 'Lbstrydom', state: 'APPROVED', commitId: H }], ...over });
const evalWith = (f, changed = ['caps.json']) => evaluateLoosening({ changedFiles: changed, protectedPaths: new Set(['caps.json']), facts: f, base: B, head: H });

test('authorization: needs the protected set only AND the label AND a standing approval on the analyzed head', () => {
  assert.equal(evalWith(facts()).state, 'authorized');
  const outside = evalWith(facts(), ['caps.json', 'src/app.mjs']);
  assert.equal(outside.state, 'not-authorized');
  assert.match(outside.reasons.join(), /outside the protected set: src\/app.mjs/);
  assert.match(evalWith(facts({ labels: [] })).reasons.join(), /missing label gate-loosening/);
  assert.match(evalWith(facts({ reviews: [] })).reasons.join(), /no standing approving review/);
  assert.match(evalWith(facts({ reviews: [{ user: 'someone-else', state: 'APPROVED', commitId: H }] })).reasons.join(), /Lbstrydom/);
});

test('approval binding: an approval of an EARLIER commit does not stand', () => {
  const stale = facts({ reviews: [{ user: 'Lbstrydom', state: 'APPROVED', commitId: 'c'.repeat(40) }] });
  assert.equal(evalWith(stale).state, 'not-authorized');
  assert.equal(hasApproval(stale.reviews, H), false);
  assert.equal(hasApproval(facts().reviews, H), true);
});

test('approval binding: latest state decides; a later changes-requested or dismissal voids it; comments do not', () => {
  const rv = (state) => ({ user: 'Lbstrydom', state, commitId: H });
  assert.equal(hasApproval([rv('APPROVED'), rv('CHANGES_REQUESTED')], H), false);
  assert.equal(hasApproval([rv('APPROVED'), rv('DISMISSED')], H), false);
  assert.equal(hasApproval([rv('CHANGES_REQUESTED'), rv('APPROVED')], H), true);
  assert.equal(hasApproval([rv('APPROVED'), rv('COMMENTED')], H), true);
});

test('approval binding: PR facts for another base or head are UNMEASURED, never authorized', () => {
  assert.equal(evalWith(facts({ headSha: 'd'.repeat(40) })).state, 'unmeasured');
  assert.equal(evalWith(facts({ baseSha: 'd'.repeat(40) })).state, 'unmeasured');
  assert.match(evalWith(facts({ headSha: 'd'.repeat(40) })).reasons[0], /describe/);
  assert.equal(evalWith({ measured: false, reason: 'gh missing' }).state, 'unmeasured');
});

function ghRun(pages) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    if (args[1].endsWith('/reviews?per_page=100')) return { status: 0, stdout: JSON.stringify(pages) };
    return { status: 0, stdout: JSON.stringify({ labels: [{ name: 'gate-loosening' }], base: { sha: B }, head: { sha: H } }) };
  };
  return { run, calls };
}

test('fetchPrFacts: paginates reviews (--paginate --slurp) so a later review on page 2 is seen and decides', () => {
  const page1 = [{ user: { login: 'Lbstrydom' }, state: 'APPROVED', commit_id: H }];
  const page2 = [{ user: { login: 'Lbstrydom' }, state: 'CHANGES_REQUESTED', commit_id: H }];
  const { run, calls } = ghRun([page1, page2]);
  const f = fetchPrFacts({ repo: 'o/r', pr: 7, run });
  assert.equal(f.measured, true);
  assert.equal(f.reviews.length, 2);
  assert.equal(f.reviews[1].commitId, H);
  assert.match(calls[1], /--paginate --slurp/);
  assert.equal(evalWith(f).state, 'not-authorized', 'the page-2 changes-requested review voids the page-1 approval');
  const only1 = fetchPrFacts({ repo: 'o/r', pr: 7, run: ghRun([page1]).run });
  assert.equal(evalWith(only1).state, 'authorized');
});

test('fetchPrFacts: unreadable or malformed answers are unmeasured', () => {
  assert.equal(fetchPrFacts({ repo: 'o/r', pr: '5', run: () => ({ status: null, stdout: '' }) }).measured, false);
  assert.equal(fetchPrFacts({ repo: 'not a repo', pr: '5' }).measured, false);
  assert.equal(fetchPrFacts({ repo: 'o/r', pr: 'abc' }).measured, false);
  assert.equal(fetchPrFacts({ repo: 'o/r', pr: 5, run: () => ({ status: 0, stdout: '{"labels":[]}' }) }).measured, false, 'no base/head sha in the PR doc');
});

// ── orchestration ──────────────────────────────────────────────────────────────────────────────────────────────────
const fakeInstall = (dir) => { fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true }); return { ok: true }; };
const pass = (extra) => ({ installDeps: fakeInstall, runGate: ({ cwd }) => ({ exit: 0, cwd }), ...extra });

function scenario(mutate) {
  const r = makeRepo();
  const base = baseFixture(r);
  mutate(r);
  return { r, base, head: r.commit('pr') };
}
const A = (r, base, head, over = {}) => analyze({ repoRoot: r.dir, base, head, mode: 'observe', ...over });

test('analyze: tightening-only PR with every part measured is clean', () => {
  const { r, base, head } = scenario((x) => x.put('caps.json', JSON.stringify({ limit: 5 })));
  try {
    const rep = A(r, base, head, { deps: pass() });
    assert.equal(rep.state, 'clean');
    assert.deepEqual(rep.unmeasuredParts, []);
    assert.equal(rep.classification.verdict, 'tightening');
    assert.equal(rep.gateRuns.runs[0].id, 'g');
    assert.match(summaryLine(rep), /state=clean/);
  } finally { r.cleanup(); }
});

test('UNMEASURED DOMINATES: every unmeasured input forces unmeasured, never clean or authorized', () => {
  const { r, base, head } = scenario((x) => x.put('caps.json', JSON.stringify({ limit: 99 })));
  try {
    // loosening, authorized, but the gate runs were skipped -> unmeasured, not authorized
    const skipped = A(r, base, head, { gateRuns: false, deps: { facts: facts({ baseSha: base, headSha: head, reviews: [{ user: 'Lbstrydom', state: 'APPROVED', commitId: head }] }) } });
    assert.equal(skipped.authorization.state, 'authorized');
    assert.equal(skipped.state, 'unmeasured');
    assert.match(skipped.reason, /--no-gate-runs/);
    // base install failed
    const noInstall = A(r, base, head, { deps: { installDeps: () => ({ ok: false, reason: 'registry unreachable' }), runGate: () => { throw new Error('must not run'); }, facts: facts({ baseSha: base, headSha: head, reviews: [{ user: 'Lbstrydom', state: 'APPROVED', commitId: head }] }) } });
    assert.equal(noInstall.state, 'unmeasured');
    assert.match(noInstall.reason, /registry unreachable/);
    // snapshot construction itself failed
    const noSnap = A(r, base, head, { deps: { installDeps: () => { throw new Error('boom'); }, runGate: () => ({ exit: 0 }) } });
    assert.equal(noSnap.state, 'unmeasured');
    assert.match(noSnap.reason, /snapshot construction failed: boom/);
    // unreadable PR facts
    const blind = A(r, base, head, { deps: pass({ facts: { measured: false, reason: 'gh missing' } }) });
    assert.equal(blind.state, 'unmeasured');
    assert.match(blind.reason, /gh missing/);
    // facts about another head
    const other = A(r, base, head, { deps: pass({ facts: facts({ baseSha: base, headSha: 'd'.repeat(40) }) }) });
    assert.equal(other.state, 'unmeasured');
    // everything measured and authorized -> authorized (the control)
    const ok = A(r, base, head, { deps: pass({ facts: facts({ baseSha: base, headSha: head, reviews: [{ user: 'Lbstrydom', state: 'APPROVED', commitId: head }] }) }) });
    assert.equal(ok.state, 'authorized');
    assert.equal(r.git('worktree', 'list').split('\n').length, 1, 'no path leaks a worktree');
  } finally { r.cleanup(); }
});

test('UNMEASURED DOMINATES: a git read failure (not absence) is unmeasured; confirmed absence is not', () => {
  const { r, base, head } = scenario((x) => x.put('caps.json', JSON.stringify({ limit: 5 })));
  try {
    const failing = (bad) => (root, rev, file) => {
      if (file === bad) { const e = new Error(`git show ${rev}:${file} failed: bad object`); e.code = 'GIT_READ_FAILED'; throw e; }
      return execFileSync('git', ['show', `${rev}:${file}`], { cwd: root, encoding: 'utf8' });
    };
    const rep = A(r, base, head, { deps: pass({ show: failing('caps.json') }) });
    assert.equal(rep.state, 'unmeasured');
    assert.match(rep.reason, /git read failed.*caps.json/);
    assert.equal(rep.classification, null);
    const side = loadSide(r.dir, head);
    assert.equal(side.read('does/not/exist.json'), null, 'a path the tree does not have is confirmed absent');
    assert.throws(() => loadSide(r.dir, head, { show: failing('caps.json') }).read('caps.json'), /bad object/);
  } finally { r.cleanup(); }
});

test('UNMEASURED DOMINATES: bootstrap (base has no registry) is unmeasured', () => {
  const r = makeRepo();
  try {
    r.put('a.txt', 'x');
    const base = r.commit('no registry');
    r.put('.gate-files.json', JSON.stringify(REG));
    const head = r.commit('adds registry');
    const boot = A(r, base, head);
    assert.equal(boot.state, 'unmeasured');
    assert.match(boot.reason, /bootstrap/);
  } finally { r.cleanup(); }
});

test('a measured violation still outranks an unmeasured neighbour', () => {
  const { r, base, head } = scenario((x) => x.put('caps.json', JSON.stringify({ limit: 99 })));
  try {
    const rep = A(r, base, head, { deps: pass({ facts: facts({ baseSha: base, headSha: head, labels: [] }) }) });
    assert.equal(rep.state, 'violation');
  } finally { r.cleanup(); }
});

test('one protected-set model: a PR changing a helper IMPORTED by a gate, or SPAWNED by one, classifies unknown (loosening)', () => {
  for (const [file, text] of [
    ['scripts/lib/helper.mjs', 'export const v = "evil";\n'],
    ['scripts/spawned.mjs', 'import "./lib/spawned-dep.mjs";\nconsole.log("evil");\n'],
    ['scripts/lib/spawned-dep.mjs', 'export const d = 2;\n'],
  ]) {
    const { r, base, head } = scenario((x) => x.put(file, text));
    try {
      const rep = A(r, base, head, { gateRuns: false, deps: { facts: facts({ baseSha: base, headSha: head }) } });
      assert.equal(rep.classification.verdict, 'unknown', file);
      const row = rep.classification.files.find((f) => f.path === file);
      assert.ok(row, `${file} is in the classification`);
      assert.equal(row.kind, 'opaque');
      assert.equal(rep.authorization.state, 'not-authorized');
    } finally { r.cleanup(); }
  }
  const { r, base, head } = scenario((x) => x.put('src/app.mjs', 'export const app = 5;\n'));
  try {
    assert.equal(A(r, base, head, { gateRuns: false }).classification.verdict, 'unchanged', 'an unprotected file stays out');
  } finally { r.cleanup(); }
});

test('one protected-set model: the snapshot restores spawned helpers and their closure, and reports them', () => {
  const { r, base, head } = scenario((x) => {
    x.put('scripts/spawned.mjs', 'import "./lib/spawned-dep.mjs";\nconsole.log("pr");\n');
    x.put('scripts/lib/spawned-dep.mjs', 'export const d = 99;\n');
  });
  try {
    const side = loadSide(r.dir, base);
    const p = computeProtected(side, side);
    assert.deepEqual(p.helpers, ['scripts/spawned.mjs']);
    assert.ok(p.closure.includes('scripts/lib/spawned-dep.mjs'), 'the helper closure is followed recursively');
    const snap = buildSnapshot({ repoRoot: r.dir, base, head, install: false });
    try {
      assert.equal(fs.readFileSync(path.join(snap.dir, 'scripts/spawned.mjs'), 'utf8').includes('pr'), false);
      assert.match(fs.readFileSync(path.join(snap.dir, 'scripts/lib/spawned-dep.mjs'), 'utf8'), /d = 1/);
      assert.deepEqual(snap.inventories.helperScripts, ['scripts/spawned.mjs']);
    } finally { snap.cleanup(); }
  } finally { r.cleanup(); }
});

test('authorization uses the same protected set: a registered-only PR that touches a gate helper is allowed, one touching src is not', () => {
  const only = scenario((x) => x.put('scripts/lib/helper.mjs', 'export const v = "evil";\n'));
  try {
    const rep = A(only.r, only.base, only.head, { gateRuns: false, deps: { facts: facts({ baseSha: only.base, headSha: only.head, reviews: [{ user: 'Lbstrydom', state: 'APPROVED', commitId: only.head }] }) } });
    assert.equal(rep.authorization.state, 'authorized', 'helper is inside the protected set');
  } finally { only.r.cleanup(); }
  const mixed = scenario((x) => { x.put('scripts/lib/helper.mjs', 'export const v = "evil";\n'); x.put('src/app.mjs', 'export const app = 7;\n'); });
  try {
    const rep = A(mixed.r, mixed.base, mixed.head, { gateRuns: false, deps: { facts: facts({ baseSha: mixed.base, headSha: mixed.head, reviews: [{ user: 'Lbstrydom', state: 'APPROVED', commitId: mixed.head }] }) } });
    assert.equal(rep.authorization.state, 'not-authorized');
  } finally { mixed.r.cleanup(); }
});

test('renames: a move from an unregistered path into a registered one (and the reverse) is seen on BOTH sides', () => {
  const r = makeRepo();
  try {
    r.put('.gate-files.json', JSON.stringify(REG, null, 2));
    r.put('scripts/gate.mjs', 'console.log(1);\n');
    r.put('src/data.json', JSON.stringify({ n: 1, pad: 'x'.repeat(200) }));
    r.put('caps.json', JSON.stringify({ limit: 10, pad: 'y'.repeat(200) }));
    r.put('package.json', '{}');
    const base = r.commit('base');
    r.git('mv', 'src/data.json', 'extra-baseline.json');   // unregistered -> registered
    r.git('mv', 'caps.json', 'src/caps-moved.json');       // registered -> unregistered
    const head = r.commit('moves');
    assert.match(r.git('diff', '--name-status', '-M', base, head), /^R/m, 'precondition: git pairs these as renames');
    const rep = A(r, base, head, { gateRuns: false, deps: { facts: facts({ baseSha: base, headSha: head, reviews: [{ user: 'Lbstrydom', state: 'APPROVED', commitId: head }] }) } });
    assert.equal(rep.authorization.state, 'not-authorized');
    const why = rep.authorization.reasons.join();
    assert.match(why, /src\/data.json/, 'the unregistered SOURCE of the move is listed');
    assert.match(why, /src\/caps-moved.json/, 'the unregistered DESTINATION of the move is listed');
  } finally { r.cleanup(); }
});

test('shadow run: a clean worktree of the resolved head, with the same node_modules link, never the caller tree', () => {
  const r = makeRepo();
  try {
    const base = baseFixture(r);
    r.put('src/app.mjs', 'export const app = "at-head";\n');
    const head = r.commit('head');
    r.put('src/app.mjs', 'export const app = "later-commit";\n');
    r.commit('later, so the checkout HEAD is NOT the analyzed head');
    r.put('src/app.mjs', 'export const app = "dirty";\n');   // and the caller tree is dirty
    r.put('dirty-untracked.txt', 'x');
    const seen = [];
    const runGate = ({ cwd }) => {
      seen.push({
        cwd,
        app: fs.readFileSync(path.join(cwd, 'src/app.mjs'), 'utf8'),
        untracked: fs.existsSync(path.join(cwd, 'dirty-untracked.txt')),
        nodeModules: fs.existsSync(path.join(cwd, 'node_modules', 'marker')),
      });
      return { exit: 0, cwd };
    };
    const installDeps = (dir) => { fs.mkdirSync(path.join(dir, 'node_modules', 'marker'), { recursive: true }); return { ok: true }; };
    const rep = A(r, base, head, { deps: { installDeps, runGate } });
    assert.equal(rep.gateRuns.state, 'measured');
    assert.equal(seen.length, 2);
    const [verdict, shadow] = seen;
    assert.notEqual(shadow.cwd, r.dir, 'the shadow never runs in the caller working tree');
    assert.notEqual(shadow.cwd, verdict.cwd);
    assert.match(shadow.app, /at-head/, 'the shadow is the explicit head, not HEAD and not the dirty tree');
    assert.equal(shadow.untracked, false);
    assert.equal(shadow.nodeModules, true, 'the shadow gets the same base node_modules link');
    assert.equal(verdict.nodeModules, true);
    assert.equal(r.git('worktree', 'list').split('\n').length, 1);
  } finally { r.cleanup(); }
});

test('a supplied base install is linked instead of installing again', () => {
  const { r, base, head } = scenario((x) => x.put('caps.json', JSON.stringify({ limit: 5 })));
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ext-'));
  try {
    fs.mkdirSync(path.join(ext, 'node_modules', 'marker'), { recursive: true });
    const rep = A(r, base, head, { baseInstallDir: ext, deps: { installDeps: () => { throw new Error('must not install'); }, runGate: ({ cwd }) => ({ exit: fs.existsSync(path.join(cwd, 'node_modules', 'marker')) ? 0 : 1 }) } });
    assert.equal(rep.state, 'clean', rep.reason);
    assert.equal(fs.existsSync(path.join(ext, 'node_modules', 'marker')), true, 'cleanup never deletes the supplied install');
  } finally { r.cleanup(); rm(ext); }
});

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';

const CLI = path.resolve(import.meta.dirname, '..', 'scripts', 'gate-provenance.mjs');
const cli = (args, cwd, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...sanitizeGitEnv(cwd), ...env } });

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

test('cli: enforce exits 3 for EVERY unmeasured path (skipped runs, bad base, bootstrap) and observe still exits 0', () => {
  const { r, base } = scenario((x) => x.put('caps.json', JSON.stringify({ limit: 5 })));
  try {
    const skipped = cli(['--repo-root', r.dir, '--base', base, '--no-gate-runs', '--mode', 'enforce', '--json'], r.dir);
    assert.equal(skipped.status, 3, '--no-gate-runs is unmeasured, so enforce refuses it');
    assert.equal(JSON.parse(skipped.stdout).state, 'unmeasured');
    const ghost = '0123456789abcdef0123456789abcdef01234567';
    const missing = cli(['--repo-root', r.dir, '--base', ghost, '--mode=enforce', '--json'], r.dir);
    assert.equal(missing.status, 3);
    assert.equal(JSON.parse(missing.stdout).state, 'unmeasured');
    const observe = cli(['--repo-root', r.dir, '--base', ghost, '--json'], r.dir);
    assert.equal(observe.status, 0);
    assert.equal(JSON.parse(observe.stdout).state, 'unmeasured');
  } finally { r.cleanup(); }
});

test('cli: a CRASH exits 3 under --mode enforce AND --mode=enforce, and 0 in observe', () => {
  const { r, base } = scenario((x) => x.put('caps.json', JSON.stringify({ limit: 5 })));
  const crash = { GATE_PROVENANCE_CRASH_FOR_TEST: '1' };
  try {
    for (const modeArgs of [['--mode', 'enforce'], ['--mode=enforce']]) {
      const res = cli(['--repo-root', r.dir, '--base', base, '--no-gate-runs', ...modeArgs], r.dir, crash);
      assert.equal(res.status, 3, modeArgs.join(' '));
      assert.match(res.stderr, /state=unmeasured \| runner crashed/);
    }
    const obs = cli(['--repo-root', r.dir, '--base', base, '--no-gate-runs'], r.dir, crash);
    assert.equal(obs.status, 0);
    assert.match(obs.stderr, /runner crashed/);
  } finally { r.cleanup(); }
});

// ── audit round 2 ──────────────────────────────────────────────────────────────────────────────────────────────────────
function twoGateScenario() {
  const r = makeRepo();
  baseFixture(r);
  r.put('.gate-files.json', JSON.stringify({ ...REG, gates: [{ id: 'g1', argv: ['scripts/gate.mjs'] }, { id: 'g2', argv: ['scripts/gate.mjs', 'two'] }] }, null, 2));
  const base = r.commit('two gates');
  r.put('src/app.mjs', 'export const app = 2;\n');
  return { r, base, head: r.commit('pr') };
}

test('isolation: ALL verdict runs finish before ANY shadow run starts, so a shadow cannot change a verdict', () => {
  const { r, base, head } = twoGateScenario();
  try {
    const calls = [];
    const runGate = ({ cwd, argv }) => {
      const shadow = path.basename(cwd) === 'shadow';
      const nm = path.join(cwd, 'node_modules', 'poison');
      calls.push(`${shadow ? 'shadow' : 'verdict'}:${argv.join(' ')}`);
      // A fixture gate that WRITES into the shared node_modules, as a hostile shadow run could.
      if (shadow) { fs.writeFileSync(nm, 'x'); return { exit: 0 }; }
      return { exit: fs.existsSync(nm) ? 1 : 0 };
    };
    const rep = A(r, base, head, { deps: { installDeps: fakeInstall, runGate } });
    assert.deepEqual(rep.gateRuns.runs.map((g) => g.verdict.exit), [0, 0], 'no verdict saw the shadow write');
    assert.equal(rep.state, 'clean', rep.reason);
    const firstShadow = calls.findIndex((c) => c.startsWith('shadow'));
    assert.ok(calls.slice(0, firstShadow).every((c) => c.startsWith('verdict')) && calls.slice(firstShadow).every((c) => c.startsWith('shadow')), calls.join(' | '));
    assert.equal(calls.length, 4);
  } finally { r.cleanup(); }
});

test('literal pathspecs: a tracked caps[1].json beside caps1.json restores ONLY the protected file', () => {
  const r = makeRepo();
  try {
    r.put('.gate-files.json', JSON.stringify({ version: 1, files: [{ path: 'caps[1].json', kind: 'numeric-cap' }, { path: 'package.json', kind: 'opaque' }], gates: [] }, null, 2));
    r.put('caps[1].json', JSON.stringify({ limit: 10 }));
    r.put('caps1.json', JSON.stringify({ unrelated: 'base' }));
    r.put('package.json', '{}');
    const base = r.commit('base');
    r.put('caps[1].json', JSON.stringify({ limit: 99 }));
    r.put('caps1.json', JSON.stringify({ unrelated: 'pr-work' }));
    r.put('extra[2].json', '{}');
    const head = r.commit('pr');
    const snap = buildSnapshot({ repoRoot: r.dir, base, head, install: false });
    try {
      const read = (p) => fs.readFileSync(path.join(snap.dir, p), 'utf8');
      assert.equal(JSON.parse(read('caps[1].json')).limit, 10, 'the protected file is the base version');
      assert.equal(JSON.parse(read('caps1.json')).unrelated, 'pr-work', 'the glob-lookalike is NOT swept up by the pathspec');
    } finally { snap.cleanup(); }
    // and the removal side: a registered path with glob characters that the PR added is removed literally
    r.put('.gate-files.json', JSON.stringify({ version: 1, files: [{ path: 'caps[1].json', kind: 'numeric-cap' }, { path: 'extra[2].json', kind: 'opaque' }, { path: 'package.json', kind: 'opaque' }], gates: [] }, null, 2));
    const head2 = r.commit('registers extra');
    r.put('extra2.json', '{}');
    const head3 = r.commit('adds lookalike');
    const snap2 = buildSnapshot({ repoRoot: r.dir, base, head: head3, install: false });
    try {
      assert.equal(fs.existsSync(path.join(snap2.dir, 'extra[2].json')), false, 'the protected path absent at base is removed');
      const idx = execFileSync('git', ['ls-files'], { cwd: snap2.dir, encoding: 'utf8', env: sanitizeGitEnv(snap2.dir) }).split(String.fromCharCode(10));
      assert.ok(idx.includes('extra2.json') && fs.existsSync(path.join(snap2.dir, 'extra2.json')), 'its glob-lookalike stays tracked and on disk');
      assert.ok(head2);
    } finally { snap2.cleanup(); }
  } finally { r.cleanup(); }
});

test('unlink: only ENOENT is ignored; anything else is a snapshot failure (unmeasured), and cleanup still happens', () => {
  const { r, base, head } = scenario((x) => x.put('extra-baseline.json', JSON.stringify({ n: 1 })));
  try {
    const failing = (code) => ({ ...fs, unlinkSync: (p) => { if (String(p).endsWith('extra-baseline.json')) throw Object.assign(new Error(`${code} injected`), { code }); return fs.unlinkSync(p); } });
    assert.throws(() => buildSnapshot({ repoRoot: r.dir, base, head, install: false, fsImpl: failing('EACCES') }), /EACCES injected/);
    assert.equal(r.git('worktree', 'list').split('\n').length, 1, 'the failed snapshot left no worktree behind');
    const ok = buildSnapshot({ repoRoot: r.dir, base, head, install: false, fsImpl: failing('ENOENT') });
    ok.cleanup();
    const rep = A(r, base, head, { deps: { installDeps: fakeInstall, runGate: () => ({ exit: 0 }), fsImpl: failing('EPERM'), facts: facts({ baseSha: base, headSha: head }) } });
    assert.equal(rep.state === 'unmeasured' || rep.state === 'violation', true);
    assert.match(rep.gateRuns.reason, /snapshot construction failed: EPERM injected/);
    assert.equal(rep.gateRuns.state, 'unmeasured');
  } finally { r.cleanup(); }
});

test('report shape: a range failure builds the same report (unmeasuredParts present) in JSON and text output', () => {
  const { r, base } = scenario((x) => x.put('caps.json', JSON.stringify({ limit: 5 })));
  try {
    for (const badBase of ['not a revision', '0123456789abcdef0123456789abcdef01234567']) {
      const json = cli(['--repo-root', r.dir, '--base', badBase, '--json'], r.dir);
      assert.equal(json.status, 0, json.stderr);
      const rep = JSON.parse(json.stdout);
      assert.equal(rep.state, 'unmeasured');
      assert.ok(Array.isArray(rep.unmeasuredParts) && rep.unmeasuredParts.length === 1, `unmeasuredParts: ${JSON.stringify(rep.unmeasuredParts)}`);
      assert.equal(rep.contractVersion, 1);
      const text = cli(['--repo-root', r.dir, '--base', badBase], r.dir);
      assert.equal(text.status, 0);
      assert.match(text.stdout, /UNMEASURED:/);
      assert.doesNotMatch(text.stderr, /runner crashed/);
      assert.match(text.stdout, /::notice title=audit-loop-gate-provenance::state=unmeasured/);
    }
    assert.ok(base);
  } finally { r.cleanup(); }
});
