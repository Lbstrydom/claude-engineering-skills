/**
 * @fileoverview `ResolvedScope` — the ONE way to obtain arms (D1).
 *
 * The two live incidents this closes both had the same shape: a function
 * accepted `arms`/`expectedScope` as independently-defaulted parameters, so a
 * caller could omit one, get a silently-substituted legacy value, and judge
 * real evidence against the wrong arm set. `ResolvedScope` makes that
 * unrepresentable by replacing "two loose parameters, each with its own
 * fallback" with "one value, returned only by the resolver, validated at
 * every boundary that consumes it."
 *
 * Pure — no I/O, no config read. The resolver (`resolveArms`/`scopeForEntry`
 * in `bakeoff-collect.mjs`) is the only thing that constructs one; this
 * module only defines the shape and the two assertions every consumer needs.
 *
 * Plan: docs/plans/comparison-tooling-consolidation.md D1/D1a/D1b/D2a.
 *
 * @module scripts/lib/bakeoff/scope
 */

/** Absent, malformed, or duplicate-arm-id scope — refused rather than guessed. */
export class UnresolvedScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnresolvedScopeError';
  }
}

/** A scope and the entry/entries it was asked to judge disagree about which
 *  campaign they belong to — the hole an id alone would leave open. */
export class ScopeMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScopeMismatchError';
  }
}

/**
 * Recursively freeze a plain object/array's own enumerable properties.
 * Bounded to the shapes real arm data actually has (declared arm objects,
 * their `args`/`redactionTerms` arrays, their `env` maps) — config parsed
 * from JSON, so no cycles and no exotic prototypes to worry about.
 *
 * Deliberately does NOT short-circuit on `Object.isFrozen(value)` (round-4
 * finding M4): a value can arrive SHALLOW-frozen — its own container frozen
 * by some other code path, its children not — and an early return there
 * skips exactly the children this function exists to reach. Verified: an
 * `Object.freeze({sub: {mutable: true}})` container passed in left `sub`
 * mutable under the short-circuited version. Freezing an already-frozen
 * object again is a harmless no-op, so there is no correctness reason to
 * skip it — only a (here, wrong) performance one.
 */
function deepFreezeValue(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const v of Object.values(value)) deepFreezeValue(v);
  return Object.freeze(value);
}

/**
 * Deep-freeze a `ResolvedScope` — record, `arms` array, each arm object, AND
 * each arm's own nested values (`args`, `redactionTerms`, `env`, …).
 * `Object.freeze` alone is shallow (the round-1 gate's own finding, R2/H1):
 * freezing the record leaves `arms` mutable, so a downstream reader could
 * rewrite the arm set it was handed — and freezing only the arm object
 * ONE level deep leaves the SAME hole one level further in (round-4 finding,
 * M10): `scope.arms[0].args.push(...)` still worked. Structural validation
 * is the caller's job (`createResolvedScope`); this only locks what is
 * already valid.
 */
function deepFreezeScope(scope) {
  for (const arm of scope.arms) deepFreezeValue(arm);
  Object.freeze(scope.arms);
  return Object.freeze(scope);
}

/**
 * Structural validation only — this does NOT prove the scope was derived
 * from config (a provenance brand was proposed for that and explicitly
 * WITHDRAWN as theatre: the only way to obtain arms *implicitly* was
 * `defaultArms()`, and D1 deletes it, so a hand-built scope literal requires
 * deliberately authoring an arm set, which is a different threat than the
 * one this module exists to close).
 *
 * @param {unknown} scope
 * @throws {UnresolvedScopeError}
 */
export function assertResolvedScope(scope) {
  if (!scope || typeof scope !== 'object') {
    throw new UnresolvedScopeError(
      `[bakeoff/scope] expected a ResolvedScope, got ${scope === null ? 'null' : typeof scope}. `
      + 'Every reader of arms must go through resolveArms()/scopeForEntry() — there is no other way to obtain one.',
    );
  }
  if (typeof scope.campaignId !== 'string' || scope.campaignId.length === 0) {
    throw new UnresolvedScopeError('[bakeoff/scope] ResolvedScope.campaignId must be a non-empty string');
  }
  if (!Array.isArray(scope.arms) || scope.arms.length === 0) {
    throw new UnresolvedScopeError('[bakeoff/scope] ResolvedScope.arms must be a non-empty array');
  }
  const seen = new Set();
  for (const arm of scope.arms) {
    if (!arm || typeof arm.id !== 'string' || arm.id.length === 0) {
      throw new UnresolvedScopeError('[bakeoff/scope] every arm in ResolvedScope.arms must have a non-empty string id');
    }
    if (seen.has(arm.id)) {
      throw new UnresolvedScopeError(`[bakeoff/scope] duplicate arm id "${arm.id}" in ResolvedScope.arms`);
    }
    seen.add(arm.id);
  }
  if (scope.expectedScope !== null && typeof scope.expectedScope !== 'string') {
    throw new UnresolvedScopeError('[bakeoff/scope] ResolvedScope.expectedScope must be a string or null');
  }
  if (scope.expectedConfigDigest !== undefined && scope.expectedConfigDigest !== null && typeof scope.expectedConfigDigest !== 'string') {
    throw new UnresolvedScopeError('[bakeoff/scope] ResolvedScope.expectedConfigDigest must be a string, null, or undefined');
  }
}

/**
 * Build a `ResolvedScope`. Validates structurally (`assertResolvedScope`) and
 * deep-freezes. The ONLY constructor — `resolveArms`/`scopeForEntry` call
 * this, nothing else may.
 *
 * `expectedConfigDigest` (§7 Phase 6) defaults to `null` — every EXISTING
 * 3-argument call site (a large existing test surface) stays byte-identical;
 * only `resolveArms`/`scopeForEntry` pass a real value.
 *
 * @param {string} campaignId
 * @param {object[]} arms
 * @param {string|null} expectedScope
 * @param {string|null} [expectedConfigDigest]
 * @returns {Readonly<{campaignId: string, arms: ReadonlyArray<object>, expectedScope: string|null, expectedConfigDigest: string|null}>}
 */
export function createResolvedScope(campaignId, arms, expectedScope, expectedConfigDigest = null) {
  const scope = { campaignId, arms, expectedScope, expectedConfigDigest };
  assertResolvedScope(scope);
  return deepFreezeScope(scope);
}

/**
 * Assert that an entry, or every entry in a set, does not ACTIVELY claim a
 * DIFFERENT campaign than `scope`. The structural backstop for a
 * programming error (D1b) — NOT the mechanism that handles legacy/
 * unjudgeable data.
 *
 * An entry with `campaignId` absent or `null` is NOT a mismatch — that is
 * D1a's separate "unjudgeable, predates campaign declaration" question,
 * answered upstream (`scopeForEntry`) before an entry ever reaches a reader
 * that assumes one cohort; this assertion only rejects an entry that names a
 * campaign and names the WRONG one. A synthetic fixture with no `campaignId`
 * field at all (every pure-logic unit test in this codebase) is therefore
 * unaffected by this check, on purpose: campaignId identity is a concern of
 * the real collected-log data path, not of testing `isComplete`'s epoch/
 * scope-binding arithmetic in isolation.
 *
 * @param {object|object[]} entryOrEntries
 * @param {{campaignId: string}} scope
 * @throws {ScopeMismatchError}
 */
export function assertScopeMatches(entryOrEntries, scope) {
  const entries = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];
  for (const entry of entries) {
    const claimed = entry?.campaignId;
    if (claimed != null && claimed !== scope.campaignId) {
      throw new ScopeMismatchError(
        `[bakeoff/scope] entry campaignId "${claimed}" does not match scope campaignId "${scope.campaignId}" — `
        + 'a heterogeneous entry set, or a scope built for the wrong campaign, was handed to a reader that assumes one cohort.',
      );
    }
  }
}
