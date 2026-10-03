/**
 * @fileoverview An incremental copy-forward must not carry an import edge whose
 * TARGET file no longer exists.
 *
 * `copyForwardImports` filtered carried edges by `importer_path` only. An edge
 * `a -> b` with `a` untouched and `b` deleted/renamed was therefore copied
 * forward verbatim, while a FULL refresh drops it (`extract.mjs` counts an
 * unresolved import as `unresolved` and never persists it) — so the same commit
 * indexed to two different edge sets depending on the refresh mode.
 *
 * The retention rule is the pure `retainCarriedRows` (shared with the symbol
 * copy-forward), now taking an optional `targetPathOf`. Pure tests over injected
 * predicates, no DB. The wiring — that `refresh.mjs` hands `copyForwardImports` a
 * REAL existence predicate in every mode — is asserted on source text below,
 * because a pure test cannot see a call site that passes `null`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { retainCarriedRows } from '../scripts/lib/store/arch/_shared.mjs';

const edge = (importer_path, imported_path) => ({ importer_path, imported_path });
const keepEdges = (rows, over = {}) => retainCarriedRows(rows, {
  pathOf: (r) => r.importer_path,
  targetPathOf: (r) => r.imported_path,
  touchedFileSet: new Set(),
  fileStillExists: () => true,
  isDisowned: null,
  ...over,
}).map((r) => `${r.importer_path}->${r.imported_path}`);

test('an edge to a DELETED target is dropped when its importer is untouched', () => {
  // `a` is not in touchedFileSet (it did not change), `b` is gone. This is the
  // exact input the importer-only filter carried.
  const kept = keepEdges([edge('a.mjs', 'b.mjs')], { fileStillExists: (p) => p !== 'b.mjs' });
  assert.deepEqual(kept, []);
});

test('an edge to an EXISTING untouched target is kept', () => {
  assert.deepEqual(keepEdges([edge('a.mjs', 'b.mjs')]), ['a.mjs->b.mjs']);
});

test('an edge to a TOUCHED-but-still-existing target is kept (its importer still imports it)', () => {
  // Only the importer key consults touchedFileSet. Applying it to the target
  // would drop every edge into a file that merely changed — the opposite bug.
  const kept = keepEdges([edge('a.mjs', 'b.mjs')], { touchedFileSet: new Set(['b.mjs']) });
  assert.deepEqual(kept, ['a.mjs->b.mjs']);
});

test('a TOUCHED importer still drops its edges, as before', () => {
  assert.deepEqual(keepEdges([edge('a.mjs', 'b.mjs')], { touchedFileSet: new Set(['a.mjs']) }), []);
});

test('a deleted IMPORTER still drops its edges, as before', () => {
  assert.deepEqual(keepEdges([edge('gone.mjs', 'b.mjs')], { fileStillExists: (p) => p !== 'gone.mjs' }), []);
});

test('a disowned importer still drops its edges, as before', () => {
  assert.deepEqual(keepEdges([edge('vendor/x.mjs', 'b.mjs')], { isDisowned: (p) => p.startsWith('vendor/') }), []);
});

test('mixed batch: only the edge with a vanished target is removed', () => {
  const rows = [edge('a.mjs', 'b.mjs'), edge('a.mjs', 'gone.mjs'), edge('c.mjs', 'b.mjs'), edge('t.mjs', 'b.mjs')];
  const kept = keepEdges(rows, { touchedFileSet: new Set(['t.mjs']), fileStillExists: (p) => p !== 'gone.mjs' });
  assert.deepEqual(kept, ['a.mjs->b.mjs', 'c.mjs->b.mjs']);
});

test('NEGATIVE CONTROL — without targetPathOf the dead-target edge survives (the pre-fix carry)', () => {
  const kept = retainCarriedRows([edge('a.mjs', 'gone.mjs')], {
    pathOf: (r) => r.importer_path,
    touchedFileSet: new Set(),
    fileStillExists: (p) => p !== 'gone.mjs',
  });
  assert.equal(kept.length, 1, 'proves the target check is what drops it, not the importer check');
});

test('NEGATIVE CONTROL — with no existence gate nothing is dropped (null = carry everything)', () => {
  // A caller that cannot answer the existence question must not delete rows.
  assert.deepEqual(keepEdges([edge('a.mjs', 'gone.mjs')], { fileStillExists: null }), ['a.mjs->gone.mjs']);
});

test('symbol rows (no targetPathOf) are unaffected', () => {
  const kept = retainCarriedRows([{ file_path: 'a.mjs' }, { file_path: 'gone.mjs' }], {
    touchedFileSet: new Set(), fileStillExists: (p) => p !== 'gone.mjs',
  });
  assert.deepEqual(kept.map((r) => r.file_path), ['a.mjs']);
});

test('wiring: copyForwardImports keys the existence check on BOTH endpoints', () => {
  const src = fs.readFileSync(new URL('../scripts/lib/store/arch/imports.mjs', import.meta.url), 'utf-8');
  assert.match(src, /retainCarriedRows\(rows, \{[^}]*targetPathOf:\s*\(r\)\s*=>\s*r\.imported_path/);
});

test('wiring: refresh.mjs passes copyForwardImports a real existence predicate in EVERY mode', () => {
  const src = fs.readFileSync(new URL('../scripts/symbol-index/refresh.mjs', import.meta.url), 'utf-8');
  const call = src.slice(src.indexOf('copyForwardImports({'));
  const block = call.slice(0, call.indexOf('});'));
  // Not the `timeoutRecovery ? … : null`-gated variable the symbol copy uses.
  assert.match(block, /fileStillExists:\s*onDisk\b/, 'imports must get the ungated predicate');
  assert.match(src, /const onDisk = \(filePath => fs\.existsSync\(path\.join\(repoRoot, filePath\)\)\)/);
  assert.match(src, /const fileStillExists = timeoutRecovery \? onDisk : null/, 'symbols keep their timed-out-only gate');
});
