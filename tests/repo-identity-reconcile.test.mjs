/**
 * @fileoverview `reconcileRepoIdentity` — one row may not name two repositories.
 *
 * Guards the audit finding "Conflicting repository identities":
 * `cmdRecordPersonaSession` filled only the MISSING identity field from ambient
 * resolution. A caller that supplied `repoName` but omitted `repoId` therefore
 * got the CALLER's name beside THIS checkout's id on one `persona_test_sessions`
 * row — and the two are used by different joins (`audit_effectiveness` joins
 * `repo_name = audit_repos.name`, everything else joins `repo_id`), so the row
 * was simultaneously attributed to two repositories depending on the reader.
 *
 * Extracted as a pure function so the decision is testable without a store —
 * the defect was in the merge rule, not in the resolver.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRepoIdentity } from '../scripts/lib/repo-scope.mjs';

const AMBIENT = { repoRowId: 'id-B', name: 'owner/repo-B' };

describe('reconcileRepoIdentity — refuses a split identity', () => {
  // The regression: this used to yield {repoName: 'owner/repo-A', repoId: 'id-B'}.
  it('refuses when the caller names one repo and the checkout is another', () => {
    const r = reconcileRepoIdentity({ repoName: 'owner/repo-A' }, AMBIENT);
    assert.equal(r.ok, false);
    assert.equal(r.conflict, 'name');
    assert.equal(r.supplied, 'owner/repo-A');
    assert.equal(r.ambient, 'owner/repo-B');
  });

  it('refuses the mirror case — a supplied id against a different ambient id', () => {
    const r = reconcileRepoIdentity({ repoId: 'id-A' }, AMBIENT);
    assert.equal(r.ok, false);
    assert.equal(r.conflict, 'id');
  });
});

describe('reconcileRepoIdentity — the legitimate cases still resolve', () => {
  // Vacuous-pass guards: a function that refused everything would satisfy the
  // block above, and the whole point is to keep filling gaps where it is safe.
  it('fills both fields from ambient identity when the caller supplied neither', () => {
    const r = reconcileRepoIdentity({}, AMBIENT);
    assert.deepEqual(r, { ok: true, repoId: 'id-B', repoName: 'owner/repo-B' });
  });

  it('fills the missing field when the supplied one AGREES with the checkout', () => {
    const r = reconcileRepoIdentity({ repoName: 'owner/repo-B' }, AMBIENT);
    assert.equal(r.ok, true);
    assert.equal(r.repoId, 'id-B', 'agreement is the case this fill exists for');
    assert.equal(r.repoName, 'owner/repo-B');
  });

  it('passes a fully-supplied identity through without consulting ambient', () => {
    const r = reconcileRepoIdentity({ repoId: 'id-A', repoName: 'owner/repo-A' }, null);
    assert.equal(r.ok, true);
    assert.equal(r.repoId, 'id-A');
    assert.equal(r.repoName, 'owner/repo-A');
  });

  it('leaves fields null rather than guessing when ambient identity is unresolvable', () => {
    const r = reconcileRepoIdentity({}, null);
    assert.deepEqual(r, { ok: true, repoId: null, repoName: null });
  });

  // A caller-supplied value must survive an unresolvable checkout — the refusal
  // is about contradiction, never about the mere presence of a supplied field.
  it('keeps a supplied name when ambient resolution failed', () => {
    const r = reconcileRepoIdentity({ repoName: 'owner/repo-A' }, null);
    assert.equal(r.ok, true);
    assert.equal(r.repoName, 'owner/repo-A');
    assert.equal(r.repoId, null);
  });
});
