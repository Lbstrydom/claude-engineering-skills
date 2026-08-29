/**
 * @fileoverview Derive the managed `.gitattributes` EOL-pin block from the
 * sync's OWN destination set, instead of hand-maintaining a parallel list.
 *
 * We write synced surfaces with LF; on a Windows consumer (`core.autocrlf`)
 * git checks them out as CRLF and then reports every tracked synced file as
 * perpetually " M" with an EMPTY diff. That reads as unexplained drift, and
 * the fix a maintainer reaches for next — regenerating the "drifted" file —
 * is actively harmful for `.audit-loop/expected-schema.json`, which must only
 * ever come from a fresh replay (`npm run db:local:regen`); a restored DB
 * renumbers `attnum` past DROP COLUMN tombstones. So a cosmetic EOL bug can
 * steer someone into corrupting the fixture it affects.
 *
 * **Why derived, not listed.** The pin list used to be seven literal globs
 * inline in sync-to-repos.mjs, hand-kept in parallel with the path map. It
 * drifted: `.audit-loop/expected-schema.json` — a TRACKED synced destination
 * with its own `LAYOUT_CONSTANTS.EXPECTED_SCHEMA_DEST` constant, landing in
 * the same directory as the `.audit-loop/migrations/**` glob one line above —
 * was never pinned, and churned in consumers for as long as it has shipped.
 * The old guard test could not see it: it asserted block SHAPE against a
 * 2-element illustrative list, never that the real list was COMPLETE.
 *
 * The rule here is a property of what a pin is FOR, so it cannot drift the
 * same way: **pin every destination the sync writes that is not inside the
 * always-gitignored tooling dir** — i.e. everything a consumer can track.
 * `computeEolPins` iterates the destinations (the authoritative side) and
 * reports any that no glob covers, so adding a new tracked surface without a
 * pin ABORTS the sync rather than silently shipping churn.
 *
 * Globs, not literal paths, so the block stays a handful of lines and does not
 * re-churn on every skill-file addition — but only globs that actually matched
 * a destination are emitted, so the block is a real function of the bundle.
 *
 * @module scripts/lib/sync-eol-pins
 */

import { LAYOUT_CONSTANTS } from './sync-path-map.mjs';
import { RECEIPT_PATH } from './sync-receipt.mjs';

/**
 * Destinations the sync writes on EVERY run without them appearing in a
 * bundle's file list.
 *
 * The module's rule is "pin every destination the sync writes that a consumer
 * can track" — and `computeEolPins` only ever sees `repo.files`, so a surface
 * written outside that loop is invisible to it. That is exactly how
 * `.audit-loop/expected-schema.json` churned unnoticed before this module
 * existed; folding the receipt in HERE, rather than at the one call site, keeps
 * the rule and its enforcement in the same file.
 */
export const ALWAYS_WRITTEN_DESTINATIONS = Object.freeze([RECEIPT_PATH]);

/**
 * Covering globs for the tracked synced surfaces, in emission order.
 *
 * This is a COVERING list, not the contract: the contract is "every non-exempt
 * destination is covered", enforced by `computeEolPins`. Adding a surface here
 * that nothing matches is harmless (it is simply never emitted); FAILING to add
 * one is loud.
 */
export const EOL_PIN_GLOBS = Object.freeze([
  '.claude/skills/**',
  '.claude/hooks/**',
  '.claude/settings.json',
  '.vscode/mcp.json',
  'docs/reference/consistency-contract.md',
  LAYOUT_CONSTANTS.MANIFEST_PATH,
  `${LAYOUT_CONSTANTS.MIGRATIONS_DEST_PREFIX}**`,
  LAYOUT_CONSTANTS.EXPECTED_SCHEMA_DEST,
  RECEIPT_PATH,
]);

/** Sentinel standing in for `**` between the two wildcard passes. NUL cannot
 *  occur in a path, so no glob can smuggle it past the single-segment rule. */
const DOUBLESTAR = '\u0000';

function normalise(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Compile a gitattributes path glob to an anchored RegExp.
 *
 * `**` crosses `/` (whole subtree); a single `*` does NOT — the same semantics
 * git itself applies, and the same distinction `sync-untrack.mjs`'s
 * `gitignoreToRegExp` makes for the ignore block (that one deliberately
 * supports single-segment `*` only, which is why this is a separate function
 * rather than a shared one: widening it would widen the DESTRUCTIVE untrack
 * matcher too).
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  const escaped = normalise(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&'); // NOT `*`
  const body = escaped
    .split('**').join(DOUBLESTAR)
    .split('*').join('[^/]*')
    .split(DOUBLESTAR).join('.*');
  return new RegExp(`^${body}$`);
}

/**
 * Is this destination exempt from EOL pinning?
 *
 * Exactly one exemption: the consumer tooling dir, which the sync gitignores in
 * every consumer (the ignore block writes `<dir>/` from the same layout
 * constant), so nothing under it is ever tracked and CRLF churn is invisible.
 * Deliberately NOT "matches any managed ignore pattern" —
 * `scripts/.sync-manifest.json` is ignore-listed but never force-untracked (a
 * consumer that already tracks it keeps doing so by explicit decision), so it
 * still needs its pin.
 *
 * @param {string} destRel
 * @returns {boolean}
 */
export function isPinExempt(destRel) {
  return normalise(destRel).startsWith(`${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/`);
}

/**
 * Derive the EOL pins for a bundle from its consumer-relative destinations.
 *
 * @param {string[]} destRels - consumer-relative destinations (post `sourceRelToDestRel`)
 * @returns {{pins: string[], uncovered: string[]}} `pins` in EOL_PIN_GLOBS order,
 *   restricted to globs that actually matched something; `uncovered` lists
 *   trackable destinations no glob covers — a non-empty array is a sync ABORT,
 *   never a warning.
 */
export function computeEolPins(destRels) {
  const seen = new Set();
  const candidates = [];
  for (const d of [...(destRels || []), ...ALWAYS_WRITTEN_DESTINATIONS]) {
    const p = normalise(d);
    if (seen.has(p)) continue;
    seen.add(p);
    if (isPinExempt(p)) continue;
    candidates.push(p);
  }

  const matchers = EOL_PIN_GLOBS.map((g) => [g, globToRegExp(g)]);
  const used = new Set();
  const uncovered = [];
  for (const p of candidates) {
    const hit = matchers.find(([, re]) => re.test(p));
    if (hit) used.add(hit[0]);
    else uncovered.push(p);
  }

  return { pins: EOL_PIN_GLOBS.filter((g) => used.has(g)), uncovered };
}

/**
 * Render pins as managed-block lines.
 *
 * @param {string[]} pins
 * @returns {string[]}
 */
export function renderEolPinLines(pins) {
  return (pins || []).map((g) => `${g} text eol=lf`);
}
