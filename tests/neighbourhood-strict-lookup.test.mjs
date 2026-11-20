/**
 * @fileoverview get-neighbourhood / get-incident-neighbourhood must look the repo
 * up STRICTLY. `getRepoIdByUuid` swallows a DB error into `null` by default, and
 * `null` now means "connected store, repo not registered" — so a dropped
 * connection would be reported as an unregistered repo. Strict makes it throw.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../scripts/lib/cross-skill/dispatch.mjs';
import { argv } from './helpers/cross-skill-argv.mjs';

const KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
let saved;
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); process.env.GEMINI_API_KEY = 'test-key-not-used'; });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function deps(lookup) {
  const noop = async () => null;
  return {
    initLearningStore: async () => true, isCloudEnabled: async () => true,
    getRepoIdByUuid: lookup, getActiveSnapshot: noop, getBandCalibration: noop,
    callNeighbourhoodRpc: noop, callIncidentNeighbourhoodRpc: noop, getMaxIncidentRefreshAt: noop,
  };
}
const payload = '{"repoUuid":"00000000-0000-5000-8000-000000000001","targetPaths":[],"intentDescription":"x"}';

for (const cmd of ['get-neighbourhood', 'get-incident-neighbourhood']) {
  describe(`${cmd} — repo lookup is strict`, () => {
    it('asks for a strict lookup, and a DB error is an error, not "repo not registered"', async () => {
      let sawStrict = null;
      const lookup = async (_u, opts = {}) => { sawStrict = !!opts.strict; if (opts.strict) throw new Error('connection terminated'); return null; };
      const r = await dispatch(argv(cmd, '--json', payload), { deps: deps(lookup), cloudGate: 'ready' });
      assert.equal(sawStrict, true);
      assert.notEqual(r.exitCode, 0);
      assert.notEqual(r.envelope.repoRegistered, false);
    });

    it('control: a genuine absent row still reads as connected + unregistered', async () => {
      const r = await dispatch(argv(cmd, '--json', payload), { deps: deps(async () => null), cloudGate: 'ready' });
      assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
      assert.equal(r.envelope.cloud, true);
      assert.equal(r.envelope.repoRegistered, false);
    });
  });
}
