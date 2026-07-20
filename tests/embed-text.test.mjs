import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { embedText, providerTag, _internals } from '../scripts/lib/embed-text.mjs';
import { buildAzureConfig } from '../scripts/lib/config.mjs';

const INACTIVE = buildAzureConfig({});
const AZURE = buildAzureConfig({
  AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com',
  AZURE_OPENAI_API_KEY: 'k',
  AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-5.3-chat',
});

// Fakes ASSERT the input is a non-empty string — this is what catches the
// redactor `.text` bug (a string redactor would make `input` undefined).
const fakeAzureClient = (vec) => ({
  embeddings: {
    create: async ({ input }) => {
      assert.equal(typeof input, 'string', 'azure embeddings input must be a string');
      assert.ok(input.length > 0, 'azure embeddings input must be non-empty');
      return { data: [{ embedding: vec }], usage: { total_tokens: 7 } };
    },
  },
});
const fakeGeminiClient = (vec) => ({
  models: {
    embedContent: async ({ contents }) => {
      assert.equal(typeof contents, 'string', 'gemini embedContent contents must be a string');
      assert.ok(contents.length > 0, 'gemini embedContent contents must be non-empty');
      return { embeddings: [{ values: vec }], usageMetadata: { totalTokenCount: 9 } };
    },
  },
});

describe('providerTag — vector-space provenance (Gemini-R2-H1)', () => {
  it('reports azure-openai when active', () => {
    assert.equal(providerTag({ azure: AZURE }), 'azure-openai:text-embedding-3-large');
  });
  it('reports gemini when inactive', () => {
    assert.equal(providerTag({ azure: INACTIVE, model: 'gemini-embedding-001' }), 'gemini:gemini-embedding-001');
  });
});

describe('embedText — return contract {result, usage, latencyMs}', () => {
  it('azure path returns the vector + provider tag', async () => {
    const vec = new Array(768).fill(0.1);
    const out = await embedText('hello', { dim: 768, azure: AZURE, client: fakeAzureClient(vec) });
    assert.equal(out.result.length, 768);
    assert.equal(out.provider, 'azure-openai:text-embedding-3-large');
    assert.ok(typeof out.latencyMs === 'number');
  });

  it('gemini path returns the vector + provider tag', async () => {
    const vec = new Array(768).fill(0.2);
    const out = await embedText('hello', { dim: 768, azure: INACTIVE, model: 'gemini-embedding-001', client: fakeGeminiClient(vec) });
    assert.equal(out.result.length, 768);
    assert.equal(out.provider, 'gemini:gemini-embedding-001');
  });
});

describe('embedText — dim guard', () => {
  it('throws EMBEDDING_MISMATCH on wrong length', async () => {
    const vec = new Array(512).fill(0.1);
    await assert.rejects(
      () => embedText('x', { dim: 768, azure: AZURE, client: fakeAzureClient(vec) }),
      /dim mismatch/,
    );
  });
  it('throws on empty input', async () => {
    await assert.rejects(() => embedText('  ', { dim: 768, azure: AZURE }), /non-empty string/);
  });
  it('throws on bad dim', async () => {
    await assert.rejects(() => embedText('x', { dim: 0, azure: AZURE }), /positive integer/);
  });

  it('rejects vectors with non-finite elements (NaN/Infinity/string)', async () => {
    for (const bad of [[1, NaN, 3], [1, Infinity, 3], [1, '2', 3], [1, null, 3]]) {
      const dim = bad.length;
      await assert.rejects(
        () => embedText('x', { dim, azure: AZURE, client: fakeAzureClient(bad) }),
        /non-finite/,
        `expected rejection for ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('validateVector internal', () => {
  it('rejects empty', () => {
    assert.throws(() => _internals.validateVector([], 3, 'm'), /empty embedding/);
  });
});

// 2026-07-14 installer-audit P4: a cloud-enabled install with NO embedding
// provider (no GEMINI_API_KEY, Azure inactive) used to exit non-zero from
// get-neighbourhood. The CLIs now pre-check provider availability and degrade
// to {ok:true, records:[], degraded:'no-embed-provider'} — same contract as
// their cloud-disabled short-circuit. Subprocess probe (env-dependent path).
describe('get-neighbourhood degrades gracefully when no embedding provider is configured', () => {
  it('cloud enabled + no provider → exit 0, empty records, no-embed-provider hint', async () => {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, [
      'scripts/cross-skill.mjs', 'get-neighbourhood', '--json',
      JSON.stringify({ targetPaths: ['scripts/cross-skill.mjs'], intentDescription: 'probe', k: 3 }),
    ], {
      encoding: 'utf8', timeout: 30000,
      env: {
        PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
        AUDIT_LOOP_DISABLE_SHARED: '1', DOTENV_CONFIG_PATH: 'nonexistent-probe.env',
        AUDIT_DB_URL: 'postgresql://probe:probe@localhost:5999/probe',
      },
    });
    const result = JSON.parse(out.trim().split('\n').pop());
    assert.equal(result.ok, true);
    assert.equal(result.degraded, 'no-embed-provider');
    assert.deepEqual(result.records, []);
    assert.match(result.hint, /GEMINI_API_KEY/);
  });
});
