/**
 * @fileoverview `--max-tokens` overrides the CEILING only — never the depth.
 *
 * Depth's real levers are the prose length asked for in the system prompt
 * (`wordTarget`), the reasoning-effort hint, and topic auto-promotion. Those
 * are properties of the TIER, not of the output ceiling. Resolving them
 * inside an `else` branch of "did the user pass --max-tokens?" silently
 * reverted every `--max-tokens` run to the default 250–500 word ask with
 * `reasoningEffort: null` and auto-promotion dead — so `--depth deep
 * --max-tokens N` produced standard-depth prose while reporting deep.
 *
 * The bug was introduced once, then RE-introduced when `wordTarget` was added
 * to the same branch (it too was only assigned in the `else`). Two
 * independent recurrences is why the composition now lives in one tested
 * seam rather than three lines at the call site.
 *
 * Found by the consolidated Gemini gate (G2) during the WS-0/WS-A cycle of
 * docs/plans/debt-burndown-workstreams.md.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEPTH_TOKENS,
  DEPTH_VISIBLE_TOKENS,
  DEPTH_WORD_TARGETS,
  resolveOutputBudget,
} from '../scripts/lib/brainstorm/depth-config.mjs';

describe('resolveOutputBudget — --max-tokens overrides only the ceiling', () => {
  it('THE REGRESSION: --depth deep --max-tokens 500 keeps deep wordTarget + reasoningEffort', () => {
    const b = resolveOutputBudget({
      explicitDepth: 'deep', explicitMaxTokens: true, maxTokens: 500, topic: 'anything',
    });

    assert.equal(b.maxTokens, 500, 'the ceiling IS overridden — that is what --max-tokens owns');
    assert.equal(b.depth, 'deep', 'depth must survive the override');
    assert.equal(b.wordTarget, DEPTH_WORD_TARGETS.deep,
      'the prose ask is depth\'s real lever — it must NOT revert to the default');
    assert.notEqual(b.wordTarget, DEPTH_WORD_TARGETS.standard);
    assert.equal(b.reasoningEffort, resolveOutputBudget({ explicitDepth: 'deep' }).reasoningEffort,
      'the reasoning-effort hint is a tier property, not a ceiling property');
    assert.equal(b.tierMaxTokens, DEPTH_TOKENS.deep, 'the tier ceiling is still reported');
    assert.equal(b.ceilingOverridden, true);
  });

  it('every tier keeps its own wordTarget under an explicit ceiling', () => {
    for (const tier of ['shallow', 'standard', 'deep']) {
      const b = resolveOutputBudget({
        explicitDepth: tier, explicitMaxTokens: true, maxTokens: 777,
      });
      assert.equal(b.wordTarget, DEPTH_WORD_TARGETS[tier], `${tier} wordTarget must survive`);
      assert.equal(b.visibleTokens, DEPTH_VISIBLE_TOKENS[tier]);
      assert.equal(b.maxTokens, 777);
    }
  });

  it('topic auto-promotion still fires when --max-tokens is passed', () => {
    // Auto-promotion lived in the skipped branch too, so an explicit ceiling
    // silently disabled the architecture/schema/migration trigger entirely.
    const promoted = resolveOutputBudget({ topic: 'how should we structure this database schema migration' });
    if (!promoted.autoPromoted) return; // trigger changed — nothing to assert

    const withCeiling = resolveOutputBudget({
      topic: 'how should we structure this database schema migration',
      explicitMaxTokens: true, maxTokens: 999,
    });
    assert.equal(withCeiling.autoPromoted, true, 'auto-promotion must not depend on the ceiling flag');
    assert.equal(withCeiling.depth, promoted.depth);
    assert.equal(withCeiling.wordTarget, promoted.wordTarget);
    assert.equal(withCeiling.maxTokens, 999);
  });

  it('without --max-tokens the tier ceiling is used unchanged', () => {
    const b = resolveOutputBudget({ explicitDepth: 'deep' });
    assert.equal(b.maxTokens, DEPTH_TOKENS.deep);
    assert.equal(b.tierMaxTokens, DEPTH_TOKENS.deep);
    assert.equal(b.ceilingOverridden, false);
    assert.equal(b.ceilingBelowProseBudget, false, 'no override → nothing to warn about');
  });

  it('flags a ceiling below the tier prose budget (the ceiling must not truncate)', () => {
    const tight = resolveOutputBudget({ explicitDepth: 'deep', explicitMaxTokens: true, maxTokens: 500 });
    assert.equal(tight.ceilingBelowProseBudget, true,
      `500 < deep visible budget ${DEPTH_VISIBLE_TOKENS.deep} — the user must be warned before the spend`);

    const roomy = resolveOutputBudget({ explicitDepth: 'deep', explicitMaxTokens: true, maxTokens: 99_000 });
    assert.equal(roomy.ceilingBelowProseBudget, false);
  });

  it('explicitMaxTokens=false ignores any stale maxTokens value', () => {
    // Defensive: the flag, not the number, decides whether an override happened.
    const b = resolveOutputBudget({ explicitDepth: 'shallow', explicitMaxTokens: false, maxTokens: 12 });
    assert.equal(b.maxTokens, DEPTH_TOKENS.shallow);
    assert.equal(b.ceilingOverridden, false);
  });

  it('tolerates a null/garbage args object (matches resolveDepth\'s contract)', () => {
    for (const bad of [undefined, null, 'nonsense', 42]) {
      const b = resolveOutputBudget(bad);
      assert.equal(b.depth, 'standard');
      assert.equal(b.wordTarget, DEPTH_WORD_TARGETS.standard);
      assert.equal(b.ceilingOverridden, false);
    }
  });

  it('an unknown depth still throws (validation is not bypassed by the ceiling)', () => {
    assert.throws(
      () => resolveOutputBudget({ explicitDepth: 'enormous', explicitMaxTokens: true, maxTokens: 100 }),
      /Unknown depth/,
    );
  });
});
