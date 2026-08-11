/**
 * @fileoverview `source_kind = 'unit-test'` — a regression lock for a fix with
 * no browser surface.
 *
 * Why the kind exists: `unlocked_fixes` counts a fix as unlocked unless a
 * `regression_specs` row exists, and every prior `source_kind` is authored by
 * /ux-lock or /persona-test — a Playwright spec driving a live URL. That made
 * the gate unsatisfiable for any fix without a UI (119 open obligations in a
 * repo with no frontend, most already covered by unit tests). It is also not a
 * CLI special case: /ux-lock has a documented bad record on React surfaces
 * (wine-cellar-app 2026-07, specs reverted), so the browser path is unreliable
 * even where it applies.
 *
 * What these tests actually guard is the HONESTY of the mechanism, not the
 * happy path. Closing 119 obligations by matching `primary_file` to a
 * same-named test would move the number while proving nothing, so the writer
 * refuses a missing path, a path outside the repo, and a missing description.
 * Those three refusals are the feature; the insert is incidental.
 *
 * @module tests/unit-test-lock-kind
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const fixture = JSON.parse(fs.readFileSync(
  path.resolve(import.meta.dirname, 'fixtures/expected-schema.json'), 'utf8'));

/** Constraint text for regression_specs, from the committed schema fixture. */
function constraintText(name) {
  const rows = fixture.constraints.filter((c) => (c.table_name === 'regression_specs' || c.table === 'regression_specs'));
  const hit = rows.find((c) => JSON.stringify(c).includes(name));
  return hit ? JSON.stringify(hit) : '';
}

describe('regression_specs accepts unit-test as a lock kind', () => {
  it('unit-test is in the source_kind allowlist', () => {
    const t = constraintText('regression_specs_source_kind_check');
    assert.ok(t, 'source_kind check constraint must exist in the schema fixture');
    assert.match(t, /unit-test/,
      'without this, a fix guarded by a unit test can never be recorded as locked');
  });

  it('the row shape requires spec_path, which a unit-test row always carries', () => {
    // Was: "unit-test sits in the spec_path-bearing branch, not the consistency
    // shape". The consistency branches are gone (migration 20260811150000
    // retired both persona-consistency kinds with the promotion path), so the
    // three-branch CHECK collapsed to the single predicate every surviving kind
    // already satisfied. The property under test is unchanged — a unit-test row
    // is legal precisely because it names a spec_path.
    const t = constraintText('regression_specs_row_shape_check');
    assert.match(t, /spec_path IS NOT NULL/);
  });

  it('the retired consistency kinds are gone from both constraints', () => {
    // The negative direction, asserted rather than assumed: a lingering
    // candidate branch would reference columns this migration dropped.
    for (const name of ['regression_specs_row_shape_check', 'regression_specs_source_kind_check']) {
      const t = constraintText(name);
      assert.doesNotMatch(t, /persona-consistency-candidate/, `${name} still names the candidate kind`);
      assert.doesNotMatch(t, /persona-consistency-locked/, `${name} still names the locked kind`);
    }
  });
});

describe('lock-with-test refusals (the anti-fake-check surface)', () => {
  const cli = fs.readFileSync(path.resolve(import.meta.dirname, '../scripts/cross-skill.mjs'), 'utf8');

  it('refuses a test path that does not exist', () => {
    assert.match(cli, /does not exist — a lock naming a missing file is a fake check/,
      'file existence is the one thing the CLI can actually verify; it must');
  });

  it('refuses a path resolving outside the repo', () => {
    assert.match(cli, /resolves outside the repo/,
      'a lock naming a file outside the repo is not evidence about this repo');
  });

  it('requires a description — an unexplained lock is an unverifiable claim', () => {
    assert.match(cli, /description is mandatory/);
  });

  it('the worksheet labels its suggestion as a heuristic, not a verdict', () => {
    // The suggestion maps primary_file's basename to tests/<base>.test.mjs.
    // Presenting that as established coverage is exactly the fake check the
    // refusals above exist to prevent, so the wording is load-bearing.
    assert.match(cli, /filename heuristic only/);
    assert.match(cli, /do NOT lock it to an unrelated file/);
  });

  it('emits pasteable commands with real values, never angle-bracket placeholders', () => {
    // PowerShell reserves `<`, so a bracketed example is unpasteable on the
    // platform this repo is developed on (bit twice before 2026-07-02). This
    // covers BOTH operator-facing surfaces — the worksheet and the usage error
    // a caller hits first — because the error is the one people paste from.
    assert.ok(!/--finding <|--test <|--description </.test(cli),
      'no lock-with-test surface may print <placeholder> flag syntax');
  });

  it('the usage error shows a concrete runnable example', () => {
    // Asserted on the source, which concatenates the message across string
    // literals — so match the parts, not one contiguous span.
    assert.match(cli, /Example: /);
    assert.match(cli, /lock-with-test --finding [0-9a-f]{8}-[0-9a-f-]{27}/,
      'a caller who gets the invocation wrong should be able to paste the fix');
  });
});
