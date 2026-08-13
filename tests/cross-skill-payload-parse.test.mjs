/**
 * @fileoverview Malformed payload JSON is BAD INPUT, not an internal exception.
 *
 * `parsePayload` called `JSON.parse` three times with no guard, so a typo in a
 * `--json` argument escaped as a raw `SyntaxError`. dispatch()'s catch-all then
 * reported it as `code: 'EXCEPTION'` with a **stack trace** at **exit 1** — the
 * shape this CLI reserves for "the tool broke". Every other bad-input rejection
 * on this surface (unknown flag, stray positional, unknown subcommand) is a
 * structured error at exit 2, so an operator scripting against `$?` could not
 * tell their own typo from a crash, and the stack trace pointed into
 * `dispatch.mjs` rather than at the argument they mistyped.
 *
 * Measured before the fix (`get-neighbourhood --json '{bad json'`):
 *   exit 1, {"ok":false,"error":{"code":"EXCEPTION","message":"Expected property
 *   name or '}' in JSON at position 1","stack":"SyntaxError: ...at parsePayload"}}
 *
 * The cases below drive the real dispatcher in-process and assert on the
 * EMITTED envelope + exit code, never on parsePayload directly — the defect was
 * only ever visible at that boundary.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../scripts/lib/cross-skill/dispatch.mjs';

const argv = (...a) => ['node', 'cross-skill.mjs', ...a];

/** Enough store surface for the command to reach its payload read. */
function stubDeps() {
  return {
    initLearningStore: async () => true,
    isCloudEnabled: async () => true,
    resolveRepoForStoreResult: async () => ({ kind: 'resolved', repoRowId: 'repo-1', repoUuid: 'uuid-1', name: 'o/r' }),
    getRepoIdByName: async () => 'repo-1',
    getRepoIdByUuid: async () => ({ id: 'repo-1', name: 'o/r' }),
    listRepoIds: async () => ['repo-1'],
    recordRegressionSpec: async () => ({ ok: true, cloud: true, specId: 'spec-1' }),
  };
}

const VALID = JSON.stringify({
  specPath: 'tests/x.spec.ts', description: 'd', sourceKind: 'ux-lock',
  assertionCount: 1, domContractTypes: [],
});

describe('parsePayload — malformed JSON is BAD_PAYLOAD at exit 2, never EXCEPTION at exit 1', () => {
  it('POSITIVE CONTROL: well-formed --json still parses and succeeds', async () => {
    // Without this the suite could pass by rejecting everything.
    const r = await dispatch(argv('record-regression-spec', '--json', VALID), { deps: stubDeps(), cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.equal(r.envelope.ok, true);
  });

  it('--json with malformed JSON', async () => {
    const r = await dispatch(argv('record-regression-spec', '--json', '{bad json'), { deps: stubDeps(), cloudGate: 'ready' });
    assert.equal(r.exitCode, 2, 'bad input is exit 2 on this CLI, the same as an unknown flag');
    assert.equal(r.envelope.ok, false);
    assert.equal(r.envelope.error.code, 'BAD_PAYLOAD');
    assert.equal(r.envelope.error.stack, undefined, 'a user typo must not emit an internal stack trace');
  });

  it('the message names the SOURCE of the bad payload, so the operator knows which arg to fix', async () => {
    const r = await dispatch(argv('record-regression-spec', '--json', '{bad json'), { deps: stubDeps(), cloudGate: 'ready' });
    assert.match(r.envelope.error.message, /--json/);
  });

  it('trailing bare-JSON arg with malformed JSON', async () => {
    // The third parse site: skills interpolate a bare `{...}` as the last arg.
    const r = await dispatch(argv('record-regression-spec', '{bad json'), { deps: stubDeps(), cloudGate: 'ready' });
    assert.equal(r.exitCode, 2);
    assert.equal(r.envelope.error.code, 'BAD_PAYLOAD');
  });

  it('a payload that is valid JSON but not an object is still BAD_PAYLOAD', async () => {
    // `JSON.parse('7')` succeeds and hands every downstream `payload.x` read an
    // undefined — the malformed-record class, one level up from a parse error.
    const r = await dispatch(argv('record-regression-spec', '--json', '7'), { deps: stubDeps(), cloudGate: 'ready' });
    assert.equal(r.exitCode, 2);
    assert.equal(r.envelope.error.code, 'BAD_PAYLOAD');
    assert.match(r.envelope.error.message, /object/);
  });
});
