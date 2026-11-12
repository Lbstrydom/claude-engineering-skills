/**
 * @fileoverview Stamps a finished audit run's result envelope with the notices about its OWN execution that no wave could carry (hook v18).
 *
 * The one notice today is `OWNERSHIP_UNVERIFIED`: an ownership scan the run rested on came back `degraded` (git could not be asked which
 * files the repo owns), so the file set the audit read is unverified, not confirmed clean. The scan returned that fact to its caller and
 * nothing carried it further, so wine #1336 printed `PASS (H:0 M:0 L:0)` with no `tooling:` line over a scan that checked nothing. The marker
 * rides the envelope's `findings` (the pre-push gate's one reader, `isControlMarkerFinding`) and is classified `unmeasured`, never `clean`.
 *
 * @module scripts/lib/audit/run-notices
 */
import { takeDegradedScanNotes } from '../disowned-paths.mjs';

/** The marker finding for one degraded scan. Mirrors the shape of the adjacency control marker so every consumer of `findings` reads it. */
export function buildOwnershipUnverifiedFinding(why, index = 0) {
  return {
    id: `ownership-unverified-${index + 1}`,
    severity: 'MEDIUM',
    category: 'scan unverified - control did not fully run',
    detail: `OWNERSHIP_UNVERIFIED: ${why}`,
    risk: 'Which files the repository owns could not be established, so the audit read an unverified file set. A clean result must mean "looked and found nothing", never "could not look".',
    recommendation: 'Fix the cause named in the detail (git could not be consulted from the audit\'s working directory) and push again.',
    section: 'ownership-scan',
    affectedFiles: [],
    affectedPrinciples: ['#19 Observability'],
    is_mechanical: true,
    is_quick_fix: true,
    is_reopened: false,
  };
}

/**
 * Append one marker per recorded degraded scan to `result.findings`. A run with none returns `result` unchanged (same object).
 * @template T
 * @param {T} result
 * @param {string[]} [notes] defaults to this process's recorded notes, CONSUMED (cleared) by the call
 * @returns {T}
 */
export function stampOwnershipUnverified(result, notes = takeDegradedScanNotes()) {
  if (!result || typeof result !== 'object' || notes.length === 0) return result;
  const findings = Array.isArray(result.findings) ? result.findings : [];
  return { ...result, findings: [...findings, ...notes.map((n, i) => buildOwnershipUnverifiedFinding(n, i))] };
}
