/**
 * @fileoverview Bounded malformed-anchor diagnostics (WS-E2).
 *
 * **Why this module exists.** The bounding logic was written for the eval
 * harness (`scripts/model-eval-discovery.mjs`) and lived there. But the tiered
 * pipeline needs the *same* breakdown for `_stageBreakdown.discoveryMalformedReasons`
 * — the surface `tiered-shadow-compare.mjs` reads and the Phase-14 shadow window
 * actually consumes. Importing a CLI entry point from a library module would
 * invert the dependency direction (and drag `main()`'s provider/network setup
 * into the pipeline's import graph), while copying the function would leave two
 * bounding policies free to drift apart — and the whole point of the field is
 * that two runs over the same input produce identical records. So the pure
 * helper lives here and both callers import it.
 *
 * **Two budgets, not one.** Bounding exemplars PER reason code leaves the NUMBER
 * of reason codes unbounded — a model emitting thousands of distinct strings
 * would yield thousands of one-element buckets. So: cap the key, cap the
 * buckets, cap the exemplars, and fold the rest into a counted `__other`.
 *
 * Deterministic throughout (first-N by rawIndex; buckets by count desc then key
 * asc) so two runs over the same input produce identical records.
 *
 * @module scripts/lib/audit/malformed-details
 */

// MUST stay the egress-gate redactor, not `lib/secret-patterns.mjs`. This repo
// carries several redactors with deliberately different aggressiveness, and this
// is the one the original eval-harness `clip` used. Swapping it during the
// extraction would have silently changed what these persisted strings leak —
// a behaviour change disguised as a refactor.
import { redactSecrets } from '../sensitive-egress-gate.mjs';

export const MALFORMED_MAX_BUCKETS = 20;
export const MALFORMED_MAX_EXEMPLARS = 5;
export const MALFORMED_MAX_KEY_BYTES = 120;
export const MALFORMED_MAX_DETAIL_BYTES = 500;
export const MALFORMED_MAX_ANCHOR_BYTES = 2000;
/**
 * Sentinel for the folded long tail. Prefixed so a model emitting this exact
 * string natively cannot occupy the same key and produce two buckets that
 * disagree — the payload is untrusted, including its keys.
 */
export const MALFORMED_OTHER_KEY = '__other (aggregated by harness)';

/**
 * Redact THEN clip. These strings are model-produced echoes of the code payload
 * and they are PERSISTED — before this field they were discarded, so storing
 * them widens the blast radius of anything sensitive that reached the prompt.
 * Bounding alone is not an egress control (audit R1-H1).
 */
export const clip = (v, max) => {
  // Absent stays ABSENT. `JSON.stringify(null)` yields the 4-char string
  // "null", so an unconditional clip turned a missing detail into a literal
  // that reads like data — the absent-vs-value confusion this telemetry is
  // supposed to avoid.
  if (v === null || v === undefined) return null;
  const raw = typeof v === 'string' ? v : JSON.stringify(v);
  if (typeof raw !== 'string') return raw;
  let safe;
  try {
    const out = redactSecrets(raw);
    safe = typeof out === 'string' ? out : (out?.text ?? raw);
  } catch {
    // Fail closed: a redactor failure must not emit the raw text.
    return '[REDACTED:redaction-failed]';
  }
  if (safe.length <= max) return safe;
  // Truncate on a CODE POINT boundary. `.slice` cuts UTF-16 code units, so a
  // cap landing mid-surrogate emits a lone half — malformed Unicode in a
  // persisted, rendered field.
  const cut = safe.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff) ? cut.slice(0, -1) : cut;
};

/**
 * Build the bounded reason breakdown.
 *
 * Returns `[]` for an empty input, and callers MUST preserve that: an empty
 * array means "this run was measured and had no malformed anchors", which is a
 * different fact from `null` ("nothing wrote this field — insufficient data").
 * Collapsing the two is the exact ambiguity this telemetry exists to remove.
 *
 * @param {Array<{rawIndex:number, reasonCode:string, reasonDetail?:string}>} malformed
 * @param {Array<object>} rawFindings the round's findings, for anchor lookup
 * @returns {Array<object>} bounded buckets, deterministically ordered
 */
export function boundMalformedDetails(malformed, rawFindings) {
  const byReason = new Map();
  for (const m of malformed) {
    const key = clip(m.reasonCode ?? 'unknown', MALFORMED_MAX_KEY_BYTES) || 'reason_code_invalid';
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key).push(m);
  }
  const ordered = [...byReason.entries()]
    .sort((a, b) => (b[1].length - a[1].length) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const kept = ordered.slice(0, MALFORMED_MAX_BUCKETS);
  const dropped = ordered.slice(MALFORMED_MAX_BUCKETS);

  const buckets = kept.map(([reasonCode, items]) => {
    const sorted = [...items].sort((a, b) => (a.rawIndex ?? 0) - (b.rawIndex ?? 0));
    const exemplars = sorted.slice(0, MALFORMED_MAX_EXEMPLARS).map((m) => {
      // Validate rawIndex before using it — an out-of-range value records the
      // reason with a null anchor rather than indexing garbage or throwing.
      const idx = Number.isInteger(m.rawIndex) && m.rawIndex >= 0 && m.rawIndex < rawFindings.length
        ? m.rawIndex : null;
      const anchor = idx === null ? null : (rawFindings[idx]?.anchor ?? rawFindings[idx]?.triggerAnchor ?? null);
      return {
        rawIndex: idx,
        reasonDetail: clip(m.reasonDetail ?? null, MALFORMED_MAX_DETAIL_BYTES),
        rawAnchor: anchor === null ? null : clip(anchor, MALFORMED_MAX_ANCHOR_BYTES),
      };
    });
    return {
      reasonCode,
      count: items.length,                       // count is over ALL, not the exemplars
      exemplars,
      truncated: items.length > exemplars.length,
      omittedCount: items.length - exemplars.length,
    };
  });

  if (dropped.length > 0) {
    buckets.push({
      reasonCode: MALFORMED_OTHER_KEY,
      count: dropped.reduce((n, [, items]) => n + items.length, 0),
      exemplars: [],
      truncated: true,
      omittedCount: dropped.reduce((n, [, items]) => n + items.length, 0),
      distinctReasonCodes: dropped.length,
    });
  }
  return buckets;
}
