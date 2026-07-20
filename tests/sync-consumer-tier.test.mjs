/**
 * @fileoverview Adoption-tier classification for consumer repos.
 *
 * Guards the 2026-07-20 gap: a consumer with no `package.json` received a
 * GREEN sync and an inert `scripts/.claude-skills/**` tree, discoverable only
 * by running something and watching it fail to resolve its imports. The
 * classifier exists so sync can NAME that state up front.
 *
 * The load-bearing assertion is the last one: classification must stay
 * advisory. A Tier-2 consumer still gets a fully-working `.claude/skills/**`
 * markdown half, so sync must not abort on it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _internals } from '../scripts/sync-to-repos.mjs';

const { classifyConsumerRuntime, assessConsumerAzureEmbed } = _internals;

/** Build a throwaway consumer-shaped dir; returns its path. */
function makeRepo({ packageJson = false, nodeModules = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-tier-'));
  if (packageJson) fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
  if (nodeModules) fs.mkdirSync(path.join(root, 'node_modules'));
  return root;
}

describe('classifyConsumerRuntime', () => {
  it('a Node consumer with installed deps is Tier 1', () => {
    const root = makeRepo({ packageJson: true, nodeModules: true });
    assert.deepEqual(classifyConsumerRuntime(root), {
      tier: 1, hasPackageJson: true, hasNodeModules: true,
    });
  });

  it('package.json without node_modules is still Tier 1 (deps merely uninstalled)', () => {
    // Distinct from Tier 2: `npm install` fixes this one. Conflating them
    // would send a Node consumer down the foreign-cwd path for no reason.
    const root = makeRepo({ packageJson: true, nodeModules: false });
    assert.deepEqual(classifyConsumerRuntime(root), {
      tier: 1, hasPackageJson: true, hasNodeModules: false,
    });
  });

  it('a non-Node consumer (Python / Databricks / Go) is Tier 2', () => {
    const root = makeRepo();
    assert.deepEqual(classifyConsumerRuntime(root), {
      tier: 2, hasPackageJson: false, hasNodeModules: false,
    });
  });

  it('a stray node_modules without package.json is still Tier 2', () => {
    // Nothing declares the bundle's deps, so the .mjs half cannot be trusted
    // to resolve — an incidental node_modules must not promote the tier.
    const root = makeRepo({ nodeModules: true });
    assert.equal(classifyConsumerRuntime(root).tier, 2);
  });

  it('classification is advisory — it never throws on an odd consumer', () => {
    // (see assessConsumerAzureEmbed below for the Azure-side advisory)
    // Tier 2 must degrade to a warning, never an abort: the markdown half
    // works without a runtime, and refusing to sync would withdraw it.
    assert.doesNotThrow(() => classifyConsumerRuntime(makeRepo()));
    assert.doesNotThrow(() => classifyConsumerRuntime(path.join(os.tmpdir(), 'does-not-exist-xyz')));
  });
});

describe('assessConsumerAzureEmbed — advise at adoption time, not at first 400', () => {
  /** Write a consumer dir with the given .env contents (null = no .env at all). */
  function repoWithEnv(envText) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-azure-'));
    if (envText !== null) fs.writeFileSync(path.join(root, '.env'), envText);
    return root;
  }

  it('fires when Azure is active and no embed deployment is pinned', () => {
    const root = repoWithEnv('AZURE_OPENAI_ENDPOINT=https://r.openai.azure.com\n');
    assert.equal(assessConsumerAzureEmbed(root).actionable, true);
  });

  it('is silent once a deployment is pinned', () => {
    const root = repoWithEnv(
      'AZURE_OPENAI_ENDPOINT=https://r.openai.azure.com\n'
      + 'AZURE_OPENAI_EMBED_DEPLOYMENT=text-embedding-3-large\n');
    assert.equal(assessConsumerAzureEmbed(root).actionable, false);
  });

  it('is silent for a non-Azure consumer', () => {
    // The overwhelming majority. An advisory that fires on every sync is unread.
    assert.equal(assessConsumerAzureEmbed(repoWithEnv('OPENAI_API_KEY=sk-x\n')).actionable, false);
  });

  it('is silent when the consumer has no .env at all', () => {
    assert.equal(assessConsumerAzureEmbed(repoWithEnv(null)).actionable, false);
  });

  it('treats whitespace-only and quoted-empty as NOT set, matching config.mjs', () => {
    // config resolves `(env.X || '').trim() || default`, so a blank value takes
    // the default guess. If this predicate disagreed, the advice would contradict
    // the runtime it is advising about.
    for (const blank of ['AZURE_OPENAI_EMBED_DEPLOYMENT=   ', 'AZURE_OPENAI_EMBED_DEPLOYMENT=""', "AZURE_OPENAI_EMBED_DEPLOYMENT=''"]) {
      const root = repoWithEnv(`AZURE_OPENAI_ENDPOINT=https://r.openai.azure.com\n${blank}\n`);
      assert.equal(assessConsumerAzureEmbed(root).actionable, true, blank);
    }
  });

  it('strips quotes around a REAL value so it is not mistaken for unset', () => {
    const root = repoWithEnv(
      'AZURE_OPENAI_ENDPOINT="https://r.openai.azure.com"\n'
      + 'AZURE_OPENAI_EMBED_DEPLOYMENT="text-embedding-3-large"\n');
    assert.equal(assessConsumerAzureEmbed(root).actionable, false);
  });

  it('reads the CONSUMER file, never this process\'s env', () => {
    // The subtle one: resolveEnvValue also reports process.env. If the source
    // machine exports AZURE_OPENAI_ENDPOINT, every consumer would look
    // Azure-active and the advisory would fire repo-wide on a false premise.
    const prior = process.env.AZURE_OPENAI_ENDPOINT;
    process.env.AZURE_OPENAI_ENDPOINT = 'https://source-machine.openai.azure.com';
    try {
      assert.equal(assessConsumerAzureEmbed(repoWithEnv('OPENAI_API_KEY=sk-x\n')).actionable, false);
    } finally {
      if (prior === undefined) delete process.env.AZURE_OPENAI_ENDPOINT;
      else process.env.AZURE_OPENAI_ENDPOINT = prior;
    }
  });

  it('never throws on an unreadable or missing consumer path', () => {
    assert.doesNotThrow(() => assessConsumerAzureEmbed(path.join(os.tmpdir(), 'nope-xyz')));
  });
});
