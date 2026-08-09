/**
 * @fileoverview The read→writer key contract: a view whose rows a skill tells
 * you to CLOSE must project every key the closing command requires.
 *
 * THE DEFECT THIS LOCKS (upstream 23544fca + da67a8c1, filed from a consumer
 * 2026-08-04). `/ship` Step 0.5e reads `unremediated_acceptances` and nudges the
 * operator to close each row. The only command that can close one,
 * `cross-skill.mjs final-review-record-fix`, hard-requires `--run-id` AND
 * `--fingerprint`. The view projected `audit_finding_id` and no fingerprint, so
 * every listed obligation was unclosable from what the read handed back — the
 * nudge grew a backlog it gave you no way to clear. Two consumer reports, one
 * root cause, one missing column (`20260808200000`).
 *
 * Why a TEST and not just the migration: the migration fixes today's instance.
 * The recurring shape is "a read and its writer disagree about the key", and
 * nothing mechanically held them together — the same shape as the repo-scoping
 * defect `cross-skill-unlocked-scope.test.mjs` locks, which also reached a
 * SECOND reader before anyone noticed. Adding a row here is the cost of adding
 * a close-this-row nudge.
 *
 * Asserted from COMMITTED source only (the schema fixture + the skill text), so
 * this runs with no database and cannot pass by talking to a store that happens
 * to be ahead of the migrations.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/expected-schema.json'), 'utf-8'));

/**
 * One row per "a skill reads this view and tells you to close its rows".
 *
 * `requires` is the closing command's mandatory flags, expressed as the view
 * columns that supply them. Keep it in step with the command's own BAD_INPUT
 * guard — for `final-review-record-fix` that is
 * `'--run-id <id> and --fingerprint <hash> are both required'`
 * (`scripts/cross-skill.mjs`, `cmdFinalReviewRecordFix`).
 */
const CLOSE_CONTRACTS = [
  {
    view: 'unremediated_acceptances',
    step: '/ship Step 0.5e',
    closer: 'final-review-record-fix',
    requires: ['audit_run_id', 'finding_fingerprint'],
  },
];

describe('view → writer key contract', () => {
  for (const c of CLOSE_CONTRACTS) {
    it(`${c.view} projects every key ${c.closer} requires`, () => {
      const view = SCHEMA.tables.find((t) => t.table_name === c.view);
      assert.ok(view, `${c.view} is absent from the schema fixture — regenerate with \`npm run db:local:regen\``);
      const columns = new Set(view.columns.map((col) => col.column_name));
      for (const key of c.requires) {
        assert.ok(
          columns.has(key),
          `${c.view} does not project "${key}", but ${c.step} tells the operator to close its rows with `
          + `\`${c.closer}\`, which requires it. The read hands back a key its writer cannot accept, so every `
          + `row is reported as an open obligation and none of them is closable. Add the column to the view in `
          + `a NEW migration (CREATE OR REPLACE VIEW can only APPEND).`,
        );
      }
    });
  }
});

describe('/ship Step 0.5e names a command that can actually close the rows', () => {
  const SKILL = fs.readFileSync(path.join(REPO_ROOT, 'skills/ship/SKILL.md'), 'utf-8');
  // Bound the assertion to the step, not the whole file: `finalize-outcomes` is
  // a real command and may legitimately be named elsewhere.
  const step = SKILL.slice(
    SKILL.indexOf('### 0.5e'),
    SKILL.indexOf('### 0.5g') > 0 ? SKILL.indexOf('### 0.5g') : undefined,
  );

  it('locates the step (guards against the slice silently matching nothing)', () => {
    assert.ok(step.length > 200, 'Step 0.5e not found in skills/ship/SKILL.md — the assertions below would be vacuous');
  });

  it('the printed remedy is the command that accepts the view\'s keys', () => {
    assert.match(step, /final-review-record-fix/,
      'Step 0.5e must name `final-review-record-fix` — the only command that can close an acceptance '
      + 'accepted in an earlier session.');
  });

  it('does NOT tell the operator to run finalize-outcomes on these rows', () => {
    // It needs one round's --ledger + --result. A finding accepted weeks ago in
    // a since-deleted run has neither, which is what made the old advice
    // unactionable for exactly the rows this step lists (upstream da67a8c1).
    const remedy = step.slice(step.indexOf('UNREMEDIATED ACCEPTANCES'));
    assert.doesNotMatch(remedy.slice(0, 600), /cross-skill\.mjs finalize-outcomes/,
      'the printed remedy must not be `finalize-outcomes` — it cannot close a finding from an earlier session');
  });
});
