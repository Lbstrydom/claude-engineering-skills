/**
 * @fileoverview DB-free tests for the cloud FP suppression policy
 * (scripts/lib/suppression-policy.mjs).
 *
 * Plan: docs/plans/cloud-fp-suppression-read-loop.md
 *
 * The dangerous green for this layer is "the audit passed and the findings are
 * silently gone", so the suite is deliberately two-sided: every case that pins
 * "must NOT suppress" has a mirror pinning "still DOES suppress". A suite that
 * only asserted the safe direction would pass with the feature entirely dead —
 * which is exactly the orchestration bug the plan's audit found.
 *
 * Everything here is a pure function over injected fixtures: no DB, no DSN, no
 * LLM (INC-002 — a destructive/real DSN must never be reachable from a test).
 */
process.env.AUDIT_DB_URL = ''; // must precede the dynamic imports below

const {
  resolveSuppressionPolicy,
  shouldSuppressFinding,
  applyCloudFpSuppression,
  runCloudFpPass,
  buildCloudFpPolicy,
  applyLocalFpSuppression,
  runLocalFpPass,
  runSuppressionPasses,
} = await import('../scripts/lib/suppression-policy.mjs');
const { learningConfig } = await import('../scripts/lib/config.mjs');
const { fpPatternReadColumns } = await import('../scripts/lib/store/bandit-fp.mjs');
const { FalsePositiveTracker } = await import('../scripts/lib/findings-tracker.mjs');

import test from 'node:test';
import assert from 'node:assert/strict';

const HALF_LIFE = learningConfig.outcomeHalfLifeMs;
const NOW = Date.parse('2026-07-17T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const FRESH = iso(NOW);                      // decays ~nothing
const ANCIENT = iso(NOW - HALF_LIFE * 8);    // 8 half-lives → /256

/** A cloud row as the reader returns it (snake_case counters + anchor). */
function cloudRow(over = {}) {
  return {
    category: 'dry violation',
    severity: 'MEDIUM',
    principle: 'single source of truth',
    scope: 'global',
    file_extension: 'unknown',
    dismissed: 8,
    accepted: 0,
    ema: 0.05,
    decayed_accepted: 0,
    decayed_dismissed: 8,
    auto_suppress: true,
    last_dismissed_at: FRESH,
    // Real rows always carry this (pattern_value TEXT NOT NULL) — it is the
    // pattern's persisted identity, and the policy now reads it rather than
    // rebuilding a lossy approximation of it.
    pattern_value: 'dry violation::MEDIUM::single source of truth',
    ...over,
  };
}

function finding(over = {}) {
  return { category: 'dry violation', severity: 'MEDIUM', principle: 'single source of truth', ...over };
}

const envelope = (repo, global) => ({
  repo: { status: 'ok', patterns: [], atLimit: false, ...repo },
  global: { status: 'ok', patterns: [], atLimit: false, ...global },
});

// ── 1. Cloud-shape mapping ─────────────────────────────────────────────────

test('resolveFpPatterns maps snake_case cloud counters onto the camelCase shape ESS reads', () => {
  const policy = resolveSuppressionPolicy(
    null, null, { repoPatterns: [cloudRow({ decayed_accepted: 1.5, decayed_dismissed: 6.5 })], globalPatterns: [] },
    undefined, { nowMs: NOW }
  );
  const [p] = policy.fpSuppressions;
  assert.equal(p.decayedAccepted, 1.5);
  assert.equal(p.decayedDismissed, 6.5);
});

// ── 2. The GLOBAL effective-sample-size gate ───────────────────────────────

test('a global row with auto_suppress=true but ESS below the minimum does NOT suppress', () => {
  // The writer computes auto_suppress from RAW counts; the reader must re-gate
  // on the DECAYED ones and must not trust the writer's flag.
  const thin = cloudRow({ decayed_dismissed: 1, decayed_accepted: 0, auto_suppress: true });
  const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [], globalPatterns: [thin] }, undefined, { nowMs: NOW });
  assert.equal(shouldSuppressFinding(finding(), policy).suppress, false);
});

test('MIRROR: a global row with sufficient ESS and low ema DOES suppress', () => {
  const strong = cloudRow({ decayed_dismissed: 8, decayed_accepted: 0, ema: 0.05 });
  const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [], globalPatterns: [strong] }, undefined, { nowMs: NOW });
  const v = shouldSuppressFinding(finding(), policy);
  assert.equal(v.suppress, true);
  assert.equal(v.scope, 'global');
});

// ── 3. Reader-side decay (a row whose writer stopped syncing must expire) ───

test('an ancient row decays below the ESS floor and stops suppressing — with no new write', () => {
  const stale = cloudRow({ last_dismissed_at: ANCIENT, decayed_dismissed: 8, decayed_accepted: 0 });
  const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [], globalPatterns: [stale] }, undefined, { nowMs: NOW });
  const [p] = policy.fpSuppressions;
  assert.ok(p.decayedDismissed < learningConfig.minFpSamples, `decayed to ${p.decayedDismissed}`);
  assert.equal(shouldSuppressFinding(finding(), policy).suppress, false);
});

test('MIRROR: the same row stamped fresh still suppresses', () => {
  const fresh = cloudRow({ last_dismissed_at: FRESH, decayed_dismissed: 8, decayed_accepted: 0 });
  const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [], globalPatterns: [fresh] }, undefined, { nowMs: NOW });
  assert.equal(shouldSuppressFinding(finding(), policy).suppress, true);
});

// ── 4. An undatable decay anchor must not suppress ─────────────────────────
//
// "Fail-open" for a suppression layer means failing toward KEEPING THE FINDING.
// An earlier revision kept an undatable row at its as-written ESS and called
// that fail-open — but preserving a pattern's full strength when its freshness
// cannot be established is failing toward SUPPRESSING, i.e. exactly the
// immortal row the read-side decay exists to kill.

test('an absent or unparseable decay anchor makes the pattern unusable — it cannot suppress', () => {
  for (const anchor of [undefined, null, '', 'not-a-date']) {
    const row = cloudRow({ last_dismissed_at: anchor, decayed_dismissed: 8, ema: 0.05 });
    const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [], globalPatterns: [row] }, undefined, { nowMs: NOW });
    assert.equal(policy.fpSuppressions.length, 0, `undatable anchor must not yield a usable pattern: ${String(anchor)}`);
    assert.equal(shouldSuppressFinding(finding(), policy).suppress, false);
  }
});

test('MIRROR: a datable anchor on the same row still suppresses (the drop is anchor-specific, not blanket)', () => {
  const row = cloudRow({ last_dismissed_at: FRESH, decayed_dismissed: 8, ema: 0.05 });
  const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [], globalPatterns: [row] }, undefined, { nowMs: NOW });
  assert.equal(policy.fpSuppressions.length, 1);
  assert.equal(shouldSuppressFinding(finding(), policy).suppress, true);
});

// ── 5. Scope hierarchy: narrow overrides broad ─────────────────────────────

test('a well-evidenced repo BLOCKER (ema >= 0.15) stops the walk and keeps the finding', () => {
  // This is the row auto_suppress=true would have filtered out of the read.
  const blocker = cloudRow({ scope: 'repo', ema: 0.8, decayed_accepted: 8, decayed_dismissed: 1, auto_suppress: false });
  const suppressor = cloudRow({ scope: 'global', ema: 0.05, decayed_accepted: 0, decayed_dismissed: 8 });
  const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [blocker], globalPatterns: [suppressor] }, undefined, { nowMs: NOW });
  const v = shouldSuppressFinding(finding(), policy);
  assert.equal(v.suppress, false, 'repo blocker must pre-empt the global suppressor');
  assert.equal(v.scope, 'repo');
});

test('MIRROR: without the repo blocker, the same global suppressor DOES suppress', () => {
  const suppressor = cloudRow({ scope: 'global', ema: 0.05, decayed_accepted: 0, decayed_dismissed: 8 });
  const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [], globalPatterns: [suppressor] }, undefined, { nowMs: NOW });
  assert.equal(shouldSuppressFinding(finding(), policy).suppress, true);
});

// ── 6. A cloud-only policy has no ledger reach ─────────────────────────────

test('a cloud-only policy carries no ledger exclusions', () => {
  const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [], globalPatterns: [] }, undefined, { nowMs: NOW });
  assert.deepEqual(policy.ledgerExclusions, []);
});

// ── 7/8. applyCloudFpSuppression: exempt vs no-ledger ──────────────────────

const suppressingPolicy = () => resolveSuppressionPolicy(
  null, null, { repoPatterns: [], globalPatterns: [cloudRow()] }, undefined, { nowMs: NOW }
);

test('a finding in the exempt set is kept even though its category matches', () => {
  const f = finding();
  const { kept, suppressed } = applyCloudFpSuppression([f], suppressingPolicy(), { exempt: new Set([f]) });
  assert.deepEqual(kept, [f]);
  assert.equal(suppressed.length, 0);
});

test('MIRROR: with an empty exempt set (the no-ledger case) the finding IS suppressed', () => {
  const f = finding();
  const { kept, suppressed } = applyCloudFpSuppression([f], suppressingPolicy(), { exempt: new Set() });
  assert.equal(kept.length, 0);
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].finding, f);
});

test('every suppression carries attributable provenance — a finding never vanishes anonymously', () => {
  // matchedTopic/matchScore mirror suppressReRaises' entry shape so
  // recordSuppressionEvents persists a cloud suppression through the same path.
  // Without them a cloud-suppressed finding disappears with no auditable cause.
  const { suppressed } = applyCloudFpSuppression([finding()], suppressingPolicy());
  const [s] = suppressed;
  assert.ok(s.matchedTopic, 'must name the pattern that caused the suppression');
  assert.equal(typeof s.matchScore, 'number');
  assert.ok(s.reason.includes('FP pattern'), 'reason states scope, n and ema');
  assert.ok(s.finding._hash === undefined || typeof s.finding._hash === 'string');
});

// ── matchedTopic must be the PERSISTED identity, not a reconstruction ───────
//
// The assertion above only requires matchedTopic to be TRUTHY — which is exactly
// how a wrong-but-present key survived a full audit cycle. `_key` used to be
// rebuilt as `category::severity::principle`, the LEGACY 3-segment shape. For a
// SCOPED pattern the real persisted key is 6 segments
// (`…::repoId::fileExtension::scope`, buildPatternKey), so the rebuild emitted a
// key matching no row in the table — and it surfaces as
// suppression_events.matched_topic_id. Confidently-wrong provenance is worse
// than none: it reads as authoritative.

test('PROVENANCE: matchedTopic EQUALS the persisted pattern_value (scoped 6-segment key)', () => {
  // The case the old reconstruction got wrong. `pattern_value` is what
  // buildFpPatternRows actually wrote; nothing else is the pattern's identity.
  const PERSISTED = 'dry violation::MEDIUM::single source of truth::e89ab30aa7d1a6aa::mjs::repo+fileType';
  const scoped = cloudRow({ scope: 'global', pattern_value: PERSISTED });
  const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [], globalPatterns: [scoped] }, undefined, { nowMs: NOW });
  const { suppressed } = applyCloudFpSuppression([finding()], policy);
  assert.equal(
    suppressed[0].matchedTopic, PERSISTED,
    'a rebuilt 3-segment key names a pattern that does not exist in false_positive_patterns'
  );
});

test('PROVENANCE: a legacy 3-segment pattern_value round-trips too', () => {
  // The rebuild happened to be CORRECT here — which is why the bug hid. Pin it
  // so the fix is proven not to break the case that already worked.
  const PERSISTED = 'dry violation::MEDIUM::single source of truth';
  const legacy = cloudRow({ scope: 'global', pattern_value: PERSISTED });
  const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [], globalPatterns: [legacy] }, undefined, { nowMs: NOW });
  const { suppressed } = applyCloudFpSuppression([finding()], policy);
  assert.equal(suppressed[0].matchedTopic, PERSISTED);
});

test('PROVENANCE: the reader SELECTS pattern_value — it cannot be reconstructed downstream', () => {
  // The root cause was structural: the query ordered BY pattern_value without
  // selecting it, so the identity never reached the policy and had to be
  // (lossily) rebuilt. Pin that it is fetched.
  assert.ok(
    fpPatternReadColumns().includes('pattern_value'),
    'the persisted identity must be read, not recomputed from its parts'
  );
});

// ── 9. runCloudFpPass — the composition seam ───────────────────────────────

test('null policy: contents and order unchanged, nothing logged', () => {
  const input = [finding({ category: 'a' }), finding({ category: 'b' })];
  const lines = [];
  const r = runCloudFpPass(input, { policy: null, log: (l) => lines.push(l) });
  assert.deepEqual(r.findings, input);
  assert.equal(r.suppressedCount, 0);
  assert.equal(lines.length, 0);
});

test('ARRAY OWNERSHIP: the result is never the input array (null policy)', () => {
  const input = [finding()];
  const r = runCloudFpPass(input, { policy: null });
  assert.notEqual(r.findings, input, 'aliasing the input erases everything at the call site');
});

test('ARRAY OWNERSHIP: the result is never the input array (populated policy)', () => {
  const input = [finding({ category: 'unmatched' })];
  const r = runCloudFpPass(input, { policy: suppressingPolicy() });
  assert.notEqual(r.findings, input);
});

test('CALL-SITE REPLAY: clear-then-push after a null-policy pass keeps every finding', () => {
  // Reproduces the orchestrator's exact destructive sequence. If runCloudFpPass
  // returned its input, `length = 0` would empty the result too and this would
  // push nothing — erasing every finding on every cloud-disabled run.
  const arr = [finding({ category: 'a' }), finding({ category: 'b' })];
  const before = [...arr];
  const r = runCloudFpPass(arr, { policy: null });
  arr.length = 0;
  arr.push(...r.findings);
  assert.deepEqual(arr, before);
});

test('runCloudFpPass suppresses and logs when the policy matches', () => {
  const lines = [];
  const r = runCloudFpPass([finding()], { policy: suppressingPolicy(), log: (l) => lines.push(l) });
  assert.equal(r.findings.length, 0);
  assert.equal(r.suppressedCount, 1);
  assert.ok(lines.some(l => l.includes('[cloud-fp]')));
});

test('runCloudFpPass exempts reopened findings', () => {
  const f = finding();
  const r = runCloudFpPass([f], { policy: suppressingPolicy(), exempt: new Set([f]) });
  assert.deepEqual(r.findings, [f]);
  assert.equal(r.suppressedCount, 0);
});

test('CONSERVATION: every cloud suppression comes out of kept, never out of exempt/reopened', () => {
  // The orchestrator reconciles keptCount by SUBTRACTING suppressedCount, which
  // is only exact if exempt findings can never be suppressed. Pin the premise
  // that arithmetic rests on: in + out must balance, and the exempt member must
  // survive.
  const reopened = finding({ category: 'dry violation' });   // matches the policy
  const kept = [finding({ category: 'dry violation' }), finding({ category: 'unmatched' })];
  const input = [...kept, reopened];
  const r = runCloudFpPass(input, { policy: suppressingPolicy(), exempt: new Set([reopened]) });

  assert.equal(r.findings.length + r.suppressedCount, input.length, 'no finding may be created or lost');
  assert.ok(r.findings.includes(reopened), 'the exempt finding must survive a matching pattern');
  assert.ok(!r.suppressed.some(s => s.finding === reopened), 'and must never appear as suppressed');
  assert.equal(r.suppressedCount, 1, 'exactly the matching non-exempt finding is suppressed');
});

// ── WS-B: the LOCAL FP pass ────────────────────────────────────────────────
//
// Two-sided by construction: every "must NOT suppress" case has a mirror
// proving it still CAN. A suite that only asserted the safe direction would
// pass with the feature dead — which is the bug this workstream fixes.

/** A tracker whose legacy single-key path suppresses `category` at ema<0.15. */
function trackerFor(category, { ema = 0.05, dismissed = 8 } = {}) {
  return new FalsePositiveTracker('unused.json', {
    store: {
      load: () => ({
        [`${category}::HIGH::correctness`]: {
          category, severity: 'HIGH', principle: 'correctness',
          accepted: 0, dismissed, ema,
          decayedAccepted: 0, decayedDismissed: dismissed,
          lastDecayTs: NOW,
        },
      }),
      save: () => {},
    },
  });
}
const localFinding = (over = {}) => ({ category: 'noisy', severity: 'HIGH', principle: 'correctness', ...over });

test('LOCAL: with NO ledger, a learned pattern now suppresses (the whole point of WS-B)', () => {
  const r = runLocalFpPass([localFinding()], { fpTracker: trackerFor('noisy'), exempt: new Set() });
  assert.equal(r.suppressedCount, 1);
  assert.equal(r.findings.length, 0);
});

test('MIRROR: a non-matching finding still survives the local pass', () => {
  const r = runLocalFpPass([localFinding({ category: 'unmatched' })], { fpTracker: trackerFor('noisy') });
  assert.equal(r.suppressedCount, 0, 'the pass must not suppress indiscriminately');
  assert.equal(r.findings.length, 1);
});

test('LOCAL: reopened findings are EXEMPT — category stats can never mask a regression', () => {
  // A DECISION, not an inheritance: the old in-branch loop filtered `kept` only,
  // so it never saw reopens. Lifting it over kept+reopened without this would
  // silently acquire a new behaviour as a refactor side effect.
  const f = localFinding();
  const r = runLocalFpPass([f], { fpTracker: trackerFor('noisy'), exempt: new Set([f]) });
  assert.deepEqual(r.findings, [f]);
  assert.equal(r.suppressedCount, 0);
});

test('LOCAL: a null tracker is a no-op — findings unchanged, nothing logged', () => {
  const input = [localFinding(), localFinding({ category: 'b' })];
  const lines = [];
  const r = runLocalFpPass(input, { fpTracker: null, log: (l) => lines.push(l) });
  assert.deepEqual(r.findings, input);
  assert.equal(r.suppressedCount, 0);
  assert.equal(lines.length, 0);
});

test('LOCAL ARRAY OWNERSHIP: never returns the input array (both paths)', () => {
  const input = [localFinding({ category: 'unmatched' })];
  assert.notEqual(runLocalFpPass(input, { fpTracker: null }).findings, input);
  assert.notEqual(runLocalFpPass(input, { fpTracker: trackerFor('noisy') }).findings, input);
});

test('LOCAL CALL-SITE REPLAY: clear-then-push keeps every finding on the no-op path', () => {
  const arr = [localFinding({ category: 'a' }), localFinding({ category: 'b' })];
  const before = [...arr];
  const r = runLocalFpPass(arr, { fpTracker: null });
  arr.length = 0; arr.push(...r.findings);
  assert.deepEqual(arr, before, 'returning the input by reference would erase everything here');
});

test('LOCAL: a suppression names the REAL matched pattern, not a synthesized one', () => {
  // shouldSuppress returns a bare boolean and discards which scope fired; a
  // synthesized topic would name a pattern that may not be the one that
  // suppressed — confidently-wrong provenance, worse than none.
  const { suppressed } = applyLocalFpSuppression([localFinding()], trackerFor('noisy'));
  assert.equal(suppressed[0].matchedTopic, 'noisy::HIGH::correctness');
  assert.equal(typeof suppressed[0].matchScore, 'number');
});

// ── WS-B: the composition boundary ─────────────────────────────────────────

test('COMPOSITION: no ledger + a local suppression → envelope SYNTHESIZED with provenance', () => {
  const r = runSuppressionPasses([localFinding()], {
    fpTracker: trackerFor('noisy'), cloudPolicy: null, suppressionData: null, cloudEnabled: false,
  });
  assert.ok(r.suppressionData, 'a suppression with no envelope leaves no audit trail');
  assert.equal(r.suppressionData.fpSuppressedCount, 1);
  assert.equal(r.suppressionData.suppressed.length, 1);
  assert.equal(r.suppressionData.suppressed[0].matchedTopic, 'noisy::HIGH::correctness');
});

test('COMPOSITION: cloud-off adds NO cloud key (--out byte-identity) but DOES record fpSuppressedCount', () => {
  const r = runSuppressionPasses([localFinding()], {
    fpTracker: trackerFor('noisy'), cloudPolicy: null, suppressionData: null, cloudEnabled: false,
  });
  assert.equal('cloudFpSuppressedCount' in r.suppressionData, false, 'cloud-off must gain no cloud-specific key');
  assert.equal(r.suppressionData.fpSuppressedCount, 1);
});

test('COMPOSITION: both passes fire → each count lands in its OWN field; keptCount subtracts both', () => {
  const local = localFinding({ category: 'noisy' });
  const cloud = finding();                       // matches the cloud policy
  const survivor = localFinding({ category: 'untouched' });
  const data = {
    suppressed: [{ finding: { category: 'ledger' }, matchedTopic: 't', matchScore: 1 }],
    reopened: [], keptCount: 3, suppressedCount: 1, reopenedCount: 0, fpSuppressedCount: 0,
  };
  const r = runSuppressionPasses([local, cloud, survivor], {
    fpTracker: trackerFor('noisy'), cloudPolicy: suppressingPolicy(),
    suppressionData: data, cloudEnabled: true,
  });
  assert.equal(r.suppressionData.fpSuppressedCount, 1, 'local owns its field');
  assert.equal(r.suppressionData.cloudFpSuppressedCount, 1, 'cloud owns its field');
  assert.equal(r.suppressionData.suppressedCount, 1, 'the ledger count is untouched');
  assert.equal(r.suppressionData.keptCount, 1, '3 − 1 local − 1 cloud');
  assert.equal(r.suppressionData.suppressed.length, 3, 'the union: ledger ⧺ local ⧺ cloud');
  assert.deepEqual(r.findings, [survivor]);
});

test('COMPOSITION CONSERVATION: kept + suppressed + reopened + fp + cloud === total raised', () => {
  const TOTAL = 3;
  const data = { suppressed: [], reopened: [], keptCount: TOTAL, suppressedCount: 0, reopenedCount: 0, fpSuppressedCount: 0 };
  const r = runSuppressionPasses([localFinding({ category: 'noisy' }), finding(), localFinding({ category: 'safe' })], {
    fpTracker: trackerFor('noisy'), cloudPolicy: suppressingPolicy(), suppressionData: data, cloudEnabled: true,
  });
  const d = r.suppressionData;
  // `?? 0` is LOAD-BEARING: the cloud key is ABSENT when cloud is off, and
  // `x + undefined` is NaN — the invariant could not be asserted at all without it.
  const total = d.keptCount + d.suppressedCount + d.reopenedCount + d.fpSuppressedCount + (d.cloudFpSuppressedCount ?? 0);
  assert.equal(total, TOTAL, 'no finding may be created or lost across both passes');
});

test('COMPOSITION CONSERVATION holds on the cloud-OFF path too (where the key is absent)', () => {
  const TOTAL = 2;
  const data = { suppressed: [], reopened: [], keptCount: TOTAL, suppressedCount: 0, reopenedCount: 0, fpSuppressedCount: 0 };
  const r = runSuppressionPasses([localFinding({ category: 'noisy' }), localFinding({ category: 'safe' })], {
    fpTracker: trackerFor('noisy'), cloudPolicy: null, suppressionData: data, cloudEnabled: false,
  });
  const d = r.suppressionData;
  const total = d.keptCount + d.suppressedCount + d.reopenedCount + d.fpSuppressedCount + (d.cloudFpSuppressedCount ?? 0);
  assert.equal(total, TOTAL);
});

test('COMPOSITION: reopened survives BOTH passes — the premise the subtraction rests on', () => {
  const reopened = localFinding({ category: 'noisy' });   // matches the local tracker
  const data = { suppressed: [], reopened: [reopened], keptCount: 1, suppressedCount: 0, reopenedCount: 1, fpSuppressedCount: 0 };
  const r = runSuppressionPasses([localFinding({ category: 'safe' }), reopened], {
    fpTracker: trackerFor('noisy'), cloudPolicy: suppressingPolicy(),
    exempt: new Set([reopened]), suppressionData: data, cloudEnabled: true,
  });
  assert.ok(r.findings.includes(reopened), 'a reopen must survive a matching pattern');
  assert.equal(r.suppressionData.fpSuppressedCount, 0);
  assert.equal(r.suppressionData.keptCount, 1, 'nothing came out of kept');
});

test('COMPOSITION: null tracker AND null policy → total no-op, envelope untouched', () => {
  const input = [localFinding(), finding()];
  const data = { suppressed: [], reopened: [], keptCount: 2, suppressedCount: 0, reopenedCount: 0, fpSuppressedCount: 0 };
  const r = runSuppressionPasses(input, { fpTracker: null, cloudPolicy: null, suppressionData: data, cloudEnabled: false });
  assert.deepEqual(r.findings, input);
  assert.notEqual(r.findings, input, 'still a fresh array');
  assert.equal(r.suppressionData.keptCount, 2);
  assert.equal('cloudFpSuppressedCount' in r.suppressionData, false);
});

// ── 10. The clock is resolved once per policy ──────────────────────────────

test('every pattern in one policy is decayed against the same injected instant', () => {
  const rows = [
    cloudRow({ category: 'a', last_dismissed_at: ANCIENT, decayed_dismissed: 8 }),
    cloudRow({ category: 'b', last_dismissed_at: ANCIENT, decayed_dismissed: 8 }),
  ];
  const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [], globalPatterns: rows }, undefined, { nowMs: NOW });
  const [a, b] = policy.fpSuppressions;
  assert.equal(a.decayedDismissed, b.decayedDismissed, 'same anchor + same nowMs → identical decay');
});

// ── 11. Dedup — local wins ─────────────────────────────────────────────────

test('a pattern present locally and in cloud resolves to one entry, local wins', () => {
  const tracker = {
    patterns: {
      'dry violation::MEDIUM::single source of truth': {
        category: 'dry violation', severity: 'MEDIUM', principle: 'single source of truth',
        scope: 'global', ema: 0.9, decayedAccepted: 9, decayedDismissed: 1,
      },
    },
  };
  const policy = resolveSuppressionPolicy(tracker, tracker, { repoPatterns: [], globalPatterns: [cloudRow()] }, undefined, { nowMs: NOW });
  const matching = policy.fpSuppressions.filter(p => p.category === 'dry violation' && p.scope === 'global');
  assert.equal(matching.length, 1);
  assert.equal(matching[0].ema, 0.9, 'the local pattern wins');
});

// ── 12. Empty policy ───────────────────────────────────────────────────────

test('an empty policy returns only the two decision fields and suppresses nothing', () => {
  const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [], globalPatterns: [] }, undefined, { nowMs: NOW });
  assert.deepEqual(Object.keys(policy).sort(), ['fpSuppressions', 'ledgerExclusions']);
  const f = finding();
  const { kept, suppressed } = applyCloudFpSuppression([f], policy);
  assert.deepEqual(kept, [f]);
  assert.equal(suppressed.length, 0);
});

// ── 13. Export surface — the deleted prompt formatter stays deleted ────────

test('the unsafe prompt-rendering surface is absent from the module and the barrel', async () => {
  const mod = await import('../scripts/lib/suppression-policy.mjs');
  const shared = await import('../scripts/shared.mjs');
  for (const gone of ['formatPolicyForPrompt', 'deduplicateExclusions', 'suppressionTopics']) {
    assert.equal(mod[gone], undefined, `${gone} must stay deleted, not dormant`);
    assert.equal(shared[gone], undefined, `${gone} must not be re-exported by the barrel`);
  }
  const policy = resolveSuppressionPolicy(null, null, { repoPatterns: [cloudRow()], globalPatterns: [] }, undefined, { nowMs: NOW });
  assert.equal(policy.systemPromptExclusions, undefined, 'no prompt-only projection may survive');
  assert.equal(policy.suppressionTopics, undefined);
});

// ── buildCloudFpPolicy: completeness / asymmetry ───────────────────────────

test('repo scope FAILED → no policy at all, even with a suppressing global pattern', () => {
  const built = buildCloudFpPolicy(
    { repo: { status: 'failed', patterns: [], atLimit: false, errorName: 'DatabaseError' },
      global: { status: 'ok', patterns: [cloudRow()], atLimit: false } },
    { nowMs: NOW }
  );
  assert.equal(built.policy, null, 'a failed narrow scope must not let global decide');
  assert.equal(built.lifecycleState, 'load-failed');
});

test('repo scope TRUNCATED (atLimit) → no policy — truncation is incompleteness, not telemetry', () => {
  const built = buildCloudFpPolicy(
    { repo: { status: 'ok', patterns: [cloudRow({ scope: 'repo' })], atLimit: true },
      global: { status: 'ok', patterns: [cloudRow()], atLimit: false } },
    { nowMs: NOW }
  );
  assert.equal(built.policy, null);
  assert.equal(built.lifecycleState, 'load-failed');
});

test('repo scope SKIPPED (non-uuid) → no policy', () => {
  const built = buildCloudFpPolicy(
    { repo: { status: 'skipped', patterns: [], atLimit: false, reason: 'non-uuid-repo-id' },
      global: { status: 'ok', patterns: [cloudRow()], atLimit: false } },
    { nowMs: NOW }
  );
  assert.equal(built.policy, null);
  assert.equal(built.lifecycleState, 'load-failed');
});

test('global FAILED + repo ok → repo-only policy (the safe, under-suppressing direction)', () => {
  const built = buildCloudFpPolicy(
    { repo: { status: 'ok', patterns: [cloudRow({ scope: 'repo' })], atLimit: false },
      global: { status: 'failed', patterns: [], atLimit: false, errorName: 'DatabaseError' } },
    { nowMs: NOW }
  );
  assert.ok(built.policy, 'repo patterns remain usable');
  assert.equal(built.lifecycleState, 'degraded-global-dropped');
  assert.equal(shouldSuppressFinding(finding(), built.policy).suppress, true, 'repo match still suppresses');
});

test('global ATLIMIT + repo ok → same as global-failed (global incompleteness is harmless)', () => {
  const built = buildCloudFpPolicy(
    { repo: { status: 'ok', patterns: [cloudRow({ scope: 'repo' })], atLimit: false },
      global: { status: 'ok', patterns: [cloudRow()], atLimit: true } },
    { nowMs: NOW }
  );
  assert.equal(built.lifecycleState, 'degraded-global-dropped');
});

test('repo ok-but-EMPTY is NOT repo failed — an explicitly empty repo scope permits global suppression', () => {
  const built = buildCloudFpPolicy(envelope({ patterns: [] }, { patterns: [cloudRow()] }), { nowMs: NOW });
  assert.ok(built.policy, 'an empty repo scope is complete, not unavailable');
  assert.equal(built.lifecycleState, 'loaded-active');
  assert.equal(shouldSuppressFinding(finding(), built.policy).suppress, true);
});

test('lifecycle: zero patterns everywhere → loaded-zero, null policy, no crash', () => {
  const built = buildCloudFpPolicy(envelope({}, {}), { nowMs: NOW });
  assert.equal(built.policy, null);
  assert.equal(built.lifecycleState, 'loaded-zero');
});

test('lifecycle: every state returned is one of the five documented values', () => {
  const STATES = new Set(['loaded-zero', 'loaded-active', 'degraded-global-dropped', 'load-failed']);
  const cases = [
    envelope({}, {}),
    envelope({ patterns: [cloudRow({ scope: 'repo' })] }, {}),
    { repo: { status: 'failed', patterns: [], atLimit: false, errorName: 'E' }, global: { status: 'ok', patterns: [], atLimit: false } },
    { repo: { status: 'ok', patterns: [], atLimit: false }, global: { status: 'failed', patterns: [], atLimit: false, errorName: 'E' } },
    { repo: { status: 'ok', patterns: [], atLimit: true }, global: { status: 'ok', patterns: [], atLimit: false } },
  ];
  for (const env of cases) {
    assert.ok(STATES.has(buildCloudFpPolicy(env, { nowMs: NOW }).lifecycleState));
  }
});

test('a malformed envelope fails safe rather than throwing', () => {
  for (const bad of [undefined, {}, { repo: null, global: null }]) {
    const built = buildCloudFpPolicy(bad, { nowMs: NOW });
    assert.equal(built.policy, null);
    assert.equal(built.lifecycleState, 'load-failed');
  }
});
