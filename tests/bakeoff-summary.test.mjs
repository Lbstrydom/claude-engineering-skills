/**
 * @fileoverview `summarise` + its building blocks (isComplete, zeroFindingArms,
 * armCostUsd, distinctFindingCount, shadowFindingTotal) — D1's `ResolvedScope`
 * threading, D1c's derived-set invariant, D6's no-silent-zero contract.
 *
 * Split out of `final-review-bakeoff.test.mjs` (Phase 1, plan:
 * comparison-tooling-consolidation.md); extended for D1c/D6 in Phase 1′
 * (same commit range — Cluster A′ runs alongside Cluster A).
 *
 * @module tests/bakeoff-summary
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  zeroFindingArms, isComplete, summarise,
  distinctFindingCount, shadowFindingTotal, armCostUsd,
} from '../scripts/lib/bakeoff/summary.mjs';
import { CONTRACT_EPOCH } from '../scripts/lib/bakeoff/log.mjs';
import { createResolvedScope } from '../scripts/lib/bakeoff/scope.mjs';

// Shared 3-arm fixture (opus/kimi shadow + solo-opus primary) mirroring the
// live `final-review-2026q3` campaign shape — the arm ids these tests were
// originally written against.
const SCOPE_NULL = createResolvedScope('c', [
  { id: 'opus', model: 'm' }, { id: 'kimi', model: 'm' }, { id: 'solo-opus', model: 'm', solo: true },
], null);
const SCOPE_THIN = createResolvedScope('c', [
  { id: 'opus', model: 'm' }, { id: 'kimi', model: 'm' }, { id: 'solo-opus', model: 'm', solo: true },
], 'thin');

describe('zeroFindingArms (bakeoff-collect)', () => {
  const armEntry = (over) => ({ shadowState: 'ran', buckets: { shadowOnly: 0 }, ...over });

  it('an arm with findings is never listed — this is about ZEROES only', () => {
    const e = { arms: { opus: armEntry({ buckets: { shadowOnly: 4 }, shadowVerdict: 'APPROVE' }), kimi: armEntry({ shadowVerdict: 'APPROVE' }) } };
    assert.deepEqual(zeroFindingArms(e, SCOPE_NULL).map((z) => z.arm), ['kimi']);
  });

  it('zero findings WITH a verdict reads as reviewed — a lenient model, not a broken arm', () => {
    const e = { arms: { opus: armEntry({ buckets: { shadowOnly: 1 } }), kimi: armEntry({ shadowVerdict: 'APPROVE' }) } };
    assert.deepEqual(zeroFindingArms(e, SCOPE_NULL), [{ arm: 'kimi', verdict: 'APPROVE', evidence: 'reviewed' }]);
  });

  it('zero findings with a RECORDED-but-empty verdict reads as no-verdict — suspect the arm', () => {
    const e = { arms: { kimi: armEntry({ shadowVerdict: null }) } };
    assert.deepEqual(zeroFindingArms(e, SCOPE_NULL), [{ arm: 'kimi', verdict: null, evidence: 'no-verdict' }]);
  });

  it('an ABSENT shadowVerdict key is `unrecorded`, NOT `no-verdict`', () => {
    // The campaign's own first three snapshots predate the field. Collapsing
    // absent into null would report them as broken arms and invite a re-run of
    // three snapshots that were fine.
    const e = { arms: { kimi: armEntry({}) } };
    assert.deepEqual(zeroFindingArms(e, SCOPE_NULL), [{ arm: 'kimi', verdict: undefined, evidence: 'unrecorded' }]);
  });

  it('an arm that did not RUN is not a zero-finding arm at all', () => {
    const e = { arms: { kimi: { shadowState: 'skipped-no-key', buckets: null } } };
    assert.deepEqual(zeroFindingArms(e, SCOPE_NULL), []);
  });
});

describe('contract epoch + solo arm (bakeoff-collect isComplete)', () => {
  // `SCOPE_NULL` (expectedScope: null) on every call in THIS block,
  // explicitly — these tests are about epoch + solo-arm logic, orthogonal to
  // scope-binding (which has its own dedicated block below).
  const ran = (over) => ({ shadowState: 'ran', buckets: { shadowOnly: 1 }, primaryVerdict: 'CONCERNS', ...over });
  const full = (over = {}) => ({
    contractEpoch: CONTRACT_EPOCH,
    arms: { opus: ran(), kimi: ran(), 'solo-opus': { primaryVerdict: 'APPROVE' }, ...over },
  });
  const complete = (e) => isComplete(e, SCOPE_NULL);

  it('a fully-populated current-epoch snapshot counts', () => {
    assert.equal(complete(full()), true);
  });

  it('an UNSTAMPED entry never counts, however complete it looks', () => {
    // The e1 rows are exactly this shape. Counting them would compare arms that
    // ran at three different reasoning depths and call it a model result.
    const e = full();
    delete e.contractEpoch;
    assert.equal(complete(e), false);
  });

  it('a STALE epoch never counts — and is not silently upgraded', () => {
    assert.equal(complete({ ...full(), contractEpoch: 'e1-unmatched' }), false);
  });

  it('the solo arm is judged on its primary verdict, not on shadowState', () => {
    // It runs Opus as primary with no shadow; requiring shadowState==='ran'
    // would make every snapshot permanently incomplete.
    assert.equal(complete(full({ 'solo-opus': { primaryVerdict: 'REJECT', shadowState: null } })), true);
    assert.equal(complete(full({ 'solo-opus': { primaryVerdict: null } })), false);
  });

  it('an arm that ERRORED fails the snapshot even under the right epoch', () => {
    assert.equal(complete(full({ kimi: { error: 'exit 1' } })), false);
  });

  it('a missing arm fails the snapshot — absence is never treated as a pass', () => {
    const e = full();
    delete e.arms.kimi;
    assert.equal(complete(e), false);
  });

  it('the solo arm is excluded from zero-finding reporting (it has no shadow bucket)', () => {
    const z = zeroFindingArms(full({ opus: ran({ buckets: { shadowOnly: 0 }, shadowVerdict: 'APPROVE' }) }), SCOPE_NULL);
    assert.deepEqual(z.map((x) => x.arm), ['opus']);
  });
});

describe('isComplete — scope-binding eligibility (plan KD-6)', () => {
  // Same three-arm shape as above, but now WITH shadowScope, since these
  // tests are specifically about the scope check the previous block
  // deliberately disables.
  const ran = (scope, over) => ({ shadowState: 'ran', buckets: { shadowOnly: 1 }, primaryVerdict: 'CONCERNS', shadowScope: scope, ...over });
  const full = (opusScope, kimiScope, over = {}) => ({
    contractEpoch: CONTRACT_EPOCH,
    arms: { opus: ran(opusScope), kimi: ran(kimiScope), 'solo-opus': { primaryVerdict: 'APPROVE' }, ...over },
  });

  it('every shadow arm matching the expected scope counts', () => {
    assert.equal(isComplete(full('thin', 'thin'), SCOPE_THIN), true);
  });

  it('a MISMATCHED shadow arm makes the snapshot ineligible', () => {
    // One arm ran under a different envelope than the manifest declares —
    // exactly the mixed-cohort case KD-6 exists to make structurally
    // impossible rather than merely discouraged.
    assert.equal(isComplete(full('thin', 'full'), SCOPE_THIN), false);
  });

  it('expectedScope null (no campaign / legacy fallback) skips the check entirely', () => {
    // Both directions matter: this must NOT reject a scope-less entry when
    // nothing declared a scope to bind against.
    assert.equal(isComplete(full('thin', 'full'), SCOPE_NULL), true);
  });

  it("the PRIMARY (solo) arm is NEVER checked for shadowScope — it has none", () => {
    // The bug this regression-guards: a check quantified over ALL arms
    // (`arms.every`) would compare the solo arm's `undefined` shadowScope
    // against the expected value and mark the snapshot ineligible even when
    // every REAL shadow arm matches — bricking every snapshot in any cohort
    // that includes a primary replicate, permanently, the moment one exists.
    const e = full('thin', 'thin', { 'solo-opus': { primaryVerdict: 'APPROVE' } }); // no shadowScope key at all
    assert.equal(isComplete(e, SCOPE_THIN), true);
  });

  it('an entry that PREDATES the scope field (shadowScope absent) does not match a declared scope', () => {
    const e = full('thin', 'thin');
    delete e.arms.kimi.shadowScope;
    assert.equal(isComplete(e, SCOPE_THIN), false);
  });
});

describe('counting rules shared by the two Opus samples', () => {
  it('distinctFindingCount dedups by _hash, so a primary is counted the shadow’s way', () => {
    // The shadow is deduped before bucketing; the primary is written raw.
    // Comparing the two un-normalised reports a dedup difference as model variance.
    assert.equal(distinctFindingCount([{ _hash: 'a' }, { _hash: 'b' }, { _hash: 'a' }]), 2);
  });

  it('an UNHASHED finding is never collapsed away', () => {
    // Same rule as dedupByHash's semanticId fallback: silent data loss here
    // would understate a reviewer's output and read as agreement.
    assert.equal(distinctFindingCount([{}, {}, {}]), 3);
  });

  it('absent / non-array findings are 0, not a throw', () => {
    for (const v of [null, undefined, 'nope']) assert.equal(distinctFindingCount(v), 0);
  });

  it('shadowFindingTotal is both + shadowOnly — the shadow’s whole deduped set', () => {
    assert.equal(shadowFindingTotal({ buckets: { both: 2, shadowOnly: 5, primaryOnly: 9 } }), 7);
  });

  it('a shadow that did not run is null, NEVER 0', () => {
    // 0 would mean "reviewed and found nothing"; null means "no measurement".
    // Collapsing them is the anti-green failure this campaign already hit.
    for (const v of [{ buckets: null }, {}, null, undefined, { buckets: { both: 1 } }]) {
      assert.equal(shadowFindingTotal(v), null);
    }
  });
});

describe('armCostUsd — spend is measured, never partially guessed', () => {
  const opusCall = { _model: 'claude-opus-5', _usage: { input_tokens: 1_000_000, output_tokens: 0 } };

  it('sums the primary and shadow calls an arm makes', () => {
    const both = armCostUsd({
      ...opusCall,
      _shadow: { model: 'claude-opus-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    });
    const one = armCostUsd(opusCall);
    assert.equal(both.usd, one.usd * 2);
  });

  it('prices cached tokens rather than reading a cache hit as free', () => {
    const hit = armCostUsd({ _model: 'claude-opus-5', _usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 } });
    assert.ok(hit.usd > 0);
  });

  it('an UNPRICED call yields null for the arm, not a partial sum', () => {
    // A partial sum is worse than none: it reads as a complete figure, and the
    // arm silently looks cheaper than every arm it is compared against.
    const r = armCostUsd({ ...opusCall, _shadow: { model: 'not-a-real-model-xyz', usage: { input_tokens: 1000, output_tokens: 1 } } });
    assert.equal(r.usd, null);
    assert.deepEqual(r.unpricedModels, ['not-a-real-model-xyz']);
  });

  it('an arm with no usage at all is null, never 0', () => {
    assert.equal(armCostUsd({}).usd, null);
    assert.equal(armCostUsd({ _model: 'claude-opus-5' }).usd, null, 'a model with no usage is not a free call');
  });

  it('a PARTIALLY-metered arm is null, not a confident subtotal (audit R1 H2)', () => {
    // The discriminating case the two tests above miss: the primary call is
    // fully metered, so `calls` is non-empty and a total gets computed — while
    // the shadow call, which really happened, was dropped by the old
    // `c.model && c.usage` filter before pricing. The arm then published the
    // primary's cost as if it were the whole spend.
    for (const [label, shadow] of [
      ['no usage key', { model: 'claude-opus-5' }],
      ['empty usage', { model: 'claude-opus-5', usage: {} }],
      ['one-sided usage', { model: 'claude-opus-5', usage: { input_tokens: 1000 } }],
    ]) {
      const r = armCostUsd({ ...opusCall, _shadow: shadow });
      assert.equal(r.usd, null, `${label}: an unmeterable shadow call must void the arm total`);
      assert.deepEqual(r.unpricedModels, ['claude-opus-5'], `${label}: the unmeterable call is named`);
    }
    // a fully-metered shadow is still summed normally
    assert.ok(armCostUsd({ ...opusCall, _shadow: { model: 'claude-opus-5', usage: { input_tokens: 1000, output_tokens: 1 } } }).usd > 0);
  });
});

describe('summarise surfaces every arm (bakeoff-collect)', () => {
  const ran = (shadowOnly, primaryFindings) => ({
    shadowState: 'ran', shadowVerdict: 'CONCERNS', buckets: { shadowOnly }, primaryVerdict: 'CONCERNS', primaryFindings,
  });
  const snap = (id, opusUnique, kimiUnique, p1, p2, solo) => ({
    snapshotId: id, contractEpoch: CONTRACT_EPOCH,
    arms: { opus: ran(opusUnique, p1), kimi: ran(kimiUnique, p2), 'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: solo } },
  });

  it('the solo arm contributes its PRIMARY findings, never a shadow bucket it does not have', () => {
    const s = summarise([snap('a', 7, 1, 2, 4, 7)], 12, SCOPE_NULL);
    assert.equal(s.totals.soloFindings, 7);
    assert.equal(s.totals.opusUnique, 7);
    assert.equal(s.totals.kimiUnique, 1);
    // The generic maps behind the legacy flat fields (D1c) — a measured value
    // carries observationCount + unpairedCount, never a bare number.
    assert.deepEqual(s.totals.uniqueByArm.opus, { status: 'measured', value: 7, observationCount: 1, unpairedCount: 0 });
    assert.deepEqual(s.totals.soloFindingsByArm['solo-opus'], { status: 'measured', value: 7, observationCount: 1, unpairedCount: 0 });
  });

  it('primary self-divergence is an AggregateResult, generalised over non-solo arms (D6)', () => {
    // Same primary model, same transcript, two runs. This is §0.4's
    // "is a 2nd reviewer just a reroll?" question, and it is free to collect.
    const s = summarise([snap('a', 7, 1, 2, 4, 7), snap('b', 3, 2, 5, 5, 3)], 12, SCOPE_NULL);
    assert.equal(s.totals.primaryDivergence.status, 'measured');
    assert.equal(s.totals.primaryDivergence.value, 1, 'mean of [2, 0]');
    assert.equal(s.totals.primaryDivergence.max, 2);
    assert.equal(s.totals.primaryDivergence.observationCount, 2);
    assert.equal(s.totals.primaryDivergence.unpairedCount, 0);
  });

  it('primary self-divergence NEVER fabricates a 0 sample when fewer than 2 non-solo arms report (D6, the actual incident)', () => {
    // The measured incident: a campaign whose declared arms don't include a
    // pair that both report `primaryFindings` for a snapshot used to push a
    // silent `Math.abs(0 - 0)` sample — reading as "mean 0.0, max 0", the
    // strongest possible agreement claim, manufactured from nothing measured.
    const oneArmOnly = createResolvedScope('c', [{ id: 'solo-x', model: 'm', solo: true }], null);
    const e = {
      snapshotId: 'a', contractEpoch: CONTRACT_EPOCH,
      arms: { 'solo-x': { primaryVerdict: 'CONCERNS', primaryFindings: 3 } },
    };
    const s = summarise([e], 12, oneArmOnly);
    assert.equal(s.totals.primaryDivergence.status, 'unknown');
    assert.equal(s.totals.primaryDivergence.observationCount, 0);
    assert.equal(s.totals.primaryDivergence.unpairedCount, 1);
    assert.match(s.totals.primaryDivergence.reason, /non-solo/);
  });

  it('Opus self-divergence pairs the shadow sample against the solo sample', () => {
    // Both arms issue a byte-identical request, so the spread is Opus's own
    // variance — the number that decides whether solo-opus buys a role
    // comparison or a reroll.
    const e = {
      snapshotId: 'a', contractEpoch: CONTRACT_EPOCH,
      arms: {
        opus: { ...ran(5, 2), buckets: { both: 0, shadowOnly: 5 } },
        kimi: ran(1, 2),
        'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: 4, primaryDistinct: 4 },
      },
    };
    assert.deepEqual(summarise([e], 12, SCOPE_NULL).totals.opusDivergence, [1]);
    assert.equal(summarise([e], 12, SCOPE_NULL).totals.opusDivergenceUnpaired, 0);
  });

  it('a missing Opus sample is UNPAIRED, never scored as zero divergence', () => {
    // Zero would assert Opus agreed with itself perfectly — the strongest claim
    // available, from the one state that cannot support any claim. Entries
    // predating `primaryDistinct` land here, which is why it is counted and
    // printed rather than silently dropped.
    const e = {
      snapshotId: 'a', contractEpoch: CONTRACT_EPOCH,
      arms: {
        opus: { ...ran(5, 2), buckets: { both: 0, shadowOnly: 5 } },
        kimi: ran(1, 2),
        'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: 4 }, // no primaryDistinct
      },
    };
    const s = summarise([e], 12, SCOPE_NULL);
    assert.deepEqual(s.totals.opusDivergence, []);
    assert.equal(s.totals.opusDivergenceUnpaired, 1);
  });

  it('arms sharing a request fingerprint are reported as a REROLL, not two configurations', () => {
    // The finding this instrument exists for: `opus` and `solo-opus` issue a
    // byte-identical Anthropic request, so a gap between them is sampling noise
    // plus a bucketing convention. Establishing that once took reading the
    // shadow orchestration and cross-checking token counts across five files.
    const e = {
      snapshotId: 'a', contractEpoch: CONTRACT_EPOCH,
      arms: {
        opus: { ...ran(5, 2), requestFingerprints: ['geminiFP', 'opusFP'] },
        kimi: { ...ran(1, 2), requestFingerprints: ['geminiFP', 'kimiFP'] },
        'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: 4, requestFingerprints: ['opusFP'] },
      },
    };
    const pairs = summarise([e], 12, SCOPE_NULL).totals.rerollPairs;
    assert.ok(pairs.includes('opus=solo-opus'), 'the identical Opus request must be surfaced');
    assert.ok(pairs.includes('opus=kimi'), 'both arms also run the same Gemini primary');
  });

  it('MISSING fingerprints read as unknown, never as "these arms differ"', () => {
    // Entries predating the field must not silently certify that every arm is
    // distinct — the strongest reading available from no evidence at all.
    const e = {
      snapshotId: 'a', contractEpoch: CONTRACT_EPOCH,
      arms: { opus: ran(5, 2), kimi: ran(1, 2), 'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: 4 } },
    };
    assert.deepEqual(summarise([e], 12, SCOPE_NULL).totals.rerollPairs, []);
  });

  it('an arm with an unpriced call makes that ARM null, and flags the snapshot', () => {
    const e = {
      snapshotId: 'a', contractEpoch: CONTRACT_EPOCH,
      arms: {
        opus: { ...ran(5, 2), costUsd: 2.5 },
        kimi: { ...ran(1, 2), costUsd: null },
        'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: 4, costUsd: 2.3 },
      },
    };
    const t = summarise([e], 12, SCOPE_NULL).totals;
    assert.equal(t.costByArm.opus, 2.5);
    assert.equal(t.costByArm.kimi, null, 'an unpriced arm shows null, not the sum of its priced snapshots');
    assert.equal(t.costUncostedSnapshots, 1);
  });

  it('an INCOMPLETE snapshot contributes to no total — not even a partial one', () => {
    const bad = snap('c', 9, 9, 9, 9, 9);
    delete bad.contractEpoch; // stale-epoch row
    const s = summarise([bad], 12, SCOPE_NULL);
    assert.equal(s.complete, 0);
    assert.equal(s.totals.opusUnique, 0);
    assert.equal(s.totals.soloFindings, 0);
    assert.equal(s.totals.primaryDivergence.status, 'unknown', 'zero complete snapshots ⇒ unknown, never an empty-array 0.0');
  });
});

// ── D1c/D6 — the derived-set invariant + no-silent-zero, disjoint per-n ─────
//
// Three DISJOINT fixtures (round-3 gate, M1) — never one formula stretched
// across n, which required `arm[n-1]` to play two contradictory roles at n=2.

describe('D1c/D6 — the derived-set invariant is exact, and a metric with no measurement is `unknown`, never `0`', () => {
  it('n=1: a single declared arm, no off-by-one on a 1-element set', () => {
    // `n=1` is included on purpose (AGENTS.md architectural-memory note in this
    // plan): `checkArmSetSemantics` requires >=2 SCORED arms for a real
    // campaign, but this is a legal input to the pure tally arithmetic, and it
    // is the case where an `arms[0]`/`arms[1]` assumption shows up.
    const scope = createResolvedScope('c', [{ id: 'a0', model: 'm' }], null);
    const entries = [{
      snapshotId: 's1', contractEpoch: CONTRACT_EPOCH,
      arms: { a0: { shadowState: 'ran', buckets: { shadowOnly: 5 }, primaryFindings: 1, costUsd: 1 } },
    }];
    const s = summarise(entries, 12, scope);
    assert.deepEqual(Object.keys(s.totals.uniqueByArm), ['a0']);
    assert.deepEqual(s.totals.uniqueByArm.a0, { status: 'measured', value: 5, observationCount: 1, unpairedCount: 0 });
  });

  it('n=2: one measured-nonzero, one measured-ZERO — a real zero, distinct from unknown', () => {
    const scope = createResolvedScope('c', [{ id: 'a0', model: 'm' }, { id: 'a1', model: 'm' }], null);
    const entries = [{
      snapshotId: 's1', contractEpoch: CONTRACT_EPOCH,
      arms: {
        a0: { shadowState: 'ran', buckets: { shadowOnly: 5 }, primaryFindings: 1, costUsd: 1 },
        a1: { shadowState: 'ran', buckets: { shadowOnly: 0 }, primaryFindings: 1, costUsd: 0 },
      },
    }];
    const s = summarise(entries, 12, scope);
    assert.deepEqual(Object.keys(s.totals.uniqueByArm).sort(), ['a0', 'a1']);
    assert.deepEqual(s.totals.uniqueByArm.a0, { status: 'measured', value: 5, observationCount: 1, unpairedCount: 0 });
    assert.deepEqual(s.totals.uniqueByArm.a1, { status: 'measured', value: 0, observationCount: 1, unpairedCount: 0 },
      'a MEASURED zero — the arm ran and genuinely found nothing, not "no data"');
  });

  it('n=6: the exact key set holds at a realistic arm count, with distinguishable per-arm values', () => {
    // All six declared arms RAN in this snapshot (isComplete's AND-gate over
    // `scope.arms` requires exactly that for any entry to count at all — see
    // the note below), so this establishes the key-set-exactness + measured-
    // zero-vs-nonzero halves of the invariant at the live campaign's own arm
    // count. `a5`'s own value is deliberately 0 (a measured zero, not unknown)
    // — see the next test for the genuinely-never-ran case.
    const scope = createResolvedScope(
      'c', ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'].map((id) => ({ id, model: 'm' })), null,
    );
    const values = { a0: 9, a1: 0, a2: 3, a3: 4, a4: 2, a5: 0 };
    const entries = [{
      snapshotId: 's1', contractEpoch: CONTRACT_EPOCH,
      arms: Object.fromEntries(Object.entries(values).map(([id, v]) => [
        id, { shadowState: 'ran', buckets: { shadowOnly: v }, primaryFindings: 1, costUsd: 1 },
      ])),
    }];
    const s = summarise(entries, 12, scope);
    assert.deepEqual(Object.keys(s.totals.uniqueByArm).sort(), ['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    for (const [id, v] of Object.entries(values)) {
      assert.deepEqual(s.totals.uniqueByArm[id], { status: 'measured', value: v, observationCount: 1, unpairedCount: 0 }, `arm ${id}`);
    }
  });

  it('the invariant holds ABOVE the live campaign\'s own arm count too (n=8) — the loop is arity-generic, not tuned to n=6', () => {
    // Round-4 finding H4: the mandatory fixtures only exercised n ∈ {1, 2, 6},
    // so a campaign larger than any fixture had no direct coverage. The
    // production code has no arm-count branching (every tally is a `for (const
    // a of scope.arms)` loop), so this is not expected to reveal new behaviour
    // — it is the cheap, direct check that the claim is true above n=6, not an
    // argument that it must be.
    const ids = Array.from({ length: 8 }, (_, i) => `a${i}`);
    const scope = createResolvedScope('c', ids.map((id) => ({ id, model: 'm' })), null);
    const values = Object.fromEntries(ids.map((id, i) => [id, i]));
    const entries = [{
      snapshotId: 's1', contractEpoch: CONTRACT_EPOCH,
      arms: Object.fromEntries(ids.map((id) => [
        id, { shadowState: 'ran', buckets: { shadowOnly: values[id] }, primaryFindings: 1, costUsd: 1 },
      ])),
    }];
    const s = summarise(entries, 12, scope);
    assert.deepEqual(Object.keys(s.totals.uniqueByArm).sort(), [...ids].sort());
    for (const id of ids) {
      assert.deepEqual(s.totals.uniqueByArm[id], { status: 'measured', value: values[id], observationCount: 1, unpairedCount: 0 }, `arm ${id}`);
    }
  });

  it('a declared arm that never ran in ANY complete snapshot is `unknown` for the WHOLE scope — never a fabricated 0', () => {
    // Distinct from the n=6 case above: here NO snapshot is complete (one
    // declared arm never ran in any of them), so `complete.length === 0` and
    // every declared arm — not just the missing one — reads `unknown`. This is
    // the honest floor `summarise` can express today: because `isComplete`
    // requires EVERY declared arm to have run within the SAME entry, a
    // declared arm that is measured in some complete snapshots while another
    // is measured in none of them (the plan's literal "5 measured, 1 never
    // seen, one cohort" shape) is a property of the per-arm TALLY step in
    // isolation from completeness-gating — that becomes independently
    // testable once Phase 2 (D2) extracts it into `bakeoff/summary.mjs` as a
    // pure function taking an already-filtered `complete` array; tracked
    // there rather than faked here.
    const scope = createResolvedScope('c', [{ id: 'a0', model: 'm' }, { id: 'a1', model: 'm' }], null);
    const entries = [{
      snapshotId: 's1', contractEpoch: CONTRACT_EPOCH,
      arms: { a0: { shadowState: 'ran', buckets: { shadowOnly: 9 }, primaryFindings: 1, costUsd: 1 } }, // a1 never ran
    }];
    const s = summarise(entries, 12, scope);
    assert.equal(s.complete, 0);
    assert.deepEqual(Object.keys(s.totals.uniqueByArm).sort(), ['a0', 'a1'], 'the key set is exact even when nothing was measured');
    assert.equal(s.totals.uniqueByArm.a0.status, 'unknown');
    assert.equal(s.totals.uniqueByArm.a1.status, 'unknown');
    assert.equal(s.totals.uniqueByArm.a0.observationCount, 0);
    assert.match(s.totals.uniqueByArm.a0.reason, /did not run in any complete snapshot/);
  });

  it('a solo arm that never ran is `unknown` in soloFindingsByArm, not absent from the map', () => {
    const scope = createResolvedScope('c', [
      { id: 'shadow0', model: 'm' }, { id: 'solo0', model: 'm', solo: true },
    ], null);
    // No entries at all — the emptiest possible input.
    const s = summarise([], 12, scope);
    assert.deepEqual(Object.keys(s.totals.soloFindingsByArm), ['solo0']);
    assert.equal(s.totals.soloFindingsByArm.solo0.status, 'unknown');
    assert.deepEqual(Object.keys(s.totals.uniqueByArm), ['shadow0']);
    assert.equal(s.totals.uniqueByArm.shadow0.status, 'unknown');
  });
});
