/**
 * @fileoverview Depth → prompt target → token ceiling contract.
 *
 * Regression suite for a four-part defect found empirically on 2026-07-19
 * (gpt-5.6-terra + gemini-pro-latest, `--depth shallow`):
 *
 *  1. Depth never reached the model. `BRAINSTORM_SYSTEM_PROMPT` hardcoded
 *     "250–500 words" for every tier, so `--depth deep` asked for the same
 *     length as `--depth shallow` and only moved where truncation happened.
 *  2. `shallow`'s 500-token ceiling was BELOW the prompt's own 250–500-word
 *     target (~335–670 tokens) — truncation was guaranteed by construction,
 *     before any reasoning overhead.
 *  3. Reasoning/thinking tokens are drawn from the same ceiling, turning a
 *     marginal overrun into a total one (OpenAI returned empty; Gemini a
 *     mid-sentence fragment).
 *  4. Truncation was reported as `state: 'success'` — a fragment rendered
 *     as a complete peer view. AGENTS.md: "audit your success paths".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveDepth,
  DEPTH_WORD_TARGETS,
  DEPTH_VISIBLE_TOKENS,
  REASONING_HEADROOM_TOKENS,
} from '../scripts/lib/brainstorm/depth-config.mjs';
import { buildBrainstormSystemPrompt, BRAINSTORM_SYSTEM_PROMPT } from '../scripts/lib/brainstorm/prompt.mjs';

const TIERS = ['shallow', 'standard', 'deep'];

test('every depth tier carries a distinct word target', () => {
  const targets = TIERS.map((t) => DEPTH_WORD_TARGETS[t]);
  assert.equal(new Set(targets).size, TIERS.length,
    'depth must change what is ASKED FOR, not merely where truncation lands');
});

test('the word target reaches the system prompt', () => {
  for (const tier of TIERS) {
    const prompt = buildBrainstormSystemPrompt({ wordTarget: DEPTH_WORD_TARGETS[tier] });
    assert.ok(prompt.includes(DEPTH_WORD_TARGETS[tier]),
      `${tier}: prompt must state its own word target`);
  }
  // The historical bug: deep and shallow produced identical instructions.
  assert.notEqual(
    buildBrainstormSystemPrompt({ wordTarget: DEPTH_WORD_TARGETS.shallow }),
    buildBrainstormSystemPrompt({ wordTarget: DEPTH_WORD_TARGETS.deep }),
  );
});

test('the ceiling always exceeds the prose the prompt asks for', () => {
  for (const tier of TIERS) {
    const { maxTokens } = resolveDepth({ explicitDepth: tier });
    // Upper bound of the word range → tokens. English averages ~1.33
    // tokens/word; 1.6 is a deliberately pessimistic factor.
    const upperWords = Number(String(DEPTH_WORD_TARGETS[tier]).match(/(\d+)\s*$|(\d+)(?=\s*words)/)?.[0]
      ?? String(DEPTH_WORD_TARGETS[tier]).match(/\d+/g).pop());
    const worstCaseProseTokens = Math.ceil(upperWords * 1.6);
    assert.ok(maxTokens > worstCaseProseTokens,
      `${tier}: ceiling ${maxTokens} must exceed worst-case prose ${worstCaseProseTokens} — `
      + 'a ceiling below the requested length truncates by construction');
  }
});

test('the ceiling reserves headroom for reasoning tokens on top of prose', () => {
  for (const tier of TIERS) {
    const { maxTokens, visibleTokens } = resolveDepth({ explicitDepth: tier });
    assert.ok(maxTokens >= visibleTokens + REASONING_HEADROOM_TOKENS[tier],
      `${tier}: reasoning tokens share max_output_tokens, so the ceiling must be `
      + 'prose + headroom, never prose alone');
  }
});

test('shallow specifically survives a reasoning model — the field failure', () => {
  const { maxTokens } = resolveDepth({ explicitDepth: 'shallow' });
  assert.ok(maxTokens >= 2000,
    `shallow ceiling ${maxTokens} is too tight: gpt-5.6 burned 500 tokens reasoning `
    + 'and returned finish_reason:length with no text at all');
});

test('depth ordering is monotonic in both prose and ceiling', () => {
  const r = TIERS.map((t) => resolveDepth({ explicitDepth: t }));
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i].visibleTokens > r[i - 1].visibleTokens, 'prose target must increase');
    assert.ok(r[i].maxTokens > r[i - 1].maxTokens, 'ceiling must increase');
  }
});

test('resolveDepth still honours explicit > auto-promote > standard', () => {
  assert.equal(resolveDepth({ explicitDepth: 'shallow', topic: 'refactor the schema' }).depth, 'shallow');
  assert.equal(resolveDepth({ topic: 'how should we structure this' }).depth, 'deep');
  assert.equal(resolveDepth({ topic: 'what should we name it' }).depth, 'standard');
  assert.throws(() => resolveDepth({ explicitDepth: 'wat' }), /Unknown depth/);
  assert.throws(() => resolveDepth({ explicitDepth: 'constructor' }), /Unknown depth/);
});

test('the back-compat constant still exists and matches standard depth', () => {
  assert.ok(BRAINSTORM_SYSTEM_PROMPT.includes(DEPTH_WORD_TARGETS.standard));
  assert.match(BRAINSTORM_SYSTEM_PROMPT, /thoughtful brainstorming partner/);
});

test('DEPTH_VISIBLE_TOKENS and the word targets do not contradict each other', () => {
  for (const tier of TIERS) {
    const upperWords = Number(String(DEPTH_WORD_TARGETS[tier]).match(/\d+/g).pop());
    assert.ok(DEPTH_VISIBLE_TOKENS[tier] >= Math.ceil(upperWords * 1.33),
      `${tier}: the visible-token figure must be able to hold its own word target`);
  }
});
