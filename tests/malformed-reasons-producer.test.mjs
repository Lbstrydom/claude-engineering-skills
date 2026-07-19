/**
 * WS-E2 leg (b) — the dead read.
 *
 * `tiered-shadow-compare.mjs:349` has always READ
 * `_stageBreakdown.discoveryMalformedReasons`, but nothing in the repo ever
 * wrote it: a `grep` returned exactly one hit, the read itself. The field was
 * therefore permanently `null`, and because the consumer uses `?? null`, "never
 * written" was indistinguishable from "absent this run". So the E2 claim that
 * the Phase-14 blocker is "diagnosable from stored rows" held for the eval
 * record and was false for the shadow comparison — which is the surface the
 * Phase-14 window actually reads.
 *
 * The three-state contract is the fix, not merely the plumbing:
 *   null → nothing wrote it (pre-field row, or a run that never reached Stage 0)
 *   []   → this run WAS measured and had no malformed anchors
 *   [..] → measured, with bounded reasons
 * A change that restores a value but collapses null and [] has not fixed this.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  boundMalformedDetails,
  MALFORMED_MAX_BUCKETS,
  MALFORMED_MAX_EXEMPLARS,
  MALFORMED_OTHER_KEY,
} from '../scripts/lib/audit/malformed-details.mjs';

/** Mirrors the consumer's read at tiered-shadow-compare.mjs:349. */
const readAsConsumer = (stageBreakdown) => stageBreakdown?.discoveryMalformedReasons ?? null;

const mk = (n, reasonCode = 'producer_anchor_malformed') =>
  Array.from({ length: n }, (_, i) => ({
    rawIndex: i, reasonCode, reasonDetail: `detail ${i}`,
  }));

describe('E2b — the producer writes the key the consumer reads', () => {
  it('a measured run with malformed anchors yields a non-null breakdown', () => {
    const raw = [{ anchor: 'src/a.mjs:12' }, { anchor: 'src/b.mjs:30' }];
    const breakdown = { discoveryMalformedReasons: boundMalformedDetails(mk(2), raw) };
    const seen = readAsConsumer(breakdown);
    assert.notEqual(seen, null, 'the field must survive producer -> consumer');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].count, 2);
    assert.equal(seen[0].exemplars[0].rawAnchor, 'src/a.mjs:12',
      'exemplars must resolve their anchor from the raw findings');
  });

  it('THE CONTRACT: measured-and-empty ([]) is distinguishable from never-written (null)', () => {
    const measuredEmpty = { discoveryMalformedReasons: boundMalformedDetails([], []) };
    const neverWritten = { discoveryRawFindings: 0 };          // key absent, as the fallback path leaves it

    assert.deepEqual(readAsConsumer(measuredEmpty), [],
      'a measured run with zero malformed must read as [], not null');
    assert.equal(readAsConsumer(neverWritten), null,
      'an unwritten field must read as null — insufficient data, never "zero malformed"');
    assert.notDeepEqual(readAsConsumer(measuredEmpty), readAsConsumer(neverWritten),
      'collapsing these two is the original defect; they must not compare equal');
  });

  it('the never-ran fallback breakdown does NOT claim a measurement', () => {
    // Shape mirrors the early-return _stageBreakdown: every count 0 because
    // nothing ran, NOT because everything passed. Writing [] there would assert
    // "measured, none malformed" about a run that never reached Stage 0.
    const fallback = { discoveryRawFindings: 0, discoveryMalformedRaw: 0 };
    assert.equal(readAsConsumer(fallback), null);
    assert.ok(!('discoveryMalformedReasons' in fallback),
      'the fallback path must omit the key entirely, not zero it');
  });
});

describe('E2b — bounding survives the extraction to lib/', () => {
  it('caps buckets and folds the tail into a counted __other', () => {
    const many = [];
    for (let i = 0; i < MALFORMED_MAX_BUCKETS + 5; i++) many.push(...mk(1, `reason_${i}`));
    const out = boundMalformedDetails(many, []);
    assert.equal(out.length, MALFORMED_MAX_BUCKETS + 1, 'kept buckets + one __other');
    const other = out[out.length - 1];
    assert.equal(other.reasonCode, MALFORMED_OTHER_KEY);
    assert.equal(other.distinctReasonCodes, 5);
    assert.equal(other.count, 5);
  });

  it('caps exemplars per bucket while counting all', () => {
    const out = boundMalformedDetails(mk(MALFORMED_MAX_EXEMPLARS + 3), []);
    assert.equal(out[0].count, MALFORMED_MAX_EXEMPLARS + 3, 'count is over ALL items');
    assert.equal(out[0].exemplars.length, MALFORMED_MAX_EXEMPLARS);
    assert.equal(out[0].truncated, true);
    assert.equal(out[0].omittedCount, 3);
  });

  it('is deterministic — identical input yields identical records', () => {
    const input = [...mk(3, 'b_reason'), ...mk(5, 'a_reason')];
    assert.deepEqual(
      boundMalformedDetails(input, []),
      boundMalformedDetails(input, []),
      'two runs over the same input must produce byte-identical records');
  });

  it('an out-of-range rawIndex records the reason with a null anchor, never throws', () => {
    const out = boundMalformedDetails([{ rawIndex: 99, reasonCode: 'x', reasonDetail: 'd' }], []);
    assert.equal(out[0].exemplars[0].rawIndex, null);
    assert.equal(out[0].exemplars[0].rawAnchor, null);
  });
});
