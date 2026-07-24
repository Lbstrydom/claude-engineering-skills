/**
 * @fileoverview Tier-1 tests for `scripts/lib/audit/tiered-model-selection.mjs`
 * — `selectStage1TriagerCall`'s validated-vs-default branch selection,
 * extracted from `tiered-pipeline.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md
 * Phase 1).
 *
 * `selectStage1TriagerCall` calls the REAL `resolveStage1TriagerModel` (a
 * plain named ESM export — this repo's own established convention says these
 * cannot be `t.mock.method`'d, only object methods/class prototypes can), so
 * branch selection is driven via its two REAL inputs: `tieredAuditConfig.
 * stage1Model` (operator override, fully hermetic) and the on-disk validation
 * manifest at `resolveStage1TriagerModel`'s default relative path (driven via
 * `process.cwd()`, matching this test suite's own established `withCwd`
 * pattern for VCS-touching tests elsewhere).
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectStage1TriagerCall } from '../scripts/lib/audit/tiered-model-selection.mjs';

// @duplicate-justification: target=tests/tiered-pipeline-stage0-wiring.test.mjs:withCwd reason=a tiny per-file cwd-swap helper duplicated across test files matching this repo's established local-helper convention (AGENTS.md: "three similar lines is better than a premature abstraction") — a shared fixture module for one 8-line helper is the over-engineered extreme, not the right-sized one.
async function withCwd(dir, fn) {
  const saved = process.cwd();
  process.chdir(dir);
  try {
    // MUST await here — `return fn()` alone returns fn's pending promise
    // before entering `finally`, so any code in `fn` AFTER its first `await`
    // would see cwd already restored to `saved` (audit-code fix M6).
    return await fn();
  } finally {
    process.chdir(saved);
  }
}

// @duplicate-justification: target=tests/config-shared-env.test.mjs:mkdtemp reason=a 2-line temp-dir helper duplicated across test files matching this repo's established per-file local-helper convention (AGENTS.md: "three similar lines is better than a premature abstraction") — a shared fixture module for one trivial helper is the over-engineered extreme, not the right-sized one.
function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tiered-model-selection-'));
}

describe('selectStage1TriagerCall', () => {
  it('validated branch (model resolved + providers.ossCall present): calls validatedTriagerCall, records oss usage, logs the model+source', async () => {
    const recorded = [];
    const writeMock = mock.method(process.stderr, 'write', () => true);
    try {
      const triagerCall = selectStage1TriagerCall({
        // An operator-override resolves via the SAME `stage1Resolution.model
        // && providers.ossCall` branch a validated-manifest resolution would
        // — resolveStage1TriagerModel's precedence puts operator-override
        // first, but selectStage1TriagerCall does not distinguish the two
        // once `.model` is truthy, so this exercises the identical code path
        // deterministically, independent of the real on-disk manifest state.
        tieredAuditConfig: { stage1Model: 'operator-override-model' },
        providers: { ossCall: async () => ({ result: { dismissalAttempted: true, disproof: 'x' }, category: null, error: null, usage: { input_tokens: 10, output_tokens: 4, latency_ms: 2 } }) },
        recordUsage: (e) => recorded.push(e),
        openaiConfig: { model: 'gpt-fallback' },
      });
      const result = await triagerCall({ category: 'c', detail: 'd' });
      assert.deepEqual(result, { dismissalAttempted: true, disproof: 'x' });
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].provider, 'oss');
      assert.equal(recorded[0].modelSentinel, 'operator-override-model');

      const logged = writeMock.mock.calls.map((c) => c.arguments[0]).join('');
      assert.match(logged, /Stage 1 triager: operator-override-model \(operator-override/);
    } finally {
      writeMock.mock.restore();
    }
  });

  it('default-GPT fallback, oss_provider_unavailable reason: model resolves but no providers.ossCall', async () => {
    const recorded = [];
    const writeMock = mock.method(process.stderr, 'write', () => true);
    try {
      const triagerCall = selectStage1TriagerCall({
        tieredAuditConfig: { stage1Model: 'operator-override-model' },
        providers: {}, // no ossCall — the model resolved but there's no way to reach it
        recordUsage: (e) => recorded.push(e),
        openaiConfig: { model: 'gpt-fallback' },
      });
      assert.match(writeMock.mock.calls.map((c) => c.arguments[0]).join(''), /WARNING: Stage 1 triager falling back to gpt-fallback \(oss_provider_unavailable\)/);
    } finally {
      writeMock.mock.restore();
    }
  });

  it('default-GPT fallback, no-override/no-manifest reason: neither an operator pin nor a resolvable manifest', async () => {
    // A clean temp cwd has no docs/experiments/audit-effectiveness/
    // cheap-triager-validation.json, so resolveStage1TriagerModel's default
    // manifest lookup returns {model: null, source: 'fallback', reason:
    // 'manifest_not_found'} — the real, reachable instance of this factory's
    // "no override, no manifest" else-branch. (The literal fallback string
    // 'no_override_or_manifest' this branch also carries is a defensive
    // default for a `stage1Resolution.reason` that resolveStage1TriagerModel's
    // real contract never actually leaves unset — every fallback return sets
    // .reason — so it is not independently reachable; this test proves the
    // same branch attribution via the reason the real resolver does produce.)
    const dir = mkdtemp();
    try {
      await withCwd(dir, async () => {
        const writeMock = mock.method(process.stderr, 'write', () => true);
        try {
          const triagerCall = selectStage1TriagerCall({
            tieredAuditConfig: {},
            providers: { ossCall: async () => { throw new Error('must not be reached — no model was resolved'); } },
            recordUsage: () => {},
            openaiConfig: { model: 'gpt-fallback' },
          });
          assert.match(writeMock.mock.calls.map((c) => c.arguments[0]).join(''), /WARNING: Stage 1 triager falling back to gpt-fallback \(manifest_not_found\)/);
          await assert.rejects(triagerCall({ category: 'c', detail: 'd' }), /providers\.openai is required/, 'falls through to defaultTriagerCall, which requires providers.openai');
        } finally {
          writeMock.mock.restore();
        }
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
