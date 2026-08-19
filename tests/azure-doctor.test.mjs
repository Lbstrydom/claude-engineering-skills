/**
 * @fileoverview Cluster B / Phase 5 — the azure-doctor CLI state machine. Every
 * §2 matrix row via injected deps: inactive, verified/unsupported/unverified
 * report exits, TTY confirm/decline, non-TTY refusal, --json never writes,
 * first-verified-wins, and the H10 live-value-differs warning.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runAzureDoctor, EXIT } from '../scripts/azure-doctor.mjs';

const ACTIVE = Object.freeze({ active: true, embedDeployment: 'text-embedding-3-small', openaiEndpoint: 'https://x.openai.azure.com' });
const INACTIVE = Object.freeze({ active: false });

/** A deps harness with a captured output buffer + a stubbed select(). */
function harness({ selectResult, isTTY = false, answer = 'n', envText = '', snapshot = null, json = false } = {}) {
  const lines = [];
  const written = {};
  const deps = {
    azure: ACTIVE,
    client: {},
    select: async () => selectResult,
    isTTY,
    prompt: async () => answer,
    readEnvFile: () => envText,
    writeEnvFile: (p, t) => { written.path = p; written.text = t; },
    envPath: '/repo/.env',
    getActiveSnapshot: async () => snapshot,
    repoId: 'repo-1',
    out: (s) => lines.push(s),
  };
  return { deps, lines, written, out: () => lines.join('\n') };
}

const verified = (name) => ({ status: 'verified', selected: name, catalogSource: 'catalog', probed: [{ name, outcome: 'verified' }] });

describe('azure-doctor — inactive + report-only exits', () => {
  test('inactive profile → exit 0, no probing', async () => {
    const lines = [];
    const r = await runAzureDoctor({}, { azure: INACTIVE, out: (s) => lines.push(s) });
    assert.equal(r.exitCode, EXIT.OK);
    assert.match(lines.join('\n'), /inactive/i);
  });

  test('configured verified → exit 0, "nothing to fix", no write', async () => {
    const h = harness({ selectResult: verified('text-embedding-3-small') });
    const r = await runAzureDoctor({}, h.deps);
    assert.equal(r.exitCode, EXIT.OK);
    assert.equal(r.wrote, false);
    assert.match(h.out(), /Nothing to fix/i);
  });

  test('configured unsupported but a candidate verified → report-only exit 3 (FIXABLE)', async () => {
    const h = harness({ selectResult: verified('text-embedding-3-large') });
    const r = await runAzureDoctor({ fix: false }, h.deps);
    assert.equal(r.exitCode, EXIT.FIXABLE);
    assert.equal(r.wrote, false);
    assert.match(h.out(), /--fix/);
  });

  test('all unverified (transient) → exit 4, preserve config, no write', async () => {
    const h = harness({ selectResult: { status: 'unverified', selected: null, catalogSource: 'static', probed: [{ name: 'x', outcome: 'unverified' }] } });
    const r = await runAzureDoctor({ fix: true, }, { ...h.deps, isTTY: true });
    assert.equal(r.exitCode, EXIT.UNVERIFIED);
    assert.equal(r.wrote, false);
  });

  test('all unsupported → exit 5, "supply --candidate"', async () => {
    const h = harness({ selectResult: { status: 'none-found', selected: null, catalogSource: 'static', probed: [{ name: 'x', outcome: 'unsupported' }] } });
    const r = await runAzureDoctor({ fix: true }, { ...h.deps, isTTY: true });
    assert.equal(r.exitCode, EXIT.NONE_FOUND);
    assert.match(h.out(), /--candidate/);
  });
});

describe('azure-doctor — --fix write path (TTY only)', () => {
  test('TTY + confirm y → writes the env key, warns about invalidation', async () => {
    const h = harness({ selectResult: verified('text-embedding-3-large'), isTTY: true, answer: 'y', snapshot: { activeEmbeddingModel: 'https://x.openai.azure.com::text-embedding-3-small' } });
    const r = await runAzureDoctor({ fix: true }, h.deps);
    assert.equal(r.exitCode, EXIT.OK);
    assert.equal(r.wrote, true);
    assert.match(h.written.text, /AZURE_OPENAI_EMBED_DEPLOYMENT=text-embedding-3-large/);
    assert.match(h.out(), /invalidates the index built with/i);
    assert.match(h.out(), /arch:refresh -- --full/);
  });

  test('TTY + decline n → exit 130, NO write', async () => {
    const h = harness({ selectResult: verified('text-embedding-3-large'), isTTY: true, answer: 'n' });
    const r = await runAzureDoctor({ fix: true }, h.deps);
    assert.equal(r.exitCode, EXIT.DECLINED);
    assert.equal(r.wrote, false);
    assert.equal(h.written.text, undefined);
  });

  test('--fix WITHOUT a TTY → refuses to write, exit 6', async () => {
    const h = harness({ selectResult: verified('text-embedding-3-large'), isTTY: false });
    const r = await runAzureDoctor({ fix: true }, h.deps);
    assert.equal(r.exitCode, EXIT.REFUSED_CI);
    assert.equal(r.wrote, false);
  });

  test('snapshot read failure does NOT block the fix (M7 best-effort)', async () => {
    const h = harness({ selectResult: verified('text-embedding-3-large'), isTTY: true, answer: 'y' });
    h.deps.getActiveSnapshot = async () => { throw new Error('store offline'); };
    const r = await runAzureDoctor({ fix: true }, h.deps);
    assert.equal(r.exitCode, EXIT.OK);
    assert.equal(r.wrote, true);
    assert.match(h.out(), /if an architectural-memory index already exists/i);
  });

  test('H10: warns when a live env value would shadow the written file', async () => {
    const saved = process.env.AZURE_OPENAI_EMBED_DEPLOYMENT;
    process.env.AZURE_OPENAI_EMBED_DEPLOYMENT = 'shell-export-value';
    try {
      const h = harness({ selectResult: verified('text-embedding-3-large'), isTTY: true, answer: 'y' });
      const r = await runAzureDoctor({ fix: true }, h.deps);
      assert.equal(r.wrote, true);
      assert.match(h.out(), /shell export.*overriding|override:false/i);
    } finally {
      if (saved === undefined) delete process.env.AZURE_OPENAI_EMBED_DEPLOYMENT;
      else process.env.AZURE_OPENAI_EMBED_DEPLOYMENT = saved;
    }
  });
});

describe('azure-doctor — input validation (H2)', () => {
  test('a malformed --candidate is rejected before any probe → exit 2', async () => {
    const h = harness({ selectResult: verified('x'), isTTY: true, answer: 'y' });
    let probed = false;
    h.deps.select = async () => { probed = true; return verified('x'); };
    const r = await runAzureDoctor({ fix: true, candidates: ['bad name!! $(rm)'] }, h.deps);
    assert.equal(r.exitCode, EXIT.BAD_INPUT);
    assert.equal(probed, false, 'must not probe with an invalid candidate');
    assert.equal(r.wrote, false);
  });

  test('valid deployment-name candidates pass validation', async () => {
    const h = harness({ selectResult: verified('team-a_embed.v2'), isTTY: true, answer: 'y' });
    const r = await runAzureDoctor({ fix: true, candidates: ['team-a_embed.v2'] }, h.deps);
    assert.notEqual(r.exitCode, EXIT.BAD_INPUT);
  });
});

describe('azure-doctor — --json never writes, never prompts (H7)', () => {
  test('--json emits a machine object and mirrors the exit code, no write even with --fix', async () => {
    const h = harness({ selectResult: verified('text-embedding-3-large'), isTTY: true, answer: 'y' });
    const r = await runAzureDoctor({ json: true, fix: true }, h.deps);
    assert.equal(r.wrote, false, '--json must never write');
    assert.equal(r.exitCode, EXIT.FIXABLE);
    assert.ok(r.json && r.json.selected === 'text-embedding-3-large');
    // exactly one line of output, and it parses as JSON
    assert.doesNotThrow(() => JSON.parse(h.out()));
  });
});

describe('azure-doctor — --target (gpt / claude deployment slots)', () => {
  test('an unknown --target is rejected before any probe, exit 2', async () => {
    const h = harness({ selectResult: verified('x') });
    let probed = false;
    h.deps.select = async () => { probed = true; return verified('x'); };
    const r = await runAzureDoctor({ target: 'bogus' }, h.deps);
    assert.equal(r.exitCode, EXIT.BAD_INPUT);
    assert.equal(probed, false);
    assert.match(h.out(), /Invalid --target/);
  });

  test('--target gpt reads gptDeployment as configured, writes AZURE_OPENAI_GPT_DEPLOYMENT', async () => {
    const h = harness({ selectResult: verified('gpt-5.6-terra'), isTTY: true, answer: 'y' });
    h.deps.azure = { ...h.deps.azure, gptDeployment: 'gpt-5.5' };
    let seenConfigured = null;
    h.deps.select = async (args) => { seenConfigured = args.configured; return verified('gpt-5.6-terra'); };
    const r = await runAzureDoctor({ target: 'gpt', fix: true }, h.deps);
    assert.equal(seenConfigured, 'gpt-5.5');
    assert.equal(r.wrote, true);
    assert.match(h.written.text, /AZURE_OPENAI_GPT_DEPLOYMENT=gpt-5\.6-terra/);
    // The embedding-vector-space warning is embed-specific — must not leak to gpt.
    assert.doesNotMatch(h.out(), /embedding vector-space/i);
  });

  test('--target claude reads claudeDeployment as configured, writes AZURE_FOUNDRY_CLAUDE_DEPLOYMENT', async () => {
    const h = harness({ selectResult: verified('claude-opus-4-8'), isTTY: true, answer: 'y' });
    h.deps.azure = { ...h.deps.azure, claudeDeployment: 'claude-opus-4-7' };
    let seenConfigured = null;
    h.deps.select = async (args) => { seenConfigured = args.configured; return verified('claude-opus-4-8'); };
    const r = await runAzureDoctor({ target: 'claude', fix: true }, h.deps);
    assert.equal(seenConfigured, 'claude-opus-4-7');
    assert.equal(r.wrote, true);
    assert.match(h.written.text, /AZURE_FOUNDRY_CLAUDE_DEPLOYMENT=claude-opus-4-8/);
    assert.doesNotMatch(h.out(), /embedding vector-space/i);
  });

  test('default (no --target) is byte-identical to --target embed', async () => {
    const h1 = harness({ selectResult: verified('text-embedding-3-large'), isTTY: true, answer: 'y' });
    const r1 = await runAzureDoctor({ fix: true }, h1.deps);
    const h2 = harness({ selectResult: verified('text-embedding-3-large'), isTTY: true, answer: 'y' });
    const r2 = await runAzureDoctor({ target: 'embed', fix: true }, h2.deps);
    assert.equal(r1.exitCode, r2.exitCode);
    assert.equal(h1.written.text, h2.written.text);
  });
});
