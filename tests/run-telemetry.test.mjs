/**
 * @fileoverview Tier 1/2 unit tests for scripts/lib/audit/run-telemetry.mjs
 * (docs/plans/legacy-production-audit-decomposition.md Phase 4d) — direct
 * coverage of this module's own exports. `runTelemetry` itself (the
 * observation/cloud-write stage) is covered end-to-end through
 * tests/finalization-characterization.test.mjs's golden-master harness
 * (cloud OFF, per this repo's no-whole-provider-mock testing doctrine) —
 * this file covers the guard function that IS independently testable:
 * `classifyShadowFailureSafe` takes an injectable import seam specifically
 * so its own recovery-failure path can be exercised without touching the
 * real audit-shadow.mjs module.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { classifyShadowFailureSafe } = await import('../scripts/lib/audit/run-telemetry.mjs');

describe('classifyShadowFailureSafe — guards its own recovery import', () => {
  it('falls back to a safe classification when the recovery import itself fails, instead of throwing', async () => {
    const originalErr = new Error('original shadow failure');
    const failingImporter = () => { throw new Error('module load failed'); };
    const { log, marker } = await classifyShadowFailureSafe(originalErr, failingImporter);
    assert.equal(marker, null);
    assert.match(log, /shadow failure classification unavailable/);
    assert.match(log, /original shadow failure/);
  });

  it('delegates to the real classifyShadowFailure when the import succeeds', async () => {
    const { classifyShadowFailure } = await import('../scripts/lib/audit-shadow.mjs');
    const originalErr = new Error('some shadow error');
    const direct = classifyShadowFailure(originalErr);
    const viaSafe = await classifyShadowFailureSafe(originalErr);
    assert.deepEqual(viaSafe, direct);
  });

  it('never throws, even when the recovery import\'s own error is not a real Error', async () => {
    const badImporter = () => { throw 'not an Error instance'; };
    const { log, marker } = await classifyShadowFailureSafe(new Error('x'), badImporter);
    assert.equal(marker, null);
    assert.equal(typeof log, 'string');
  });
});
