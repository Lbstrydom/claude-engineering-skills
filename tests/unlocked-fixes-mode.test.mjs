/**
 * @fileoverview The `unlocked_fixes` regression-lock nudge must report a real
 * denominator and must not count plan findings as obligations.
 *
 * Two defects this pins, both measured 2026-07-29 against the live store:
 *
 * 1. `getUnlockedFixes` caps at `LIMIT 20`, so a caller counting its rows
 *    reported "20" when the true total was **232** — an order-of-magnitude
 *    undercount in a nudge whose only job is to convey scale.
 * 2. 113 of those 232 came from `mode = 'plan'` runs. A plan finding's
 *    `primary_file` is a section reference, there is no code artifact, and the
 *    thing the view counts (a `regression_specs` row authored by /ux-lock) can
 *    never exist for it. Folding them into one total made half the backlog
 *    read as work that cannot be done.
 *
 * The reduce is pure and the fixture rows mirror the view's real shape, so
 * these run without a database. The `audit_mode` column itself is covered by
 * the schema fixture (`tests/fixtures/expected-schema.json`).
 *
 * @module tests/unlocked-fixes-mode
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The exact fold `countUnlockedFixes` applies to the GROUP BY rows. Mirrored
 * here rather than imported because the store module opens a pg pool on import.
 */
function foldModeCounts(rows) {
  return rows.reduce((acc, r) => {
    const n = Number(r.n) || 0;
    acc.total += n;
    if (r.audit_mode === 'code') acc.code += n;
    else if (r.audit_mode === 'plan') acc.plan += n;
    return acc;
  }, { total: 0, code: 0, plan: 0 });
}

describe('countUnlockedFixes fold', () => {
  it('splits the real 2026-07-29 population correctly', () => {
    const r = foldModeCounts([{ audit_mode: 'code', n: 119 }, { audit_mode: 'plan', n: 113 }]);
    assert.deepEqual(r, { total: 232, code: 119, plan: 113 });
  });

  it('total counts every row, including modes it does not bucket', () => {
    // A future mode must still reach `total` — otherwise the denominator
    // silently shrinks and the nudge under-reports again, which is defect #1.
    const r = foldModeCounts([{ audit_mode: 'code', n: 2 }, { audit_mode: 'future-mode', n: 5 }]);
    assert.equal(r.total, 7);
    assert.equal(r.code, 2);
    assert.equal(r.plan, 0);
  });

  it('tolerates a null mode without corrupting the total', () => {
    const r = foldModeCounts([{ audit_mode: null, n: 3 }]);
    assert.deepEqual(r, { total: 3, code: 0, plan: 0 });
  });

  it('coerces string counts (pg may return bigint as text)', () => {
    const r = foldModeCounts([{ audit_mode: 'code', n: '4' }]);
    assert.equal(r.code, 4);
  });

  it('an empty result is a real zero, not a crash', () => {
    assert.deepEqual(foldModeCounts([]), { total: 0, code: 0, plan: 0 });
  });
});

describe('unlocked_fixes view contract', () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.resolve(import.meta.dirname, 'fixtures/expected-schema.json'), 'utf8'));
  const view = fixture.views.find((v) => v.view_name === 'unlocked_fixes');
  // The obligation predicate now lives one view down: `unlocked_fixes_all` holds
  // it plus the age test as a COLUMN (`is_recent`), and `unlocked_fixes` is the
  // windowed projection over it. Splitting them is what made "what did the
  // window drop?" answerable; the predicate itself is unchanged, so these
  // assertions follow it rather than relaxing.
  const base = fixture.views.find((v) => v.view_name === 'unlocked_fixes_all');

  it('exposes audit_mode so callers can separate code from plan obligations', () => {
    assert.ok(view, 'unlocked_fixes must exist in the schema fixture');
    assert.match(view.definition, /audit_mode/,
      'without this column the nudge cannot tell an obligation from an unlockable plan finding');
  });

  it('still filters to HIGH + fixed/verified — neither change widened anything', () => {
    assert.ok(base, 'unlocked_fixes_all must exist — it now owns the obligation predicate');
    assert.match(base.definition, /severity = 'HIGH'/);
    assert.match(base.definition, /remediation_state/);
  });

  it('the age window lives in exactly ONE expression', () => {
    // Two copies of `14 days` is how "what is in the window" and "what the
    // window dropped" drift apart, which is the whole point of the split.
    assert.match(base.definition, /is_recent/,
      'the window must be a column on the base view, not a filter duplicated per reader');
    assert.equal((view.definition.match(/14 days/g) ?? []).length, 0,
      'the windowed view must inherit the bound, never restate it');
  });

  it('unlocked_fixes narrows unlocked_fixes_all rather than re-deriving it', () => {
    assert.match(view.definition, /FROM unlocked_fixes_all/);
    assert.match(view.definition, /is_recent/);
    // Vacuous-pass guard: a projection that dropped a column would still match
    // the two assertions above, and every existing reader does `SELECT *`.
    for (const col of ['audit_finding_id', 'audit_run_id', 'repo_id', 'severity',
      'category', 'primary_file', 'detail_snapshot', 'fixed_at', 'lock_spec_count', 'audit_mode']) {
      assert.match(view.definition, new RegExp(`\\b${col}\\b`), `${col} must survive the split`);
    }
    assert.ok(!/\bis_recent\b[\s\S]*FROM/.test(view.definition.split('FROM')[0]),
      'is_recent is an implementation detail of the base view and must not leak into the windowed column list');
  });

  it('mirrors the sibling view, which also exposes mode rather than dropping rows', () => {
    const sib = fixture.views.find((v) => v.view_name === 'unremediated_acceptances');
    assert.ok(sib && /mode/.test(sib.definition),
      'the two nudge views should stay shaped alike; diverging silently is how one of them rots');
  });
});
