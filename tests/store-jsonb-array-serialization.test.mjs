/**
 * @fileoverview Regression guard for the postgres-parity M3 jsonb-array bug
 * (2026-05-21). The supabase-js→pg migration dropped PostgREST's implicit JSON
 * serialization; under the `pg` driver a jsonb ARRAY column bound as a RAW JS array
 * fails (`22P02 invalid input syntax for type json`) for non-empty content and
 * silently stores `{}` for empty. Every array-jsonb write MUST `JSON.stringify` at
 * the call site (object-jsonb columns are auto-serialized by node-postgres and are
 * exempt). This scans the store sources so a future raw-array bind fails CI here
 * rather than silently corrupting production data. See store/security.mjs for the
 * canonical convention.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// file → the jsonb ARRAY columns it writes (NOT object-jsonb columns — those are
// auto-serialized by node-postgres and must NOT be double-stringified).
const ARRAY_JSONB_WRITES = {
  'scripts/lib/store/persona.mjs': ['findings', 'click_path'],
  'scripts/lib/store/plans-ship.mjs': ['principles_cited', 'focus_areas', 'dom_contract_types', 'block_reasons'],
  'scripts/lib/store/debt.mjs': ['affected_files', 'affected_principles', 'content_aliases'],
};

for (const [file, cols] of Object.entries(ARRAY_JSONB_WRITES)) {
  test(`${file}: array-jsonb columns are JSON.stringify'd before bind`, () => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const col of cols) {
      // Match either the row-object property `<col>: <rhs>,` or an assignment
      // `row.<col> = <rhs>;` (optional `obj.` prefix), anchored to line start so we
      // don't match a `.findings` read mid-expression.
      const m = src.match(new RegExp(`\\n\\s*(?:\\w+\\.)?${col}\\s*[:=]\\s*([^\\n,;]*)`));
      assert.ok(m, `${file}: expected a row assignment for jsonb-array column "${col}"`);
      assert.match(
        m[1], /JSON\.stringify\(/,
        `${file}: jsonb-array column "${col}" must be JSON.stringify'd (raw-array bind → 22P02 / silent {} corruption). Got: ${m[1].trim()}`,
      );
    }
  });
}
