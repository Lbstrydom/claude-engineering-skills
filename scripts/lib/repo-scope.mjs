/**
 * @fileoverview Repo-scope resolution — the `repo_uuid` → `audit_repos.id` translation.
 *
 * **The bug this exists to prevent.** There are TWO repo identifiers and they are
 * different columns of the same row: `audit_repos.id` (v4 — what the cross-skill views
 * key on) and `repo_uuid` (v5 — the arch-memory identity). `resolveRepoIdentityQuiet`
 * returned the **uuid** while three call sites bound it to a variable named `repoId` and
 * queried on it. Those queries match nothing, and the command reports an authoritative
 * empty result for a repo that was never queried — the same believable false zero that
 * cost a real mis-triage on 2026-07-30.
 *
 * Dependencies are INJECTED so the four outcome variants are unit-testable with a stub
 * and no database. A source-text assertion that "the translation is called" cannot
 * establish that the translated id reaches the query, that `unknown-repo` suppresses it,
 * or that a lookup failure fails closed — which is why this is a function and not a
 * convention.
 *
 * Plan: docs/plans/layering-and-mutation-contracts.md (C1).
 *
 * @module scripts/lib/repo-scope
 */

/**
 * @typedef {{kind: 'scoped', repoId: string}
 *   | {kind: 'no-identity'}
 *   | {kind: 'unknown-repo', repoUuid: string}
 *   | {kind: 'lookup-failed', repoUuid: string, error: string}} RepoScope
 */

/**
 * Resolve the caller's repo scope.
 *
 * Variants, and why each is distinct:
 * - `scoped` — uuid resolved AND a row exists. The only variant that may run a scoped query.
 * - `no-identity` — not a git checkout / no ambient identity. Callers proceed **unscoped,
 *   exactly as before**: this is a rename, not a behaviour change, so it must not newly
 *   fail a command that works today.
 * - `unknown-repo` — a uuid resolved but matches no `audit_repos` row. Distinct from
 *   `no-identity` because an empty result here is NOT a clean zero and must never render
 *   as one.
 * - `lookup-failed` — the lookup threw (transient DB). Fails closed; never silently
 *   downgraded to an unscoped query, which would turn an outage into a wrong answer.
 *   `{strict: true}` is what makes this distinguishable from not-found.
 *
 * @param {{
 *   resolveRepoUuid: () => Promise<string|null>,
 *   getRepoIdByUuid: (uuid: string, opts?: {strict?: boolean}) => Promise<string|null>,
 *   explicitRepoId?: string|null,
 * }} deps
 * @returns {Promise<RepoScope>}
 */
export async function resolveRepoScope({ resolveRepoUuid, getRepoIdByUuid, explicitRepoId = null }) {
  // An explicit --repo-id is authoritative and already a v4 id; no translation needed.
  if (explicitRepoId) return { kind: 'scoped', repoId: explicitRepoId };

  let repoUuid = null;
  try { repoUuid = await resolveRepoUuid(); } catch { repoUuid = null; }
  if (!repoUuid) return { kind: 'no-identity' };

  let resolved;
  try {
    resolved = await getRepoIdByUuid(repoUuid, { strict: true });
  } catch (err) {
    return { kind: 'lookup-failed', repoUuid, error: err?.message ?? String(err) };
  }
  if (!resolved) return { kind: 'unknown-repo', repoUuid };

  // `getRepoIdByUuid` returns the audit_repos ROW — `{id, name, repo_uuid,
  // activeRefreshId, activeEmbeddingModel, activeEmbeddingDim}` — not a bare
  // id, despite the name. Returning it whole made `scope.repoId` an OBJECT,
  // which callers bind straight into `WHERE repo_id = $1`:
  //
  //   invalid input syntax for type uuid: "{"id":"22865de8-…","name":"…"}"
  //
  // That killed `persona-outcomes summary` (and with it /ship's Step 0.5a UX
  // gate) in a consumer repo on 2026-08-01. It survived because the unit test
  // stubbed this resolver as `async () => 'id-v4'` — a bare string the real
  // implementation never returns, so the fixture was more generous than
  // reality and certified a shape that could not occur.
  //
  // A string is still accepted: injected/test resolvers legitimately return
  // one, and narrowing to objects only would break them.
  const repoId = typeof resolved === 'string' ? resolved : (resolved.id ?? null);
  if (!repoId) return { kind: 'unknown-repo', repoUuid };
  return { kind: 'scoped', repoId };
}
