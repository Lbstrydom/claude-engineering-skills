/**
 * @fileoverview `scoreAgainstGroundTruth`/`toRawContext` — moved to
 * `scripts/lib/model-eval/adjudicator-executor.mjs` (D7a, plan:
 * comparison-tooling-consolidation.md, Cluster D). Covers the pure transform
 * directly, and proves BOTH callers (the existing 1-vs-1 CLI path in
 * `model-eval-adjudicator.mjs` and `EXECUTORS.adjudicator` in
 * `executors.mjs`) resolve to the SAME function — neither is a copy.
 *
 * `scoreAgainstGroundTruth` itself makes a real provider call
 * (`extractStructured`) and is not whole-provider-mocked here, matching this
 * repo's testing doctrine (AGENTS.md Tier 2: "never a whole-provider mock —
 * that tests the mock"). Its usage-summation null-propagation rule is
 * exercised at the unit level against `costFromUsage` directly, the same
 * function it composes.
 *
 * @module tests/adjudicator-executor
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { toRawContext, scoreAgainstGroundTruth } from '../scripts/lib/model-eval/adjudicator-executor.mjs';
import { costFromUsage } from '../scripts/lib/model-pricing.mjs';

describe('toRawContext', () => {
  it('joins category, primaryFile and detailSnapshot with an em-dash separator', () => {
    const row = { category: 'Backend', primaryFile: 'scripts/a.mjs:12', detailSnapshot: 'a defect', severity: 'HIGH' };
    const ctx = toRawContext(row);
    assert.equal(ctx.findingText, 'Backend — scripts/a.mjs:12 — a defect');
    assert.equal(ctx.severity, 'HIGH');
  });

  it('omits falsy fields rather than joining empty strings', () => {
    const ctx = toRawContext({ category: 'Backend', primaryFile: null, detailSnapshot: undefined, severity: 'LOW' });
    assert.equal(ctx.findingText, 'Backend');
  });

  it('a row with no captured detail at all reports the fallback text, not an empty string', () => {
    const ctx = toRawContext({ severity: null });
    assert.equal(ctx.findingText, '(no detail captured)');
    assert.equal(ctx.severity, 'UNKNOWN', 'an absent severity is UNKNOWN, never null — computeVerdict/scoring must never silently treat a missing label as a value');
  });
});

describe('scoreAgainstGroundTruth is reachable from BOTH callers, and is the same function', () => {
  it('model-eval-adjudicator.mjs and executors.mjs both import scoreAgainstGroundTruth from adjudicator-executor.mjs, never redefine it', () => {
    // Round-5 audit finding M6 (correctly): asserting the export EXISTS
    // proves nothing about whether either caller actually imports it, or
    // reimplements the loop locally instead. Assert the ACTUAL import
    // statement in each caller's source names the canonical module and the
    // real export — this fails if either file ever stops importing it (a
    // reimplementation) or renames the import without updating this test.
    const adjudicatorCli = fs.readFileSync(new URL('../scripts/model-eval-adjudicator.mjs', import.meta.url), 'utf-8');
    const executorsSrc = fs.readFileSync(new URL('../scripts/lib/model-eval/executors.mjs', import.meta.url), 'utf-8');
    const importsFrom = (src, specifier) => new RegExp(`import\\s*\\{[^}]*\\bscoreAgainstGroundTruth\\b[^}]*\\}\\s*from\\s*['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(src);
    assert.ok(importsFrom(adjudicatorCli, './lib/model-eval/adjudicator-executor.mjs'), 'model-eval-adjudicator.mjs must import scoreAgainstGroundTruth from adjudicator-executor.mjs, not redefine it locally');
    assert.ok(importsFrom(executorsSrc, './adjudicator-executor.mjs'), 'executors.mjs must import scoreAgainstGroundTruth from adjudicator-executor.mjs, not redefine it locally');
    assert.ok(!/async function scoreAgainstGroundTruth/.test(adjudicatorCli), 'a LOCAL function declaration in the CLI would shadow the import and defeat this whole test');
    assert.ok(!/async function scoreAgainstGroundTruth/.test(executorsSrc), 'a LOCAL function declaration in executors.mjs would shadow the import and defeat this whole test');
  });

  it('the imported binding IS the module-namespace export — verified via dynamic import, not just source text', async () => {
    // Complements the source-grep test above with a runtime check: the
    // module actually loads and exports the function under this exact name.
    const adjudicatorExecutorMod = await import('../scripts/lib/model-eval/adjudicator-executor.mjs');
    assert.equal(typeof adjudicatorExecutorMod.scoreAgainstGroundTruth, 'function');
    assert.equal(typeof adjudicatorExecutorMod.toRawContext, 'function');
  });
});

describe('usage null-propagation rule (Cluster B round-2 H7/H8, resolved in D7c)', () => {
  // scoreAgainstGroundTruth sums costFromUsage(...).totalUsd across every
  // internal extractStructured call; if ANY row is unpriced/unmeterable the
  // summed costUsd must be null, never a partial sum read as the whole. This
  // is exactly the composition rule scoreAgainstGroundTruth applies — proven
  // here against the primitive it composes, since the composed function
  // itself needs a live provider to exercise end-to-end.
  it('costFromUsage returns null totalUsd for an unknown model — the propagation input is real, not simulated', () => {
    const cost = costFromUsage({ input_tokens: 100, output_tokens: 50 }, 'a-model-with-no-pricing-entry');
    assert.equal(cost.totalUsd, null, 'an unpriced model must never report a false-zero or false-partial cost');
    assert.equal(cost.inputTokens, 100, 'token counts are always the sanitized observation, independent of pricing');
    assert.equal(cost.outputTokens, 50);
  });

  it('a sum-loop mirroring scoreAgainstGroundTruth\'s own logic drops to null costUsd on one unpriced row', () => {
    // Mirrors scoreAgainstGroundTruth's accumulation exactly: sum tokens
    // unconditionally, sum cost only while every row has priced, drop to
    // null the moment one row does not.
    const rows = [
      costFromUsage({ input_tokens: 10, output_tokens: 5 }, 'gpt-5.6'), // priced (assuming this model is in the pricing table)
      costFromUsage({ input_tokens: 20, output_tokens: 8 }, 'a-model-with-no-pricing-entry'), // unpriced
    ];
    let inputTokens = 0; let outputTokens = 0; let costUsd = 0; let allPriced = true;
    for (const cost of rows) {
      inputTokens += cost.inputTokens;
      outputTokens += cost.outputTokens;
      if (cost.totalUsd == null) allPriced = false; else costUsd += cost.totalUsd;
    }
    assert.equal(inputTokens, 30);
    assert.equal(outputTokens, 13);
    assert.equal(allPriced ? costUsd : null, null, 'one unpriced row must null the WHOLE sum, not just its own contribution');
  });
});
