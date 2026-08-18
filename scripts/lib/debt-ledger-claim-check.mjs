/**
 * @fileoverview Ledger-capture claim check — a plan document that says a
 * deferred item was "captured to / named in the debt ledger" is making a
 * claim about a record ELSEWHERE (`.audit/tech-debt.json`), which no reader
 * of the diff can falsify. Twice in this repo that claim was confidently
 * wrong (`cross-skill-cli-integrity.md`, then `cross-skill-command-registry.md`)
 * and survived six audit rounds, a Gemini gate, and a shadow reviewer each
 * time — reviewing harder doesn't catch it, because the truth isn't in the
 * text being reviewed. This module is the mechanical check: a claim must
 * carry a resolvable `topicId`, the citation style `refactor-vcs-protocol.md`
 * already uses correctly (`**\`b093444897a3\`** (new — captured to
 * \`.audit/tech-debt.json\` …)`).
 *
 * Scope, deliberately narrow (AGENTS.md "do not widen this into a general
 * cross-document verification framework"):
 *   - Matches POSITIVE capture claims only ("captured to/in", "named in",
 *     "filed to/in", "tracked in" + "debt ledger" / "tech-debt.json").
 *     NEGATIVE claims ("NOT in the debt ledger", e.g.
 *     `refactor-evidence-integrity.md`) are OUT OF SCOPE for v1: they invert
 *     the failure mode this check exists for — a false negative undersells
 *     existing coverage rather than overclaiming it, which is lower-risk and
 *     not the "confidently wrong" hazard both real incidents shared.
 *   - A claim inside quote marks (`*"captured to the debt ledger"*`, the
 *     shape both corrected plans now use to DISCUSS the false phrase) is a
 *     MENTION, not a live claim, and is excluded — same use-vs-mention
 *     distinction `check-docs-refs.mjs`'s SPEC exclusion already applies,
 *     implemented here as a content heuristic instead of a file allowlist so
 *     it generalises to any future plan quoting the pattern.
 *   - Resolution scope is WHOLE-DOCUMENT, not per-line/per-paragraph: a valid
 *     claim can point at a citation elsewhere in the same file (e.g.
 *     `refactor-vcs-protocol.md` §1 says "captured … see §7", and §7 is
 *     where the topicId actually appears). Document scope avoids false
 *     positives on that legitimate pointer pattern without having to follow
 *     "see §N" references. The accepted trade-off (documented, not
 *     accidental): an unrelated valid topicId elsewhere in the same document
 *     would satisfy resolution for an otherwise-unbacked claim. Narrower
 *     than that requires following prose pointers, which is exactly the kind
 *     of over-engineering AGENTS.md's right-sizing discipline rejects for a
 *     check whose real job is catching a WRONG claim, not policing every
 *     RIGHT one's precision.
 *
 * Deliberately NOT wired into the blocking `npm run check` pipeline.
 * `.audit/tech-debt.json` is gitignored, machine-local state (see AGENTS.md
 * "Generated-artifact policy" category A) — the pre-push hook runs `check`
 * against a throwaway worktree of the commit being pushed
 * (`docs/runbooks/prepush-sandbox.md`), where the ledger is always absent.
 * A blocking gate here would either fail every push touching `docs/plans/`
 * (ledger absent -> nothing resolves) or, if it treated "absent" as "clean",
 * silently pass having checked nothing — the sandbox-honesty anti-pattern
 * AGENTS.md calls out by name. `debt-health-check.mjs` and
 * `check-accepted-debt.mjs` hit the identical constraint (the first reads
 * this same file; the second reads AGENTS.md but exists for the same
 * "checked vs. unverifiable, never silently trusted" reason) and both stay
 * local-only, opt-in via `maintenance-checks.mjs`, never blocking a push.
 * This module follows the same precedent, not `check-docs-refs.mjs`'s
 * BASELINE drift-gate (whose targets — repo paths — are always present in a
 * clean checkout, so blocking is safe there in a way it is not here).
 *
 * @module scripts/lib/debt-ledger-claim-check
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PLANS_DIR = 'docs/plans';

// word-boundary on the capture-verb: without it, "filed" matches inside
// "fileDebtLedger" (a real false positive hit during design — an internal
// variable name in a code sample, not a claim).
const CLAIM_TRIGGER = new RegExp(
  '\\b(captured|named|filed|tracked)\\b.{0,60}(debt ledger|tech-debt\\.json)' +
  '|(debt ledger|tech-debt\\.json).{0,60}\\b(captured|named|filed|tracked)\\b',
  'i',
);

// A claim wrapped in quote marks on the same line is being discussed, not
// asserted — e.g. `*"captured to the debt ledger"*` inside a correction
// block. Matches straight and curly double quotes.
const QUOTE_WRAPPED_MENTION = new RegExp(
  '["“][^"”]*\\b(captured|named|filed|tracked)\\b[^"”]*(debt ledger|tech-debt\\.json)[^"”]*["”]' +
  '|["“][^"”]*(debt ledger|tech-debt\\.json)[^"”]*\\b(captured|named|filed|tracked)\\b[^"”]*["”]',
  'i',
);

// topicIds observed in the ledger are 8 or 12 lowercase hex chars, always
// backtick-quoted in prose (`b093444897a3`, `78e4d7aa`). A commit sha is the
// same shape and can share a backtick citation style — collision with a real
// topicId is a ~1-in-4-billion (8-hex) or ~1-in-280-trillion (12-hex) event
// per token; accepted, same class as this repo's other documented negligible-
// probability trade-offs (AGENTS.md "Accepted Technical Debt").
const TOPIC_ID_IN_BACKTICKS = /`([0-9a-f]{8}(?:[0-9a-f]{4})?)`/gi;

/**
 * Find ledger-capture claim lines in one document's text.
 * @param {string} text
 * @returns {{line: number, snippet: string}[]}
 */
export function findClaimLines(text) {
  const lines = text.split('\n');
  const claims = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (CLAIM_TRIGGER.test(l) && !QUOTE_WRAPPED_MENTION.test(l)) {
      claims.push({ line: i + 1, snippet: l.trim().slice(0, 160) });
    }
  }
  return claims;
}

/**
 * Extract every backtick-quoted hex token that could be a topicId, deduped
 * and lower-cased. Does not itself decide validity — the caller resolves
 * against the ledger.
 * @param {string} text
 * @returns {string[]}
 */
export function extractCitedIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(TOPIC_ID_IN_BACKTICKS)) ids.add(m[1].toLowerCase());
  return [...ids];
}

/**
 * Check one document. Pure — no fs access.
 * @param {{relPath: string, text: string}} doc
 * @param {Set<string>} validTopicIds - lower-cased topicIds present in the ledger
 * @returns {{relPath: string, claims: {line:number,snippet:string}[], resolvable: boolean, citedValidIds: string[]}}
 */
export function checkDocument({ relPath, text }, validTopicIds) {
  const claims = findClaimLines(text);
  if (claims.length === 0) {
    return { relPath, claims: [], resolvable: true, citedValidIds: [] };
  }
  const cited = extractCitedIds(text);
  const citedValidIds = cited.filter((id) => validTopicIds.has(id));
  return { relPath, claims, resolvable: citedValidIds.length > 0, citedValidIds };
}

/**
 * Run the check as a pure function of its inputs — mirrors
 * `check-accepted-debt.mjs`'s `executeCheck()` shape (pure core, thin
 * process adapter). `ledgerAvailable: false` is a distinct outcome from
 * "clean": nothing was verified, and the caller must report that plainly
 * rather than implying a pass.
 * @param {{docs: {relPath: string, text: string}[], ledgerAvailable: boolean, validTopicIds: Set<string>}} args
 * @returns {{ok: boolean, ledgerAvailable: boolean, results: object[], violations: object[], claimingDocs: number}}
 */
export function executeCheck({ docs, ledgerAvailable, validTopicIds }) {
  const results = docs
    .map((d) => checkDocument(d, validTopicIds))
    .filter((r) => r.claims.length > 0);

  if (!ledgerAvailable) {
    return { ok: true, ledgerAvailable: false, results, violations: [], claimingDocs: results.length };
  }

  const violations = results.filter((r) => !r.resolvable);
  return {
    ok: violations.length === 0,
    ledgerAvailable: true,
    results,
    violations,
    claimingDocs: results.length,
  };
}

/**
 * Read every `*.md` file directly under `dir` (non-recursive — matches
 * `docs/plans/*.md`, not the `security/` subdirectory, per the task's
 * exact glob).
 * @param {string} dir
 * @returns {{relPath: string, text: string}[]}
 */
export function readPlanDocs(dir = DEFAULT_PLANS_DIR) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const docs = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const rel = path.posix.join(dir, e.name);
    docs.push({ relPath: rel, text: fs.readFileSync(path.join(dir, e.name), 'utf-8') });
  }
  return docs;
}
