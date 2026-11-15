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
import {
  unserviceableCliParams, cliFaithfulnessVerdict, SERVICEABLE_CLI_PARAMS,
} from '../scripts/lib/anthropic-cli-faithfulness.mjs';

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
  // THE CLAIM IS ABOUT TWO CLIENTS, SO IT IS ASSERTED ON TWO CLIENTS. The first
  // version of this called `cliFaithfulnessVerdict` twice with identical
  // arguments and compared the results — a tautology that passes for a pure
  // function whatever the adapters do, which is the one thing it was meant to
  // check. The messages must match where they are actually RAISED: once with
  // cli chosen ambiently through `CLAUDE_BACKEND`, once with it named at the
  // call site.
  it('the ambient and explicit THROWS carry byte-identical messages', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const bin = writeFakeCli('from-cli');

    process.env.CLAUDE_BACKEND = 'cli';
    const ambient = await createAnthropicClient({ claudeBin: bin, fresh: true });
    const explicit = await createAnthropicClient({ backend: 'cli', claudeBin: bin, fresh: true });

    const raised = [];
    for (const client of [ambient, explicit]) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () => client.messages.create({ ...BASE_PARAMS, system: 'be brief' }),
        (e) => { raised.push(e.message); return true; },
      );
    }
    assert.equal(raised.length, 2, 'both clients must actually have thrown');
    assert.equal(raised[0], raised[1], 'one verdict, whichever way cli was chosen');
    assert.match(raised[0], /cannot honour `system`/);
    assert.ok(!('action' in cliFaithfulnessVerdict({ system: 'be brief' })),
      'and there is no longer a route action to choose');
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

// ── ALLOWLIST, not denylist (2026-11-15) ───────────────────────────────────
//
// The oracle used to name three params to refuse and pass everything else. A
// denylist is only as complete as the last person who thought to add a name,
// and two params had already slipped past it: `stream`, passed at a real call
// site and dropped by the adapter, and `output_config`, which did not exist
// when the list was written. These cases all PASS under a denylist, so they are
// what separates the two implementations.
describe('the allowlist refuses params nobody named', () => {
  const u = unserviceableCliParams;

  it('`stream` — the measured blind spot', () => {
    const v = u({ model: 'm', max_tokens: 1, messages: [], stream: true });
    assert.equal(v.param, 'stream');
    assert.equal(v.kind, 'unrepresentable');
    assert.match(v.why, /no streaming mode/);
  });

  it('a param the oracle has never heard of is refused with the generic reason', () => {
    for (const extra of [{ temperature: 0.2 }, { metadata: { user_id: 'u' } },
      { output_config: { effort: 'high' } }, { a_param_shipped_next_year: 1 }]) {
      const v = u({ model: 'm', max_tokens: 1, messages: [], ...extra });
      const name = Object.keys(extra)[0];
      assert.equal(v?.param, name, `${name} must be refused by the allowlist`);
      assert.match(v.why, /accepted and\s+dropped|accepted and dropped/);
    }
  });

  it('EVERY offending param is named, not only the first', () => {
    const v = u({ model: 'm', messages: [], system: 's', temperature: 0, stream: true });
    assert.equal(v.param, 'system', 'the named params sort first, so the message is stable');
    assert.match(v.why, /also passes `stream`, `temperature`/);
  });

  it('the allowlist itself is exactly {model, max_tokens, messages}', () => {
    assert.deepEqual([...SERVICEABLE_CLI_PARAMS].sort(), ['max_tokens', 'messages', 'model']);
    assert.equal(u({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }), null);
  });

  it('an explicitly-undefined param is ABSENT — the SDK never puts it on the wire', () => {
    assert.equal(u({ model: 'm', messages: [], tools: undefined, stream: undefined }), null);
  });

  // FAIL CLOSED, IN ITS OWN WORDS. "This call passes a param cli cannot honour"
  // and "I cannot tell what this call passes" are different facts; one string
  // for both teaches the next reader to dismiss the second as noise.
  it('params that cannot be enumerated are `unresolvable`, worded distinctly', () => {
    for (const bad of [null, undefined, 'a string', 42, ['an', 'array']]) {
      const v = u(bad);
      assert.equal(v?.kind, 'unresolvable', `${JSON.stringify(bad)} must fail closed`);
      const msg = cliFaithfulnessVerdict(bad).message;
      assert.match(msg, /cannot establish which params/);
      assert.match(msg, /refusal to guess/);
      assert.ok(!/cannot honour `/.test(msg),
        'the unresolvable verdict must NOT borrow the named-param wording');
    }
  });

  it('a Proxy whose ownKeys trap throws is unresolvable, not clean', () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error('nope'); } });
    assert.equal(u(hostile)?.kind, 'unresolvable');
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

  // NOT a conditional assertion. The first version of this test asserted on the
  // warning's TEXT only when present, because warn-once state is module-global
  // and another suite may have tripped it first — so it passed with zero hits,
  // which is the vacuous pass this repo's own discipline names. `_resetClientCache`
  // clears that state (its whole purpose), so the count IS assertable: exactly
  // one line across two calls, both halves of the "once per session" claim.
  it('the max_tokens warning fires ONCE per session and says UNENFORCED', async () => {
    _resetClientCache();
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
      await client.messages.create({ ...BASE_PARAMS, max_tokens: 128 });
    } finally {
      process.stderr.write = origWrite;
    }
    const hits = written.filter((l) => /max_tokens is UNENFORCED/.test(l));
    assert.equal(hits.length, 1, 'once per session, and at least once — not zero');
    assert.match(hits[0], /accepted and ignored/);
    assert.match(hits[0], /1995 output tokens/, 'the warning carries the measurement');
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

// ── The `system` CLAIM, guarded (2026-11-15) ───────────────────────────────
//
// Louis kept the throw and asked for the wording restated precisely, because
// the earlier phrasing ("does not honour `system` as an instruction") reads as
// NEVER, and the measurement says NOT RELIABLY:
//
//   * the REAL `NORMALIZE_PROMPT` on cli → 1995-2784 output tokens of
//     first-person prose against `max_tokens: 200`; sdk returned the requested
//     one line in 29-43.
//   * a SHORTENED variant of that same prompt → a correct one-line answer
//     3 of 3 runs, still 466-673 output tokens.
//
// So `--system-prompt` IS passed and a simple instruction IS obeyed; what cli
// cannot promise is that the instruction WINS over the agent persona and its
// ~164K-token project context on a structured-output contract. A wording claim
// with no guard goes stale silently (AGENTS.md's own rule), and the overstated
// version is worse than vague: it would be falsified by one terse cli reply,
// and an operator who found that would discount the whole refusal. This suite
// is where that claim lives, so it is pinned here rather than asserted in prose.
describe('the stated reason for refusing `system` matches what was measured', () => {
  const why = () => unserviceableCliParams({ system: 'be brief' }).why;

  it('says the param is PASSED, not ignored or dropped', () => {
    assert.match(why(), /PASSES|passed/,
      'cli delivers the string as `--system-prompt`; claiming otherwise is falsifiable');
    assert.doesNotMatch(why(), /\bignores?\b/i);
    assert.doesNotMatch(why(), /\bdrops?\b|\bdropped\b/i,
      '`tools`/`tool_choice` are dropped; `system` is not — conflating them overstates the case');
  });

  it('says UNRELIABLY, and names what outranks it', () => {
    assert.match(why(), /reliabl/i, 'the claim is "not reliably honoured", not "never honoured"');
    assert.match(why(), /outrank/i);
    assert.match(why(), /persona/i);
  });

  it('carries the measurement that makes it falsifiable', () => {
    assert.match(why(), /1995/, 'the measured figure, so a reader can check the claim');
    assert.match(why(), /164K|164,000/, 'and the prefix that is charged either way');
  });

  // NEGATIVE CONTROL for the three above: the `tools` reason MUST still say
  // "drops", or these assertions would be rewarding vagueness everywhere
  // rather than precision about `system` specifically.
  it('and `tools` still says DROPS, because that one really is dropped', () => {
    const toolsWhy = unserviceableCliParams({ tools: [] }).why;
    assert.match(toolsWhy, /drops|dropped/);
    assert.doesNotMatch(toolsWhy, /reliabl/i, 'nothing unreliable about it — it never arrives');
  });

  // The same claim travels in the user-facing message, which is what a reader
  // of a log line sees; a precise docstring with a sloppy error string would
  // have left the overstatement exactly where it does the damage.
  it('the thrown message carries the restated claim too', () => {
    const { message } = cliFaithfulnessVerdict({ system: 'be brief' });
    assert.match(message, /cannot honour `system`/);
    assert.match(message, /PASSES|passed/);
    assert.doesNotMatch(message, /\bignores\b/i);
  });
});
