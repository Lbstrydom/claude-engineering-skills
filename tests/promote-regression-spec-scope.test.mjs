/**
 * @fileoverview Cross-tenant write fence on regression-spec PROMOTION.
 *
 * Guards the audit finding "Tenant/owner scoping": `cmdPromoteRegressionSpec`
 * mutated a `regression_specs` row using only `p.specId`, and the store's UPDATE
 * read `WHERE id = $4 AND source_kind = 'persona-consistency-candidate'` with no
 * `repo_id` predicate. `specId` is a globally-unique uuid, so a caller holding an
 * id from ANY repository could flip that repository's candidate row to `locked`.
 *
 * Candidate CREATION (`cmdRecordRegressionCandidate`) and candidate LISTING were
 * both already repo-scoped — promotion was the one mutation in the trio that was
 * not, which is why it survived the review that added the other two.
 *
 * These assertions run without a database: the argument checks deliberately
 * precede `isCloudEnabled()`, so a missing scope is refused on its own merits
 * rather than depending on a live DSN.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promoteRegressionSpec } from '../scripts/lib/store/plans-ship.mjs';

const SPEC_ID = '33333333-3333-4333-8333-333333333333';
const REPO_ID = '44444444-4444-4444-8444-444444444444';
const VALID = { specPath: 'tests/e2e/x.spec.js', promotedBy: 'ship' };

describe('promoteRegressionSpec — repo scope is mandatory', () => {
  it('refuses a promotion carrying no repoId', async () => {
    const res = await promoteRegressionSpec(SPEC_ID, { ...VALID });
    assert.equal(res.ok, false);
    assert.equal(res.rowsAffected, 0);
    assert.equal(res.reason, 'repo-scope-required',
      'an unscoped promotion must be refused for THAT reason, not incidentally by a missing store');
  });

  it('refuses an empty-string repoId (a falsy scope is not a scope)', async () => {
    for (const repoId of ['', null, undefined]) {
      const res = await promoteRegressionSpec(SPEC_ID, { ...VALID, repoId });
      assert.equal(res.reason, 'repo-scope-required', `repoId=${JSON.stringify(repoId)} must not pass the fence`);
    }
  });

  // Vacuous-pass guard: every assertion above would hold for a function that
  // refuses everything. A scoped call must get PAST the fence — here it reaches
  // the environment check, which is the next gate, proving the fence let it by.
  it('a scoped promotion passes the fence and proceeds to the next gate (negative control)', async () => {
    const res = await promoteRegressionSpec(SPEC_ID, { ...VALID, repoId: REPO_ID });
    assert.notEqual(res.reason, 'repo-scope-required',
      'a promotion carrying a repoId must not be refused by the scope fence');
    assert.notEqual(res.reason, 'bad-input');
  });

  it('still refuses genuinely malformed input, scope or not', async () => {
    const res = await promoteRegressionSpec(SPEC_ID, { promotedBy: 'ship', repoId: REPO_ID });
    assert.equal(res.reason, 'bad-input');
  });
});

describe('promoteRegressionSpec — the SQL carries the predicate, not just the guard', () => {
  // The guard above refuses a MISSING scope. This asserts the supplied scope is
  // actually applied to the row selection — a fence that validates an argument
  // it then drops on the floor is the failure mode worth naming separately.
  it('the UPDATE filters on repo_id', () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL('../scripts/lib/store/plans-ship.mjs', import.meta.url)), 'utf-8');
    const stmt = src.slice(src.indexOf('UPDATE regression_specs'));
    const where = stmt.slice(0, stmt.indexOf('`', 1));
    assert.match(where, /AND repo_id = \$\d/,
      'the promotion UPDATE must restrict by repo_id, or the caller-side check is decorative');
    assert.match(where, /source_kind = 'persona-consistency-candidate'/,
      'and it must still only promote candidates (vacuous-pass guard on the slice above)');
  });
});
