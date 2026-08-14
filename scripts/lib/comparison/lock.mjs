/**
 * @fileoverview The comparison lock — canonical serialization + the
 * collection-time digest. Role-agnostic.
 *
 * Moved verbatim from `campaign/config.mjs` (2026-08-14). The input set, key
 * order and float precision are UNCHANGED by the move: `configDigest` over a
 * committed campaign must remain byte-identical, because the digest is cohort
 * identity — a changed byte silently splits one cohort into two and shrinks the
 * aggregate. That is asserted directly in tests/comparison-core.test.mjs
 * against the value recorded in .audit/bakeoff-log.jsonl during the 2026-08-14
 * live collection (8786fd5211cdf25c), not against a value this code produced.
 *
 * MEMBERSHIP RULE — the one thing to get right when extending this:
 * **an input belongs in the lock iff changing it would make already-collected
 * evidence mean something different.** Not "iff changing it changes a number".
 * `targetN`, `calibration`, `decisionRule`, the matcher version/threshold and
 * `maxAttemptsPerArm` are all analysis-time: they change how evidence is READ,
 * never what it means, and hashing them would orphan a paid cohort over a
 * cost-ceiling edit. Pre-registration is protected instead by `campaign_events`
 * (`rule_changed`) plus the standings watermark, which records that the
 * goalposts moved without destroying the data.
 *
 * `lockSchemaVersion` is recorded ALONGSIDE the digest, never inside it — that
 * is what lets a future plan add inputs (prompt-template hash, resolved route)
 * deliberately without changing today's bytes.
 *
 * Plan: docs/plans/role-agnostic-comparison-core.md D2, D2a.
 *
 * @module scripts/lib/comparison/lock
 */

import crypto from 'node:crypto';

/**
 * Current lock schema version. Stored beside the digest (on the cohort row),
 * NOT hashed into it. Bumping it is the deliberate, greppable way to declare
 * "all prior evidence is incomparable"; it must never happen as a side effect
 * of an unrelated edit.
 */
export const LOCK_SCHEMA_VERSION = 1;

/**
 * Structure-stable JSON: keys sorted, floats fixed to 6dp, non-finite refused.
 *
 * `JSON.stringify` of an object literal is insertion-ordered and a float can
 * render differently across producers — either would split one cohort into two.
 * Not reusing `cohortDigest`: that is a fixed four-field literal for the
 * matcher config, not a general structural canonicaliser.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: refusing to digest a non-finite number (${value}) — it would serialize as null and silently change identity`);
      // Fixed 6dp so two producers rendering the same float agree. But rounding
      // is LOSSY, and this is cohort identity: `temperature: 0.0000001` and
      // `0.0000002` both render "0", so two genuinely different provider
      // requests would collapse into one cohort and be aggregated as if they
      // were the same scenario — the silent-merge failure the digest exists to
      // prevent, arriving through the digest itself.
      //
      // The fix is NOT to widen the precision: that would change the digest of
      // every existing config and orphan all collected evidence. Instead,
      // refuse a value that does not survive the round-trip. Every value in use
      // today (temperature 0, integer token counts) is unaffected — verified by
      // the byte-identity test — so this closes the collision without touching
      // a single existing identity.
      const rounded = Number(value.toFixed(6));
      if (rounded !== value) {
        throw new Error(
          `canonicalJson: refusing to digest ${value} — it does not survive 6dp canonicalisation (becomes ${rounded}), `
          + 'so two distinct configurations would share one cohort identity. Use a value expressible in 6 decimal places.',
        );
      }
      return JSON.stringify(rounded);
    }
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * Digest over the COLLECTION-RELEVANT subset — the fields that determine what
 * was asked of the models.
 *
 * @param {{role: string, decision: object, arms: object[], controls: object}} cfg
 * @returns {string} 16 hex chars
 */
export function configDigest(cfg) {
  const subset = { role: cfg.role, decision: cfg.decision, arms: cfg.arms, controls: cfg.controls };
  return crypto.createHash('sha256').update(canonicalJson(subset)).digest('hex').slice(0, 16);
}

/** Fields deliberately outside every digest — exported so a readout can name
 * the analysis-time values it applied rather than leaving a reader to guess
 * which rule produced a verdict. */
export const ANALYSIS_TIME_FIELDS = Object.freeze(['targetN', 'calibration', 'decisionRule']);
