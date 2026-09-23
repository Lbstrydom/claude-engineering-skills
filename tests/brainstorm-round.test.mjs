import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { BrainstormOutputSchema } from '../scripts/lib/brainstorm/schemas.mjs';
import { BRAINSTORM_SYSTEM_PROMPT } from '../scripts/lib/brainstorm/prompt.mjs';
import { priceFor, estimateCostUsd, preflightEstimateUsd } from '../scripts/lib/brainstorm/pricing.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HELPER = path.join(__dirname, '..', 'scripts', 'brainstorm-round.mjs');

// Every case below asserts PUBLIC-profile behaviour, and the helper inherits
// the developer's environment. Since provider availability became a route
// question rather than a public-key question, an ambient AZURE_OPENAI_ENDPOINT
// would make these runs reach a real Azure deployment instead of returning
// `misconfigured` — the suite would spend money and pass/fail by whose machine
// it ran on. Scrub the profile explicitly; a caller may still opt back in.
const PUBLIC_PROFILE_ENV = {
  AZURE_OPENAI_ENDPOINT: '',
  AZURE_AI_ENDPOINT: '',
  AZURE_OPENAI_API_KEY: '',
};

function runHelper(args, { stdin = null, env = {} } = {}) {
  return spawnSync('node', [HELPER, ...args], {
    input: stdin,
    encoding: 'utf-8',
    env: { ...process.env, ...PUBLIC_PROFILE_ENV, ...env },
  });
}

describe('brainstorm prompt module', () => {
  it('exports the concept-level system prompt', () => {
    assert.match(BRAINSTORM_SYSTEM_PROMPT, /thoughtful brainstorming partner/);
    assert.match(BRAINSTORM_SYSTEM_PROMPT, /Push back where you disagree/);
    assert.ok(BRAINSTORM_SYSTEM_PROMPT.length > 100, 'prompt should be substantive');
    // Must NOT mirror audit-style language
    assert.doesNotMatch(BRAINSTORM_SYSTEM_PROMPT, /audit|severity|HIGH|MEDIUM|verdict/i);
  });
});

describe('brainstorm pricing', () => {
  it('delegates to the repo-wide pricing SSoT (model-pricing.mjs) for known models', () => {
    // Bare gpt-5's own published rate (2026-09-23 refresh: $1.25/$10, cached
    // $0.125) — also the family fallback for an unlisted non-premium 5.x SKU.
    assert.deepEqual(priceFor('gpt-5'), { input: 1.25, output: 10, cachedInput: 0.125 });
    // gemini-pro became size-TIERED on 2026-09-07 (Google prices Pro by prompt
    // size), so the SSoT hands back the selected tier rather than a flat pair.
    // Asserted field-wise: the rates are the contract, `maxInputTokens` is the
    // tier's own boundary and would make a deepEqual brittle to a re-tiering.
    const pro = priceFor('gemini-pro-latest');
    assert.equal(pro.input, 2, 'the <=200k input rate');
    assert.equal(pro.output, 12, 'the <=200k output rate');
  });

  it('selects the RIGHT tier for a large prompt, not just the cheapest', () => {
    // The direction that silently under-counts: without forwarding inputTokens
    // a 300k-token prompt would price at the <=200k rate.
    const small = priceFor('gemini-pro-latest', { inputTokens: 1_000 });
    const large = priceFor('gemini-pro-latest', { inputTokens: 300_000 });
    assert.equal(small.input, 2);
    assert.equal(large.input, 4, 'a >200k prompt takes the higher tier');
    const cost = estimateCostUsd({ modelId: 'gemini-pro-latest', inputTokens: 300_000, outputTokens: 1_000 });
    // 300k * 4/1M + 1k * 18/1M = 1.2 + 0.018
    assert.ok(Math.abs(cost - 1.218) < 1e-9, `unexpected cost: ${cost}`);
  });

  it('resolves versioned IDs through pricingKeys() (SKU row, then FAMILY), not raw prefix matching', () => {
    const v = priceFor('gpt-5-2025-11-01');
    assert.equal(v.input, 1.25, 'a dated snapshot with no SKU resolves to the gpt-5 family rate');
    // The regression this file's header records: gpt-5.6-terra must land on
    // ITS row ($2/$12), never the bare gpt-5 row a prefix match reached.
    const terra = priceFor('gpt-5.6-terra', { inputTokens: 1000 });
    assert.equal(terra.input, 2);
    assert.equal(terra.output, 12);
  });

  it('returns null for an unpriced model (null-cost policy, never a guessed fallback rate)', () => {
    assert.equal(priceFor('unknown-model-xyz'), null);
  });

  it('estimateCostUsd accounts for input AND output (Gemini-G2 v2)', () => {
    const cost = estimateCostUsd({ modelId: 'gpt-5', inputTokens: 100_000, outputTokens: 1_000 });
    // 100k * 1.25/1M + 1k * 10/1M = 0.125 + 0.01 = 0.135
    assert.ok(cost > 0.134 && cost < 0.136, `unexpected cost: ${cost}`);
  });

  it('estimateCostUsd returns null for an unpriced model instead of a fallback number', () => {
    const cost = estimateCostUsd({ modelId: 'unknown-model-xyz', inputTokens: 100, outputTokens: 100 });
    assert.equal(cost, null);
  });

  it('preflight estimate uses chars/4 as token proxy', () => {
    const cost = preflightEstimateUsd({ modelId: 'gpt-5', inputChars: 4000, maxOutputTokens: 1000 });
    // 1000 input + 1000 output → (1000*1.25 + 1000*10)/1M = 0.01125
    assert.ok(cost > 0.01124 && cost < 0.01126, `unexpected preflight: ${cost}`);
  });
});

describe('brainstorm output schema', () => {
  it('accepts a fully-populated success document', () => {
    const doc = {
      topic: 'test',
      redactionCount: 0,
      resolvedModels: { openai: 'gpt-5', gemini: 'gemini-pro-latest' },
      providers: [
        {
          provider: 'openai', state: 'success',
          text: 'response text', errorMessage: null, httpStatus: null,
          usage: { inputTokens: 50, outputTokens: 200 },
          latencyMs: 3000, estimatedCostUsd: 0.002,
        },
      ],
      totalCostUsd: 0.002,
    };
    assert.ok(BrainstormOutputSchema.safeParse(doc).success);
  });

  it('accepts a misconfigured-only document (R2-H2)', () => {
    const doc = {
      topic: 'test', redactionCount: 0,
      resolvedModels: { openai: 'gpt-5' },
      providers: [{
        provider: 'openai', state: 'misconfigured', text: null,
        errorMessage: 'OPENAI_API_KEY not set', httpStatus: null,
        usage: null, latencyMs: 0, estimatedCostUsd: null,
      }],
      totalCostUsd: 0,
    };
    assert.ok(BrainstormOutputSchema.safeParse(doc).success);
  });

  it('rejects unknown provider state', () => {
    const doc = {
      topic: 't', redactionCount: 0, resolvedModels: {},
      providers: [{
        provider: 'openai', state: 'completely-made-up-state',
        text: null, errorMessage: null, httpStatus: null,
        usage: null, latencyMs: 0, estimatedCostUsd: null,
      }],
      totalCostUsd: 0,
    };
    assert.ok(!BrainstormOutputSchema.safeParse(doc).success);
  });

  it('rejects unknown provider name', () => {
    const doc = {
      topic: 't', redactionCount: 0, resolvedModels: {},
      providers: [{
        provider: 'anthropic', state: 'success',
        text: 'x', errorMessage: null, httpStatus: null,
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 100, estimatedCostUsd: 0,
      }],
      totalCostUsd: 0,
    };
    assert.ok(!BrainstormOutputSchema.safeParse(doc).success);
  });
});

describe('brainstorm CLI argv parsing', () => {
  it('--help exits 0 with usage text', () => {
    const r = runHelper(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /brainstorm-round/);
    assert.match(r.stdout, /USAGE/);
  });

  it('rejects missing topic', () => {
    const r = runHelper(['--models', 'openai']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Missing --topic/);
  });

  it('rejects --topic AND --topic-stdin together (R3-H1)', () => {
    const r = runHelper(['--topic', 'a', '--topic-stdin']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /either --topic OR --topic-stdin/);
  });

  it('rejects unknown provider', () => {
    const r = runHelper(['--topic', 't', '--models', 'anthropic']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown model provider/);
  });

  it('rejects unknown flag', () => {
    const r = runHelper(['--topic', 't', '--frobnicate']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown flag/);
  });

  it('rejects bad --max-tokens', () => {
    const r = runHelper(['--topic', 't', '--max-tokens', '-1']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /max-tokens must be a positive integer/);
  });

  it('rejects bad --timeout-ms (audit-code R1-M10)', () => {
    const r = runHelper(['--topic', 't', '--timeout-ms', 'NaN']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /timeout-ms must be a positive integer/);
  });

  it('rejects flag missing value (audit-code R1-M10)', () => {
    const r = runHelper(['--topic', 't', '--max-tokens']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires a value/);
  });

  it('rejects fractional --max-tokens (audit-code R1-M10)', () => {
    const r = runHelper(['--topic', 't', '--max-tokens', '12.5']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /max-tokens must be a positive integer/);
  });
});

describe('brainstorm CLI live behaviour', () => {
  it('missing OPENAI_API_KEY → exit 0 + misconfigured state (R2-H2, R3-H2)', () => {
    const outFile = path.join(os.tmpdir(), `brainstorm-test-${Date.now()}.json`);
    const r = runHelper(
      ['--topic', 'test', '--models', 'openai', '--out', outFile],
      { env: { OPENAI_API_KEY: '', GEMINI_API_KEY: '' } },
    );
    try {
      assert.equal(r.status, 0, `expected exit 0 (R2-H2 total contract); got ${r.status}, stderr: ${r.stderr}`);
      const doc = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      const parsed = BrainstormOutputSchema.parse(doc);
      assert.equal(parsed.providers.length, 1);
      assert.equal(parsed.providers[0].provider, 'openai');
      assert.equal(parsed.providers[0].state, 'misconfigured');
      assert.match(parsed.providers[0].errorMessage, /OPENAI_API_KEY/);
    } finally {
      try { fs.unlinkSync(outFile); } catch {}
    }
  });

  it('all-providers-misconfigured → exit 0 + valid JSON (R2-H4 total contract)', () => {
    const outFile = path.join(os.tmpdir(), `brainstorm-test-${Date.now()}-${Math.random()}.json`);
    const r = runHelper(
      ['--topic', 'x', '--models', 'openai,gemini', '--out', outFile],
      { env: { OPENAI_API_KEY: '', GEMINI_API_KEY: '' } },
    );
    try {
      assert.equal(r.status, 0);
      const doc = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      const parsed = BrainstormOutputSchema.parse(doc);
      assert.equal(parsed.providers.length, 2);
      assert.equal(parsed.providers[0].state, 'misconfigured');
      assert.equal(parsed.providers[1].state, 'misconfigured');
    } finally {
      try { fs.unlinkSync(outFile); } catch {}
    }
  });

  it('provider order matches --models argv order (R3-M2)', () => {
    const outFile = path.join(os.tmpdir(), `brainstorm-test-order-${Date.now()}.json`);
    const r = runHelper(
      ['--topic', 'x', '--models', 'gemini,openai', '--out', outFile],
      { env: { OPENAI_API_KEY: '', GEMINI_API_KEY: '' } },
    );
    try {
      assert.equal(r.status, 0);
      const doc = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      assert.equal(doc.providers[0].provider, 'gemini');
      assert.equal(doc.providers[1].provider, 'openai');
    } finally {
      try { fs.unlinkSync(outFile); } catch {}
    }
  });

  it('redacts fake API key in topic (R1-H5)', () => {
    const outFile = path.join(os.tmpdir(), `brainstorm-test-redact-${Date.now()}.json`);
    const fakeKey = 'sk-' + 'a'.repeat(40);
    const r = runHelper(
      ['--topic', `my key is ${fakeKey} please help`, '--models', 'openai', '--out', outFile],
      { env: { OPENAI_API_KEY: '' } },
    );
    try {
      assert.equal(r.status, 0);
      const doc = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      assert.ok(doc.redactionCount >= 1, `expected redaction, got ${doc.redactionCount}`);
      assert.ok(!doc.topic.includes(fakeKey), `fake key should be redacted from topic`);
      assert.match(doc.topic, /\[REDACTED:/);
    } finally {
      try { fs.unlinkSync(outFile); } catch {}
    }
  });

  it('--topic-stdin reads from stdin and preserves multiline', () => {
    const outFile = path.join(os.tmpdir(), `brainstorm-test-stdin-${Date.now()}.json`);
    const r = runHelper(
      ['--topic-stdin', '--models', 'openai', '--out', outFile],
      { stdin: 'line one\nline two\nline three', env: { OPENAI_API_KEY: '' } },
    );
    try {
      assert.equal(r.status, 0);
      const doc = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      assert.match(doc.topic, /line one\nline two\nline three/);
    } finally {
      try { fs.unlinkSync(outFile); } catch {}
    }
  });

  it('shell-injection-shaped topic does not execute (Gemini-G1)', () => {
    // The whole point of stdin/--topic — inputs containing shell metachars
    // must reach the helper as literal text. We pass via spawnSync stdin
    // (no shell), so $(date) etc. is bytes, not commands.
    const outFile = path.join(os.tmpdir(), `brainstorm-test-shell-${Date.now()}.json`);
    const dangerous = '$(date) `whoami` ${PATH}';
    const r = runHelper(
      ['--topic-stdin', '--models', 'openai', '--out', outFile],
      { stdin: dangerous, env: { OPENAI_API_KEY: '' } },
    );
    try {
      assert.equal(r.status, 0);
      const doc = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      assert.match(doc.topic, /\$\(date\)/);
      assert.match(doc.topic, /`whoami`/);
      assert.match(doc.topic, /\$\{PATH\}/);
    } finally {
      try { fs.unlinkSync(outFile); } catch {}
    }
  });
});
