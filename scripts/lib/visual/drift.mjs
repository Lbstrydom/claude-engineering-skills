/**
 * @fileoverview Drift = gate-eligibility partition + changed-surface scoping +
 * aging (plan §7, mirrors nav/drift.mjs). The CI gate fires ONLY on gate-eligible
 * findings (GATE_ELIGIBLE_CLASSES) that survive the canonical ChangedScopeResolver
 * (changed-scope.mjs). Aging is cloud-sourced; the local ledger is a cache.
 *
 * @module scripts/lib/visual/drift
 */
import { resolveChangedScope } from './changed-scope.mjs';

/** A stable key for a finding so it can be aged across runs. */
export function divergenceKey(finding) {
  return `${finding.class}:${finding.surfaceId ?? ''}:${finding.nodeKey ?? ''}:${finding.property ?? ''}`;
}

/**
 * Partition findings into gate-eligible (by class) and advisory.
 * @param {object[]} findings
 * @returns {{gateEligible: object[], advisory: object[]}}
 */
export function partitionFindings(findings) {
  const gateEligible = (findings || []).filter((f) => f.gateEligible);
  const advisory = (findings || []).filter((f) => !f.gateEligible);
  return { gateEligible, advisory };
}

/**
 * Scope gate-eligible findings to the changed surface via the canonical resolver.
 * @param {object[]} gateEligible
 * @param {object} scopeArgs - passed to resolveChangedScope (minus `findings`)
 * @returns {object[]} the subset that should actually block
 */
export function scopeToChanged(gateEligible, scopeArgs) {
  return resolveChangedScope({ ...scopeArgs, findings: gateEligible });
}

/**
 * Age divergences using a cloud-sourced firstSeen lookup + head commit date.
 * @param {object[]} findings
 * @param {{firstSeenLookup:(k:string)=>string|null, headCommitDate:string}} args
 * @returns {Array<{key:string, finding:object, firstSeen:string, ageDays:number}>}
 */
export function ageDivergences(findings, { firstSeenLookup, headCommitDate }) {
  const head = Date.parse(headCommitDate);
  return (findings || []).map((finding) => {
    const key = divergenceKey(finding);
    const firstSeen = (firstSeenLookup && firstSeenLookup(key)) || headCommitDate;
    const ageDays = Number.isFinite(head) ? Math.max(0, Math.floor((head - Date.parse(firstSeen)) / 86400000)) : 0;
    return { key, finding, firstSeen, ageDays };
  });
}

/** Build a firstSeenLookup from cloud run-history rows ({driftKeys, capturedAt}). */
export function firstSeenFromHistory(historyRows) {
  const earliest = new Map();
  for (const row of historyRows || []) {
    const when = row.capturedAt || row.captured_at;
    if (!when || Number.isNaN(Date.parse(when))) continue;
    for (const key of row.driftKeys || row.drift_keys || []) {
      if (!earliest.has(key) || Date.parse(when) < Date.parse(earliest.get(key))) earliest.set(key, when);
    }
  }
  return (key) => earliest.get(key) || null;
}
