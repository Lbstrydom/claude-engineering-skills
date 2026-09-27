/**
 * The model-eval harness's native-Anthropic route must never run on the `cli`
 * backend. That backend reads only {model, max_tokens, system, messages}, so a
 * `temperature` dial is silently dropped while `honoredDials.temperature`
 * still records true, and a `claude -p` call is not the API request being
 * evaluated. Before the fix the public route built its client with the ambient
 * backend, and this machine's `.env` sets `CLAUDE_BACKEND=cli`.
 *
 * Asserted on BEHAVIOUR, not client config: `CLAUDE_BIN` points at a fake
 * binary that leaves a marker when spawned. The fake answers with valid JSON,
 * so before the fix the call SUCCEEDED through it (the test failed on the
 * marker). After the fix the sdk backend runs with no key and refuses before
 * any network call.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { invokeStructured } from '../scripts/lib/model-eval/provider-adapter.mjs';
import { _resetClientCache } from '../scripts/lib/anthropic-client.mjs';

// Everything the client resolves ambiently, plus the Azure profile (a set
// AZURE_OPENAI_ENDPOINT changes routing): the verdict must not depend on the
// operator's shell. ANTHROPIC_API_KEY is removed so the sdk path can never
// reach the network from a test.
const SCRUB = ['CLAUDE_BACKEND', 'CLAUDE_BIN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_CLAUDE_ROUTE', 'AWS_REGION', 'AWS_DEFAULT_REGION'];
let tmpDir;
let saved;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-sdk-pin-'));
  saved = Object.fromEntries(SCRUB.map((k) => [k, process.env[k]]));
  for (const k of SCRUB) delete process.env[k];
  _resetClientCache();
});

afterEach(() => {
  for (const k of SCRUB) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  _resetClientCache();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function fakeClaudeBinary(markerPath) {
  const script = path.join(tmpDir, 'fake-claude.mjs');
  const envelope = JSON.stringify({ result: '{"ok":true}', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.001, num_turns: 1 });
  fs.writeFileSync(script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(markerPath)}, 'spawned');\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(envelope)}));\n`);
  if (process.platform === 'win32') {
    const cmd = path.join(tmpDir, 'fake-claude.cmd');
    fs.writeFileSync(cmd, `@echo off\r\nnode "${script}" %*\r\n`);
    return cmd;
  }
  const sh = path.join(tmpDir, 'fake-claude.sh');
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
  return sh;
}

test('invokeStructured (native-anthropic, public route) never spawns the claude CLI, even with CLAUDE_BACKEND=cli ambient', async () => {
  const marker = path.join(tmpDir, 'spawned.txt');
  process.env.CLAUDE_BACKEND = 'cli';
  process.env.CLAUDE_BIN = fakeClaudeBinary(marker);

  const outcome = await invokeStructured({
    route: { provider: 'anthropic', transport: 'native-anthropic', resolvedModel: 'claude-sonnet-5' },
    messages: [{ role: 'user', content: 'Return {"ok": true}.' }],
    schema: z.object({ ok: z.boolean() }),
    dials: { temperature: 0.2 },
  }).then((r) => ({ ok: true, r }), (err) => ({ ok: false, err }));

  assert.equal(fs.existsSync(marker), false, 'the eval request was sent through `claude -p`, which drops temperature while honoredDials says it was applied');
  // With no key, the sdk backend must refuse locally rather than succeed some other way.
  assert.equal(outcome.ok, false, 'no ANTHROPIC_API_KEY: the sdk path cannot have produced a result');
});
