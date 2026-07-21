/**
 * @fileoverview The frozen enforcement-verb pattern + the candidate-coverage
 * core for the D6 check (docs/plans/gate-contract-authoring.md).
 *
 * "What counts as an enforcement-claim candidate" lives HERE, in code — never
 * in a plan document (Gemini G1: a pre-push gate must not parse an immutable
 * historical plan as a live data source). The pattern is pinned by
 * tests/gate-honesty.test.mjs so a widening cannot drift silently.
 *
 * The coverage core is PURE — no git, no fs. The caller resolves the changed
 * SKILL.md lines (diff-scoped via push-range) and the contracts; this decides
 * which changed candidate lines are undispositioned. That split keeps every
 * coverage rule unit-testable without a repo, and mirrors db-suites-gate's
 * pure-decide / impure-shell shape.
 *
 * @module scripts/lib/gate-honesty/verb-pattern
 */

/**
 * The frozen enforcement-verb set. A candidate is a SKILL.md line on which one
 * of these appears as a whole word. Deliberately broad — the check is
 * DIFF-SCOPED (only new/modified lines) AND contracted-skill-only, so breadth
 * costs no corpus-wide toil (Gemini G3). Widening this array is a deliberate
 * act guarded by a pinning test.
 */
export const ENFORCEMENT_VERBS = Object.freeze([
  'blocks', 'block', 'fails', 'fail', 'exits', 'exit', 'refuses', 'refuse',
  'requires', 'require', 'must', 'never', 'always', 'threshold', 'thresholds',
  'cap', 'caps', 'max', 'gate', 'gates',
]);

// Longest-first alternation so `thresholds` matches before `threshold`; word
// boundaries so `gateway`/`maximum`/`format` do not match. Case-insensitive.
const VERB_ALTERNATION = [...ENFORCEMENT_VERBS]
  .sort((a, b) => b.length - a.length)
  .join('|');
const VERB_RE = new RegExp(`\\b(?:${VERB_ALTERNATION})\\b`, 'gi');

/**
 * Every enforcement-verb match position on a single line.
 * @param {string} line
 * @returns {Array<{start: number, end: number, verb: string}>}
 */
export function verbMatchesInLine(line) {
  const out = [];
  VERB_RE.lastIndex = 0;
  let m;
  while ((m = VERB_RE.exec(line)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, verb: m[0] });
    if (m.index === VERB_RE.lastIndex) VERB_RE.lastIndex++; // zero-width guard
  }
  return out;
}

/** Does a line contain at least one enforcement verb? */
export function isCandidateLine(line) {
  return verbMatchesInLine(line).length > 0;
}

/**
 * Normalise a candidate line for comparison: strip leading indentation and an
 * optional markdown list marker (`- ` / `* ` / `N. `), and trailing whitespace.
 * Applied to BOTH diff-extracted lines and `ignoredCandidates[].line` by the
 * caller so the two are compared on the same footing. A gate `stated` is a
 * mid-line claim snippet, so it survives this normalisation as a substring.
 */
export function normalizeCandidateLine(line) {
  return String(line).replace(/^\s*(?:[-*]\s+|\d+\.\s+)?/, '').replace(/\s+$/, '');
}

/**
 * Is every enforcement-verb position on `line` covered by the disposition set?
 *
 * SPAN coverage (implements Gemini-G2 without the count-formulation's
 * overcount): a `stated` snippet is a substring of the line, so it occupies a
 * span `[i, i+len)`. A verb position is covered iff it falls inside some
 * covering span. A second claim edited onto an already-contracted line places
 * new verbs OUTSIDE every existing `stated` span → uncovered → flagged. An
 * `ignoredCandidates` entry whose `line` equals the candidate covers it whole.
 *
 * (Design note: the plan wrote this as "#matches == #verb-hits". Span coverage
 * is a strictly better realisation — "must exit 1" is one claim with two verbs,
 * and count-matching would wrongly demand two dispositions; span coverage
 * accepts one `stated` that spans both. Recorded in the plan implementation
 * log.)
 *
 * @param {string} line — the candidate line's text (trimmed as authored)
 * @param {string[]} stateds — every gate `stated` for the owning skill
 * @param {string[]} ignoredLines — every `ignoredCandidates[].line`
 * @returns {boolean}
 */
export function lineIsCovered(line, stateds, ignoredLines) {
  if (ignoredLines.some((ig) => ig === line)) return true;

  const spans = [];
  for (const s of stateds) {
    if (!s) continue;
    let from = 0;
    // A stated may appear more than once; record every occurrence's span.
    for (;;) {
      const idx = line.indexOf(s, from);
      if (idx === -1) break;
      spans.push([idx, idx + s.length]);
      from = idx + Math.max(1, s.length);
    }
  }
  const verbs = verbMatchesInLine(line);
  return verbs.every((v) => spans.some(([a, b]) => v.start >= a && v.end <= b));
}

/**
 * The pure coverage decision.
 *
 * @param {Array<{skill: string, line: string}>} changedCandidates
 *   new/modified candidate lines (already diff-scoped + verb-filtered by the
 *   caller), each tagged with its owning skill.
 * @param {Map<string, {stateds: string[], ignoredLines: string[]}>} contracts
 *   ONLY contracted skills (D6 scopes to skills with a contract — an
 *   uncontracted skill has no dispositions yet; the ratchet forces its contract
 *   in Phase D, after which D6 keeps it current).
 * @returns {Array<{skill: string, line: string, reason: string}>} uncovered lines
 */
export function findUndispositionedCandidates(changedCandidates, contracts) {
  const out = [];
  for (const { skill, line } of changedCandidates) {
    const contract = contracts.get(skill);
    if (!contract) continue; // uncontracted → out of D6 scope (see @param)
    if (!lineIsCovered(line, contract.stateds, contract.ignoredLines)) {
      out.push({
        skill,
        line,
        reason: 'enforcement-verb line has no covering gate `stated` or `ignoredCandidates` entry',
      });
    }
  }
  return out;
}
