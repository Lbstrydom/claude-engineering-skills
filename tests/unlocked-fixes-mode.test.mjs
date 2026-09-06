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

// ── audit_mode alone is not the mode (upstream report fe1ff38a) ─────────────
//
// Everything above this line asserts a MIRROR of the reduce, copied into the test
// because the module was believed to open a pg pool on import. It does not — measured
// 2026-09-06, `await import('.../ship-nudges.mjs')` completes in ~1.5s and opens
// nothing — and the mirror is exactly why this defect survived: the copy was correct
// while the original was wrong, so the suite stayed green through the whole period.
// The block below imports the REAL module and asserts the real exported oracle.
describe('effective mode — a code-mode row whose primary_file is a plan section', () => {
  // Imported, never restated. A second spelling of the pattern here would reintroduce
  // the drift this whole report is about.
  const load = async () => import('../scripts/lib/store/finding-mode.mjs');

  // Verbatim `primary_file` values, taken from the live store on 2026-09-06 — not
  // invented. The first group is what the fixture factories always produced (and so
  // what the mirrored tests above have always exercised); the second is what the store
  // actually holds and no test had ever seen.
  const REAL_PATHS = [
    'scripts/lib/upstream/commands.mjs',
    'scripts/lib/db/client.mjs',
    'scripts/lib/cross-skill/commands/quality.mjs',
    'src/routes/wines.js',
    'app/components/Cellar.tsx',
    'data/migrations/177_drop_dead_bottle_count.sql',
    'docs/reference/gate-honesty.md',
  ];
  const REAL_SECTIONS = [
    '§2 proposed architecture — bootstrap entry point',
    '§2 entry point `npx github',
    '§1 measured consumer state; §2 entry points; §5 sustainability notes',
    'plan file inventory — migration and verification deliverables',
    'files in scope — durable debt state, consumer-local configuration, and v3 run-metadata migration',
    'runlegacyproductionaudit — `audit.runcomplete` and `reconcilecompletionrow`',
    'wave 1.5c production wiring; d12 lifecycle reconciliation',
    // From the reporter's repo, quoted in fe1ff38a:
    'plan §7 — service/config additions',
    'plan §2 / new files — freshness configuration',
    'plan §7 frontend shared and cellar-analysis components',
  ];

  it('accepts real repo-relative paths as code', async () => {
    const { CODE_PATH_PATTERN } = await load();
    const re = new RegExp(CODE_PATH_PATTERN);
    for (const p of REAL_PATHS) assert.ok(re.test(p), `${p} must count as code`);
  });

  it('rejects real plan-section references — the direction that was 2.5x wrong', async () => {
    const { CODE_PATH_PATTERN } = await load();
    const re = new RegExp(CODE_PATH_PATTERN);
    for (const s of REAL_SECTIONS) assert.ok(!re.test(s), `${JSON.stringify(s)} must NOT count as code`);
  });

  it('a bare extensionless token is not a path either', async () => {
    // The failure mode a laxer predicate would reintroduce: `README`, `§7`, or a
    // sentence fragment with no spaces would sail through a "no whitespace" test alone.
    const { CODE_PATH_PATTERN } = await load();
    const re = new RegExp(CODE_PATH_PATTERN);
    for (const s of ['README', '§7', 'runlegacyproductionaudit', '']) {
      assert.ok(!re.test(s), `${JSON.stringify(s)} must NOT count as code`);
    }
  });

  it('the SQL fragment is COMPOSED from the pattern, so the two cannot drift', async () => {
    const { CODE_PATH_PATTERN, EFFECTIVE_MODE_SQL } = await load();
    assert.ok(EFFECTIVE_MODE_SQL.includes(CODE_PATH_PATTERN),
      'EFFECTIVE_MODE_SQL must embed CODE_PATH_PATTERN rather than restate it');
    // A plan-mode row can never be promoted to code, whatever its primary_file looks
    // like: the guard is a conjunction. Asserted on the emitted SQL, not on intent.
    assert.match(EFFECTIVE_MODE_SQL, /audit_mode\s*=\s*'code'\s+AND/,
      'promotion to code must require audit_mode = code AND a path-shaped primary_file');
    assert.ok(!/\b[a-z]\.(audit_mode|primary_file)\b/.test(EFFECTIVE_MODE_SQL),
      'columns stay unqualified so the fragment drops into aliased and unaliased queries alike');
  });
});

describe('WIRING PIN: every byMode split counts effective mode, not audit_mode', () => {
  // The assertion that actually fails against the old code. The mirrored tests above
  // pass either way — they never touch the module — so without this the fix would be
  // unguarded and the next refactor could revert it silently.
  it('no reducer branches on r.audit_mode, and every byMode GROUP BY uses the fragment', () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, '../scripts/lib/store/ship-nudges.mjs'), 'utf-8');

    assert.ok(!/r\.audit_mode/.test(src),
      'a reducer branching on the RAW audit_mode is the defect fe1ff38a reported');

    // Six aggregate branches across four readers: countUnlockedFixes (4 literal view
    // branches), countUnremediatedAcceptances (4), countAgedUnlockedFixes (1) and
    // countAgedUnremediatedAcceptances (2). Count the fragment's uses rather than
    // trusting that a grep found them all — the report itself named only three sites.
    const uses = (src.match(/\$\{EFFECTIVE_MODE_SQL\}/g) || []).length;
    assert.ok(uses >= 11, `expected every byMode branch to use the fragment, saw ${uses}`);

    // The ROW filter must move with the counts. Fixing only the aggregate would be
    // worse than the original defect: the card would say `code: 64` while `mode:'code'`
    // handed back 74 rows, and nothing tells the reader which number is lying.
    // Measured after the fix: 64 rows / byMode.code 64 / 0 non-path rows leaking.
    assert.ok(!/preds\.push\(`audit_mode = /.test(src),
      'the row-level mode filter must use effective mode, not the raw audit_mode');

    // GROUP BY must follow the SELECT. A fragment in the projection with a stale
    // `GROUP BY audit_mode` would be a Postgres error at runtime, not a silent
    // miscount — but this catches it at push time instead of in a consumer's ship.
    assert.ok(!/GROUP BY[^`]*\baudit_mode\b/.test(src),
      'a GROUP BY on the raw audit_mode contradicts an effective_mode projection');

    // The interpolation must stay out of FROM/ORDER BY, or the static fence scan in
    // cross-skill-unlocked-scope.test.mjs reads a placeholder and goes green over it.
    //
    // Scanned with COMMENT LINES STRIPPED. The first version of this assertion matched
    // the module's own prose — two comments that quote the `FROM ${view}` anti-pattern
    // in order to warn against it — and reported the warning as the violation. That is
    // the docstring-reads-as-code false positive this repo keeps hitting, reproduced
    // inside the guard written to prevent it. Caught because the assertion failed on a
    // change that could not have introduced it.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/FROM\s*\$\{/.test(code), 'view names stay literal — the fence scan reads them');
    assert.ok(!/ORDER BY\s*\$\{/.test(code), 'ORDER BY stays literal for the same reason');
  });
});
