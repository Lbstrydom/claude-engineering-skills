/**
 * @fileoverview `deepMerge` — the co-owned-JSON merge used when syncing config
 * files into a consumer repo, extracted so its behaviour can be asserted.
 *
 * Extracted verbatim from `sync-to-repos.mjs` (2026-08-13) by
 * `docs/plans/cross-agent-delivery-parity.md` Phase 0. It was a private,
 * non-exported function there, so nothing could test it without reimplementing
 * it — and a second spelling of a merge rule is exactly the duplication that
 * lets two copies drift apart unnoticed. `sync-to-repos.mjs` now imports this
 * module; `tests/mcp-parity.test.mjs` imports the same one.
 *
 * **The contract is LEAF-PATH authority, and it is narrower than it looks.**
 * Two drafts of the plan above got this wrong in opposite directions before it
 * was settled by executing the function rather than reading it:
 *
 *   - a source **leaf** (scalar or ARRAY) is authoritative at its path —
 *     arrays are replaced wholesale, never concatenated;
 *   - a source **plain object** is merged RECURSIVELY, not replaced;
 *   - a consumer-only path at **any depth** survives.
 *
 * So a declared key whose value is an object is NOT authoritative: given
 * `ours.env = {A:1}` and `consumer.env = {B:2}`, the merged `env` is the UNION
 * `{B:2, A:1}`, not `ours.env`. That is deliberate — these files are co-owned,
 * and preserving a consumer's local additions is the whole reason the sync
 * merges instead of overwriting.
 *
 * @module scripts/lib/json-merge
 */

/**
 * Deep merge two plain objects. Source keys overwrite target keys at every
 * level. Arrays are replaced (not concatenated). Non-object values use source.
 * Used to safely sync JSON config files without destroying local additions.
 *
 * @param {Record<string, unknown>} target — the consumer's existing object
 * @param {Record<string, unknown>} source — ours; wins at every leaf it declares
 * @returns {Record<string, unknown>} a new object; neither input is mutated
 */
export function deepMerge(target, source) {
  const result = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)
        && typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}
