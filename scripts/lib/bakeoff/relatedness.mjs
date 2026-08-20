/**
 * @fileoverview Plan/transcript relatedness heuristic (§7 Phase 4).
 *
 * Plan: docs/plans/campaign-arm-state-and-identity-integrity.md §7 Phase 4.
 *
 * A collection-time SOFT heuristic that would have caught all 3 real
 * mis-paired snapshots documented in
 * `docs/research/campaign-2026q3-mispaired-snapshots.md` §Method — that
 * manual method's own regex (`/[a-z0-9-]+\.mjs/g`) is the precedent this
 * mirrors, deliberately matching on BASENAME, not full path.
 *
 * Pure — no I/O. `transcriptJson` is the already-parsed transcript object
 * `bakeoff-collect.mjs` already holds in memory; never a raw-text regex
 * over the whole artifact (that would admit unrelated paths from
 * prompt/context/prose, not just cited findings).
 *
 * @module scripts/lib/bakeoff/relatedness
 */

/** Path-shaped tokens: a run of word/dot/dash/slash characters ending in a
 *  known extension. Kept intentionally narrow (the same extension set the
 *  manual method used) rather than any-file, since a plan or finding citing
 *  prose like "see the README" should not manufacture a spurious token. */
const PATH_TOKEN_RE = /[\w./-]+\.(mjs|js|ts|json|md|sql)\b/g;

/** Reduce a matched path token to its basename, lower-cased. Both sides
 *  (transcript citations and plan prose) are normalised identically, so a
 *  full relative path and a bare filename for the SAME file always collide
 *  — the manual method's own precedent (§Method's regex has no `/` at all). */
function basenameToken(token) {
  const stripped = token.replace(/^\.\//, '');
  const slash = stripped.lastIndexOf('/');
  return (slash >= 0 ? stripped.slice(slash + 1) : stripped).toLowerCase();
}

function extractTokens(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(PATH_TOKEN_RE)) out.add(basenameToken(m[0]));
  return out;
}

/**
 * Does a bake-off transcript look related to the plan it is being paired
 * with?
 *
 * Two distinct empty cases, two different defaults (Gemini gate round 1,
 * G2): a structurally invalid transcript (`findings` missing or not an
 * array) cannot even attempt a comparison — `related: false`, since a
 * malformed input is not evidence of a clean pairing. A VALID but EMPTY
 * `findings: []` — a genuinely clean, 0-finding review — poses none of the
 * mixed-pairing risk `--confirm-mismatch` exists to catch, so it returns
 * `related: true, reason: 'no-findings-to-compare'` rather than forcing
 * every clean audit through the confirmation flag.
 *
 * @param {{findings?: Array<{section?: string, file?: string}>}} transcriptJson
 * @param {string} planText - the plan's raw markdown body
 * @returns {{overlap: string[], related: boolean, reason?: string}}
 */
export function planLooksRelated(transcriptJson, planText) {
  if (!Array.isArray(transcriptJson?.findings)) {
    return { overlap: [], related: false };
  }
  if (transcriptJson.findings.length === 0) {
    return { overlap: [], related: true, reason: 'no-findings-to-compare' };
  }
  const transcriptTokens = new Set();
  for (const f of transcriptJson.findings) {
    for (const t of extractTokens(f?.section)) transcriptTokens.add(t);
    for (const t of extractTokens(f?.file)) transcriptTokens.add(t);
  }
  const planTokens = extractTokens(planText);
  const overlap = [...transcriptTokens].filter((t) => planTokens.has(t)).sort();
  return { overlap, related: overlap.length > 0 };
}
