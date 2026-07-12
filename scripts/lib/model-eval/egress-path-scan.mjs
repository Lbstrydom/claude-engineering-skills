/**
 * @fileoverview Shared free-text sensitive-path token scan — extracted
 * (round-12 audit H6 fix) so both structured-extractor.mjs (the extraction
 * boundary) and provider-adapter.mjs (the final provider-call boundary, "not
 * just part of the pipeline" per this round's finding) apply the SAME check,
 * without a circular import between them (structured-extractor.mjs already
 * imports invokeStructured from provider-adapter.mjs).
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 1.
 *
 * @module scripts/lib/model-eval/egress-path-scan
 */

import { classifyPath } from '../sensitive-paths.mjs';

// Round-14 audit M11 fix — moved here (from structured-extractor.mjs, which
// re-exports it for backward compatibility) so provider-adapter.mjs's
// final-boundary path-scan check can throw the SAME domain-specific error
// class the upstream extraction boundary uses, instead of a plain Error —
// equivalent egress-policy failures are now consistently classified across
// both boundaries, without a circular import between the two.
export class EgressGateError extends Error {
  constructor(message) { super(message); this.name = 'EgressGateError'; }
}

/**
 * True iff a path-shaped candidate token has enough real-path evidence to
 * trust a bare-keyword sensitive-pattern match (`tokens?`, `password`,
 * `secrets?`, `credentials?`, `private`) when it's applied to free-text
 * PROSE rather than an actual file path. Those keyword patterns are
 * intentionally broad in `sensitive-paths.mjs` for genuine path-discovery
 * call sites (git diffs, symbol index) and must stay that way there — but
 * the generic `word/word` extraction regex below manufactures path-shaped
 * candidates out of ordinary English ("token/size", "public/private",
 * "read/write"), and any of those tripped the gate the moment the first
 * word matched a keyword. Confirmed 2026-07-12: an audit finding's own
 * prose ("a token/size cap... not enforced globally") blocked a legitimate
 * blind-judge payload this way.
 *
 * Dotfile-shaped tokens (.env, .env.production, .npmrc, .ssh/id_rsa),
 * anchored paths (./, ~/, /), real filename extensions, 3+ path segments,
 * and explicit .aws/.ssh directory mentions are essentially never how
 * natural English prose is shaped, so those always pass unconditionally.
 * A bare single-slash word pair with none of that evidence does not — same
 * "tighten recall for higher precision" tradeoff already documented in
 * sensitive-paths.mjs; this scanner is defense-in-depth, not the sole
 * egress layer (assertEgressSafe's secret-content scan still runs first).
 *
 * @param {string} token
 * @returns {boolean}
 */
function looksLikeRealPath(token) {
  if (/^\./.test(token)) return true;
  if (/^id_[rd]sa/i.test(token)) return true;
  if (/^(?:\.{1,2}\/|~\/|\/)/.test(token)) return true;
  if (/\.[A-Za-z0-9]{1,8}$/.test(token)) return true;
  if ((token.match(/\//g) || []).length >= 2) return true;
  if (/\/\.(aws|ssh)(\/|$)/i.test(token)) return true;
  return false;
}

// Characters that appear in REGEX SOURCE but essentially never in a real
// file path. This repo's own security tooling (sensitive-paths.mjs,
// secret-patterns.mjs, their tests) contains pattern literals like
// `/(^|\/)id_rsa.*$/i` — the `.*$` tail made the classifier's own
// `id_rsa.*` pattern match the TOKEN, so any diff touching those files
// self-tripped the gate on its own pattern text (2026-07-12 sweep:
// `id_rsa.*$/i`, `.env(\..+)?$` tokens). A plain-string fixture mention
// (`'.ssh/id_rsa'`) contains none of these and still trips — correctly:
// it is indistinguishable from a real path mention.
//
// NOTE deliberately NOT added: stripping trailing code punctuation
// (`'.env.local'),` → `.env.local`) before classifying. It was tried and
// reverted same-day — it silently STRENGTHENED the gate beyond its
// historical recall (prose like "keys live in .env)" started flagging,
// re-blocking two previously-valid corpus entries). Historical behavior
// is the contract; punctuation-wrapped mentions escape exactly as before.
const REGEX_SOURCE_CHARS = /[(){}[\]|*+?^$\\]/;

/**
 * Bounded, best-effort scan for path-shaped substrings in free text (prose,
 * not a structured field) — not full NLP-grade path extraction, a
 * defense-in-depth net for the common "the file .env has..." case.
 *
 * The `.env`/`rc`-dotfile branches require a negative lookbehind
 * (`(?<!\w)`) immediately before the leading dot — discovered 2026-07-12
 * scanning this repo's own harvested defect-candidate diffs: source code
 * reading `process.env.GEMINI_API_KEY` or `import.meta.env.X` is extremely
 * common in any JS/TS codebase, and without the lookbehind the match starts
 * mid-identifier (the "." right before "env"), producing a token
 * indistinguishable from a real `.env.production`-style dotfile mention —
 * this alone blocked ~40% of an otherwise-clean 331-candidate corpus sweep.
 * A genuine `.env` FILE mention is always preceded by whitespace, a quote,
 * a path separator, or start-of-string — never by a bare identifier
 * character — so the lookbehind costs no real recall.
 *
 * Only the `sensitive` category flags. `generatedNoise` (lockfiles,
 * *.min.js, *.map) exists to keep those files' BODIES out of provider
 * prompts (context waste); a mere lockfile path MENTION carries no secret,
 * and flagging it blocked every diff that touched package-lock.json
 * alongside real code. Body-egress call sites keep using
 * `sensitive-egress-gate.mjs::isPathSensitive` (both categories) — the
 * conflation is correct there.
 *
 * @param {string} text
 * @returns {string[]} sensitive path-like tokens found, if any
 */
export function findSensitivePathMentions(text) {
  if (typeof text !== 'string' || !text) return [];
  const tokens = text.match(/[.\w-]+(?:\/[.\w-]+)+|(?<!\w)\.\w+rc\b|(?<!\w)\.env\S*|id_[rd]sa\S*/g) || [];
  return tokens
    .filter((t) => !REGEX_SOURCE_CHARS.test(t) && looksLikeRealPath(t) && classifyPath(t) === 'sensitive');
}
