/**
 * @fileoverview Tier-2 invariant test for the GREEN ≠ REALIZED Cluster B runtime-truth audit
 * rules (plan: docs/completed/green-not-realized.md, Phase 5). NOT a grep of the source — it asserts
 * the rule text survives into the BUILT pass prompt (`PASS_PROMPTS.frontend`, the exact string
 * `openai-audit.mjs` bootstraps into the registry and injects). A prose drift that drops the
 * checkable-artifact demand would let the derived-state-parity rule silently degrade to "consider
 * agreement" — itself green-but-not-realized — so this pins the load-bearing phrases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PASS_PROMPTS, PASS_FRONTEND_RUBRIC } from '../scripts/lib/prompt-seeds.mjs';

test('frontend pass prompt carries the derived-state-parity rule (built injection path)', () => {
  const built = PASS_PROMPTS.frontend;
  assert.ok(built.includes('DERIVED-STATE PARITY'), 'rule header present in the built prompt');
  // It must demand a CHECKABLE ARTIFACT, not prose — the three named escape hatches.
  assert.ok(/data-engine-claim/.test(built), 'nudges the consistency-contract surface declaration');
  assert.ok(/source-of-truth/i.test(built), 'shared-SSoT artifact named');
  assert.ok(/parity assertion/i.test(built), 'parity-assertion artifact named');
  // It must explicitly reject prose-only "keep in sync" guidance.
  assert.ok(/green-but-not-realized/i.test(built), 'explicitly rejects prose-only agreement');
});

test('frontend pass prompt carries the freeze-semantics rule (#5)', () => {
  assert.ok(PASS_PROMPTS.frontend.includes('FREEZE-SEMANTICS'), 'freeze-semantics rule present');
  assert.ok(/SEMANTICS match/i.test(PASS_PROMPTS.frontend), 'demands proving source semantics, not just naming it');
});

test('the rule lives in the rubric constant, so it survives registry bootstrap', () => {
  // PASS_PROMPTS.frontend = objective + PASS_FRONTEND_RUBRIC; pin the source of the phrase.
  assert.ok(PASS_FRONTEND_RUBRIC.includes('DERIVED-STATE PARITY'));
  assert.ok(PASS_PROMPTS.frontend.endsWith(PASS_FRONTEND_RUBRIC) || PASS_PROMPTS.frontend.includes(PASS_FRONTEND_RUBRIC));
});
