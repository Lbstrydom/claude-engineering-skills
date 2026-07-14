/**
 * @fileoverview Report shaping for the duplication audit wave — bouncer
 * prompt construction (egress-gated), the narrow-contract decision mapper,
 * the deterministic fallback, and D-prefixed finding-id assignment.
 *
 * Plan: docs/plans/audit-code-duplication-wave.md §2/§4 Phase 2.
 * Mirrors `deriveFindingsFromReport` (legacy-production-audit.mjs) — the
 * one existing precedent for "mechanical report → LLM bouncer → deterministic
 * fallback" in this codebase.
 *
 * @module scripts/lib/audit/duplication-report
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveAndClassify } from '../sensitive-paths.mjs';
import { scanEgressPayload } from '../sensitive-egress-gate.mjs';

/** Lines of padding around a symbol's [startLine, endLine] span when excerpting for the bouncer prompt. */
const EXCERPT_PADDING_LINES = 2;
const MAX_EXCERPT_CHARS = 3000;

/**
 * Test-fixture duplication noise — checked ONLY here (the duplication
 * candidate/match filter), never in `sensitive-paths.mjs`'s general
 * indexing-skip predicate (round-3 M1 fix: these files are real test code
 * other architecture-memory consumers may legitimately want indexed —
 * unlike `docs/plans/security/files/**`, which is fully excluded from the
 * index itself via `sensitive-paths.mjs`'s `driftExempt` category).
 */
export const DUPLICATION_QUERY_EXCLUDE_GLOBS = Object.freeze([
  /(^|\/)tests\/arch-intent-adapter-(java|postgres|python)\.test\.mjs$/,
]);

/** True if `filePath` matches one of `DUPLICATION_QUERY_EXCLUDE_GLOBS`. */
export function isDuplicationQueryExcluded(filePath) {
  return DUPLICATION_QUERY_EXCLUDE_GLOBS.some((re) => re.test(String(filePath || '')));
}

/** `state === 'clean'` — NOT just an empty candidate/finding array (unavailable/failed also have empty arrays but are not "clean"). */
export function isDuplicationReportClean(report) {
  return report?.state === 'clean';
}

let _idCounter = 0;
/** Reset the D-id counter — test-only (mirrors the pattern other pass-finding constructors use for deterministic test output). */
export function _resetDuplicationIdCounter() { _idCounter = 0; }
function nextId() { return `D${++_idCounter}`; }

/**
 * Read `filePath`'s [startLine, endLine] span (±EXCERPT_PADDING_LINES),
 * bounded to MAX_EXCERPT_CHARS. Returns `null` on any read/sensitivity
 * failure (fail-closed — caller treats null as "cannot build evidence").
 *
 * Resolves `filePath` against the EXPLICIT `repoRoot`, never bare
 * `path.resolve` (which silently binds to `process.cwd()`) — Gemini gate
 * G1: this audit tool can run from a directory other than the repo root
 * (this repo's own consumer-sync architecture is proof such invocations
 * exist), and an implicit-cwd resolution would silently drop every
 * candidate into `refusedIds` rather than fail loudly.
 *
 * `gateSymbolForEgress` (defaults to the real WS-CANON `resolveAndClassify`,
 * injectable for tests) is a real defense-in-depth re-check, not a weaker
 * lexical stand-in — Gemini gate G1 flagged the original lexical-only
 * `isSensitiveFile` re-check as inconsistent with the detector's own
 * step-9 symlink-aware gate.
 *
 * @param {string} filePath
 * @param {number|null} startLine
 * @param {number|null} endLine
 * @param {string} repoRoot
 * @param {(p:string, repoRoot:string) => {category:string|null}} gateSymbolForEgress
 * @returns {string|null}
 */
function readExcerpt(filePath, startLine, endLine, repoRoot, gateSymbolForEgress) {
  if (gateSymbolForEgress(filePath, repoRoot).category === 'sensitive') return null;
  let raw;
  try {
    raw = fs.readFileSync(path.join(repoRoot, filePath), 'utf-8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    // No line range available (e.g. the RPC didn't return one for an
    // older-indexed row) — fall back to a bounded head of the file rather
    // than refusing outright.
    return lines.slice(0, 60).join('\n').slice(0, MAX_EXCERPT_CHARS);
  }
  const from = Math.max(0, startLine - 1 - EXCERPT_PADDING_LINES);
  const to = Math.min(lines.length, endLine + EXCERPT_PADDING_LINES);
  return lines.slice(from, to).join('\n').slice(0, MAX_EXCERPT_CHARS);
}

/**
 * Build the egress-gated markdown context for the LLM bouncer prompt, over
 * `semanticCandidates` (post-pragma, post-path-egress-gate — never the raw
 * candidate set). Excerpts just the candidate's and top match's own line
 * spans (round-1 code-audit M24 fix — was previously whole-file context,
 * which both gave the bouncer noisy irrelevant code AND could truncate the
 * actually-relevant symbol out of a large file's fixed-size window).
 * Refuses (never scrub-and-send) any pair whose assembled excerpt still
 * trips the secret-shaped-content scan — mirrors this repo's existing
 * `buildRedactedAuditContext` doctrine ("refuse rather than silently
 * scrub-and-send to a new provider").
 *
 * @param {object[]} semanticCandidates
 * @param {object} opts
 * @param {string} opts.repoRoot - REQUIRED, explicit — never inferred from process.cwd() (Gemini gate G1)
 * @param {(p:string, repoRoot:string) => {category:string|null}} [opts.gateSymbolForEgress] - injectable for tests; defaults to the real WS-CANON resolveAndClassify
 * @returns {{prompt: string, includedIds: string[], refusedIds: string[]}}
 */
export function formatCandidatesForPrompt(semanticCandidates, { repoRoot, gateSymbolForEgress = (p, root) => resolveAndClassify(p, { repoRoot: root }) } = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot) {
    throw new TypeError('formatCandidatesForPrompt: opts.repoRoot is required (Gemini gate G1 — never infer from process.cwd())');
  }
  const includedIds = [];
  const refusedIds = [];
  const blocks = [];

  for (const c of semanticCandidates) {
    const candExcerpt = readExcerpt(c.candidate.filePath, c.candidate.startLine, c.candidate.endLine, repoRoot, gateSymbolForEgress);
    const matchExcerpt = readExcerpt(c.topMatch.filePath, c.topMatch.startLine, c.topMatch.endLine, repoRoot, gateSymbolForEgress);
    if (candExcerpt === null || matchExcerpt === null) {
      refusedIds.push(c.id);
      continue;
    }
    const combined = `${candExcerpt}\n${matchExcerpt}`;
    const { safe } = scanEgressPayload(combined);
    if (!safe) {
      refusedIds.push(c.id);
      continue;
    }
    includedIds.push(c.id);
    const otherMatches = c.allMatches.slice(1).map((m) => `${m.filePath}:${m.symbolName} (sim=${m.similarity.toFixed(2)})`).join(', ');
    blocks.push(
      `### Candidate ${c.id}\n` +
      `New/changed: ${c.candidate.kind} \`${c.candidate.symbolName}\` in ${c.candidate.filePath} — ${c.candidate.purposeSummary || '(no summary)'}\n` +
      '```\n' + candExcerpt + '\n```\n' +
      `Top match: ${c.topMatch.kind} \`${c.topMatch.symbolName}\` in ${c.topMatch.filePath} (sim=${c.topMatch.similarity.toFixed(2)})\n` +
      '```\n' + matchExcerpt + '\n```\n' +
      (otherMatches ? `Other matches ≥ threshold: ${otherMatches}\n` : '')
    );
  }

  return { prompt: blocks.join('\n---\n'), includedIds, refusedIds };
}

/**
 * Orchestration-side mapper — the ONLY place a bouncer `decision: 'keep'`
 * becomes a real finding. `is_quick_fix`/`is_mechanical` are hardcoded
 * literals here, never read from the model's response (its schema doesn't
 * even expose those fields) — Gemini round-2 H4 fix, "the model can't be
 * trusted to set the convergence flag."
 *
 * Validates completeness: every id in `expectedIds` must appear in
 * `decisions` exactly once. Any violation (missing/duplicate/unknown id)
 * is a bouncer failure — caller should route the WHOLE candidate set to
 * `deriveFindingsFromDuplicationReport` instead of using a partial result.
 *
 * @param {{candidateId:string, decision:'keep'|'drop', severity:'MEDIUM'|'HIGH', rationale:string}[]} decisions
 * @param {object[]} semanticCandidates
 * @param {string[]} expectedIds
 * @returns {{ok:true, findings:object[]} | {ok:false, reason:string}}
 */
export function mapBouncerDecisionsToFindings(decisions, semanticCandidates, expectedIds) {
  const seen = new Set();
  for (const d of decisions || []) {
    if (!expectedIds.includes(d.candidateId)) return { ok: false, reason: `unknown candidateId in bouncer response: ${d.candidateId}` };
    if (seen.has(d.candidateId)) return { ok: false, reason: `duplicate candidateId in bouncer response: ${d.candidateId}` };
    seen.add(d.candidateId);
  }
  for (const id of expectedIds) {
    if (!seen.has(id)) return { ok: false, reason: `bouncer response missing decision for candidateId: ${id}` };
  }

  const byId = new Map(semanticCandidates.map((c) => [c.id, c]));
  const findings = [];
  for (const d of decisions) {
    if (d.decision !== 'keep') continue;
    const c = byId.get(d.candidateId);
    if (!c) continue;
    findings.push(buildDuplicationFinding(c, d.severity === 'HIGH' ? 'HIGH' : 'MEDIUM', d.rationale));
  }
  return { ok: true, findings };
}

/** Deterministic fallback (bouncer call failed) — every semantic candidate becomes a MEDIUM finding directly, no HIGH without LLM judgement. */
export function deriveFindingsFromDuplicationReport(semanticCandidates) {
  return (semanticCandidates || []).map((c) => buildDuplicationFinding(c, 'MEDIUM', null));
}

function buildDuplicationFinding(c, severity, bouncerRationale) {
  const { candidate, topMatch } = c;
  return {
    id: nextId(),
    severity,
    category: '[Duplication] Near-duplicate of existing symbol',
    detail: bouncerRationale
      ? `${candidate.filePath}:${candidate.symbolName} closely duplicates ${topMatch.filePath}:${topMatch.symbolName} (similarity ${topMatch.similarity.toFixed(2)}). ${bouncerRationale}`
      : `${candidate.filePath}:${candidate.symbolName} closely duplicates ${topMatch.filePath}:${topMatch.symbolName} (similarity ${topMatch.similarity.toFixed(2)}).`,
    risk: 'Shipping a duplicate instead of reusing the existing canonical symbol is the exact class of architectural drift arch:drift measures — it compounds with every future edit to either copy.',
    recommendation: `Import/reuse ${topMatch.filePath}:${topMatch.symbolName} instead of the new implementation, or add ` +
      `// @duplicate-justification: target=${topMatch.filePath}:${topMatch.symbolName} reason=<why this diverges> ` +
      `immediately above the declaration if the duplication is intentional.`,
    section: candidate.filePath,
    affectedFiles: [candidate.filePath, topMatch.filePath],
    affectedPrinciples: ['#1 DRY', '#5 SSoT'],
    is_mechanical: !bouncerRationale,
    is_quick_fix: true,
    principle: '#1 DRY',
  };
}

/** The 'failed'-state deterministic finding — "the check itself couldn't run" blocks convergence exactly like a real finding (reuses is_quick_fix, no new convergence logic). `detail` never carries the raw error (round-3 M1) — `reason` is accepted for call-site symmetry with the detector's `report.reason` field but intentionally unused here; only a stable public code is emitted. */
export function buildDetectorFailedFinding(_reason) {
  return {
    id: nextId(),
    severity: 'MEDIUM',
    category: '[Duplication] detector failed — audit incomplete for this control',
    detail: 'DUPLICATION_DETECTOR_FAILED: an internal step threw — see local logs for the redacted cause',
    risk: 'The duplication control did not actually run for this audit; treating this as a silent pass would let real duplication ship unflagged.',
    recommendation: 'Re-run /audit-code. If this persists, check the duplication-detector stderr log for the underlying cause (never logged into this finding, to avoid leaking paths/credentials from the raw error).',
    section: 'duplication-detector',
    affectedFiles: [],
    affectedPrinciples: ['#15 Error Handling'],
    is_mechanical: true,
    is_quick_fix: true,
    principle: '#15 Error Handling',
  };
}

/** Converts detector.mjs's raw `{type:'orphaned-pragma', ...}` records into FindingSchema-shaped findings with assigned D-ids. */
export function finalizeDeterministicFindings(rawRecords) {
  return (rawRecords || []).map((r) => {
    if (r.type === 'orphaned-pragma') {
      return {
        id: nextId(),
        severity: 'MEDIUM',
        category: '[Duplication] Orphaned suppression pragma',
        detail: `${r.filePath}:${r.symbolName} carries a @duplicate-justification pragma targeting ` +
          `${r.target.file}:${r.target.symbolName}, but that target is not among this symbol's actual ` +
          `near-duplicate matches (reason given: "${r.reason}").`,
        risk: 'A stale or mistargeted suppression pragma silently hides genuine duplication from this control.',
        recommendation: `Update the pragma's target to the real matched canonical symbol, or remove it if the duplication no longer applies.`,
        section: r.filePath,
        affectedFiles: [r.filePath],
        affectedPrinciples: ['#1 DRY', '#5 SSoT'],
        is_mechanical: true,
        is_quick_fix: true,
        principle: '#1 DRY',
      };
    }
    throw new Error(`finalizeDeterministicFindings: unknown record type ${r.type}`);
  });
}
