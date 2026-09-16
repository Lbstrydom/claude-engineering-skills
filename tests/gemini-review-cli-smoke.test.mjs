/**
 * @fileoverview Fresh-process CLI smoke test — the one gap the decomposition
 * plan's Testing Strategy mapping surfaced (docs/plans/gemini-review-decomposition.md,
 * Phase 2 close-out): no existing test drove the real `main()` entrypoint
 * from a genuinely fresh `node` process, so nothing proved the relocated
 * modules' cross-file initialization order (e.g. `providers.mjs`'s module
 * load resolving `MODEL` before `main()` calls `refreshProviderModels()`) or
 * exercised stdout/stderr/exit-code behaviour post-decomposition. The 22
 * existing `gemini-review-*`/`final-review-*` test files all import the
 * module in-process — Node's module cache and any state a test file already
 * warmed can hide a real cross-module wiring defect that only a cold spawn
 * would surface.
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

/** Spawn the real CLI, capturing stdout/stderr; resolve {code, timedOut, stdout, stderr}. */
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
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise({ code: null, timedOut: true, stdout, stderr });
    }, killMs);
    child.on('exit', (code) => { clearTimeout(killer); resolvePromise({ code, timedOut: false, stdout, stderr }); });
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
