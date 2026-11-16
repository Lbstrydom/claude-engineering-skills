/**
 * @fileoverview Final-review provider selection precedence.
 *
 * Deterministic seam (Tier 1) — the per-repo default stack is "GPT auditor +
 * Gemini reviewer" off the Azure profile; ON it (AZURE_OPENAI_ENDPOINT set, hook v18) the final review is Foundry Claude and never
 * quietly Gemini. A repo that wants Gemini there makes an explicit choice. These tests pin the precedence.
 *
 * `selectProvider` accepts injected `{env, azureActive}` so we can assert the
 * decision points without touching real credentials or the frozen azureConfig
 * snapshot. We only assert the return-value paths (no process.exit branches).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selectProvider, applyProviderSetting } from '../scripts/gemini-review.mjs';
import { ProviderNotReadyError, describeAzureClaudeGap, quoteForDisplay } from '../scripts/lib/final-review/providers.mjs';

describe('selectProvider precedence', () => {
  test('auto-detect prefers Gemini when GEMINI_API_KEY is present', () => {
    const env = { GEMINI_API_KEY: 'g' };
    assert.equal(selectProvider(null, { env, azureActive: false }), 'gemini');
  });

  test('an active Azure profile selects Azure Claude even when GEMINI_API_KEY is set (hook v18)', () => {
    // 2026-11-12 (STO): a work-profile worker with a Gemini key in its environment got a Gemini final verdict. The work profile's rule is
    // Foundry Claude; Gemini on that profile now needs an EXPLICIT choice (next test).
    const env = { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' };
    assert.equal(selectProvider(null, { env, azureActive: true, assertAzure: () => {} }), 'azure-claude');
  });

  test('an active Azure profile whose route is unusable FAILS LOUDLY - it never falls through to Gemini or public Opus', () => {
    const env = { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' };
    const assertAzure = () => { throw new ProviderNotReadyError('azure route unreachable'); };
    assert.throws(() => selectProvider(null, { env, azureActive: true, assertAzure }), (e) => e instanceof ProviderNotReadyError && /azure route unreachable/.test(e.message));
  });

  test('the public path is unchanged: azure inactive never consults the Azure readiness check', () => {
    const assertAzure = () => { throw new Error('must not be called'); };
    assert.equal(selectProvider(null, { env: { GEMINI_API_KEY: 'g' }, azureActive: false, assertAzure }), 'gemini');
    assert.equal(selectProvider(null, { env: { ANTHROPIC_API_KEY: 'a' }, azureActive: false, assertAzure }), 'claude-opus');
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

describe('half-configured Azure profile: refuse loudly, with a remedy that keeps the profile (AIO 2026-11-15)', () => {
  // ai-organiser: AZURE_OPENAI_ENDPOINT set, AZURE_FOUNDRY_CLAUDE_DEPLOYMENT unset. The refusal was right (hook v18 forbids a
  // silent public fallback); its remedy, "unset AZURE_OPENAI_ENDPOINT", switched the whole work profile off to get past it.
  const halfConfigured = { claudeRoute: { mode: 'apim', apiKey: 'k', credentialVar: 'AZURE_OPENAI_API_KEY' }, claudeDeployment: null };
  const assertWith = (azure) => (deps) => {
    const msg = describeAzureClaudeGap(azure, deps?.env ?? {});
    if (msg) throw new ProviderNotReadyError(msg);
  };

  test('auto-detect still REFUSES - never routes the tenant diff to Gemini on its own', () => {
    const env = { GEMINI_API_KEY: 'g' };
    assert.throws(() => selectProvider(null, { env, azureActive: true, assertAzure: assertWith(halfConfigured) }),
      (e) => e instanceof ProviderNotReadyError && /AZURE_FOUNDRY_CLAUDE_DEPLOYMENT/.test(e.message));
  });

  test('the message names the missing variable and the explicit opt-out, and no longer says to clear the endpoint', () => {
    const msg = describeAzureClaudeGap(halfConfigured, { GEMINI_API_KEY: 'g' });
    assert.match(msg, /requires AZURE_FOUNDRY_CLAUDE_DEPLOYMENT/);
    assert.match(msg, /--provider gemini/);
    assert.match(msg, /set-provider gemini/);
    assert.match(msg, /azure-doctor\.mjs --target claude/);
    assert.doesNotMatch(msg, /unset AZURE_OPENAI_ENDPOINT/);
  });

  test('the public opt-out is offered only when its key exists', () => {
    assert.doesNotMatch(describeAzureClaudeGap(halfConfigured, {}), /--provider/);
    assert.match(describeAzureClaudeGap(halfConfigured, { ANTHROPIC_API_KEY: 'a' }), /--provider anthropic/);
  });

  test('the explicit opt-out the message names actually works on the same profile', () => {
    assert.equal(selectProvider('gemini', { env: { GEMINI_API_KEY: 'g' }, azureActive: true, assertAzure: assertWith(halfConfigured) }), 'gemini');
  });

  test('a fully configured route has no gap', () => {
    assert.equal(describeAzureClaudeGap({ ...halfConfigured, claudeDeployment: 'claude-opus-dep' }, {}), null);
  });
});

describe('quoteForDisplay — a suggested command stays pasteable', () => {
  test('a plain path is shown bare', () => assert.equal(quoteForDisplay('scripts/azure-doctor.mjs'), 'scripts/azure-doctor.mjs'));
  test('a path with a space or a shell metacharacter is SINGLE-quoted (literal in POSIX shells and PowerShell alike)', () => {
    assert.equal(quoteForDisplay('my repo/scripts/x.mjs'), "'my repo/scripts/x.mjs'");
    // Inside double quotes PowerShell expands $ and its escape is a backtick, so a backslash escape is not portable.
    assert.equal(quoteForDisplay('a$b/x.mjs'), "'a$b/x.mjs'");
    assert.equal(quoteForDisplay('a`b/x.mjs'), "'a`b/x.mjs'");
    assert.equal(quoteForDisplay('a&b/x.mjs'), "'a&b/x.mjs'");
  });
  test('an embedded single quote cannot be quoted portably, so the output says which shell it is for', () => {
    assert.equal(quoteForDisplay("o'brien/x.mjs"), "'o''brien/x.mjs' (PowerShell quoting)");
  });
});
