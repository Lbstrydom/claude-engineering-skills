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
    return { key, finding, firstSeen, ageDays: computeAgeDays(head, firstSeen) };
  });
}

/**
 * Age in whole days, or `null` when either endpoint is not a parseable date.
 *
 * Two failure modes, both previously silent (tech-debt `fa6e120c`):
 *  - an unparseable `firstSeen` made `head - NaN` → `NaN`, which survives
 *    `Math.max`/`Math.floor` and only becomes `null` later by accident, when
 *    `JSON.stringify` refuses to serialise it;
 *  - an unparseable `headCommitDate` returned **0**, reporting every finding as
 *    brand new — the more dangerous of the two, because 0 is a plausible value
 *    that reads as "just appeared" rather than "we don't know".
 *
 * `null` distinguishes both from a genuine 0, which means the finding was first
 * seen AT head and is a real measurement. This is the same
 * unknown-is-not-zero rule the coverage-gate honesty work applies
 * (`docs/plans/observed-graph-coverage-honesty.md`).
 *
 * NOTE: `scripts/lib/nav/drift.mjs` carries a byte-identical copy of this
 * function — the two lenses are deliberately separate modules, so the guard is
 * duplicated rather than abstracted, and `tests/visual-drift.test.mjs` asserts
 * BOTH copies agree so they cannot drift apart again.
 *
 * @param {number} head - `Date.parse` of the head commit date
 * @param {string} firstSeen
 * @returns {number|null}
 */
function computeAgeDays(head, firstSeen) {
  const seen = Date.parse(firstSeen);
  if (!Number.isFinite(head) || !Number.isFinite(seen)) return null;
  return Math.max(0, Math.floor((head - seen) / 86400000));
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
