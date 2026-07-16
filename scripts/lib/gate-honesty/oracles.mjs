/**
 * @fileoverview The oracle registry (plan §F2.3 — the H5 design). A plain
 * `Map` + four adapter functions, deliberately bounded (Gemini's
 * over-engineering flag, recorded in the plan): no plugin loading, no
 * config indirection. Each adapter imports or spawns the REAL production
 * seam named by the contract's `implementation` field — same-module
 * identity, not a lookalike — and returns a normalized tri-state result.
 *
 * @module scripts/lib/gate-honesty/oracles
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

/**
 * @typedef {{state: 'ok'} | {state: 'divergent', stated: string, found: string} | {state: 'env-skipped', skipReason: string}} OracleResult
 */

async function importImplementation(gate, repoRoot) {
  const abs = path.resolve(repoRoot, gate.implementation);
  return import(pathToFileURL(abs).href);
}

/** @returns {Promise<OracleResult>} */
async function convergenceThreshold(gate, { repoRoot }) {
  const mod = await importImplementation(gate, repoRoot);
  const { high, medium, quickFix } = gate.params;
  const constants = mod.CONVERGENCE_THRESHOLDS;
  if (!constants || constants.high !== high || constants.medium !== medium || constants.quickFix !== quickFix) {
    return {
      state: 'divergent',
      stated: `params ${JSON.stringify(gate.params)}`,
      found: `CONVERGENCE_THRESHOLDS ${JSON.stringify(constants ?? null)} (${gate.implementation})`,
    };
  }
  const cases = [
    [{ high, medium, quickFix }, true],
    [{ high: high + 1, medium, quickFix }, false],
    [{ high, medium: medium + 1, quickFix }, false],
    [{ high, medium, quickFix: quickFix + 1 }, false],
  ];
  for (const [counts, expected] of cases) {
    const actual = mod.evaluateConvergence(counts);
    if (actual !== expected) {
      return {
        state: 'divergent',
        stated: `evaluateConvergence(${JSON.stringify(counts)}) === ${expected}`,
        found: `evaluateConvergence returned ${actual}`,
      };
    }
  }
  return { state: 'ok' };
}

/** @returns {Promise<OracleResult>} */
async function tieredShadowWindow(gate, { repoRoot }) {
  const mod = await importImplementation(gate, repoRoot);
  const rows = gate.fixture.rows;
  const expectedCompared = rows.filter((r) => r.comparison?.tieredRunStatus === 'complete').length;
  const summary = mod.summarize(rows);
  if (summary.comparedRuns !== expectedCompared) {
    return {
      state: 'divergent',
      stated: `comparedRuns excludes fallback_legacy rows (expected ${expectedCompared})`,
      found: `comparedRuns === ${summary.comparedRuns}`,
    };
  }
  const progress = mod.windowProgress(summary.comparedRuns);
  const allFallback = rows.every((r) => r.comparison?.tieredRunStatus === 'fallback_legacy');
  if (allFallback && progress.met) {
    return {
      state: 'divergent',
      stated: 'an all-fallback_legacy window never reads "met"',
      found: `windowProgress(${summary.comparedRuns}).met === true`,
    };
  }
  return { state: 'ok' };
}

/** @returns {Promise<OracleResult>} */
async function visualGateUnverified(gate, { repoRoot }) {
  const mod = await importImplementation(gate, repoRoot);
  const fn = mod.gateUnverifiedReason;
  const cases = [
    { input: { integrity: { noSurfaces: true }, isFull: true, changedPathsResolved: true }, mustBeNonNull: true, contains: 'no surfaces' },
    { input: { integrity: { degraded: true, total: 3 }, isFull: true, changedPathsResolved: true }, mustBeNonNull: true, contains: 'unverifiable' },
    { input: { integrity: { noSurfaces: false, degraded: false }, isFull: false, changedPathsResolved: false }, mustBeNonNull: true, contains: 'merge-base' },
    { input: { integrity: { noSurfaces: false, degraded: false, total: 3 }, isFull: true, changedPathsResolved: true }, mustBeNonNull: false },
  ];
  for (const c of cases) {
    const result = fn(c.input);
    if (c.mustBeNonNull && (typeof result !== 'string' || (c.contains && !result.includes(c.contains)))) {
      return {
        state: 'divergent',
        stated: `gateUnverifiedReason(${JSON.stringify(c.input)}) is non-null and mentions "${c.contains}"`,
        found: `returned ${JSON.stringify(result)}`,
      };
    }
    if (!c.mustBeNonNull && result !== null) {
      return {
        state: 'divergent',
        stated: `gateUnverifiedReason(${JSON.stringify(c.input)}) === null (nothing wrong)`,
        found: `returned ${JSON.stringify(result)}`,
      };
    }
  }
  return { state: 'ok' };
}

/** Registry-owned cli-exit scenario recipes (§F2.3 — closed set, right-sized to v1 usage). */
const CLI_EXIT_RECIPES = {
  'visual-static-gate-refusal': {
    args: ['--gate'],
    fixture(dir) {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'visual-contract.json'), JSON.stringify({
        version: 1, surfaces: [{ id: 'app', selector: 'body', sourceGlobs: ['src/**'] }],
        tokenSources: [], globalStyleGlobs: [], themes: [],
      }));
    },
    expectExit: 2,
    expectStderrContains: '--gate requires --verify',
    envPrereq: null, // deterministic everywhere — no browser involved
  },
};

/** @returns {Promise<OracleResult>} */
async function cliExit(gate, { repoRoot }) {
  const recipe = CLI_EXIT_RECIPES[gate.scenario];
  const cliAbs = path.resolve(repoRoot, gate.implementation);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-honesty-cli-'));
  try {
    if (recipe.envPrereq && !recipe.envPrereq()) {
      return { state: 'env-skipped', skipReason: `scenario "${gate.scenario}" prerequisite unavailable` };
    }
    recipe.fixture(tmpDir);
    const r = spawnSync(process.execPath, [cliAbs, ...recipe.args], { cwd: tmpDir, encoding: 'utf-8' });
    if (r.status !== recipe.expectExit) {
      return { state: 'divergent', stated: `exit ${recipe.expectExit}`, found: `exit ${r.status}` };
    }
    if (recipe.expectStderrContains && !r.stderr.includes(recipe.expectStderrContains)) {
      return { state: 'divergent', stated: `stderr contains "${recipe.expectStderrContains}"`, found: `stderr: ${r.stderr.slice(0, 200)}` };
    }
    return { state: 'ok' };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/** The registry — oracle id → adapter. Unknown ids are a schema-time divergence (schema.mjs), never reach here. */
export const ORACLES = new Map([
  ['convergence-threshold', convergenceThreshold],
  ['tiered-shadow-window', tieredShadowWindow],
  ['visual-gate-unverified', visualGateUnverified],
  ['cli-exit', cliExit],
]);

/**
 * Run the oracle named by `gate.oracle` against the real implementation.
 * @param {object} gate — a validated executable gate
 * @param {{repoRoot: string}} ctx
 * @returns {Promise<OracleResult>}
 */
export async function runOracle(gate, ctx) {
  const adapter = ORACLES.get(gate.oracle);
  if (!adapter) return { state: 'divergent', stated: `registered oracle "${gate.oracle}"`, found: 'unknown oracle id' };
  try {
    return await adapter(gate, ctx);
  } catch (e) {
    return { state: 'divergent', stated: 'oracle runs without throwing', found: `threw: ${e.message}` };
  }
}
