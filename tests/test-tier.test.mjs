/**
 * @fileoverview The test-tier oracle (docs/plans/gate-cost-slice-2.md section 9, Tier 1): `parseImports`'s computed-import
 * report, the heavy list, reach, every escape, the guards and the one-line summary. Every refusal is shown red on a
 * mutation of the input, and every rule that must NOT fire is shown not to.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseImports } from '../scripts/lib/module-graph.mjs';
import {
  DEFAULT_BRANCH_TIER, SELECTOR_DEPENDENCIES, SELECTOR_IDENTITY_FILES, TEST_TIER_VERSION, computeReach, envelopeMatchesRequest, literalRefs, parseHeavyList,
  parseSummary, parseTierEnvelope, replayCandidate, selectBranchTier, selectTier, shadowLine, summaryLine, tierBanner, validateEnvelopeAgainstList,
} from '../scripts/lib/test-tier.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const AS_OF = '2026-10-13T12:00:00.000Z';

/** A tree from {path: source}; a non-code value is still a file. */
const mkTree = (files) => ({ files: new Set(Object.keys(files)), read: (p) => (Object.hasOwn(files, p) ? files[p] : null) });
const entry = (file, reach = ['lib/x/**'], over = {}) => ({ file, why: 'a heavy family member', measuredMs: 1000, measuredAt: '2026-10-13', reach, ...over });
const listOf = (...heavy) => ({ version: 1, maxAgeDays: 30, heavyThresholdMs: 60000, heavy });

/** A small repo: two heavy tests, one light, a shared lib. */
const repo = (over = {}) => mkTree({
  'tests/heavy-a.test.mjs': "import { a } from '../scripts/lib/a.mjs';\n",
  'tests/heavy-b.test.mjs': "import { b } from '../scripts/lib/b.mjs';\n",
  'tests/light.test.mjs': "import { a } from '../scripts/lib/a.mjs';\n",
  'scripts/lib/a.mjs': "import { shared } from './shared.mjs';\nexport const a = 1;\n",
  'scripts/lib/b.mjs': "export const b = 2;\n",
  'scripts/lib/shared.mjs': 'export const shared = 0;\n',
  'package.json': '{}', 'docs/readme.md': '# x\n',
  '.test-tiers.json': '{}', 'scripts/lib/test-tier.mjs': '', 'scripts/lib/test-tier-git.mjs': '', 'scripts/lib/module-graph.mjs': '', 'scripts/lib/glob-match.mjs': '',
  'scripts/test-tier.mjs': '', 'scripts/run-tests.mjs': '', 'scripts/prepush-check.mjs': '', '.githooks/pre-push': '',
  ...over,
});
const LIST = listOf(entry('tests/heavy-a.test.mjs', ['lib/a-declared/**']), entry('tests/heavy-b.test.mjs', ['lib/b-declared/**']));
const select = (changed, over = {}) => selectTier({ tree: repo(), list: LIST, changed, head: HEAD, base: BASE, asOf: AS_OF, requested: 'branch', ...over });
const reachedOf = (e) => e.heavy.filter((h) => h.reached).map((h) => h.file);

describe('parseImports reportComputed (Gemini G2): opt-in, and the default is untouched', () => {
  const src = [
    "import a from './a.mjs';", "const x = await import('./lit.mjs');", 'const y = await import(`./adapters/${k}.mjs`);',
    'const z = await import(name);', "const w = await import('./c.mjs' + suffix);", "// import(commented)", 'const u = import.meta.url;',
  ].join('\n');
  it('counts every import() whose argument is not a single string literal, and nothing else', () => {
    const r = parseImports(src, { dynamic: true, reportComputed: true });
    assert.equal(r.computed, 3, 'template, identifier, concatenation; not the literal, not the comment, not import.meta');
    assert.deepEqual(r.specifiers, ['./a.mjs', './lit.mjs']);
  });
  it('without the option the return value is the bare array it always was', () => {
    assert.deepEqual(parseImports(src, { dynamic: true }), ['./a.mjs', './lit.mjs']);
    assert.deepEqual(parseImports(src), ['./a.mjs']);
    assert.ok(Array.isArray(parseImports(src, { dynamic: true })));
  });
  it('a file with no computed import reports zero (control: the counter can read zero)', () => {
    assert.equal(parseImports("import('./a.mjs');", { dynamic: true, reportComputed: true }).computed, 0);
  });
});

describe('the heavy list', () => {
  const ok = JSON.stringify(LIST);
  it('accepts a valid list', () => assert.equal(parseHeavyList(ok).ok, true));
  it('refuses each malformed shape', () => {
    const mutate = (f) => { const l = structuredClone(LIST); f(l); return JSON.stringify(l); };
    for (const [name, text] of Object.entries({
      'not json': '{',
      'wrong version': mutate((l) => { l.version = 2; }),
      'empty heavy': mutate((l) => { l.heavy = []; }),
      'duplicate file': mutate((l) => { l.heavy.push(l.heavy[0]); }),
      'a path outside tests/': mutate((l) => { l.heavy[0].file = 'scripts/x.test.mjs'; }),
      'a nested test dir': mutate((l) => { l.heavy[0].file = 'tests/sub/x.test.mjs'; }),
      'no reason': mutate((l) => { l.heavy[0].why = 'short'; }),
      'a bad date': mutate((l) => { l.heavy[0].measuredAt = 'yesterday'; }),
      'no reach': mutate((l) => { l.heavy[0].reach = []; }),
      'an unknown key': mutate((l) => { l.heavy[0].extra = 1; }),
    })) assert.equal(parseHeavyList(text).ok, false, name);
  });
  it('the committed list parses, names the 48-file family, and every entry has a non-trivial declared reach', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const r = parseHeavyList(fs.readFileSync(path.join(import.meta.dirname, '..', '.test-tiers.json'), 'utf8'));
    assert.equal(r.ok, true, r.reason);
    assert.ok(r.list.heavy.length >= 1, 'vacuous-pass guard: a list that names nothing skips nothing');
    for (const h of r.list.heavy) {
      assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', h.file)), `${h.file} exists`);
      assert.ok(h.reach.length >= 1, `${h.file} declares its reach`);
    }
    // Derived from the entry's own declared reach, not from its name: an entry that declares the fleet CLI's reach also
    // reads `.fleet.json` at runtime (lib/fleet/config.mjs), which no import shows (Gemini final review).
    for (const h of r.list.heavy.filter((e) => e.reach.includes('scripts/fleet.mjs'))) {
      assert.ok(h.reach.includes('.fleet.json'), `${h.file} declares the fleet CLI's reach but not .fleet.json`);
    }
  });
});

describe('reach (D3): computed union declared, and an edge we cannot follow is an edge', () => {
  const reach = (files, file = 'tests/t.test.mjs') => computeReach({ file, tree: mkTree(files) });
  it('follows an ESM import chain, static and string-literal dynamic', () => {
    const r = reach({ 'tests/t.test.mjs': "import {a} from '../s/a.mjs';", 's/a.mjs': "const b = await import('./b.mjs');", 's/b.mjs': '' });
    assert.deepEqual([...r.files].sort(), ['s/a.mjs', 's/b.mjs', 'tests/t.test.mjs']);
  });
  it('follows a literal repo path a test names (a spawned CLI), then into that file\'s own imports', () => {
    const r = reach({ 'tests/t.test.mjs': "spawn(node, ['scripts/cli.mjs']);", 'scripts/cli.mjs': "import './lib/inner.mjs';", 'scripts/lib/inner.mjs': '' });
    assert.ok(r.files.has('scripts/cli.mjs') && r.files.has('scripts/lib/inner.mjs'));
  });
  it('follows path.join / path.resolve segments and a root file literal', () => {
    const r = reach({ 'tests/t.test.mjs': "const f = path.join(ROOT, 'scripts', 'cli.mjs'); read('status.md');", 'scripts/cli.mjs': '', 'status.md': 'x' });
    assert.ok(r.files.has('scripts/cli.mjs'));
    assert.ok(r.files.has('status.md'));
  });
  it('a node builtin and an installed package are external: not traversed, not reached', () => {
    const r = reach({ 'tests/t.test.mjs': "import t from 'node:test'; import z from 'zod';" });
    assert.deepEqual([...r.files], ['tests/t.test.mjs']);
    assert.deepEqual([r.computed, r.unresolved], [0, []]);
  });
  it('a missing relative file, an extensionless specifier and a directory import are UNRESOLVABLE (ESM rejects them) and mark the file reached', () => {
    for (const spec of ['./gone.mjs', './noext', './dir']) {
      const r = reach({ 'tests/t.test.mjs': `import x from '${spec}';`, 'tests/noext.mjs': '', 'tests/dir/index.mjs': '' });
      assert.equal(r.unresolved.length, 1, spec);
    }
    const sel = (files, changed) => {
      const t = mkTree(files);
      return selectTier({ tree: t, list: listOf(entry('tests/t.test.mjs')), changed, head: HEAD, base: BASE, asOf: AS_OF, requested: 'branch' });
    };
    const files = { 'tests/t.test.mjs': "import x from './gone.mjs';", 'docs/a.md': '' };
    assert.deepEqual(reachedOf(sel(files, ['docs/a.md'])), ['tests/t.test.mjs'], 'reached by an unrelated diff');
    assert.deepEqual(reachedOf(sel({ ...files, 'tests/t.test.mjs': "import x from './here.mjs';", 'tests/here.mjs': '' }, ['docs/a.md'])), [], 'control: a resolvable import is not');
  });
  it('a non-literal import() in the TEST layer marks the file reached; in a scripts module it is recorded as blind, not a reach (measured deviation)', () => {
    const t = reach({ 'tests/t.test.mjs': 'await import(`./f/${n}.mjs`);' });
    assert.equal(t.computed, 1);
    const s = reach({ 'tests/t.test.mjs': "import './l.mjs';", 'tests/l.mjs': '', 'scripts/x.mjs': 'await import(name);' }, 'scripts/x.mjs');
    assert.deepEqual([s.computed, s.blind], [0, [{ file: 'scripts/x.mjs', calls: 1 }]]);
  });
  it('source text that merely contains "from `./${x}`" is regex noise, never an unresolvable import - but is RECORDED, not hidden', () => {
    const r = reach({ 'tests/t.test.mjs': "import './u.mjs';", 'tests/u.mjs': 'const s = `export * from "./${name}"`;' });
    assert.deepEqual(r.unresolved, []);
    assert.equal(r.computed, 1, 'a template-shaped edge in the test layer counts as a computed edge, so the file is reached');
  });
  it('importing through a symbolic link is an unresolvable edge: the entry is reached by any diff (audit r3 H1/M1)', () => {
    const files = { 'tests/t.test.mjs': "import '../scripts/alias.mjs';", 'scripts/alias.mjs': 'worker.mjs', 'scripts/worker.mjs': 'export {};', 'docs/a.md': '' };
    const tree = { ...mkTree(files), symlinks: new Set(['scripts/alias.mjs']) };
    const sel = (t) => selectTier({ tree: t, list: listOf(entry('tests/t.test.mjs')), changed: ['docs/a.md'], head: HEAD, base: BASE, asOf: AS_OF, requested: 'branch' });
    assert.deepEqual(reachedOf(sel(tree)), ['tests/t.test.mjs'], 'the link hides the target, so it is reached');
    assert.deepEqual(reachedOf(sel(mkTree(files))), [], 'control: the same files with no symlink flag are an ordinary skip');
  });
  it('a lone "$" in a specifier is a legal file name: a missing file with one is still UNRESOLVABLE (audit r2 H2)', () => {
    const r = reach({ 'tests/t.test.mjs': "import './$weird.mjs';" });
    assert.deepEqual(r.unresolved, ['tests/t.test.mjs -> ./$weird.mjs']);
    assert.equal(r.computed, 0);
  });
  it('a path the test names that the diff DELETES still reaches it (the file is gone from the head tree) - audit H3', () => {
    const files = { 'tests/t.test.mjs': "readFileSync('scripts/removed-fixture.json'); spawn('scripts/cli.mjs');", 'scripts/cli.mjs': '' };
    const sel = (changed) => selectTier({ tree: mkTree(files), list: listOf(entry('tests/t.test.mjs')), changed, head: HEAD, base: BASE, asOf: AS_OF, requested: 'branch' });
    assert.deepEqual(reachedOf(sel(['scripts/removed-fixture.json'])), ['tests/t.test.mjs'], 'the deleted fixture is named by the test');
    assert.deepEqual(reachedOf(sel(['docs/unrelated.md'])), [], 'control: an unrelated change still skips it');
  });
  it('an ambiguous literal suffix keeps EVERY plausible match, independent of enumeration order - audit H4', () => {
    const base = { 'tests/t.test.mjs': "spawn('lib/cli.mjs');", 'a/lib/cli.mjs': '', 'b/lib/cli.mjs': '' };
    for (const order of [Object.keys(base), Object.keys(base).reverse()]) {
      const t = mkTree(Object.fromEntries(order.map((k) => [k, base[k]])));
      const r = computeReach({ file: 'tests/t.test.mjs', tree: t });
      assert.ok(r.files.has('a/lib/cli.mjs') && r.files.has('b/lib/cli.mjs'), order.join(','));
    }
  });
  it('literalRefs finds quoted paths, join segments and root files, and ignores unrelated strings', () => {
    const refs = literalRefs("a('scripts/x.mjs'); path.join(R, 'tests', 'helpers', 'h.mjs'); b('status.md'); c('hello world');");
    assert.ok(refs.has('scripts/x.mjs') && refs.has('tests/helpers/h.mjs') && refs.has('status.md'));
    assert.ok(![...refs].includes('hello world'));
  });
});

describe('selectTier', () => {
  it('a diff that touches nothing a heavy file reaches skips both heavy files; the light file is never in the list', () => {
    const e = select(['docs/readme.md']);
    assert.equal(e.tier, 'branch');
    assert.deepEqual(e.skipped, ['tests/heavy-a.test.mjs', 'tests/heavy-b.test.mjs']);
    assert.ok(!e.skipped.includes('tests/light.test.mjs'));
    assert.equal(e.version, TEST_TIER_VERSION);
  });
  it('an import-closure change reaches only the file that imports it (shared.mjs is under heavy-a, not heavy-b)', () => {
    const e = select(['scripts/lib/shared.mjs']);
    assert.deepEqual(reachedOf(e), ['tests/heavy-a.test.mjs']);
    assert.deepEqual(e.skipped, ['tests/heavy-b.test.mjs']);
  });
  it('a declared-reach change reaches the declaring file (what no import shows)', () => {
    assert.deepEqual(reachedOf(select(['lib/b-declared/deep/x.json'])), ['tests/heavy-b.test.mjs']);
    assert.deepEqual(reachedOf(select(['lib/a-declared/x'])), ['tests/heavy-a.test.mjs']);
  });
  it('a heavy file that itself changed is reached', () => {
    assert.deepEqual(reachedOf(select(['tests/heavy-b.test.mjs'])), ['tests/heavy-b.test.mjs']);
  });
  it('the default is FULL (stage 0/1): nothing skipped, wouldSkip reported for the shadow line', () => {
    const e = select(['docs/readme.md'], { requested: undefined });
    assert.equal(DEFAULT_BRANCH_TIER, 'full');
    assert.deepEqual([e.tier, e.skipped, e.wouldSkip.length, e.requestedRaw], ['full', [], 2, null]);
    assert.equal(shadowLine(e), 'test-tier/v1 shadow: would skip 2 of 2 heavy file(s) (0 reached by this diff)');
  });

  describe('each escape fires alone, is named, and forces full', () => {
    const fires = (id, e) => { assert.equal(e.tier, 'full', id); assert.deepEqual(e.skipped, [], id); assert.ok(e.escapes.some((x) => x.id === id), `${id} in ${JSON.stringify(e.escapes.map((x) => x.id))}`); };
    it('pushes-default', () => fires('pushes-default', select(['docs/readme.md'], { pushesDefault: true })));
    it('forced-full (AUDIT_PREPUSH_TIER=full)', () => fires('forced-full', select(['docs/readme.md'], { requested: 'full' })));
    it('an unknown request', () => fires('unknown-tier-request', select(['docs/readme.md'], { requested: 'bogus' })));
    it('no resolvable selection base', () => fires('no-selection-base', select(['docs/readme.md'], { base: null })));
    it('every selector dependency (audit H1)', () => {
      for (const dep of ['scripts/lib/test-tier.mjs', 'scripts/lib/test-tier-git.mjs', 'scripts/lib/module-graph.mjs', 'scripts/lib/glob-match.mjs', 'scripts/test-tier.mjs', '.test-tiers.json', 'scripts/run-tests.mjs', 'scripts/prepush-check.mjs', '.githooks/pre-push', '.githooks/anything']) {
        fires('selector-changed', select([dep]));
      }
      assert.ok(SELECTOR_IDENTITY_FILES.every((f) => SELECTOR_DEPENDENCIES.includes(f)), 'identity files are a subset of the dependencies');
    });
    it('the shared environment', () => { for (const f of ['package.json', 'package-lock.json', '.nvmrc']) fires('shared-environment', select([f])); });
    it('a listed file that no longer exists (stale list)', () => {
      const t = repo(); t.files.delete('tests/heavy-b.test.mjs');
      fires('heavy-list-stale', selectTier({ tree: t, list: LIST, changed: ['docs/readme.md'], head: HEAD, base: BASE, asOf: AS_OF, requested: 'branch' }));
    });
    it('a timing older than maxAgeDays, judged at asOf (not at the wall clock)', () => {
      const old = listOf(entry('tests/heavy-a.test.mjs', ['x'], { measuredAt: '2026-08-01' }), entry('tests/heavy-b.test.mjs', ['y']));
      fires('heavy-list-stale', selectTier({ tree: repo(), list: old, changed: ['docs/readme.md'], head: HEAD, base: BASE, asOf: AS_OF, requested: 'branch' }));
      const sameList = selectTier({ tree: repo(), list: old, changed: ['docs/readme.md'], head: HEAD, base: BASE, asOf: '2026-08-15T00:00:00.000Z', requested: 'branch' });
      assert.equal(sameList.tier, 'branch', 'control: judged at an earlier head time the same list is fresh');
    });
    it('control: none of these fire for an ordinary docs change', () => assert.deepEqual(select(['docs/readme.md']).escapes, []));
  });

  it('the base is a fork point carried in the envelope: a re-push keeps the earlier commits\' reach', () => {
    const e = select(['scripts/lib/shared.mjs', 'docs/readme.md'], { baseSource: 'merge-base:origin/main' });
    assert.equal(e.baseSource, 'merge-base:origin/main');
    assert.equal(e.base, BASE);
    assert.deepEqual(reachedOf(e), ['tests/heavy-a.test.mjs']);
  });

  it('the counterfactual ignores every push-time input and says it is measured', () => {
    const q = selectBranchTier({ tree: repo(), list: LIST, changed: ['docs/readme.md'], head: HEAD, base: BASE, asOf: AS_OF, requested: 'full', pushesDefault: true });
    assert.deepEqual([q.kind, q.measured, q.tier, q.skipped.length], ['counterfactual-branch', true, 'branch', 2]);
  });
  it('replayCandidate is labelled a candidate counterfactual and never the production kind', () => {
    const r = replayCandidate({ changed: ['docs/readme.md'], list: LIST, tree: repo(), asOf: AS_OF });
    assert.equal(r.kind, 'counterfactual-candidate');
    assert.notEqual(r.kind, 'counterfactual-branch');
  });
  it('a determinism check: the same inputs give byte-identical envelopes', () => {
    assert.equal(JSON.stringify(select(['scripts/lib/shared.mjs'])), JSON.stringify(select(['scripts/lib/shared.mjs'])));
  });
});

describe('the guards (section 2.4), each seen RED on a mutation', () => {
  const envelope = () => structuredClone(select(['scripts/lib/shared.mjs']));
  it('green on a real envelope', () => assert.deepEqual(validateEnvelopeAgainstList(envelope(), LIST), { ok: true }));
  it('an envelope that skips a file not on the heavy list is refused', () => {
    const e = envelope(); e.skipped = ['tests/light.test.mjs'];
    assert.match(validateEnvelopeAgainstList(e, LIST).reason, /not on the heavy list/);
  });
  it('an envelope that skips a file the diff reaches is refused', () => {
    const e = envelope(); e.skipped = ['tests/heavy-a.test.mjs'];
    assert.match(validateEnvelopeAgainstList(e, LIST).reason, /the diff reaches/);
  });
  it('a full envelope that skips anything is refused', () => {
    const e = select(['docs/readme.md'], { requested: 'full' }); e.skipped = ['tests/heavy-a.test.mjs'];
    assert.match(validateEnvelopeAgainstList(e, LIST).reason, /full-tier envelope must skip nothing/);
  });
  it('an envelope with no reach record for a listed file, a duplicate, or a stranger is refused: absence is never "not reached" (audit H2/M8)', () => {
    const e = envelope(); e.skipped = ['tests/heavy-b.test.mjs'];
    e.heavy = []; // the supplied example: heavy:[] and a skipped, listed file
    assert.match(validateEnvelopeAgainstList(e, LIST).reason, /no reach record for 2 listed file/);
    const dup = envelope(); dup.heavy.push(structuredClone(dup.heavy[0]));
    assert.match(validateEnvelopeAgainstList(dup, LIST).reason, /records a file twice/);
    const stranger = envelope(); stranger.heavy.push({ file: 'tests/other.test.mjs', reached: false });
    assert.match(validateEnvelopeAgainstList(stranger, LIST).reason, /not on the heavy list/);
    assert.deepEqual(validateEnvelopeAgainstList(envelope(), LIST), { ok: true }, 'control: the real envelope still validates');
  });
  it('envelopeMatchesRequest: a branch envelope is legal only for a branch request, off the default branch, with no escape (audit H1)', () => {
    const branch = select(['docs/readme.md']);
    assert.deepEqual(envelopeMatchesRequest(branch, { tier: 'branch', pushesDefault: false }), { ok: true });
    assert.match(envelopeMatchesRequest(branch, { tier: 'branch', pushesDefault: true }).reason, /updates the default branch/);
    assert.match(envelopeMatchesRequest(branch, { tier: '', pushesDefault: false }).reason, /the default/);
    assert.match(envelopeMatchesRequest(branch, { tier: 'full', pushesDefault: false }).reason, /request of "full"/);
    assert.match(envelopeMatchesRequest({ ...branch, escapes: [{ id: 'selector-changed', detail: 'x' }] }, { tier: 'branch', pushesDefault: false }).reason, /lists escape/);
    assert.deepEqual(envelopeMatchesRequest(select(['docs/readme.md'], { requested: 'full' }), { tier: 'full', pushesDefault: false }), { ok: true }, 'a full envelope is always acceptable');
  });
  describe('this repo\'s committed default tier (docs/plans/ci-full-suite-actions.md D2-D4)', () => {
    const WF = '.github/workflows/full-suite.yml';
    const CES = { ...LIST, defaultTier: 'branch', ciVerdict: { workflow: WF } };
    const withWf = repo({ [WF]: 'name: full-suite\n' });
    const ask = (over = {}) => selectTier({ tree: withWf, list: CES, changed: ['docs/readme.md'], head: HEAD, base: BASE, asOf: AS_OF, requested: null, ...over });

    it('an EMPTY request takes the list default (branch) where the verdict workflow exists, and says where it came from', () => {
      const e = ask();
      assert.deepEqual([e.tier, e.defaultSource, e.requestedRaw, e.escapes], ['branch', 'list', null, []]);
      assert.equal(e.skipped.length, 2);
    });
    it('the workflow missing from the tree is the FULL suite (ci-verdict-missing): a light default needs the CI that supplies the verdict', () => {
      const e = ask({ tree: repo() });
      assert.equal(e.tier, 'full');
      assert.deepEqual(e.escapes.map((x) => x.id), ['ci-verdict-missing']);
      assert.deepEqual(e.skipped, []);
    });
    it('every other escape still wins: an explicit full, a push to the default branch, a selector change, package.json', () => {
      assert.deepEqual(ask({ requested: 'full' }).escapes.map((x) => x.id), ['forced-full']);
      assert.equal(ask({ requested: 'full' }).tier, 'full');
      assert.equal(ask({ pushesDefault: true }).tier, 'full');
      assert.equal(ask({ changed: ['scripts/lib/test-tier.mjs'] }).tier, 'full');
      assert.equal(ask({ changed: ['package.json'] }).tier, 'full');
    });
    it('an explicit branch request does not need the CI (stage 1 keeps its meaning) and records that it was a request', () => {
      const e = ask({ requested: 'branch', tree: repo(), list: LIST });
      assert.deepEqual([e.tier, e.defaultSource], ['branch', 'request']);
    });
    it('a list WITHOUT the field behaves exactly as before: the code default (full)', () => {
      const e = ask({ list: LIST });
      assert.deepEqual([e.tier, e.defaultSource, DEFAULT_BRANCH_TIER], ['full', 'code', 'full']);
    });
    it('the list can never turn a branch default on without a ciVerdict, and only branch|full are values', () => {
      assert.equal(parseHeavyList(JSON.stringify({ ...LIST, defaultTier: 'branch' })).ok, false);
      assert.equal(parseHeavyList(JSON.stringify({ ...CES, defaultTier: 'sometimes' })).ok, false);
      assert.equal(parseHeavyList(JSON.stringify({ ...CES, ciVerdict: { workflow: '../outside.yml' } })).ok, false);
      assert.equal(parseHeavyList(JSON.stringify(CES)).ok, true, 'control: the valid shape parses');
      assert.equal(parseHeavyList(JSON.stringify({ ...LIST, defaultTier: 'full' })).ok, true, 'a full default needs no CI');
    });
    it('envelopeMatchesRequest accepts an empty request ONLY for a branch envelope that came from the list default', () => {
      const e = ask();
      assert.deepEqual(envelopeMatchesRequest(e, { tier: '', pushesDefault: false, list: CES }), { ok: true });
      assert.match(envelopeMatchesRequest(e, { tier: '', pushesDefault: false, list: LIST }).reason, /request of "the default"/, 'no list default: still refused');
      assert.match(envelopeMatchesRequest(e, { tier: '', pushesDefault: false }).reason, /the default/, 'no list at all: still refused');
      assert.match(envelopeMatchesRequest(e, { tier: 'full', pushesDefault: false, list: CES }).reason, /request of "full"/);
      assert.match(envelopeMatchesRequest(e, { tier: '', pushesDefault: true, list: CES }).reason, /updates the default branch/);
      assert.match(envelopeMatchesRequest({ ...e, escapes: [{ id: 'selector-changed', detail: 'x' }] }, { tier: '', pushesDefault: false, list: CES }).reason, /lists escape/);
      assert.match(envelopeMatchesRequest({ ...e, defaultSource: 'request' }, { tier: '', pushesDefault: false, list: CES }).reason, /the default/, 'an envelope that did not come from the list is not excused');
    });
  });
  it('known blind spots (a non-literal import() inside scripts/**) ride in the envelope, not just the reach result (audit M3)', () => {
    const tree = mkTree({ 'tests/t.test.mjs': "import '../scripts/lib/x.mjs';", 'scripts/lib/x.mjs': 'await import(name);', 'docs/a.md': '' });
    const e = selectTier({ tree, list: listOf(entry('tests/t.test.mjs')), changed: ['docs/a.md'], head: HEAD, base: BASE, asOf: AS_OF, requested: 'branch' });
    assert.deepEqual([e.heavy[0].blindCount, e.heavy[0].blind], [1, [{ file: 'scripts/lib/x.mjs', calls: 1 }]]);
    assert.equal(e.heavy[0].reached, false, 'a blind spot is reported, and (by the documented deviation) is not itself a reach');
    assert.equal(parseTierEnvelope(JSON.stringify(e)).ok, true, 'and it survives serialization');
  });
  it('a missing, unparseable, wrong-version or malformed envelope is not "skip nothing silently"', () => {
    for (const text of ['', '{', JSON.stringify({ ...envelope(), version: 'test-tier/v0' }), JSON.stringify({ version: TEST_TIER_VERSION }), JSON.stringify({ ...envelope(), skipped: 'all' })]) {
      assert.equal(parseTierEnvelope(text).ok, false, text.slice(0, 40));
    }
    assert.equal(parseTierEnvelope(JSON.stringify(envelope())).ok, true);
  });
  it('the banner names what a branch run skipped, and a full run has no banner', () => {
    assert.match(tierBanner(envelope()), /^BRANCH TIER — not the full suite\. Skipped 1 heavy file\(s\): heavy-b\.test\.mjs\.$/);
    assert.equal(tierBanner(select(['docs/readme.md'], { requested: 'full' })), null);
  });
});

describe('the one-line summary (audit M1)', () => {
  const line = summaryLine({ tier: 'branch', head: HEAD, skipped: 3, base: BASE });
  it('has exactly the documented grammar and round-trips', () => {
    assert.equal(line, `test-tier/v1 branch ${HEAD} skipped=3 base=${BASE}`);
    assert.deepEqual(parseSummary(`${line}\n`, HEAD), { ok: true, tier: 'branch', head: HEAD, skipped: 3, base: BASE, reason: null });
    assert.equal(parseSummary(summaryLine({ tier: 'full', head: HEAD, skipped: 0, base: null, reason: 'head-predates-tier' }), HEAD).reason, 'head-predates-tier');
    assert.equal(parseSummary(summaryLine({ tier: 'full', head: HEAD, skipped: 0, base: null }), HEAD).base, null);
  });
  it('missing, empty, truncated, malformed, duplicated and another-sha summaries are all refused', () => {
    for (const bad of [null, '', '\n', line.slice(0, 30), `${line} extra`, `${line}\n${line}\n`, line.replace('branch', 'both'), line.replace('skipped=3', 'skipped=x'), 'test-tier/v1 full'])
      assert.equal(parseSummary(bad, HEAD).ok, false, JSON.stringify(bad));
    assert.match(parseSummary(line, 'c'.repeat(40)).reason, /not the pushed head/);
  });
  it('summaryLine refuses a bad tier or head rather than printing a lookalike', () => {
    assert.throws(() => summaryLine({ tier: 'both', head: HEAD, skipped: 0, base: null }));
    assert.throws(() => summaryLine({ tier: 'full', head: 'abc', skipped: 0, base: null }));
  });
});
