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

/**
 * Assess whether a verify run is gate-authoritative: a page can load (states
 * captured) yet every contracted surface stall (visible-but-empty / selector never
 * matched) → zero findings → a gate would pass having checked nothing. This is the
 * dead-server capture-honesty failure at surface granularity. Pure; the orchestrator
 * acts on it (degraded → exit 2; partial → warn).
 * @param {string[]} declaredSurfaceIds - contract.surfaces[].id
 * @param {string[]} unverifiableSurfaceIds - ext.unverifiableSurfaces
 * @returns {{total:number, verifiedCount:number, noSurfaces:boolean, degraded:boolean, partial:boolean}}
 */
export function assessCaptureIntegrity(declaredSurfaceIds = [], unverifiableSurfaceIds = []) {
  const unver = new Set(unverifiableSurfaceIds || []);
  const total = (declaredSurfaceIds || []).length;
  const verifiedCount = (declaredSurfaceIds || []).filter((id) => !unver.has(id)).length;
  return {
    total,
    verifiedCount,
    noSurfaces: total === 0,
    degraded: total > 0 && verifiedCount === 0,         // page loaded but every surface stalled
    partial: total > 0 && verifiedCount > 0 && verifiedCount < total,
  };
}

/**
 * The reason a `--gate` run could not evaluate anything (→ UNVERIFIED, exit 2),
 * or `null` when the gate genuinely evaluated its scope. Single source of the
 * gate-honesty contract: a blocking gate that checked NOTHING must never report
 * a clean exit-0 pass — the same dead-server-honesty principle the degraded
 * branch already enforces, extended to its philosophically-identical siblings:
 *   - no surfaces declared        → the gate checks nothing
 *   - every surface unverifiable  → the gate cannot vouch for anything
 *   - `--scope diff` w/ no merge-base → the gate has no changed-set to evaluate
 * `--scope full` never needs a merge-base, so an unresolved one there is fine.
 * @param {{ integrity: {noSurfaces:boolean, degraded:boolean, total:number}, isFull:boolean, changedPathsResolved:boolean }} a
 * @returns {string|null}
 */
export function gateUnverifiedReason({ integrity, isFull, changedPathsResolved }) {
  if (integrity.noSurfaces) {
    return 'the contract declares no surfaces — the gate checks nothing; add surfaces to visual-contract.json or drop --gate';
  }
  if (integrity.degraded) {
    return `all ${integrity.total} contracted surface(s) unverifiable (capture stall/empty) — the gate cannot vouch for anything; fix capture first`;
  }
  if (!isFull && !changedPathsResolved) {
    return 'no merge-base (shallow checkout / detached HEAD?) — the gate has no changed-set to evaluate; use --scope full or a full-history checkout';
  }
  return null;
}

/** Build a firstSeenLookup from cloud run-history rows ({driftKeys, capturedAt}). */
// @duplicate-justification: target=scripts/lib/nav/drift.mjs:firstSeenFromHistory reason=nav-audit and visual-audit are a deliberately independent "sister lens" pair (AGENTS.md skill-naming-convention note) -- zero existing nav<->visual imports today, not accidental duplication
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
