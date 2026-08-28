/**
 * @fileoverview Event-wiring-symmetry audit pass (Wave 1.5c) — deterministic,
 * no LLM call, committed-range-only.
 *
 * Extracted from `legacy-production-audit.mjs` (docs/plans/legacy-production-audit-decomposition.md
 * Phase 3) — a pure relocation, verbatim bodies, no behaviour change.
 *
 * @module scripts/lib/audit/event-wiring-pass
 */

import path from 'node:path';
import { processFindings } from './findings-pipeline.mjs';
import {
  detectEventWiringAsymmetry, resolveEventWiringScopeRefs, buildEventWiringDiffScope, loadEventWiringConfig,
} from './event-wiring-corpus.mjs';

/**
 * Convert a raw event-wiring-symmetry finding (dispatch-only symmetry, or an
 * orphaned suppression pragma) to the standard FindingSchema shape.
 * Mirrors `orphanToStandardFinding`'s shape. `enforcement: 'advisory'`
 * carries through unchanged (spread, not reconstructed) — that field, not
 * `classification.sourceKind`, is what D10 gates on; `sourceKind: 'LINTER'`
 * is set here only for display/reporting parity with the orphan wave (both
 * are mechanical, non-LLM detectors in this codebase's loose use of that
 * label), never relied on for the advisory/gating decision itself.
 *
 * @param {object} raw - finding from `resolveSymmetry`/`extractEventSites` (event-wiring.mjs)
 * @param {number} idx
 * @returns {object} FindingSchema-shaped finding
 */
function eventWiringToStandardFinding(raw, idx) {
  const idSuffix = String(idx).padStart(2, '0');
  if (raw.kind === 'event-wiring-orphaned-pragma') {
    return {
      id: `EWP${idSuffix}`,
      severity: raw.severity,
      enforcement: raw.enforcement,
      category: 'Orphaned event-consumer-external pragma',
      section: raw.locus.path,
      detail: `${raw.rationale} (${raw.pragmaText.trim()})`,
      risk: 'Stale suppression annotation — no longer bound to any dispatch site; misleads future readers about why an event is unconsumed',
      recommendation: 'Remove the pragma, or move it above the dispatch site it is meant to suppress',
      is_quick_fix: false,
      is_mechanical: true,
      is_reopened: false,
      principle: 'Single Source of Truth (#10) — a suppression annotation must stay bound to what it suppresses',
      classification: { sonarType: 'CODE_SMELL', effort: 'TRIVIAL', sourceKind: 'LINTER', sourceName: 'event-wiring-symmetry' },
    };
  }
  return {
    id: `EW${idSuffix}`,
    severity: raw.severity, // 'MEDIUM' | 'LOW'
    enforcement: raw.enforcement, // 'advisory' — D10, never gates
    category: `Event Wiring Asymmetry (${raw.triggers.join('+')})`,
    section: raw.locus.path,
    detail: raw.rationale,
    risk: raw.testOnlyConsumer
      ? 'Contract exercised only by tests — no production consumer wires this event, so real users never receive it'
      : 'A dispatched custom event has no listener anywhere in the repo — the intended fan-out never fires for any real user',
    recommendation: `Wire a listener for '${raw.eventName}', or suppress with a `
      + `// @event-consumer-external: <reason> pragma directly above the dispatch if consumed outside this repo`,
    is_quick_fix: false,
    is_mechanical: true,
    is_reopened: false,
    principle: 'Wiring Completeness — a dispatch with no consumer is invisible dead fan-out',
    classification: { sonarType: 'CODE_SMELL', effort: 'TRIVIAL', sourceKind: 'LINTER', sourceName: 'event-wiring-symmetry' },
  };
}

/**
 * Wave 1.5c — event-wiring-symmetry check (docs/plans/event-wiring-symmetry.md).
 * Runs after the orphan-introduced wave, same deterministic-mechanical-pass
 * shape (no LLM cost). Unlike orphan, this wave is deliberately COMMITTED-
 * RANGE-ONLY — it never runs in dirty-working-tree mode, because D12's
 * lifecycle/ancestry tracking (`git merge-base --is-ancestor`) needs a real,
 * resolvable commit ref; "is the dirty working tree an ancestor of X" has no
 * answer. `resolveEventWiringScopeRefs` therefore ignores `workingTreeDirty`
 * entirely (unlike `resolveOrphanScopeRefs`).
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string|null} args.auditBaseCommit
 * @param {string} args.runId
 * @param {object|null} args.ledger
 * @param {string|null} args.planContent
 * @param {boolean} [args.learningWritesAllowed]
 * @returns {Promise<{state: string, result: object}>}
 */
export async function runEventWiringSymmetryPass({ repoRoot, auditBaseCommit, runId, ledger, planContent, learningWritesAllowed = true }) {
  const emptyResult = {
    result: { pass_name: 'event-wiring-symmetry', findings: [], summary: '' },
    usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: 0,
  };
  const startedAt = Date.now();

  let wrappers;
  let totalByteBudgetMb;
  try {
    ({ wrappers, totalByteBudgetMb } = loadEventWiringConfig(repoRoot));
  } catch (err) {
    // Present-but-invalid config is a hard failure per the CLI's own
    // contract (§7) — the production wave degrades to SKIPPED rather than
    // scanning with built-ins-only, which would silently under-scan a repo
    // whose listeners are entirely behind a custom wrapper.
    process.stderr.write(`  [event-wiring] invalid config, skipping wave: ${err.message}\n`);
    return { state: 'ERROR', result: { ...emptyResult, result: { ...emptyResult.result, summary: `invalid config: ${err.message}` } } };
  }

  const { baseRef, headRef } = resolveEventWiringScopeRefs({ auditBaseCommit });
  let diffScope;
  try {
    diffScope = buildEventWiringDiffScope({ repoPath: repoRoot, baseRef, headRef });
  } catch (err) {
    process.stderr.write(`  [event-wiring] diff-scope build error: ${err.message}\n`);
    return { state: 'ERROR', result: { ...emptyResult, result: { ...emptyResult.result, summary: `diff-scope: ${err.message}` } } };
  }

  const ledgerPath = path.join(repoRoot, '.audit', 'event-wiring-ledger.json');
  let detectorOut;
  try {
    detectorOut = await detectEventWiringAsymmetry({
      diffScope, repoPath: repoRoot, wrappers, totalByteBudgetMb, ledgerPath,
      metricsSinkPath: '.audit/event-wiring-metrics.jsonl', runId, learningWritesAllowed,
    });
  } catch (err) {
    // Cluster-B audit-code R1/H3 fix: this call does non-trivial git I/O
    // (batched blob reads, lock acquisition for D12 reconciliation) and was
    // previously unguarded — an exception here would propagate past this
    // mechanical wave's own caller and crash the WHOLE audit run, the exact
    // failure mode orphan-introduced's own resolver call is already guarded
    // against (see the try/catch around `buildEventWiringDiffScope` above).
    // A mechanical detector degrading to ERROR must never take the run down.
    process.stderr.write(`  [event-wiring] detector error: ${err.message}\n`);
    return { state: 'ERROR', result: { ...emptyResult, result: { ...emptyResult.result, summary: `detector: ${err.message}` } } };
  }

  if (detectorOut.partial) {
    // D11's partial-corpus safety: no new finding, no record close — the
    // metrics write already happened inside detectEventWiringAsymmetry
    // itself (its own step 2.5), gated there on the same
    // `learningWritesAllowed` this function was passed (an earlier draft
    // left this write unconditional, unlike orphan's short-circuit emit —
    // fixed so an observation-only shadow run can't double-count a commit).
    return { state: 'ANALYZED_PARTIAL', result: { ...emptyResult, result: { ...emptyResult.result, summary: `partial scan — ${detectorOut.counters.skippedFiles} file(s) skipped` } } };
  }

  // Post-processing pipeline (fingerprint + ledger-suppress) — same shared
  // path orphan-introduced uses, so R2+ dismiss/fix suppression applies
  // uniformly across mechanical waves. Operates on the RAW event-wiring
  // findings (kind/eventName/locus intact) — `findingFingerprint` already
  // knows the `event-wiring-symmetry`/`event-wiring-orphaned-pragma` kinds.
  const { survivors, suppressed } = processFindings(detectorOut.findings, { ledger, planContent });

  const findings = survivors.map((f, i) => eventWiringToStandardFinding(f, i));
  const state = findings.length > 0 ? 'ANALYZED_WITH_FINDINGS' : 'ANALYZED_CLEAN';
  const summary = findings.length === 0
    ? `No event-wiring asymmetries. ${detectorOut.counters.testDispatchSites ?? 0} test-only dispatch site(s), ${detectorOut.counters.dynamicListenSites ?? 0} dynamic listen site(s).`
    : `${findings.length} event-wiring-symmetry finding(s) surfaced (${detectorOut.findings.length} raw, ${suppressed.length} suppressed).`;

  const latencyMs = Date.now() - startedAt;
  return {
    state,
    result: {
      result: { pass_name: 'event-wiring-symmetry', findings, summary },
      usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: latencyMs },
      latencyMs,
    },
  };
}
