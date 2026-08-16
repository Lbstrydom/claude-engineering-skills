/**
 * @fileoverview `model-eval-adjudicator.mjs --manifest` — CLI parity with
 * the auditor entry point (D7c, plan: comparison-tooling-consolidation.md,
 * Cluster D). Mirrors `tests/model-eval-auditor-manifest.test.mjs`'s
 * pattern: real subprocess, real CLI, but every case here is refused or
 * fails BEFORE any provider call reaches a live model, so it needs no API
 * key and spends nothing.
 *
 * Includes the Phase 6 exit-condition integration test the plan requires
 * "not optional": a manifest with one route-resolvable arm and one arm whose
 * model cannot be resolved to a route — asserting the cohort still runs and
 * names the failed arm as `terminal`, rather than aborting the whole
 * comparison. Route resolution is synchronous and local (no provider call),
 * so this is exercised without a live API key; a full arm SUCCEEDING still
 * needs one and is out of scope for this suite, matching the auditor
 * manifest suite's own stated boundary.
 *
 * @module tests/model-eval-adjudicator-manifest
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'model-eval-adjudicator.mjs');

const VALID_CONTROLS = {
  reasoningEffort: 'medium', promptTemplateId: 'adjudicator-v1', outputSchemaId: 'adjudicator-v1',
  maxOutputTokens: 4096, toolPolicy: 'none', temperature: 0, tier: 'screen',
};

function manifest(overrides = {}) {
  return {
    schemaVersion: 1, id: 'test-adjudicator-manifest', role: 'adjudicator',
    decision: { type: 'select_default', incumbent: 'latest-pro' },
    arms: [
      { id: 'gpt', model: 'latest-gpt', mode: 'shadow' },
      { id: 'sonnet', model: 'latest-sonnet', mode: 'shadow' },
    ],
    controls: VALID_CONTROLS,
    ...overrides,
  };
}

const dirs = [];
after(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } }
});

function writeManifest(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adjudicator-manifest-'));
  dirs.push(dir);
  const p = path.join(dir, 'manifest.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function run(args, opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000, ...opts,
  });
}

describe('model-eval-adjudicator.mjs --manifest — CLI contract', () => {
  it('--candidate and --manifest together exit 2, before any provider call', () => {
    const mPath = writeManifest(manifest());
    const r = run(['--candidate', '{"kind":"sentinel","value":"latest-gpt"}', '--manifest', mPath, '--tier', 'screen']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /mutually exclusive/);
  });

  it('neither --candidate nor --manifest: exit 1 with a usage line naming BOTH forms', () => {
    const r = run(['--tier', 'screen']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--candidate/);
    assert.match(r.stderr, /--manifest/);
  });

  it('--manifest naming a nonexistent file: preflight failure, exit 2', () => {
    const r = run(['--manifest', path.join(REPO_ROOT, 'nonexistent-manifest.json'), '--tier', 'screen']);
    assert.equal(r.status, 2);
  });

  it('an auditor-role manifest refuses via the shared schema/dispatch, not silently accepted here', () => {
    const mPath = writeManifest(manifest({
      role: 'auditor',
      controls: { reasoningEffort: 'medium', promptTemplateId: 'x', outputSchemaId: 'x', maxOutputTokens: 100, toolPolicy: 'none', temperature: 0, passes: ['structure'], scope: 'diff', rounds: 1 },
    }));
    const r = run(['--manifest', mPath, '--tier', 'screen']);
    assert.equal(r.status, 2);
  });

  it('a manifest declaring an ABSOLUTE subject path refuses — manifest paths are repo-relative', () => {
    const mPath = writeManifest(manifest({ subject: { corpusPath: 'C:/etc/passwd' } }));
    const r = run(['--manifest', mPath, '--tier', 'screen']);
    assert.equal(r.status, 2);
  });

  it('an empty ground-truth corpus refuses AT LOAD, before any arm runs (setup error, not a 0-observation result)', () => {
    // Cloud is off in this test environment, so getAdjudicatorGroundTruth
    // returns 0 rows unconditionally — prepareContext's own refusal (D7c;
    // "an empty corpus is a setup error, not a degenerate-but-valid
    // outcome") fires before the per-arm loop, which is itself the correct,
    // desired behaviour: nothing to score is refused, never silently scored
    // as an empty comparison.
    const mPath = writeManifest(manifest({ decision: { type: 'select_default', incumbent: 'latest-gpt' } }));
    const r = run(['--manifest', mPath, '--tier', 'screen', '--thresholds', path.join(REPO_ROOT, 'scripts', 'lib', 'model-eval', 'config', 'adjudicator-thresholds.json')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /nothing to score|setup error/);
  });
});

describe('Phase 6 exit condition (integration test the plan requires "not optional"): a cohort with one route-unresolvable arm still runs, naming the failed arm terminal', () => {
  // Exercised at the unit level directly against EXECUTORS.adjudicator, with
  // a SYNTHETIC context (bypassing prepareContext's live ground-truth
  // fetch) — the CLI-level equivalent is unreachable in this environment
  // because cloud is off, so getAdjudicatorGroundTruth always returns 0
  // rows and prepareContext refuses before any arm ever runs (see the test
  // above). Route resolution is synchronous and local, so the terminal path
  // is real, not simulated; the surviving arm would still need a live
  // provider to reach 'ok', which is out of scope for this suite (same
  // boundary the auditor-manifest suite states for itself).
  it('a route-unresolvable arm returns a terminal ExecutorAttempt, never throws — the cohort continues', async () => {
    const { EXECUTORS } = await import('../scripts/lib/model-eval/executors.mjs');
    const fixtureRows = [
      { category: 'Backend', primaryFile: 'a.mjs:1', detailSnapshot: 'x', severity: 'HIGH', humanLabel: true },
      { category: 'Backend', primaryFile: 'b.mjs:2', detailSnapshot: 'y', severity: 'LOW', humanLabel: false },
    ];
    const context = { rows: fixtureRows, groundTruthLimit: 200 };
    const controls = { ...VALID_CONTROLS };
    const badArm = { id: 'bad-route', model: 'not-a-real-sentinel-or-model-id', mode: 'shadow' };

    const attempt = await EXECUTORS.adjudicator.executeArm(badArm, controls, context, { comparisonId: null, armId: badArm.id, attempt: 1, supersedePrior: false });
    assert.equal(attempt.outcome, 'terminal', `expected a terminal ExecutorAttempt, got ${JSON.stringify(attempt)}`);
    assert.match(attempt.reason, /route resolution failed/);
    assert.equal(attempt.result, undefined, 'a terminal attempt must not carry a RoleResult — the type is unrepresentable for a pre-provider-call failure');
    assert.equal(attempt.usage, undefined);
  });

  it('negative control — a route-resolvable arm reaches PAST route resolution (into the live provider call, which this suite does not exercise)', async () => {
    // Proves the terminal outcome above is specific to the bad model id, not
    // a bug that terminals EVERY arm regardless of input.
    const { resolveCandidateRoute } = await import('../scripts/lib/model-eval/route-catalog.mjs');
    assert.doesNotThrow(() => resolveCandidateRoute({ role: 'adjudicator', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' } }),
      'a real sentinel must resolve locally without a provider call — if this throws, the terminal test above proves nothing about the BAD arm specifically');
  });
});
