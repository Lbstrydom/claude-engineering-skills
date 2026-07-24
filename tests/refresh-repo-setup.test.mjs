/**
 * @fileoverview Tier-1 tests for `scripts/symbol-index/refresh-repo-setup.mjs`
 * — extracted from `refresh.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md
 * Phase 4).
 *
 * `assertRegisteredRepo` is the directly, deterministically unit-testable
 * surface: this repo's own established convention
 * (tests/legacy-production-audit-hardening.test.mjs:361-365's own comment)
 * is that plain ESM named function exports — which is what `upsertRepoByUuid`
 * is — cannot be `t.mock.method`'d (only object methods/class prototypes
 * can), so "make a real upsertRepoByUuid return null" is not achievable with
 * this repo's tooling. The DB-touching `resolveAndRegisterRepo` wrapper stays
 * covered the way it always has been — indirectly, via whatever
 * integration/CLI-level coverage already exercises a real `main()` run; no
 * new claim is made about testing its null-return branch end-to-end (it was
 * untested before this plan too — not a regression).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertRegisteredRepo } from '../scripts/symbol-index/refresh-repo-setup.mjs';
import { RepoRegistrationError } from '../scripts/symbol-index/refresh-errors.mjs';

describe('assertRegisteredRepo', () => {
  it('throws RepoRegistrationError with the exact original message when repo is null', () => {
    assert.throws(
      () => assertRegisteredRepo(null),
      (err) => {
        assert.ok(err instanceof RepoRegistrationError);
        assert.equal(err.message, 'upsertRepoByUuid returned null — aborting');
        return true;
      },
    );
  });

  it('throws the same way for undefined (any falsy upsert result)', () => {
    assert.throws(() => assertRegisteredRepo(undefined), RepoRegistrationError);
  });

  it('returns a truthy repo object unchanged', () => {
    const repo = { id: 'repo-123', name: 'x' };
    assert.equal(assertRegisteredRepo(repo), repo);
  });
});
