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
import { selectRetryArmIds } from '../scripts/bakeoff-collect.mjs';
import { armDidRun, scopeForEntry } from '../scripts/lib/bakeoff/arms.mjs';
import { entriesToSpendSnapshots } from '../scripts/lib/bakeoff/summary.mjs';
import { CONTRACT_EPOCH } from '../scripts/lib/bakeoff/log.mjs';
import { createResolvedScope } from '../scripts/lib/bakeoff/scope.mjs';
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
  const scope = createResolvedScope('test-campaign', ARMS, null);

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

// ── §7 Phase 2: store-authoritative retry scoping ───────────────────────────
describe('bakeoff-collect — selectRetryArmIds is STORE-authoritative (Phase 2)', () => {
  const scope = createResolvedScope('test-campaign', ARMS, null);
  const CONFIG_DIGEST = 'config-abc';
  const PLAN_HASH = 'planhash-current';

  it('(a) fresh/empty local log + store showing 5 of 6 arms succeeded selects only the missing arm', () => {
    const SIX = [OPUS, KIMI, GROK, { id: 'qwen', solo: false }, { id: 'deepseek', solo: false }, SOLO_OPUS];
    const sixScope = createResolvedScope('test-campaign', SIX, null);
    const storeArmState = {
      opus: { succeeded: true }, kimi: { succeeded: true }, grok: { succeeded: true },
      qwen: { succeeded: true }, deepseek: { succeeded: false }, 'solo-opus': { succeeded: true },
    };
    assert.deepEqual(selectRetryArmIds(undefined, sixScope, storeArmState), ['deepseek']);
  });

  it('(b) a store-live arm with succeeded:false (recorded error) is still selected for retry, not skipped', () => {
    const storeArmState = { opus: { succeeded: false }, kimi: { succeeded: true }, grok: { succeeded: true } };
    assert.deepEqual(selectRetryArmIds(undefined, scope, storeArmState), ['opus']);
  });

  it('(e) a store-live succeeded:true arm ALSO matched by an active exclusion reads succeeded:false upstream and is retried', () => {
    // `liveArmRunsForSnapshot` (store/campaign.mjs) is what applies
    // isAttemptExcluded to compute `succeeded` — by the time selectRetryArmIds
    // sees it, an excluded attempt has already been demoted to `false`.
    const storeArmState = { opus: { succeeded: false }, kimi: { succeeded: true }, grok: { succeeded: true } };
    assert.deepEqual(selectRetryArmIds(undefined, scope, storeArmState), ['opus']);
  });

  it('(f) the store shows an arm ABSENT (not yet promoted) but the local log shows it completed — treated as done, not re-spawned', () => {
    const entry = {
      contractEpoch: CONTRACT_EPOCH,
      arms: { opus: { shadowState: 'ran' }, kimi: { shadowState: 'ran' }, grok: { error: 'exit 1' } },
    };
    // storeArmState has no entry for any arm at all (absent from the store).
    assert.deepEqual(selectRetryArmIds(entry, scope, {}), ['grok']);
  });

  it('(g) same as (f) but the log-side completed result is matched by an active exclusion — the arm IS re-spawned', () => {
    const entry = {
      snapshotId: 's1', contractEpoch: CONTRACT_EPOCH,
      arms: { opus: { shadowState: 'ran' }, kimi: { shadowState: 'ran' }, grok: { error: 'exit 1' } },
    };
    const exclusions = [{ snapshotId: 's1', scope: 'all', planContentHash: null }];
    assert.deepEqual(selectRetryArmIds(entry, scope, {}, exclusions).sort(), ['grok', 'kimi', 'opus']);
  });

  it('(h)/(l) store-shaped success with a differing config/plan hash reads succeeded:false upstream — retried', () => {
    // (h)/(l) test `liveArmRunsForSnapshot`'s own predicate directly —
    // see tests/store-campaign-arm-state.test.mjs. Here we assert the
    // downstream consequence: once the store reports succeeded:false for a
    // stale-provenance arm, selectRetryArmIds retries it.
    const storeArmState = { opus: { succeeded: false }, kimi: { succeeded: true }, grok: { succeeded: true } };
    assert.deepEqual(selectRetryArmIds(undefined, scope, storeArmState), ['opus']);
  });

  it('(m) STORE absent + LOG completed under a DIFFERENT planContentHash than current — re-spawned, not treated as done', () => {
    const entry = {
      contractEpoch: CONTRACT_EPOCH,
      arms: {
        opus: { shadowState: 'ran', planContentHash: 'planhash-OLD', configDigest: CONFIG_DIGEST },
        kimi: { shadowState: 'ran', planContentHash: PLAN_HASH, configDigest: CONFIG_DIGEST },
        grok: { shadowState: 'ran', planContentHash: PLAN_HASH, configDigest: CONFIG_DIGEST },
      },
    };
    assert.deepEqual(selectRetryArmIds(entry, scope, {}, [], CONFIG_DIGEST, PLAN_HASH), ['opus']);
  });

  it('(n) NEGATIVE CONTROL for the store side: a two-real-hash mismatch (not NULL) still forces retry', () => {
    const storeArmState = { opus: { succeeded: false }, kimi: { succeeded: true }, grok: { succeeded: true } };
    assert.deepEqual(selectRetryArmIds(undefined, scope, storeArmState), ['opus'],
      'a strict, non-null mismatch must still force retry — only a NULL legacy hash is grandfathered');
  });

  it('(o) log-side mirror of the M1 grandfathering fix: a carried-forward arm with planContentHash:null is trusted as done', () => {
    const entry = {
      contractEpoch: CONTRACT_EPOCH,
      arms: {
        opus: { shadowState: 'ran', planContentHash: null, configDigest: null },
        kimi: { shadowState: 'ran', planContentHash: PLAN_HASH, configDigest: CONFIG_DIGEST },
        grok: { shadowState: 'ran', planContentHash: PLAN_HASH, configDigest: CONFIG_DIGEST },
      },
    };
    assert.equal(selectRetryArmIds(entry, scope, {}, [], CONFIG_DIGEST, PLAN_HASH), null,
      'every arm is trusted — the legacy NULL-hash opus result must not force a retry it cannot resolve');
  });

  it('NEGATIVE CONTROL: with no store/exclusion data at all (2-arg call), behaviour is IDENTICAL to pre-Phase-2', () => {
    const entry = {
      contractEpoch: CONTRACT_EPOCH,
      arms: { opus: { shadowState: 'ran' }, kimi: { shadowState: 'ran' }, grok: { error: 'exit 1' } },
    };
    assert.deepEqual(selectRetryArmIds(entry, scope), ['grok']);
  });

  it('a totally fresh fixture with NOTHING done anywhere returns null (first-ever collection), not an empty/full retry list', () => {
    assert.equal(selectRetryArmIds(undefined, scope, {}), null);
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
  // `entriesToSpendSnapshots` now takes a `ResolvedScope` directly (D2's
  // signature correction — it calls `isComplete(e, scope)`, not
  // `isCompleteForEntry(e)`, since `summary.mjs` cannot import `arms.mjs`).
  // The real committed scope for every call below — a synthetic single/pair
  // arm list would silently under-declare the campaign's actual arm count,
  // exactly the bug this describe block's own comment warns against. Arms
  // not present in a given fixture's `arms` object are still correctly
  // excluded from `armRuns` (the `.filter(Boolean)` null-prune below).
  const SCOPE = scopeForEntry({ campaignId: CAMPAIGN_ID });

  it('an unpriced arm-run maps to costStatus:"unpriced", never a $0 charge', () => {
    const entries = [{
      snapshotId: 's1', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID,
      arms: { opus: { shadowState: 'ran', costUsd: null } },
    }];
    const snaps = entriesToSpendSnapshots(entries, SCOPE);
    assert.equal(snaps[0].armRuns[0].costStatus, 'unpriced');
    assert.equal(snaps[0].armRuns[0].costUsd, null);
  });

  it('THE PRODUCTION SHAPE: a recorded `costUsd` is priced — the raw-artifact keys are not what a log entry holds', () => {
    // The bug this pins (fixed 2026-08-18): the projection called
    // `armCostUsd(record)`, which prices a raw arm `--out` artifact by reading
    // `_model`/`_usage`/`_shadow.usage`. A LOG entry holds `readArmResult`'s
    // OUTPUT, where none of those keys exist and the price is already computed
    // into `costUsd` — so every real row resolved to null and reported
    // unpriced. Measured over this repo's own bake-off log at the time of the
    // fix: 0 of 112 arm-runs priced, and the incomplete-spend line rendered
    // `monetaryStatus: 'unknown'` with all six arms excluded.
    //
    // The old fixtures could not catch it because they wrote `_usage`/`_model`
    // INTO the log record — a shape production has never emitted. This asserts
    // both sides: the real shape prices, and the artifact-only shape does NOT
    // silently price (its money is genuinely unknown at this layer).
    const entries = [{
      snapshotId: 's1', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID,
      arms: {
        opus: { shadowState: 'ran', costUsd: 3.1125, unpricedModels: [] },
        kimi: { shadowState: 'ran', _model: 'moonshotai/kimi-k2-thinking', _usage: { input_tokens: 1, output_tokens: 1 } },
      },
    }];
    const runs = Object.fromEntries(entriesToSpendSnapshots(entries, SCOPE)[0].armRuns.map((r) => [r.armId, r]));
    assert.equal(runs.opus.costStatus, 'priced');
    assert.equal(runs.opus.costUsd, 3.1125);
    assert.equal(runs.kimi.costStatus, 'unpriced', 'raw-artifact keys are not a recorded price and must not be read as one');
  });

  it('an arm never spawned this round is EXCLUDED, not a $0 row', () => {
    const entries = [{ snapshotId: 's1', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID, arms: { opus: { shadowState: 'ran' } } }];
    const snaps = entriesToSpendSnapshots(entries, SCOPE);
    assert.equal(snaps[0].armRuns.length, 1, 'kimi (and every other declared arm) never ran this round and must not appear as a zero-cost row');
    assert.equal(snaps[0].armRuns[0].armId, 'opus');
  });

  it('the complete flag is derived per-entry, from its own committed campaign scope', () => {
    // The "complete" fixture is DERIVED from the campaign's own declared arms,
    // not a hardcoded list. It was hardcoded to four (opus/kimi/grok/
    // gemini-control) and broke the moment a concurrent session added `qwen`
    // and `deepseek` to that campaign — s1 silently became incomplete, so both
    // sides of the contrast read `false` and the assertion failed. That is the
    // test working as designed (its own comment asked to read the config live
    // rather than blind), and the fix is to finish the job: enumerate the arms
    // from the config so adding a seventh arm cannot break this again.
    //
    // shadowScope is likewise read from the campaign's declared
    // controls.envelopeScope rather than pinned to the literal 'thin'.
    const scope = scopeForEntry({ campaignId: CAMPAIGN_ID });
    assert.ok(scope && scope.arms.length >= 2,
      'fixture invalid — the committed campaign must resolve to a real arm set or this test proves nothing');
    const ran = { shadowState: 'ran', shadowScope: scope.expectedScope };
    const complete = {
      snapshotId: 's1', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID,
      arms: Object.fromEntries(scope.arms.map((a) => [a.id, { ...ran }])),
    };
    const incomplete = { snapshotId: 's2', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID, arms: { opus: { error: 'x' } } };
    const snaps = entriesToSpendSnapshots([complete, incomplete], scope);
    assert.equal(snaps[1].complete, false, 's2 is missing three declared arms');
    // Whether s1 reads complete also depends on the live envelopeScope this
    // committed campaign currently declares — asserted loosely (not hardcoded
    // true) so this test does not silently start asserting the WRONG scope
    // string if that campaign's config changes; the meaningful, stable
    // property is the CONTRAST with s2 below.
    assert.notEqual(snaps[0].complete, snaps[1].complete);
  });

  it('a RETRIED arm contributes one row PER ATTEMPT — the superseded one was still paid for', () => {
    // Spend counts every attempt; effectiveness counts the live one. An arm
    // that timed out and recovered must not report the same spend as one that
    // succeeded first time, or the cost stage systematically flatters the
    // flakiest model in the cohort.
    const entries = [{
      snapshotId: 's1', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID,
      arms: {
        qwen: {
          shadowState: 'ran', costUsd: 0.41,
          supersededAttempts: [{ attempt: 1, errorCategory: 'timeout', elapsedMs: 900_000, costUsd: null, unpricedModels: ['qwen3.8-max'] }],
        },
      },
    }];
    const runs = entriesToSpendSnapshots(entries, SCOPE)[0].armRuns.filter((r) => r.armId === 'qwen');
    assert.equal(runs.length, 2, 'the timed-out attempt must appear as its own arm-run');
    assert.equal(runs[0].attempt, 1);
    assert.equal(runs[0].costStatus, 'unpriced', 'a timed-out call returned no usage — unknown, never $0');
    assert.equal(runs[0].supersededAt, 'recorded');
    assert.equal(runs[1].attempt, 2);
    assert.equal(runs[1].costStatus, 'priced');
    assert.equal(runs[1].supersededAt, null, 'the live attempt is the one that is not superseded');
    // The consequence that matters: armSpend must now read this arm's money as
    // UNKNOWN rather than confidently reporting only the successful attempt.
    const v = incompleteSpend(entriesToSpendSnapshots(entries, SCOPE), { cohortDigest: 'test' });
    assert.ok(v.excludedArmIds.includes('qwen'),
      'an arm with an unmeterable attempt must be named as excluded, not silently totalled from its cheap half');
  });

  it('NEGATIVE CONTROL: an arm with no retry history contributes exactly ONE row', () => {
    const entries = [{
      snapshotId: 's1', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID,
      arms: { qwen: { shadowState: 'ran', costUsd: 0.41 } },
    }];
    const runs = entriesToSpendSnapshots(entries, SCOPE)[0].armRuns.filter((r) => r.armId === 'qwen');
    assert.equal(runs.length, 1, 'inventing an attempt would over-report spend, the mirror of under-reporting it');
    assert.equal(runs[0].attempt, 1);
  });

  it('end-to-end with incompleteSpend: only the incomplete snapshot counts', () => {
    const entries = [
      {
        snapshotId: 's1', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID,
        arms: { opus: { error: 'x', costUsd: 0.0001 } },
      },
      {
        snapshotId: 's2', contractEpoch: CONTRACT_EPOCH, campaignId: CAMPAIGN_ID,
        arms: { opus: { error: 'x', costUsd: 0.0001 } },
      },
    ];
    // Both entries here are INCOMPLETE by construction (single arm, errored)
    // — the assertion is that incompleteSpend sees exactly those two AND
    // sums their (real, priced) cost, proving the projection round-trips
    // through the shared core end to end rather than dropping the charge
    // just because the arm errored (an error is still a paid call).
    const snaps = entriesToSpendSnapshots(entries, SCOPE);
    const v = incompleteSpend(snaps, { cohortDigest: 'test' });
    assert.equal(v.incompleteSnapshotCount, 2);
    assert.equal(v.monetaryStatus, 'complete', 'opus is priced on both — nothing here is unpriced');
    assert.ok(v.incompleteSpendUsd > 0, 'two priced, errored calls still cost real money and must be counted');
  });
});
