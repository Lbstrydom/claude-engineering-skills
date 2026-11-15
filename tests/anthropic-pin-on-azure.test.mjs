/**
 * The `{backend:'sdk'}` pin must be correct on an AZURE install, not only on a
 * public one — consumer `storyline` runs the Azure work profile.
 *
 * Every assertion here is on the **emitted request**, never on the client
 * config: AGENTS.md records that an endpoint and the credential it is addressed
 * with are one unit, and that asserting on the config is how a misroute passes
 * review.
 *
 * @module tests/anthropic-pin-on-azure
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createAnthropicClient, isClaudeAvailableFor, isClaudeAvailable, _resetClientCache,
} from '../scripts/lib/anthropic-client.mjs';

// SCRUBBED, not merely saved: this suite's verdict must be a function of the
// repo, never of the operator's shell.
//
// `AZURE_OPENAI_GPT_DEPLOYMENT` and `OPENAI_AUDIT_MODEL` were missing from this
// list, and that is how the suite passed on this machine and failed in CI
// (full-suite, 2026-11-15, 3 of 8). Setting `AZURE_OPENAI_ENDPOINT` activates
// the WHOLE Azure work profile, and `buildAzureConfig` then requires a GPT
// deployment or a concrete `OPENAI_AUDIT_MODEL`. The local `.env` supplies the
// latter, so `createAnthropicClient` resolved; a clean runner has neither file,
// so it threw about a GPT deployment — in a test about a CLAUDE route, which is
// why the message looked unrelated to what the test was checking.
const AMBIENT = [
  'CLAUDE_BACKEND', 'CLAUDE_BIN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_AI_ENDPOINT',
  'AZURE_OPENAI_GPT_DEPLOYMENT', 'OPENAI_AUDIT_MODEL',
  'AWS_REGION', 'AWS_DEFAULT_REGION',
];

let saved;
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-azure-'));
  saved = {};
  for (const k of AMBIENT) { saved[k] = process.env[k]; delete process.env[k]; }
  _resetClientCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  for (const k of AMBIENT) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  _resetClientCache();
});

/** Capture the emitted request — url, headers and body. */
function captor() {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: JSON.parse(init.body),
    });
    return new Response(JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', model: 'x',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { sent, fetchImpl };
}

/** A `claude` stand-in that announces itself, so a cli spawn is unmistakable. */
function writeFakeCli() {
  const scriptPath = path.join(tmpDir, 'fake.mjs');
  const payload = JSON.stringify({ result: 'FROM-CLI', usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1 });
  fs.writeFileSync(scriptPath,
    `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(payload)});});\n`);
  if (process.platform === 'win32') {
    const p = path.join(tmpDir, 'fake.cmd');
    fs.writeFileSync(p, `@echo off\r\nnode "${scriptPath}" %*\r\n`);
    return p;
  }
  const p = path.join(tmpDir, 'fake.sh');
  fs.writeFileSync(p, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, { mode: 0o755 });
  return p;
}

const AZURE_ENDPOINT = 'https://tenant.openai.azure.com';

/**
 * Activate the tenant the way a real Azure install does.
 *
 * The endpoint alone is NOT a working profile: it switches the whole work
 * profile on, and `buildAzureConfig` then demands a GPT deployment. Every test
 * here is about the CLAUDE route, so the GPT deployment is scaffolding — but
 * omitting it does not isolate the Claude route, it makes config construction
 * throw about something else entirely, which is the shape of the CI failure
 * this helper exists to prevent recurring one env var at a time.
 */
function activateTenant({ credential = 'azure-secret' } = {}) {
  process.env.AZURE_OPENAI_ENDPOINT = AZURE_ENDPOINT;
  process.env.AZURE_OPENAI_GPT_DEPLOYMENT = 'gpt-deployment-for-this-tenant';
  if (credential === null) delete process.env.AZURE_OPENAI_API_KEY;
  else process.env.AZURE_OPENAI_API_KEY = credential;
}

describe("the sdk pin is served by Foundry on a keyless-for-public Azure install", () => {
  // THE DEFINING CASE. An omitted `azureRoute` ADOPTS the tenant route
  // (AGENTS.md), so a site pinned to sdk with no public ANTHROPIC_API_KEY is
  // still served — the pin is not a blocker for an Azure consumer.
  it('reaches the TENANT endpoint with the AZURE credential, and keeps `system`', async () => {
    activateTenant();
    delete process.env.ANTHROPIC_API_KEY;

    const { sent, fetchImpl } = captor();
    const client = await createAnthropicClient({ backend: 'sdk', fetch: fetchImpl, fresh: true });
    await client.messages.create({
      model: 'claude-opus-5-5', max_tokens: 10,
      system: 'be brief', messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(sent.length, 1, 'the pinned call must be served, not refused');
    assert.ok(sent[0].url.startsWith(AZURE_ENDPOINT), `emitted to ${sent[0].url}`);
    assert.equal(sent[0].headers['api-key'], 'azure-secret',
      'the tenant endpoint must be addressed with the TENANT credential');
    assert.equal(sent[0].body.system, 'be brief',
      'and the param the pin exists for must survive the route');
  });

  // The 2026-08-13 cross-service-credential rule, asserted on the wire: no env
  // state may put a public key on a corporate host.
  it('a stray public key is NOT sent to the tenant endpoint', async () => {
    activateTenant();
    process.env.ANTHROPIC_API_KEY = 'sk-public-should-never-leave';

    const { sent, fetchImpl } = captor();
    const client = await createAnthropicClient({ backend: 'sdk', fetch: fetchImpl, fresh: true });
    await client.messages.create({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });

    assert.ok(sent[0].url.startsWith(AZURE_ENDPOINT));
    assert.ok(!JSON.stringify(sent[0].headers).includes('sk-public-should-never-leave'),
      'the public key must be UNREACHABLE once a route is resolved, not merely outranked');
  });

  it('availability on that install asks whether a ROUTE exists, not whether a key is set', () => {
    activateTenant();
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(isClaudeAvailableFor('sdk'), true,
      'a key test alone reported a fully-working backend as unavailable — the defect this oracle exists to prevent');
  });
});

// A misconfigured Azure profile (endpoint set, credential missing) makes
// `resolveClaudeRouteFromEnv` THROW by design, rather than demote to the public
// endpoint. Both availability oracles inherit that, which is deliberate — this
// test pins that the refusal is NOT weakened, and records which of the two
// answers it reaches.
describe('a misconfigured Azure profile refuses rather than demoting', () => {
  it('BOTH availability oracles throw, and name the remedy', () => {
    activateTenant({ credential: null });
    delete process.env.ANTHROPIC_API_KEY;

    for (const [label, fn] of [
      ['isClaudeAvailable()', () => isClaudeAvailable()],
      ["isClaudeAvailableFor('sdk')", () => isClaudeAvailableFor('sdk')],
    ]) {
      assert.throws(fn, /AZURE_OPENAI_API_KEY is missing/, `${label} must refuse, not demote`);
    }
  });

  it('the backend-aware oracle did NOT introduce this — the ambient one always threw', () => {
    activateTenant({ credential: null });
    // Stated as a test so the behaviour is recorded rather than assumed: the
    // throw predates the pin, so a pinned site is no worse off than before.
    assert.throws(() => isClaudeAvailable(), /AZURE_OPENAI_API_KEY is missing/);
  });
});

// GOVERNANCE, recorded not changed: ambient `CLAUDE_BACKEND=cli` wins over an
// active Azure route, because the route is only consulted once the candidate
// backend is sdk. So on a tenant with cli set, a serviceable (system-less) call
// goes to `claude -p` against PUBLIC Anthropic while the Foundry route sits
// unused. Deliberately NOT changed in this PR — it is a policy decision — but
// pinned here so the next reader finds the fact rather than inferring it.
describe('precedence today: ambient cli wins over an active Azure route', () => {
  it('a SERVICEABLE call on an Azure tenant with cli set is spawned, not routed', async () => {
    activateTenant();
    process.env.CLAUDE_BACKEND = 'cli';
    process.env.CLAUDE_BIN = writeFakeCli();

    const { sent, fetchImpl } = captor();
    const client = await createAnthropicClient({ fetch: fetchImpl, fresh: true });
    const resp = await client.messages.create({
      model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(resp.content[0].text, 'FROM-CLI', 'the cli backend served it');
    assert.equal(sent.length, 0, 'and NOTHING reached the Foundry endpoint');
  });

  it('an UNSERVICEABLE call on that same install throws, naming the param', async () => {
    activateTenant();
    process.env.CLAUDE_BACKEND = 'cli';
    process.env.CLAUDE_BIN = writeFakeCli();

    const { sent, fetchImpl } = captor();
    const client = await createAnthropicClient({ fetch: fetchImpl, fresh: true });
    await assert.rejects(
      () => client.messages.create({
        model: 'claude-opus-5-5', max_tokens: 10,
        system: 'be brief', messages: [{ role: 'user', content: 'hi' }],
      }),
      /cannot honour `system`/,
    );
    assert.equal(sent.length, 0, 'and it is not quietly routed to the tenant either');
  });

  // A PINNED site on that install does reach Foundry — which is the point of
  // the pin, and the reason the precedence above is survivable today.
  it('a PINNED site on that same install reaches Foundry', async () => {
    activateTenant();
    process.env.CLAUDE_BACKEND = 'cli';
    process.env.CLAUDE_BIN = writeFakeCli();

    const { sent, fetchImpl } = captor();
    const client = await createAnthropicClient({ backend: 'sdk', fetch: fetchImpl, fresh: true });
    await client.messages.create({
      model: 'claude-opus-5-5', max_tokens: 10,
      system: 'be brief', messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(sent.length, 1);
    assert.ok(sent[0].url.startsWith(AZURE_ENDPOINT));
    assert.equal(sent[0].headers['api-key'], 'azure-secret');
  });
});
