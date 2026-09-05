/**
 * @fileoverview Copy-forward must not carry a row whose file the repo no longer
 * owns — in EITHER table.
 *
 * Plan: docs/plans/incremental-refresh-ownership-propagation.md (Cluster A).
 * Upstream report: `edc0948e`, Lbstrydom/wine-cellar-app.
 *
 * WHY. On an incremental refresh the ownership filter is asked of `args.files`,
 * the git-diff scope. A gitignored-and-untracked file cannot appear in a git
 * diff, so it is never a candidate and never reclassified — and copy-forward's
 * only predicates were "not touched" and "still on disk", both of which an
 * already-indexed disowned row satisfies. The row is therefore carried into
 * every subsequent snapshot indefinitely.
 *
 * These are pure-predicate tests over an injected `isDisowned`. The wiring —
 * that the predicate is built from the UNION of both tables' paths, and that a
 * real disowned file is actually dropped end-to-end — is asserted separately in
 * `tests/refresh-ownership-epoch-db.test.mjs` against a real Postgres, because
 * a pure test cannot see an omitted SELECT field or a wrong candidate set.
 *
 * **This repo has nothing disowned**, so every fixture below CONSTRUCTS the
 * state. A test that passed here by sampling the repo would be vacuous.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Both helpers live in `arch/_shared.mjs`: they are pure, both copy-forward
// paths need the retention rule, and `arch/` sub-modules may not import each
// other (`tests/arch-memory-split.test.mjs`). `_shared.mjs` is deliberately NOT
// re-exported by the barrel, so testing through it adds nothing to the public
// surface — which the barrel's export contract forbids.
import { retainCarriedRows, vectorLiteral } from '../scripts/lib/store/arch/_shared.mjs';

/** Minimal row shape — only the fields the retention decision reads. */
const row = (file_path, definition_id = file_path) => ({ file_path, definition_id });

test('a disowned carried row is dropped even though it is absent from the diff scope', () => {
  // The "absent from the diff scope" half is the whole point: `touchedFileSet`
  // is the git-diff scope, and the disowned file is NOT in it. A predicate
  // wired to the restricted set could not reach this row at all, so this is the
  // assertion that separates the fix from the bug it replaces.
  const rows = [row('src/owned.mjs'), row('scripts/.claude-skills/vendored.mjs')];
  const keep = retainCarriedRows(rows, {
    touchedFileSet: new Set(),                       // nothing changed this run
    fileStillExists: () => true,                     // both still on disk
    isDisowned: (p) => p.startsWith('scripts/.claude-skills/'),
  });
  assert.deepEqual(keep.map((r) => r.file_path), ['src/owned.mjs']);
});

test('NEGATIVE CONTROL — with no ownership predicate the disowned row survives', () => {
  // Pins that the previous test measures the predicate and not something else.
  const rows = [row('src/owned.mjs'), row('scripts/.claude-skills/vendored.mjs')];
  const keep = retainCarriedRows(rows, {
    touchedFileSet: new Set(),
    fileStillExists: () => true,
    isDisowned: null,
  });
  assert.equal(keep.length, 2, 'without the predicate this is the pre-fix behaviour');
});

test('a DEGRADED oracle drops nothing', () => {
  // `disowned-paths.mjs` returns an EMPTY set with `degraded:true` when git is
  // unavailable. Empty there means "nothing was CHECKED", never "nothing is
  // disowned". A fail-open that deletes index rows on an unanswered question is
  // worse than the bug being fixed, so the caller passes `isDisowned: null` on
  // degradation and this asserts the resulting behaviour is byte-identical to
  // the pre-fix carry.
  const rows = [row('a.mjs'), row('b.mjs'), row('c.mjs')];
  const keep = retainCarriedRows(rows, {
    touchedFileSet: new Set(),
    fileStillExists: () => true,
    isDisowned: null,
  });
  assert.deepEqual(keep.map((r) => r.file_path), ['a.mjs', 'b.mjs', 'c.mjs']);
});

test('the ownership predicate does not disturb the touched-file or existence rules', () => {
  // The new predicate is additive. A touched row and a vanished row must still
  // be excluded for their own reasons, and an owned survivor must still survive.
  const rows = [row('touched.mjs'), row('gone.mjs'), row('kept.mjs'), row('disowned.mjs')];
  const keep = retainCarriedRows(rows, {
    touchedFileSet: new Set(['touched.mjs']),
    fileStillExists: (p) => p !== 'gone.mjs',
    isDisowned: (p) => p === 'disowned.mjs',
  });
  assert.deepEqual(keep.map((r) => r.file_path), ['kept.mjs']);
});

test('every exclusion rule is independently sufficient', () => {
  // Guards against an implementation that ANDs the rules together — which would
  // still pass the test above, since that fixture has exactly one survivor.
  const cases = [
    ['touched', { touchedFileSet: new Set(['x.mjs']), fileStillExists: () => true, isDisowned: () => false }],
    ['missing', { touchedFileSet: new Set(), fileStillExists: () => false, isDisowned: () => false }],
    ['disowned', { touchedFileSet: new Set(), fileStillExists: () => true, isDisowned: () => true }],
  ];
  for (const [label, opts] of cases) {
    assert.equal(retainCarriedRows([row('x.mjs')], opts).length, 0, `${label} alone must exclude`);
  }
  assert.equal(
    retainCarriedRows([row('x.mjs')], {
      touchedFileSet: new Set(), fileStillExists: () => true, isDisowned: () => false,
    }).length,
    1,
    'and none of them firing must retain — otherwise the above is vacuous',
  );
});

test('imports use the SAME retention rule as symbols', async () => {
  // R2-M2: `copyForwardImports` carries edges on its own predicates and does
  // NOT derive from retained symbols, so dropping a disowned file's symbols
  // while carrying its edges leaves `symbol_file_imports` — the table that
  // generates `.audit-loop/domain-deps-observed.json` — still attributing the
  // bundle's imports to the consumer. One rule, imported by both, is what makes
  // "they agree" structural rather than a thing to remember.
  // Asserted on the SOURCE TEXT of each module rather than through an exported
  // seam: the barrel's export contract forbids additions to the public surface,
  // and a test seam is not public API. Checking both halves — that each imports
  // the rule AND that neither carries its own copy — is what makes "they share
  // it" a checked property instead of a comment.
  const fs = await import('node:fs');
  for (const f of ['symbols.mjs', 'imports.mjs']) {
    const src = fs.readFileSync(new URL(`../scripts/lib/store/arch/${f}`, import.meta.url), 'utf-8');
    assert.ok(
      /import \{[^}]*\bretainCarriedRows\b[^}]*\} from '\.\/_shared\.mjs'/.test(src),
      `${f} must import the retention rule from _shared.mjs`,
    );
    assert.ok(
      !/function retainCarriedRows/.test(src),
      `${f} must not carry its own copy of the retention rule`,
    );
  }
});

test('an edge is dropped when EITHER endpoint file is disowned as an importer', () => {
  // Edges are keyed on importer_path; the importer is the file whose ownership
  // decides whether the edge is ours to record.
  // `file_path` is deliberately set to a DIFFERENT, owned path on both rows, so
  // this fails unless `pathOf` is genuinely reading `importer_path`. With the
  // two fields equal the accessor would be untested.
  const edges = [
    { file_path: 'src/owned-decoy.mjs', importer_path: 'src/app.mjs', imported_path: 'src/util.mjs' },
    { file_path: 'src/owned-decoy.mjs', importer_path: 'scripts/.claude-skills/x.mjs', imported_path: 'src/util.mjs' },
  ];
  const keep = retainCarriedRows(edges, {
    pathOf: (r) => r.importer_path,
    touchedFileSet: new Set(),
    fileStillExists: () => true,
    isDisowned: (p) => p.startsWith('scripts/.claude-skills/'),
  });
  assert.deepEqual(keep.map((r) => r.importer_path), ['src/app.mjs']);
});

/**
 * Cluster-A audit R1 H5. `vectorLiteral`'s dimension check was guarded by
 * `typeof expectedDim === 'number'`, so a STRING dimension disabled it silently
 * — and env-derived config is exactly where a `'768'` comes from. A validator
 * that switches itself off based on its own argument's type is inert in
 * precisely the configuration that needs it.
 */
test('the dimension check is not disabled by a string dimension', () => {
  // The exact reported case: dimension '2' (string) with a three-element vector.
  assert.throws(() => vectorLiteral([1, 2, 3], '2'), /3 dims, expected 2/,
    'a string dimension must still be enforced — this is the pre-fix escape');

  // A numeric dimension keeps its existing behaviour, in both directions.
  assert.throws(() => vectorLiteral([1, 2, 3], 2), /3 dims, expected 2/);
  assert.equal(vectorLiteral([1, 2, 3], 3), '[1,2,3]');

  // Absent still means "do not check" — the deliberate opt-out must survive.
  assert.equal(vectorLiteral([1, 2, 3], null), '[1,2,3]');
  assert.equal(vectorLiteral([1, 2, 3], undefined), '[1,2,3]');

  // An uninterpretable value is an ERROR, not a skip — the whole point.
  assert.throws(() => vectorLiteral([1, 2, 3], 'abc'), /positive integer/);
  assert.throws(() => vectorLiteral([1, 2, 3], 0), /positive integer/);
});

/**
 * Cluster-A audit R1 H4. `copyForwardImports` binds its source read to the repo
 * through the `refresh_runs` FK and says at length why; `copyForwardUntouchedFiles`
 * did not. The ownership filter added in this cluster makes the gap destructive
 * rather than merely wrong: it classifies carried paths against THIS repo's git,
 * so a foreign source snapshot would answer "disowned" for every path and delete
 * them all.
 *
 * The binding itself is SQL and is asserted end-to-end in the Cluster B
 * real-Postgres suite. What is checkable here is the guard that must precede it.
 */
test('copy-forward refuses a call missing any of its scoping ids', async () => {
  const { copyForwardUntouchedFiles } = await import('../scripts/lib/store/arch/symbols.mjs');
  const base = { fromRefreshId: 'f', toRefreshId: 't', touchedFileSet: new Set() };
  for (const missing of ['repoId', 'fromRefreshId', 'toRefreshId']) {
    const args = { ...base, repoId: 'r' };
    delete args[missing];
    assert.equal(await copyForwardUntouchedFiles(args), 0,
      `a missing ${missing} must copy NOTHING — degrade to a full re-walk, never to foreign data`);
  }
});
