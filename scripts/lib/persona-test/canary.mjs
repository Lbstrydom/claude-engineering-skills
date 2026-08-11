/**
 * @fileoverview Phase 4 canary mechanism — load + parse + verify a canary
 * definition against the contradictions a session produced.
 *
 * Plan: docs/plans/persona-test-consistency-mode.md.
 *
 * Two responsibilities:
 *   - `loadCanary(name, repoRoot)` — read `.persona-test/canaries/<name>.json`,
 *     parse via Zod (`CanaryDefinitionSchema`), refuse path-traversal.
 *   - `verifyExpectations(canary, contradictions)` — apply the canary's
 *     `expectedContradictions` rules (min/max/shapes) and emit a verdict.
 *     A min>0 canary that finds zero contradictions = rig broken (exit 2).
 *
 * Plus a small helper, `canaryExpectsShape(canary, contradiction)`, used
 * by the runner to decide whether to suppress candidate emission for a
 * contradiction that the canary deliberately invited (Gemini-R3-G1 —
 * health-check canaries don't pollute the candidate table).
 *
 * @module scripts/lib/persona-test/canary
 */
import fs from 'node:fs';
import path from 'node:path';
import { CanaryDefinitionSchema } from './schemas.mjs';

export const CANARY_DIR = path.join('.persona-test', 'canaries');

/**
 * Load a canary from `.persona-test/canaries/<name>.json` relative to repoRoot.
 *
 * Path-traversal safe — refuses names containing `/`, `\`, `..`, or symlinks
 * whose real path escapes the canary directory.
 *
 * @param {string} name
 * @param {string} repoRoot
 * @returns {import('./schemas.mjs').CanaryDefinition}
 * @throws {Error} with a structured `failureReason` property — caller maps to exit code 3
 */
export function loadCanary(name, repoRoot) {
  if (typeof name !== 'string' || name.length === 0) {
    const err = new Error('loadCanary: name is required');
    err.failureReason = 'canary-name-missing';
    throw err;
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('loadCanary: repoRoot is required');
  }
  if (/[\\/]/.test(name) || name === '..' || name.includes('..')) {
    const err = new Error(`loadCanary: invalid canary name "${name}" (no path separators or .. allowed)`);
    err.failureReason = 'canary-name-invalid';
    throw err;
  }

  const canaryDirAbs = path.join(repoRoot, CANARY_DIR);
  const filePath     = path.join(canaryDirAbs, `${name}.json`);

  // Resolves R2-H1: the canaries/ DIRECTORY itself must be inside repoRoot
  // (real-path resolved). The old code only validated the file's real
  // path against the canaries/ dir's real path — a symlinked canaries/
  // dir pointing outside the repo would still pass that check.
  let canaryDirReal;
  try {
    canaryDirReal = fs.realpathSync(canaryDirAbs);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error(`loadCanary: ${CANARY_DIR}/ does not exist in ${repoRoot}`);
      e.failureReason = 'canary-dir-missing';
      throw e;
    }
    throw err;
  }
  let repoReal;
  try {
    repoReal = fs.realpathSync(repoRoot);
  } catch (err) {
    const e = new Error(`loadCanary: repoRoot does not exist: ${repoRoot}`);
    e.failureReason = 'canary-repo-missing';
    throw e;
  }
  {
    const relDir = path.relative(repoReal, canaryDirReal);
    if (relDir.startsWith('..') || path.isAbsolute(relDir)) {
      const e = new Error(`loadCanary: refusing symlink escape — canaries/ dir resolves outside repoRoot`);
      e.failureReason = 'canary-path-traversal';
      throw e;
    }
  }

  let realPath;
  try {
    realPath = fs.realpathSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error(`loadCanary: canary "${name}" not found at ${filePath}`);
      e.failureReason = 'canary-not-found';
      throw e;
    }
    throw err;
  }

  // Refuse if the realpath escapes the canary directory.
  const rel = path.relative(canaryDirReal, realPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const e = new Error(`loadCanary: refusing symlink escape — ${realPath} is outside ${canaryDirReal}`);
    e.failureReason = 'canary-path-traversal';
    throw e;
  }

  let raw;
  try {
    raw = fs.readFileSync(realPath, 'utf-8');
  } catch (err) {
    const e = new Error(`loadCanary: read failed: ${err.message}`);
    e.failureReason = 'canary-read-failed';
    throw e;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`loadCanary: invalid JSON in ${filePath}: ${err.message}`);
    e.failureReason = 'canary-json-invalid';
    throw e;
  }

  const result = CanaryDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    const e = new Error(`loadCanary: schema validation failed for ${filePath}: ${result.error.message}`);
    e.failureReason = 'canary-schema-invalid';
    throw e;
  }

  // Enforce that the on-disk `name` matches the filename (catches rename drift).
  if (result.data.name !== name) {
    const e = new Error(`loadCanary: canary.name "${result.data.name}" does not match filename "${name}"`);
    e.failureReason = 'canary-name-mismatch';
    throw e;
  }

  return result.data;
}

// ────────────────────────────────────────────────────────────────────────────
// verifyExpectations — apply the canary's expectedContradictions rules.
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} VerifyResult
 * @property {boolean} passed
 * @property {string}  reason   - human-readable explanation
 * @property {number}  observed - count of contradictions seen
 * @property {string}  verdict  - 'passed' | 'broken'
 */

/**
 * Check whether `contradictions` satisfies `canary.expectedContradictions`.
 *
 * Rules:
 *   - min > 0 + observed < min  → broken  ("rig found fewer contradictions than expected")
 *   - max != null + observed > max → broken  ("rig found more contradictions than expected")
 *   - shapes specified + any shape not satisfied → broken  ("shape-missing")
 *   - otherwise → passed
 *
 * `shapes` is set-comparison — order doesn't matter. Each shape requires that
 * at least one contradiction match by (engineField, surfaceId) tuple.
 *
 * @param {import('./schemas.mjs').CanaryDefinition} canary
 * @param {import('./schemas.mjs').Contradiction[]} contradictions
 * @returns {VerifyResult}
 */
// Contradiction kinds that count toward `expectedContradictions.min` —
// i.e. cross-step state-mismatch findings the canary self-test cares
// about. Resolves wine-cellar adoption #1: the old code counted ALL
// findings including `missing-surface` (a rig observability finding)
// which let the canary "pass" on rig artefacts alone, masking the fact
// that no real cross-state contradictions were detected. The auditable
// state-contradiction kinds are listed explicitly; rig observations
// (missing-surface, unresolved-ground-truth) surface in the ledger but
// don't satisfy `min`.
const SELF_TEST_CONTRADICTION_KINDS = new Set([
  'value-mismatch',
  'stale-projection',
  'undeclared-engine-claim',
  'value-coercion-error',
  'absent-not-rendered',
  'key-coercion-error',
  // Rig-observability kinds that do NOT count toward `min` (wine-cellar
  // adoption #1 + round-2 #3): missing-surface, unresolved-ground-truth,
  // unannotated-surface. All three signal "rig couldn't get the state
  // contract from the page", not "engine says X, DOM says Y".
]);

export function verifyExpectations(canary, contradictions) {
  // Resolves R3-H1: strict-guard non-array input. The old code coerced
  // `.length` defensively to 0 but then called `.find()` later, which
  // would throw on a non-array. Either both branches handle non-array
  // gracefully OR neither does — refusing at the boundary is the cleaner
  // contract.
  if (!Array.isArray(contradictions)) {
    throw new Error('verifyExpectations: contradictions must be an array');
  }
  if (!canary || typeof canary !== 'object') {
    throw new Error('verifyExpectations: canary must be an object');
  }
  const expected = canary.expectedContradictions || { min: 0, max: null };
  // Count only state-contradiction kinds toward the self-test gate.
  // Rig artefacts (missing-surface, unresolved-ground-truth) flow through
  // the ledger but don't satisfy `min`.
  const stateContradictions = contradictions.filter(
    (c) => SELF_TEST_CONTRADICTION_KINDS.has(c.kind),
  );
  const observed = stateContradictions.length;
  const min = Number.isInteger(expected.min) ? expected.min : 0;
  const max = expected.max === null || expected.max === undefined
    ? null
    : (Number.isInteger(expected.max) ? expected.max : null);

  if (observed < min) {
    return {
      passed: false,
      verdict: 'broken',
      observed,
      reason: `expected min:${min} state-contradictions, found ${observed} — rig may be broken (manifest drift, attribute regression, canary expectations stale, or the contradicted surface never rendered)`,
    };
  }
  if (max !== null && observed > max) {
    return {
      passed: false,
      verdict: 'broken',
      observed,
      reason: `expected max:${max} state-contradictions, found ${observed} — consumer regression introduced new contradictions`,
    };
  }

  if (Array.isArray(expected.shapes) && expected.shapes.length > 0) {
    // Shape match scans the FULL contradiction list (including rig
    // artefacts) so canary authors can assert specific missing-surface
    // or unresolved-ground-truth shapes if they want — the count gate
    // above is the only place rig artefacts are excluded.
    for (const shape of expected.shapes) {
      const match = contradictions.find((c) =>
        c.engineField === shape.engineField &&
        c.surfaceId === shape.surfaceId &&
        // Resolves R1-H10: kind discriminator. Optional in the spec —
        // when shape.kind is undefined, any contradiction kind satisfies it.
        (shape.kind === undefined || c.kind === shape.kind)
      );
      if (!match) {
        const kindLabel = shape.kind ? `:${shape.kind}` : '';
        return {
          passed: false,
          verdict: 'broken',
          observed,
          reason: `expected shape (${shape.surfaceId}.${shape.engineField}${kindLabel}) not found in contradictions — rig may be matching the wrong surface`,
        };
      }
    }
  }

  return {
    passed: true,
    verdict: 'passed',
    observed,
    reason: max === null
      ? `observed ${observed} state-contradictions (min:${min}, no max); rig artefacts excluded from this count`
      : `observed ${observed} state-contradictions (min:${min}, max:${max}); rig artefacts excluded from this count`,
  };
}
