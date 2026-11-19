/**
 * @fileoverview Tier 2 — the miner's per-commit outcomes and reconciliation (plan docs/plans/sashiko-audit-improvements.md §5.1/§5.6).
 * A real `git init` fixture: every terminal outcome, set equality against `git rev-list`, byte-identical output for identical
 * inputs, and negative controls (a classifier that skips or double-counts a commit must fail the reconciliation).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harvestWithReport, buildInputs, serializeReport, loadCuratedSet, MINER_VERSION } from '../scripts/defect-harvest.mjs';

let root; const sha = {};
const EMPTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'git-empty-'));
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(EMPTY_DIR, 'none'), GIT_TEMPLATE_DIR: EMPTY_DIR, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const git = (...a) => execFileSync('git', ['-C', root, '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${EMPTY_DIR}`, ...a], { encoding: 'utf8', env: ENV }).trim();
const write = (f, text) => fs.writeFileSync(path.join(root, f), text);
function commit(name, msg) { git('add', '-A'); git('commit', '-q', '-m', msg); sha[name] = git('rev-parse', 'HEAD'); }

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'miner-fixture-'));
  git('init', '-q', '-b', 'main');
  write('a.js', 'const x = 1;\nfunction f() { return x + 1; }\nexport { f };\n');
  commit('c1', 'feat: add a');
  write('e.js', 'export const e = 1;\n');
  commit('c2', 'feat: add e');
  write('a.js', 'const x = 1;\nfunction f() { return x; }\nexport { f };\n');           // replaces a line c1 introduced
  commit('c3', 'fix: f returned x + 1');
  write('README.md', 'docs\n'); commit('c4', 'docs: readme');
  write('a.js', fs.readFileSync(path.join(root, 'a.js'), 'utf8') + '// note\n');
  commit('c5', 'fix: tidy (#12)\n\nFixes #12');
  write('a.js', 'if (typeof x === "undefined") throw new Error("x");\n' + fs.readFileSync(path.join(root, 'a.js'), 'utf8'));
  commit('c6', 'fix: add missing guard');                                                // pure addition
  git('revert', '--no-edit', sha.c2); sha.c7 = git('rev-parse', 'HEAD');                // a revert of c2
  git('checkout', '-q', '-b', 'side'); write('s.js', 's\n'); commit('side', 'feat: side'); git('checkout', '-q', 'main');
  write('a.js', fs.readFileSync(path.join(root, 'a.js'), 'utf8').replace('// note\n', '// note2\n'));
  commit('c8', `fix: wrong file\n\nFixes ${sha.c2}`);                                    // introducer c2 touches only e.js, the fix only a.js
  write('a.js', fs.readFileSync(path.join(root, 'a.js'), 'utf8') + '// n3\n');
  commit('c9', `fix: unrelated history\n\nFixes ${sha.side}`);                           // introducer is not an ancestor
});
after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

const run = (over = {}, deps = {}) => harvestWithReport({ root, rev: 'main', sinceN: 100, ...over }, deps);
const outcomeOf = (r, name) => r.outcomes.find((o) => o.commit === sha[name]);

describe('every commit ends in exactly one terminal outcome', () => {
  it('classifies each fixture commit and reconciles with the rev-list universe', () => {
    const r = run();
    assert.equal(r.reconciliation.ok, true, r.reconciliation.problems.join(','));
    assert.deepEqual([...r.selected].sort(), r.outcomes.map((o) => o.commit).sort());
    assert.equal(outcomeOf(r, 'c1').reason, 'not-fix-typed');
    assert.equal(outcomeOf(r, 'c4').reason, 'not-fix-typed');
    assert.equal(outcomeOf(r, 'c5').reason, 'issue-ref-only');
    assert.equal(outcomeOf(r, 'c3').outcome, 'candidate');
    assert.equal(outcomeOf(r, 'c6').outcome, 'candidate-unattributed');
    assert.equal(outcomeOf(r, 'c7').outcome, 'candidate');           // the revert
    assert.equal(outcomeOf(r, 'c8').reason, 'all-introducers-filtered');
    assert.deepEqual(outcomeOf(r, 'c8').filtered.map((f) => f.reason), ['introducer-disjoint-files']);
    assert.equal(outcomeOf(r, 'c9').reason, 'all-introducers-filtered');
    assert.deepEqual(outcomeOf(r, 'c9').filtered.map((f) => f.reason), ['introducer-not-ancestor']);
  });

  it('the drop report sums to the universe and counts pairs apart from commits', () => {
    const d = run().dropReport;
    const dropped = Object.values(d.byOutcome.dropped).reduce((a, b) => a + b, 0);
    assert.equal(d.byOutcome.candidate + d.byOutcome['candidate-unattributed'] + dropped, d.selected);
    assert.equal(d.pairs.filteredByReason['introducer-not-ancestor'], 1);
    assert.equal(d.pairs.filteredByReason['introducer-disjoint-files'], 1);
  });

  it('an already-curated pair is filtered, and a fix whose only introducer is curated is dropped', () => {
    const r = run({ curated: [{ buggyCommit: sha.c1, fixCommit: sha.c3 }] });
    assert.equal(outcomeOf(r, 'c3').reason, 'all-introducers-filtered');
    assert.equal(r.dropReport.pairs.filteredByReason['already-curated'], 1);
  });

  it('flags auditCleared only for an introducer carrying an AI-Gate trailer', () => {
    write('g.js', 'export const g = 1;\n'); commit('g1', 'feat: g\n\nAI-Gate: passed');
    write('g.js', 'export const g = 2;\n'); commit('g2', 'fix: g was wrong');
    const r = run();
    const gPair = r.candidates.find((c) => c.fixCommit === sha.g2);
    assert.equal(gPair.buggyCommit.startsWith(sha.g1.slice(0, 7)), true);
    assert.equal(gPair.auditCleared, true);
    assert.equal(r.candidates.find((c) => c.fixCommit === sha.c3).auditCleared, false);
  });
});

describe('git failures are not evidence (audit r1 H4/M7/H9)', () => {
  it('an unreadable introducer diff is filtered as unreadable, never passed as size 0 (r2 M1/M2)', () => {
    const base = (args) => git(...args);
    const failIntro = (args) => { if (args[0] === 'show' && args.includes('--format=') && sha.c1.startsWith(args[args.length - 1])) throw new Error('cannot read'); return base(args); };
    const r = run({}, { git: failIntro });
    assert.ok(outcomeOf(r, 'c3').filtered.some((f) => f.reason === 'introducer-diff-unreadable'), JSON.stringify(outcomeOf(r, 'c3')));
  });
  it('only exit status 1 means not-an-ancestor; any other failure propagates', () => {
    const base = (args) => git(...args);
    const failing = (status, stderr) => (args) => { if (args[0] === 'merge-base') throw Object.assign(new Error('boom'), { status, stderr }); return base(args); };
    assert.deepEqual(outcomeOf(run({}, { git: failing(1, '') }), 'c9').filtered.map((f) => f.reason), ['introducer-not-ancestor']);
    assert.deepEqual(outcomeOf(run({}, { git: failing(128, 'fatal: Not a valid commit name abc') }), 'c9').filtered.map((f) => f.reason), ['introducer-unresolvable']);
    assert.throws(() => run({}, { git: failing(2, 'corrupt object database') }), /merge-base --is-ancestor .* failed/);
    assert.throws(() => run({}, { git: failing(undefined, '') }), /merge-base --is-ancestor .* failed/);
  });
  it('the size bound applies to a pure addition and to the introducer diff', () => {
    const tiny = run({ maxDiffChars: 10 });
    assert.equal(outcomeOf(tiny, 'c6').reason, 'diff-too-large', 'pure addition is bounded too');
    const lines = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`);
    write('big.js', `${lines.join('\n')}\n`); commit('big1', 'feat: big');
    write('big.js', `${lines.map((l, i) => (i === 30 ? 'const v30 = 99;' : l)).join('\n')}\n`); commit('big2', 'fix: v30 was wrong');
    const r = run({ maxDiffChars: 300 });
    assert.deepEqual(outcomeOf(r, 'big2').filtered.map((f) => f.reason), ['introducer-diff-too-large']);
  });
});

describe('reconciliation is independent of the classifier (negative controls)', () => {
  const FMT_SPLIT = String.fromCharCode(0) + String.fromCharCode(0) + '\n';
  it('a log that omits a commit fails as unclassified:<sha>', () => {
    const real = (args) => git(...args);
    const r = run({}, { git: (args) => { const out = real(args); return args[0] === 'log' ? out.split(FMT_SPLIT).slice(1).join(FMT_SPLIT) : out; } });
    assert.equal(r.reconciliation.ok, false);
    assert.ok(r.reconciliation.problems.some((p) => p.startsWith('unclassified:')));
  });
  it('a log that repeats a commit fails as double-classified:<sha>', () => {
    const real = (args) => git(...args);
    const r = run({}, { git: (args) => { const out = real(args); if (args[0] !== 'log') return out; const parts = out.split(FMT_SPLIT); return [parts[0], ...parts].join(FMT_SPLIT); } });
    assert.equal(r.reconciliation.ok, false);
    assert.ok(r.reconciliation.problems.some((p) => p.startsWith('double-classified:')));
  });
});

describe('identical inputs give byte-identical output; each input changes the header', () => {
  const curated = { corpusRev: 'a'.repeat(40), digest: 'd'.repeat(64) };
  const body = (over = {}) => {
    const rep = run(over.run);
    return serializeReport({ inputs: buildInputs({ repo: 'fx', rev: 'r', sinceN: 100, maxDiffChars: 200000, curated, ...over.inputs }), report: rep });
  };
  it('is byte-identical across two runs', () => assert.equal(body(), body()));
  it('changes when the curated digest, sinceN, maxDiffChars or the miner version input changes', () => {
    const base = JSON.parse(body()).inputs;
    assert.equal(base.minerVersion, MINER_VERSION);
    assert.notEqual(JSON.stringify(JSON.parse(body({ inputs: { curated: { ...curated, digest: 'e'.repeat(64) } } })).inputs), JSON.stringify(base));
    assert.notEqual(JSON.stringify(JSON.parse(body({ inputs: { sinceN: 50 } })).inputs), JSON.stringify(base));
    assert.notEqual(JSON.stringify(JSON.parse(body({ inputs: { maxDiffChars: 1000 } })).inputs), JSON.stringify(base));
  });
  it('the body changes where the input reaches: a smaller window selects fewer commits', () => {
    assert.ok(run({ sinceN: 3 }).selected.length < run({ sinceN: 100 }).selected.length);
  });
  it('the curated set is read from an immutable object, not the working copy', () => {
    const rel = 'docs/experiments/audit-effectiveness/known-defects.json';
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    write(rel, JSON.stringify({ defects: [{ id: 'KD-1', buggyCommit: 'b1', fixCommit: 'f1' }] }));
    commit('k1', 'chore: corpus');
    const pinned = loadCuratedSet({ corpusRoot: root, corpusRev: sha.k1 });
    write(rel, JSON.stringify({ defects: [] }));                                         // uncommitted edit must not leak in
    const again = loadCuratedSet({ corpusRoot: root, corpusRev: sha.k1 });
    assert.deepEqual(again, pinned);
    assert.equal(pinned.pairs.length, 1);
    git('checkout', '--', rel);
  });
});

describe('CLI contract (audit r1 H2/M6/M10)', () => {
  const cli = (...args) => spawnSync(process.execPath, ['scripts/defect-harvest.mjs', ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, LEARNING_DISABLE: '1' } });
  it('an unknown flag is refused, not ignored', () => {
    const r = cli('--bogus');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown flag "--bogus"/);
  });
  it('--out with several roots, and roots sharing a basename, are refused before any work', () => {
    const a = cli('--roots', 'x/same,y/other', '--out', 'one.json', '--apply');
    assert.equal(a.status, 1);
    assert.match(a.stderr, /single file but several roots/);
    const b = cli('--roots', 'x/same,y/same');
    assert.equal(b.status, 1);
    assert.match(b.stderr, /share a basename/);
  });
  it('refuses to write known-defects.json', () => {
    const r = cli('--roots', '.', '--out', 'docs/known-defects.json', '--apply');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /never writes known-defects.json/);
  });
});
