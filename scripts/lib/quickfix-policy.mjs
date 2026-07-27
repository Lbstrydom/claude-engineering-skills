/**
 * @fileoverview Validated env-var parsing for the quickfix skip policy
 * (`LEARNING_QUICKFIX_SKIP_THRESHOLD` / `LEARNING_QUICKFIX_MIN_HITS`) —
 * shared by the two independent consumers that each parsed these same
 * two env vars with an unvalidated `parseFloat`/`parseInt` (round-1
 * code-audit finding H3, docs/plans/refactor-failure-contract.md): the
 * async cloud-rebuild path (`quickfix-stats.mjs`) and the synchronous
 * hot-path pattern matcher (`quickfix-patterns.mjs`). Consolidating here
 * closes both the individual bugs (a partial numeric parse like
 * `parseFloat('0.2junk') === 0.2` was silently accepted as clean) and the
 * cross-file consistency gap (fixing only one copy would leave the same
 * env var interpreted differently by two live learning-policy paths for
 * the same repo).
 *
 * Zero-dependency, pure module — no `dotenv/config`, no `fs`, no cloud-store
 * import — deliberately importable from `quickfix-patterns.mjs`'s
 * synchronous Edit/Write hot path.
 *
 * Lives at `scripts/lib/quickfix-policy.mjs` — a domain-neutral sibling
 * location, not under `scripts/lib/learning/` — so neither of its two
 * consumers (`learning-store`'s quickfix-stats.mjs, `claude-hooks`'s
 * quickfix-patterns.mjs) appears to "own" a module the other depends on
 * (code-audit round-1 finding 7eb839d1, compromise).
 *
 * @module scripts/lib/quickfix-policy
 */

export const QUICKFIX_SKIP_THRESHOLD_DEFAULT = 0.20;
export const QUICKFIX_MIN_HITS_DEFAULT = 10;

/**
 * Validate a raw `LEARNING_QUICKFIX_SKIP_THRESHOLD` value. An unset env var
 * silently falls back (normal, not warning-worthy). Any other invalid case
 * (blank/whitespace, non-finite, or out of the acceptance-rate's own
 * `[0,1]` range) emits one stderr line naming the rejected value and falls
 * back too — `parseFloat` would otherwise silently accept a partial parse
 * (`parseFloat('0.2junk') === 0.2`) as if it were a clean, deliberate value.
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
export function parseValidatedThreshold(raw, fallback) {
  if (raw === undefined) return fallback;
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (trimmed === '') {
    process.stderr.write(`[quickfix-policy] LEARNING_QUICKFIX_SKIP_THRESHOLD is blank — using default ${fallback}\n`);
    return fallback;
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    process.stderr.write(`[quickfix-policy] LEARNING_QUICKFIX_SKIP_THRESHOLD=${JSON.stringify(raw)} is invalid (must be a number in [0,1]) — using default ${fallback}\n`);
    return fallback;
  }
  return n;
}

/**
 * Validate a raw `LEARNING_QUICKFIX_MIN_HITS` value. Same shape as
 * {@link parseValidatedThreshold}, additionally requiring an integer >= 1
 * — `parseInt('1.5', 10)` would otherwise silently truncate to `1` rather
 * than rejecting the malformed input, and a `MIN_HITS` of `0`/negative
 * defeats this policy's own documented intent ("single-digit hits never
 * trigger a skip").
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
export function parseValidatedMinHits(raw, fallback) {
  if (raw === undefined) return fallback;
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (trimmed === '') {
    process.stderr.write(`[quickfix-policy] LEARNING_QUICKFIX_MIN_HITS is blank — using default ${fallback}\n`);
    return fallback;
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    process.stderr.write(`[quickfix-policy] LEARNING_QUICKFIX_MIN_HITS=${JSON.stringify(raw)} is invalid (must be a positive integer) — using default ${fallback}\n`);
    return fallback;
  }
  return n;
}
