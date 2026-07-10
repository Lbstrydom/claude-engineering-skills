/**
 * @fileoverview A1 integration test — the guard must fire END-TO-END through the CLI:
 * a code audit whose plan resolves to ZERO implementation files exits non-zero, prints
 * the refusal, and writes NO (hollow) result file. The pure predicate is unit-tested in
 * audit-subject-file-guard.test.mjs; this locks the WIRING (guard placement + main()'s
 * fail-loud catch) so a future refactor can't silently restore the hollow-verdict bug.
 * Per the testing doctrine this is a "silent regression, likely + expensive" seam.
 *
 * No API call is made: the guard throws BEFORE any GPT pass, so a dummy OpenAI key
 * suffices — BUT `main()` unconditionally runs `initAuditBrief()` first (Gemini Flash
 * → Claude Haiku → regex fallback chain), and Claude Haiku's `sdk`/`cli` backend
 * selection reads `CLAUDE_BACKEND` from the environment. Without pinning it here, a
 * developer machine with `CLAUDE_BACKEND=cli` set locally (routes through a real `claude
 * -p` subprocess) causes this test to make a real, slow LLM call before the guard ever
 * fires — 76-84s observed, dangerously close to the 90s timeout and the actual root
 * cause of this test's documented intermittent CI flakiness. `CLAUDE_BACKEND: 'sdk'`
 * below (paired with the already-empty `ANTHROPIC_API_KEY`) forces the fast, real
 * "no API call is made" regex-only brief fallback the docstring always claimed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('CLI: a code audit over a plan whose files do not exist refuses (exit≠0, no result file)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-a1-'));
  const plan = path.join(dir, 'plan.md');
  const out = path.join(dir, 'result.json');
  fs.writeFileSync(plan, '# Plan\n\nImplement `src/totally-nonexistent-impl-xyz.mjs` and `src/another-ghost-file.mjs`.\n');

  let exitCode = 0;
  let output = '';
  try {
    execFileSync(process.execPath, ['scripts/openai-audit.mjs', 'code', plan, '--scope', 'plan', '--out', out], {
      encoding: 'utf8',
      // Minimize pre-guard external work; the guard fires before any LLM pass.
      env: {
        ...process.env,
        OPENAI_API_KEY: 'sk-test-dummy-key', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '',
        CLAUDE_BACKEND: 'sdk',
        MODEL_CATALOG_REFRESH: 'skip', LEARNING_DISABLE: '1', AUDIT_DB_URL: '',
      },
      timeout: 90000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    exitCode = e.status ?? 1;
    output = `${e.stdout || ''}${e.stderr || ''}`;
  }

  assert.notEqual(exitCode, 0, `expected non-zero exit; got ${exitCode}. output:\n${output.slice(-800)}`);
  assert.match(output, /0 implementation files|refusing to emit a verdict|reached the prompt/i, 'must print the A1 refusal');
  assert.ok(!fs.existsSync(out), 'must NOT write a hollow result file when refusing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: an explicit but unreadable --diff (the base..HEAD range-misuse) fails fast', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-diff-'));
  const plan = path.join(dir, 'plan.md');
  const out = path.join(dir, 'result.json');
  fs.writeFileSync(plan, '# Plan\n\nImplement `src/x.mjs`.\n');

  let exitCode = 0;
  let output = '';
  try {
    // `HEAD~1..HEAD` is a git RANGE, not a file → the read throws → must fail fast,
    // not warn-and-proceed (quasi-silent degradation). Fires before any GPT pass.
    execFileSync(process.execPath, ['scripts/openai-audit.mjs', 'code', plan, '--scope', 'plan', '--diff', 'HEAD~1..HEAD', '--out', out], {
      encoding: 'utf8',
      env: { ...process.env, OPENAI_API_KEY: 'sk-test-dummy-key', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', CLAUDE_BACKEND: 'sdk', MODEL_CATALOG_REFRESH: 'skip', LEARNING_DISABLE: '1', AUDIT_DB_URL: '' },
      timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    exitCode = e.status ?? 1;
    output = `${e.stdout || ''}${e.stderr || ''}`;
  }

  assert.notEqual(exitCode, 0, `expected non-zero exit; got ${exitCode}. output:\n${output.slice(-800)}`);
  assert.match(output, /not a readable file|git RANGE|unified-diff FILE/i, 'must explain the --diff misuse');
  assert.ok(!fs.existsSync(out), 'must NOT write a result file');
  fs.rmSync(dir, { recursive: true, force: true });
});
