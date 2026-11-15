/**
 * THE CROSS-BACKEND CONTRACT: for one set of params, `sdk` and `cli` either
 * both SERVE the call, or the cli path THROWS. Never one of them quietly doing
 * something different from the other.
 *
 * That is the whole claim the `cli` backend's faithfulness refusal rests on,
 * and until this suite existed nothing asserted it end to end: the oracle's own
 * unit tests check the verdict function, and the pin census checks the call
 * sites, but neither runs a call down BOTH transports and compares what each
 * one actually emitted.
 *
 * **Asserted on the EMITTED request, never on client config.** AGENTS.md
 * records that an endpoint and the credential it is addressed with are one
 * unit, and that asserting on the config is how a misroute passes review. So
 * the sdk arm reads the captured fetch BODY — proof the param reached the wire
 * — and the cli arm reads the ARGV the `claude` binary was actually spawned
 * with, which is the cli transport's equivalent of a request.
 *
 * **Every ambient var the factory reads is scrubbed.** Inheriting an answer
 * from the operator's shell is how `anthropic-pin-on-azure` passed here and
 * failed in CI (3 of 8, full-suite, 2026-11-15); this suite is a function of
 * the repo or it is worthless.
 *
 * @module tests/anthropic-backend-parity
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAnthropicClient, _resetClientCache } from '../scripts/lib/anthropic-client.mjs';
import { SERVICEABLE_CLI_PARAMS } from '../scripts/lib/anthropic-cli-faithfulness.mjs';

const AMBIENT = [
  'CLAUDE_BACKEND', 'CLAUDE_BIN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_AI_ENDPOINT',
  'AZURE_OPENAI_GPT_DEPLOYMENT', 'OPENAI_AUDIT_MODEL',
  'AWS_REGION', 'AWS_DEFAULT_REGION',
];

let saved;
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-parity-'));
  saved = {};
  for (const k of AMBIENT) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.ANTHROPIC_API_KEY = 'sk-test-only';
  _resetClientCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  for (const k of AMBIENT) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  _resetClientCache();
});

/** Capture the emitted sdk request — url, headers and body. */
function captor() {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', model: 'x',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { sent, fetchImpl };
}

/**
 * A `claude` stand-in that reports its own ARGV back as the message text.
 *
 * This is the cli arm's "emitted request": the adapter's output is an argv plus
 * a stdin prompt, and reading it back is the only way to assert what the cli
 * transport actually asked for rather than what the call site hoped it would.
 */
function writeArgvEchoingCli() {
  const scriptPath = path.join(tmpDir, 'fake.mjs');
  fs.writeFileSync(scriptPath, [
    "const argv = process.argv.slice(2);",
    "let stdin = '';",
    "process.stdin.resume();",
    "process.stdin.on('data', (c) => { stdin += c; });",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({",
    "    result: JSON.stringify({ argv, stdin }),",
    "    usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1,",
    "  }));",
    "});",
    '',
  ].join('\n'));
  if (process.platform === 'win32') {
    const p = path.join(tmpDir, 'fake.cmd');
    fs.writeFileSync(p, `@echo off\r\nnode "${scriptPath}" %*\r\n`);
    return p;
  }
  const p = path.join(tmpDir, 'fake.sh');
  fs.writeFileSync(p, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, { mode: 0o755 });
  return p;
}

/** Run `params` down the sdk arm; returns the emitted request body. */
async function emitViaSdk(params) {
  const { sent, fetchImpl } = captor();
  const client = await createAnthropicClient({ backend: 'sdk', fetch: fetchImpl, fresh: true, redactor: null });
  await client.messages.create(params);
  assert.equal(sent.length, 1, 'the sdk arm must emit exactly one request');
  return sent[0].body;
}

/**
 * Run `params` down the cli arm.
 *
 * @returns {Promise<{served: true, argv: string[], stdin: string}
 *   | {served: false, error: Error}>}
 */
async function emitViaCli(params) {
  process.env.CLAUDE_BACKEND = 'cli';
  process.env.CLAUDE_BIN = writeArgvEchoingCli();
  const client = await createAnthropicClient({ fresh: true, redactor: null });
  try {
    const resp = await client.messages.create(params);
    return { served: true, ...JSON.parse(resp.content[0].text) };
  } catch (error) {
    return { served: false, error };
  }
}

// A SENTINEL, not a concrete id (AGENTS.md: never pin a concrete model id in
// new code). Both transports here are fakes, so this string is only ever
// compared against what the adapters emitted — but a concrete id in a test is
// how one gets copied into live code later.
const BASE = Object.freeze({
  model: 'latest-opus',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'hi' }],
});

/**
 * Params that are serviceable on cli, and the ones that are not.
 *
 * The unserviceable list is deliberately NOT just the three the old denylist
 * named. `stream` is the param that was passed at a real call site, dropped by
 * the cli adapter and refused by nothing; `output_config`, `temperature` and
 * `metadata` are the shape the allowlist exists for — params no denylist
 * mentions, which under the old oracle were accepted and silently discarded.
 */
const UNSERVICEABLE_CASES = [
  ['system', { system: 'be brief' }],
  ['tools', { tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }] }],
  ['tool_choice', { tool_choice: { type: 'auto' } }],
  ['stream', { stream: true }],
  ['output_config', { output_config: { effort: 'high' } }],
  ['temperature', { temperature: 0.2 }],
  ['metadata', { metadata: { user_id: 'u' } }],
  ['stop_sequences', { stop_sequences: ['\n\n'] }],
];

describe('cross-backend contract: both serve, or cli throws', () => {
  it('a SERVICEABLE call is served by BOTH, and each emits only the allowlisted params', async () => {
    const body = await emitViaSdk({ ...BASE });
    assert.deepEqual(
      Object.keys(body).sort(), [...SERVICEABLE_CLI_PARAMS].sort(),
      'the sdk arm must emit exactly the params given — a backend that adds or drops one here '
      + 'would make every comparison below meaningless',
    );

    const cli = await emitViaCli({ ...BASE });
    assert.equal(cli.served, true, 'the cli arm must SERVE a call built only from the allowlist');
    // The cli transport's emitted request: argv + stdin.
    assert.ok(cli.argv.includes('--model'), `argv carried no --model: ${cli.argv.join(' ')}`);
    assert.equal(cli.argv[cli.argv.indexOf('--model') + 1], BASE.model);
    assert.ok(cli.stdin.includes('hi'), 'the prompt must reach the cli on stdin');
    assert.ok(!cli.argv.includes('--system-prompt'),
      'no --system-prompt may appear for a call that passed no system');
  });

  for (const [name, extra] of UNSERVICEABLE_CASES) {
    it(`\`${name}\`: the sdk arm emits it on the wire, and the cli arm REFUSES`, async () => {
      const params = { ...BASE, ...extra };

      // Half one — the sdk really does honour it. Without this the test could
      // pass on a param neither backend supports, which proves nothing about
      // divergence. Asserted on the emitted BODY, so this is the wire, not the
      // client's config.
      const body = await emitViaSdk(params);
      assert.ok(Object.keys(body).includes(name),
        `the sdk arm did not emit \`${name}\` — this case cannot demonstrate divergence`);

      // Half two — the cli arm refuses rather than serving a different call.
      const cli = await emitViaCli(params);
      assert.equal(cli.served, false,
        `the cli arm SERVED a call carrying \`${name}\`; it would have answered a call the `
        + 'caller did not make');
      assert.match(cli.error.message, new RegExp(`\`${name}\``),
        'the refusal must name the param, so it is actionable from a log line alone');
      assert.match(cli.error.message, /backend: 'sdk'/,
        'and must carry the remedy: a declared pin at the call site');
    });
  }

  // THE PARAM THAT PROVES THE FLIP. Under the denylist this call was served by
  // cli, silently, and the shape the caller got back was not the shape it asked
  // for. Kept as its own named case rather than only a row above, because it is
  // the measurement that justified the whole change.
  it('`stream` was the denylist\'s blind spot: accepted by cli, refused by nothing', async () => {
    const cli = await emitViaCli({ ...BASE, stream: true });
    assert.equal(cli.served, false);
    assert.match(cli.error.message, /no streaming mode/);
  });

  // FAIL CLOSED, AND SAY SO DISTINCTLY. "This call passes a param cli cannot
  // honour" and "I cannot tell what this call passes" are different facts; a
  // reader given one string for both learns to dismiss the second as noise.
  it('params the oracle cannot enumerate are refused in their OWN words', async () => {
    const cli = await emitViaCli(['not', 'an', 'object']);
    assert.equal(cli.served, false, 'unknowable params must fail CLOSED');
    assert.match(cli.error.message, /cannot establish which params/,
      'the message must say the keys are unknown, not name a param');
    assert.match(cli.error.message, /refusal to guess/);
    assert.ok(!/cannot honour `/.test(cli.error.message),
      'it must NOT borrow the named-param wording — that is the collapse this test exists to stop');
  });

  // THE DIVERGENCE OWN-KEYS COULD NOT SEE, asserted on BOTH emitted requests.
  //
  // The round-1 audit of this change raised it and the first rebuttal written
  // got it wrong: `JSON.stringify` omits inherited properties, which is true
  // of the sdk arm and says nothing about cli, because `createCliAdapter` does
  // `const { system } = params` and DESTRUCTURING WALKS THE PROTOTYPE CHAIN.
  // Measured on the real objects: sdk emits no `system`, cli reads
  // `'INHERITED'` and would push `--system-prompt` — the exact cross-backend
  // divergence this module exists to refuse, declared serviceable by
  // `Reflect.ownKeys` alone.
  //
  // A test checking only the sdk body and "cli served it" would have passed
  // over it, which is why both arms are asserted here.
  it('an INHERITED unserviceable param is refused — sdk drops it, cli\'s destructure would read it', async () => {
    const withProto = () => {
      const p = Object.create({ system: 'INHERITED' });
      Object.assign(p, BASE);
      return p;
    };

    // sdk: the inherited key is NOT on the wire.
    const body = await emitViaSdk(withProto());
    assert.ok(!Object.keys(body).includes('system'),
      'sdk serialises own enumerable properties only — if this fails the premise has changed');

    // cli: refused, naming `system`. Were it not refused, the adapter's
    // destructure would hand `claude -p` a system prompt the sdk never sent.
    const cli = await emitViaCli(withProto());
    assert.equal(cli.served, false,
      'cli must refuse: its destructure reads the prototype chain, so serving this '
      + 'call would send a param the sdk arm does not');
    assert.match(cli.error.message, /`system`/);
  });

  // THIS CASE ASSERTED THE WRONG THING, and the round-3 audit caught it.
  // It read "an inherited SERVICEABLE param is still served", on the reasoning
  // that the fix should refuse divergence rather than inheritance. But an
  // inherited `max_tokens` IS a divergence: measured, sdk sends
  // `{"model":"m"}` — which the Messages API rejects for a missing required
  // param — while cli's destructure reads 64 and serves the call happily. The
  // test was pinning the defect as desirable, which is worse than not having
  // the test.
  it('an inherited ALLOWLISTED param is refused: sdk would not send it, cli would read it', async () => {
    const p = Object.create({ max_tokens: 64, messages: BASE.messages });
    p.model = BASE.model;

    const body = await emitViaSdk(p);
    assert.deepEqual(Object.keys(body), ['model'],
      'sdk sends own enumerable properties only — the inherited ones are simply gone');

    const cli = await emitViaCli(p);
    assert.equal(cli.served, false, 'so cli must refuse rather than answer a call sdk could not make');
    assert.match(cli.error.message, /would reach the cli backend but NOT the sdk backend/);
  });

  it('`Object.prototype` pollution is caught, not whitelisted', async () => {
    // An `Object.getOwnPropertyNames(Object.prototype)` exclusion list had
    // whitelisted exactly this: the polluted key is in that list, so it was
    // skipped, while the destructure reads it and the sdk does not send it.
    Object.prototype.system = 'POLLUTED';
    try {
      const cli = await emitViaCli({ ...BASE });
      assert.equal(cli.served, false);
      assert.match(cli.error.message, /`system`/);
    } finally {
      delete Object.prototype.system;
    }
  });

  it('a prototype chain that does not terminate is `unresolvable`, not an infinite loop', async () => {
    // A Proxy returns whatever its `getPrototypeOf` trap says, including
    // itself. The first prototype walk written here claimed a cycle was
    // impossible because `Object.setPrototypeOf` refuses to make one; that is
    // true of plain objects and false of a Proxy, and the walk hung.
    const target = { ...BASE };
    const hostile = new Proxy(target, { getPrototypeOf() { return hostile; } });
    const cli = await emitViaCli(hostile);
    assert.equal(cli.served, false);
    assert.match(cli.error.message, /did not terminate/);
  });

  // `max_tokens` IS NOT PART OF THE PARITY CONTRACT, and saying so here is the
  // round-1 audit's accepted LOW: the claim "both serve or cli throws" is about
  // the KIND and SHAPE of the answer, not about every numeric bound being
  // honoured. cli accepts `max_tokens` and ignores it, measured, and that is
  // the one deliberate exception. Pinned as a test so a reader does not infer
  // a stronger contract than this suite checks.
  it('DECLARED EXCEPTION: `max_tokens` is accepted by both and enforced only by sdk', async () => {
    const body = await emitViaSdk({ ...BASE });
    assert.equal(body.max_tokens, BASE.max_tokens, 'sdk carries the ceiling to the wire');

    const cli = await emitViaCli({ ...BASE });
    assert.equal(cli.served, true, 'cli serves it rather than refusing — refusing would refuse every call');
    assert.ok(!cli.argv.some((a) => String(a).includes('max_tokens')),
      'and there is no argv equivalent: the ceiling is accepted and dropped, which is why '
      + 'a cli-eligible caller must not rely on it as a hard bound');
  });

  // NEGATIVE CONTROL. A suite that only ever asserts "cli refuses" would pass
  // just as well if the cli arm were broken outright, so one row must show the
  // cli arm really can serve a call and return its own answer.
  it('negative control: the cli arm is not inert — it serves and answers', async () => {
    const cli = await emitViaCli({ ...BASE });
    assert.equal(cli.served, true);
    assert.ok(cli.argv.length > 0, 'the fake cli was spawned with a real argv');
  });
});
