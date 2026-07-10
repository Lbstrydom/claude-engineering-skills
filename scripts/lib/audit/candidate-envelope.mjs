/**
 * @fileoverview AuditCandidateEnvelope — provenance-preserving wrapper around
 * raw findings, introduced by the tiered-recall audit pipeline redesign.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 3 (round-1 finding
 * #9, merge contract per round-2 finding #6).
 *
 * Why this exists: a thin dedupe-by-fingerprint would collapse multiple
 * discovery-portfolio models' findings on the same underlying issue into one
 * winner, discarding the losers' evidence — which breaks two things down-
 * stream: (a) the GPT-sentinel reward can no longer tell whether GPT
 * uniquely contributed to an accepted finding (Phase 6), and (b) a
 * hallucinated anchor on the chosen "canonical" claim would silently reject
 * the whole envelope even when a sibling model's anchor was valid (Gemini
 * gate round-2 finding #G1). The envelope keeps every contributing model's
 * claim, and Stage 0 (evidence-triage.mjs) can fall back across them.
 *
 * @module scripts/lib/audit/candidate-envelope
 */

const SEVERITY_RANK = { LOW: 1, MEDIUM: 3, HIGH: 8 };

/**
 * @typedef {object} AuditCandidateEnvelope
 * @property {string} candidateId
 * @property {object} canonicalFinding - the chosen representative finding
 * @property {Array<object>} evidenceAlternatives - one entry per contributing
 *   source: {sourceModel, evidenceType, anchor, triggerAnchor, causalChain, rawDetail}.
 *   Includes the canonical claim too (index 0) — never a separate, harder-to-
 *   find "the rest" list.
 * @property {Array<{model: string, pass: string, timestamp: string}>} sources
 * @property {Array<object>} stageDecisions - append-only AuditStageDecisionV1 log
 * @property {string} fingerprint
 */

/**
 * Build the single-source envelope for one raw finding (already normalised +
 * fingerprinted by `findings-pipeline.mjs::processFindings` — this module
 * never re-fingerprints).
 *
 * @param {object} finding - a post-`processFindings` finding (`_fingerprint` set)
 * @param {object} opts
 * @param {string} opts.sourceModel
 * @param {string} opts.pass
 * @param {string} [opts.timestamp] - ISO string; defaults to caller-supplied only
 *   (this module never calls `Date.now()`/`new Date()` itself — see below)
 * @returns {AuditCandidateEnvelope}
 */
export function createEnvelope(finding, { sourceModel, pass, timestamp }) {
  if (!finding?._fingerprint) {
    throw new Error('createEnvelope: finding._fingerprint is required — pass findings through findings-pipeline.mjs::processFindings first');
  }
  const evidenceEntry = {
    sourceModel,
    evidenceType: finding.evidenceType ?? null,
    anchor: finding.anchor ?? null,
    triggerAnchor: finding.triggerAnchor ?? null,
    causalChain: finding.causalChain ?? null,
    rawDetail: finding.detail ?? '',
    // audit-orchestrator-hardening Phase 9 (audit-plan fix H2, round 1):
    // full-fidelity, INTERNAL-only provenance snapshot of the contributing
    // claim. structuredClone (not a reference) closes the mutation-aliasing
    // risk a bare `finding` would carry. Retention vs. egress are two
    // different boundaries: this field is read only by in-process code
    // (e.g. a future debugging/audit-trail tool) and NEVER serialized into
    // anything that leaves the process boundary — Phase 8's
    // `buildStageOneTriageInput` is built from `envelope.canonicalFinding`
    // ONLY and never reads `evidenceAlternatives[].fullClaim`, so Phase 8's
    // narrowing is structurally unaffected by this widening. Any FUTURE
    // code path that persists an envelope to disk/cloud must explicitly
    // `.pick()` the fields it needs rather than serializing the envelope
    // wholesale (already how `writeStage1MechanicalLedgerEntry`'s caller
    // behaves today — this adds no new discipline, only extends it here).
    fullClaim: structuredClone(finding),
  };
  return {
    candidateId: `envelope:${finding._fingerprint}`,
    canonicalFinding: finding,
    evidenceAlternatives: [evidenceEntry],
    sources: [{ model: sourceModel, pass, timestamp: timestamp ?? null }],
    stageDecisions: [],
    fingerprint: finding._fingerprint,
  };
}

/**
 * Severity-rank comparator. Unknown severities sort lowest (never silently
 * treated as highest — a finding with a malformed severity should not win
 * the canonical slot by default).
 */
function severityRank(sev) {
  return SEVERITY_RANK[String(sev || '').toUpperCase()] ?? 0;
}

/**
 * Merge raw (post-`processFindings`) findings into envelopes.
 *
 * Merge contract (round-2 finding #6):
 *   - Grouping key is the EXACT `_fingerprint` `processFindings` already
 *     computed (same underlying issue after normalisation) — never a fuzzy
 *     file+category proximity match, which risks conflating distinct issues.
 *   - Envelope severity = the MAXIMUM of contributing sources' severities.
 *     A later stage (Stage 2 / human review) may explicitly lower it; nothing
 *     upstream of that may.
 *   - Every contributing source's full claim is preserved as a distinct
 *     `evidenceAlternatives` entry, INCLUDING ones that disagree with the
 *     chosen `canonicalFinding` — disagreement is never silently discarded.
 *
 * @param {Array<object>} findings - post-`processFindings` findings, each
 *   carrying `_fingerprint`, `_pass` (or `pass`), and identifying which model
 *   produced it (`_sourceModel`, falls back to `'unknown'` — callers SHOULD
 *   set this before calling; see discovery-portfolio.mjs, Phase 6).
 * @returns {Array<AuditCandidateEnvelope>}
 * @throws {Error} if ANY finding lacks `_fingerprint` (Cluster B audit finding
 *   H4 — a caller bug here previously converted into invisible data loss via
 *   a silent `continue`; consistent with `createEnvelope`, which throws on
 *   the same precondition, this now fails loud with the offending indices).
 */
export function mergeIntoEnvelopes(findings) {
  const missingFingerprintIndexes = findings.reduce((acc, f, i) => (f?._fingerprint ? acc : [...acc, i]), []);
  if (missingFingerprintIndexes.length > 0) {
    throw new Error(
      `mergeIntoEnvelopes: ${missingFingerprintIndexes.length} finding(s) lack _fingerprint ` +
      `(indexes: ${missingFingerprintIndexes.join(', ')}) — pass findings through ` +
      `findings-pipeline.mjs::processFindings first`
    );
  }
  const byFingerprint = new Map();
  for (const f of findings) {
    const fp = f._fingerprint;
    const sourceModel = f._sourceModel || 'unknown';
    const pass = f._pass || f.pass || 'unknown';
    const evidenceEntry = {
      sourceModel,
      evidenceType: f.evidenceType ?? null,
      anchor: f.anchor ?? null,
      triggerAnchor: f.triggerAnchor ?? null,
      causalChain: f.causalChain ?? null,
      rawDetail: f.detail ?? '',
      // Phase 9 — see the matching comment in createEnvelope above. This is
      // `mergeIntoEnvelopes`'s OWN evidenceEntry construction (a separate
      // code path, not a call to createEnvelope) — the losing-alternative
      // case this phase's regression test exercises (`mergeIntoEnvelopes`
      // merging multiple findings under one fingerprint) only goes through
      // THIS block, so the fix must apply here too, not just in createEnvelope.
      fullClaim: structuredClone(f),
    };
    if (!byFingerprint.has(fp)) {
      byFingerprint.set(fp, {
        candidateId: `envelope:${fp}`,
        canonicalFinding: f,
        evidenceAlternatives: [evidenceEntry],
        sources: [{ model: sourceModel, pass, timestamp: f._timestamp ?? null }],
        stageDecisions: [],
        fingerprint: fp,
      });
      continue;
    }
    const envelope = byFingerprint.get(fp);
    envelope.evidenceAlternatives.push(evidenceEntry);
    envelope.sources.push({ model: sourceModel, pass, timestamp: f._timestamp ?? null });
    if (severityRank(f.severity) > severityRank(envelope.canonicalFinding.severity)) {
      // A higher-severity contributor is promoted to canonical; the previous
      // canonical's evidence stays in evidenceAlternatives (already pushed
      // above, before this promotion, so it's never lost). Consolidated
      // Gemini gate fix G2, round 2: this module's own JSDoc documents
      // `evidenceAlternatives` as "Includes the canonical claim too (index
      // 0)" — the original code promoted `f` to `canonicalFinding` without
      // reordering the array, leaving index 0 pointing at the NOW-STALE
      // lower-severity claim. `evidenceEntry` (just pushed) is always the
      // last element at this point, so swapping it into index 0 restores
      // the documented invariant without any other reshuffling.
      envelope.canonicalFinding = f;
      const lastIndex = envelope.evidenceAlternatives.length - 1;
      [envelope.evidenceAlternatives[0], envelope.evidenceAlternatives[lastIndex]] =
        [envelope.evidenceAlternatives[lastIndex], envelope.evidenceAlternatives[0]];
    }
  }
  return [...byFingerprint.values()];
}

/**
 * Promote a specific evidenceAlternatives entry to canonicalFinding — used by
 * Stage 0's envelope-aware fallback (Gemini gate round-2 finding #G1) when the
 * original canonical claim's anchor turns out to be fabricated but a sibling
 * claim verifies. Pure: returns a new envelope object, never mutates.
 *
 * Consolidated Gemini gate fix G2: the original implementation spread `alt`
 * (an `evidenceAlternatives`-shaped object: `{sourceModel, evidenceType,
 * anchor, triggerAnchor, causalChain, rawDetail}`) directly OVER the OLD
 * canonicalFinding (a full finding shape: `{id, severity, category, section,
 * detail, ...}`) in two places, both wrong:
 *   1. `canonicalFinding: {...oldCanonical, ...alt}` never remapped
 *      `alt.rawDetail` → the new canonical's `.detail` field, so the
 *      PROMOTED finding kept the FAILED claim's prose description paired
 *      with the NEW claim's anchor — a human reviewer would read a
 *      description that doesn't match the cited evidence.
 *   2. `demoted: {...oldCanonical, ...alt, verificationFailed:true}` spread
 *      `alt` LAST, so its fields won on conflict — `demoted` (meant to
 *      preserve the FAILED original claim's record) ended up looking like
 *      the SUCCESSFUL alternative instead, corrupting the provenance log's
 *      only record of what the failed claim actually said.
 *
 * @param {AuditCandidateEnvelope} envelope
 * @param {number} altIndex - index into evidenceAlternatives to promote
 * @returns {AuditCandidateEnvelope}
 */
/**
 * Flatten one union member of `runTieredAuditPipeline`'s findings union into
 * a homogeneous `Finding`-shaped object (tiered-recall pipeline Phase 11,
 * Gemini gate fix G1, round 4). The union mixes `AuditCandidateEnvelope`
 * objects (verified / reversed / stage1_confirmed_survivor / pending*) with
 * already-flat `Finding` objects (`stage2_missed_candidate` — never wrapped
 * in an envelope) — `AuditRunResultSchema` requires a flat `Finding[]`
 * (`f.severity`/`f.is_quick_fix` reads, schema validation), so every member
 * must pass through this function before the final `findings` array is
 * built.
 *
 * - An envelope: spreads `canonicalFinding`'s flat properties, appends a
 *   short "Alternative evidence" summary of `evidenceAlternatives` into
 *   `detail` (mirrors Phase 12's own transcript-fix precedent — provenance
 *   is never silently dropped), and tags the terminal `stageDecisions`
 *   entry's `outcome` as `_stage2Outcome` (falls back to the terminal
 *   Stage 1 outcome when no Stage 2 decision was ever recorded — e.g.
 *   `stage1_confirmed_survivor`, which routes to the human queue directly
 *   without ever reaching Stage 2).
 * - An already-flat finding (no `canonicalFinding`/`evidenceAlternatives`):
 *   passed through unchanged (identity) — this is what makes the function
 *   safe to map over a HETEROGENEOUS union without a caller-side type check.
 *
 * @param {object} envelopeOrFinding
 * @returns {object} a flat Finding-shaped object
 */
export function flattenEnvelopeToFinding(envelopeOrFinding) {
  if (!envelopeOrFinding || typeof envelopeOrFinding !== 'object') return envelopeOrFinding;
  // Identity for already-flat input — an envelope always carries both of
  // these; a flat Finding (e.g. a stage2_missed_candidate) carries neither.
  if (!('canonicalFinding' in envelopeOrFinding) && !('evidenceAlternatives' in envelopeOrFinding)) {
    return envelopeOrFinding;
  }
  const { canonicalFinding, evidenceAlternatives = [], stageDecisions = [] } = envelopeOrFinding;
  const altLines = evidenceAlternatives
    .filter((alt) => alt && alt.rawDetail !== canonicalFinding?.detail)
    .map((alt) => `- ${alt.sourceModel ?? 'unknown'} (${alt.evidenceType ?? 'n/a'})${alt.verificationFailed ? ' [unverified anchor]' : ''}: ${alt.rawDetail ?? ''}`.trim());
  const detail = altLines.length > 0
    ? `${canonicalFinding?.detail ?? ''}\n\nAlternative evidence:\n${altLines.join('\n')}`
    : (canonicalFinding?.detail ?? '');
  const terminalDecision = [...stageDecisions].reverse().find((d) => d?.outcome);
  return {
    ...canonicalFinding,
    detail,
    _stage2Outcome: terminalDecision?.outcome ?? null,
  };
}

export function promoteAlternative(envelope, altIndex) {
  const alt = envelope.evidenceAlternatives[altIndex];
  if (!alt) return envelope;
  const oldCanonical = envelope.canonicalFinding;

  // The failed original claim, preserved in evidenceAlternatives-entry shape
  // (never the successful alt's fields) so its provenance record stays intact.
  const demoted = {
    sourceModel: oldCanonical._sourceModel ?? oldCanonical.sourceModel ?? 'unknown',
    evidenceType: oldCanonical.evidenceType ?? null,
    anchor: oldCanonical.anchor ?? null,
    triggerAnchor: oldCanonical.triggerAnchor ?? null,
    causalChain: oldCanonical.causalChain ?? null,
    rawDetail: oldCanonical.detail ?? '',
    verificationFailed: true,
  };
  const nextAlternatives = envelope.evidenceAlternatives.map((a, i) => (i === altIndex ? demoted : a));

  // The new canonical: the OLD finding's envelope-level fields (id, severity,
  // category, section, ...) with `detail` explicitly remapped from
  // `alt.rawDetail` (the promoted claim's own prose) and the evidence fields
  // taken from `alt` — never a blind spread that could leave a stale `.detail`
  // paired with a fresh `.anchor`.
  const promotedCanonical = {
    ...oldCanonical,
    detail: alt.rawDetail ?? oldCanonical.detail,
    evidenceType: alt.evidenceType ?? oldCanonical.evidenceType,
    anchor: alt.anchor ?? null,
    triggerAnchor: alt.triggerAnchor ?? null,
    causalChain: alt.causalChain ?? null,
  };

  return {
    ...envelope,
    canonicalFinding: promotedCanonical,
    evidenceAlternatives: nextAlternatives,
  };
}
