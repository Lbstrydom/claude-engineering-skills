/**
 * @fileoverview Fresh-process CLI smoke test — the one gap the decomposition
 * plan's Testing Strategy mapping surfaced (docs/plans/gemini-review-decomposition.md,
 * Phase 2 close-out): no existing test drove the real `main()` entrypoint
 * from a genuinely fresh `node` process. The 22 existing
 * `gemini-review-*`/`final-review-*` test files all import the module
 * in-process, so Node's module cache (already warm from an earlier import in
 * the same test run) can hide a wiring defect that only shows up on a cold
 * `node scripts/gemini-review.mjs` spawn — a broken import path or circular
 * dependency between the relocated `output-schemas.mjs`/`prompts.mjs`/
 * `transport.mjs`/`providers.mjs`/`shadow.mjs`/`post-review.mjs` modules that
 * still "works" once something else has already loaded them once.
 *
 * What this proves: the relocated module graph loads cleanly end-to-end in a
 * genuinely fresh process (no `MODULE_NOT_FOUND`/`ReferenceError` from a
 * broken cross-file import), and `main()`'s real dispatch reaches `ping` with
 * the expected stdout shape and exit code. It does NOT exercise the
 * `MODEL_CATALOG_REFRESH` live-catalog re-resolution path specifically —
 * that is set to `skip` below (deterministic, no live network call), the
 * same choice `tests/gemini-review-termination.test.mjs` already makes for
 * the same reason. (audit-code final-gate M6: an earlier draft of this
 * comment overclaimed proving that specific reassignment path.)
 *
 * A local HTTP server stands in for the `openai-compatible` transport (same
 * pattern as `tests/gemini-review-termination.test.mjs`) — a real subprocess,
 * a real SDK call, a real client construction path through the relocated
 * `providers.mjs`/`transport.mjs`, but no live credentials or network egress.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'scripts', 'gemini-review.mjs');

/** Start a local OpenAI-compatible server answering a fixed chat-completion ping reply. */
function startPingServer() {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const body = JSON.stringify({
        id: 'x', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolvePromise({ server, port: server.address().port }));
  });
}

/**
 * Spawn the real CLI, capturing stdout/stderr; resolve {code, timedOut, stdout, stderr}.
 *
 * Waits for `'close'`, not `'exit'` (audit-code final-gate M7): `'exit'` fires
 * as soon as the process terminates, which can race ahead of buffered stdio
 * data still arriving in `'data'` events — a real risk here specifically,
 * since (unlike `tests/gemini-review-termination.test.mjs`'s all-`'ignore'`
 * stdio) this test asserts on captured stdout/stderr CONTENT. `'close'` fires
 * only once every stdio stream has ended, so the accumulated strings are
 * guaranteed complete when the promise resolves. Same fix applied to the
 * timeout path: `kill()` is a signal, not synchronous teardown, so the
 * killer waits for the same `'close'` event too rather than resolving the
 * instant `SIGKILL` is requested.
 */
function runCli(args, env, killMs = 30000) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LEARNING_DISABLE: '1', MODEL_CATALOG_REFRESH: 'skip', AUDIT_DB_URL: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, killMs);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolvePromise({ code: timedOut ? null : code, timedOut, stdout, stderr });
    });
  });
}

describe('review CLI ping — fresh-process smoke test', () => {
  test('ping against a mocked openai-compatible transport exits 0 with the expected stdout shape', async () => {
    const { server, port } = await startPingServer();
    try {
      const { code, timedOut, stdout } = await runCli(
        ['ping', '--provider', 'openai-compatible'],
        { FINAL_REVIEW_BASE_URL: `http://127.0.0.1:${port}/v1`, FINAL_REVIEW_API_KEY: 'x', FINAL_REVIEW_MODEL: 'test-model' },
      );
      assert.equal(timedOut, false, 'CLI must not hang on a fresh cold spawn');
      assert.equal(code, 0);
      assert.match(stdout, /^ping OpenAI-compatible · provider=openai-compatible · transport=openai · model=test-model/m);
      assert.match(stdout, /✓ test-model: ready/);
    } finally { server.close(); }
  });

  test('ping with no configured provider fails loudly, not silently — same cold-spawn proof, the error path', async () => {
    const { code, timedOut, stderr } = await runCli(
      ['ping'],
      { GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', AZURE_OPENAI_ENDPOINT: '', FINAL_REVIEW_PROVIDER: '' },
    );
    assert.equal(timedOut, false);
    assert.notEqual(code, 0);
    assert.match(stderr, /Final review requires GEMINI_API_KEY, ANTHROPIC_API_KEY, or an active Azure profile/);
  });
});
