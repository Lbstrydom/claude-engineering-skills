/**
 * @fileoverview Mode × failure-state matrix for the ONE scope resolver
 * (docs/plans/cross-skill-command-registry.md D3/§9).
 *
 * Each cell asserts the discriminated KIND — the F17 regression cell
 * (lookup-throw must be `error`, never `unresolved`/unknown) is the reason
 * this matrix exists: the fix for F4 reintroduced F7's failure-collapse
 * inside its own new resolver, and only a cell-by-cell matrix makes that
 * class of regression loud.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCommandScope } from '../scripts/lib/cross-skill/scope.mjs';

const okDeps = (over = {}) => ({
  isCloudEnabled: async () => true,
  getRepoIdByName: async () => 'row-by-name',
  getRepoIdByUuid: async () => ({ id: 'row-by-uuid', name: 'o/r' }),
  listRepoIds: async () => ['row-a', 'row-by-name'],
  resolveRepoForStoreResult: async () => ({ kind: 'resolved', repoRowId: 'row-ambient', repoUuid: 'u', name: 'o/r' }),
  ...over,
});

const THROWING = async () => { throw new Error('connection refused'); };

describe("scope 'none'", () => {
  it('resolves to kind none without touching the store', async () => {
    const s = await resolveCommandScope('none', {}, {});
    assert.equal(s.kind, 'none');
  });
});

describe("scope 'ambient-ok' (the writers' chain — legacy resolveRepoId)", () => {
  it('explicit repoId wins verbatim', async () => {
    const s = await resolveCommandScope('ambient-ok', { explicitRepoId: 'given' }, okDeps());
    assert.deepEqual(s, { kind: 'scoped', repoId: 'given' });
  });
  it('explicit repoUuid resolves strictly', async () => {
    const s = await resolveCommandScope('ambient-ok', { explicitRepoUuid: 'u1' }, okDeps());
    assert.deepEqual(s, { kind: 'scoped', repoId: 'row-by-uuid' });
  });
  it('UNKNOWN explicit repoUuid is an ERROR, never a null scope (F13)', async () => {
    const s = await resolveCommandScope('ambient-ok', { explicitRepoUuid: 'u1' },
      okDeps({ getRepoIdByUuid: async () => null }));
    assert.equal(s.kind, 'error');
    assert.equal(s.code, 'UNKNOWN_REPO');
  });
  it('THROWN repoUuid lookup is an ERROR, never not-found (F7 family)', async () => {
    const s = await resolveCommandScope('ambient-ok', { explicitRepoUuid: 'u1' },
      okDeps({ getRepoIdByUuid: THROWING }));
    assert.equal(s.kind, 'error');
    assert.equal(s.code, 'REPO_RESOLVE_FAILED');
  });
  it('ambient resolves', async () => {
    const s = await resolveCommandScope('ambient-ok', {}, okDeps());
    assert.deepEqual(s, { kind: 'scoped', repoId: 'row-ambient' });
  });
  it('ambient ERROR fails closed — the F7 cell', async () => {
    const s = await resolveCommandScope('ambient-ok', {},
      okDeps({ resolveRepoForStoreResult: async () => ({ kind: 'error', error: 'pool down' }) }));
    assert.equal(s.kind, 'error');
    assert.equal(s.code, 'REPO_RESOLVE_FAILED');
  });
  it('ambient THROW fails closed too', async () => {
    const s = await resolveCommandScope('ambient-ok', {},
      okDeps({ resolveRepoForStoreResult: THROWING }));
    assert.equal(s.kind, 'error');
  });
  it('cloud-off / no-identity are honest absences, not errors', async () => {
    const off = await resolveCommandScope('ambient-ok', {},
      okDeps({ resolveRepoForStoreResult: async () => ({ kind: 'cloud-off' }) }));
    assert.deepEqual(off, { kind: 'unresolved', reason: 'cloud-off' });
    const none = await resolveCommandScope('ambient-ok', {},
      okDeps({ resolveRepoForStoreResult: async () => ({ kind: 'unresolved', repoUuid: 'u', name: 'n' }) }));
    assert.equal(none.kind, 'unresolved');
  });
});

describe("scope 'explicit-required' (--repo authoritative — legacy resolveRequestedRepoScope)", () => {
  it('an ABSENT repo name is a policy-level refusal, never getRepoIdByName(undefined) (CA-r6)', async () => {
    const s = await resolveCommandScope('explicit-required', {}, okDeps());
    assert.equal(s.kind, 'error');
    assert.equal(s.code, 'BAD_SCOPE_INPUT');
  });

  it('resolves the REQUESTED name, never the ambient checkout (F4/F10)', async () => {
    const s = await resolveCommandScope('explicit-required', { explicitRepoName: 'other/repo' }, okDeps());
    assert.deepEqual(s, { kind: 'scoped', repoId: 'row-by-name' });
  });
  it('explicit id and name that DISAGREE are a refusal, never a silent winner', async () => {
    const s = await resolveCommandScope('explicit-required',
      { explicitRepoName: 'o/r', explicitRepoId: 'different-row' }, okDeps());
    assert.equal(s.kind, 'error');
    assert.equal(s.code, 'REPO_SCOPE_CONFLICT');
  });
  it('unknown --repo is UNKNOWN_REPO even with a valid --repo-id (F11)', async () => {
    const s = await resolveCommandScope('explicit-required',
      { explicitRepoName: 'bogus/nope', explicitRepoId: 'row-a' },
      okDeps({ getRepoIdByName: async () => null }));
    assert.equal(s.kind, 'error');
    assert.equal(s.code, 'UNKNOWN_REPO');
  });
  it('THE F17 CELL: a thrown name lookup is REPO_LOOKUP_FAILED, never UNKNOWN_REPO', async () => {
    const s = await resolveCommandScope('explicit-required', { explicitRepoName: 'o/r' },
      okDeps({ getRepoIdByName: THROWING }));
    assert.equal(s.kind, 'error');
    assert.equal(s.code, 'REPO_LOOKUP_FAILED',
      'a store outage must never read as "your repo name is wrong" — that is F17, the regression a fix introduced');
  });
  it('cloud-off passes through as scoped-with-explicit (the documented cloud:false path)', async () => {
    const s = await resolveCommandScope('explicit-required', { explicitRepoName: 'o/r' },
      okDeps({ isCloudEnabled: async () => false }));
    assert.deepEqual(s, { kind: 'scoped', repoId: null });
  });
});

describe("scope 'global-optin' (--all-repos chain — legacy resolveShipNudgeScope)", () => {
  it('--all-repos + explicit scope is a refusal (Gemini G2-M)', async () => {
    const s = await resolveCommandScope('global-optin',
      { allRepos: true, explicitRepoId: 'row-a' }, okDeps());
    assert.equal(s.kind, 'error');
    assert.equal(s.code, 'CONFLICTING_SCOPE');
  });
  it('--all-repos alone is global, evaluated BEFORE ambient', async () => {
    // ambient would resolve here — the flag must still win (the original
    // resolveShipNudgeScope bug had the flag unreachable behind ambient).
    const s = await resolveCommandScope('global-optin', { allRepos: true }, okDeps());
    assert.deepEqual(s, { kind: 'global' });
  });
  it('a verified explicit repo-id scopes; an unknown one is an ERROR with "nothing was measured"', async () => {
    const ok = await resolveCommandScope('global-optin', { explicitRepoId: 'row-a' }, okDeps());
    assert.equal(ok.kind, 'scoped');
    const bad = await resolveCommandScope('global-optin', { explicitRepoId: 'not-a-row' },
      okDeps({ getRepoIdByUuid: async () => null }));
    assert.equal(bad.kind, 'error');
    assert.equal(bad.code, 'UNKNOWN_REPO_ID');
    assert.match(bad.message, /nothing was measured/);
  });
  it('an unverifiable repo-id (empty audit_repos read) is UNRESOLVED, never a zero', async () => {
    const s = await resolveCommandScope('global-optin', { explicitRepoId: 'row-a' },
      okDeps({ listRepoIds: async () => [] }));
    assert.deepEqual(s, { kind: 'unresolved', reason: 'repo-id-unverifiable' });
  });

  it('a THROWN audit_repos read is an ERROR naming the outage, not "unverifiable" (F17 doctrine, global mode)', async () => {
    const s = await resolveCommandScope('global-optin', { explicitRepoId: 'row-a' },
      okDeps({ listRepoIds: THROWING }));
    assert.equal(s.kind, 'error');
    assert.equal(s.code, 'REPO_LOOKUP_FAILED');
    const s2 = await resolveCommandScope('global-optin', { explicitRepoId: 'not-a-row' },
      okDeps({ getRepoIdByUuid: THROWING }));
    assert.equal(s2.kind, 'error');
    assert.equal(s2.code, 'REPO_LOOKUP_FAILED',
      'an outage during the uuid-translation fallback must not read as UNKNOWN_REPO_ID');
  });
  it('ambient unresolvable is unresolved (measured:false), not an error and not global', async () => {
    const s = await resolveCommandScope('global-optin', {},
      okDeps({ resolveRepoForStoreResult: async () => ({ kind: 'unresolved', repoUuid: 'u', name: 'n' }) }));
    assert.equal(s.kind, 'unresolved');
  });

  it('ambient OUTAGE is an ERROR, never folded into unresolvable (CA-r4 — the F17 doctrine, ambient branch)', async () => {
    const s = await resolveCommandScope('global-optin', {},
      okDeps({ resolveRepoForStoreResult: async () => ({ kind: 'error', error: 'pool down' }) }));
    assert.equal(s.kind, 'error');
    assert.equal(s.code, 'REPO_RESOLVE_FAILED');
    const s2 = await resolveCommandScope('global-optin', {},
      okDeps({ resolveRepoForStoreResult: THROWING }));
    assert.equal(s2.kind, 'error');
  });
});
