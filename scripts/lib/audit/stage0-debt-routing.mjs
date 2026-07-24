/**
 * @fileoverview Pre-existing-independent candidate → debt-ledger routing
 * (tiered-recall pipeline decision #9). Self-contained: batch-reconciled
 * debt routing with zero coupling to any other Stage 0 module.
 *
 * Extracted from `tiered-pipeline.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/lib/audit/stage0-debt-routing
 */

import { writeDebtEntries } from '../debt-ledger.mjs';
import { buildDebtEntry } from '../debt-capture.mjs';

/**
 * Extract the file a `pre_existing_independent` envelope's canonical claim
 * cites — the discovery generator's output contract (the producer finding
 * `canonicalFinding` is shaped by) carries no `affectedFiles`/`_primaryFile`
 * field at all, so this reuses the SAME anchor-file extraction Gate B itself
 * already performs internally. Still true post-V3: the anchor's paths are now
 * DERIVED by `prepareCandidates` rather than model-supplied, but they land in
 * the same `oldFile`/`newFile` fields this reads.
 */
export function extractCanonicalAnchorFile(canonicalFinding) {
  const anchorField = canonicalFinding?.evidenceType === 'omission' ? 'triggerAnchor' : 'anchor';
  const anchor = canonicalFinding?.[anchorField];
  if (!anchor) return null;
  return anchor.side === 'base' ? anchor.oldFile : anchor.newFile;
}

export const PRE_EXISTING_DEBT_RATIONALE = 'Pre-existing code, independent of this change — Stage 0 evidence-relevance triage (tiered-recall pipeline decision #9) confirmed the cited lines predate the audited commit and no changed file depends on them.';

/**
 * Transform a `pre_existing_independent` envelope into a PersistedDebtEntry
 * payload via the existing `buildDebtEntry` primitive — `deferredReason:
 * 'out-of-scope'` requires no extra conditional fields, matching this
 * fully-automated (no operator-authored rationale) routing path.
 */
export function buildPreExistingDebtEntry(envelope, runId) {
  const cf = envelope.canonicalFinding || {};
  const filePath = extractCanonicalAnchorFile(cf);
  const finding = {
    _topicId: envelope.fingerprint,
    _hash: envelope.fingerprint,
    severity: cf.severity,
    category: cf.category,
    section: cf.section,
    detail: cf.detail,
    affectedFiles: filePath ? [filePath] : [],
    affectedPrinciples: cf.principle ? [cf.principle] : [],
    _pass: 'tiered-stage0',
    classification: cf.classification || null,
  };
  const { entry } = buildDebtEntry(finding, {
    deferredReason: 'out-of-scope',
    deferredRationale: PRE_EXISTING_DEBT_RATIONALE,
    deferredRun: String(runId || 'tiered').slice(0, 40),
  });
  return entry;
}

/**
 * Batch-reconciled debt routing (decision #9): build ALL
 * `preExistingIndependent` candidates into debt entries up front (keyed by
 * `fingerprint`/`topicId`) and submit as ONE `writeDebtEntries` batch. Any
 * fingerprint that either (a) throws during the whole-batch write, or (b)
 * appears in the API's own `rejected[]` array, is restored to the Stage-1-
 * eligible pool — never silently dropped. `noDebtLedger`/`readOnlyDebt`
 * (existing CLI flags governing every other debt-ledger interaction in this
 * codebase) short-circuit to the same restore-with-reason path, never a
 * silent write attempt.
 *
 * @returns {Promise<{eligible: Array<object>, debtRoutedFiles: string[], debtRoutingIncomplete: Array<{fingerprint:string, reason:string}>}>}
 */
export async function routePreExistingIndependent(preExistingIndependent, ctx) {
  if (preExistingIndependent.length === 0) {
    return { eligible: [], debtRoutedFiles: [], debtRoutingIncomplete: [] };
  }
  if (ctx.noDebtLedger || ctx.readOnlyDebt) {
    return {
      eligible: preExistingIndependent,
      debtRoutedFiles: [],
      debtRoutingIncomplete: preExistingIndependent.map((env) => ({
        fingerprint: env.fingerprint,
        reason: ctx.noDebtLedger ? 'debt_ledger_disabled' : 'debt_ledger_read_only',
      })),
    };
  }

  const entries = preExistingIndependent.map((env) => buildPreExistingDebtEntry(env, ctx.runId));
  let writeResult;
  try {
    writeResult = await writeDebtEntries(entries, ctx.debtLedgerPath ? { ledgerPath: ctx.debtLedgerPath } : {});
  } catch (err) {
    return {
      eligible: preExistingIndependent,
      debtRoutedFiles: [],
      debtRoutingIncomplete: preExistingIndependent.map((env) => ({
        fingerprint: env.fingerprint,
        reason: `writeDebtEntries threw: ${err.message}`,
      })),
    };
  }

  const rejectedByTopicId = new Map((writeResult.rejected || []).map((r) => [r.entry?.topicId, r.reason]));
  const eligible = [];
  const debtRoutedFiles = [];
  const debtRoutingIncomplete = [];
  for (const env of preExistingIndependent) {
    if (rejectedByTopicId.has(env.fingerprint)) {
      eligible.push(env);
      debtRoutingIncomplete.push({ fingerprint: env.fingerprint, reason: rejectedByTopicId.get(env.fingerprint) || 'rejected by writeDebtEntries' });
    } else {
      const filePath = extractCanonicalAnchorFile(env.canonicalFinding);
      if (filePath) debtRoutedFiles.push(filePath);
    }
  }
  return { eligible, debtRoutedFiles: [...new Set(debtRoutedFiles)], debtRoutingIncomplete };
}
