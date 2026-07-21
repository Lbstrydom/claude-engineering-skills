/**
 * @fileoverview Pure helpers for the strengthen-only main-branch protection
 * tool (scripts/ensure-branch-protection.mjs). No network here — the CLI does
 * the `gh api` I/O; these functions transform ruleset JSON so they are unit-
 * testable without GitHub.
 *
 * "Strengthen-only" = set `strict_required_status_checks_policy: true`
 * ("Require branches to be up to date before merging") on an EXISTING
 * required_status_checks ruleset rule, and NEVER create protection where none
 * exists. A repo with no PR/ratchet flow (a direct-push consumer) has nothing
 * to strengthen and is left untouched. Rationale: the stale-baseline ratchet
 * failure (a branch cut before a main-derived baseline landed fails the
 * ratchet on phantom findings) only exists where a ratchet exists; imposing
 * PR-protection on a direct-push repo is a workflow change, not a safety fix.
 * See docs/runbooks/consumer-adoption.md §"Main-branch protection".
 */

/**
 * Parse `{owner, name, slug}` from a git remote URL (https or ssh, optional
 * `.git` suffix). Returns null if it is not a recognisable GitHub remote.
 * @param {string} remoteUrl
 * @returns {{owner:string,name:string,slug:string}|null}
 */
export function parseOriginRepo(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== 'string') return null;
  const s = remoteUrl.trim().replace(/\.git$/i, '');
  // git@github.com:owner/name | https://github.com/owner/name | ssh://git@github.com/owner/name
  const m = s.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+)$/);
  if (!m) return null;
  return { owner: m[1], name: m[2], slug: `${m[1]}/${m[2]}` };
}

/** Does this ruleset carry a required_status_checks rule at all? */
export function hasStatusCheckRatchet(ruleset) {
  return (ruleset?.rules || []).some((r) => r.type === 'required_status_checks');
}

/**
 * Given a single ruleset object (from `GET .../rulesets/:id`), return
 * `{ changed, body }` where `body` is the minimal PUT payload with
 * `strict_required_status_checks_policy` flipped to true on every
 * required_status_checks rule that had it non-true. `changed` is false when
 * nothing needed changing (already strict, or no such rule) — the caller then
 * skips the PUT, keeping the operation idempotent.
 * @param {object} ruleset
 * @returns {{changed:boolean, body:object}}
 */
export function strengthenRuleset(ruleset) {
  let changed = false;
  const rules = (ruleset?.rules || []).map((rule) => {
    if (
      rule.type === 'required_status_checks' &&
      rule.parameters &&
      rule.parameters.strict_required_status_checks_policy !== true
    ) {
      changed = true;
      return {
        ...rule,
        parameters: { ...rule.parameters, strict_required_status_checks_policy: true },
      };
    }
    return rule;
  });
  // PUT accepts only the mutable fields; id/timestamps/_links are read-only.
  const body = {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    bypass_actors: ruleset.bypass_actors || [],
    conditions: ruleset.conditions,
    rules,
  };
  return { changed, body };
}

export const _internals = { parseOriginRepo, hasStatusCheckRatchet, strengthenRuleset };
