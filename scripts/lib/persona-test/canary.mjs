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
export function verifyExpectations(canary, contradictions) {
  const expected = canary.expectedContradictions || { min: 0, max: null };
  const observed = Array.isArray(contradictions) ? contradictions.length : 0;
  const min = Number.isInteger(expected.min) ? expected.min : 0;
  const max = expected.max === null || expected.max === undefined
    ? null
    : (Number.isInteger(expected.max) ? expected.max : null);

  if (observed < min) {
    return {
      passed: false,
      verdict: 'broken',
      observed,
      reason: `expected min:${min} contradictions, found ${observed} — rig may be broken (manifest drift, attribute regression, or canary expectations stale)`,
    };
  }
  if (max !== null && observed > max) {
    return {
      passed: false,
      verdict: 'broken',
      observed,
      reason: `expected max:${max} contradictions, found ${observed} — consumer regression introduced new contradictions`,
    };
  }

  if (Array.isArray(expected.shapes) && expected.shapes.length > 0) {
    for (const shape of expected.shapes) {
      const match = contradictions.find(
        (c) => c.engineField === shape.engineField && c.surfaceId === shape.surfaceId,
      );
      if (!match) {
        return {
          passed: false,
          verdict: 'broken',
          observed,
          reason: `expected shape (${shape.surfaceId}.${shape.engineField}) not found in contradictions — rig may be matching the wrong surface`,
        };
      }
    }
  }

  return {
    passed: true,
    verdict: 'passed',
    observed,
    reason: max === null
      ? `observed ${observed} contradictions (min:${min}, no max)`
      : `observed ${observed} contradictions (min:${min}, max:${max})`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// canaryExpectsShape — suppress candidate emission for canary-expected hits.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the contradiction matches one of the canary's
 * `expectedContradictions.shapes` (resolves Gemini-R3-G1 — broken-canary
 * health checks shouldn't pollute the candidate table with their own
 * deliberately-introduced contradictions).
 *
 * Match is by `(engineField, surfaceId)` — same predicate as
 * `verifyExpectations` shape check. When no shapes declared, returns false
 * for every contradiction (candidates still emit; the rig is operating on
 * a journey that doesn't constrain the contradictions it expects).
 *
 * @param {import('./schemas.mjs').CanaryDefinition} canary
 * @param {import('./schemas.mjs').Contradiction} contradiction
 * @returns {boolean}
 */
export function canaryExpectsShape(canary, contradiction) {
  const shapes = canary?.expectedContradictions?.shapes;
  if (!Array.isArray(shapes) || shapes.length === 0) return false;
  return shapes.some(
    (s) => s.engineField === contradiction.engineField && s.surfaceId === contradiction.surfaceId,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// candidateFingerprint — sha256(repoId+journeyKey+surfaceId+engineField+kind+locator)
// (Gemini-R6-G2 fix: journeyKey included so a different canary exercising
// the same surface produces a distinct candidate)
// ────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

/**
 * @param {object} args
 * @param {string} args.repoId
 * @param {string} args.journeyKey
 * @param {import('./schemas.mjs').Contradiction} args.contradiction
 * @returns {string}
 */
export function candidateFingerprint({ repoId, journeyKey, contradiction }) {
  if (!repoId || !journeyKey || !contradiction) {
    throw new Error('candidateFingerprint: repoId, journeyKey, contradiction required');
  }
  const locatorNorm = String(contradiction.selector || '').trim();
  const h = createHash('sha256');
  h.update(String(repoId));        h.update('\x00');
  h.update(String(journeyKey));    h.update('\x00');
  h.update(String(contradiction.surfaceId   ?? ''));  h.update('\x00');
  h.update(String(contradiction.engineField ?? ''));  h.update('\x00');
  h.update(String(contradiction.kind        ?? ''));  h.update('\x00');
  h.update(locatorNorm);
  return h.digest('hex');
}
