/**
 * @fileoverview The recorded-history replay (docs/plans/gate-cost-slice-2.md section 1.4 and 9, Tier 2): `replayCandidate`
 * with the COMMITTED heavy list over the change lists in `tests/fixtures/test-tier/replay-cases.json`, against the CURRENT
 * tree read from disk. No git history is read, so the result is the same in a fresh clone, a shallow CI checkout and the
 * pre-push sandbox; the failing PR heads were squash-merged and their branches deleted, which is why the inputs are
 * committed fixtures and not commits.
 *
 * Fixture rot cannot read as a pass: a case naming a test file that no longer exists, an empty case list, or a case with
 * neither assertion FAILS. A fleet case turning red means an edge between its changed files and a fleet test was removed
 * (or the case is stale): update the fixture if that was on purpose.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { computeReach, parseHeavyList, replayCandidate } from '../scripts/lib/test-tier.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '.audit', 'dist', 'coverage']);

/** The working tree as the oracle's reader. Hermetic: no git. */
function diskTree() {
  const files = new Set();
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name); }
      else files.add(rel ? `${rel}/${e.name}` : e.name);
    }
  }(ROOT, ''));
  const cache = new Map();
  return {
    files,
    read: (p) => {
      if (!/\.(?:mjs|js|cjs)$/.test(p) || !files.has(p)) return null;
      if (!cache.has(p)) cache.set(p, fs.readFileSync(path.join(ROOT, p), 'utf8'));
      return cache.get(p);
    },
  };
}

const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'test-tier', 'replay-cases.json'), 'utf8'));
const list = parseHeavyList(fs.readFileSync(path.join(ROOT, '.test-tiers.json'), 'utf8')).list;
const tree = diskTree();
// Judged at the list's own newest timing, so the fixture does not rot with the wall clock.
const AS_OF = new Date(`${list.heavy.map((h) => h.measuredAt).sort().at(-1)}T12:00:00.000Z`).toISOString();
const DEFAULT_TESTS = [...tree.files].filter((f) => /^tests\/(claudemd\/|install\/)?[^/]+\.test\.mjs$/.test(f));

describe('the replay fixture itself cannot rot into a pass', () => {
  it('has cases, each with a source, a change list and at least one assertion', () => {
    assert.ok(fixture.cases.length >= 6, 'vacuous-pass guard: an empty or token fixture');
    for (const c of fixture.cases) {
      assert.ok(c.case && c.sourceHead && c.why, c.case);
      assert.ok(Array.isArray(c.changed) && c.changed.length > 0, `${c.case}: no change list`);
      assert.ok(c.mustRun.length + c.mustSkip.length > 0 || c.expectEscape, `${c.case}: no assertion`);
    }
  });
  it('names only test files that exist (a renamed or deleted test fails here, loudly)', () => {
    for (const c of fixture.cases) for (const t of [...c.mustRun, ...c.mustSkip]) assert.ok(tree.files.has(t), `${c.case}: ${t} no longer exists; update the fixture`);
  });
  it('every mustSkip is a heavy file (light files are never selected against) and every heavy mustSkip is in the list', () => {
    const heavy = new Set(list.heavy.map((h) => h.file));
    for (const c of fixture.cases) for (const t of c.mustSkip) assert.ok(heavy.has(t), `${c.case}: ${t} is not on the heavy list, so it can never be skipped`);
  });
});

describe('the reach contract is enforced on the committed list (audit H7: the documented backstops must exist)', () => {
  it('every heavy file has a NON-TRIVIAL computed reach (a scripts/** file), so a parse regression cannot make it unreachable-by-anything', () => {
    for (const h of list.heavy) {
      const r = computeReach({ file: h.file, tree });
      assert.ok([...r.files].some((f) => f.startsWith('scripts/')), `${h.file}: the computed reach holds no scripts/** file`);
      assert.equal(r.computed, 0, `${h.file}: a non-literal import() in the TEST layer marks it reached by every diff`);
      assert.deepEqual(r.unresolved, [], `${h.file}: an unresolvable import marks it reached by every diff`);
    }
  });
  it('every heavy file declares a reach, and each declared glob names a path that exists (no glob that can never match)', () => {
    const globRoot = (g) => g.split('*')[0].replace(/\/$/, '');
    for (const h of list.heavy) {
      assert.ok(h.reach.length > 0, h.file);
      for (const g of h.reach) assert.ok([...tree.files].some((f) => f === g || f.startsWith(globRoot(g))) || g === '.fleet.json', `${h.file}: declared reach ${g} matches nothing in the tree`);
    }
  });
});

describe('replayCandidate with the committed manifest (the plan\'s section 1.4 (c) column)', () => {
  for (const c of fixture.cases) {
    it(c.case, () => {
      const r = replayCandidate({ changed: c.changed, list, tree, asOf: AS_OF });
      const skipped = new Set(r.wouldSkip);
      const run = DEFAULT_TESTS.filter((t) => !skipped.has(t));
      assert.equal(r.kind, 'counterfactual-candidate');
      if (c.expectEscape) {
        assert.ok(r.escapes.some((e) => e.id === c.expectEscape), `${c.case}: expected escape ${c.expectEscape}, got ${r.escapes.map((e) => e.id)}`);
        assert.deepEqual(r.skipped, [], `${c.case}: an escape means nothing is skipped`);
      }
      for (const t of c.mustRun) {
        const via = r.heavy.find((h) => h.file === t);
        assert.ok(run.includes(t), `${c.case}: ${t} must run but would be skipped (${via ? `reached:${via.reached}` : 'light'}). If an edge was removed on purpose, update the fixture.`);
      }
      for (const t of c.mustSkip) assert.ok(skipped.has(t), `${c.case}: ${t} must be skipped but would run (${r.heavy.find((h) => h.file === t)?.via?.join('; ')})`);
      assert.ok(run.length > DEFAULT_TESTS.length - list.heavy.length - 1, `${c.case}: every light file always runs`);
    });
  }
  it('the light set is never touched: whatever the diff, skipped is a subset of the heavy list', () => {
    const heavy = new Set(list.heavy.map((h) => h.file));
    for (const c of fixture.cases) assert.ok(replayCandidate({ changed: c.changed, list, tree, asOf: AS_OF }).wouldSkip.every((f) => heavy.has(f)), c.case);
  });
  it('control: some case actually skips something and some case actually runs a heavy file (the replay is not constant)', () => {
    const counts = fixture.cases.map((c) => replayCandidate({ changed: c.changed, list, tree, asOf: AS_OF }).wouldSkip.length);
    assert.ok(counts.some((n) => n > 0) && counts.some((n) => n === 0), JSON.stringify(counts));
  });
});
