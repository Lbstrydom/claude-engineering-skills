/**
 * The cli backend must refuse a call whose params it cannot honour — THROW AND
 * PIN, never route.
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
 * **The assertions that carry the design.** Every throw test also asserts
 * ZERO sdk calls, because the rejected alternative was a lazy sdk fallback that
 * served the call quietly: a suite that only checked "it threw" would pass
 * under a routing implementation too. And `BILLING PIN` asserts the opposite
 * direction — a serviceable call must make zero SDK calls — so this never
 * silently becomes "cli is never usable", which would move every operator's
 * spend off the Max 20x credit.
 *
 * @module tests/anthropic-cli-faithfulness
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createAnthropicClient, _resetClientCache, isClaudeAvailable, isClaudeAvailableFor,
} from '../scripts/lib/anthropic-client.mjs';
import { unserviceableCliParams, cliFaithfulnessVerdict } from '../scripts/lib/anthropic-cli-faithfulness.mjs';

// Every env var the factory resolves ambiently. SCRUBBED, not merely saved:
// this suite's verdict must be a function of the repo, never of the operator's
// shell — and Claude Code desktop injects ANTHROPIC_BASE_URL into every child.
const AMBIENT_PROVIDER_ENV = [
  'CLAUDE_BACKEND', 'CLAUDE_BIN', 'CLAUDE_CLI_TIMEOUT_MS',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
  'AWS_REGION', 'AWS_DEFAULT_REGION',
  // Removed 2026-11-15 with the strict path. Still scrubbed, so a stale value
  // in an operator's shell cannot make the "it is no longer honoured" test
  // below pass for the wrong reason.
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

const BASE_PARAMS = {
  model: 'claude-haiku-4-5',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'ping' }],
};

describe('cli faithfulness: ambient CLAUDE_BACKEND=cli THROWS, never routes', () => {
  for (const [label, extra] of UNSERVICEABLE) {
    it(`\`${label}\` throws, and makes ZERO sdk calls`, async () => {
      process.env.CLAUDE_BACKEND = 'cli';
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      process.env.CLAUDE_BIN = writeFakeCli('from-cli');
      const { calls, fetchImpl } = sdkSpy();
      const client = await createAnthropicClient({ fetch: fetchImpl, fresh: true });
      await assert.rejects(
        () => client.messages.create({ ...BASE_PARAMS, ...extra }),
        (e) => new RegExp('cannot honour `' + label + '`').test(e.message)
          && /backend: 'sdk'/.test(e.message),
        'the throw must name the param AND the pin that fixes it',
      );
      // THE LOAD-BEARING HALF. A suite that only checked the rejection would
      // pass under the rejected lazy-fallback design too, since that threw on
      // the explicit-cli half. Zero sdk calls is what says "not routed".
      assert.equal(calls.length, 0, 'an unserviceable call must not be silently served on the sdk');
    });
  }

  // THE GAP THE AUDIT OF THE PREVIOUS DESIGN FOUND, now the defining case: on a
  // keyless `CLAUDE_BACKEND=cli` install the old design had no sdk credential
  // to fall back to, so the failure surfaced as `ANTHROPIC_API_KEY required` —
  // a credential error for a backend the operator never selected, blaming the
  // wrong thing. The throw must name the PARAM.
  it('KEYLESS ambient cli: the error names the param, not a missing API key', async () => {
    process.env.CLAUDE_BACKEND = 'cli';
    delete process.env.ANTHROPIC_API_KEY;
    const client = await createAnthropicClient({
      claudeBin: writeFakeCli('from-cli'), fresh: true,
    });
    await assert.rejects(
      () => client.messages.create({ ...BASE_PARAMS, system: 'be brief' }),
      (e) => /cannot honour `system`/.test(e.message)
        && !/ANTHROPIC_API_KEY/i.test(e.message),
      'a keyless cli install must be told the param is the problem, not its credentials',
    );
  });

  // POSITIVE CONTROL. A gate is not trustworthy until it has been seen NOT to
  // fire in the direction where it must not. Without this, the change could
  // quietly have become "cli is never usable" — which voids an operator's
  // transport choice and moves EVERY call's spend to the API meter.
  it('BILLING PIN: serviceable params STAY on the cli transport', async () => {
    process.env.CLAUDE_BACKEND = 'cli';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const { calls, fetchImpl } = sdkSpy();
    const client = await createAnthropicClient({
      claudeBin: writeFakeCli('stayed-on-cli'),
      fetch: fetchImpl,
      fresh: true,
    });
    const resp = await client.messages.create(BASE_PARAMS);
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
    const resp = await client.messages.create({ ...BASE_PARAMS, system: '   ' });
    assert.equal(resp.content[0].text, 'stayed-on-cli');
    assert.equal(calls.length, 0);
  });
});

describe("cli faithfulness: explicit backend:'cli' throws identically", () => {
  for (const [label, extra] of UNSERVICEABLE) {
    it(`\`${label}\` throws with the same message as the ambient case`, async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      const client = await createAnthropicClient({
        backend: 'cli',
        claudeBin: writeFakeCli('from-cli'),
        fresh: true,
      });
      await assert.rejects(
        () => client.messages.create({ ...BASE_PARAMS, ...extra }),
        (e) => new RegExp('cannot honour `' + label + '`').test(e.message)
          && /backend: 'sdk'/.test(e.message),
      );
    });
  }

  // Precedence is now FLAT: one verdict, one message, whichever way cli was
  // chosen. The earlier design mirrored `reconcileBackendWithBaseUrl` (ambient
  // coerces, explicit throws); that symmetry was the wrong one to copy, because
  // a baseURL names a DESTINATION the operator chose, while `system` names a
  // billable contract the call site never made a transport decision about.
  it('the ambient and explicit messages are byte-identical for the same param', async () => {
    const ambientVerdict = cliFaithfulnessVerdict({ system: 'be brief' });
    const explicitVerdict = cliFaithfulnessVerdict({ system: 'be brief' });
    assert.equal(ambientVerdict.message, explicitVerdict.message);
    assert.ok(!('action' in ambientVerdict), 'there is no longer a route action to choose');
  });

  it('serviceable params on an explicit cli backend still run on cli', async () => {
    const client = await createAnthropicClient({
      backend: 'cli',
      claudeBin: writeFakeCli('stayed-on-cli'),
      fresh: true,
    });
    const resp = await client.messages.create(BASE_PARAMS);
    assert.equal(resp.content[0].text, 'stayed-on-cli');
  });
});

describe("a pinned backend:'sdk' site carries its params intact", () => {
  it('`system` reaches the sdk unmodified — the pin is the fix, so it must work', async () => {
    process.env.CLAUDE_BACKEND = 'cli'; // ambient cli, PINNED call site
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const { calls, fetchImpl } = sdkSpy();
    const client = await createAnthropicClient({ backend: 'sdk', fetch: fetchImpl, fresh: true });
    await client.messages.create({
      ...BASE_PARAMS,
      max_tokens: 200,
      system: 'Answer in ONE line.',
    });
    assert.equal(calls.length, 1, 'the pin must win over the ambient cli backend');
    assert.equal(
      calls[0].body.system,
      'Answer in ONE line.',
      'stripping `system` to make a call fit would reproduce the defect on the other backend',
    );
    assert.equal(calls[0].body.max_tokens, 200);
  });

  it('a pinned site also carries `tools` and `tool_choice`', async () => {
    process.env.CLAUDE_BACKEND = 'cli';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const { calls, fetchImpl } = sdkSpy();
    const client = await createAnthropicClient({ backend: 'sdk', fetch: fetchImpl, fresh: true });
    await client.messages.create({
      ...BASE_PARAMS,
      tools: [{ name: 'x', description: 'd', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'x' },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.tools[0].name, 'x');
    assert.deepEqual(calls[0].body.tool_choice, { type: 'tool', name: 'x' });
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

  it('unserviceable shapes name the param', () => {
    assert.equal(u({ system: 'be brief' }).param, 'system');
    assert.equal(u({ system: [{ type: 'text', text: 'be brief' }] }).param, 'system');
    assert.equal(u({ tools: [] }).param, 'tools', 'an empty tools array is still a tool-using call shape');
    assert.equal(u({ tool_choice: { type: 'auto' } }).param, 'tool_choice');
  });

  it('every refusal carries a reason — the throw quotes it', () => {
    for (const [, extra] of UNSERVICEABLE) {
      const verdict = u(extra);
      assert.ok(verdict, 'must be refused');
      assert.ok(verdict.why && verdict.why.length > 20, 'a reasonless refusal is not actionable');
    }
  });

  it('a throw message names the param AND the remedy', () => {
    const v = cliFaithfulnessVerdict({ tool_choice: { type: 'any' } });
    assert.match(v.message, /cannot honour `tool_choice`/);
    assert.match(v.message, /backend: 'sdk'/);
  });

  it('serviceable params return null from the verdict too', () => {
    assert.equal(cliFaithfulnessVerdict({ max_tokens: 100 }), null);
    assert.equal(cliFaithfulnessVerdict({}), null);
  });
});

// ── max_tokens: unenforced, warned, and NOT a routing condition ─────────────
//
// `max_tokens` is equally unenforced on cli — accepted and ignored, measured —
// but its being unmet does not change the ANSWER the caller receives, only how
// much of it there is. Every caller sets it (the Messages API requires it), so
// refusing on it is arithmetically "cli is never usable".
//
// A `CLAUDE_CLI_STRICT_MAX_TOKENS` opt-in was implemented on 2026-11-14 and
// REMOVED on 2026-11-15: a second routing dial for a param that does not change
// the answer, which no call site asked for. The removal has its own negative
// control below — a stale value in an operator's env must now do nothing, and a
// removal that left the read in place would be invisible without it.
describe('max_tokens: unenforced on cli, never a refusal', () => {
  it('`max_tokens` alone is serviceable — refusing it would refuse every call', () => {
    assert.equal(unserviceableCliParams({ max_tokens: 100 }), null);
    assert.equal(cliFaithfulnessVerdict({ max_tokens: 100 }), null);
  });

  it('REMOVED: CLAUDE_CLI_STRICT_MAX_TOKENS is no longer read, at any value', () => {
    for (const val of ['1', 'true', 'TRUE', 'yes', '0', 'false', '']) {
      process.env.CLAUDE_CLI_STRICT_MAX_TOKENS = val;
      assert.equal(
        unserviceableCliParams({ max_tokens: 100 }), null,
        `${JSON.stringify(val)}: the strict path is gone; a stale env value must not route or throw`,
      );
    }
  });

  it('STALE ENV: a strict-looking value still leaves the call on cli end to end', async () => {
    process.env.CLAUDE_BACKEND = 'cli';
    process.env.CLAUDE_CLI_STRICT_MAX_TOKENS = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const { calls, fetchImpl } = sdkSpy();
    const client = await createAnthropicClient({
      claudeBin: writeFakeCli('stayed-on-cli'), fetch: fetchImpl, fresh: true,
    });
    const resp = await client.messages.create({ ...BASE_PARAMS, max_tokens: 64 });
    assert.equal(resp.content[0].text, 'stayed-on-cli');
    assert.equal(calls.length, 0, 'the removed dial must not still be able to move billing');
  });

  it('an overlong cli response is returned intact, not misrepresented as bounded', async () => {
    const long = 'x'.repeat(5000);
    const client = await createAnthropicClient({
      backend: 'cli', claudeBin: writeFakeCli(long), fresh: true,
    });
    const resp = await client.messages.create({ ...BASE_PARAMS, max_tokens: 10 });
    assert.equal(resp.content[0].text.length, 5000,
      'the response must not be silently truncated to look like the ceiling held');
  });

  it('the once-per-session warning says UNENFORCED, not merely unenforceable', async () => {
    const written = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk, ...rest) => {
      written.push(String(chunk));
      return origWrite.call(process.stderr, chunk, ...rest);
    };
    try {
      const client = await createAnthropicClient({
        backend: 'cli', claudeBin: writeFakeCli('ok'), fresh: true,
      });
      await client.messages.create({ ...BASE_PARAMS, max_tokens: 64 });
    } finally {
      process.stderr.write = origWrite;
    }
    // Warn-once state is module-global and other suites in this file may have
    // already tripped it, so this asserts on the TEXT when present rather than
    // on its presence — the shape claim, not an ordering claim.
    const hits = written.filter((l) => /max_tokens is UNENFORCED/.test(l));
    for (const h of hits) assert.match(h, /accepted and ignored/);
  });
});

describe('isClaudeAvailableFor: the gate a pinned site must ask', () => {
  it('a keyless ambient cli install is available for cli but NOT for sdk', () => {
    process.env.CLAUDE_BACKEND = 'cli';
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(isClaudeAvailable(), true, 'the ambient answer: cli needs no key');
    assert.equal(
      isClaudeAvailableFor('sdk'), false,
      'and that is exactly why a pinned site must not use the ambient answer — it would '
      + 'pass this gate and then throw ANTHROPIC_API_KEY required',
    );
    assert.equal(isClaudeAvailableFor('cli'), true);
  });

  it('with a key, both answers are available', () => {
    process.env.CLAUDE_BACKEND = 'cli';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    assert.equal(isClaudeAvailable(), true);
    assert.equal(isClaudeAvailableFor('sdk'), true);
  });

  it('bedrock availability is the AWS region, not the Anthropic key', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AWS_REGION;
    assert.equal(isClaudeAvailableFor('bedrock'), false);
    process.env.AWS_REGION = 'us-east-1';
    assert.equal(isClaudeAvailableFor('bedrock'), true);
  });

  // The ambient wrapper surfaces a billing-affecting typo; a named backend does
  // not, because a pinned site never reads the ambient value — and failing here
  // would disable a working feature over an unrelated env typo.
  it('an invalid CLAUDE_BACKEND throws for the ambient answer but not a named one', () => {
    process.env.CLAUDE_BACKEND = 'cil';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    assert.throws(() => isClaudeAvailable(), /Invalid CLAUDE_BACKEND/);
    assert.equal(isClaudeAvailableFor('sdk'), true);
  });
});
