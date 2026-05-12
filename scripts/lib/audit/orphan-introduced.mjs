/**
 * @fileoverview Pure detector for the orphan-introduced check (dead-code phase 1).
 *
 * Given an already-resolved DiffScope (from diff-scope-resolver.mjs) and the
 * HEAD import graph projection (from arch-intent's js-ts adapter _meta), emit
 * raw orphan-introduced findings.
 *
 * **Pure function** — no I/O, no git access, no fs access. Orchestration owns
 * baseline resolution + AST parsing + telemetry emission.
 *
 * Algorithm: see docs/plans/dead-code-phase-1-orphan-introduced.md §2.
 *
 * @module scripts/lib/audit/orphan-introduced
 */

import { DiffScopeSchema, HeadGraphMetaSchema } from '../schemas.mjs';

/**
 * Test-file path patterns. Extracted as a constant so phase 2 can swap in
 * a config-driven equivalent without touching detector logic
 * (audit-code R1/M18 — externalise repo-convention assumptions).
 */
const TEST_PATH_PATTERNS = Object.freeze({
  prefixes: ['tests/', 'test/'],
  segmentContains: ['/tests/', '/test/', '/__tests__/'],
  suffixRegex: /\.(test|spec)\.[a-z]+$/i,
});

/**
 * Detect orphans introduced by the current diff.
 *
 * @param {object} args
 * @param {import('../schemas.mjs').DiffScopeSchema} args.scope - fully-resolved diff scope
 * @param {import('../schemas.mjs').HeadGraphMetaSchema} args.head - HEAD graph projection
 * @param {object} [args.ctx] - reserved for future use (currently unused; detector is pure)
 * @returns {{
 *   rawFindings: Array<import('../schemas.mjs').OrphanIntroducedFindingSchema>,
 *   _meta: { suspectsCount: number, removedEdgesCount: number, entryPointsCount: number },
 *   state: 'ANALYZED_CLEAN' | 'ANALYZED_WITH_FINDINGS' | 'ANALYZED_PARTIAL'
 * }}
 */
export function detectOrphansIntroduced({ scope, head, ctx: _ctx } = {}) {
  // Boundary validation — fail closed on contract violations (audit-code R1/M11).
  // Zod schemas throw on missing required fields so upstream contract bugs
  // surface immediately instead of producing silently empty results.
  const parsedScope = DiffScopeSchema.parse(scope);
  const parsedHead = HeadGraphMetaSchema.parse(head);

  const changedFiles = parsedScope.changedFiles;
  const preEdges = parsedScope.preEdgesByBaseCaller;
  const targetExistedAtBase = new Set(parsedScope.targetExistedAtBase);
  const entryPoints = new Set(parsedScope.entryPoints);
  const callersByTarget = parsedHead.callersByTarget;
  const targetsByCaller = parsedHead.targetsByCaller;
  const allFiles = new Set(parsedHead.allFiles);

  // Step 1: removedEdgesByTarget — Gemini-R5/H1 fix.
  // Track EXACT attribution (which baseCallers dropped an edge to each target)
  // rather than reverse-walking preEdges later (which would include
  // still-importing callers and produce unstable fingerprints).
  const removedEdgesByTarget = new Map();
  function recordRemoved(target, caller) {
    if (!removedEdgesByTarget.has(target)) removedEdgesByTarget.set(target, new Set());
    removedEdgesByTarget.get(target).add(caller);
  }

  for (const f of changedFiles) {
    if (!['M', 'D', 'R'].includes(f.status)) continue;
    if (!f.baseCallerPath) continue; // defensive
    const preTargets = preEdges[f.baseCallerPath] || [];
    if (f.status === 'D') {
      for (const t of preTargets) recordRemoved(t, f.baseCallerPath);
    } else {
      const headTargets = new Set(targetsByCaller[f.headCallerPath] || []);
      for (const t of preTargets) {
        if (!headTargets.has(t)) recordRemoved(t, f.baseCallerPath);
      }
    }
  }

  // Step 2: suspects — files that may have become orphan in this diff.
  const suspects = new Set();
  for (const f of changedFiles) {
    if (['A', 'C', 'R'].includes(f.status) && f.headCallerPath) {
      suspects.add(f.headCallerPath);
    }
  }
  for (const t of removedEdgesByTarget.keys()) suspects.add(t);

  // Step 3: emit raw findings.
  const rawFindings = [];
  for (const path of suspects) {
    if (!allFiles.has(path)) continue;          // file deleted at HEAD — out of scope
    if (entryPoints.has(path)) continue;        // public API / CLI entry
    if (isTestFile(path)) continue;             // tests/** + *.test.* + *.spec.*

    // Gemini-R2/wrongly-dismissed-R3/M2: filter test callers from the zero-caller check.
    // Public-contract files are already exempted via entryPoints. A non-entry-point file
    // whose only remaining callers are test files IS dead in prod.
    const allCallers = callersByTarget[path] || [];
    const nonTestCallers = allCallers.filter(c => !isTestFile(c));
    const testCallers = allCallers.filter(c => isTestFile(c));
    if (nonTestCallers.length > 0) continue;

    // R2/H3 fix — subKind from target's base existence (not from changedFiles membership).
    const subKind = targetExistedAtBase.has(path) ? 'left-orphan' : 'born-orphan';

    // Gemini-G1 + R5/H1 fix — emit FULL sorted set (for fingerprint) AND truncated display.
    const allRemovedCallers = Array.from(removedEdgesByTarget.get(path) || []).sort((a, b) => a.localeCompare(b));
    const priorCallers = allRemovedCallers.slice(0, 3);
    const overflow = allRemovedCallers.length > 3
      ? `, ... (${allRemovedCallers.length - 3} more)`
      : '';
    const rationale = subKind === 'left-orphan'
      ? `Lost all incoming imports in this diff (previously imported by: ${priorCallers.join(', ')}${overflow})`
      : 'Newly added; no file at HEAD imports it (entry-points + tests excluded)';

    rawFindings.push({
      severity: 'MEDIUM',
      kind: 'orphan-introduced',
      subKind,
      file: path,
      allRemovedCallers,
      priorCallers,
      testCallers,
      rationale,
    });
  }

  // Step 4: derive state.
  // audit-code R2/M5 — every non-ANALYZED_CLEAN upstream state must propagate,
  // not just ANALYZED_PARTIAL. Maps the OrphanPassStateSchema enum 1:1 from
  // the input scope's state, falling through to the detector's own verdict
  // only when upstream signalled a clean baseline.
  const INHERITED_STATES = new Set([
    'ANALYZED_PARTIAL',
    'SKIPPED_NO_BASELINE',
    'SKIPPED_NO_GRAPH',
    'SKIPPED_PATCH_ONLY_MODE',
    'SKIPPED_UNSUPPORTED_STACK',
    'ERROR',
  ]);
  let state;
  if (INHERITED_STATES.has(parsedScope.state)) {
    state = parsedScope.state;
  } else if (rawFindings.length === 0) {
    state = 'ANALYZED_CLEAN';
  } else {
    state = 'ANALYZED_WITH_FINDINGS';
  }

  // audit-code R1/L1 — distinguish unique-targets-with-removed-edges vs.
  // total-removed-edges. Both can be useful; expose both with clear names.
  let totalRemovedEdges = 0;
  for (const s of removedEdgesByTarget.values()) totalRemovedEdges += s.size;

  return {
    rawFindings,
    _meta: {
      suspectsCount: suspects.size,
      removedEdgeTargetCount: removedEdgesByTarget.size, // unique orphaned-target candidates
      totalRemovedEdges,                                  // total caller→target edges removed
      entryPointsCount: entryPoints.size,
    },
    state,
  };
}

/**
 * Test-file classifier. Files matched here are exempted from being orphan
 * candidates AND filtered out of the caller-list when judging zero-caller.
 * Backed by TEST_PATH_PATTERNS — phase 2 can swap in config-driven patterns.
 */
export function isTestFile(p) {
  if (!p || typeof p !== 'string') return false;
  const n = p.replaceAll('\\', '/');
  for (const prefix of TEST_PATH_PATTERNS.prefixes) {
    if (n.startsWith(prefix)) return true;
  }
  for (const segment of TEST_PATH_PATTERNS.segmentContains) {
    if (n.includes(segment)) return true;
  }
  return TEST_PATH_PATTERNS.suffixRegex.test(n);
}
