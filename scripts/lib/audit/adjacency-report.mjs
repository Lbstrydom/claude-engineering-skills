/**
 * @fileoverview Report shaping for the containment-adjacency wave — prompt
 * construction, the bouncer invocation, the narrow-contract decision mapper,
 * the deterministic fallback, and the control findings.
 *
 * Plan: docs/plans/adjacency-check-containment.md §D1b / §D5 / §D7.
 *
 * **This module performs NO filesystem access — by design, and it is tested.**
 * The detector's single canonicalised read already produced the excerpt text,
 * the egress classification, AND the payload scan, all carried on the immutable
 * `AdjacencyCandidateEvidence`. The duplication wave re-reads and
 * re-classifies at this stage, and needed a Gemini-gate fix precisely because
 * that second classification had drifted lexical while the detector's was
 * symlink-aware. Here there is no second read to drift: `payload.safe` is a
 * property of the evidence, asserted rather than recomputed. A re-scan would be
 * a second computation of the same judgement — exactly the shape that drifted.
 *
 * @module scripts/lib/audit/adjacency-report
 */

import { INCOMPLETENESS_KINDS, incompleteness } from './adjacency-state.mjs';

let _idCounter = 0;
/** Reset the A-id counter — test-only, mirroring the duplication wave's D-id pattern. */
export function _resetAdjacencyIdCounter() { _idCounter = 0; }
function nextId() { return `A${++_idCounter}`; }

// incompleteness(kind, scope, detail) now imported from adjacency-state.mjs —
// this file's copy was byte-identical to adjacency-detector.mjs's (flagged
// by `arch:duplicates`).

/**
 * Build the egress-safe bouncer prompt from evidence ALONE.
 *
 * @param {object[]} evidence - AdjacencyCandidateEvidence[]
 * @param {{maxCandidateChars:number, maxPromptChars:number}} bounds
 * @returns {{prompt:string, includedIds:string[], incompleteness:object[]}}
 */
export function formatCandidatesForPrompt(evidence, { bounds } = {}) {
  if (!bounds) throw new TypeError('formatCandidatesForPrompt: bounds is required');
  const includedIds = [];
  const inc = [];
  const blocks = [];
  let total = 0;

  for (const e of evidence || []) {
    // The detector guarantees this; assert rather than re-scan (see header).
    // A violation is a detector bug, which is a FAILED audit, never a silent drop.
    if (!e?.payload) throw new Error(`adjacency: evidence ${e?.id} has no payload — detector contract violated`);
    if (!e.payload.safe) {
      // Already recorded as incompleteness by the detector; skip silently here
      // so the same fact is not double-counted.
      continue;
    }

    const block =
      `### Candidate ${e.id}\n` +
      `Container: \`if\` at ${e.canonicalPath}:${e.containerLine}\n` +
      `Condition: \`${(e.payload.conditionText || '').trim().slice(0, 300)}\`\n` +
      `Statement (${e.canonicalPath}:${e.span.startLine}-${e.span.endLine}), ` +
      `reads nothing declared in the branch and nothing the condition tests:\n` +
      '```\n' + e.payload.statementText + '\n```\n';

    if (block.length > bounds.maxCandidateChars) {
      inc.push(incompleteness(INCOMPLETENESS_KINDS.EXCERPT_UNRESOLVABLE, e.canonicalPath,
        `candidate ${e.id} needs ${block.length}B, exceeds maxCandidateChars=${bounds.maxCandidateChars} — not judged`));
      continue;
    }
    if (total + block.length > bounds.maxPromptChars) {
      inc.push(incompleteness(INCOMPLETENESS_KINDS.EXCERPT_UNRESOLVABLE, e.canonicalPath,
        `candidate ${e.id} dropped — prompt budget maxPromptChars=${bounds.maxPromptChars} exhausted`));
      continue;
    }
    total += block.length;
    includedIds.push(e.id);
    blocks.push(block);
  }

  return { prompt: blocks.join('\n---\n'), includedIds, incompleteness: inc };
}

/**
 * Invoke the LLM bouncer over the eligible evidence.
 *
 * Eligibility, the zero-candidate short-circuit, and total failure→fallback
 * mapping all live here rather than in the orchestrator, so they can be tested
 * without driving a whole audit.
 *
 * @param {object[]} evidence
 * @param {{bounds:object, callLlm:Function}} opts - `callLlm({prompt, rubric, schemaName})`
 * @returns {Promise<{ok:true, decisions:object[], includedIds:string[], incompleteness:object[]}
 *                 | {ok:false, reason:string, includedIds:string[], incompleteness:object[]}>}
 */
export async function runAdjacencyBouncer(evidence, { bounds, callLlm, rubric } = {}) {
  const { prompt, includedIds, incompleteness: inc } = formatCandidatesForPrompt(evidence, { bounds });

  // No eligible candidate → NO model call. An empty prompt is a paid no-op that
  // returns text the mapper would reject anyway.
  if (includedIds.length === 0) return { ok: true, decisions: [], includedIds, incompleteness: inc };

  if (typeof callLlm !== 'function') {
    return { ok: false, reason: 'no bouncer transport configured', includedIds, incompleteness: inc };
  }

  try {
    const raw = await callLlm({ prompt, rubric, schemaName: 'adjacency_bouncer' });
    const decisions = raw?.decisions;
    if (!Array.isArray(decisions)) {
      return { ok: false, reason: 'bouncer returned no decisions array', includedIds, incompleteness: inc };
    }
    if (decisions.length > bounds.maxCandidates) {
      return { ok: false, reason: `bouncer returned ${decisions.length} decisions, exceeds maxCandidates`, includedIds, incompleteness: inc };
    }
    return { ok: true, decisions, includedIds, incompleteness: inc };
  } catch (err) {
    // Timeout, non-2xx, parse failure, schema-validation failure — ALL map here.
    // Never a throw, never silence: the caller routes to the deterministic fallback.
    return { ok: false, reason: `bouncer call failed: ${err?.name ?? 'Error'}`, includedIds, incompleteness: inc };
  }
}

/**
 * The ONLY place a bouncer `keep` becomes a finding.
 *
 * `is_quick_fix` / `is_mechanical` are hardcoded literals here — never read
 * from the model's response (its schema does not even expose them). A model
 * that could author the convergence flag could silently defeat convergence.
 *
 * Completeness is validated: every included id must appear exactly once. Any
 * violation is a bouncer failure and the WHOLE set routes to the fallback —
 * a partial result is not a result.
 */
export function mapDecisionsToFindings(decisions, evidence, expectedIds) {
  const seen = new Set();
  for (const d of decisions || []) {
    if (!expectedIds.includes(d.candidateId)) return { ok: false, reason: `unknown candidateId: ${d.candidateId}` };
    if (seen.has(d.candidateId)) return { ok: false, reason: `duplicate candidateId: ${d.candidateId}` };
    seen.add(d.candidateId);
  }
  for (const id of expectedIds) {
    if (!seen.has(id)) return { ok: false, reason: `missing decision for candidateId: ${id}` };
  }

  const byId = new Map((evidence || []).map((e) => [e.id, e]));
  const findings = [];
  for (const d of decisions) {
    if (d.decision !== 'keep') continue;
    const e = byId.get(d.candidateId);
    if (!e) continue;
    findings.push(buildAdjacencyFinding(e, d.severity === 'HIGH' ? 'HIGH' : 'MEDIUM', d.rationale));
  }
  return { ok: true, findings };
}

/** Deterministic fallback (bouncer unavailable) — every eligible candidate
 *  becomes MEDIUM. Never HIGH without model judgement, and never silence. */
export function deriveFindingsFromAdjacencyReport(evidence, includedIds) {
  const eligible = new Set(includedIds ?? (evidence || []).map((e) => e.id));
  return (evidence || [])
    .filter((e) => eligible.has(e.id) && e.payload?.safe)
    .map((e) => buildAdjacencyFinding(e, 'MEDIUM', null));
}

function buildAdjacencyFinding(e, severity, rationale) {
  const where = `${e.canonicalPath}:${e.span.startLine}`;
  return {
    id: nextId(),
    severity,
    category: 'Statement may be trapped inside a conditional',
    detail:
      `${where} sits inside the \`if\` at ${e.canonicalPath}:${e.containerLine}, but reads nothing declared ` +
      `in that branch and nothing its condition tests.` + (rationale ? ` ${rationale}` : ''),
    risk:
      'If the statement is not genuinely conditional, it silently does not run on the other path — and because ' +
      'nothing errors, the result is wrong-shaped data rather than a failure. This is the class that produced ' +
      'a degraded bandit reward signal and a degraded cloud findings table for weeks without a single finding raised.',
    recommendation:
      `Decide whether ${where} depends on the condition at ${e.canonicalPath}:${e.containerLine}. If it does not, ` +
      'hoist it above the branch so it runs on every path. If it genuinely belongs (e.g. it reports ON the branch), ' +
      'leave it — this control is a nudge, not a gate.',
    section: e.canonicalPath,
    affectedFiles: [e.canonicalPath],
    affectedPrinciples: ['#2 SRP', '#15 Error Handling'],
    is_mechanical: !rationale,
    is_quick_fix: true,
    principle: '#2 SOLID — Single Responsibility',
  };
}

/**
 * The "this control did not fully run" finding — one shape for EVERY
 * incompleteness kind, so a new kind cannot be added without a finding to
 * carry it. Never carries raw error text (it can hold paths or credentials);
 * only a stable public code plus the already-sanitised detail.
 */
export function buildAdjacencyIncompleteFinding(record) {
  return {
    id: nextId(),
    severity: 'MEDIUM',
    category: 'coverage incomplete — control did not fully run',
    detail: `ADJACENCY_INCOMPLETE (${record.kind}): ${record.detail}`,
    risk:
      'Part of the change was not enumerated, so a trapped statement there would go unreported. Treating partial ' +
      'coverage as a pass is the failure this control exists to prevent — a clean result must mean "looked and ' +
      'found nothing", never "did not look".',
    recommendation:
      'Re-run with a narrower diff, or raise the relevant ADJACENCY_* bound if the limit is genuinely too low. ' +
      'The scope named in the detail is what was skipped.',
    section: record.scope || 'adjacency',
    affectedFiles: record.scope && record.scope !== 'diff' ? [record.scope] : [],
    affectedPrinciples: ['#19 Observability'],
    is_mechanical: true,
    is_quick_fix: true,
    principle: '#19 Observability',
  };
}

/** The detector-threw finding. Mirrors the duplication wave's: "the check
 *  itself couldn't run" blocks convergence exactly like a real finding, reusing
 *  `is_quick_fix` rather than adding new gate logic. */
export function buildAdjacencyFailedFinding(_reason) {
  return {
    id: nextId(),
    severity: 'MEDIUM',
    category: 'detector failed — audit incomplete for this control',
    detail: 'ADJACENCY_DETECTOR_FAILED: an internal step threw — see local logs for the redacted cause',
    risk:
      'The containment-adjacency control did not run for this audit; treating that as a silent pass would let a ' +
      'trapped statement ship unflagged.',
    recommendation:
      'Re-run /audit-code. If this persists, check the adjacency stderr log for the underlying cause (never logged ' +
      'into this finding, to avoid leaking paths or credentials from the raw error).',
    section: 'adjacency-detector',
    affectedFiles: [],
    affectedPrinciples: ['#15 Error Handling'],
    is_mechanical: true,
    is_quick_fix: true,
    principle: '#15 Error Handling',
  };
}
