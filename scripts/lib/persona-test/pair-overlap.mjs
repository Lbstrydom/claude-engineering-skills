/**
 * @fileoverview The /persona-test --pair overlap rate (SKILL.md Step P5
 * COVERAGE METRIC), as ONE formula shared by the command that validates a
 * caller's figure and the store writer that persists it. Pure.
 *
 * @module scripts/lib/persona-test/pair-overlap
 */

/**
 * consensus / (consensus + aOnly + bOnly), rounded to the
 * `persona_pair_sessions.overlap_rate` column's 4 places so the stored value
 * is exactly what this returns. A pair with no findings on either side has
 * nothing to overlap: 0, never NaN.
 * @param {{consensusCount: number, aOnlyCount: number, bOnlyCount: number}} c
 * @returns {number}
 */
export function derivePairOverlapRate({ consensusCount, aOnlyCount, bOnlyCount }) {
  const total = consensusCount + aOnlyCount + bOnlyCount;
  if (!(total > 0)) return 0;
  return Math.round((consensusCount / total) * 10000) / 10000;
}
