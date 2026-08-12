/**
 * @fileoverview Misc registry commands (docs/plans/cross-skill-command-registry.md
 * — Cluster A template trio; grows in Phases 4–5).
 *
 * Handlers here are BEHAVIOUR-PRESERVING moves of the legacy cross-skill.mjs
 * handlers: same envelope fields, same refusal codes, same ordering of
 * store-touching operations. All persistence goes through `ctx.deps` (the
 * store port) — never a direct store import; the conformance suite enforces
 * that via the import graph.
 */

/**
 * `whoami` — repo/cloud diagnostics. Moved verbatim from `cmdWhoami`.
 *
 * `cloud:'none'` in the registry: this command REPORTS cloud state as data,
 * so it owns its own `initLearningStore()` + `isCloudEnabled()` reads via
 * the port rather than being gated by the dispatcher.
 */
export async function whoamiCmd(ctx) {
  await ctx.deps.initLearningStore();
  return {
    ok: true,
    cloud: await ctx.deps.isCloudEnabled(),
    commitSha: ctx.git.commitSha(),
    branch: ctx.git.branch(),
  };
}
