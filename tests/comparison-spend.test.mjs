// Tier 1: scripts/lib/comparison/spend.mjs + cost.mjs — pure, deterministic, no
// LLM. Each test asserts the failing direction too (§9 negative-control rule):
// a spend test that cannot fail when money is dropped is worthless.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { armSpend, incompleteSpend, armBudgetStop } from '../scripts/lib/comparison/spend.mjs';
import { evaluateCost } from '../scripts/lib/comparison/cost.mjs';

describe('comparison/spend — armSpend sums ALL attempts', () => {
  it('a superseded attempt WAS paid for — it counts', () => {
    const spend = armSpend([{
      snapshotId: 's1',
      armRuns: [
        { armId: 'flaky', attempt: 1, costUsd: 2, costStatus: 'priced', supersededAt: '2026-08-10T00:00:00Z' },
        { armId: 'flaky', attempt: 2, costUsd: 3, costStatus: 'priced', supersededAt: null },
        { armId: 'steady', attempt: 1, costUsd: 3, costStatus: 'priced', supersededAt: null },
      ],
    }]);
    assert.equal(spend.flaky.spendUsd, 5);
    assert.equal(spend.flaky.attempts, 2);
    assert.equal(spend.steady.spendUsd, 3);
  });

  it('NEGATIVE CONTROL: summing only live attempts would under-report — the direction that must not fire', () => {
    // If a future edit "simplified" this to sum only supersededAt:null rows,
    // flaky would silently drop to 3 instead of 5. Pin the discriminator.
    const spend = armSpend([{
      snapshotId: 's1',
      armRuns: [
        { armId: 'flaky', attempt: 1, costUsd: 2, costStatus: 'priced', supersededAt: '2026-08-10T00:00:00Z' },
        { armId: 'flaky', attempt: 2, costUsd: 3, costStatus: 'priced', supersededAt: null },
      ],
    }]);
    assert.notEqual(spend.flaky.spendUsd, 3, 'live-only summation would under-report a paid, superseded attempt');
  });

  it('an unpriced attempt makes cost evidence unknown, never zero', () => {
    const spend = armSpend([{ snapshotId: 's1', armRuns: [{ armId: 'a', costUsd: null, costStatus: 'unpriced', supersededAt: null }] }]);
    assert.equal(spend.a.costEvidence, 'unknown');
    assert.equal(spend.a.unpricedAttempts, 1);
    assert.equal(spend.a.spendUsd, 0, 'the summed portion is 0; costEvidence is what marks it unusable, not the number');
  });

  it('THE HEADLINE CASE: a NEGATIVE costUsd degrades to unpriced rather than DECREASING the total (Cluster B fix-gate, round 2)', () => {
    // No real provider bill is negative; a finite negative number here can
    // only be a corrupted or malformed upstream value. Trusting it would make
    // a corrupted call look like a REFUND, silently deflating aggregate
    // spend — the wrong direction for a cost-accounting sum.
    const spend = armSpend([{
      snapshotId: 's1',
      armRuns: [
        { armId: 'a', costUsd: 5, costStatus: 'priced' },
        { armId: 'a', costUsd: -3, costStatus: 'priced' },
      ],
    }]);
    assert.equal(spend.a.spendUsd, 5, 'the negative attempt must NOT subtract from the real one — it never counted as priced at all');
    assert.equal(spend.a.costEvidence, 'unknown', 'a negative-cost attempt makes the arm as unusable as an unpriced one');
    assert.equal(spend.a.unpricedAttempts, 1);
  });

  it("THE HEADLINE CASE: an arm literally named 'constructor' gets a real entry, not the inherited Object constructor (Cluster B fix-gate, round 2)", () => {
    // `constructor` matches ARM_ID_PATTERN (`__proto__` does not — the
    // pattern's charset excludes underscores). A plain `{}` accumulator
    // inherits Object.prototype, so `perArm['constructor'] ?? (assign)` reads
    // the INHERITED constructor FUNCTION first — truthy, so the `??`
    // short-circuits and no real entry is ever written; the next line then
    // silently attaches `.attempts` to the global `Object` function.
    const spend = armSpend([{ snapshotId: 's1', armRuns: [{ armId: 'constructor', costUsd: 5, costStatus: 'priced' }] }]);
    assert.equal(typeof spend.constructor, 'object', 'must be a real spend record, not the inherited Object constructor function');
    assert.equal(spend.constructor.attempts, 1);
    assert.equal(spend.constructor.spendUsd, 5);
  });

  it("NEGATIVE CONTROL: other prototype-inherited names (toString, hasOwnProperty, valueOf) are equally safe", () => {
    for (const armId of ['toString', 'hasOwnProperty', 'valueOf']) {
      const spend = armSpend([{ snapshotId: 's1', armRuns: [{ armId, costUsd: 1, costStatus: 'priced' }] }]);
      assert.equal(typeof spend[armId], 'object', `${armId}: must be a real spend record`);
      assert.equal(spend[armId].attempts, 1, `${armId}: attempts must be tracked correctly`);
    }
  });

  it('spend includes incomplete AND superseded snapshots — effectiveness must not share this sum', () => {
    const snapshots = [
      { snapshotId: 's1', complete: true, armRuns: [{ armId: 'opus', costUsd: 1, costStatus: 'priced' }] },
      { snapshotId: 's2', complete: false, armRuns: [{ armId: 'opus', costUsd: 1, costStatus: 'priced' }] },
    ];
    assert.equal(armSpend(snapshots).opus.spendUsd, 2, 'both the complete and incomplete snapshot must count');
  });

  // Cluster B fix-gate (R6) — each attempt's costUsd is validated finite
  // before summing, but the RUNNING TOTAL was not: enough finite-but-extreme
  // attempts can still overflow to Infinity, which round6(Infinity) passes
  // through unchanged rather than catching.
  it('an overflowed running total degrades to unpriced/unknown, never escapes as Infinity/NaN', () => {
    const armRuns = Array.from({ length: 3 }, () => ({ armId: 'a', costUsd: Number.MAX_VALUE, costStatus: 'priced' }));
    const r = armSpend([{ snapshotId: 's1', armRuns }]);
    assert.equal(r.a.spendUsd, 0);
    assert.equal(r.a.costEvidence, 'unknown');
    assert.ok(Number.isFinite(r.a.spendUsd));
  });

  it('NEGATIVE CONTROL: a normal, realistic sum is unaffected by the overflow guard', () => {
    const r = armSpend([{ snapshotId: 's1', armRuns: [{ armId: 'b', costUsd: 2.5, costStatus: 'priced' }, { armId: 'b', costUsd: 1.25, costStatus: 'priced' }] }]);
    assert.equal(r.b.spendUsd, 3.75);
    assert.equal(r.b.costEvidence, 'known');
  });
});

describe('comparison/spend — incompleteSpend view model', () => {
  it('empty state: zero incomplete snapshots renders as absent, not $0.00', () => {
    const v = incompleteSpend([{ snapshotId: 's1', complete: true, armRuns: [{ armId: 'opus', costUsd: 1, costStatus: 'priced' }] }]);
    assert.equal(v.incompleteSnapshotCount, 0);
    assert.equal(v.incompleteSpendUsd, null, 'absent, never 0 — a renderer must be told nothing was incomplete');
    assert.equal(v.monetaryStatus, 'complete');
  });

  it('the measured incident shape: 59% of spend on incomplete snapshots, all named', () => {
    const snapshots = [
      { snapshotId: 's1', complete: true, armRuns: [{ armId: 'opus', costUsd: 2.94, costStatus: 'priced' }] },
      { snapshotId: 's2', complete: false, armRuns: [{ armId: 'opus', costUsd: 2.5, costStatus: 'priced' }, { armId: 'kimi', costUsd: 1.66, costStatus: 'priced' }] },
      { snapshotId: 's3', complete: false, armRuns: [{ armId: 'grok', error: 'exit 1', costUsd: null, costStatus: 'unpriced' }] },
    ];
    const v = incompleteSpend(snapshots, { cohortDigest: 'abc123' });
    assert.equal(v.cohortDigest, 'abc123');
    assert.equal(v.incompleteSnapshotCount, 2);
    assert.equal(v.incompleteSpendUsd, 4.16, 'the priced portion of incomplete-snapshot spend');
    assert.equal(v.monetaryStatus, 'partial', 'grok is unpriced — the total must not read as complete');
    assert.deepEqual(v.excludedArmIds, ['grok']);
  });

  it('every incomplete arm unpriced yields unknown, never a confident $0.00', () => {
    const v = incompleteSpend([{ snapshotId: 's1', complete: false, armRuns: [{ armId: 'a', costUsd: null, costStatus: 'unpriced' }] }]);
    assert.equal(v.incompleteSpendUsd, null);
    assert.equal(v.monetaryStatus, 'unknown');
  });

  it('NEGATIVE CONTROL: a naive sum would render $0.00 for the fully-unpriced case', () => {
    const v = incompleteSpend([{ snapshotId: 's1', complete: false, armRuns: [{ armId: 'a', costUsd: null, costStatus: 'unpriced' }] }]);
    assert.notEqual(v.incompleteSpendUsd, 0, 'a $0.00 here is indistinguishable from "nothing was spent" — the exact misread this view model exists to prevent');
  });

  // Cluster B fix-gate (R4) — a snapshot that died before its first arm run
  // was even recorded (armRuns: []) is a different shape from an unpriced
  // arm: it has NO arm id for excludedArmIds to name, and an empty armIds
  // list previously read as "nothing to total" (monetaryStatus: 'complete',
  // $0.00) rather than "we have zero data". unrecordedSnapshotCount closes
  // that gap.
  it('a snapshot with NO arm run recorded at all reads as unknown, never a confident $0.00', () => {
    const v = incompleteSpend([{ snapshotId: 's-crashed', complete: false, armRuns: [] }]);
    assert.equal(v.incompleteSnapshotCount, 1);
    assert.equal(v.unrecordedSnapshotCount, 1);
    assert.equal(v.incompleteSpendUsd, null, 'must not render as $0.00 — we never observed a single arm run');
    assert.equal(v.monetaryStatus, 'unknown');
    assert.deepEqual(v.excludedArmIds, [], 'no arm id exists to name — the snapshot never reached its first arm');
  });

  it('a snapshot with armRuns entirely absent (not just empty) is the same "unrecorded" fact', () => {
    const v = incompleteSpend([{ snapshotId: 's-crashed', complete: false }]);
    assert.equal(v.unrecordedSnapshotCount, 1);
    assert.equal(v.incompleteSpendUsd, null);
    assert.equal(v.monetaryStatus, 'unknown');
  });

  it('MIXED: one recorded+priced snapshot beside one wholly-unrecorded one — total stays true for what it covers, gap is named', () => {
    const snapshots = [
      { snapshotId: 's1', complete: false, armRuns: [{ armId: 'opus', costUsd: 2, costStatus: 'priced' }] },
      { snapshotId: 's-crashed', complete: false, armRuns: [] },
    ];
    const v = incompleteSpend(snapshots);
    assert.equal(v.incompleteSnapshotCount, 2);
    assert.equal(v.unrecordedSnapshotCount, 1);
    assert.equal(v.incompleteSpendUsd, 2, 'the recorded portion is still reported — it is real data, not folded into unknown');
    assert.equal(v.monetaryStatus, 'partial', 'a genuine gap exists beside genuine data — neither complete nor unknown is honest here');
  });

  it('NEGATIVE CONTROL: a fully-recorded, fully-priced incomplete snapshot is unaffected — unrecordedSnapshotCount stays 0', () => {
    const v = incompleteSpend([{ snapshotId: 's1', complete: false, armRuns: [{ armId: 'opus', costUsd: 3, costStatus: 'priced' }] }]);
    assert.equal(v.unrecordedSnapshotCount, 0);
    assert.equal(v.incompleteSpendUsd, 3);
    assert.equal(v.monetaryStatus, 'complete');
  });

  it('NEGATIVE CONTROL: zero incomplete snapshots still carries unrecordedSnapshotCount: 0 on the empty-state return', () => {
    const v = incompleteSpend([{ snapshotId: 's1', complete: true, armRuns: [{ armId: 'opus', costUsd: 1, costStatus: 'priced' }] }]);
    assert.equal(v.unrecordedSnapshotCount, 0);
  });
});

describe('comparison/spend — armBudgetStop is a POST-HOC stop, not a cap', () => {
  it('no budget declared: never stops', () => {
    assert.deepEqual(armBudgetStop({ spendSoFarUsd: 999, budgetUsdPerArm: null }), { stop: false, reason: null, remainingUsd: null });
  });

  it('stops AT the budget, not only strictly over it', () => {
    const r = armBudgetStop({ spendSoFarUsd: 10, budgetUsdPerArm: 10 });
    assert.equal(r.stop, true);
    assert.equal(r.reason, 'budget-exhausted');
    assert.equal(r.remainingUsd, 0);
  });

  it('reports remaining budget while under it', () => {
    const r = armBudgetStop({ spendSoFarUsd: 3, budgetUsdPerArm: 10 });
    assert.equal(r.stop, false);
    assert.equal(r.remainingUsd, 7);
  });

  it('an unenforceable (unpriced) route stops rather than spending under an unmeasurable ceiling', () => {
    const r = armBudgetStop({ spendSoFarUsd: 5, budgetUsdPerArm: 10, costEvidence: 'unknown' });
    assert.equal(r.stop, true);
    assert.equal(r.reason, 'budget-unenforceable-unpriced');
  });

  it('NEGATIVE CONTROL: an arm just under budget must not stop', () => {
    // The direction that must not fire: a guard eager enough to false-stop a
    // legitimate arm is as damaging to the comparison as one that never fires.
    assert.equal(armBudgetStop({ spendSoFarUsd: 9.999999, budgetUsdPerArm: 10 }).stop, false);
  });

  // Cluster B fix-gate: `NaN == null` is false, so a malformed budget did not
  // hit the "no budget declared" early return; and every comparison against
  // NaN is false, so `spendSoFarUsd >= NaN` never fired either — the function
  // fell all the way through to the "still under budget" success path with a
  // ceiling that could not be measured, reporting an unenforceable guard as an
  // enforced one. Confirmed live before the fix: `remainingUsd` came back as
  // literal `NaN`, invisible in a naive `JSON.stringify` (which serializes
  // NaN as `null`) — a second reason this needed a dedicated assertion rather
  // than eyeballing a console.log.
  it('THE HEADLINE CASE: a NaN budget stops rather than silently passing as "under budget"', () => {
    const r = armBudgetStop({ spendSoFarUsd: 5, budgetUsdPerArm: Number.NaN });
    assert.equal(r.stop, true);
    assert.equal(r.reason, 'budget-unenforceable-invalid-budget');
    assert.equal(r.remainingUsd, null, 'never NaN — NaN is a value that leaks through JSON as null and reads as "unknown", not "no limit"');
  });

  it('an Infinity or negative budget is equally unenforceable and stops', () => {
    assert.equal(armBudgetStop({ spendSoFarUsd: 5, budgetUsdPerArm: Infinity }).stop, true);
    assert.equal(armBudgetStop({ spendSoFarUsd: 5, budgetUsdPerArm: -10 }).stop, true);
  });

  it('NEGATIVE CONTROL: a well-formed positive budget is NOT flagged as invalid', () => {
    // Proves the finite/non-negative check above does not accidentally widen
    // to reject legitimate values.
    assert.equal(armBudgetStop({ spendSoFarUsd: 5, budgetUsdPerArm: 10 }).stop, false);
    assert.equal(armBudgetStop({ spendSoFarUsd: 5, budgetUsdPerArm: 0 }).stop, true, 'a zero budget with any spend is exhausted, not invalid — reason must say so');
    assert.equal(armBudgetStop({ spendSoFarUsd: 5, budgetUsdPerArm: 0 }).reason, 'budget-exhausted');
  });

  it('a NEGATIVE spend-so-far stops rather than reading as extra headroom (Cluster B fix-gate, round 2)', () => {
    // budgetUsdPerArm - (-5) computes as MORE remaining, not less — the wrong
    // direction for a guard whose entire job is to stop spending sooner.
    const r = armBudgetStop({ spendSoFarUsd: -5, budgetUsdPerArm: 10 });
    assert.equal(r.stop, true);
    assert.equal(r.reason, 'budget-unenforceable-invalid-spend');
    assert.notEqual(r.remainingUsd, 15, 'must never report MORE headroom than the declared budget');
  });
});

describe('comparison/cost — evaluateCost consumes booleans, never the floor', () => {
  it('floor-before-cost: a cleared:false arm is never selectable, however cheap', () => {
    const r = evaluateCost({
      clearedFloor: { cheap: false, opus: true },
      spendUsd: { cheap: 0.01, opus: 5 },
      acceptedUnits: { cheap: 10, opus: 6 },
    });
    assert.deepEqual(r.selectable, ['opus'], 'the arm that failed its own floor must not win on price');
  });

  it('an unpriced arm is never selectable and costPerAccepted is null', () => {
    const r = evaluateCost({
      clearedFloor: { a: true },
      spendUsd: { a: null },
      acceptedUnits: { a: 5 },
    });
    assert.equal(r.perArm.a.costPerAccepted, null);
    assert.deepEqual(r.selectable, []);
    assert.equal(r.evidence, 'unknown');
  });

  it('zero accepted units yields null, never Infinity', () => {
    const r = evaluateCost({
      clearedFloor: { a: true },
      spendUsd: { a: 5 },
      acceptedUnits: { a: 0 },
    });
    assert.equal(r.perArm.a.costPerAccepted, null);
    assert.notEqual(r.perArm.a.costPerAccepted, Infinity);
  });

  it('NEGATIVE CONTROL: zero-accepted must not read as an infinitely cheap winner either', () => {
    // A naive `spend / accepted` with accepted=0 in JS gives Infinity for a
    // positive spend, not a small number — but a careless "0 cost when nothing
    // accepted" rewrite is the failure mode worth pinning explicitly.
    const r = evaluateCost({ clearedFloor: { a: true }, spendUsd: { a: 5 }, acceptedUnits: { a: 0 } });
    assert.notEqual(r.perArm.a.costPerAccepted, 0);
  });

  it('a ceiling excludes an over-cost arm from selectable, even with a cleared floor', () => {
    const r = evaluateCost({
      clearedFloor: { pricey: true, cheap: true },
      spendUsd: { pricey: 100, cheap: 1 },
      acceptedUnits: { pricey: 10, cheap: 10 },
      ceilingUsdPerAccepted: 5,
    });
    assert.equal(r.perArm.pricey.withinCeiling, false);
    assert.deepEqual(r.selectable, ['cheap']);
  });

  it('no ceiling declared: withinCeiling is null (unconstrained), not true', () => {
    const r = evaluateCost({ clearedFloor: { a: true }, spendUsd: { a: 5 }, acceptedUnits: { a: 1 } });
    assert.equal(r.perArm.a.withinCeiling, null, 'unconstrained must not be conflated with verified-within');
  });

  it('evidence is partial when some cleared arms are priced and others are not', () => {
    const r = evaluateCost({
      clearedFloor: { a: true, b: true },
      spendUsd: { a: 5, b: null },
      acceptedUnits: { a: 1, b: 1 },
    });
    assert.equal(r.evidence, 'partial');
  });

  // Cluster B fix-gate, round 2 (raised independently in two review rounds):
  // "unknown cost must not select a winner" (D2b) was satisfied per-arm only
  // — arm `a` above never itself won on unknown cost — but the COMPARISON as
  // a whole could still resolve a winner from whichever arms happened to be
  // priced, which is a weaker claim than a caller reading a non-empty
  // `selectable` back would assume.
  it("THE HEADLINE CASE: selectable is EMPTY by default whenever evidence is partial, even though arm 'a' itself is priced and clears its ceiling", () => {
    const r = evaluateCost({
      clearedFloor: { a: true, b: true },
      spendUsd: { a: 5, b: null },
      acceptedUnits: { a: 1, b: 1 },
    });
    assert.equal(r.evidence, 'partial');
    assert.deepEqual(r.selectable, [], 'a decision made from partial evidence must not present a winner by default');
  });

  it('allowPartialEvidence:true opts back into the old per-arm behavior, explicitly', () => {
    const r = evaluateCost({
      clearedFloor: { a: true, b: true },
      spendUsd: { a: 5, b: null },
      acceptedUnits: { a: 1, b: 1 },
      allowPartialEvidence: true,
    });
    assert.deepEqual(r.selectable, ['a'], 'the opt-in restores exactly the arms that ARE priced and clear their floor');
  });

  it('NEGATIVE CONTROL: complete evidence is unaffected by the new default — selectable is populated either way', () => {
    const args = { clearedFloor: { a: true }, spendUsd: { a: 5 }, acceptedUnits: { a: 1 } };
    assert.deepEqual(evaluateCost(args).selectable, ['a']);
    assert.deepEqual(evaluateCost({ ...args, allowPartialEvidence: true }).selectable, ['a']);
  });

  // Cluster B fix-gate: the arm universe used to be derived SOLELY from
  // Object.keys(clearedFloor), so an arm named only in spendUsd/acceptedUnits
  // (a caller bug — every scored arm should appear in all three) vanished
  // from the result with no trace, rather than being reported as an arm that
  // never cleared its floor.
  it("THE HEADLINE CASE: an arm present only in spendUsd/acceptedUnits is still reported, with clearedFloor:false", () => {
    const r = evaluateCost({
      clearedFloor: { a: true },
      spendUsd: { a: 5, ghost: 1 },
      acceptedUnits: { a: 1, ghost: 1 },
    });
    assert.ok('ghost' in r.perArm, 'comparison evidence supplied by the caller must never silently disappear');
    assert.equal(r.perArm.ghost.clearedFloor, false, 'an arm absent from clearedFloor cannot have cleared it');
    assert.ok(!r.selectable.includes('ghost'), 'unable to clear a floor it was never asserted to clear');
  });

  it('NEGATIVE CONTROL: an arm present in ALL three inputs is unaffected by the union change', () => {
    const r = evaluateCost({
      clearedFloor: { a: true },
      spendUsd: { a: 5 },
      acceptedUnits: { a: 1 },
    });
    assert.deepEqual(Object.keys(r.perArm), ['a']);
  });

  it('a non-finite acceptedUnits count (Infinity, NaN) is treated as 0, never as a division-by-huge-number "cheap" arm', () => {
    // spend / Infinity ≈ 0 in raw JS arithmetic — exactly the wrong-direction
    // failure for a COST comparison: a corrupted count would look like the
    // cheapest, most attractive arm instead of an unusable measurement.
    const r = evaluateCost({ clearedFloor: { a: true }, spendUsd: { a: 5 }, acceptedUnits: { a: Infinity } });
    assert.equal(r.perArm.a.acceptedUnits, 0);
    assert.equal(r.perArm.a.costPerAccepted, null, 'zero accepted units is null, never a suspiciously cheap number');
    assert.ok(!r.selectable.includes('a'));
  });

  it('a negative acceptedUnits count is also treated as 0, not as a sign-flipped cost', () => {
    const r = evaluateCost({ clearedFloor: { a: true }, spendUsd: { a: 5 }, acceptedUnits: { a: -3 } });
    assert.equal(r.perArm.a.acceptedUnits, 0);
  });

  it('THE HEADLINE CASE: a NEGATIVE spend is not "priced" — it must not read as the cheapest, most attractive arm (Cluster B fix-gate, round 2)', () => {
    // A negative costPerAccepted is <= any positive ceiling by construction,
    // so treating it as priced would make a corrupted value ALWAYS win the
    // comparison — the wrong-direction failure this seam exists to prevent.
    const r = evaluateCost({
      clearedFloor: { corrupted: true, honest: true },
      spendUsd: { corrupted: -100, honest: 5 },
      acceptedUnits: { corrupted: 1, honest: 1 },
    });
    assert.equal(r.perArm.corrupted.spendUsd, null, 'negative spend must read as unpriced, not as a real (negative) cost');
    assert.equal(r.perArm.corrupted.costPerAccepted, null);
    assert.ok(!r.selectable.includes('corrupted'), 'a negative-cost arm must never be selectable, however cheap it LOOKS');
  });

  it("THE HEADLINE CASE: an arm named '__proto__' gets a real entry, not a hijacked perArm prototype (Cluster B fix-gate, round 3)", () => {
    // Unlike armSpend's read-then-assign pattern, evaluateCost's perArm[armId]
    // = {...} is a DIRECT assignment — verified this safely shadows an
    // inherited property like `constructor`. But `__proto__` is not an
    // ordinary inherited property: it is a SETTER on Object.prototype that
    // bracket-notation assignment invokes exactly like dot notation does, so
    // `perArm['__proto__'] = {...}` changes perArm's OWN prototype instead of
    // creating an entry — silently dropping that arm from every subsequent
    // Object.keys(perArm)/lookup.
    const clearedFloor = {}; Object.defineProperty(clearedFloor, '__proto__', { value: true, enumerable: true, configurable: true });
    const r = evaluateCost({
      clearedFloor,
      spendUsd: { a: 1 }, // any real key, just so armIds is non-empty via the union
      acceptedUnits: {},
    });
    // The definitive proof: perArm was built with Object.create(null), so its
    // OWN prototype stays null no matter what key was assigned to it —
    // confirming `__proto__` never reached the special setter.
    assert.equal(Object.getPrototypeOf(r.perArm), null, "perArm's own prototype must be untouched by an arm named __proto__");
  });

  it('a non-finite or negative ceilingUsdPerAccepted is treated as no ceiling, never as "everything passes" (Cluster B fix-gate, round 3)', () => {
    // costPerAccepted <= Infinity is true for every finite cost, so an
    // Infinity ceiling made withinCeiling read `true` — CLAIMING a real limit
    // was checked and confirmed, when no limit constrained anything.
    const args = { clearedFloor: { a: true }, spendUsd: { a: 100 }, acceptedUnits: { a: 1 } };
    for (const badCeiling of [Infinity, Number.NaN, -5]) {
      const r = evaluateCost({ ...args, ceilingUsdPerAccepted: badCeiling });
      assert.equal(r.perArm.a.withinCeiling, null, `ceiling=${badCeiling}: must read as unconstrained (null), not as a passed check`);
    }
  });

  it('NEGATIVE CONTROL: a well-formed ceiling still works exactly as before', () => {
    const args = { clearedFloor: { a: true }, spendUsd: { a: 100 }, acceptedUnits: { a: 1 } };
    assert.equal(evaluateCost({ ...args, ceilingUsdPerAccepted: 200 }).perArm.a.withinCeiling, true);
    assert.equal(evaluateCost({ ...args, ceilingUsdPerAccepted: 50 }).perArm.a.withinCeiling, false);
  });

  // Cluster B fix-gate (R5) — withinCeiling must compare the RAW quotient,
  // not the round6'd display figure: a cost up to $0.0000005 over the
  // ceiling used to round DOWN to exactly the ceiling and read as within it.
  it('a cost just over the ceiling that would round DOWN to it at 6dp is still rejected', () => {
    const ceiling = 10;
    const spend = 10.0000004 * 3; // raw quotient 10.0000004 — rounds to 10.000000 (== ceiling) at 6dp
    const r = evaluateCost({ clearedFloor: { a: true }, spendUsd: { a: spend }, acceptedUnits: { a: 3 }, ceilingUsdPerAccepted: ceiling });
    assert.equal(r.perArm.a.costPerAccepted, 10, 'the REPORTED figure still rounds to the ceiling — this is a display fact, not what gates selection');
    assert.equal(r.perArm.a.withinCeiling, false, 'the raw cost is genuinely over the ceiling and must not read as within it');
    assert.deepEqual(r.selectable, []);
  });

  it('NEGATIVE CONTROL: a cost genuinely at or under the ceiling still selects', () => {
    const r = evaluateCost({ clearedFloor: { a: true }, spendUsd: { a: 30 }, acceptedUnits: { a: 3 }, ceilingUsdPerAccepted: 10 });
    assert.equal(r.perArm.a.withinCeiling, true);
    assert.deepEqual(r.selectable, ['a']);
  });
});
