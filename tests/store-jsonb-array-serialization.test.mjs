/**
 * @fileoverview Guards the db-layer "jsonb-safe write" seam (fix for the
 * postgres-parity M3 regression). node-postgres serializes a JS ARRAY param as a
 * Postgres ARRAY literal, NOT JSON — so a raw array bound to a `jsonb` column fails
 * (`22P02`, non-empty) or silently stores `{}` (empty). The seam (`serializeWriteParam`
 * in db/query.mjs) JSON-serializes plain arrays at every write site by default, so a
 * jsonb writer CANNOT reintroduce the bug; genuine `text[]` columns opt out with
 * `pgArray()`. This tests both halves with no DB (the `_builders` seam) plus a source
 * guard that the known `text[]` writers keep their `pgArray()` wrapper.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { _builders, pgArray } from '../scripts/lib/db/query.mjs';

const { buildInsert, buildUpsert, buildUpdate } = _builders;
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// ── the seam: plain arrays → JSON; pgArray → raw; everything else untouched ──
test('INSERT serializes a plain array to a JSON string (jsonb-safe)', () => {
  const { params } = buildInsert('t', { findings: [{ a: 1 }], n: 2, s: 'x' });
  assert.equal(params[0], '[{"a":1}]');       // JSON string, NOT a JS array
  assert.deepEqual(params.slice(1), [2, 'x']); // scalars/strings untouched
});

test('empty array → "[]" (never the corrupting `{}`)', () => {
  assert.equal(buildInsert('t', { findings: [] }).params[0], '[]');
});

test('UPSERT serializes array values per row', () => {
  const { params } = buildUpsert('t', [{ click_path: [1, 2] }], { onConflict: 'id', update: 'all' });
  assert.equal(params[0], '[1,2]');
});

test('UPDATE SET serializes array values', () => {
  const { params } = buildUpdate('t', { focus_areas: ['a'] }, { id: 'r1' });
  assert.equal(params[0], '["a"]');
});

test('pgArray() keeps the raw JS array (for genuine text[] columns)', () => {
  const { params } = buildInsert('t', { paths: pgArray(['a', 'b']) });
  assert.deepEqual(params[0], ['a', 'b']);    // raw array → node-pg builds the array literal
});

test('pgArray(undefined) drops the column (DB default), not a NULL bind', () => {
  const { params } = buildInsert('t', { a: 1, paths: pgArray(undefined) });
  assert.deepEqual(params, [1]);              // the undefined column is omitted entirely
});

test('plain objects / strings / null pass through unchanged', () => {
  // a plain object is auto-JSON-serialized by node-pg itself — the seam leaves it as an object
  const { params } = buildInsert('t', { meta: { k: 1 }, s: '["already","json"]', z: null });
  assert.deepEqual(params[0], { k: 1 });
  assert.equal(params[1], '["already","json"]'); // an already-serialized string is NOT double-encoded
  assert.equal(params[2], null);
});

test('WHERE predicates are NOT serialized (text[]/array equality must stay raw)', () => {
  // buildUpdate's SET goes through the seam; its WHERE goes through flattenWhere,
  // which the seam deliberately skips so a `text[] = $n` predicate stays a raw array.
  const { params } = buildUpdate('t', { arr: [1, 2] }, { tags: ['a', 'b'] });
  assert.equal(params[0], '[1,2]');           // SET array → serialized
  assert.deepEqual(params[1], ['a', 'b']);    // WHERE array → raw (not JSON)
});

// ── source guard: the known text[] writers must keep their pgArray() wrapper ──
// (a raw array there would now be JSON-corrupted by the seam — the inverse hazard).
const TEXT_ARRAY_WRITERS = {
  'scripts/lib/store/repo.mjs': 'focus_areas',
  'scripts/lib/store/security.mjs': 'affected_paths',
  'scripts/lib/store/runs-findings.mjs': 'map_reduce_passes',
};
for (const [file, col] of Object.entries(TEXT_ARRAY_WRITERS)) {
  test(`${file}: text[] column "${col}" stays wrapped in pgArray()`, () => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // Capture the RHS of the column assignment (`<col>: <rhs>` or `<col> = <rhs>`).
    const m = src.match(new RegExp(`${col}\\s*[:=]\\s*([^\\n;]*)`));
    assert.ok(m, `${file}: expected a writer for text[] column "${col}"`);
    assert.match(m[1], /pgArray\(/, `${file}: text[] column "${col}" must use pgArray() (a raw array is JSON-corrupted by the seam)`);
  });
}
