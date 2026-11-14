/**
 * The cli backend must refuse a call whose params it cannot honour.
 *
 * `cli` already refuses what it cannot REPRESENT (multi-turn histories,
 * assistant roles, non-text blocks — `assertOneShotTextMessages`) and what it
 * cannot TARGET (a baseURL — `reconcileBackendWithBaseUrl`). Both throw. The
 * params covered here were the silent third category: accepted, then dropped
 * or outranked, so the failure surfaced one layer up as a MODEL failure rather
 * than a transport failure.
 *
 * Measured 2026-11-14 (docs/plans/anthropic-cli-faithfulness-routing.md §6.B):
 * on `normalize-intent`'s own call shape the cli backend returned 1995 output
 * tokens in 40.0s against `max_tokens: 200` — a first-person Claude Code
 * session reply citing AGENTS.md — where the sdk backend returned the
 * requested one-line sentence in 29 tokens and 1.3s. `tools`/`tool_choice`
 * are the already-documented instance: AGENTS.md records a silent drop costing
 * the tiered-recall discovery generator a whole shadow window.
 *
 * @module tests/anthropic-cli-faithfulness
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAnthropicClient, _resetClientCache } from '../scripts/lib/anthropic-client.mjs';
import { unserviceableCliParams, cliFaithfulnessVerdict } from '../scripts/lib/anthropic-cli-faithfulness.mjs';

// Every env var the factory resolves ambiently. SCRUBBED, not merely saved:
// this suite's verdict must be a function of the repo, never of the operator's
// shell — and Claude Code desktop injects ANTHROPIC_BASE_URL into every child.
const AMBIENT_PROVIDER_ENV = [
  'CLAUDE_BACKEND', 'CLAUDE_BIN', 'CLAUDE_CLI_TIMEOUT_MS',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
  'AWS_REGION', 'AWS_DEFAULT_REGION',
  'CLAUDE_CLI_STRICT_MAX_TOKENS',
];

let tmpDir;
let savedEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anthropic-faith-'));
  savedEnv = {};
  for (const k of AMBIENT_PROVIDER_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  _resetClientCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  for (const k of AMBIENT_PROVIDER_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _resetClientCache();
});

/** A stand-in for the `claude` binary that prints a deterministic envelope. */
function writeFakeCli(resultText) {
  const scriptPath = path.join(tmpDir, 'faith-claude.mjs');
  const payload = JSON.stringify({
    result: resultText,
    usage: { input_tokens: 1, output_tokens: 1 },
    num_turns: 1,
  });
  fs.writeFileSync(
    scriptPath,
    `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(payload)});});\n`,
  );
  if (process.platform === 'win32') {
    const cmdPath = path.join(tmpDir, 'faith-claude.cmd');
    fs.writeFileSync(cmdPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`);
    return cmdPath;
  }
  const shPath = path.join(tmpDir, 'faith-claude.sh');
  fs.writeFileSync(shPath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, { mode: 0o755 });
  return shPath;
}

/**
 * An injected transport is the only vantage point that can prove a call left
 * via the sdk rather than via `claude -p`: the sdk client binds its transport
 * at CONSTRUCTION, so patching `globalThis.fetch` afterwards observes nothing.
 */
function sdkSpy() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'from-sdk' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const UNSERVICEABLE = [
  ['system', { system: 'Answer in ONE line. No preamble.' }],
  ['tools', { tools: [{ name: 'x', description: 'd', input_schema: { type: 'object' } }] }],
  ['tool_choice', { tool_choice: { type: 'tool', name: 'x' } }],
];

describe('cli faithfulness routing: ambient CLAUDE_BACKEND=cli', () => {
  for (const [label, extra] of UNSERVICEABLE) {
    it(`\`${label}\` routes the call to the sdk transport`, async () => {
      process.env.CLAUDE_BACKEND = 'cli';
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      process.env.CLAUDE_BIN = writeFakeCli('from-cli');
      const { calls, fetchImpl } = sdkSpy();
      const client = await createAnthropicClient({ fetch: fetchImpl, fresh: true });
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'ping' }],
        ...extra,
      });
      assert.equal(calls.length, 1, 'the call must leave via the sdk transport, not `claude -p`');
      assert.equal(resp.content[0].text, 'from-sdk');
    });
  }

  it('the routed call reaches the sdk with its params INTACT', async () => {
    process.env.CLAUDE_BACKEND = 'cli';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.CLAUDE_BIN = writeFakeCli('from-cli');
    const { calls, fetchImpl } = sdkSpy();
    const client = await createAnthropicClient({ fetch: fetchImpl, fresh: true });
    await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: 'Answer in ONE line.',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(
      calls[0].body.system,
      'Answer in ONE line.',
      'routing must preserve the contract — stripping `system` to make the call fit would reproduce the defect on the other backend',
    );
    assert.equal(calls[0].body.max_tokens, 200);
  });

  // POSITIVE CONTROL. A gate is not trustworthy until it has been seen NOT to
  // fire in the direction where it must not. Without this, the change could
  // quietly have become "ambient cli always means sdk" — which voids an
  // operator's explicit transport choice and moves EVERY call's spend from the
  // Max 20x credit to the API meter.
  it('BILLING PIN: serviceable params STAY on the cli transport', async () => {
    process.env.CLAUDE_BACKEND = 'cli';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const { calls, fetchImpl } = sdkSpy();
    const client = await createAnthropicClient({
      claudeBin: writeFakeCli('stayed-on-cli'),
      fetch: fetchImpl,
      fresh: true,
    });
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(resp.content[0].text, 'stayed-on-cli');
    assert.equal(calls.length, 0, 'no sdk call may be made for a call cli can serve faithfully');
  });

  it('an empty / whitespace `system` is serviceable (it carries no instruction)', async () => {
    process.env.CLAUDE_BACKEND = 'cli';
    const { calls, fetchImpl } = sdkSpy();
    const client = await createAnthropicClient({
      claudeBin: writeFakeCli('stayed-on-cli'),
      fetch: fetchImpl,
      fresh: true,
    });
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      system: '   ',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(resp.content[0].text, 'stayed-on-cli');
    assert.equal(calls.length, 0);
  });

  it('the warning names the param and fires ONCE per reason, not once per call', async () => {
    process.env.CLAUDE_BACKEND = 'cli';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.CLAUDE_BIN = writeFakeCli('from-cli');
    const { fetchImpl } = sdkSpy();
    const written = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk, ...rest) => {
      written.push(String(chunk));
      return origWrite.call(process.stderr, chunk, ...rest);
    };
    try {
      const client = await createAnthropicClient({ fetch: fetchImpl, fresh: true });
      const params = {
        model: 'claude-haiku-4-5',
        max_tokens: 100,
        system: 'be brief',
        messages: [{ role: 'user', content: 'ping' }],
      };
      await client.messages.create(params);
      await client.messages.create(params);
    } finally {
      process.stderr.write = origWrite;
    }
    const hits = written.filter(l => /`system` set . using the sdk backend/.test(l));
    assert.equal(hits.length, 1, 'once per reason');
    assert.match(hits[0], /CLAUDE_BACKEND=cli/);
  });
});

describe("cli faithfulness routing: explicit backend:'cli'", () => {
  for (const [label, extra] of UNSERVICEABLE) {
    it(`\`${label}\` throws — the caller contradicted itself`, async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      const client = await createAnthropicClient({
        backend: 'cli',
        claudeBin: writeFakeCli('from-cli'),
        fresh: true,
      });
      await assert.rejects(
        () => client.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'ping' }],
          ...extra,
        }),
        (e) => new RegExp('cannot honour `' + label + '`').test(e.message)
          && /backend:'sdk'/.test(e.message),
        'the throw must name the param AND the remedy',
      );
    });
  }

  it('serviceable params on an explicit cli backend still run on cli', async () => {
    const client = await createAnthropicClient({
      backend: 'cli',
      claudeBin: writeFakeCli('stayed-on-cli'),
      fresh: true,
    });
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(resp.content[0].text, 'stayed-on-cli');
  });
});

describe('unserviceableCliParams: the unit truth table', () => {
  const u = unserviceableCliParams;

  it('serviceable shapes return null', () => {
    assert.equal(u({ messages: [] }), null);
    assert.equal(u({}), null);
    assert.equal(u({ system: '' }), null);
    assert.equal(u({ system: ' \n ' }), null);
    assert.equal(u({ system: [] }), null, 'an empty structured system block carries no instruction');
  });

  it('`max_tokens` is deliberately NOT a refusal trigger', () => {
    assert.equal(
      u({ max_tokens: 100 }),
      null,
      'equally unenforced on cli, but every caller sets it — refusing on it would refuse every call, which is the "always sdk" outcome this routing exists to avoid',
    );
  });

  it('unserviceable shapes name the param', () => {
    assert.equal(u({ system: 'be brief' }).param, 'system');
    assert.equal(u({ system: [{ type: 'text', text: 'be brief' }] }).param, 'system');
    assert.equal(u({ tools: [] }).param, 'tools', 'an empty tools array is still a tool-using call shape');
    assert.equal(u({ tool_choice: { type: 'auto' } }).param, 'tool_choice');
  });

  it('every refusal carries a reason — the warning and the throw both quote it', () => {
    for (const [, extra] of UNSERVICEABLE) {
      const verdict = u(extra);
      assert.ok(verdict, 'must be refused');
      assert.ok(verdict.why && verdict.why.length > 20, 'a reasonless refusal is not actionable');
    }
  });
});

describe('cliFaithfulnessVerdict: the precedence rule', () => {
  it('serviceable params return null — the call proceeds on cli', () => {
    assert.equal(cliFaithfulnessVerdict({ max_tokens: 100 }, {}), null);
    assert.equal(cliFaithfulnessVerdict({ max_tokens: 100 }, { backendWasExplicit: true }), null);
  });

  it('ambient cli routes; explicit cli throws — on the SAME params', () => {
    const params = { system: 'be brief' };
    const ambient = cliFaithfulnessVerdict(params, {});
    const explicit = cliFaithfulnessVerdict(params, { backendWasExplicit: true });
    assert.equal(ambient.action, 'route');
    assert.equal(explicit.action, 'throw');
    assert.equal(ambient.param, 'system');
    assert.equal(explicit.param, 'system');
  });

  it('a route message names the ambient var it is overriding', () => {
    const v = cliFaithfulnessVerdict({ tools: [] }, {});
    assert.match(v.message, /CLAUDE_BACKEND=cli/);
    assert.match(v.message, /`tools`/);
    assert.ok(v.message.endsWith('\n'), 'it is written straight to stderr, so it carries its own newline');
  });

  it('a throw message names the param AND the remedy', () => {
    const v = cliFaithfulnessVerdict({ tool_choice: { type: 'any' } }, { backendWasExplicit: true });
    assert.match(v.message, /cannot honour `tool_choice`/);
    assert.match(v.message, /backend:'sdk'/);
  });
});

// ── the max_tokens exemption, and the operator's opt-out of it ──────────────
//
// Adjudicated 2026-11-14 (GPT ruling `compromise`, HIGH -> MEDIUM). The audit
// was right that an accepted-and-ignored `max_tokens` is the same CLASS of
// defect this change closes; the recommendation it shipped with ("refuse when
// max_tokens is supplied") was arithmetically "ambient cli always means sdk",
// because the Messages API requires max_tokens and all 17 ambient call sites
// set it. The landing is an OPERATOR-level strict path: default off so billing
// is untouched, opt in and the ceiling is honoured by routing.
describe('max_tokens: unenforced by default, strict on request', () => {
  it('DEFAULT: `max_tokens` alone is serviceable — refusing it would refuse every call', () => {
    delete process.env.CLAUDE_CLI_STRICT_MAX_TOKENS;
    assert.equal(unserviceableCliParams({ max_tokens: 100 }), null);
    assert.equal(cliFaithfulnessVerdict({ max_tokens: 100 }, {}), null);
  });

  it('STRICT: the operator opt-in makes an unenforceable ceiling unserviceable', () => {
    process.env.CLAUDE_CLI_STRICT_MAX_TOKENS = '1';
    const v = unserviceableCliParams({ max_tokens: 100 });
    assert.equal(v.param, 'max_tokens');
    assert.match(v.why, /CLAUDE_CLI_STRICT_MAX_TOKENS/);
    assert.match(v.why, /2254/, 'the reason carries the measurement, not just an assertion');
  });

  it('STRICT routes an ambient-cli call to the backend that honours the ceiling', async () => {
    process.env.CLAUDE_BACKEND = 'cli';
    process.env.CLAUDE_CLI_STRICT_MAX_TOKENS = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.CLAUDE_BIN = writeFakeCli('from-cli');
    const { calls, fetchImpl } = sdkSpy();
    const client = await createAnthropicClient({ fetch: fetchImpl, fresh: true });
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 64,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(calls.length, 1, 'strict mode must route, not warn-and-proceed');
    assert.equal(calls[0].body.max_tokens, 64, 'the ceiling the caller asked for must survive the routing');
    assert.equal(resp.content[0].text, 'from-sdk');
  });

  // MUST NOT FIRE. The whole point of the default is that an operator who has
  // not opted in keeps the Max 20x credit for calls cli serves correctly.
  it('BILLING PIN: without the opt-in, a max_tokens call STAYS on cli', async () => {
    process.env.CLAUDE_BACKEND = 'cli';
    delete process.env.CLAUDE_CLI_STRICT_MAX_TOKENS;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const { calls, fetchImpl } = sdkSpy();
    const client = await createAnthropicClient({
      claudeBin: writeFakeCli('stayed-on-cli'), fetch: fetchImpl, fresh: true,
    });
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 64,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(resp.content[0].text, 'stayed-on-cli');
    assert.equal(calls.length, 0);
  });

  it('only 1/true enable it — an unrecognised value reads as OFF, never throws', () => {
    for (const val of ['0', 'false', 'yes', 'on', '', '  ', 'TRUE ']) {
      process.env.CLAUDE_CLI_STRICT_MAX_TOKENS = val;
      const v = unserviceableCliParams({ max_tokens: 100 });
      const expectOn = val.trim().toLowerCase() === 'true';
      assert.equal(
        v === null, !expectOn,
        `${JSON.stringify(val)}: turning strictness on by accident is what moves the operator's spend`,
      );
    }
  });

  it('an answer-changing param is diagnosed ahead of the cost guard', () => {
    process.env.CLAUDE_CLI_STRICT_MAX_TOKENS = '1';
    const v = unserviceableCliParams({ max_tokens: 100, system: 'be brief' });
    assert.equal(v.param, 'system', 'the ceiling must not shadow the reason the answer would be wrong');
  });

  // The gap conceded in the rebuttal: an overlong cli response must come back
  // intact and be visible AS overlong, never silently presented as if the
  // ceiling had bound it. Documenting the missing guard is not the guard — the
  // guard is the strict opt-in above; this pins the honest default behaviour.
  it('DEFAULT: an overlong cli response is returned intact, not misrepresented as bounded', async () => {
    const long = 'x'.repeat(5000);
    const client = await createAnthropicClient({
      backend: 'cli', claudeBin: writeFakeCli(long), fresh: true,
    });
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 10,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(resp.content[0].text.length, 5000,
      'the response must not be silently truncated to look like the ceiling held');
    assert.ok(resp.content[0].text.length > 10 * 10,
      'and it is plainly over the requested budget — the caller can see that');
  });

  it('STRICT + explicit backend:cli throws rather than routing', async () => {
    process.env.CLAUDE_CLI_STRICT_MAX_TOKENS = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const client = await createAnthropicClient({
      backend: 'cli', claudeBin: writeFakeCli('from-cli'), fresh: true,
    });
    await assert.rejects(
      () => client.messages.create({
        model: 'claude-haiku-4-5', max_tokens: 64,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      (e) => /cannot honour `max_tokens`/.test(e.message) && /backend:'sdk'/.test(e.message),
    );
  });
});
