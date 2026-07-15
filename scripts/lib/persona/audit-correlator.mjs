/**
 * @fileoverview Deterministic persona<->audit correlator — WS1 of
 * docs/completed/persona-nav-feedback-recovery.md. Replaces the
 * agent-discretionary manual `record-correlation` emission (which ran for
 * ~5 weeks and produced zero rows) with a correlator that runs
 * automatically inside `cross-skill.mjs record-persona-session`,
 * immediately after the session row commits.
 *
 * **Ground-truth integrity is the whole point of this module** — every
 * design choice below exists to keep `persona_audit_correlations` a
 * trustworthy signal for the bandit user-impact reward and the
 * `audit_effectiveness` view, not just "some rows."
 *
 * Versioned matching contract: bump MATCHER_VERSION on any change to
 * `personaFindingHash()` or the matching algorithm. A version bump
 * orphans OLD outcome labels from NEW sessions only (accepted
 * single-operator debt — see the plan's Risks table).
 *
 * @module scripts/lib/persona/audit-correlator
 */
import { semanticId } from '../findings.mjs';
import { sanitizeStepUrl } from '../store/persona.mjs';

export const MATCHER_VERSION = 1;

// Strengthened at code-audit time (H3/M2 — "false ground-truth from generic
// UI vocabulary overlap"): 0.5 combined with the dual-signal floor below
// still let a merely-plausible pair through. 0.6 raises the bar on the
// COMBINED score (0.5*fileScore + 0.5*keywordScore) — this is a threshold
// on the weighted sum, NOT an independent per-axis minimum; e.g. a candidate
// clearing 100% file-path overlap only needs >=20% keyword overlap to reach
// 0.6, while one at 50%/50% needs 70% on the other axis to compensate. The
// MIN_INFORMATIVE_TOKENS floor below (not this threshold) is what rejects
// single-generic-token matches. A rejected match still falls through to
// `audit_missed`, so this only trades recall for precision, never drops a
// finding silently.
//
// Exported (code-audit M6/M7 fix) so the test suite pins the ACTUAL
// production boundary rather than a hardcoded literal that can silently
// drift from this value — "one shared source for implementation and
// tests" was the auditor's exact recommendation.
export const FUZZY_THRESHOLD = 0.6;
const MIN_TOKEN_LEN = 3;

// ── Canonical persona-finding identity (shared by WS1 correlation and WS4
// outcome labels — defined ONCE here, never re-derived) ───────────────────

/**
 * A raw persona finding as produced by persona-test's Phase 5 report step.
 * NOT formally schema'd upstream (freeform convention) — every field read
 * here is defensive (`?? ''`) because a malformed/older-shape finding must
 * degrade to a harmless empty-string component, never throw.
 *
 * Real production shape (verified against live session data, 2026-07-13):
 * `{ fix, code, step, element, expected, observed, confidence }` — `code`
 * IS the severity ("P0".."P3"), there is no separate `category` field.
 *
 * @param {object} finding
 * @returns {string} 8-char hex hash, stable across sessions for the same
 *   observation
 */
export function personaFindingHash(finding) {
  const section = String(finding?.element ?? '');
  const category = String(finding?.code ?? '');
  const detail = String(finding?.observed ?? '');
  return semanticId({ section, category, detail });
}

/** P0/P1 only — the correlator's scope (P2/P3 are not ground-truth-worthy). */
export function isP0OrP1(finding) {
  return finding?.code === 'P0' || finding?.code === 'P1';
}

/**
 * A finding missing `element` or `observed` degrades, via
 * `personaFindingHash`'s `?? ''` fallbacks, to the SAME synthetic identity
 * as every other malformed finding sharing the missing fields — a shared
 * hash across unrelated malformed observations, which is a correlation/
 * outcome-label identity collision, not just a harmless empty match
 * (code-audit H4 fix). Quarantine before hashing rather than let it
 * silently acquire a colliding identity.
 */
function isMalformedFinding(finding) {
  return !finding?.element || !String(finding.element).trim()
    || !finding?.observed || !String(finding.observed).trim();
}

// ── Tokenization + Overlap Coefficient (Gemini gate round-2 fix — NOT
// Jaccard, which is mathematically wrong when comparing a short
// UI-vocabulary token set against a long code-path token set: the larger
// set's extra tokens inflate the union denominator regardless of true
// relevance) ────────────────────────────────────────────────────────────

function tokenize(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= MIN_TOKEN_LEN),
  );
}

// A single-token smaller set can never independently confirm a match — e.g.
// persona observed = "Save" (1 token) fully contained in ANY audit detail
// mentioning "save" scores a degenerate 1.0, regardless of relevance
// (code-audit H5/H8 fix — "single generic token" false-ground-truth case).
// Require at least 2 tokens on the smaller side before overlap counts as
// evidence at all.
const MIN_INFORMATIVE_TOKENS = 2;

/** |A ∩ B| / min(|A|, |B|) — 0 when either set is empty OR the smaller set is too small to be informative (see MIN_INFORMATIVE_TOKENS). */
function overlapCoefficient(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  if (smaller.size < MIN_INFORMATIVE_TOKENS) return 0;
  let intersection = 0;
  for (const t of smaller) if (larger.has(t)) intersection += 1;
  return intersection / smaller.size;
}

/**
 * Build the persona side's file-path token set: `finding.element` plus the
 * sanitized URL of the step it occurred on (cross-referenced via
 * `finding.step` against the session's clickPath, when available).
 */
function personaFilePathTokens(finding, stepUrlByNumber) {
  const stepUrl = stepUrlByNumber?.get(finding?.step) ?? '';
  return tokenize(`${finding?.element ?? ''} ${sanitizeStepUrl(stepUrl)}`);
}

function personaKeywordTokens(finding) {
  return tokenize(finding?.observed ?? '');
}

/** audit_findings has a single `primary_file` column, not an array. */
function auditFilePathTokens(auditFinding) {
  return tokenize(auditFinding.primary_file ?? '');
}

function auditKeywordTokens(auditFinding) {
  return tokenize(`${auditFinding.detail_snapshot ?? ''} ${auditFinding.category ?? ''}`);
}

/**
 * Score one persona finding against one audit-finding candidate row.
 * Returns both components alongside the combined score — acceptance
 * requires corroboration from BOTH signals (see `matchFinding`), not just
 * a high combined total, so a candidate with zero keyword overlap can't
 * pass purely on file-path containment (a real false-ground-truth risk:
 * a UI element token can trivially appear in an unrelated file's path).
 * @returns {{score: number, fileScore: number, keywordScore: number}}
 */
function scoreMatch(finding, auditFinding, stepUrlByNumber) {
  const fileScore = overlapCoefficient(
    personaFilePathTokens(finding, stepUrlByNumber),
    auditFilePathTokens(auditFinding),
  );
  const keywordScore = overlapCoefficient(
    personaKeywordTokens(finding),
    auditKeywordTokens(auditFinding),
  );
  return { score: 0.5 * fileScore + 0.5 * keywordScore, fileScore, keywordScore };
}

const SEVERITY_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * Match one persona finding against the candidate audit findings.
 * Strict precedence: exact tier (semanticId byte-equality against the
 * stored finding_fingerprint — an opportunistic fast path expected to
 * fire rarely, since the two vocabularies differ structurally) then the
 * fuzzy tier (Overlap Coefficient, threshold 0.6 + dual-signal floor —
 * see FUZZY_THRESHOLD). Ties within a tier
 * broken by newest audit run, then highest audit severity.
 *
 * @param {object} finding - raw persona finding
 * @param {string} findingHash - personaFindingHash(finding), pre-computed
 * @param {object[]} candidates - audit_findings rows (each also carries
 *   `run_created_at` from the join, for tie-breaking)
 * @param {Map<number,string>} stepUrlByNumber
 * @returns {{ auditFinding: object, matchScore: number, tier: 'exact'|'fuzzy' } | null}
 */
export function matchFinding(finding, findingHash, candidates, stepUrlByNumber) {
  // Defensive: `decideCorrelations` always passes a real array (DB rows via
  // getCandidateAuditFindings), but this is an exported public function —
  // degrade to "no candidates" rather than throw on a malformed caller input.
  if (!Array.isArray(candidates)) return null;
  const exact = candidates.filter((c) => c.finding_fingerprint === findingHash);
  if (exact.length > 0) {
    const best = pickBest(exact);
    return { auditFinding: best, matchScore: 1.0, tier: 'exact' };
  }

  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const { score, fileScore, keywordScore } = scoreMatch(finding, c, stepUrlByNumber);
    // Require BOTH signals to contribute — a candidate that only shares a
    // file-path token (or only a keyword) with zero corroboration from the
    // other axis does not clear the bar, even if the combined score would.
    if (score < FUZZY_THRESHOLD || fileScore <= 0 || keywordScore <= 0) continue;
    if (
      best === null
      || score > bestScore
      || (score === bestScore && isNewerOrHigherSeverity(c, best))
    ) {
      best = c;
      bestScore = score;
    }
  }
  return best ? { auditFinding: best, matchScore: bestScore, tier: 'fuzzy' } : null;
}

function pickBest(rows) {
  return rows.reduce((best, r) => (isNewerOrHigherSeverity(r, best) ? r : best), rows[0]);
}

function isNewerOrHigherSeverity(candidate, current) {
  const cTime = new Date(candidate.run_created_at ?? 0).getTime();
  const curTime = new Date(current.run_created_at ?? 0).getTime();
  if (cTime !== curTime) return cTime > curTime;
  return (SEVERITY_RANK[candidate.severity] ?? 0) > (SEVERITY_RANK[current.severity] ?? 0);
}

/** True when the audit's own severity understates a P0 persona finding. */
export function isSeverityUnderstated(finding, auditFinding) {
  return finding?.code === 'P0' && (auditFinding.severity === 'LOW' || auditFinding.severity === 'MEDIUM');
}

/**
 * Build a `step -> sanitizedUrl` lookup from a session's raw clickPath
 * array (the same shape `buildSanitizedClickPath` consumes).
 * @param {Array<{step?: number, url?: string}>} clickPath
 * @returns {Map<number, string>}
 */
export function buildStepUrlLookup(clickPath) {
  const map = new Map();
  if (!Array.isArray(clickPath)) return map;
  for (const entry of clickPath) {
    if (entry && typeof entry.step === 'number' && typeof entry.url === 'string') {
      map.set(entry.step, sanitizeStepUrl(entry.url));
    }
  }
  return map;
}

/**
 * Pure correlation-decision function — no I/O. Given a session's P0/P1
 * findings and the candidate audit findings (already fetched), decides
 * what to emit. The caller (the orchestration wrapper in
 * `cross-skill.mjs`) is responsible for the actual store writes and the
 * existing-correlation existence check (first-hit-wins is enforced by the
 * CALLER skipping findings already in `alreadyCorrelatedHashes`, not by
 * this function, since that requires a DB read).
 *
 * @param {{ findings: object[], clickPath?: unknown, candidates: object[],
 *   alreadyCorrelatedHashes: Set<string> }} args
 * @returns {{ emissions: Array<object>, skippedExisting: number, malformed: number }}
 *   `emissions` entries are ready for `recordPersonaAuditCorrelation`
 *   (camelCase, matcherVersion attached). `malformed` counts P0/P1 findings
 *   quarantined for missing `element`/`observed` — never hashed, matched,
 *   or emitted (see `isMalformedFinding`).
 */
export function decideCorrelations({ findings, clickPath, candidates, alreadyCorrelatedHashes }) {
  const stepUrlByNumber = buildStepUrlLookup(clickPath);
  const p0p1 = (findings || []).filter(isP0OrP1);
  const emissions = [];
  let skippedExisting = 0;
  let malformed = 0;
  // Seeded from the DB existence check, then updated in-loop so two P0/P1
  // findings with the SAME identity hash in one session (a repeated
  // observation) are decided once, not emitted twice against the same
  // unique-index target (the second write would just fail as a spurious
  // conflict).
  const seen = new Set(alreadyCorrelatedHashes);

  for (const finding of p0p1) {
    if (isMalformedFinding(finding)) { malformed += 1; continue; }
    const hash = personaFindingHash(finding);
    if (seen.has(hash)) { skippedExisting += 1; continue; }
    seen.add(hash);

    const match = matchFinding(finding, hash, candidates, stepUrlByNumber);
    if (match) {
      const correlationType = isSeverityUnderstated(finding, match.auditFinding)
        ? 'severity_understated'
        : 'confirmed_hit';
      emissions.push({
        personaFindingHash: hash,
        personaSeverity: finding.code,
        auditFindingId: match.auditFinding.id,
        auditRunId: match.auditFinding.run_id,
        correlationType,
        matchScore: match.matchScore,
        matchRationale: `[v${MATCHER_VERSION}] ${match.tier} tier, score ${match.matchScore.toFixed(2)}`,
        matcherVersion: MATCHER_VERSION,
        // Caller-only bookkeeping (tallying correlationSummary.exact/fuzzy/
        // missed) — NOT part of the recordPersonaAuditCorrelation payload
        // shape; strip before persisting if a future write path is strict
        // about unknown keys.
        _tier: match.tier,
      });
    } else if (candidates.length > 0) {
      // audit_missed requires >=1 candidate — an empty candidate set is
      // NOT evidence of a miss (see decideCorrelations caller: candidates
      // empty short-circuits before this function is even called).
      const mostRecent = candidates.reduce(
        (a, b) => (new Date(b.run_created_at) > new Date(a.run_created_at) ? b : a),
      );
      emissions.push({
        personaFindingHash: hash,
        personaSeverity: finding.code,
        auditFindingId: null,
        auditRunId: mostRecent.run_id,
        correlationType: 'audit_missed',
        matchScore: null,
        matchRationale: `[v${MATCHER_VERSION}] no candidate scored >= ${FUZZY_THRESHOLD}`,
        matcherVersion: MATCHER_VERSION,
        _tier: 'missed',
      });
    }
  }
  return { emissions, skippedExisting, malformed };
}
