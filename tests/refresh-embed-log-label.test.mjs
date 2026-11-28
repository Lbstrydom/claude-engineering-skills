/**
 * The refresh log's embed line names the model the vectors are made with. Under
 * Azure a consumer saw `model=gemini-embedding-001` while embed.mjs used the
 * Azure deployment; the label now comes from the same resolveEmbedProfile().
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { embedLogLabel } from '../scripts/symbol-index/refresh-subprocess.mjs';
import { resolveEmbedProfile } from '../scripts/lib/embed-text.mjs';

describe('embedLogLabel', () => {
  it('names the Azure deployment, never the Gemini default, under Azure', () => {
    const azure = { active: true, embedDeployment: 'text-embedding-3-large', openaiEndpoint: 'https://example.openai.azure.com' };
    const label = embedLogLabel(resolveEmbedProfile({ azure, concreteModel: 'gemini-embedding-001' }), 'gemini-embedding-001');
    assert.match(label, /text-embedding-3-large/);
    assert.match(label, /azure-openai/);
    assert.doesNotMatch(label, /gemini/);
  });

  it('names the concrete Gemini model off-Azure', () => {
    const label = embedLogLabel(resolveEmbedProfile({ azure: { active: false }, concreteModel: 'gemini-embedding-001' }), 'gemini-embedding-001');
    assert.equal(label, 'model=gemini-embedding-001, gemini');
  });

  it('falls back to the concrete model when no profile is passed', () => {
    assert.equal(embedLogLabel(undefined, 'gemini-embedding-001'), 'model=gemini-embedding-001');
  });
});

// The pipeline spawns extract/summarise/embed as subprocesses, so (as in refresh-cli-contract.test.mjs) the
// wiring is pinned at the source: reverting either link restores the Azure mislabel while the unit tests stay green.
describe('embed log wiring', () => {
  const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8');
  it('refresh.mjs hands its resolved embedProfile to runExtractSummariseEmbed', () => {
    const call = /runExtractSummariseEmbed\(\{[\s\S]*?\}\)/.exec(read('scripts/symbol-index/refresh.mjs'));
    assert.ok(call, 'the call site exists');
    assert.match(call[0], /\bembedProfile\b/);
  });
  it('the embed progress line is built by embedLogLabel from that profile, never from concreteEmbedModel alone', () => {
    const src = read('scripts/symbol-index/refresh-subprocess.mjs');
    assert.match(src, /logOk\(`embedding \(\$\{embedLogLabel\(embedProfile, concreteEmbedModel\)\}\)\.\.\.`\)/);
    assert.doesNotMatch(src, /embedding \(model=\$\{concreteEmbedModel\}\)/);
  });
});
