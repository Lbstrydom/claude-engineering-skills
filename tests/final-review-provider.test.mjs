/**
 * @fileoverview Final-review provider selection precedence.
 *
 * Deterministic seam (Tier 1) — the per-repo default stack is "GPT auditor +
 * Gemini reviewer", and a stray AZURE_OPENAI_ENDPOINT must NOT silently hijack
 * the reviewer. These tests pin the precedence so that regression can't quietly
 * reroute a private-repo final review to Azure Foundry.
 *
 * `selectProvider` accepts injected `{env, azureActive}` so we can assert the
 * decision points without touching real credentials or the frozen azureConfig
 * snapshot. We only assert the return-value paths (no process.exit branches).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selectProvider, applyProviderSetting } from '../scripts/gemini-review.mjs';

describe('selectProvider precedence', () => {
  test('auto-detect prefers Gemini when GEMINI_API_KEY is present', () => {
    const env = { GEMINI_API_KEY: 'g' };
    assert.equal(selectProvider(null, { env, azureActive: false }), 'gemini');
  });

  test('Gemini wins over an active Azure profile (no silent hijack)', () => {
    // The core fix: even with the Azure work profile active, a present Gemini
    // key keeps the reviewer on Gemini unless explicitly overridden.
    const env = { GEMINI_API_KEY: 'g' };
    assert.equal(selectProvider(null, { env, azureActive: true }), 'gemini');
  });

  test('explicit "gemini" setting is honoured when its key exists', () => {
    const env = { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' };
    assert.equal(selectProvider('gemini', { env, azureActive: true }), 'gemini');
  });

  test('explicit "anthropic" setting selects public Claude Opus', () => {
    const env = { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' };
    assert.equal(selectProvider('anthropic', { env, azureActive: false }), 'claude-opus');
  });

  test('falls back to public Claude Opus when only ANTHROPIC_API_KEY is set', () => {
    const env = { ANTHROPIC_API_KEY: 'a' };
    assert.equal(selectProvider(null, { env, azureActive: false }), 'claude-opus');
  });
});

describe('applyProviderSetting (.env mutation, pure)', () => {
  test('appends FINAL_REVIEW_PROVIDER + managed comment when absent', () => {
    const { text, changed } = applyProviderSetting('OPENAI_API_KEY=x\n', 'azure-claude');
    assert.equal(changed, true);
    assert.match(text, /^OPENAI_API_KEY=x$/m);
    assert.match(text, /managed by `set-provider`/);
    assert.match(text, /^FINAL_REVIEW_PROVIDER=azure-claude$/m);
    assert.ok(text.endsWith('\n'));
  });

  test('replaces an existing value in place (no duplicate line)', () => {
    const start = 'A=1\nFINAL_REVIEW_PROVIDER=azure-claude\nB=2\n';
    const { text } = applyProviderSetting(start, 'gemini');
    assert.match(text, /^FINAL_REVIEW_PROVIDER=gemini$/m);
    assert.equal(text.match(/FINAL_REVIEW_PROVIDER=/g).length, 1);
    assert.match(text, /^A=1$/m);
    assert.match(text, /^B=2$/m);
  });

  test('default clears the line and its managed comment', () => {
    const { text } = applyProviderSetting('A=1\n', 'azure-claude');           // add
    const cleared = applyProviderSetting(text, 'default');                    // remove
    assert.equal(cleared.changed, true);
    assert.doesNotMatch(cleared.text, /FINAL_REVIEW_PROVIDER/);
    assert.doesNotMatch(cleared.text, /managed by `set-provider`/);
    assert.match(cleared.text, /^A=1$/m);
  });

  test('default on a file without the setting is a no-op', () => {
    const { text, changed } = applyProviderSetting('A=1\n', 'default');
    assert.equal(changed, false);
    assert.equal(text, 'A=1\n');
  });

  test('throws on an invalid provider', () => {
    assert.throws(() => applyProviderSetting('', 'bogus'), /invalid provider/);
  });
});
