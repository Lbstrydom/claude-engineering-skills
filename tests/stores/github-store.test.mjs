import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// GitHub store tests only run when @octokit/rest is installed
describe('github adapter (structural)', () => {
  it('exports adapter with correct name and capabilities', async () => {
    try {
      const { adapter } = await import('../../scripts/lib/stores/github-store.mjs');
      assert.equal(adapter.name, 'github');
      assert.equal(adapter.capabilities.debt, true);
      assert.equal(adapter.capabilities.run, true);
      assert.equal(adapter.capabilities.learningState, true);
      assert.equal(adapter.capabilities.globalState, true);
      assert.equal(adapter.capabilities.repo, true);
      assert.equal(adapter.capabilities.scopeIsolation, true);
    } catch (err) {
      // @octokit/rest not installed — skip
      if (err.code === 'ERR_MODULE_NOT_FOUND') return;
      throw err;
    }
  });

  it('has a factory function', async () => {
    try {
      const { adapter } = await import('../../scripts/lib/stores/github-store.mjs');
      assert.equal(typeof adapter._factory, 'function');
    } catch (err) {
      if (err.code === 'ERR_MODULE_NOT_FOUND') return;
      throw err;
    }
  });
});

describe('github adapter selection', () => {
  it('github is in VALID_ADAPTERS', async () => {
    const { VALID_ADAPTERS } = await import('../../scripts/lib/stores/index.mjs');
    assert.ok(VALID_ADAPTERS.includes('github'));
  });
});
