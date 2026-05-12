/**
 * @fileoverview Unified post-processing pipeline for raw findings (mechanical
 * passes + LLM passes). Normalises shape, fingerprints, applies ledger
 * suppression + accept-v1 marker suppression. Returns `{survivors, suppressed}`.
 *
 * Pipeline is pure-data: NO I/O, NO telemetry emission. Each pass orchestration
 * owns its own metrics-sink call on the return (Gemini-R4/H1 — keeps the
 * pipeline reusable across pass types).
 *
 * @module scripts/lib/audit/findings-pipeline
 */

import crypto from 'node:crypto';
import { normalizePath } from '../file-io.mjs';
import { semanticId } from '../findings.mjs';
import { parseAcceptV1Markers } from './deferral-classifier.mjs';
import { globMatch } from './glob-match.mjs';

/**
 * Compute a stable fingerprint for a finding.
 *
 * For `orphan-introduced` findings (Gemini-G1 + R5/H1 + audit-code R1/M4):
 *   - left-orphan: hash over {kind, subKind, file, sortedAllRemovedCallers}
 *   - born-orphan: hash over {kind, subKind, file}
 *   The orphan fingerprint is fully structural — no prose, no truncated lists.
 *
 * For other findings (LLM passes, future mechanical passes): delegates to
 * findings.mjs/semanticId() — same canonical-evidence path used everywhere
 * else in the audit pipeline (audit-code R1/M8 — single SoT for identity).
 *
 * @param {object} f - raw finding
 * @returns {string} 8-char hex hash
 */
export function findingFingerprint(f) {
  if (f.kind === 'orphan-introduced') {
    const file = normalizePath(f.file || '');
    let canonical;
    if (f.subKind === 'left-orphan') {
      const callers = Array.isArray(f.allRemovedCallers)
        ? [...f.allRemovedCallers].map(c => normalizePath(c)).sort((a, b) => a.localeCompare(b))
        : [];
      canonical = `${f.kind}|${f.subKind}|${file}|${callers.join(',')}`;
    } else {
      canonical = `${f.kind}|${f.subKind}|${file}`;
    }
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  }
  // Delegate generic findings to the shared semanticId path so all passes
  // produce consistent identities for ledger matching (M8 SoT alignment).
  return semanticId(f);
}

/**
 * Apply ledger suppression: drop findings whose fingerprint matches an entry
 * with `adjudicationOutcome === 'dismissed'` (or `severity_adjusted-to-zero`).
 *
 * Audit-code R1/H2 fix — does NOT treat `remediationState: 'fixed'/'verified'`
 * as suppression. Those are HISTORICAL outcomes — if a fixed file later
 * regresses (e.g. another diff re-orphans it), the new occurrence must surface.
 * Only an explicit operator decision (`adjudicationOutcome === 'dismissed'`)
 * suppresses future detections.
 *
 * Uses the existing R2+ ledger entries' `fingerprint` field if present; falls
 * back to the entry's `topicId` for older entries.
 */
function applyLedgerSuppression(findings, ledger) {
  if (!ledger || !Array.isArray(ledger.entries)) return { kept: findings, dropped: [] };

  const dismissedFingerprints = new Set();
  for (const e of ledger.entries) {
    const isDismissed =
      e.adjudicationOutcome === 'dismissed' ||
      e.adjudicationOutcome === 'severity_adjusted-to-zero';
    if (!isDismissed) continue;
    if (e.fingerprint) dismissedFingerprints.add(e.fingerprint);
    if (e.topicId) dismissedFingerprints.add(e.topicId);
  }

  const kept = [];
  const dropped = [];
  for (const f of findings) {
    if (dismissedFingerprints.has(f._fingerprint)) {
      dropped.push({ ...f, suppressedBy: 'ledger' });
    } else {
      kept.push(f);
    }
  }
  return { kept, dropped };
}

/**
 * Apply accept-v1 marker suppression. Findings whose `file` matches any
 * `audit:accept-v1` marker glob in the plan markdown are suppressed.
 *
 * **Gemini-final-gate wrongly-dismissed-H1 fix — kind-scoped suppression**:
 * accept-v1 markers in phase 1 are an operator override for the `orphan-introduced`
 * pass specifically. Without a kind filter, a marker added to silence an orphan
 * on a file would ALSO silence unrelated future findings (security, architecture)
 * on the same file once the pipeline is shared across passes. Phase 1 hardcodes
 * the filter to `kind === 'orphan-introduced'`; phase 2 will extend the marker
 * grammar to accept an optional `:: kind=<finding-kind>` clause.
 */
function applyAcceptV1Suppression(findings, planContent) {
  if (!planContent) return { kept: findings, dropped: [] };
  const markers = parseAcceptV1Markers(planContent);
  if (markers.length === 0) return { kept: findings, dropped: [] };

  const kept = [];
  const dropped = [];
  for (const f of findings) {
    // Kind-scope gate: only orphan-introduced findings are eligible for
    // accept-v1 suppression in phase 1. Other kinds pass through unchanged.
    if (f.kind !== 'orphan-introduced') {
      kept.push(f);
      continue;
    }
    const filePath = f.file || f.section || '';
    const hit = markers.find(m => globMatch(m.fileGlob, filePath));
    if (hit) {
      dropped.push({ ...f, suppressedBy: 'accept-v1', acceptReason: hit.reason });
    } else {
      kept.push(f);
    }
  }
  return { kept, dropped };
}

/**
 * Run the unified post-processing pipeline.
 *
 * Steps:
 *   1. Normalise shape (path canonicalisation, defensive defaults).
 *   2. Fingerprint each finding (attached as `_fingerprint`).
 *   3. Ledger suppression (R2+ only).
 *   4. accept-v1 marker suppression.
 *
 * @param {Array<object>} rawFindings
 * @param {object} ctx
 * @param {object} [ctx.ledger] - parsed adjudication ledger (R2+ only)
 * @param {string} [ctx.planContent] - plan markdown (for accept-v1)
 * @returns {{ survivors: object[], suppressed: object[] }}
 */
export function processFindings(rawFindings, ctx = {}) {
  if (!Array.isArray(rawFindings) || rawFindings.length === 0) {
    return { survivors: [], suppressed: [] };
  }

  // 1 + 2: normalise + fingerprint
  const normalised = rawFindings.map(f => {
    const file = f.file ? normalizePath(f.file) : f.file;
    const out = { ...f, file };
    out._fingerprint = findingFingerprint(out);
    return out;
  });

  // 3: ledger suppression
  const afterLedger = applyLedgerSuppression(normalised, ctx.ledger);

  // 4: accept-v1 suppression
  const afterAcceptV1 = applyAcceptV1Suppression(afterLedger.kept, ctx.planContent);

  return {
    survivors: afterAcceptV1.kept,
    suppressed: [...afterLedger.dropped, ...afterAcceptV1.dropped],
  };
}
