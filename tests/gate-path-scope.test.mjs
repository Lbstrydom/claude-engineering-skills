/**
 * Path-scoping of the slow pre-push gates (gate census L-2 `db:suites:gate`, L-3 `gates:poison`). The contract under test:
 * a skip is only ever a positive finding ("none of this gate's inputs changed in the explicit range"); every uncertainty
 * and every non-branch-tier push runs the gate in full; and a skip prints a visible SKIPPED line with its reason.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GATE_SCOPE_ENV, GATE_SCOPE_PATH, applyGateScope, computedImportFingerprint, decideGateScope, importClosure, isScopedPush, scopeFromOracle, scopeLine } from '../scripts/lib/gate-path-scope.mjs';
import { ACKNOWLEDGED_COMPUTED_IMPORTS, dbSuitesTriggers } from '../scripts/db-suites-gate.mjs';
import { readTreeAt } from '../scripts/lib/test-tier-git.mjs';
import { selectTier } from '../scripts/lib/test-tier.mjs';
import { sanitizeGitEnv } from '../scripts/lib/git-env-sanitize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOPED = { [GATE_SCOPE_ENV]: GATE_SCOPE_PATH, AUDIT_PUSH_RANGE_BASE: 'a'.repeat(40), AUDIT_PUSH_RANGE_HEAD: 'b'.repeat(40) };
const okRange = () => ({ ok: true, base: 'a'.repeat(40), head: 'b'.repeat(40), source: 'explicit', trusted: true });
const tree = { ok: true, tree: { files: new Set(['x']), read: () => '' } };
const trig = (files = ['scripts/gate-input.mjs'], extra = {}) => () => ({ files, prefixes: ['data/'], ...extra });
const decide = (over = {}) => decideGateScope({
  gate: 'g', env: SCOPED, cwd: ROOT, triggers: trig(),
  io: { resolveRange: okRange, getChanged: () => ({ ok: true, files: ['README.md'] }), getTree: () => tree, ...over.io },
  ...over.top,
});

describe('isScopedPush', () => {
  const branchList = JSON.stringify({ version: 1, maxAgeDays: 30, heavyThresholdMs: 1, defaultTier: 'branch', ciVerdict: { workflow: '.github/workflows/full-suite.yml' }, heavy: [{ file: 'tests/a.test.mjs', why: 'a heavy family member', measuredMs: 5, measuredAt: '2026-10-13', reach: ['x'] }] });
  const fullList = JSON.stringify({ version: 1, maxAgeDays: 30, heavyThresholdMs: 1, heavy: [{ file: 'tests/a.test.mjs', why: 'a heavy family member', measuredMs: 5, measuredAt: '2026-10-13', reach: ['x'] }] });
  it('CONTROL: a branch-tier push that does not update main is scoped (requested, and by the list default)', () => {
    assert.equal(isScopedPush({ tierRequest: 'branch', listText: fullList }), true);
    assert.equal(isScopedPush({ tierRequest: '', listText: branchList }), true);
  });
  it('a push to the default branch, a forced full tier, an unknown tier, a full default and an unreadable list are NOT scoped', () => {
    assert.equal(isScopedPush({ tierRequest: 'branch', pushesDefault: true, listText: branchList }), false);
    assert.equal(isScopedPush({ tierRequest: 'full', listText: branchList }), false);
    assert.equal(isScopedPush({ tierRequest: 'bogus', listText: branchList }), false);
    assert.equal(isScopedPush({ tierRequest: '', listText: fullList }), false);
    assert.equal(isScopedPush({ tierRequest: '', listText: 'not json' }), false);
    assert.equal(isScopedPush({ tierRequest: '', listText: null }), false);
    assert.equal(isScopedPush({}), false);
  });
});

describe('importClosure', () => {
  const files = {
    'scripts/root.mjs': "import './lib/a.mjs'; const x = 'scripts/spawned.mjs'; // names a CLI",
    'scripts/lib/a.mjs': "import { b } from './b.mjs'; // 'scripts/prose-only.mjs' is only prose here",
    'scripts/lib/b.mjs': 'export const b = 1;',
    'scripts/spawned.mjs': 'export {};',
    'scripts/prose-only.mjs': 'export {};',
    'tests/t.test.mjs': "import '../scripts/lib/b.mjs'; import fs from 'node:fs'; fs.readFileSync('tests/fixtures/f.json');",
    'tests/fixtures/f.json': '{}',
  };
  const mk = (extra = {}) => { const all = { ...files, ...extra }; return { files: new Set(Object.keys(all)), read: (p) => all[p] ?? null }; };
  it('follows imports everywhere and literals only from test files and declared driver scripts', () => {
    const r = importClosure({ roots: ['scripts/root.mjs', 'tests/t.test.mjs'], literalFrom: ['scripts/root.mjs'], tree: mk() });
    for (const f of ['scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'scripts/spawned.mjs', 'tests/fixtures/f.json']) assert.ok(r.files.has(f), f);
    assert.equal(r.files.has('scripts/prose-only.mjs'), false, 'a library module that only mentions a path is not an edge');
    assert.deepEqual(r.uncertain, []);
  });
  it('without literalFrom the driver script\'s spawned CLI is not reached (so the option is load-bearing)', () => {
    assert.equal(importClosure({ roots: ['scripts/root.mjs'], tree: mk() }).files.has('scripts/spawned.mjs'), false);
  });
  it('skipLiteral drops a literal (the enrolment-exempt list is prose, not an edge)', () => {
    const t = mk({ 'scripts/root.mjs': "import './lib/a.mjs'; const x = 'tests/exempt.test.mjs';", 'tests/exempt.test.mjs': 'export {};' });
    assert.equal(importClosure({ roots: ['scripts/root.mjs'], literalFrom: ['scripts/root.mjs'], tree: t }).files.has('tests/exempt.test.mjs'), true);
    assert.equal(importClosure({ roots: ['scripts/root.mjs'], literalFrom: ['scripts/root.mjs'], skipLiteral: (l) => l.startsWith('tests/'), tree: t }).files.has('tests/exempt.test.mjs'), false);
  });
  it('a computed import() is `uncertain` wherever it is, unless the gate acknowledged that file with a reason', () => {
    const t = mk({ 'tests/c.test.mjs': 'await import(process.env.X);', 'scripts/lib/c.mjs': 'await import(process.env.X);' });
    for (const root of ['tests/c.test.mjs', 'scripts/lib/c.mjs']) {
      const r = importClosure({ roots: [root], tree: t });
      assert.equal(r.uncertain.length, 1, root);
      assert.match(r.uncertain[0], /not acknowledged/);
    }
    const fp = computedImportFingerprint('await import(process.env.X);');
    const acked = importClosure({ roots: ['scripts/lib/c.mjs'], acknowledgedComputed: { 'scripts/lib/c.mjs': { reason: 'reviewed', calls: 1, fingerprint: fp } }, tree: t });
    assert.equal(acked.uncertain.length, 0);
    assert.match(acked.blind[0], /acknowledged: reviewed/);
    const withTarget = importClosure({ roots: ['scripts/lib/c.mjs'], acknowledgedComputed: { 'scripts/lib/c.mjs': { reason: 'reviewed', calls: 1, fingerprint: fp, targets: ['scripts/lib/b.mjs'] } }, tree: t });
    assert.ok(withTarget.files.has('scripts/lib/b.mjs'), 'targets named by the reviewer are followed, not assumed away');
    const grew = importClosure({ roots: ['scripts/lib/c.mjs'], acknowledgedComputed: { 'scripts/lib/c.mjs': { reason: 'reviewed', calls: 2, fingerprint: fp } }, tree: t });
    assert.match(grew.uncertain.join(), /changed since it was acknowledged/, 'a changed call count voids the acknowledgement');
    const rewritten = mk({ 'scripts/lib/c.mjs': "await import('./' + process.env.OTHER);" });
    const r2 = importClosure({ roots: ['scripts/lib/c.mjs'], acknowledgedComputed: { 'scripts/lib/c.mjs': { reason: 'reviewed', calls: 1, fingerprint: fp } }, tree: rewritten });
    assert.match(r2.uncertain.join(), /changed since it was acknowledged/, 'same count, different expression: the acknowledgement no longer applies');
    const edited = mk({ 'scripts/lib/c.mjs': 'const unrelated = 1;\nawait import(process.env.X);' });
    assert.equal(importClosure({ roots: ['scripts/lib/c.mjs'], acknowledgedComputed: { 'scripts/lib/c.mjs': { reason: 'reviewed', calls: 1, fingerprint: fp } }, tree: edited }).uncertain.length, 0, 'an edit elsewhere in the file keeps it');
  });
  it('a test whose computed import happens to sit beside an UNRELATED code literal is still uncertain (no covering heuristic)', () => {
    const t = mk({ 'tests/d.test.mjs': "const other = 'scripts/lib/b.mjs'; const m = await import(process.env.TARGET);" });
    assert.equal(importClosure({ roots: ['tests/d.test.mjs'], tree: t }).uncertain.length, 1);
  });
  it('an unresolvable import is uncertain in scripts/** too (a deleted import target must not be ignored)', () => {
    const t = mk({ 'scripts/lib/e.mjs': "import './gone.mjs';" });
    const r = importClosure({ roots: ['scripts/lib/e.mjs'], tree: t });
    assert.match(r.uncertain.join(), /gone\.mjs does not resolve/);
  });
  it('a literal naming a path the tree no longer has stays in the result, so deleting that fixture still matches', () => {
    const t = mk({ 'tests/f.test.mjs': "fs.readFileSync('tests/fixtures/deleted.json');" });
    assert.ok(importClosure({ roots: ['tests/f.test.mjs'], tree: t }).files.has('tests/fixtures/deleted.json'));
  });
  it('a LIBRARY literal is followed to a data file (a fixture it reads) but not to code (prose mentions)', () => {
    const t = mk({ 'scripts/lib/g.mjs': "const f = 'tests/fixtures/f.json'; // see 'scripts/prose-only.mjs'" });
    const r = importClosure({ roots: ['scripts/lib/g.mjs'], tree: t });
    assert.ok(r.files.has('tests/fixtures/f.json'));
    assert.equal(r.files.has('scripts/prose-only.mjs'), false);
  });
  it('a missing root and a symlink root are uncertain, never silently skipped', () => {
    assert.equal(importClosure({ roots: ['scripts/nope.mjs'], tree: mk() }).uncertain.length, 1);
    const t = { ...mk(), symlinks: new Set(['scripts/root.mjs']) };
    assert.equal(importClosure({ roots: ['scripts/root.mjs'], tree: t }).uncertain.length, 1);
  });
});

describe('decideGateScope', () => {
  it('POSITIVE CONTROL: a changed gate input makes the gate run, and the reason names it', () => {
    const d = decide({ io: { getChanged: () => ({ ok: true, files: ['docs/x.md', 'scripts/gate-input.mjs'] }) } });
    assert.deepEqual([d.run, d.scoped], [true, true]);
    assert.match(d.reason, /scripts\/gate-input\.mjs is an input of g/);
  });
  it('a changed file under a derived prefix makes it run', () => {
    assert.equal(decide({ io: { getChanged: () => ({ ok: true, files: ['data/new.sql'] }) } }).run, true);
  });
  it('NEGATIVE: only unrelated paths changed => skip, with a SKIPPED line carrying the reason', () => {
    const d = decide();
    assert.deepEqual([d.run, d.scoped], [false, true]);
    const line = scopeLine('g', d);
    assert.match(line, /^g: SKIPPED \(path-scoped\) — none of the .* reads changed in /);
    assert.match(line, /did NOT run for this push/);
  });
  it('touching what every test shares (package.json, the lockfile, .nvmrc) forces the gate', () => {
    for (const f of ['package.json', 'package-lock.json', '.nvmrc']) {
      assert.equal(decide({ io: { getChanged: () => ({ ok: true, files: [f] }) } }).run, true, f);
    }
  });
  it('UNRESOLVED RANGE: no explicit base, an unresolvable base, or a resolver failure runs the gate in full', () => {
    for (const range of [
      { ok: false, reason: 'inference-forbidden', message: 'unset' },
      { ok: false, reason: 'unresolvable-explicit', message: 'no such commit' },
    ]) {
      const d = decide({ io: { resolveRange: () => range } });
      assert.deepEqual([d.run, d.scoped], [true, false]);
      assert.match(d.reason, /push range is unresolved/);
    }
  });
  it('the real resolver with NO base in the env fails closed (requireExplicit), not by inferring one', () => {
    const d = decideGateScope({ gate: 'g', env: { [GATE_SCOPE_ENV]: GATE_SCOPE_PATH }, cwd: ROOT, triggers: trig() });
    assert.equal(d.run, true);
    assert.match(d.reason, /unresolved/);
  });
  it('every other uncertainty runs the gate: diff unreadable, tree unreadable, uncertain inputs, empty input set, throwing derivation', () => {
    const cases = {
      'diff': { io: { getChanged: () => ({ ok: false, error: 'boom' }) } },
      'tree': { io: { getTree: () => ({ ok: false, error: 'boom' }) } },
      'uncertain': { top: { triggers: trig(['a'], { uncertain: ['x has a computed import()'] }) } },
      'empty': { top: { triggers: () => ({ files: [], prefixes: [] }) } },
      'throws': { top: { triggers: () => { throw new Error('nope'); } } },
    };
    for (const [name, c] of Object.entries(cases)) {
      const d = decide(c);
      assert.deepEqual([d.run, d.scoped], [true, false], name);
    }
  });
  it('NOT SCOPED unless the sandbox opted in: no env, or any other value, runs in full without touching git', () => {
    for (const env of [{}, { [GATE_SCOPE_ENV]: '' }, { [GATE_SCOPE_ENV]: 'full' }, { [GATE_SCOPE_ENV]: '1' }]) {
      const d = decide({ top: { env }, io: { resolveRange: () => { throw new Error('must not resolve'); } } });
      assert.deepEqual([d.run, d.scoped], [true, false]);
      assert.match(scopeLine('g', d), /^g: running in full/);
    }
  });
});

describe('scopeFromOracle (the effective tier, not the requested one)', () => {
  const HEAD = 'c'.repeat(40);
  const listText = JSON.stringify({ version: 1, maxAgeDays: 30, heavyThresholdMs: 1, defaultTier: 'branch', ciVerdict: { workflow: '.github/workflows/full-suite.yml' }, heavy: [{ file: 'tests/a.test.mjs', why: 'a heavy family member', measuredMs: 5, measuredAt: '2026-10-13', reach: ['x'] }] });
  // REAL envelopes from the real selector, never hand-built: a fixture that only matches what the reader expects proves nothing.
  const WF = '.github/workflows/full-suite.yml';
  const mkTree = () => ({ files: new Set([WF, 'tests/a.test.mjs']), read: () => '' });
  const envelope = (over = {}) => JSON.stringify({
    ...selectTier({ tree: mkTree(), list: JSON.parse(listText), changed: ['docs/x.md'], head: HEAD, base: 'a'.repeat(40), asOf: '2026-11-01T00:00:00.000Z', requested: null }),
    ...over,
  });
  const go = (over = {}, env = envelope()) => scopeFromOracle({
    base: 'a'.repeat(40), tierRequest: '', pushesDefault: false, listText, head: HEAD, envelopePath: 'e.json',
    run: () => ({ status: 0 }), readText: () => env, ...over,
  });
  it('CONTROL: the oracle choosing branch scopes the push', () => {
    const r = go();
    assert.equal(JSON.parse(envelope()).tier, 'branch', 'the fixture really is a branch-tier envelope');
    assert.equal(r.scoped, true, r.reason);
  });
  it('the oracle forcing FULL (stale heavy list, changed selector, ...) un-scopes it, naming the escape', () => {
    const stale = JSON.stringify(selectTier({ tree: mkTree(), list: { ...JSON.parse(listText), heavy: [{ ...JSON.parse(listText).heavy[0], measuredAt: '2026-01-01' }] }, changed: ['docs/x.md'], head: HEAD, base: 'a'.repeat(40), asOf: '2026-11-01T00:00:00.000Z' }));
    assert.equal(JSON.parse(stale).tier, 'full');
    const r = go({}, stale);
    assert.equal(r.scoped, false);
    assert.match(r.reason, /full tier \(heavy-list-stale\)/);
  });
  it('every other failure is not scoped: no base, a push to main, a forced full, oracle exit, bad envelope, another head, a throw', () => {
    assert.equal(go({ base: null }).scoped, false);
    assert.equal(go({ pushesDefault: true }).scoped, false);
    assert.equal(go({ tierRequest: 'full' }).scoped, false);
    assert.equal(go({ run: () => ({ status: 1 }) }).scoped, false);
    assert.equal(go({ run: () => ({ status: null, error: new Error('x') }) }).scoped, false);
    assert.equal(go({ readText: () => 'not json' }).scoped, false);
    assert.equal(go({}, envelope({ head: 'd'.repeat(40) })).scoped, false);
    assert.equal(go({ run: () => { throw new Error('boom'); } }).scoped, false);
  });
  it('runs the SAME plan the tiered run will (head, tier request, pushes-default)', () => {
    let seen;
    go({ tierRequest: 'branch', run: (kind, args) => { seen = args; return { status: 0 }; } });
    assert.deepEqual(seen.slice(0, 4), ['scripts/test-tier.mjs', 'plan', '--head', HEAD]);
    assert.ok(seen.includes('--tier') && seen.includes('branch'));
  });
});

describe('applyGateScope', () => {
  it('an AMBIENT path value never survives an unscoped decision', () => {
    assert.equal(GATE_SCOPE_ENV in applyGateScope({ [GATE_SCOPE_ENV]: GATE_SCOPE_PATH, X: '1' }, { scoped: false }), false);
  });
  it('a scoped decision sets it; the rest of the env is untouched', () => {
    const e = applyGateScope({ X: '1' }, { scoped: true });
    assert.deepEqual([e[GATE_SCOPE_ENV], e.X], [GATE_SCOPE_PATH, '1']);
  });
});

describe('db-suites-gate triggers, derived from the real tree', () => {
  const t = readTreeAt(ROOT, 'HEAD');
  it('are derived (not hand-listed), cover the DB seam, and are not vacuous', () => {
    assert.equal(t.ok, true, t.error);
    const r = dbSuitesTriggers(t.tree);
    assert.deepEqual(r.uncertain, [], 'the closure must be fully followable, or the gate would always run');
    assert.ok(r.files.size > 100, `a closure of ${r.files.size} files is vacuous`);
    for (const f of ['tests/db-withtx.test.mjs', 'scripts/db-test-container.mjs', 'scripts/lib/db/query.mjs', 'scripts/setup-postgres.mjs', 'scripts/postgres-parity/generate-expected-schema.mjs', 'tests/fixtures/expected-schema.json']) {
      assert.ok(r.files.has(f), `${f} is read by the DB suites`);
    }
    assert.ok(r.prefixes.includes('supabase/migrations/'));
  });
  it('every acknowledged computed import still matches a live one (a stale acknowledgement is a defect, not a convenience)', () => {
    const live = new Set(dbSuitesTriggers(t.tree).blind.map((b) => b.split(' ')[0]));
    for (const f of Object.keys(ACKNOWLEDGED_COMPUTED_IMPORTS)) assert.ok(live.has(f), `${f} is acknowledged but no longer has a computed import in the closure`);
    assert.equal(live.size, Object.keys(ACKNOWLEDGED_COMPUTED_IMPORTS).length);
  });
  it('an unrelated doc is not an input', () => {
    const r = dbSuitesTriggers(t.tree);
    assert.equal(r.files.has('README.md'), false);
    assert.equal(r.files.has('scripts/check-gate-poison-pills.mjs'), false);
  });
});

describe('db-suites-gate CLI under the scoped env (real git range, no docker needed)', () => {
  const GATE = path.join(ROOT, 'scripts', 'db-suites-gate.mjs');
  const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', env: sanitizeGitEnv(ROOT) });
  const head = git('rev-parse', 'HEAD').stdout.trim();
  // An unreferenced commit with an EMPTY tree (`mktree` writes it; the empty tree is not in a fresh object store): diffing it against HEAD lists every file, so a gate input is guaranteed to differ.
  const emptyTree = spawnSync('git', ['mktree'], { cwd: ROOT, encoding: 'utf8', input: '', env: sanitizeGitEnv(ROOT) }).stdout.trim();
  const commitEnv = { ...sanitizeGitEnv(ROOT), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const emptyBase = spawnSync('git', ['commit-tree', emptyTree, '-m', 'empty base for gate-path-scope test'], { cwd: ROOT, encoding: 'utf8', env: commitEnv }).stdout.trim();
  const run = (base) => {
    const env = { ...process.env, [GATE_SCOPE_ENV]: GATE_SCOPE_PATH, AUDIT_PUSH_RANGE_BASE: base, AUDIT_PUSH_RANGE_HEAD: head, AUDIT_PUSH_RANGE_REQUIRED: '1', AUDIT_LOOP_DB_TESTS_SKIP: '1' };
    delete env.AUDIT_LOOP_DB_TESTS_REQUIRED;
    const r = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8', env });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  it('HARNESS CONTROL: the fixture base is a real commit', () => { assert.match(emptyBase, /^[0-9a-f]{40}$/); assert.match(head, /^[0-9a-f]{40}$/); });
  it('POSITIVE: a range that touches the gate\'s inputs runs it (here it then degrades via the operator opt-out)', () => {
    const r = run(emptyBase);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /db-suites-gate: running \(path-scoped\)/);
    assert.match(r.out, /AUDIT_LOOP_DB_TESTS_SKIP=1/, 'it got past the scope check to the real gate');
  });
  it('NEGATIVE: an empty range skips with a visible SKIPPED (path-scoped) line and never reaches the gate body', () => {
    const r = run(head);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /db-suites-gate: SKIPPED \(path-scoped\) — none of the/);
    assert.doesNotMatch(r.out, /AUDIT_LOOP_DB_TESTS_SKIP=1/);
  });
  it('UNRESOLVED RANGE: an unresolvable base runs the gate in full', () => {
    const r = run('f'.repeat(40));
    assert.match(r.out, /db-suites-gate: running in full — full: the push range is unresolved/);
    assert.match(r.out, /AUDIT_LOOP_DB_TESTS_SKIP=1/);
  });
  it('NOT SCOPED without the env: runs in full', () => {
    const env = { ...process.env, AUDIT_LOOP_DB_TESTS_SKIP: '1' };
    delete env[GATE_SCOPE_ENV]; delete env.AUDIT_LOOP_DB_TESTS_REQUIRED;
    const r = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8', env });
    assert.match(`${r.stdout}${r.stderr}`, /db-suites-gate: running in full — full: not a path-scoped push/);
  });
});
