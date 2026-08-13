/**
 * @fileoverview `azure:routes` must TERMINATE.
 *
 * Reported from a consumer's Azure work repo on 2026-08-13: `npm run azure:routes`
 * authenticated all three routes, printed "All probed routes authenticated.", and
 * then the Node process stayed alive for over five minutes and had to be killed.
 * The route authentication itself was correct — this is a process-lifecycle
 * defect, and it is the kind no in-process assertion can catch: a test that
 * imports the module and calls a function never observes whether the PROCESS
 * would have exited.
 *
 * So this drives the real CLI as a SUBPROCESS against a stub endpoint and
 * asserts a bounded exit. The stub answers with `connection: keep-alive`, which
 * is what a real endpoint does and what an SDK will happily hold open.
 *
 * `gemini-review.mjs` had already solved this class for itself (its own
 * `finishAndExit`, whose docstring calls it "the hang this whole change exists
 * to remove"); the route doctor was written without it. The primitive now lives
 * in `lib/cli-io.mjs` so the next CLI inherits it instead of rediscovering it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A stub Azure endpoint that answers all three probed surfaces with 200 + keep-alive. */
async function startStub() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = req.url || '';
      const payload = url.includes('/embeddings')
        ? { data: [{ embedding: [0.1, 0.2], index: 0 }], model: 'x', usage: {} }
        : url.includes('/anthropic/v1/messages')
          ? { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
          : { id: 'r', object: 'response', model: 'x', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: {} };
      const json = JSON.stringify(payload);
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(json),
        connection: 'keep-alive',       // the socket a hung CLI would be held by
      });
      res.end(json);
    });
  });
  server.keepAliveTimeout = 60_000;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

function envFor(port) {
  return {
    ...process.env,
    AZURE_OPENAI_ENDPOINT: `http://127.0.0.1:${port}/foundry`,
    AZURE_OPENAI_API_KEY: 'stub-key',
    AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-stub',
    AZURE_OPENAI_EMBED_DEPLOYMENT: 'embed-stub',
    AZURE_FOUNDRY_CLAUDE_DEPLOYMENT: 'claude-stub',
    AZURE_CLAUDE_ROUTE: 'apim',
    // Never let the doctor's own deadline be the thing that ends the test — the
    // assertion must be about the CLI finishing its work and leaving.
    AZURE_ROUTES_DEADLINE_MS: '120000',
  };
}

/** Run the CLI, resolving {code, out, ms} or rejecting on timeout. */
function runCli(args, env, limitMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'azure-doctor.mjs'), ...args],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`azure-doctor did not exit within ${limitMs}ms — it printed:\n${out.slice(-400)}`));
    }, limitMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, ''), ms: Date.now() - started });
    });
  });
}

describe('azure:routes process lifecycle', () => {
  test('exits promptly after every route authenticates', async (t) => {
    const { server, port } = await startStub();
    t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

    const r = await runCli(['--routes'], envFor(port), 45_000);
    assert.match(r.out, /All probed routes authenticated/, 'the stub should make every probe pass');
    assert.equal(r.code, 0, 'all-green must exit 0');
    // Generous, but finite: the point is termination, not speed. The reported
    // failure sat alive for >5 minutes.
    assert.ok(r.ms < 30_000, `expected a prompt exit, took ${r.ms}ms`);
  });

  test('exits — with a distinct non-zero code — when a route fails', async (t) => {
    const { server, port } = await startStub();
    t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

    // Point Claude at a host that does not resolve: the other two still pass, so
    // this exercises the mixed path rather than a total blackout.
    const env = { ...envFor(port), AZURE_CLAUDE_ROUTE: 'foundry', AZURE_AI_ENDPOINT: 'http://127.0.0.1:1/nope' };
    const r = await runCli(['--routes'], env, 60_000);
    assert.equal(r.code, 7, 'a failed route must exit 7, not hang and not exit 0');
    assert.match(r.out, /route\(s\) failed/);
  });

  test('the inactive fast path exits 0 without touching the network', async (t) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('AZURE_')) delete env[k];
    const r = await runCli(['--routes'], env, 20_000);
    assert.equal(r.code, 0);
    assert.match(r.out, /inactive/i);
  });

  test('--json output is not truncated by the exit', async (t) => {
    // The other half of why `finishAndExit` exists: on Windows a piped stdout is
    // async, so a bare `process.exit()` can drop whatever has not flushed. Here
    // stdout IS a pipe, so a truncating exit shows up as unparseable JSON.
    const { server, port } = await startStub();
    t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

    const r = await runCli(['--routes', '--json'], envFor(port), 45_000);
    const jsonLine = r.out.split('\n').filter(Boolean).find((l) => l.trimStart().startsWith('{'));
    assert.ok(jsonLine || r.out.includes('"routes"'), 'expected JSON on stdout');
    const parsed = JSON.parse(r.out.slice(r.out.indexOf('{')));
    assert.equal(parsed.active, true);
    assert.equal(parsed.routes.length, 3, 'all three route rows must survive the exit');
  });
});
