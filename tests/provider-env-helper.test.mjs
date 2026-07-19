/**
 * @fileoverview The env-isolation helper must not itself leak env.
 *
 * Behavioural (not source-scan): these drive the real helper and assert on
 * `process.env` afterwards.
 *
 * Plan: docs/plans/debt-burndown-workstreams.md §4 WS-B4.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROVIDER_ENV_VARS, withScrubbedProviderEnv } from './helpers/provider-env.mjs';

const K = 'ANTHROPIC_BASE_URL';

describe('withScrubbedProviderEnv', () => {
  it('scrubs inside the scope and restores exactly afterwards', async () => {
    process.env[K] = 'https://ambient.example';
    await withScrubbedProviderEnv(() => {
      assert.equal(process.env[K], undefined, 'must be scrubbed inside');
    });
    assert.equal(process.env[K], 'https://ambient.example', 'must be restored after');
    delete process.env[K];
  });

  it('restores after a THROWING body (a failing test must not leak)', async () => {
    process.env[K] = 'https://ambient.example';
    await assert.rejects(() => withScrubbedProviderEnv(() => { throw new Error('boom'); }), /boom/);
    assert.equal(process.env[K], 'https://ambient.example');
    delete process.env[K];
  });

  it('preserves unset-vs-empty (presence is what the resolvers read)', async () => {
    delete process.env[K];
    await withScrubbedProviderEnv(() => {});
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, K), false,
      'an absent var must not come back as an empty string');

    process.env[K] = '';
    await withScrubbedProviderEnv(() => {});
    assert.equal(process.env[K], '', 'an empty var must come back empty, not absent');
    delete process.env[K];
  });

  it('cleans up a `set` key that is OUTSIDE the managed list (Gemini G1)', async () => {
    const CUSTOM = 'WS_B4_CUSTOM_PROBE';
    assert.ok(!PROVIDER_ENV_VARS.includes(CUSTOM), 'precondition: not managed');
    assert.equal(process.env[CUSTOM], undefined);

    await withScrubbedProviderEnv(() => {
      assert.equal(process.env[CUSTOM], 'injected', 'set must apply inside the scope');
    }, { set: { [CUSTOM]: 'injected' } });

    assert.equal(Object.prototype.hasOwnProperty.call(process.env, CUSTOM), false,
      'an injected key outside `vars` must not leak into every subsequent test');
  });

  it('`set` applies AFTER scrubbing, so a managed var can be forced', async () => {
    process.env[K] = 'ambient';
    await withScrubbedProviderEnv(() => {
      assert.equal(process.env[K], 'forced');
    }, { set: { [K]: 'forced' } });
    assert.equal(process.env[K], 'ambient');
    delete process.env[K];
  });

  it('a genuinely NESTED scope does not deadlock on its own owner', async () => {
    const out = await withScrubbedProviderEnv(async () => {
      return withScrubbedProviderEnv(() => 'nested-ok');
    });
    assert.equal(out, 'nested-ok');
  });

  it('concurrent scopes serialise instead of interleaving', async () => {
    // The G1 class: with a global counter, once A awaited, B saw depth>0 and
    // bypassed the queue, mutating env underneath A.
    process.env[K] = 'original';
    const seen = [];
    await Promise.all([
      withScrubbedProviderEnv(async () => {
        process.env[K] = 'A';
        await new Promise((r) => setTimeout(r, 30));
        seen.push(['A', process.env[K]]);
      }),
      withScrubbedProviderEnv(async () => {
        process.env[K] = 'B';
        await new Promise((r) => setTimeout(r, 10));
        seen.push(['B', process.env[K]]);
      }),
    ]);
    for (const [who, val] of seen) assert.equal(val, who, `${who} saw its own value, not the other scope's`);
    assert.equal(process.env[K], 'original', 'the outer value survives both scopes');
    delete process.env[K];
  });
});
