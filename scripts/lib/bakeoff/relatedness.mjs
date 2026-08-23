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
 * Every finding in a transcript, whichever shape it arrived in.
 *
 * TWO shapes are real and both must work (fixed 2026-08-23, before this
 * heuristic had ever gated a real collection). The original implementation
 * read `transcriptJson.findings[]` only — a shape `build-audit-transcript.mjs`
 * does NOT produce. Every archived transcript nests them under
 * `rounds[].findings[]`, so against real input the citation set was always
 * empty, every pairing returned `related: false`, and the soft gate would have
 * demanded `--confirm-mismatch` on correct and incorrect pairings alike.
 *
 * That is strictly worse than no check: a guard that fires on everything
 * teaches the operator to pass the override reflexively, which is precisely
 * the failure the Gemini round-1 G2 fix (the clean-audit false positive) was
 * written to avoid — reintroduced through the input shape instead of the
 * threshold. Measured on the 4 real pairings this was first pointed at:
 * 3 known-correct and 1 deliberately-wrong control ALL returned
 * `related: false`, i.e. the heuristic could not discriminate at all.
 *
 * Accepting both shapes rather than migrating callers to one: the archive
 * holds 86 transcripts written over months by several producers, and a
 * heuristic that silently reads nothing is the exact failure being fixed —
 * so it must not depend on every historical artifact having one layout.
 */
function allFindings(transcriptJson) {
  if (Array.isArray(transcriptJson?.findings)) return transcriptJson.findings;
  if (Array.isArray(transcriptJson?.rounds)) {
    return transcriptJson.rounds.flatMap((r) => {
      if (Array.isArray(r?.findings)) return r.findings;
      if (Array.isArray(r?.result?.findings)) return r.result.findings;
      return [];
    });
  }
  return null; // structurally unreadable — distinct from "readable and empty"
}

/**
 * Does a bake-off transcript look related to the plan it is being paired
 * with?
 *
 * Two distinct empty cases, two different defaults (Gemini gate round 1,
 * G2): a structurally invalid transcript (no findings ANYWHERE — neither
 * top-level nor under `rounds`) cannot even attempt a comparison —
 * `related: false`, since a malformed input is not evidence of a clean
 * pairing. A VALID but EMPTY finding set — a genuinely clean, 0-finding
 * review — poses none of the mixed-pairing risk `--confirm-mismatch` exists
 * to catch, so it returns `related: true, reason: 'no-findings-to-compare'`
 * rather than forcing every clean audit through the confirmation flag.
 *
 * @param {{findings?: Array<object>, rounds?: Array<object>}} transcriptJson
 * @param {string} planText - the plan's raw markdown body
 * @returns {{overlap: string[], related: boolean, reason?: string}}
 */
export function planLooksRelated(transcriptJson, planText) {
  const findings = allFindings(transcriptJson);
  if (findings === null) {
    return { overlap: [], related: false };
  }
  if (findings.length === 0) {
    return { overlap: [], related: true, reason: 'no-findings-to-compare' };
  }
  const transcriptTokens = new Set();
  for (const f of findings) {
    // Every field a finding cites a location in. `section` is prose that
    // usually LEADS with the path; `_primaryFile` and `affectedFiles` are the
    // structured fields the audit pipeline actually populates — reading only
    // `file` (which no producer writes) was the second half of the same
    // shape mismatch as `rounds` above.
    for (const t of extractTokens(f?.section)) transcriptTokens.add(t);
    for (const t of extractTokens(f?.file)) transcriptTokens.add(t);
    for (const t of extractTokens(f?._primaryFile)) transcriptTokens.add(t);
    for (const one of (Array.isArray(f?.affectedFiles) ? f.affectedFiles : [])) {
      for (const t of extractTokens(one)) transcriptTokens.add(t);
    }
  }
  const planTokens = extractTokens(planText);
  const overlap = [...transcriptTokens].filter((t) => planTokens.has(t)).sort();
  return { overlap, related: overlap.length > 0 };
}
