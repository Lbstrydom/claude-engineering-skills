/**
 * @fileoverview `runFinalReview`'s plan-derived code-path fallback must
 * actually populate the reviewed code set, not silently drop it.
 *
 * The defect (audit finding d33109ef, 2026-08-14): `codePaths` is assembled by
 * an if / else-if / else chain over the transcript shape — `reduced` scope,
 * `transcript.code_files` present, or (this suite's target) neither, falling
 * back to file paths cited in the PLAN text via `extractPlanPaths`. A
 * statement trapped inside the wrong branch's condition, or one that read
 * something not declared in its own branch, would leave `codePaths` at its
 * initial `[]` whenever the fallback branch — not the other two — was the one
 * actually selected, and the reviewer would silently see no code at all for a
 * plan-only transcript.
 *
 * This exercises exactly that branch: a transcript with NO `code_files` (so
 * neither the `reduced`-scope selector nor the code_files branch fires) and a
 * plan citing a real file by path. The envelope sent to the provider must
 * contain that file's content.
 */
process.env.FINAL_REVIEW_MODEL = 'test-model';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runFinalReview } = await import('../scripts/gemini-review.mjs');

const VALID_REVIEW = JSON.stringify({
  verdict: 'APPROVE',
  deliberation_quality: { claude_bias_detected: false, gpt_false_positive_count: 0, deliberation_was_fair: true, quality_summary: 'ok' },
  new_findings: [], wrongly_dismissed: [], over_engineering_flags: [],
  architectural_coherence: 'Strong', overall_reasoning: 'ok',
});

describe('runFinalReview — plan-fallback codePaths branch', () => {
  let dir; let prevCwd;

  before(() => {
    prevCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'fr-plan-fallback-'));
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'config.mjs'), '// PLAN_CITED_MARKER content\nexport const y = 2;\n');
    process.chdir(dir); // readFilesAsContext / extractPlanPaths resolve relative to cwd
  });

  after(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('a transcript with no code_files falls back to plan-cited paths, and their content reaches the envelope', async () => {
    let captured = null;
    const fakeClient = {
      chat: {
        completions: {
          create: async (body) => {
            captured = body.messages.find((m) => m.role === 'user')?.content ?? '';
            return { choices: [{ message: { content: VALID_REVIEW }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
          },
        },
      },
    };

    const plan = 'Implement the thing described in `nested/config.mjs`.';
    // No `code_files` key at all — this is the exact shape that must route
    // through the plan-fallback branch, not the transcript.code_files branch.
    const transcript = JSON.stringify({ changed_files: [] });

    const { result } = await runFinalReview('openai-compatible', fakeClient, plan, transcript, 'ctx', 'plan');

    assert.equal(result.verdict, 'APPROVE');
    assert.ok(captured, 'adapter received the single envelope');
    assert.match(
      captured, /PLAN_CITED_MARKER/,
      'plan-cited file content must reach the envelope via the fallback codePaths branch — '
      + 'if this fails, codePaths was left empty and the reviewer saw no code at all',
    );
  });
});
