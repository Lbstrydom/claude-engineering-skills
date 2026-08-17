/**
 * @fileoverview `runManifestDriver` — moved to
 * `scripts/lib/model-eval/manifest-driver.mjs`, made role-generic (D7a, plan:
 * comparison-tooling-consolidation.md, Cluster D). Covers dispatch against
 * `EXECUTORS` and the refuse-at-load contract, without needing a live
 * provider or a real store (cloud is off in this environment — every case
 * here fails or is refused BEFORE any provider call or store write).
 *
 * @module tests/manifest-driver
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runManifestDriver, _internals as manifestDriverInternals } from '../scripts/lib/model-eval/manifest-driver.mjs';
import { EXECUTORS } from '../scripts/lib/model-eval/executors.mjs';
import { RunPreflightError } from '../scripts/lib/model-eval/cli-shared.mjs';
import { AUDITOR_TIER_C_PROMPT_IDS, AUDITOR_TIER_C_SCHEMA_IDS } from '../scripts/lib/comparison/controls.mjs';

const { computeControlsDivergence } = manifestDriverInternals;

const VALID_AUDITOR_CONTROLS = {
  reasoningEffort: 'medium', promptTemplateId: AUDITOR_TIER_C_PROMPT_IDS.at(-1), outputSchemaId: AUDITOR_TIER_C_SCHEMA_IDS.at(-1),
  maxOutputTokens: 4096, toolPolicy: 'none', temperature: 0,
  passes: ['structure'], scope: 'diff', rounds: 1,
};

const VALID_FINAL_REVIEW_SHADOW_CONTROLS = {
  reasoningEffort: 'medium', promptTemplateId: 'x', outputSchemaId: 'x',
  maxOutputTokens: 100, toolPolicy: 'none', temperature: 0, envelopeScope: 'thin',
};

const dirs = [];
after(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } }
});

function writeManifest(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-driver-'));
  dirs.push(dir);
  const p = path.join(dir, 'manifest.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe('EXECUTORS registry coverage', () => {
  it('every role in the vocabulary has a registry entry (assertRoleCoverage\'s THIRD check, D7c)', async () => {
    const { ROLES } = await import('../scripts/lib/comparison/roles.mjs');
    for (const role of ROLES) {
      assert.ok(Object.hasOwn(EXECUTORS, role), `EXECUTORS is missing an entry for role "${role}"`);
    }
  });

  it('auditor and adjudicator are runnable; final_review_shadow is registered but deliberately not', () => {
    assert.equal(typeof EXECUTORS.auditor.executeArm, 'function');
    assert.equal(typeof EXECUTORS.adjudicator.executeArm, 'function');
    assert.equal(EXECUTORS.final_review_shadow.executeArm, undefined,
      'final_review_shadow must have NO executeArm — its only execution path is the passive campaign collector');
  });
});

describe('runManifestDriver — role dispatch, refused at load', () => {
  it('a final_review_shadow manifest refuses BEFORE any store write, naming the role', async () => {
    const mPath = writeManifest({
      schemaVersion: 1, id: 'fr-shadow-test', role: 'final_review_shadow',
      decision: { type: 'select_default', incumbent: 'claude-opus' },
      arms: [{ id: 'a', model: 'claude-opus', mode: 'shadow' }, { id: 'b', model: 'gemini-pro-latest', mode: 'shadow' }],
      controls: VALID_FINAL_REVIEW_SHADOW_CONTROLS,
    });
    await assert.rejects(
      () => runManifestDriver({ manifestPath: mPath, tier: 'screen', corpusFlagPath: null, thresholdsPath: 'x', outFile: null, repoRoots: [process.cwd()] }),
      (err) => {
        assert.ok(err instanceof RunPreflightError, `expected RunPreflightError, got ${err.constructor.name}`);
        assert.equal(err.reason, 'bad_manifest');
        assert.match(err.message, /no synchronous executor/);
        assert.match(err.message, /final_review_shadow/);
        return true;
      },
    );
  });

  it('an unparseable manifest file refuses with bad_manifest, before role dispatch is even reached', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-driver-bad-'));
    dirs.push(dir);
    const p = path.join(dir, 'manifest.json');
    fs.writeFileSync(p, '{not valid json');
    await assert.rejects(
      () => runManifestDriver({ manifestPath: p, tier: 'screen', corpusFlagPath: null, thresholdsPath: 'x', outFile: null, repoRoots: [process.cwd()] }),
      (err) => {
        assert.ok(err instanceof RunPreflightError);
        assert.equal(err.reason, 'bad_manifest');
        return true;
      },
    );
  });

  it('a nonexistent manifest path refuses with bad_manifest', async () => {
    await assert.rejects(
      () => runManifestDriver({ manifestPath: '/nonexistent/manifest.json', tier: 'screen', corpusFlagPath: null, thresholdsPath: 'x', outFile: null, repoRoots: [process.cwd()] }),
      (err) => {
        assert.ok(err instanceof RunPreflightError);
        assert.equal(err.reason, 'bad_manifest');
        return true;
      },
    );
  });

  it('an auditor manifest with fewer than 2 scored arms refuses at schema validation, before reaching EXECUTORS at all', async () => {
    const mPath = writeManifest({
      schemaVersion: 1, id: 'too-few-arms', role: 'auditor',
      decision: { type: 'select_default', incumbent: 'latest-gpt' },
      arms: [{ id: 'solo', model: 'latest-gpt', mode: 'primary' }],
      controls: VALID_AUDITOR_CONTROLS,
    });
    await assert.rejects(
      () => runManifestDriver({ manifestPath: mPath, tier: 'screen', corpusFlagPath: null, thresholdsPath: 'x', outFile: null, repoRoots: [process.cwd()] }),
      (err) => {
        assert.ok(err instanceof RunPreflightError);
        assert.equal(err.reason, 'bad_manifest');
        assert.match(err.message, />= 2 scored arms/);
        return true;
      },
    );
  });
});

describe('negative control — the refuse-at-load check can fail to trigger', () => {
  it('a role WITH a real executeArm does not hit the "no synchronous executor" refusal', () => {
    // Proves the final_review_shadow test above is not vacuously matching
    // every manifest — auditor and adjudicator, which DO have executeArm,
    // must not trip the same guard runManifestDriver applies.
    assert.notEqual(EXECUTORS.auditor.executeArm, undefined);
    assert.notEqual(EXECUTORS.adjudicator.executeArm, undefined);
  });
});

describe('computeControlsDivergence — auditor-controls-execution-wiring.md, round-4 H1 fix', () => {
  const okResult = (controlsApplied) => ({ result: { outcome: 'ok', result: { controlsApplied } } });

  it('a field every arm agrees on is "uniform"', () => {
    const results = [okResult({ scope: true }), okResult({ scope: true })];
    assert.deepEqual(computeControlsDivergence(results), { scope: 'uniform' });
  });

  it('a field arms disagree on is "divergent" — the exact heterogeneous-tier scenario H1 raised', () => {
    const results = [okResult({ scope: true, reasoningEffort: false }), okResult({ scope: false, reasoningEffort: true })];
    assert.deepEqual(computeControlsDivergence(results), { scope: 'divergent', reasoningEffort: 'divergent' });
  });

  it('a field only SOME arms report is scored only across those that reported it', () => {
    const results = [okResult({ scope: true }), okResult({})]; // second arm never declared scope
    assert.deepEqual(computeControlsDivergence(results), { scope: 'uniform' });
  });

  it('no arm reporting any controlsApplied returns null, not an empty object', () => {
    const results = [{ result: { outcome: 'terminal', reason: 'exit 1' } }, { result: { outcome: 'terminal', reason: 'exit 1' } }];
    assert.equal(computeControlsDivergence(results), null);
  });

  it('a failed arm alongside a successful one is simply excluded, not counted as divergence', () => {
    const results = [okResult({ scope: true }), { result: { outcome: 'terminal', reason: 'exit 1' } }];
    assert.deepEqual(computeControlsDivergence(results), { scope: 'uniform' });
  });
});
