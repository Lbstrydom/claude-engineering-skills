// Tier 1: retry scoping is STORE-authoritative, not local-log-authoritative.
//
// THE MEASURED DEFECT (2026-08-18, ~6x overspend). `selectRetryArmIds` decides
// which arms to re-spawn from the local `.audit/bakeoff-log.jsonl`. `.audit/`
// is gitignored, so a freshly-created pinned fixture has an EMPTY one — and
// `docs/runbooks/pinned-revision-fixture.md` tells the operator to create
// exactly such a fixture to retry a snapshot at its recorded revision (the
// only correct way, since the store refuses mixed-revision snapshots). So the
// documented happy path for a partial retry WAS the overspend path.
//
// Snapshot 2bb342bdd692 of campaign final-review-scoped-2026q3, verified
// against the live store on 2026-08-18: six rows, all `superseded_at IS NULL`,
// `grok` alone carrying `error: 'exit 1'`. The intent was to re-bill grok. All
// six re-ran; three of the five re-runs then failed on provider errors, so the
// snapshot STILL did not complete and reconcile promoted 0.
//
// Every fixture below is that exact shape. The negative control re-runs the
// SAME fixture through the pre-fix oracle so the failing answer is asserted,
// not merely described (verification-discipline: a check is not trustworthy
// until it has been seen to fail).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planRetryScope, selectRetryArmIds } from '../scripts/bakeoff-collect.mjs';
import { CONTRACT_EPOCH } from '../scripts/lib/bakeoff/log.mjs';
import { createResolvedScope } from '../scripts/lib/bakeoff/scope.mjs';
import { liveArmIdsForSnapshot } from '../scripts/lib/store/campaign.mjs';

/** The six declared arms of the campaign the incident happened in. */
const ARM_IDS = ['opus', 'kimi', 'grok', 'gemini-control', 'qwen', 'deepseek'];
const SCOPE = createResolvedScope('final-review-scoped-2026q3', ARM_IDS.map((id) => ({ id, solo: false })), null);

/** What the live store actually returned for 2bb342bdd692: five live,
 *  error-free arm-runs; grok excluded because its row carries an error. */
const STORE_HAS_FIVE = Object.freeze({
  ok: true, source: 'store', reason: null,
  armIds: ['deepseek', 'gemini-control', 'kimi', 'opus', 'qwen'],
});
const STORE_HAS_ALL = Object.freeze({ ok: true, source: 'store', reason: null, armIds: [...ARM_IDS] });
const STORE_HAS_NONE = Object.freeze({ ok: true, source: 'store', reason: null, armIds: [] });
/** The shape `recordedArmIdsForSnapshot` returns when the cloud is off — a
 *  NON-ANSWER, deliberately not an empty measured list. */
const STORE_OFF = Object.freeze({
  ok: false, source: 'store', armIds: [],
  reason: 'cloud is off, or this repo has no store row yet',
});

/** A local log entry in which every arm ran except the ones not named. */
const entryWith = (ranIds, { epoch = CONTRACT_EPOCH } = {}) => ({
  snapshotId: '2bb342bdd692',
  campaignId: 'final-review-scoped-2026q3',
  contractEpoch: epoch,
  arms: Object.fromEntries(ARM_IDS.map((id) => [id, ranIds.includes(id) ? { shadowState: 'ran' } : { error: 'exit 1' }])),
});

describe('bakeoff retry scoping — THE FRESH-FIXTURE CASE (store authoritative)', () => {
  it('5 arms live in the store + an EMPTY local log ⇒ schedules ONLY the missing arm', () => {
    const plan = planRetryScope({
      existing: undefined,          // a fresh fixture's .audit/ is empty
      existingScope: null,
      resolvedScope: SCOPE,
      recorded: STORE_HAS_FIVE,
    });
    assert.equal(plan.mode, 'partial');
    assert.deepEqual(plan.armIds, ['grok']);
    assert.equal(plan.alreadyRecorded.length, 5, 'the five recorded arms must be named as NOT re-charged');
    assert.ok(!plan.armIds.includes('opus'), 'opus is live in the store and must never be re-billed');
    assert.ok(!plan.armIds.includes('gemini-control'), 'gemini-control is live in the store and must never be re-billed');
  });

  it('NEGATIVE CONTROL: the pre-fix oracle answers "collect everything" on the SAME fixture', () => {
    // This is the defect, executed. `selectRetryArmIds` is the whole of the old
    // rule; with no local entry it returns null, and null is the caller's
    // sentinel for a FULL collection. Six arms, five of them already paid for.
    const old = selectRetryArmIds(undefined, null);
    assert.equal(old, null,
      'the old rule really does fall through to a full collection — if this ever changes, the assertion below stops being a control');
    const oldSpawnSet = old ?? ARM_IDS;                        // exactly what main() did with null
    assert.equal(oldSpawnSet.length, 6, 'the old scoping re-bills all six arms');

    const now = planRetryScope({ existing: undefined, existingScope: null, resolvedScope: SCOPE, recorded: STORE_HAS_FIVE });
    assert.equal(now.armIds.length, 1, 'the fix re-bills exactly one');
    assert.ok(oldSpawnSet.length > now.armIds.length, 'red-then-green: same input, the old oracle is strictly wider');
  });

  it('the arms actually spawned are REPORTED before spending — the missing line that hid the bill', () => {
    const plan = planRetryScope({ existing: undefined, existingScope: null, resolvedScope: SCOPE, recorded: STORE_HAS_FIVE });
    const text = plan.messages.join('\n');
    assert.match(text, /store: 5 arm\(s\) already recorded live/);
    assert.match(text, /local log: no entry for this snapshot/);
  });

  it('a store that holds EVERY declared arm ⇒ nothing to do, never a full re-collection', () => {
    const plan = planRetryScope({ existing: undefined, existingScope: null, resolvedScope: SCOPE, recorded: STORE_HAS_ALL });
    assert.equal(plan.mode, 'nothing-to-do');
    assert.deepEqual(plan.armIds, []);
    assert.match(plan.messages.join('\n'), /every declared arm is already recorded live/);
  });

  it('a store that holds NOTHING is a measured zero ⇒ an honest full first collection, no warning', () => {
    const plan = planRetryScope({ existing: undefined, existingScope: null, resolvedScope: SCOPE, recorded: STORE_HAS_NONE });
    assert.equal(plan.mode, 'full');
    assert.equal(plan.armIds, null);
    assert.equal(plan.warn, false, 'a genuine first-ever collection is not a warning condition');
  });
});

describe('bakeoff retry scoping — cloud-off fallback FAILS LOUD', () => {
  it('no store answer + no local entry ⇒ full collection, warn:true, naming the source and its answer', () => {
    const plan = planRetryScope({ existing: undefined, existingScope: null, resolvedScope: SCOPE, recorded: STORE_OFF });
    assert.equal(plan.mode, 'full');
    assert.equal(plan.warn, true, 'a silent widening is the defect — this path must be loud');
    const text = plan.messages.join('\n');
    assert.match(text, /WARNING: cannot determine which arms are already recorded/);
    assert.match(text, /store: NOT CONSULTABLE — cloud is off, or this repo has no store row yet/,
      'the source consulted AND what it returned, not a bare "unknown"');
    assert.match(text, /FULL collection of 6 arm\(s\), every one of which will be billed/,
      'the operator must see the size of the bill BEFORE it is incurred');
    assert.match(text, /campaign\.mjs reconcile/, 'and the remedy');
  });

  it('NEGATIVE CONTROL: the same widening WITHOUT a store failure is silent — warn must discriminate', () => {
    // If `warn` were simply true whenever mode === 'full', the flag would carry
    // no information and an operator would learn to ignore it. A first-ever
    // collection against a reachable, empty cohort is a full collection nobody
    // needs warning about.
    const quiet = planRetryScope({ existing: undefined, existingScope: null, resolvedScope: SCOPE, recorded: STORE_HAS_NONE });
    const loud = planRetryScope({ existing: undefined, existingScope: null, resolvedScope: SCOPE, recorded: STORE_OFF });
    assert.equal(quiet.mode, loud.mode, 'both are full collections');
    assert.notEqual(quiet.warn, loud.warn, 'but only the undetermined one warns');
  });

  it('a null `recorded` (store never asked) is treated exactly like an unreachable store', () => {
    const plan = planRetryScope({ existing: undefined, existingScope: null, resolvedScope: SCOPE, recorded: null });
    assert.equal(plan.mode, 'full');
    assert.equal(plan.warn, true);
  });
});

describe('bakeoff retry scoping — the ordinary same-directory retry is unchanged', () => {
  const existing = entryWith(['opus', 'kimi', 'gemini-control', 'qwen', 'deepseek']);
  const existingScope = SCOPE;

  it('local log knows 5 of 6 ran, store unreachable ⇒ still retries only grok', () => {
    const plan = planRetryScope({ existing, existingScope, resolvedScope: SCOPE, recorded: STORE_OFF });
    assert.equal(plan.mode, 'partial');
    assert.deepEqual(plan.armIds, ['grok']);
    assert.equal(plan.warn, false, 'the local log answered — nothing is undetermined here');
  });

  it('local log and store agree ⇒ the answer does not change', () => {
    const plan = planRetryScope({ existing, existingScope, resolvedScope: SCOPE, recorded: STORE_HAS_FIVE });
    assert.deepEqual(plan.armIds, ['grok']);
  });

  it('local log says an arm is missing that the store already holds ⇒ that arm is NOT re-billed', () => {
    // A stale local entry in a second checkout: it never saw qwen or deepseek
    // succeed, but the store did. Re-spawning them would be the same overspend
    // in a smaller costume.
    const stale = entryWith(['opus', 'kimi', 'gemini-control']);
    const plan = planRetryScope({ existing: stale, existingScope, resolvedScope: SCOPE, recorded: STORE_HAS_FIVE });
    assert.deepEqual(plan.armIds, ['grok']);
    assert.ok(!plan.armIds.includes('qwen') && !plan.armIds.includes('deepseek'));
  });

  it('every arm the local log is missing is already in the store ⇒ nothing to do', () => {
    const stale = entryWith(['opus']);
    const plan = planRetryScope({ existing: stale, existingScope, resolvedScope: SCOPE, recorded: STORE_HAS_ALL });
    assert.equal(plan.mode, 'nothing-to-do');
    assert.match(plan.messages.join('\n'), /already recorded live in the store/);
  });

  it('the DELIBERATE full re-collection (every arm ran, snapshot still incomplete) is NOT narrowed by the store', () => {
    // A stale contract epoch: no per-arm retry can fix it, so re-spawning
    // nothing would be a silent no-op that never resolves the incompleteness.
    const staleEpoch = entryWith(ARM_IDS, { epoch: 'e2-one-reasoning-dial' });
    const plan = planRetryScope({ existing: staleEpoch, existingScope, resolvedScope: SCOPE, recorded: STORE_HAS_ALL });
    assert.equal(plan.mode, 'full');
    assert.equal(plan.armIds, null);
  });

  it('--force keeps its meaning: an explicit re-collection is never narrowed by the store', () => {
    const plan = planRetryScope({ existing: entryWith(ARM_IDS), existingScope, resolvedScope: SCOPE, recorded: STORE_HAS_ALL, force: true });
    assert.equal(plan.mode, 'full');
    assert.deepEqual(plan.alreadyRecorded, []);
    assert.match(plan.messages.join('\n'), /--force: the store is NOT consulted to narrow this run/);
  });
});

describe('store read — a non-answer is never a measured zero', () => {
  it('an incomplete cohort identity returns ok:false, not an empty armIds a caller could trust', async () => {
    // Environment-independent: cloud-off returns the cloud-off refusal, cloud-on
    // returns the identity refusal, and BOTH must be ok:false. An `ok:true` with
    // `armIds: []` here would tell the collector "nothing is recorded" on the
    // strength of a question that was never asked.
    const r = await liveArmIdsForSnapshot({ repoId: null, campaignKey: null, lockDigest: null, snapshotId: null });
    assert.equal(r.ok, false);
    assert.deepEqual(r.armIds, []);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'and it names why it could not answer');
  });
});
