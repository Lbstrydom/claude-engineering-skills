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

const { classifyConsumerRuntime } = _internals;

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
    // Tier 2 must degrade to a warning, never an abort: the markdown half
    // works without a runtime, and refusing to sync would withdraw it.
    assert.doesNotThrow(() => classifyConsumerRuntime(makeRepo()));
    assert.doesNotThrow(() => classifyConsumerRuntime(path.join(os.tmpdir(), 'does-not-exist-xyz')));
  });
});
