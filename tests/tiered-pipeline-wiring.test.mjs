/**
 * Shadow-validation flip wiring (2026-07-13) — the seams that had to change
 * before AUDIT_TIERED_SHADOW_ENABLED could produce real data instead of
 * deterministic failures:
 *  1. the Stage 2 subprocess adapter's default gemini-review.mjs path must be
 *     MODULE-relative (consumer scripts/.claude-skills/ layout), never
 *     repoRoot-relative (source layout only);
 *  2. runTieredAuditPipeline requires BOTH Stage 2 handles (reviewCall /
 *     cleanRegionCall have different signatures — one function cannot serve
 *     both), failing fast with a clear configuration error.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { defaultGeminiReviewScriptPath } from '../scripts/lib/audit/final-adjudication.mjs';
import { runTieredAuditPipeline } from '../scripts/lib/audit/tiered-pipeline.mjs';

describe('defaultGeminiReviewScriptPath (consumer-layout safety)', () => {
  test('resolves module-relative to an existing gemini-review.mjs sibling', () => {
    const p = defaultGeminiReviewScriptPath();
    assert.ok(p.endsWith('gemini-review.mjs'), `unexpected basename: ${p}`);
    assert.ok(fs.existsSync(p), `default script path does not exist: ${p}`);
  });

  test('does not depend on process.cwd() (the repoRoot-join form broke in consumers)', () => {
    const fromRepoRoot = defaultGeminiReviewScriptPath();
    const saved = process.cwd();
    try {
      process.chdir(path.dirname(saved)); // any other directory
      assert.equal(defaultGeminiReviewScriptPath(), fromRepoRoot);
    } finally {
      process.chdir(saved);
    }
  });
});

describe('runTieredAuditPipeline Stage 2 handle fail-fast', () => {
  const fn = async () => {};

  test('missing BOTH handles throws the configuration error before any provider work', async () => {
    await assert.rejects(
      () => runTieredAuditPipeline({ providers: {} }),
      /geminiReviewCall and .*geminiCleanRegionCall must both be functions/s,
    );
  });

  test('reviewCall alone is not enough (the old single-handle design)', async () => {
    await assert.rejects(
      () => runTieredAuditPipeline({ providers: { geminiReviewCall: fn } }),
      /must both be functions/,
    );
  });

  test('cleanRegionCall alone is not enough', async () => {
    await assert.rejects(
      () => runTieredAuditPipeline({ providers: { geminiCleanRegionCall: fn } }),
      /must both be functions/,
    );
  });
});
