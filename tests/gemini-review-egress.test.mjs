/**
 * @fileoverview Single-envelope egress safety (H2/C3) for the provider-agnostic
 * final review. The review payload is assembled ONCE in runFinalReview through
 * the sensitive-path-filtered readFilesAsContext, and every transport adapter
 * receives only that string — so adding a gateway route cannot open a new egress
 * path. This asserts the built envelope excludes a sensitive file's contents.
 *
 * Tier-3-adjacent: a leak here ships proprietary/secret content to a third-party
 * gateway that ordinary provider-selection tests would never catch.
 */
process.env.FINAL_REVIEW_MODEL = 'test-model';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runFinalReview } = await import('../scripts/gemini-review.mjs');

const VALID_REVIEW = JSON.stringify({
  verdict: 'APPROVE',
  deliberation_quality: { claude_bias_detected: false, gpt_false_positive_count: 0, deliberation_was_fair: true, quality_summary: 'ok' },
  new_findings: [], wrongly_dismissed: [], over_engineering_flags: [],
  architectural_coherence: 'Strong', overall_reasoning: 'ok',
});

describe('final-review egress envelope (H2/C3)', () => {
  let dir; let prevCwd;

  before(() => {
    prevCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'fr-egress-'));
    writeFileSync(join(dir, 'foo.js'), '// NORMAL_MARKER content\nexport const x = 1;\n');
    writeFileSync(join(dir, '.env'), 'SECRET_MARKER=super-secret-value\n');
    process.chdir(dir); // readFilesAsContext resolves relative paths against cwd
  });

  after(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  // Every transport receives the SAME single envelope built in runFinalReview.
  // Capture each transport's outbound user-content and assert the same exclusion,
  // so a future adapter can't quietly construct a different (leaking) payload.
  const CASES = [
    {
      provider: 'openai-compatible', // → openai transport
      client: (capture) => ({ chat: { completions: { create: async (body) => {
        capture(body.messages.find((m) => m.role === 'user')?.content ?? '');
        return { choices: [{ message: { content: VALID_REVIEW }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      } } } }),
    },
    {
      provider: 'claude-opus', // → anthropic transport
      client: (capture) => ({ messages: { create: async (body) => {
        capture(body.messages?.[0]?.content ?? '');
        return { content: [{ type: 'text', text: VALID_REVIEW }], usage: { input_tokens: 1, output_tokens: 1 } };
      } } }),
    },
    {
      provider: 'gemini', // → gemini transport
      client: (capture) => ({ models: { generateContentStream: async (req) => {
        capture(req.contents ?? '');
        return (async function* () { yield { text: VALID_REVIEW, usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 0 } }; })();
      } } }),
    },
  ];

  for (const { provider, client } of CASES) {
    test(`the ${provider} route's envelope includes the code file but NOT the sensitive .env`, async () => {
      let captured = null;
      const fakeClient = client((p) => { captured = p; });
      const transcript = JSON.stringify({ code_files: ['foo.js', '.env'], changed_files: ['foo.js'] });
      const { result } = await runFinalReview(provider, fakeClient, '# plan', transcript, 'ctx', 'code');

      assert.equal(result.verdict, 'APPROVE');
      assert.ok(captured, 'adapter received the single envelope');
      assert.match(captured, /NORMAL_MARKER/, 'ordinary code file IS included');
      assert.doesNotMatch(captured, /SECRET_MARKER/, 'sensitive .env is filtered out of the envelope');
    });
  }
});
