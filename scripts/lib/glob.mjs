/**
 * @fileoverview The ONE glob-matching seam for repo code (fleet claims, append-only
 * globs, archive ignores, audit exclusions, debt budgets).
 *
 * Backed by `picomatch`, which has no dependencies. It replaced `micromatch`
 * (2026-10-10): micromatch's only addition over picomatch is brace EXPANSION via
 * the `braces` package, which carries an unpatched stack-exhaustion DoS
 * (GHSA-vfj7-8cjw-p6xm, every version <= 3.0.3, no fix published). picomatch
 * still matches `{a,b}` alternation itself, without that recursive expander.
 * Every caller goes through here, so changing engines again is one file.
 *
 * Semantics kept from micromatch:
 *  - `isMatch(str, patterns)` — true when ANY pattern matches (picomatch's own).
 *  - `filterMatches(list, patterns)` — micromatch's LIST semantics: patterns
 *    starting with `!` are EXCLUSIONS, not independent matchers. An item is kept
 *    when it matches some positive pattern (or there are none) and no negated one.
 *    Plain picomatch would treat `!*.md` as "anything but *.md" and keep almost
 *    everything; tests/glob.test.mjs pins the difference.
 *
 * @module scripts/lib/glob
 */
// A STATIC import on purpose: scripts/lib/bundle-deps.json is derived from the
// import graph, and only a static specifier tells a consumer's sync to install
// the package. A required dependency that is missing fails loudly at import.
import picomatch from 'picomatch';

const asList = (patterns) => (Array.isArray(patterns) ? patterns : [patterns]).filter((p) => typeof p === 'string' && p !== '');

/**
 * A reusable matcher (any-of).
 * @param {string|string[]} patterns
 * @param {object} [opts] picomatch options (`dot`, `nocase`, …)
 * @returns {(s: string) => boolean}
 */
export function matcher(patterns, opts = {}) {
  const list = asList(patterns);
  if (!list.length) return () => false;
  return picomatch(list, opts);
}

/**
 * Does `str` match ANY of `patterns`?
 * @param {string} str
 * @param {string|string[]} patterns
 * @param {object} [opts]
 */
export function isMatch(str, patterns, opts = {}) {
  return matcher(patterns, opts)(str);
}

/**
 * The items of `list` selected by `patterns`, with `!`-prefixed patterns as exclusions.
 * @param {string[]} list
 * @param {string|string[]} patterns
 * @param {object} [opts]
 * @returns {string[]}
 */
export function filterMatches(list, patterns, opts = {}) {
  const all = asList(patterns);
  const pos = all.filter((p) => !p.startsWith('!'));
  const neg = all.filter((p) => p.startsWith('!')).map((p) => p.slice(1)).filter(Boolean);
  const keep = pos.length ? matcher(pos, opts) : () => true;
  const drop = neg.length ? matcher(neg, opts) : () => false;
  return list.filter((s) => keep(s) && !drop(s));
}
