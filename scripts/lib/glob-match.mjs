/**
 * Minimal glob matcher supporting `**`, `*`, `?` (no brace expansion).
 *
 * Lives in a domain-neutral module because two unrelated subsystems now make
 * decisions with it: `visual/changed-scope.mjs` (gate eligibility) and
 * `security/predicates.mjs` (the `path-scope` routing predicate). Before this
 * extraction the security predicate imported it from the visual subsystem —
 * so a change made for visual diff scoping could silently alter security path
 * routing, with the dependency direction implying the opposite.
 *
 * Anchored with `^…$` and matched against **repo-relative, forward-slashed**
 * paths. Passing an absolute path is a silent no-match — see the `path-scope`
 * caller, which converts via `path.relative(repoRoot, …)` first.
 *
 * **Known semantic gap — `**` does NOT collapse an empty directory segment.**
 * `src/**\/*.js` matches `src/a/b.js` but NOT `src/b.js`, because `**` becomes
 * `.*` and the literal `/` still has to match. Most glob dialects (and
 * `audit/deferral-classifier.mjs`'s separate matcher) treat `**\/` as
 * zero-or-more segments instead. This behaviour is preserved verbatim from
 * `visual/changed-scope.mjs` so the extraction changed nothing; reconciling the
 * two dialects would alter visual gate-eligibility and deferral classification,
 * which is a deliberate change, not a refactor. Until then, write
 * `tests/**` rather than `tests/**\/*.js` in a `.security-triage.json`.
 */
// @duplicate-justification: target=scripts/lib/audit/deferral-classifier.mjs:globMatch reason=the two matchers implement DIFFERENT `**/` semantics (zero-or-more segments vs literal-slash); merging them silently changes visual gate eligibility and deferral classification, so reconciliation is a separate deliberate change rather than a de-duplication
export function globMatch(glob, filePath) {
  const g = String(glob).replace(/\\/g, '/');
  const p = String(filePath).replace(/\\/g, '/');
  const DSTAR = '\x00'; // sentinel for ** so the single-* pass doesn't touch it
  const body = g
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*/g, DSTAR)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(DSTAR).join('.*');
  return new RegExp(`^${body}$`).test(p);
}
