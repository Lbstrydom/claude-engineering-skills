/**
 * @fileoverview Tier 1 — `controls.mjs`'s `temperature` field and `lock.mjs`'s
 * `canonicalJson` must enforce the SAME numeric contract (Cluster A round 6, M4).
 *
 * Before this: `COMMON_SHAPE.temperature` accepted any finite non-negative
 * number, while `canonicalJson` refuses a number that does not survive a 6dp
 * round-trip (two such values would collapse to the same digest bytes and
 * silently merge distinct cohorts — see lock.mjs). A config could therefore
 * parse successfully and only fail much later, deep inside a `configDigest()`
 * call. The fix shares one predicate (`isCanonicalizableNumber`, exported from
 * lock.mjs) between the schema and the serializer, so the two cannot drift the
 * way `PreflightSchema`/`ControlsSchema` already did once (round 5, M5).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isCanonicalizableNumber, canonicalJson } from '../scripts/lib/comparison/lock.mjs';
import { controlsSchemaForRole } from '../scripts/lib/comparison/controls.mjs';

function baseControls(temperature) {
  return {
    reasoningEffort: 'high', promptTemplateId: 'a@1', outputSchemaId: 'b@1',
    maxOutputTokens: 32000, toolPolicy: 'structured-output-only', temperature,
    envelopeScope: 'thin',
  };
}

describe('temperature validation matches the digest\'s own round-trip test', () => {
  it('a value canonicalJson would refuse is ALSO refused at schema parse time', () => {
    const bad = 0.1234567; // does not survive toFixed(6) round-trip
    assert.throws(() => canonicalJson({ temperature: bad }), /does not survive 6dp canonicalisation/);
    const result = controlsSchemaForRole('final_review_shadow').safeParse(baseControls(bad));
    assert.equal(result.success, false, 'the schema must reject what the digest would later throw on');
    assert.match(result.error.issues[0].message, /6 decimal places/);
  });

  it('a value canonicalJson accepts is ALSO accepted by the schema', () => {
    for (const ok of [0, 0.5, 1, 0.123456]) {
      assert.doesNotThrow(() => canonicalJson({ temperature: ok }));
      assert.equal(controlsSchemaForRole('final_review_shadow').safeParse(baseControls(ok)).success, true, `${ok} must parse`);
    }
  });

  it('isCanonicalizableNumber agrees with canonicalJson on the exact same inputs', () => {
    for (const v of [0, 1, 0.5, 0.123456, 0.1234567, 1e-9, NaN, Infinity]) {
      const digestAccepts = (() => { try { canonicalJson({ v }); return true; } catch { return false; } })();
      assert.equal(isCanonicalizableNumber(v), digestAccepts, `mismatch for ${v}`);
    }
  });
});
