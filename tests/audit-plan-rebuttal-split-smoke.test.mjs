/**
 * @fileoverview Regression coverage for the tiered-recall pipeline Phase 11
 * split — the 5 mode-agnostic GPT-calling primitives (`_callGPTOnce`,
 * `callGPT`, `safeCallGPT`, `getPassPrompt`, `buildCachePrompt`) moved out of
 * `openai-audit.mjs` into the neutral `scripts/lib/audit/llm-helpers.mjs`
 * (Gemini gate fix G2, round 3), specifically so `/audit-plan`'s `plan` and
 * `rebuttal` CLI modes — which call `callGPT` directly, NOT through
 * `legacy-production-audit.mjs` — keep working unchanged.
 *
 * `tests/openai-wrapper-contract.test.mjs` already covers the primitives
 * themselves in isolation (via `__testExports`, now resolving through their
 * new `llm-helpers.mjs` home) and `tests/run-multi-pass-code-audit-harness
 * .test.mjs` already exercises `getPassPrompt`/`buildCachePrompt` for real
 * (every stubbed code-audit pass constructs its prompt through them). What
 * NEITHER covers is `main()`'s OWN `plan`/`rebuttal` dispatch code — this
 * file closes that gap with a real (dummy-key) subprocess invocation per
 * mode: a clean, EXPECTED runtime failure (dummy key → provider auth error)
 * proves the import graph resolved and the call reached the provider: not
 * an import-time `ReferenceError`/`Cannot find module`, which is exactly
 * the class of bug a broken relocation would produce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DUMMY_ENV = {
  ...process.env,
  OPENAI_API_KEY: 'sk-test-dummy-key', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '',
  MODEL_CATALOG_REFRESH: 'skip', LEARNING_DISABLE: '1', AUDIT_DB_URL: '',
  AUDIT_NO_PREFLIGHT: '1',
  // Force the SDK backend (not `cli`) for Claude calls in this smoke test —
  // with no ANTHROPIC_API_KEY, `initAuditBrief`'s Claude-Haiku attempt then
  // fails FAST (missing key) instead of spawning a `claude -p` subprocess,
  // which can take 60-90s in some environments and has nothing to do with
  // this test's actual target (the Phase 11 import-graph split). A stray
  // per-machine `CLAUDE_BACKEND=cli` in a developer's own `.env` must not
  // slow down or flake this test.
  CLAUDE_BACKEND: 'sdk',
};

function runCli(args) {
  let exitCode = 0;
  let output = '';
  try {
    output = execFileSync(process.execPath, ['scripts/openai-audit.mjs', ...args], {
      encoding: 'utf8', env: DUMMY_ENV, timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    exitCode = e.status ?? 1;
    output = `${e.stdout || ''}${e.stderr || ''}`;
  }
  return { exitCode, output };
}

test('plan mode: main() resolves its imports and reaches callGPT (a clean provider auth error, never a ReferenceError/module-resolution crash)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-plan-smoke-'));
  const plan = path.join(dir, 'plan.md');
  fs.writeFileSync(plan, '# Plan\n\nA trivial plan for the split-regression smoke test.\n');

  const { exitCode, output } = runCli(['plan', plan]);

  assert.notEqual(exitCode, 0, `expected a provider-auth-error exit (dummy key); got 0. output:\n${output.slice(-800)}`);
  assert.doesNotMatch(output, /ReferenceError|Cannot find module|is not defined|is not a function/i,
    `plan mode must fail on the PROVIDER call, never on a broken import from the Phase 11 split. output:\n${output.slice(-800)}`);
  assert.match(output, /401|Incorrect API key|api-keys/i, `expected a clean OpenAI auth error. output:\n${output.slice(-800)}`);

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('rebuttal mode: main() resolves its imports and reaches callGPT (a clean provider auth error, never a ReferenceError/module-resolution crash)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rebuttal-smoke-'));
  const plan = path.join(dir, 'plan.md');
  const rebuttal = path.join(dir, 'rebuttal.md');
  fs.writeFileSync(plan, '# Plan\n\nA trivial plan for the split-regression smoke test.\n');
  fs.writeFileSync(rebuttal, 'Claude accepts finding H1.\n');

  const { exitCode, output } = runCli(['rebuttal', plan, rebuttal]);

  assert.notEqual(exitCode, 0, `expected a provider-auth-error exit (dummy key); got 0. output:\n${output.slice(-800)}`);
  assert.doesNotMatch(output, /ReferenceError|Cannot find module|is not defined|is not a function/i,
    `rebuttal mode must fail on the PROVIDER call, never on a broken import from the Phase 11 split. output:\n${output.slice(-800)}`);
  assert.match(output, /401|Incorrect API key|api-keys/i, `expected a clean OpenAI auth error. output:\n${output.slice(-800)}`);

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
