/**
 * @fileoverview Persist automatic `finding_equivalence` links
 * (docs/plans/audit-telemetry-capture.md Decision 6) and account for them.
 *
 * Both callers -- the ledger writer (concern links) and semantic-suppress -- know a
 * (duplicate, canonical) fingerprint pair and nothing else. This module sends each
 * pair through the registered `audit.equivalence` durable writer, tallies every
 * outcome by name, and records the tally under `write_outcomes.equivalence` on the
 * run, so a query for re-raise rate can report itself as the lower bound it is.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/equivalence-links
 */

/** The tally every caller reports: nothing a link can do is left uncounted. */
export function emptyEquivalenceTally() {
  return {
    expected: 0, written: 0, spilled: 0, lost: 0,
    'skipped:endpoint': 0, 'skipped:ambiguous-repo': 0, 'skipped:cycle': 0, 'skipped:manual': 0, 'skipped:other': 0,
    'skipped:no-fingerprint': 0,
  };
}

/**
 * Fold one `durableWrite` result into the tally.
 * @param {ReturnType<typeof emptyEquivalenceTally>} tally
 * @param {{outcome: string, error?: string}} out
 */
export function tallyEquivalenceOutcome(tally, out) {
  tally.expected++;
  if (out.outcome === 'written') tally.written++;
  else if (out.outcome === 'spilled') tally.spilled++;
  else if (out.outcome === 'lost') tally.lost++;
  else if (out.outcome === 'skipped') {
    const key = typeof out.error === 'string' && out.error.startsWith('skipped:') && Object.hasOwn(tally, out.error) ? out.error : 'skipped:other';
    tally[key]++;
  } else tally.lost++; // an unknown outcome is not a success
  return tally;
}

/**
 * @param {object} args
 * @param {{duplicateFingerprint: string, canonicalFingerprint: string}[]} args.links
 * @param {string|null} args.runId - the run whose receipt carries the tally
 * @param {'semantic-suppress'|'concern-v1'} args.createdBy
 * @param {number} [args.unfingerprinted] - links the caller could not name by fingerprint; counted as skipped
 * @param {object} args.deps - `{durableWrite, recordWriteReceipt}` (injected; this module imports no store)
 * @returns {Promise<ReturnType<typeof emptyEquivalenceTally>>}
 */
export async function recordEquivalenceLinks({ links, runId, createdBy, deps, unfingerprinted = 0 }) {
  const tally = emptyEquivalenceTally();
  // Links the caller could not even name by fingerprint (a debt-entry target, an older ledger entry): counted, never dropped.
  tally.expected += unfingerprinted;
  tally['skipped:no-fingerprint'] += unfingerprinted;
  for (const link of links) {
    // A write that throws is still a link that did not land: count it, never let it hide the rest.
    let out;
    try {
      out = await deps.durableWrite('audit.equivalence', {
        run_id: runId, duplicateFingerprint: link.duplicateFingerprint, canonicalFingerprint: link.canonicalFingerprint, createdBy,
      });
    } catch (err) {
      out = { outcome: 'lost', error: err.message };
    }
    tallyEquivalenceOutcome(tally, out);
  }
  if (runId && tally.expected > 0) {
    // ACCUMULATED: several batches report on one run, and a later clean one must not erase an earlier batch's losses.
    const stored = await deps.recordWriteReceipt(runId, 'equivalence', tally, { accumulate: true });
    tally.receiptApplied = stored?.applied === true;
  }
  return tally;
}
