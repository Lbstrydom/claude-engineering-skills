/**
 * @fileoverview Background-safe termination (D1/D2/H3) — the regression guard for
 * the reported bug: the review CLI used to RETURN from main() and rely on natural
 * event-loop drain, so a lingering LLM-SDK keep-alive socket blocked exit —
 * invisible foreground (the harness reaps on its own timeout) but an indefinite
 * hang in a detached background run.
 *
 * This is a REAL-ROUTE test (not fixture-only): it stands up a local
 * OpenAI-compatible server that answers with a valid review but keeps the socket
 * alive, then drives the actual CLI through the `openai-compatible` provider and
 * asserts the process EXITS promptly. A fixture-only assertion would not prove the
 * real SDK/socket path reaches finishAndExit.
 *
 * LEARNING_DISABLE=1 keeps these smoke runs out of the cloud learning store; the
 * keep-alive socket to the local server is the lingering handle under test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'scripts', 'gemini-review.mjs');

const VALID_REVIEW = JSON.stringify({
  verdict: 'APPROVE',
  deliberation_quality: { claude_bias_detected: false, gpt_false_positive_count: 0, deliberation_was_fair: true, quality_summary: 'ok' },
  new_findings: [], wrongly_dismissed: [], over_engineering_flags: [],
  architectural_coherence: 'Strong', overall_reasoning: 'ok',
});

const dir = mkdtempSync(join(tmpdir(), 'fr-term-'));
const planFile = join(dir, 'plan.md');
const transcriptFile = join(dir, 'transcript.json');
writeFileSync(planFile, '# plan\n');
writeFileSync(transcriptFile, JSON.stringify({ changed_files: [], code_files: [] }));

/** Spawn the review CLI; resolve with {code, timedOut} — kills after `killMs`. */
function runCli(args, env, killMs = 12000) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // Isolate the SDK keep-alive socket (the handle under test) from
        // orthogonal network deps: no brief-gen LLM (regex-only brief), no
        // cloud pg pool, no catalog refresh. dotenv won't override these.
        LEARNING_DISABLE: '1', MODEL_CATALOG_REFRESH: 'skip', CLAUDE_BACKEND: 'sdk',
        ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', AUDIT_DB_URL: '',
        ...env,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const killer = setTimeout(() => { child.kill('SIGKILL'); resolvePromise({ code: null, timedOut: true }); }, killMs);
    child.on('exit', (code) => { clearTimeout(killer); resolvePromise({ code, timedOut: false }); });
  });
}

/** Start a local OpenAI-compatible server. `mode`: 'ok' answers; 'hang' never responds. */
function startServer(mode) {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      if (mode === 'hang') return; // accept the socket, never respond
      const body = JSON.stringify({
        id: 'x', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: VALID_REVIEW }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'keep-alive' });
      res.end(body);
    });
    server.keepAliveTimeout = 60000; // hold the socket open — the lingering handle under test
    server.listen(0, '127.0.0.1', () => resolvePromise({ server, port: server.address().port }));
  });
}

describe('review CLI terminates (background-safe)', () => {
  test('real openai-compatible route + keep-alive socket → exits 0 WITH --out', async () => {
    const { server, port } = await startServer('ok');
    try {
      const outFile = join(dir, 'out-a.json');
      const { code, timedOut } = await runCli(
        ['review', planFile, transcriptFile, '--provider', 'openai-compatible', '--out', outFile],
        { FINAL_REVIEW_BASE_URL: `http://127.0.0.1:${port}/v1`, FINAL_REVIEW_API_KEY: 'x', FINAL_REVIEW_MODEL: 'test-model' },
      );
      assert.equal(timedOut, false, 'CLI must not hang on the lingering keep-alive socket');
      assert.equal(code, 0);
      assert.ok(existsSync(outFile), '--out artifact written');
    } finally { server.close(); }
  });

  test('same route WITHOUT --out also terminates 0 (L1 — --out is not a termination prerequisite)', async () => {
    const { server, port } = await startServer('ok');
    try {
      const { code, timedOut } = await runCli(
        ['review', planFile, transcriptFile, '--provider', 'openai-compatible'],
        { FINAL_REVIEW_BASE_URL: `http://127.0.0.1:${port}/v1`, FINAL_REVIEW_API_KEY: 'x', FINAL_REVIEW_MODEL: 'test-model' },
      );
      assert.equal(timedOut, false);
      assert.equal(code, 0);
    } finally { server.close(); }
  });

  test('a hung provider terminates via the per-attempt timeout (bounded, non-zero — never an infinite hang)', async () => {
    const { server, port } = await startServer('hang');
    try {
      // The invariant under test is BOUNDED termination — the CLI exits on its
      // own and never relies on the harness reaper (the original keep-alive-socket
      // bug hung INDEFINITELY). It is NOT a wall-clock SLA. A hung provider throws
      // on attempt 1 (runReviewWithRetry only retries JSON-truncation, not
      // timeouts), so the CLI's own bound is ~GEMINI_REVIEW_TIMEOUT_MS + node
      // startup + SDK teardown — a couple of seconds. But this is a spawned child
      // in the full `npm test` pool: under CPU starvation, node startup + timer
      // firing for this large module can slip several seconds, which is what made
      // a tight 10s killer flake (observed 10.4s). The killer is a no-hang safety
      // net, not a latency probe — give it generous headroom so contention can't
      // trip it, while a genuine (infinite) hang still fails loudly. It costs
      // nothing on the normal path: the child exits in ~2s and resolves at once.
      const { code, timedOut } = await runCli(
        ['review', planFile, transcriptFile, '--provider', 'openai-compatible', '--out', join(dir, 'out-h.json')],
        { FINAL_REVIEW_BASE_URL: `http://127.0.0.1:${port}/v1`, FINAL_REVIEW_API_KEY: 'x', FINAL_REVIEW_MODEL: 'test-model', GEMINI_REVIEW_TIMEOUT_MS: '1500' },
        30000,
      );
      assert.equal(timedOut, false, 'a hung provider must not hang the CLI (bounded termination, no reaper reliance)');
      assert.notEqual(code, 0, 'a hung/aborted review exits non-zero');
    } finally { server.close(); }
  });

  test('fixture path exits 0', async () => {
    const { code, timedOut } = await runCli(
      ['review', planFile, transcriptFile, '--provider', 'fixture', '--out', join(dir, 'out-fx.json')],
      { NODE_ENV: 'test' },
    );
    assert.equal(timedOut, false);
    assert.equal(code, 0);
  });
});

test.after?.(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
