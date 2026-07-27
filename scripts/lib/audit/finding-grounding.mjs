/**
 * @fileoverview Pre-adjudication grounding check for LLM review findings.
 *
 * **The problem, measured — not assumed.** Of the 8 shadow-only findings
 * dismissed to date, 5 shared one failure mode: the finding asserted that
 * something was ABSENT ("the plan never states what happens when
 * `getBinding()` returns undefined", "no visible test asserting...", "is
 * silent on validation") when the named file already contained exactly that
 * handling. Each cost real triage time to refute by hand — opening the file
 * and grepping for the thing the finding said was missing. That lookup is
 * mechanical, and doing it before a human sees the finding is strictly
 * cheaper than doing it after.
 *
 * This module does that lookup. It is **advisory evidence, never a gate**:
 * it attaches "here is where the named file appears to already do this" to a
 * finding, so the adjudicator starts with the disconfirming evidence in hand
 * instead of going to find it. It does NOT suppress, score, or auto-dismiss.
 * That restraint is deliberate: a false suppression hides a real defect,
 * which is a far worse error than a redundant note, and the shadow's whole
 * purpose is catching what the primary missed.
 *
 * **Scope (v1) — absence claims only.** The dismissals split into two mirror
 * shapes:
 *   - Shape A (5/8): "X is missing" where X is present  → covered here.
 *   - Shape B (2/8): "the artifact states Y" where Y is absent → NOT covered.
 *     Detecting which quoted fragments are being *attributed* to the artifact
 *     (rather than proposed by the reviewer) is a materially harder parse, and
 *     building it on 2 observations would be fitting noise. Left explicitly
 *     uncovered rather than half-built.
 *   The 8th dismissal (`dc7b1c0c`) is a genuine judgement disagreement with no
 *   absence claim at all — it is the negative control this module must NOT
 *   flag, and the test suite pins that.
 *
 * **Why the code and not the prompt.** Several refutations lived in code that
 * was never in the review payload — pre-existing guards outside the diff. So
 * the search corpus is the repo working tree, scoped to files the finding
 * itself names. Verifying against only what the reviewer was shown would have
 * missed exactly the cases that cost the most time.
 *
 * @module scripts/lib/audit/finding-grounding
 */

/**
 * Phrasings that assert absence. Calibrated against the real dismissal corpus
 * (2026-07-27), not invented: every pattern here fired on at least one true
 * case. Deliberately conservative — a missed claim costs a note we would not
 * have had anyway, while an over-broad pattern floods the adjudicator with
 * noise and gets the whole check switched off.
 */
const ABSENCE_PATTERNS = [
  /\b(?:never|not)\s+(?:state|states|stated|say|says|specify|specifies|mention|mentions|address|addresses|define|defines|document|documents)\b/i,
  /\bdoes\s+not\s+(?:state|say|name|specify|address|mention|distinguish|define|document)\b/i,
  /\bis\s+silent\s+on\b/i,
  /\bthere\s+is\s+no\b/i,
  /\bno\s+(?:visible\s+|explicit\s+|dedicated\s+)?(?:test|guard|check|validation|assertion|handling|coverage)\b/i,
  /\bnor\s+(?:does|that|is|any)\b/i,
  /\bnothing\s+(?:asserts|checks|validates|guards|pins|prevents)\b/i,
  /\bwithout\s+(?:any\s+)?(?:validation|check|guard|test|handling)\b/i,
  /\blacks?\s+(?:a|an|any)\b/i,
];

/** Cap on evidence entries per claim — see `specificity`. */
const MAX_SUBJECTS_PER_CLAIM = 3;

/** Split into sentences. Crude but adequate — findings are plain prose. */
function sentences(text) {
  return String(text || '')
    .split(/(?<=[.;])\s+(?=[A-Z`(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Identifiers worth grepping for. Ordered by precision:
 *   - backtick-quoted spans (the models are consistent about this)
 *   - `name()` call shapes
 *   - dotted accesses (`binding.path`)
 * Bare prose words are deliberately NOT extracted — "validation" as a search
 * term matches everything and proves nothing.
 *
 * @param {string} s
 * @returns {string[]} unique, plausible code identifiers
 */
export function extractIdentifiers(s) {
  const out = new Set();
  const text = String(s || '');
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) {
    const raw = m[1].trim();
    // A backticked span can be a whole expression; keep identifier-ish atoms.
    for (const id of raw.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\b/g)) {
      if (id[1].length >= 4) out.add(id[1]);
    }
  }
  for (const m of text.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]{3,})\s*\(\)/g)) out.add(m[1]);
  for (const m of text.matchAll(/\b([a-z_$][A-Za-z0-9_$]*\.[a-z_$][A-Za-z0-9_$]*)\b/g)) out.add(m[1]);
  // Bare camelCase, unquoted and without call parens — real findings write
  // "(acquireLock/releaseLock from file-store.mjs)" with no backticks at all,
  // and the first version of this module missed every such case. An interior
  // capital after a lowercase start is a strong code-identifier signal that
  // English prose almost never produces.
  for (const m of text.matchAll(/\b([a-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]{2,})\b/g)) out.add(m[1]);
  return [...out];
}

/**
 * How much a hit on this identifier is worth as evidence. A claim sentence
 * names both the thing asserted missing AND the subject it is about
 * ("never states that `sinceCommit` must pass isSafeGitRevision()"); finding
 * the *parameter* present proves nothing, while finding the *validator*
 * present refutes the claim. Specificity is a cheap proxy for that
 * distinction, used to rank and cap rather than to filter absolutely.
 * @param {string} id
 * @param {string} scope - the claim text the identifier came from
 */
function specificity(id, scope) {
  if (id.includes('.')) return 3;
  if (new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(scope)) return 2;
  return 1;
}

/** File paths the finding names — the search corpus. */
export function extractPaths(s) {
  const out = new Set();
  for (const m of String(s || '').matchAll(/\b([\w@./-]+\.(?:mjs|cjs|js|jsx|ts|tsx|sql|json|md))\b/g)) {
    out.add(m[1]);
  }
  return [...out];
}

/**
 * PURE. Find absence claims and the identifiers each one is about.
 *
 * An identifier counts as belonging to a claim if it appears in the same
 * sentence OR the one immediately before it — several real findings name the
 * symbol in a setup sentence and make the claim in the next ("The module
 * acquires/releases a lock (acquireLock/releaseLock...). The plan does not
 * state whether ... the lock is released on this path.").
 *
 * @param {string} detail - the finding's detail text
 * @returns {Array<{claim: string, subjects: string[]}>}
 */
export function extractAbsenceClaims(detail) {
  const sents = sentences(detail);
  const claims = [];
  for (let i = 0; i < sents.length; i++) {
    const s = sents[i];
    if (!ABSENCE_PATTERNS.some((re) => re.test(s))) continue;
    const scope = (i > 0 ? `${sents[i - 1]} ` : '') + s;
    const subjects = extractIdentifiers(scope);
    if (subjects.length > 0) claims.push({ claim: s, subjects });
  }
  return claims;
}

/**
 * Check a finding's absence claims against the files it names.
 *
 * I/O is injected so the decision logic stays unit-testable without a
 * filesystem — the same seam pattern the store modules use.
 *
 * @param {object} args
 * @param {string} args.detail - finding detail text
 * @param {string} [args.primaryFile] - the finding's primary_file (may carry a ` — section` suffix)
 * @param {(relPath: string) => string|null} args.readFile - returns contents or null if absent
 * @param {number} [args.maxFiles=6] - bound on files read per finding
 * @returns {{contested: Array<{claim: string, subject: string, file: string, line: number, evidence: string}>,
 *            claimsChecked: number, filesSearched: string[]}}
 */
export function checkFindingGrounding({ detail, primaryFile = '', readFile, maxFiles = 6 }) {
  const claims = extractAbsenceClaims(detail);
  // primary_file often reads "path/to/file.mjs — someFunction()"; take the path.
  const corpus = [...new Set([...extractPaths(primaryFile), ...extractPaths(detail)])].slice(0, maxFiles);
  const contested = [];
  const filesSearched = [];

  for (const rel of corpus) {
    let src;
    try { src = readFile(rel); } catch { src = null; }
    if (src == null) continue;
    filesSearched.push(rel);
    const lines = src.split('\n');
    for (const { claim, subjects } of claims) {
      // Rank by specificity and cap: an unbounded list turns one weak hit on a
      // parameter name into as much apparent evidence as a real refutation,
      // and a noisy note is a note the adjudicator learns to skip.
      const ranked = [...subjects]
        .sort((a, b) => specificity(b, claim) - specificity(a, claim))
        .slice(0, MAX_SUBJECTS_PER_CLAIM);
      for (const subject of ranked) {
        // Whole-identifier match; a substring hit ("path" inside "pathname")
        // would manufacture evidence that isn't there.
        const re = new RegExp(`(?<![A-Za-z0-9_$])${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`);
        const idx = lines.findIndex((l) => re.test(l));
        if (idx === -1) continue;
        contested.push({
          claim: claim.slice(0, 200),
          subject,
          file: rel,
          line: idx + 1,
          evidence: lines[idx].trim().slice(0, 160),
        });
      }
    }
  }
  return { contested, claimsChecked: claims.length, filesSearched };
}

/**
 * One-line advisory for the adjudication surface. Empty string when the
 * finding is clean — callers append nothing rather than a reassuring note,
 * because "grounding: ok" would invite reading absence of evidence as
 * evidence of correctness.
 *
 * @param {ReturnType<typeof checkFindingGrounding>} result
 * @returns {string}
 */
export function formatGroundingNote(result) {
  if (!result?.contested?.length) return '';
  const byFile = new Map();
  for (const c of result.contested) {
    if (!byFile.has(c.file)) byFile.set(c.file, c);
  }
  const parts = [...byFile.values()].map((c) => `${c.file}:${c.line} already references \`${c.subject}\``);
  return `⚠ grounding: this finding asserts an absence, but ${parts.join('; ')}. Verify before accepting.`;
}
