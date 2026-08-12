/**
 * @fileoverview The ONE repo-scope resolver for registry commands
 * (docs/plans/cross-skill-command-registry.md D3).
 *
 * `cross-skill.mjs` grew FIVE scope resolvers, one per incident, and the fix
 * for one (F4) reintroduced another's failure-collapse (F7) inside its own
 * body — F17. This module replaces accretion with modes. Every mode returns
 * the same discriminated union, and the F17 lesson is structural here: a
 * thrown lookup is `kind:'error'`, never folded into `'unresolved'` or an
 * unknown-repo answer.
 *
 * Semantics are ported VERBATIM from the legacy resolvers they replace
 * (byte-compatibility D6 — migrated commands must refuse/degrade with the
 * same codes and messages):
 *   - 'ambient-ok'        ← `resolveRepoId(payload)`   (writers)
 *   - 'explicit-required' ← `resolveRequestedRepoScope` (--repo-documented)
 *   - 'global-optin'      ← `resolveShipNudgeScope`     (--all-repos chain)
 *
 * @returns discriminated union:
 *   {kind:'scoped', repoId: string|null, slug?: string|null}
 * | {kind:'global'}
 * | {kind:'none'}
 * | {kind:'unresolved', reason: string}
 * | {kind:'error', code: string, message: string, exitCode?: number}
 */

/**
 * @param {'none'|'ambient-ok'|'explicit-required'|'global-optin'} policy
 * @param {{
 *   explicitRepoId?: string|null,   // --repo-id flag or payload.repoId
 *   explicitRepoUuid?: string|null, // payload.repoUuid (ambient-ok writers)
 *   explicitRepoName?: string|null, // --repo flag (explicit-required)
 *   allRepos?: boolean,             // --all-repos (global-optin)
 * }} input
 * @param {object} deps - the store port (or a test stub)
 */
export async function resolveCommandScope(policy, input = {}, deps) {
  if (policy === 'none') return { kind: 'none' };
  if (policy === 'ambient-ok') return ambientOk(input, deps);
  if (policy === 'explicit-required') return explicitRequired(input, deps);
  if (policy === 'global-optin') return globalOptin(input, deps);
  return { kind: 'error', code: 'BAD_SCOPE_POLICY', message: `unknown scope policy "${policy}"` };
}

/** `resolveRepoId(payload)` semantics — the writers' chain. */
async function ambientOk({ explicitRepoId, explicitRepoUuid }, deps) {
  if (explicitRepoId) return { kind: 'scoped', repoId: explicitRepoId };
  if (explicitRepoUuid) {
    let repo;
    try {
      repo = await deps.getRepoIdByUuid(explicitRepoUuid, { strict: true });
    } catch (err) {
      return { kind: 'error', code: 'REPO_RESOLVE_FAILED', exitCode: 1,
        message: `repoUuid ${explicitRepoUuid} lookup failed (transient DB error) — refusing an unscoped write rather than silently dropping repo scope: ${err.message}` };
    }
    if (!repo?.id) {
      return { kind: 'error', code: 'UNKNOWN_REPO', exitCode: 1,
        message: `repoUuid ${explicitRepoUuid} does not resolve to any audit_repos row — refusing to write an unscoped row `
          + 'for an explicitly named repository. It is NOT "no repo scope"; the identity you supplied is unknown.' };
    }
    return { kind: 'scoped', repoId: repo.id };
  }
  const ref = await deps.resolveRepoForStoreResult({}).catch(
    (err) => ({ kind: 'error', error: err?.message ?? String(err) }),
  );
  if (ref.kind === 'error') {
    return { kind: 'error', code: 'REPO_RESOLVE_FAILED', exitCode: 1,
      message: `repo identity lookup failed (${ref.error}) — refusing an unscoped write rather than silently dropping repo scope. `
        + 'This is a transient store failure, NOT a repo without an identity; retry once the store is reachable.' };
  }
  if (ref.kind === 'resolved') return { kind: 'scoped', repoId: ref.repoRowId };
  // 'cloud-off' / 'unresolved' are genuine absences — the cross-skill tables
  // accept a NULL repo_id, and callers that require a scope check for it.
  return { kind: 'unresolved', reason: ref.kind === 'cloud-off' ? 'cloud-off' : 'repo-identity-unresolvable' };
}

/** `resolveRequestedRepoScope(repoName)` semantics — `--repo` is authoritative. */
async function explicitRequired({ explicitRepoId, explicitRepoName }, deps) {
  // A policy that means "the caller NAMES the repo" is incoherent without a
  // name — refuse at the policy level rather than passing `undefined` into
  // `getRepoIdByName` (audit CA-r6: current callers all validate the name
  // first, but this resolver is a public seam for later cohorts, and
  // `getRepoIdByName(undefined)` would surface as a store-shaped error for
  // what is an input defect).
  if (!explicitRepoName) {
    return { kind: 'error', code: 'BAD_SCOPE_INPUT',
      message: "scope policy 'explicit-required' needs a repo name (--repo) — the handler must validate and pass it" };
  }
  // Cloud-off resolves nothing by name; the callers' documented `cloud:false`
  // path reports it — classified as scoped(-with-null) to preserve behaviour.
  if (!await deps.isCloudEnabled()) return { kind: 'scoped', repoId: explicitRepoId || null };

  let byName;
  try {
    byName = await deps.getRepoIdByName(explicitRepoName);
  } catch (err) {
    return { kind: 'error', code: 'REPO_LOOKUP_FAILED',
      message: `could not resolve repo "${explicitRepoName}" (${err.message}) — the store was unreachable, `
        + 'so this is NOT an unknown repo and NOT an empty result; nothing was measured.' };
  }
  if (explicitRepoId && byName && explicitRepoId !== byName) {
    return { kind: 'error', code: 'REPO_SCOPE_CONFLICT',
      message: `--repo "${explicitRepoName}" resolves to ${byName} but --repo-id says ${explicitRepoId} — `
        + 'these name different repositories; pass only one.' };
  }
  if (!byName) {
    return { kind: 'error', code: 'UNKNOWN_REPO',
      message: `unknown repo "${explicitRepoName}" — expected an owner/repo slug present in audit_repos. `
        + 'It is NOT an empty result; nothing was measured.' };
  }
  return { kind: 'scoped', repoId: explicitRepoId || byName };
}

/** `resolveShipNudgeScope()` semantics — explicit global before ambient. */
async function globalOptin({ explicitRepoId, explicitRepoName, allRepos }, deps) {
  if (allRepos && (explicitRepoId || explicitRepoName)) {
    return { kind: 'error', code: 'CONFLICTING_SCOPE',
      message: '--all-repos cannot be combined with --repo/--repo-id — pick one.' };
  }
  if (allRepos) return { kind: 'global' };

  if (explicitRepoId) {
    // A THROWN read is a store outage, not an empty table — the F17 doctrine
    // applies here exactly as in explicit-required (audit CA-r3: the legacy
    // `.catch(() => [])` collapsed the two; safe — both end in refusal — but
    // the refusal REASON lied about which fact refused). No golden constrains
    // this mode yet (global-optin commands migrate in Cluster C), so the
    // distinction is free to make now.
    let known;
    try {
      known = await deps.listRepoIds();
    } catch (err) {
      return { kind: 'error', code: 'REPO_LOOKUP_FAILED',
        message: `could not read audit_repos to verify --repo-id (${err.message}) — the store was unreachable; `
          + 'refusing to report a count that cannot be attributed. Nothing was measured.' };
    }
    if (known.length === 0) {
      return { kind: 'unresolved', reason: 'repo-id-unverifiable' };
    }
    if (known.includes(explicitRepoId)) return { kind: 'scoped', repoId: explicitRepoId };
    let viaUuid;
    try {
      viaUuid = await deps.getRepoIdByUuid(explicitRepoId);
    } catch (err) {
      return { kind: 'error', code: 'REPO_LOOKUP_FAILED',
        message: `could not resolve --repo-id "${explicitRepoId}" (${err.message}) — the store was unreachable; `
          + 'this is NOT an unknown id and NOT an empty backlog. Nothing was measured.' };
    }
    if (viaUuid?.id) return { kind: 'scoped', repoId: viaUuid.id, slug: viaUuid.name ?? null };
    return { kind: 'error', code: 'UNKNOWN_REPO_ID',
      message: `unknown --repo-id "${explicitRepoId}" — not an audit_repos.id nor a known repo_uuid. `
        + 'It is NOT an empty backlog; nothing was measured.' };
  }

  if (explicitRepoName) {
    let rowId;
    try {
      rowId = await deps.getRepoIdByName(explicitRepoName);
    } catch (err) {
      return { kind: 'error', code: 'REPO_LOOKUP_FAILED',
        message: `could not resolve repo "${explicitRepoName}" (${err.message}) — the store was unreachable. `
          + 'This is NOT an unknown repo and NOT an empty backlog; nothing was measured.' };
    }
    if (!rowId) {
      return { kind: 'error', code: 'UNKNOWN_REPO',
        message: `unknown repo "${explicitRepoName}" — expected an owner/repo slug present in audit_repos.` };
    }
    return { kind: 'scoped', repoId: rowId, slug: explicitRepoName };
  }

  const ref = await deps.resolveRepoForStoreResult({}).catch(
    (err) => ({ kind: 'error', error: err?.message ?? String(err) }),
  );
  if (ref.kind === 'resolved') return { kind: 'scoped', repoId: ref.repoRowId, slug: ref.name ?? null };
  // An ambient OUTAGE is an error, not "identity unresolvable" (audit CA-r4 —
  // the explicit-id branch got this distinction first; leaving the ambient
  // branch folding `error` into `unresolved` was the same lie one branch
  // over: the identity WAS resolvable, the store wasn't). Genuine absence
  // stays a NON-error (nothing was asserted) — but never a zero that reads
  // as "no obligations".
  if (ref.kind === 'error') {
    return { kind: 'error', code: 'REPO_RESOLVE_FAILED',
      message: `ambient repo identity lookup failed (${ref.error}) — the store was unreachable; `
        + 'nothing was measured (this is NOT an empty backlog and NOT a repo without identity).' };
  }
  return { kind: 'unresolved', reason: 'repo-identity-unresolvable' };
}
