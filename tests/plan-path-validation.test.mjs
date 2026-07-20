/**
 * @fileoverview Guard for the plan-path validator + DB status vocabulary.
 *
 * Tier 1 (deterministic seam) per the testing doctrine in AGENTS.md.
 *
 * Origin: a 2026-07-20 audit of the live store found three non-plans in
 * `plans` — the literal string `--help`, and two absolute session-scratchpad
 * paths under AppData/Temp. `plans` is the join target for
 * `audit_runs.plan_id`, so junk rows degrade every effectiveness query built
 * over it. These cases are the regression corpus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import { validatePlanPath } from '../scripts/lib/store/plans-ship.mjs';
import { PLAN_STATUS_VOCABULARY, DB_PLAN_STATUSES, toDbPlanStatus } from '../scripts/lib/status-vocabulary.mjs';

const REPO = process.platform === 'win32' ? 'C:\\GIT\\demo-repo' : '/git/demo-repo';

test('accepts a normal repo-relative plan path', () => {
  const r = validatePlanPath('docs/plans/local-dashboard.md', { repoRoot: REPO });
  assert.equal(r.ok, true);
  assert.equal(r.path, 'docs/plans/local-dashboard.md');
});

test('rejects the observed junk rows from the live store', () => {
  // The exact three values found in `plans` on 2026-07-20.
  const help = validatePlanPath('--help', { repoRoot: REPO });
  assert.equal(help.ok, false);
  assert.equal(help.reason, 'flag-like');

  for (const scratch of [
    'C:/Users/User/AppData/Local/Temp/claude/x/scratchpad/legacy-skill-cleanup-spec.md',
    'C:/Users/User/AppData/Local/Temp/claude/y/scratchpad/adhoc-audit-plan.md',
  ]) {
    const r = validatePlanPath(scratch, { repoRoot: REPO });
    assert.equal(r.ok, false, `expected rejection: ${scratch}`);
    assert.equal(r.reason, 'escapes-repo');
  }
});

test('rejects flag-like, non-markdown, empty, and escaping paths', () => {
  assert.equal(validatePlanPath('-o', { repoRoot: REPO }).reason, 'flag-like');
  assert.equal(validatePlanPath('docs/plans/notes.txt', { repoRoot: REPO }).reason, 'not-markdown');
  assert.equal(validatePlanPath('', { repoRoot: REPO }).reason, 'empty');
  assert.equal(validatePlanPath('   ', { repoRoot: REPO }).reason, 'empty');
  assert.equal(validatePlanPath(null, { repoRoot: REPO }).reason, 'empty');
  assert.equal(validatePlanPath('../outside/plan.md', { repoRoot: REPO }).reason, 'escapes-repo');
  // A traversal that climbs out and back under a SIBLING prefix must not pass
  // a naive startsWith check.
  assert.equal(
    validatePlanPath('../demo-repo-evil/plan.md', { repoRoot: REPO }).reason,
    'escapes-repo',
  );
});

test('normalises absolute in-repo paths to repo-relative POSIX', () => {
  // The idempotence hole: `plans` is unique on (repo_id, path), so the same
  // plan referenced absolutely and relatively must collapse to one key.
  const abs = path.join(REPO, 'docs', 'plans', 'x.md');
  const fromAbs = validatePlanPath(abs, { repoRoot: REPO });
  const fromRel = validatePlanPath('docs/plans/x.md', { repoRoot: REPO });
  assert.equal(fromAbs.ok, true);
  assert.equal(fromAbs.path, fromRel.path);
  assert.equal(fromAbs.path, 'docs/plans/x.md');
});

test('backslash input normalises to forward slashes', () => {
  const r = validatePlanPath('docs\\plans\\y.md', { repoRoot: REPO });
  assert.equal(r.ok, true);
  assert.equal(r.path, 'docs/plans/y.md');
});

if (process.platform === 'win32') {
  test('windows containment is case-insensitive on drive letter and dirs', () => {
    const r = validatePlanPath('c:\\git\\DEMO-repo\\docs\\plans\\z.md', { repoRoot: REPO });
    assert.equal(r.ok, true, 'a case-variant in-repo path must not read as an escape');
    assert.match(r.path, /z\.md$/);
  });
}

test('every markdown status spelling normalises into the DB vocabulary', () => {
  // The friction this closes: our own /plan skill instructs `In Progress`,
  // the CHECK constraint stores `in_progress`. A human typing what the docs
  // say must not be rejected over a casing convention.
  for (const token of [...PLAN_STATUS_VOCABULARY.terminal, ...PLAN_STATUS_VOCABULARY.active]) {
    assert.ok(DB_PLAN_STATUSES.includes(toDbPlanStatus(token)), `'${token}' must normalise`);
  }
  assert.equal(toDbPlanStatus('Complete'), 'complete');
  assert.equal(toDbPlanStatus('In Progress'), 'in_progress');
  assert.equal(toDbPlanStatus('  Superseded '), 'superseded');
});

test('DB status vocabulary is derived from the markdown vocabulary', () => {
  // Guards the drift that migration 20260718120000 exists to kill: one
  // vocabulary must not acquire a second hand-maintained definition.
  assert.deepEqual(
    [...DB_PLAN_STATUSES].sort(),
    ['abandoned', 'approved', 'complete', 'draft', 'in_progress', 'parked', 'superseded'],
  );
});

test('DB status vocabulary matches the live plans_status_check constraint', () => {
  // The list above previously CLAIMED to "match the live CHECK constraint
  // exactly" while nothing enforced it — a hand-maintained second definition
  // of the vocabulary, which is the very drift 20260718120000 exists to kill.
  // Read the constraint from the newest migration that defines it, so widening
  // the vocabulary without a migration (or vice versa) fails here.
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const defining = fs.readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .filter(f => /ADD CONSTRAINT plans_status_check/i.test(fs.readFileSync(new URL(f, dir), 'utf8')))
    .sort();
  assert.ok(defining.length > 0, 'no migration defines plans_status_check');

  const sql = fs.readFileSync(new URL(defining[defining.length - 1], dir), 'utf8');
  const m = sql.match(/ADD CONSTRAINT plans_status_check\s+CHECK\s*\(\s*status IN \(([^)]*)\)/i);
  assert.ok(m, `could not parse the CHECK in ${defining[defining.length - 1]}`);
  const constraintValues = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort();

  assert.deepEqual(
    [...DB_PLAN_STATUSES].sort(),
    constraintValues,
    `plan-status.mjs and ${defining[defining.length - 1]} disagree — a status valid in `
    + 'markdown but rejected by the store (or the reverse) is silent until a write fails',
  );
});
