/**
 * @fileoverview `summarise`, `aggregateMatched`, `zeroFindingArms`,
 * `armCostUsd` — completeness + aggregation + spend (D1 signatures, D2 move).
 *
 * Moved from `scripts/bakeoff-collect.mjs` (plan: comparison-tooling-
 * consolidation.md, Phase 2). **Pure — this is load-bearing** (D2a): it is
 * where both the incident-(c) live defect and the D6 telemetry-honesty
 * defect happened, and a module that spawns nothing and writes nothing can
 * be tested exhaustively without a rig. Per D2a: may import `bakeoff/
 * scope.mjs`, `lib/comparison/spend.mjs`; must NOT import any `scripts/*.mjs`
 * entry point, `bakeoff/arms.mjs`, `bakeoff/spawn.mjs`, or `bakeoff/log.mjs`.
 *
 * **One necessary deviation from verbatim (discovered during Phase 2
 * implementation, same class as `spawn.mjs`'s note).** The original
 * `entriesToSpendSnapshots(entries, declaredArms)` called `isCompleteForEntry
 * (e)` internally — which re-resolves a `ResolvedScope` from the entry's own
 * `campaignId` via `bakeoff/arms.mjs`'s `scopeForEntry`, an import this
 * module is forbidden. Its only caller (`printProgress`) always passes
 * entries already scoped to one campaign (`e.campaignId === scope.
 * campaignId` for every entry), so `isCompleteForEntry(e)` and `isComplete(e,
 * scope)` resolve identically there — re-deriving scope per entry was
 * redundant work, not a different answer. Signature is now
 * `entriesToSpendSnapshots(entries, scope)`, calling `isComplete(e, scope)`
 * directly; no behaviour changes for any real caller.
 *
 * @module scripts/lib/bakeoff/summary
 */
import crypto from 'node:crypto';
import { assertResolvedScope, assertScopeMatches } from './scope.mjs';
import { costFromUsage } from '../model-pricing.mjs';

/** Pre-registered cohort size — see the historical note in the CLI entry
 *  point for why 12 and not lower. Duplicated as a literal default here
 *  (not imported) because `bakeoff/arms.mjs`, which owns campaign config
 *  reads, is off-limits to this module; the entry point always passes its
 *  own resolved `target` explicitly in practice. */
const DEFAULT_TARGET = 12;

/**
 * A snapshot COUNTS only when every arm actually ran. An arm that skipped
 * (`skipped-no-key`, `skipped-azure`, …) or errored leaves the snapshot
 * incomplete — counting it would inflate N with rows that cannot support a
 * uniqueness claim, which is the same "measured nothing, read as data" failure
 * the epoch gate exists to prevent elsewhere.
 */
export function isComplete(entry, scope) {
  assertResolvedScope(scope);
  const { arms, expectedScope } = scope;
  // Duplicated as a literal (not imported) for the SAME reason DEFAULT_TARGET
  // is above — `log.mjs`, which owns CONTRACT_EPOCH, is off-limits to this
  // module per D2a. Not silent drift: tests/bakeoff-summary.test.mjs's
  // `full()` fixture stamps `contractEpoch: CONTRACT_EPOCH` (the real
  // imported constant) on every entry, so if this literal ever falls out of
  // sync with log.mjs's, "a fully-populated current-epoch snapshot counts"
  // fails immediately rather than silently accepting stale entries.
  if (entry?.contractEpoch !== 'e3-scoped-envelope') return false; // unstamped or stale ⇒ ineligible
  const armsRan = arms.every((a) => {
    const r = entry?.arms?.[a.id];
    if (!r || r.error) return false;
    // A solo arm has no shadow, so demanding shadowState==='ran' would make the
    // snapshot permanently incomplete. Its evidence of having run is a verdict.
    return a.solo ? Boolean(r.primaryVerdict) : r.shadowState === 'ran';
  });
  if (!armsRan) return false;
  if (expectedScope === null) return true; // no campaign scope declared — nothing to bind

  // Scope-binding eligibility (plan KD-6, H1's correction): every SHADOW-
  // PRODUCING arm's actual `_shadow.scope` must equal the manifest's declared
  // `controls.envelopeScope`, so a snapshot collected under a different
  // envelope (e.g. before a scope change) cannot silently mix into this
  // cohort.
  //
  // Quantified over `!a.solo` (shadow-producing arms), NEVER `arms` as a
  // whole. An earlier draft of this check used `arms.every`, which is wrong
  // by construction: the campaign schema permits one `mode:"primary"` arm
  // (the committed `final-review-2026q3` cohort has one, `solo-opus`), and a
  // primary arm runs no shadow reviewer at all — it emits no `_shadow` block
  // and therefore has no `shadowScope`. A universally-quantified check would
  // compare `undefined` against the expected scope on that arm and mark
  // EVERY snapshot in the cohort permanently ineligible — a bug that would
  // stay latent for any campaign with no primary arm and detonate the moment
  // one was added (caught in this plan's own audit trail before it shipped).
  return arms.filter((a) => !a.solo).every((a) => entry?.arms?.[a.id]?.shadowScope === expectedScope);
}

/**
 * Did an arm report ZERO findings while genuinely having reviewed?
 *
 * `shadowOnly: 0` is ambiguous on its own. Because cross-model `_hash` matching
 * makes the `both` bucket structurally ~0, a shadow that agreed with the primary
 * and a shadow that produced nothing at all BOTH read as `shadowOnly: 0`. The
 * distinguishing evidence is that it returned a verdict and spent output tokens:
 * that is a review that found nothing, not an arm that silently failed.
 *
 * Surfaced separately from `isComplete` because a broken arm and a lenient arm
 * lead to opposite conclusions, and the count alone cannot tell them apart.
 *
 * Three-way, never two-way. Entries written before `shadowVerdict` existed have
 * the key ABSENT, which is not the same as an arm that returned no verdict —
 * collapsing the two would report the campaign's own first three snapshots as
 * broken arms. `evidence` is `unrecorded` (predates the field, says nothing),
 * `reviewed` (returned a verdict ⇒ genuinely found nothing), or `no-verdict`
 * (recorded, and empty ⇒ suspect the arm, not the model).
 */
export function zeroFindingArms(entry, scope) {
  assertResolvedScope(scope);
  const out = [];
  for (const a of scope.arms) {
    const r = entry?.arms?.[a.id];
    if (a.solo) continue; // no shadow bucket exists; a zero here would be meaningless
    if (!r || r.shadowState !== 'ran') continue;
    if ((r.buckets?.shadowOnly ?? 0) !== 0) continue;
    const recorded = Object.hasOwn(r, 'shadowVerdict');
    out.push({
      arm: a.id,
      verdict: recorded ? (r.shadowVerdict ?? null) : undefined,
      evidence: !recorded ? 'unrecorded' : (r.shadowVerdict ? 'reviewed' : 'no-verdict'),
    });
  }
  return out;
}

/**
 * Aggregate the MATCHED view across snapshots, refusing to mix cohorts (§2.5d).
 *
 * Three rules, each closing a way the number could lie:
 *  1. Drop `bucketsMatched === null` FIRST. Those arms did not compute a
 *     matched view; grouping them would dereference `.both` on null, and
 *     counting them as zeros would invent measurements.
 *  2. Group by cohort digest and aggregate only the LARGEST group, naming the
 *     excluded ones. A mean across two thresholds is not a measurement of
 *     either — but refusing to report anything would push an operator to
 *     eyeball it, which is worse.
 *  3. Never let a `null` coverage reach an arithmetic operator. JS coerces it
 *     to 0, so a single `not-applicable` snapshot would silently drag the
 *     campaign's coverage down. Divide by the count of non-null coverages.
 */
export function aggregateMatched(complete, scope) {
  assertResolvedScope(scope);
  const rows = [];
  let notComputed = 0;
  for (const e of complete) {
    for (const a of scope.arms) {
      if (a.solo) continue;                       // no shadow ⇒ no matched view
      const r = e.arms?.[a.id];
      if (!r) continue;
      if (!r.bucketsMatched) { notComputed++; continue; }
      rows.push({ arm: a.id, cohort: r.matchCohort ?? 'v0-unstamped', m: r.bucketsMatched });
    }
  }
  if (rows.length === 0) {
    return { matchedCohort: null, matchedRows: 0, matchedNotComputed: notComputed, matchedExcluded: [], matchedCoverage: null, matchedTotals: null };
  }
  const groups = new Map();
  for (const r of rows) groups.set(r.cohort, [...(groups.get(r.cohort) || []), r]);
  // Largest group wins; ties break on the LOWEST digest so two runs over one
  // log always pick the same cohort (never input order).
  const ranked = [...groups.entries()].sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]));
  const [cohort, chosen] = ranked[0];

  const covs = chosen.map((r) => r.m.coverage).filter((c) => typeof c === 'number');
  return {
    matchedCohort: cohort,
    matchedRows: chosen.length,
    matchedNotComputed: notComputed,
    matchedExcluded: ranked.slice(1).map(([c, rs]) => ({ cohort: c, rows: rs.length })),
    // null, not 0, when every row was `not-applicable`.
    matchedCoverage: covs.length ? covs.reduce((s, c) => s + c, 0) / covs.length : null,
    matchedTotals: {
      both: chosen.reduce((s, r) => s + r.m.both, 0),
      shadowOnly: chosen.reduce((s, r) => s + r.m.shadowOnly, 0),
      unmatchable: chosen.reduce((s, r) => s + r.m.unmatchablePrimary + r.m.unmatchableShadow, 0),
      unknownVerdicts: chosen.filter((r) => r.m.verdict === 'unknown').length,
      notApplicable: chosen.filter((r) => r.m.verdict === 'not-applicable').length,
    },
  };
}

/**
 * Distinct-finding count under the SAME rule `diffFindingBuckets` applies to a
 * shadow (dedup by `_hash`), so a primary count and a shadow count are
 * comparable numbers rather than two different measurements wearing one name.
 *
 * The shadow side is deduped before it is ever bucketed; the primary side is
 * written to the arm file raw. Comparing them directly would report a dedup
 * difference as model variance. Observed today: raw === distinct on all five
 * snapshots, so this changes no number — which is the point. It stops being
 * true silently the first time a reviewer repeats itself.
 *
 * An unhashed finding gets a per-index key rather than collapsing into one
 * bucket — same "never silently drop" rule as `dedupByHash`, without importing
 * the hashing module into a collector.
 * @param {Array<object>|null|undefined} findings
 */
export function distinctFindingCount(findings) {
  const list = Array.isArray(findings) ? findings.filter(Boolean) : [];
  return new Set(list.map((f, i) => f._hash ?? `nohash:${i}`)).size;
}

/**
 * Opus's own finding total from the `opus` arm, where it ran as SHADOW.
 *
 * `both + shadowOnly` is the shadow's whole deduped set: `diffFindingBuckets`
 * partitions it into exactly those two buckets. In practice `both` is
 * structurally ~0 because the hashes are matched across models — that makes the
 * sum equal `shadowOnly` today, but the sum is what is correct, so it is what is
 * written.
 *
 * Returns null (never 0) when the shadow did not run: a skipped arm that reads
 * as "found nothing" is the anti-green failure this campaign already tripped on.
 * @param {object|null|undefined} armResult
 */
export function shadowFindingTotal(armResult) {
  const b = armResult?.buckets;
  if (!b || typeof b.both !== 'number' || typeof b.shadowOnly !== 'number') return null;
  return b.both + b.shadowOnly;
}

/**
 * Identity of the configuration a matched result was computed under (plan §2.5d).
 *
 * Canonical: sha256 over `{matchSchemaVersion, threshold, coverageFloor, enabled}`
 * in that FIXED key order, numbers to 4dp, first 8 hex. Fixed order and fixed
 * precision because `JSON.stringify` of an object literal is insertion-ordered
 * and a float can render differently across producers — either would split one
 * cohort into two and silently shrink the aggregate.
 *
 * `matchSchemaVersion` IS part of the identity: a schema change with an
 * unchanged threshold still changes what the buckets MEAN. `enabled` is in it
 * too, though the aggregator drops disabled rows before grouping — the digest
 * records what happened, the filter keeps the arithmetic safe.
 *
 * Returns `'v0-unstamped'` for a record written before the fields existed, so
 * those group together and report as not-re-derivable rather than silently
 * joining a real cohort.
 */
export function cohortDigest(schemaVersion, cfg) {
  if (schemaVersion == null || !cfg) return 'v0-unstamped';
  const canonical = JSON.stringify({
    matchSchemaVersion: schemaVersion,
    threshold: Number(cfg.threshold).toFixed(4),
    coverageFloor: Number(cfg.coverageFloor).toFixed(4),
    enabled: cfg.enabled !== false,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

/** What one arm SPENT, in USD, priced through the shared cost oracle. */
export function armCostUsd(armJson) {
  const calls = [
    { model: armJson?._model, usage: armJson?._usage },
    { model: armJson?._shadow?.model, usage: armJson?._shadow?.usage },
    // Audit R1 H2 — this filtered on `c.model && c.usage`, so a call that
    // really happened but reported NO usage was dropped from `calls` entirely:
    // it never reached costFromUsage, never landed in `unpricedModels`, and the
    // arm therefore published a confident-looking total that silently omitted
    // it. Filter on the model alone — a model with no usage IS a call, and
    // costFromUsage now classifies it as unmeterable, which the loop below
    // turns into an honest null total. No model means no call was made.
  ].filter((c) => c.model);
  if (calls.length === 0) return { usd: null, unpricedModels: [] };
  let usd = 0;
  const unpricedModels = [];
  for (const c of calls) {
    const r = costFromUsage(c.usage, c.model);
    // c5808479 fix — `if (!r.priced) … else usd += r.totalUsd` now has a third
    // case: a PRICED model whose usage is unmeterable returns totalUsd:null,
    // and `usd += null` would silently add 0, quietly under-reporting the arm
    // instead of admitting the total is unknown. An unmeterable call makes the
    // arm total exactly as unknowable as an unpriced one does, so it takes the
    // same path.
    if (!r.priced || r.unmeterable) unpricedModels.push(c.model);
    else usd += r.totalUsd;
  }
  return { usd: unpricedModels.length ? null : usd, unpricedModels };
}

export function summarise(entries, target = DEFAULT_TARGET, scope) {
  assertResolvedScope(scope);
  assertScopeMatches(entries, scope);
  const { arms } = scope;
  // Arrow, not a bare reference: Array#filter passes (element, index, array),
  // so `filter(isComplete)` would hand the INDEX to the second `isComplete`
  // param, and `assertResolvedScope` would throw on a number rather than
  // silently misjudging completeness. Caught by the existing suite.
  const complete = entries.filter((e) => isComplete(e, scope));
  const totals = {
    // Generic, arm-id-keyed tallies — the source of truth for the readout.
    // Every declared arm's id is a key (D1c), even one that never ran in any
    // complete snapshot — its value is `unknown`, never a fabricated 0 (D6).
    uniqueByArm: {}, soloFindingsByArm: {},
    // Legacy flat fields, DERIVED from the maps below so the historical
    // three-arm campaign keeps reporting identically. They are a view, not a
    // second source: nothing writes them directly. `primaryTotal` is GONE —
    // it was written twice and read nowhere (D1c).
    opusUnique: 0, kimiUnique: 0, soloFindings: 0,
    primaryDivergence: null, opusDivergence: [], opusDivergenceUnpaired: 0,
    // Per-arm spend. `costByArm[x] === null` means at least one call in that arm
    // was unpriced, so no total exists — distinct from a genuine 0, which would
    // claim the arm ran for free.
    costByArm: {}, costUncostedSnapshots: 0, rerollPairs: [],
  };
  // An arm is uncostable if ANY of its snapshots is. Tracked separately from the
  // running sum so one unpriced model cannot silently deflate an arm's total.
  const armCostState = new Map();
  // Per-declared-arm accumulators, seeded for EVERY arm in `scope.arms` up
  // front — not lazily on first sight — so an arm that never appears in any
  // complete snapshot still gets a key (D1c's "key set equals scope.arms
  // exactly"), reported `unknown` rather than silently absent.
  const uniqueAcc = new Map(arms.filter((a) => !a.solo).map((a) => [a.id, { sum: 0, n: 0 }]));
  const soloAcc = new Map(arms.filter((a) => a.solo).map((a) => [a.id, { sum: 0, n: 0 }]));
  const primarySamples = [];
  let primaryUnpaired = 0;
  for (const e of complete) {
    // Tallied per DECLARED arm, never per hardcoded id. The readout named
    // `opus`/`kimi`/`solo-opus` literally, so the moment a campaign declared a
    // different arm set it reported an arm that did not exist (`solo-opus`,
    // from the other campaign) and silently omitted the ones that did (`grok`,
    // `gemini-control` contributed to spend and to the verdict while appearing
    // in no line of the only readout an operator reads). A comparison tool
    // whose summary is pinned to one historical arm set cannot be used for the
    // next comparison, which is the entire point of declaring arms in config.
    for (const a of arms) {
      const r = e.arms?.[a.id];
      if (!r) continue;
      // A solo arm has no shadow bucket, so its whole result IS its primary
      // count — the two are different measurements and must not be summed into
      // one column.
      if (a.solo) {
        const s = soloAcc.get(a.id); s.sum += (r.primaryFindings ?? 0); s.n += 1;
      } else {
        const s = uniqueAcc.get(a.id); s.sum += (r.buckets?.shadowOnly ?? 0); s.n += 1;
      }
    }
    // §0.4's fifth question — "is a 2nd reviewer just a reroll?" — is answered
    // by P1-vs-P2 divergence: two INDEPENDENT invocations of the SAME primary
    // reviewer on the SAME transcript (every non-solo arm reruns the primary
    // once, with a different shadow attached). Generalised over `scope.arms`
    // (D1c) — a fixed `opus`/`kimi` pair fabricated a `0` divergence sample for
    // any campaign that declared neither (D6: measured on a `grok`/`qwen`/
    // `deepseek` campaign, `primaryDivergence samples: [0, 0]` from data that
    // was never collected). A snapshot contributes a sample only when AT LEAST
    // TWO non-solo arms report a real `primaryFindings` count; otherwise it is
    // UNPAIRED, exactly the rule `opusDivergence` already applies below.
    const primaryVals = arms
      .filter((a) => !a.solo)
      .map((a) => e.arms?.[a.id]?.primaryFindings)
      .filter((v) => typeof v === 'number');
    if (primaryVals.length >= 2) primarySamples.push(Math.max(...primaryVals) - Math.min(...primaryVals));
    else primaryUnpaired += 1;

    // The same question for OPUS, which the Gemini spread cannot answer. The
    // `opus` and `solo-opus` arms issue a byte-identical Anthropic request (the
    // shadow runs blind on the same transcript, plan and context as the primary
    // — measured: matching input token counts on every snapshot), so the pair is
    // two samples of ONE distribution and their spread is Opus's own variance.
    //
    // Worth reading because it prices the `solo-opus` arm: if Opus diverges from
    // itself by as much as it "adds" over Gemini, the arm is buying a reroll and
    // the campaign should say so rather than let a shadow-vs-solo gap read as a
    // finding about reviewer roles.
    //
    // A snapshot missing either side is COUNTED AS UNPAIRED, never as a zero —
    // a zero here would read as "Opus agreed with itself perfectly", which is
    // the strongest possible claim and exactly what absent data cannot support.
    const shadowOpus = shadowFindingTotal(e.arms.opus);
    const soloOpus = e.arms['solo-opus']?.primaryDistinct;
    if (typeof shadowOpus === 'number' && typeof soloOpus === 'number') {
      totals.opusDivergence.push(Math.abs(shadowOpus - soloOpus));
    } else {
      totals.opusDivergenceUnpaired += 1;
    }

    // Spend, per arm.
    let snapshotFullyCosted = true;
    for (const a of arms) {
      const c = e.arms?.[a.id]?.costUsd;
      const prev = armCostState.get(a.id) ?? { usd: 0, costable: true };
      if (typeof c === 'number') prev.usd += c;
      else { prev.costable = false; snapshotFullyCosted = false; }
      armCostState.set(a.id, prev);
    }
    if (!snapshotFullyCosted) totals.costUncostedSnapshots += 1;

    // Reroll detection. Two arms whose fingerprints intersect sent the SAME
    // request, so any difference between them is sampling noise plus a
    // reporting convention — never a fact about reviewer roles. Reported as a
    // property of the data rather than left as tribal knowledge, because the
    // arm table looks like three configurations and reads like three questions.
    const byArm = arms.map((a) => [a.id, new Set(e.arms?.[a.id]?.requestFingerprints ?? [])]);
    for (let i = 0; i < byArm.length; i++) {
      for (let k = i + 1; k < byArm.length; k++) {
        const shared = [...byArm[i][1]].filter((fp) => byArm[k][1].has(fp));
        if (shared.length > 0) totals.rerollPairs.push(`${byArm[i][0]}=${byArm[k][0]}`);
      }
    }
  }
  for (const [id, s] of armCostState) totals.costByArm[id] = s.costable ? s.usd : null;

  // Materialise the per-arm accumulators as `AggregateResult` (D6) — an arm
  // with `n === 0` (never ran in any complete snapshot) is `unknown`, never a
  // fabricated `0`. Key set is exactly `scope.arms`'s own ids (D1c).
  const toAggregateMap = (acc) => Object.fromEntries([...acc].map(([id, { sum, n }]) => [
    id,
    n > 0
      ? { status: 'measured', value: sum, observationCount: n, unpairedCount: 0 }
      : { status: 'unknown', observationCount: 0, unpairedCount: 0, reason: `arm "${id}" did not run in any complete snapshot` },
  ]));
  totals.uniqueByArm = toAggregateMap(uniqueAcc);
  totals.soloFindingsByArm = toAggregateMap(soloAcc);

  // Derive the legacy flat fields from the generic maps. Kept so the original
  // three-arm campaign's readout and its existing assertions are unchanged;
  // they are a projection of `uniqueByArm`/`soloFindingsByArm`, never a
  // parallel tally that could disagree with them. A measured 0 and an
  // unmeasured arm both read as `0` here on purpose — this view is
  // explicitly non-load-bearing (D1c) and predates the `unknown` distinction;
  // callers that need to tell them apart read the generic maps instead.
  totals.opusUnique = totals.uniqueByArm.opus?.status === 'measured' ? totals.uniqueByArm.opus.value : 0;
  totals.kimiUnique = totals.uniqueByArm.kimi?.status === 'measured' ? totals.uniqueByArm.kimi.value : 0;
  totals.soloFindings = totals.soloFindingsByArm['solo-opus']?.status === 'measured' ? totals.soloFindingsByArm['solo-opus'].value : 0;

  // The Gemini self-divergence aggregate (D6) — `measured` only when at
  // least one snapshot contributed a real ≥2-arm sample; otherwise `unknown`,
  // carrying whatever unpaired count was observed. Replaces the old
  // unconditional array push, which fabricated a `0` sample (and therefore a
  // confident "mean 0.0, max 0" readout) for every entry lacking two
  // qualifying arms — the exact incident D6 documents.
  totals.primaryDivergence = primarySamples.length > 0
    ? {
      status: 'measured',
      value: primarySamples.reduce((a, b) => a + b, 0) / primarySamples.length,
      observationCount: primarySamples.length,
      unpairedCount: primaryUnpaired,
      max: Math.max(...primarySamples),
    }
    : { status: 'unknown', observationCount: 0, unpairedCount: primaryUnpaired, reason: 'no complete snapshot had ≥2 non-solo arms report a primary finding count' };

  // THE incident-(c) fix: this call used to default to whatever `aggregateMatched`
  // itself would fall back to when no `scope` argument was passed — the module-
  // global arm set, silently — because this line, alone among every other call
  // site in this function, was never updated when the rest of `summarise` moved
  // onto `ResolvedScope`. `aggregateMatched` now REQUIRES `scope` (no default),
  // so the omission would have been a hard `UnresolvedScopeError` here rather
  // than a silent wrong-arms read — but it must still be passed explicitly, not
  // rely on that as a safety net.
  Object.assign(totals, aggregateMatched(complete, scope));
  return {
    complete: complete.length,
    incomplete: entries.length - complete.length,
    target,
    remaining: Math.max(0, target - complete.length),
    met: complete.length >= target,
    totals,
  };
}

/**
 * Project bake-off log entries into `comparison/spend.mjs`'s snapshot shape,
 * so the incomplete-snapshot spend line (D5) is computed by the shared core
 * rather than a second summation. Reuses `armCostUsd` — the same per-arm
 * dollar extraction the existing complete-only "spend:" line already trusts —
 * so the two lines can never quietly disagree about what one arm-run cost.
 *
 * @param {object[]} entries - bake-off log entries (already campaign-scoped)
 * @param {import('./scope.mjs').ResolvedScope} scope
 * @returns {Array<{snapshotId: string, complete: boolean, armRuns: Array<{armId: string, costUsd: number|null, costStatus: 'priced'|'unpriced'}>}>}
 */
export function entriesToSpendSnapshots(entries, scope) {
  assertResolvedScope(scope);
  return entries.map((e) => ({
    snapshotId: e.snapshotId,
    complete: isComplete(e, scope),
    armRuns: scope.arms
      .map((a) => {
        const r = e.arms?.[a.id];
        if (!r) return null; // never spawned this round — not a $0 charge
        const { usd } = armCostUsd(r);
        return { armId: a.id, costUsd: usd, costStatus: usd == null ? 'unpriced' : 'priced' };
      })
      .filter(Boolean),
  }));
}
