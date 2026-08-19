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
 * The CLOSED set of `[Architecture]` categories the MECHANICAL architecture
 * pass is allowed to emit. That pass is the only one that receives the domain
 * map (`allowedDeps`), so it is the only one that can legitimately assert a
 * declared-boundary fact. Single source of truth — the mechanical pass in
 * `legacy-production-audit.mjs` imports this and labels from it, and
 * `normalizeArchCategory` reserves the namespace against it.
 */
export const MECHANICAL_ARCH_CATEGORIES = Object.freeze(new Set([
  '[Architecture] Invalid domain-map.json',
  '[Architecture] Forbidden cross-domain edge',
  '[Architecture] File missing domain rule',
  '[Architecture] Dead declared domain',
]));

/**
 * The label a general (non-mechanical) pass's architecture opinion is demoted
 * to. It is a coupling OBSERVATION, never a boundary VIOLATION — the pass
 * cannot see the domain map, so it cannot know what is forbidden.
 */
export const COUPLING_CONCERN_CATEGORY = 'Coupling concern';

/**
 * Reserve the `[Architecture]` category namespace for the mechanical pass.
 *
 * Why (2026-07-20): the general LLM passes (structure/wiring/backend/frontend/
 * sustainability) do NOT receive `allowedDeps`, yet were emitting findings like
 * `[Architecture] Boundary Erosion` / `Layer Boundary Violation` asserting a
 * declared-boundary violation they had no evidence for — 15 invented category
 * names for one concept, each fingerprinting differently, driving the
 * memory-health cluster-density trigger. The concrete case
 * (`brainstorm → requirements`) is an edge the domain map EXPLICITLY ALLOWS.
 *
 * The prompt (prompt-seeds.mjs `NO_DECLARED_ARCH_VERDICTS`) tells the passes not
 * to do this; this is the mechanical BACKSTOP for when a probabilistic model
 * ignores the instruction — the same "the bouncer only judges what it's handed"
 * philosophy the adjacency wave uses. An `[Architecture]`-prefixed category that
 * is NOT one the mechanical pass emits is demoted to `Coupling concern`; the
 * finding is KEPT (the coupling it names may be real), only its unfounded
 * boundary-violation FRAMING is stripped. Mechanical-pass findings pass through
 * untouched — matched by exact category, not by `is_mechanical` (one mechanical
 * category legitimately carries `is_mechanical:false`).
 *
 * Pure; returns a new object when it relabels, the same reference otherwise.
 * @param {{category?: string}} f
 * @returns {object}
 */
export function normalizeArchCategory(f) {
  const cat = f?.category;
  if (typeof cat !== 'string') return f;
  if (!cat.startsWith('[Architecture]')) return f;
  if (MECHANICAL_ARCH_CATEGORIES.has(cat)) return f;
  return { ...f, category: COUPLING_CONCERN_CATEGORY };
}

/**
 * Compute a stable fingerprint for a finding.
 *
 * For `orphan-introduced` findings (Gemini-G1 + R5/H1 + audit-code R1/M4):
 *   - left-orphan: hash over {kind, subKind, file, sortedAllRemovedCallers}
 *   - born-orphan: hash over {kind, subKind, file}
 *   The orphan fingerprint is fully structural — no prose, no truncated lists.
 *
 * For `event-wiring-symmetry` findings (docs/plans/event-wiring-symmetry.md
 * R3/M2, corrected R4/H1): hash over {kind, eventName} — `eventName` ALONE,
 * never the file path (the same event dispatched from two files must
 * collapse to one record, not double-count `E`) and never `triggers[]`
 * (which is DATA, not identity — a trigger-inclusive key fragmented the
 * same event into two fingerprints depending on which trigger fired on
 * which run, the exact bug this correction fixes).
 *
 * For `event-wiring-orphaned-pragma` findings (Gemini round-4 G1, R4/L1,
 * Cluster-B audit-code R1/L2): hash over {kind, path, pragmaTextHash,
 * dedupeOrdinal} — it has no event name and no dispatch site, so the
 * pragma's own location + content is the only available identity, and
 * keying on content (not line number) keeps it stable under unrelated
 * reformatting elsewhere in the file. `dedupeOrdinal` (0-based, assigned at
 * construction in event-wiring-corpus.mjs) disambiguates two byte-identical
 * pragma texts in the same file, which would otherwise collide.
 *
 * For other findings (LLM passes, future mechanical passes): delegates to
 * findings.mjs/semanticId() — same canonical-evidence path used everywhere
 * else in the audit pipeline (audit-code R1/M8 — single SoT for identity).
 *
 * @param {object} f - raw finding
 * @returns {string} 8-char hex hash
 */
export function findingFingerprint(f) {
  if (f.kind === 'event-wiring-symmetry') {
    const canonical = `${f.kind}|${f.eventName || ''}`;
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  }
  if (f.kind === 'event-wiring-orphaned-pragma') {
    const path_ = normalizePath(f.locus?.path || '');
    const textHash = crypto.createHash('sha256').update(f.pragmaText || '').digest('hex').slice(0, 8);
    // R1/L2 fix: fold in the constructor-assigned `dedupeOrdinal` so two
    // byte-identical pragma texts in the SAME file don't collide to one
    // fingerprint (see event-wiring-corpus.mjs's orphanedPragmasToFindings).
    // Absent (any non-event-wiring-orphaned-pragma caller, or a hand-built
    // test fixture) defaults to 0 — the common single-occurrence case is
    // unaffected.
    const canonical = `${f.kind}|${path_}|${textHash}|${f.dedupeOrdinal ?? 0}`;
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  }
  if (f.kind === 'orphan-introduced') {
    const file = normalizePath(f.file || '');
    let canonical;
    if (f.subKind === 'left-orphan') {
      // Consolidated Gemini gate fix G4: `localeCompare` is host-locale-
      // dependent (developer laptop vs CI runner can order the SAME array
      // differently), which would fingerprint the identical finding
      // differently across environments — a real risk for THIS diff's new
      // `applyStage1MechanicalEarlyFilter`/`applyLedgerSuppression`
      // exclusion logic (Cluster D), both of which key off `_fingerprint`
      // and assume it is stable across machines. A plain ordinal
      // comparison is deterministic everywhere.
      const callers = Array.isArray(f.allRemovedCallers)
        ? [...f.allRemovedCallers].map(c => normalizePath(c)).sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
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
    // stage1-mechanical entries are deliberately EXCLUDED from this exact-match
    // permanent-suppression path (tiered-recall pipeline Phase 8) — they route
    // through `applyStage1MechanicalEarlyFilter` (a cost-saving fast path only)
    // and the round-boundary `suppressReRaises` (the sole AUTHORITATIVE
    // suppression/reopen mechanism for this source), never this one.
    if (e.source === 'stage1-mechanical') continue;
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
 * Cheap early filter for `stage1-mechanical` ledger entries (tiered-recall
 * pipeline Phase 8, Gemini gate round-2 finding #G4) — a COST-SAVING FAST
 * PATH ONLY, never a correctness path. Without this, a still-dismissed
 * mechanical candidate would get re-verified by Stage 0/1 and potentially
 * re-reviewed by the expensive Stage 2 Gemini adjudicator on every
 * subsequent round until its file happens to be touched — an LLM-cost leak.
 *
 * A finding is dropped early ONLY when: (a) it matches a `stage1-mechanical`
 * ledger entry by fingerprint/topicId, AND (b) that entry's file is NOT in
 * the current round's `changedFiles`. On any doubt (no `changedFiles`
 * supplied, ambiguous match) the candidate falls through to the normal
 * pipeline — `suppressReRaises` remains the sole AUTHORITATIVE reopen
 * mechanism; a false-negative here (failing to early-drop) only costs an
 * extra verification pass, while a false-positive (wrongly early-dropping)
 * would hide a genuine reopen, which this function must never risk.
 *
 * @param {Array<object>} findings - already-fingerprinted findings
 * @param {object} ledger
 * @param {string[]} changedFiles - this round's changed files (normalized by the caller
 *   is NOT required — this function normalizes internally)
 * @returns {{kept: object[], dropped: object[]}}
 */
function applyStage1MechanicalEarlyFilter(findings, ledger, changedFiles) {
  if (!ledger || !Array.isArray(ledger.entries)) return { kept: findings, dropped: [] };
  if (!Array.isArray(changedFiles)) return { kept: findings, dropped: [] }; // ambiguous — never drop without a changed-file set to check against

  const changedSet = new Set(changedFiles.map(normalizePath));
  const stage1MechanicalByKey = new Map();
  for (const e of ledger.entries) {
    if (e.source !== 'stage1-mechanical') continue;
    // consolidated-gate fix (Gemini gate, round 1 — verified genuine: this
    // function's own docstring below states "never a correctness path...
    // a false-positive (wrongly early-dropping) would hide a genuine
    // reopen, which this function must never risk" — but it never checked
    // `remediationState`. A `stage1-mechanical` entry's `adjudicationOutcome`
    // is schema-fixed to `'dismissed'` (Stage1MechanicalLedgerEntrySchema),
    // but `remediationState` can become `'regressed'` (ledger.mjs's own
    // documented state model: "stage2_reversed — Gemini overturned a
    // stage1_mechanical_dismissed... entry") — meaning the dismissal was
    // overturned and should no longer be silently suppressed. Skipping a
    // regressed entry here means it falls through to `suppressReRaises`,
    // the function's own stated sole AUTHORITATIVE reopen mechanism.
    if (e.remediationState === 'regressed') continue;
    if (e.fingerprint) stage1MechanicalByKey.set(e.fingerprint, e);
    if (e.topicId) stage1MechanicalByKey.set(e.topicId, e);
  }
  if (stage1MechanicalByKey.size === 0) return { kept: findings, dropped: [] };

  const kept = [];
  const dropped = [];
  for (const f of findings) {
    const entry = stage1MechanicalByKey.get(f._fingerprint);
    if (!entry) { kept.push(f); continue; }
    // audit fix H3, round 2: check BOTH the ledger entry's (historical)
    // affectedFiles AND the CURRENT finding's own file — the original
    // version checked only the entry's stale affectedFiles, which could
    // wrongly early-drop a same-fingerprint finding now reported against a
    // newly-changed file the original dismissal never touched. Either
    // signal indicating "this area was touched" is enough to keep it (the
    // "never a correctness path" invariant means false-negatives here — an
    // unnecessary keep — are always the safe direction).
    const entryFiles = (entry.affectedFiles || []).map(normalizePath);
    const findingFile = normalizePath(f.file || f._primaryFile || '');
    const fileInChangedSet = entryFiles.some((ef) => changedSet.has(ef)) || (findingFile && changedSet.has(findingFile));
    if (fileInChangedSet) {
      kept.push(f); // possible reopen-on-touch — let suppressReRaises decide authoritatively
    } else {
      dropped.push({ ...f, suppressedBy: 'stage1-mechanical-early-filter' });
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
 *   3. Ledger suppression (R2+ only; excludes stage1-mechanical entries).
 *   3.5. stage1-mechanical cheap early filter (cost-saving fast path only —
 *        tiered-recall pipeline Phase 8; see `applyStage1MechanicalEarlyFilter`).
 *   4. accept-v1 marker suppression.
 *
 * @param {Array<object>} rawFindings
 * @param {object} ctx
 * @param {object} [ctx.ledger] - parsed adjudication ledger (R2+ only)
 * @param {string} [ctx.planContent] - plan markdown (for accept-v1)
 * @param {string[]} [ctx.changedFiles] - this round's changed files, for the
 *   stage1-mechanical early filter; omitted → that step is a no-op (never drops)
 * @returns {{ survivors: object[], suppressed: object[] }}
 */
/**
 * Compute the coarse-grained audit verdict from a findings array + an
 * `incomplete` signal. Extracted (tiered-recall pipeline Phase 11, audit-plan
 * fix — Gemini final gate round-1 G1) from `runMultiPassCodeAudit`'s original
 * inline logic (`openai-audit.mjs` ~line 2748-2759 pre-extraction) so BOTH
 * `runLegacyProductionAudit` and `runTieredAuditPipeline` share ONE verdict
 * function instead of two independently-maintained copies that could drift.
 *
 * Legacy-path callers must pre-normalise `findings` so `.severity` already
 * reflects any verification-gate override (`effSeverity` in the original
 * code) — this function reads `f.severity` verbatim, it does not know about
 * the verification-gate concept.
 *
 * NOTE — the legacy path's map-reduce partial-completion downgrade
 * (`minMapCompletion < 0.66` unconditionally forcing `INCOMPLETE`, even over
 * a SIGNIFICANT_ISSUES/NEEDS_FIXES verdict) is NOT folded in here — it is a
 * legacy-orchestration-specific concept (map-reduce units) the tiered
 * pipeline has no equivalent of, so `runLegacyProductionAudit` applies it as
 * a post-step after calling this function, exactly as the original code did.
 *
 * @param {Array<{severity?: string}>} findings
 * @param {{incomplete?: boolean}} [opts] - `incomplete` only downgrades a
 *   PASS verdict (never a SIGNIFICANT_ISSUES/NEEDS_FIXES one) — matches the
 *   original `if (verdict === 'PASS' && failedPasses.length > 0)` guard.
 * @returns {'PASS'|'NEEDS_FIXES'|'SIGNIFICANT_ISSUES'|'INCOMPLETE'}
 */
export function computeAuditVerdict(findings, { incomplete = false } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  // D10 fail-closed (docs/plans/event-wiring-symmetry.md — a plan finding
  // originally named final-adjudication.mjs as this guarantee's owner; that
  // file turned out to be Stage-2 tiered-pipeline-specific and unrelated to
  // verdict computation, corrected after reading the real call graph).
  // Both `computeAuditVerdict` callers (legacy-production-audit.mjs,
  // tiered-pipeline.mjs) must honour this, and only the legacy caller
  // pre-filters via `countsTowardVerdict` — so the check lives HERE, in the
  // one function both pipelines share, rather than depending on every
  // caller to pre-filter correctly.
  const gating = list.filter(f => f?.enforcement !== 'advisory');
  const high = gating.filter(f => f?.severity === 'HIGH').length;
  const medium = gating.filter(f => f?.severity === 'MEDIUM').length;
  let verdict = 'PASS';
  if (high > 0) verdict = 'SIGNIFICANT_ISSUES';
  else if (medium > 2) verdict = 'NEEDS_FIXES';
  if (verdict === 'PASS' && incomplete) verdict = 'INCOMPLETE';
  return verdict;
}

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

  // 3.5: stage1-mechanical cheap early filter
  const afterStage1Early = applyStage1MechanicalEarlyFilter(afterLedger.kept, ctx.ledger, ctx.changedFiles);

  // 4: accept-v1 suppression
  const afterAcceptV1 = applyAcceptV1Suppression(afterStage1Early.kept, ctx.planContent);

  return {
    survivors: afterAcceptV1.kept,
    suppressed: [...afterLedger.dropped, ...afterStage1Early.dropped, ...afterAcceptV1.dropped],
  };
}
