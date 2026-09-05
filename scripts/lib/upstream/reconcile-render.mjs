/**
 * @fileoverview The human-grade reconciliation report — the prose a
 * `upstream reconcile` run prints.
 *
 * Split out of `commands.mjs` when it passed the size ratchet. The seam is
 * rendering vs decision: nothing here reads the store, the ledger, or git; it
 * turns an already-classified reconciliation into PowerShell-safe lines. That
 * also means its only dependency is the `MISSING_CAUSE` vocabulary.
 *
 * Plan: docs/plans/reconcile-attribution-and-base-freshness.md (Cluster B).
 *
 * @module scripts/lib/upstream/reconcile-render
 */

import { MISSING_CAUSE } from './dispositions.mjs';

/**
 * The sentence a missing-entry gap gets, keyed on its CLASSIFIED cause.
 *
 * The renderer used to print one explanation for every such row — *"the accepted
 * crash-window gap"* — and the two real causes take opposite remedies. Each
 * branch below names what was ruled out and what remains, rather than asserting
 * a cause from evidence that only eliminates one.
 */
function renderMissingCauseLines(ids, missingCause) {
  const head = `Terminal db row(s) with NO ledger entry (${ids.length})`;
  if (!missingCause) return [`${head}:`];
  const { cause, presentUpstream, freshness } = missingCause;
  const up = freshness?.upstream || 'the upstream';

  if (cause === MISSING_CAUSE.STALE) {
    return [
      `${head} — YOUR CHECKOUT IS STALE, not a lost write:`,
      `  This checkout is ${freshness.behindBy} commit(s) behind ${up}, where all ${presentUpstream.length}`,
      '  of these entries already exist. Run `git pull` — do NOT hand-write them,',
      '  which would duplicate entries that are already pushed.',
    ];
  }
  if (cause === MISSING_CAUSE.MIXED) {
    return [
      `${head} — PARTLY staleness:`,
      `  ${presentUpstream.length} of ${ids.length} already exist ${freshness.behindBy} commit(s) ahead on ${up}.`,
      '  Run `git pull` first, then re-run reconcile to see what genuinely remains.',
    ];
  }
  if (cause === MISSING_CAUSE.UNKNOWN) {
    return [
      `${head} — CAUSE UNDETERMINED:`,
      `  Could not establish whether this is staleness (${freshness?.reason || missingCause.evidenceStatus}).`,
      '  Fetch and re-run, or inspect manually. Repair is refused while the cause is unknown.',
    ];
  }
  // NOT_STALENESS — say what was ruled out, and list what is left. Naming a
  // single cause here would be the original defect with a different label.
  return [
    `${head} — staleness does NOT explain it:`,
    `  ${freshness?.state === 'current' ? `This checkout is current with ${up}.` : `${up} does not contain them.`}`,
    '  Remaining causes: the ledger write was lost between the local write and the DB',
    '  write; the entry was deleted locally; or your remote-tracking ref is itself',
    '  stale (this never fetches). Inspect before repairing.',
  ];
}

/** Human-grade reconciliation report — PowerShell-safe, mirrors renderWorksheet. */
export function renderReconciliationReport({
  missingFromLedger, ledgerOnly, stateMismatch, dispositionMismatch = [], needsReview,
  otherStore = [], coverage = null, missingCause = null,
}) {
  // WHAT THIS RUN CHECKED, in the verdict rather than above it. `clean` was
  // true of the rows it saw while 20 of 43 entries were never compared — the
  // same shape as a drift score of 0 that does not say over how many symbols.
  // When the store identity could not be derived, `checked` is a CEILING, not a
  // measurement — nothing could be scoped out, so the count says only "at most
  // this many". Saying "N of N checked" there would be the field's own defect.
  const coverageLine = coverage
    ? (coverage.storeScoped === false
      ? `store identity unknown — at most ${coverage.checked} of ${coverage.total} ledger entries could be scoped`
      : `${coverage.checked} of ${coverage.total} ledger entries checked`)
    : null;
  const clean = missingFromLedger.length === 0 && ledgerOnly.length === 0
    && stateMismatch.length === 0 && dispositionMismatch.length === 0 && needsReview.length === 0;
  // `otherStore` is deliberately NOT part of `clean`: it is not divergence, it
  // is scope. But it is still PRINTED on a clean run, because an entry nothing
  // in this run can adjudicate should never be invisible — that silence is how
  // a genuinely stale foreign entry would live forever.
  const outOfScope = otherStore.length
    ? [
      `Not reconciled — ${otherStore.length} ledger entr(y/ies) belong to another store:`,
      ...otherStore.map((e) => `  - ${e}`),
      '  These are out of scope for this run, not divergence. To check them, re-run',
      '  reconcile with the AUDIT_DB_URL of the store named above.',
      '',
    ]
    : [];
  if (clean) {
    return [
      `Reconciliation: clean — ${coverageLine ? `${coverageLine}; ` : ''}every terminal db row matches a ledger entry, and no row needs manual review.`,
      ...(coverage?.foreign ? [`  ${coverage.foreign} entr(y/ies) belong to another store and were NOT checked — re-run with that AUDIT_DB_URL.`] : []),
      ...(outOfScope.length ? ['', ...outOfScope] : []),
    ].join('\n');
  }

  const lines = [
    `Reconciliation — divergence found${coverageLine ? ` (${coverageLine})` : ''}:`,
    '', ...outOfScope,
  ];
  if (missingFromLedger.length) {
    lines.push(...renderMissingCauseLines(missingFromLedger, missingCause));
    for (const id of missingFromLedger) lines.push(`  - ${id}`);
    lines.push('');
  }
  if (ledgerOnly.length) {
    lines.push(`Ledger entr(y/ies) with no matching db row (${ledgerOnly.length}) — stale, or the issueId was mistyped:`);
    for (const id of ledgerOnly) lines.push(`  - ${id}`);
    lines.push('');
  }
  if (stateMismatch.length) {
    lines.push(`State mismatch between ledger and db (${stateMismatch.length}):`);
    for (const m of stateMismatch) lines.push(`  - ${m}`);
    lines.push('');
  }
  if (dispositionMismatch.length) {
    lines.push(`Disposition VALUE mismatch between ledger and db (${dispositionMismatch.length}):`);
    for (const m of dispositionMismatch) lines.push(`  - ${m}`);
    lines.push('');
  }
  if (needsReview.length) {
    lines.push(`Row(s) still carrying the generation-time catch-all (${needsReview.length}) — needs a REAL, researched disposition:`);
    for (const id of needsReview) lines.push(`  - ${id}`);
    lines.push('');
  }
  return lines.join('\n');
}
