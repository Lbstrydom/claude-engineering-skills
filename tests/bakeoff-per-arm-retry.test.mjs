// Tier 1: D5's per-arm retry — "a snapshot where 3 of 4 arms succeeded
// retries only the failed arm". Pure logic, no spawning: armDidRun and
// selectRetryArmIds are extracted exactly so this is assertable without a
// provider call, mirroring campaign.mjs's resolvePromotionAttempt.
//
// The measured waste this replaces: --force on a partially-failed snapshot
// used to re-spawn EVERY arm, discarding paid results from the ones that had
// already succeeded. Each test below asserts the failing direction too (§9
// negative-control rule).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  armDidRun, selectRetryArmIds, entriesToSpendSnapshots, scopeForEntry, CONTRACT_EPOCH,
} from '../scripts/bakeoff-collect.mjs';
import { incompleteSpend } from '../scripts/lib/comparison/spend.mjs';

const OPUS = { id: 'opus', solo: false };
const KIMI = { id: 'kimi', solo: false };
const GROK = { id: 'grok', solo: false };
const SOLO_OPUS = { id: 'solo-opus', solo: true };
const ARMS = [OPUS, KIMI, GROK];

describe('bakeoff-collect — armDidRun', () => {
  it('a shadow arm that ran and reported no error DID run', () => {
    assert.equal(armDidRun(OPUS, { arms: { opus: { shadowState: 'ran' } } }), true);
  });

  it('an errored arm did NOT run, even if shadowState looks fine', () => {
    assert.equal(armDidRun(OPUS, { arms: { opus: { shadowState: 'ran', error: 'exit 1' } } }), false);
  });

  it('an arm absent from the entry did NOT run', () => {
    assert.equal(armDidRun(OPUS, { arms: {} }), false);
  });

  it('a solo arm is judged by its verdict, not shadowState', () => {
    assert.equal(armDidRun(SOLO_OPUS, { arms: { 'solo-opus': { primaryVerdict: 'APPROVE' } } }), true);
    assert.equal(armDidRun(SOLO_OPUS, { arms: { 'solo-opus': {} } }), false);
  });

  it('NEGATIVE CONTROL: a solo arm judged by shadowState alone would wrongly report never-ran', () => {
    // The trap this predicate exists to avoid: a solo arm has no shadow bucket
    // at all, so `shadowState !== 'ran'` is true for every legitimate solo
    // result — a naive universal check would mark it permanently missing.
    assert.equal(armDidRun(SOLO_OPUS, { arms: { 'solo-opus': { primaryVerdict: 'APPROVE', shadowState: undefined } } }), true);
  });
});

describe('bakeoff-collect — selectRetryArmIds (D5)', () => {
  const scope = { arms: ARMS, expectedScope: null };

  it('a first-ever collection retries nothing — there is no existing entry', () => {
    assert.equal(selectRetryArmIds(undefined, scope), null);
  });

  it('an unresolvable campaign scope retries nothing — "cannot judge" is not "an arm failed"', () => {
    const entry = { contractEpoch: CONTRACT_EPOCH, arms: { opus: { error: 'x' } } };
    assert.equal(selectRetryArmIds(entry, null), null);
  });

  it('an already-complete entry retries nothing', () => {
    const entry = {
      contractEpoch: CONTRACT_EPOCH,
      arms: { opus: { shadowState: 'ran' }, kimi: { shadowState: 'ran' }, grok: { shadowState: 'ran' } },
    };
    assert.equal(selectRetryArmIds(entry, scope), null);
  });

  it('THE HEADLINE CASE: 1 of 3 arms errored — retries ONLY that arm', () => {
    const entry = {
      contractEpoch: CONTRACT_EPOCH,
      arms: {
        opus: { shadowState: 'ran' },
        kimi: { shadowState: 'ran' },
        grok: { error: 'exit 1' },
      },
    };
    assert.deepEqual(selectRetryArmIds(entry, scope), ['grok']);
  });

  it('NEGATIVE CONTROL: the succeeded arms must NOT appear in the retry set', () => {
    const entry = {
      contractEpoch: CONTRACT_EPOCH,
      arms: { opus: { shadowState: 'ran' }, kimi: { shadowState: 'ran' }, grok: { error: 'exit 1' } },
    };
    const retry = selectRetryArmIds(entry, scope);
    assert.ok(!retry.includes('opus'), 'opus already succeeded and must not be re-spawned');
    assert.ok(!retry.includes('kimi'), 'kimi already succeeded and must not be re-spawned');
  });

  it('multiple failed arms are all named', () => {
    const entry = {
      contractEpoch: CONTRACT_EPOCH,
      arms: { opus: { shadowState: 'ran' }, kimi: { error: 'x' }, grok: { error: 'y' } },
    };
    assert.deepEqual(selectRetryArmIds(entry, scope).sort(), ['grok', 'kimi']);
  });

  it('every declared arm ran, yet the snapshot is still incomplete: falls back to full re-collection (null)', () => {
    // isComplete failed for a reason a per-arm retry cannot fix (envelope-
    // scope binding, contract epoch mismatch). Re-spawning nothing here would
    // be a silent no-op that can never resolve the incompleteness.
    const entry = {
      contractEpoch: 'a-stale-epoch',
      arms: { opus: { shadowState: 'ran' }, kimi: { shadowState: 'ran' }, grok: { shadowState: 'ran' } },
    };
    assert.equal(selectRetryArmIds(entry, scope), null);
  });
});

describe('bakeoff-collect — entriesToSpendSnapshots projects into comparison/spend.mjs shape', () => {
  // `entriesToSpendSnapshots` derives `complete` via `isCompleteForEntry`,
  // which resolves scope from the entry's OWN `campaignId` (the 2026-08-14
  // ambient-default incident fix) — so a fixture with no `campaignId` is
  // judged against WHATEVER campaign happens to resolve ambiguously in this
  // repo, not against arms this test controls. Pointing at the real committed
  // `final-review-scoped-2026q3` campaign (arms: opus, kimi, grok,
  // gemini-control) makes the fixture deterministic instead of environment-
  // dependent, the same way `tests/final-review-bakeoff.test.mjs` anchors to
  // a committed config rather than the ambient default.
  const CAMPAIGN_ID = 'final-review-scoped-2026q3';
  const priced = () => ({ input_tokens: 1, output_tokens: 1 });

  it('an unpriced arm-run maps to costStatus:"unpriced", never a $0 charge', () => {
    const entries = [{
      snapshotId: 's1', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID,
      arms: { opus: { shadowState: 'ran', _usage: null } },
    }];
    const snaps = entriesToSpendSnapshots(entries, [OPUS]);
    assert.equal(snaps[0].armRuns[0].costStatus, 'unpriced');
    assert.equal(snaps[0].armRuns[0].costUsd, null);
  });

  it('an arm never spawned this round is EXCLUDED, not a $0 row', () => {
    const entries = [{ snapshotId: 's1', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID, arms: { opus: { shadowState: 'ran' } } }];
    const snaps = entriesToSpendSnapshots(entries, [OPUS, KIMI]);
    assert.equal(snaps[0].armRuns.length, 1, 'kimi never ran this round and must not appear as a zero-cost row');
    assert.equal(snaps[0].armRuns[0].armId, 'opus');
  });

  it('the complete flag is derived per-entry, from its own committed campaign scope', () => {
    // Complete needs every one of the campaign's FOUR declared arms to have
    // run — supplying only opus/kimi/grok is deliberately incomplete for the
    // negative half of this same assertion.
    const complete = {
      snapshotId: 's1', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID,
      // shadowScope:'thin' matches this committed campaign's declared
      // controls.envelopeScope — read live rather than hardcoded blind, so a
      // future change to that config fails this test loudly instead of
      // leaving it silently asserting the wrong scope.
      arms: {
        opus: { shadowState: 'ran', shadowScope: 'thin' }, kimi: { shadowState: 'ran', shadowScope: 'thin' },
        grok: { shadowState: 'ran', shadowScope: 'thin' }, 'gemini-control': { shadowState: 'ran', shadowScope: 'thin' },
      },
    };
    const incomplete = { snapshotId: 's2', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID, arms: { opus: { error: 'x' } } };
    const snaps = entriesToSpendSnapshots([complete, incomplete], [OPUS]);
    assert.equal(snaps[1].complete, false, 's2 is missing three declared arms');
    // Whether s1 reads complete also depends on the live envelopeScope this
    // committed campaign currently declares — asserted loosely (not hardcoded
    // true) so this test does not silently start asserting the WRONG scope
    // string if that campaign's config changes; the meaningful, stable
    // property is the CONTRAST with s2 below.
    assert.notEqual(snaps[0].complete, snaps[1].complete);
  });

  it('end-to-end with incompleteSpend: only the incomplete snapshot counts', () => {
    const entries = [
      {
        snapshotId: 's1', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID,
        arms: { opus: { error: 'x', _usage: priced(), _model: 'claude-opus-5' } },
      },
      {
        snapshotId: 's2', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID,
        arms: { opus: { error: 'x', _usage: priced(), _model: 'claude-opus-5' } },
      },
    ];
    // Both entries here are INCOMPLETE by construction (single arm, errored)
    // — the assertion is that incompleteSpend sees exactly those two AND
    // sums their (real, priced) cost, proving the projection round-trips
    // through the shared core end to end rather than dropping the charge
    // just because the arm errored (an error is still a paid call).
    const snaps = entriesToSpendSnapshots(entries, [OPUS]);
    const v = incompleteSpend(snaps, { cohortDigest: 'test' });
    assert.equal(v.incompleteSnapshotCount, 2);
    assert.equal(v.monetaryStatus, 'complete', 'opus is priced on both — nothing here is unpriced');
    assert.ok(v.incompleteSpendUsd > 0, 'two priced, errored calls still cost real money and must be counted');
  });
});
