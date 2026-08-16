/**
 * @fileoverview Blind adjudication DTO, redaction, worksheet identity,
 * calibration sampling, verdict normalisation, self-family policy, and
 * cluster-refusal rules (campaign/adjudicate).
 *
 * Split out of `tests/campaign-adjudication.test.mjs` (Phase 4, plan:
 * comparison-tooling-consolidation.md, D3) — assertions moved verbatim.
 *
 * @module tests/campaign-adjudicate
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  BLIND_ROW_FIELDS, buildBlindRow, buildModelRedactor, worksheetRowIdFor,
  calibrationScore, isCalibrationSelected, assignCalibrationSample,
  isSelfFamily, hmacKeyRefFor, requireCampaignHmacKey, CALIBRATION_MIN_PER_ARM,
} from '../scripts/lib/store/campaign.mjs';
import {
  clusterSnapshotFindings, normaliseVerdict, routesToHumanQueue,
  ADJUDICATION_TOOL, AdjudicationVerdictSchema,
} from '../scripts/lib/campaign/adjudicate.mjs';
import { parseCampaignConfig } from '../scripts/lib/campaign/config.mjs';

const REAL_CONFIG = parseCampaignConfig(JSON.parse(fs.readFileSync('.campaigns/final-review-2026q3.json', 'utf-8'))).config;
const KEY = 'a'.repeat(64);

// ── §9 case 6 — the blind DTO is a WHITELIST ────────────────────────────────

describe('blind worksheet DTO', () => {
  it('is a closed shape — a wider source row cannot leak a new field', () => {
    const row = buildBlindRow({
      worksheetRowId: 'w1', category: 'Backend', primaryFile: 'scripts/a.mjs:12',
      detail: 'a defect', severity: 'HIGH', citedSources: [],
      // Everything below is present on the real store row and must NOT appear.
      source_model: 'claude-opus-4-8', sourceModel: 'claude-opus-4-8',
      arm_id: 'opus', run_id: 'r1', finding_id: 'f1', someColumnAddedNextYear: 'leak',
    }, (t) => t);
    assert.deepEqual(Object.keys(row).sort(), [...BLIND_ROW_FIELDS].sort());
    const serialised = JSON.stringify(row);
    for (const leak of ['claude-opus-4-8', 'opus', 'someColumnAddedNextYear', 'leak']) {
      assert.ok(!serialised.includes(leak), `blind row leaked ${leak}`);
    }
  });

  it('flags a detail that hit the store\'s 600-char cap, so short is never mistaken for complete', () => {
    assert.equal(buildBlindRow({ worksheetRowId: 'w', detail: 'x'.repeat(600) }, (t) => t).detailTruncated, true);
    assert.equal(buildBlindRow({ worksheetRowId: 'w', detail: 'x'.repeat(599) }, (t) => t).detailTruncated, false);
  });
});

// ── the leak canary, against the REAL campaign fixture ──────────────────────

describe('redaction leak canary (real campaign fixture, not a synthetic row)', () => {
  const redact = buildModelRedactor({ arms: REAL_CONFIG.arms });

  it('no arm id, arm model or provider name survives in the rendered row', () => {
    // Real reviewer prose from this repo's own campaign: models name themselves.
    const row = buildBlindRow({
      worksheetRowId: 'w1', category: 'Backend',
      primaryFile: 'scripts/lib/store/x.mjs:40',
      detail: 'Opus 5 thinks by default, so the OpenRouter arm running moonshotai/kimi-k2-thinking '
        + 'at claude-opus parity would差 — see the gemini reviewer and gpt-5.6-terra fallback.',
      severity: 'HIGH', citedSources: [],
    }, redact);
    const text = JSON.stringify(row);
    for (const arm of REAL_CONFIG.arms) {
      assert.ok(!text.toLowerCase().includes(arm.id.toLowerCase()), `leaked arm id "${arm.id}"`);
      assert.ok(!text.toLowerCase().includes(arm.model.toLowerCase()), `leaked arm model "${arm.model}"`);
    }
    for (const provider of ['openrouter', 'gemini', 'gpt-5.6-terra', 'moonshotai']) {
      assert.ok(!text.toLowerCase().includes(provider), `leaked provider "${provider}"`);
    }
    assert.ok(text.includes('[MODEL-A]') || text.includes('[ARM]'), 'the redactor must actually have fired');
  });

  it('the SECTION is redacted too — it is not always a file path', () => {
    // It looks like a path, so an earlier version passed it through. But
    // recordFindings stores `_primaryFile || section`, so raw model-authored
    // prose lands in the column whenever the resolved path is absent. Measured
    // on the live store: 43 rows already carry a provider term there. These two
    // strings are real values from that query.
    for (const real of [
      '§4 phase 5; §6 “the gemini census must discover, not enumerate”',
      'Audit transcript (rounds: [], claude_resolutions[0]) — consolidated gate',
    ]) {
      const row = buildBlindRow({ worksheetRowId: 'w1', primaryFile: real, detail: 'x', severity: 'HIGH', citedSources: [] }, redact);
      assert.ok(!/gemini|claude/i.test(row.section), `section leaked a provider term: ${row.section}`);
    }
    // A genuine path still survives intact — redaction must not destroy the
    // location the reviewer needs.
    const pathRow = buildBlindRow({ worksheetRowId: 'w1', primaryFile: 'scripts/lib/store/campaign.mjs', detail: 'x', severity: 'HIGH', citedSources: [] }, redact);
    assert.equal(pathRow.section, 'scripts/lib/store/campaign.mjs');
  });

  it('NEGATIVE CONTROL: the same row fails the canary when the redactor is bypassed', () => {
    // Without this the canary could pass vacuously — e.g. if buildBlindRow ever
    // stopped emitting `detail` at all.
    const unredacted = buildBlindRow({
      worksheetRowId: 'w1', detail: 'the moonshotai/kimi-k2-thinking arm', severity: 'HIGH', citedSources: [],
    }, (t) => t);
    assert.ok(JSON.stringify(unredacted).toLowerCase().includes('moonshotai/kimi-k2-thinking'));
  });

  it('one placeholder, not a per-model alias — an alias would let the adjudicator correlate rows', () => {
    const a = redact('claude-opus wrote this');
    const b = redact('moonshotai/kimi-k2-thinking wrote this');
    assert.equal(a, b, 'two different models must render identically');
  });

  it('a SHORT arm id is redacted on a token boundary, not as a bare substring', () => {
    // The arm-id pattern permits a single character. As a plain substring that
    // would rewrite every letter `a` in the finding — which does not make the
    // row blind, it makes it unreadable, and an adjudicator that cannot read
    // the claim cannot verify it.
    // `redactionTerms` override — this test is about ARM-ID boundary
    // behaviour, not provider derivation, so the model is a throwaway that
    // must never collide with the assertions below.
    const short = buildModelRedactor({ arms: [{ id: 'a', model: 'unused-a', redactionTerms: ['zzz-unused'] }] });
    assert.equal(short('a caching layer already allocates'), '[ARM] caching layer already [MODEL-A]llocates'.replace('[MODEL-A]llocates', 'allocates'),
      'ordinary words containing the letter must survive');
    assert.match(short('arm a failed'), /\[ARM\]/, 'the standalone arm id is still redacted');
    assert.ok(!short('a caching layer already allocates').includes('[ARM] c[ARM]ching'), 'no intra-word rewriting');
  });

  it('EVERY arm id is token-boundaried, whatever its length', () => {
    // The split is by KIND, not length. An arm id is a discrete label that
    // appears as a whole word; a three-character one has no more business
    // rewriting the inside of a word than a one-character one does.
    const r = buildModelRedactor({ arms: [{ id: 'abc', model: 'unused-abc', redactionTerms: ['zzz-unused'] }] });
    assert.equal(r('the abcdef helper'), 'the abcdef helper', 'a 3-char arm id must not match mid-word');
    assert.match(r('arm abc failed'), /\[ARM\]/, 'but still redacts standing alone');
  });

  it('a long model id embedded in a longer token still redacts', () => {
    const r = buildModelRedactor({ arms: [{ model: 'claude-opus' }] });
    assert.ok(!r('running claude-opus-4-8-preview here').includes('claude-opus'));
  });

  it('a SHORT arm MODEL is redacted, not dropped for being short', () => {
    // The length floor is a readability heuristic for the ambient catalogue. It
    // must never decide whether THIS campaign's own arms are blind — and it did:
    // a two-character model id (which the schema permits) fell through the
    // `>= MIN_REDACTABLE_TERM` filter and stayed visible in the worksheet.
    const r = buildModelRedactor({ arms: [{ model: 'g5', redactionTerms: ['zzz-unused'] }] });
    assert.ok(!r('the g5 model found it').includes(' g5 '), 'a short arm model leaked');
    assert.match(r('the g5 model found it'), /\[MODEL-A\]/);
    assert.equal(r('a g5x identifier'), 'a g5x identifier', 'and it is boundary-guarded, not shredding longer tokens');
  });

  it('a provider NAME the resolver knows is redacted, not just its model ids', () => {
    // `flattenPool` walks values only, so the pool KEYS — google, openai,
    // anthropic — were absent from the term set: "gemini" redacted while
    // "Google's model" passed through. Half a vocabulary reads as a whole one.
    const r = buildModelRedactor({ arms: [{ id: 'opus', model: 'claude-opus' }] });
    // `z-ai` is deliberate: it is a vendor namespace in OSS_PRICING that the
    // hardcoded PROVIDER_TERMS list does NOT contain, so it is covered only by
    // deriving vendors from the pricing table. Asserting on `moonshotai` here
    // would pass whether or not that derivation exists — a vacuous test of a
    // real mechanism.
    for (const vendor of ['Google', 'google', 'z-ai']) {
      assert.ok(!r(`built by ${vendor} originally`).includes(vendor), `leaked vendor "${vendor}"`);
    }
    assert.match(r('the Gemini family'), /\[MODEL-A\]/, 'and the previously-covered terms still redact');
  });

  it('citedSources are NEVER redacted — repo source at a fixed sha carries no arm signal', () => {
    const row = buildBlindRow({
      worksheetRowId: 'w1', detail: 'x', severity: 'HIGH',
      citedSources: [{ path: 'scripts/lib/model-resolver.mjs', sha: 'abc', resolved: true, content: "'claude-opus-4-8', 'gemini-pro-latest'" }],
    }, redact);
    assert.match(row.citedSources[0].content, /claude-opus-4-8/,
      'redacting the tree would corrupt the very evidence the adjudicator exists to read');
  });
});

// ── worksheet identity + the HMAC key lifecycle ─────────────────────────────

describe('worksheet identity', () => {
  it('is one-way and stable for a given key', () => {
    const a = worksheetRowIdFor('finding-1', KEY);
    assert.equal(a, worksheetRowIdFor('finding-1', KEY));
    assert.notEqual(a, worksheetRowIdFor('finding-2', KEY));
    assert.ok(!a.includes('finding-1'), 'the row id must not carry the finding id');
    assert.notEqual(a, worksheetRowIdFor('finding-1', 'b'.repeat(64)), 'a different key gives different ids');
  });

  it('an absent key is a hard refusal, never a regenerated one', () => {
    const ref = hmacKeyRefFor('final-review-2026q3');
    assert.equal(ref, 'CAMPAIGN_HMAC_KEY_FINAL_REVIEW_2026Q3');
    assert.throws(() => requireCampaignHmacKey('final-review-2026q3', {}), /is not set/);
    // The refusal must SAY why regenerating is wrong, or the next operator does it.
    assert.throws(() => requireCampaignHmacKey('x', {}), /orphan every human disposition/);
    assert.equal(requireCampaignHmacKey('final-review-2026q3', { [ref]: KEY }), KEY);
  });
});

// ── §2.5c.5 — the deterministic calibration sample ──────────────────────────

describe('calibration sample', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ worksheetRowId: worksheetRowIdFor(`f${i}`, KEY), armId: i % 2 === 0 ? 'opus' : 'kimi' }));

  it('is a per-row property — inclusion does not change as the campaign grows', () => {
    const at10 = assignCalibrationSample(rows.slice(0, 10), { campaignId: 'c', key: KEY, rate: 0.2, minPerArm: 0 });
    const at40 = assignCalibrationSample(rows, { campaignId: 'c', key: KEY, rate: 0.2, minPerArm: 0 });
    for (const r of rows.slice(0, 10)) {
      assert.equal(at10.get(r.worksheetRowId), at40.get(r.worksheetRowId),
        'a top-N sort would churn here and overwrite human review work already done');
    }
  });

  it('is reproducible across machines from the key alone', () => {
    const id = rows[0].worksheetRowId;
    assert.equal(calibrationScore(id, 'c', KEY), calibrationScore(id, 'c', KEY));
    assert.equal(isCalibrationSelected(id, 'c', KEY, 1.0), true, 'rate 1.0 selects everything');
    assert.equal(isCalibrationSelected(id, 'c', KEY, 0.0), false, 'rate 0 selects nothing');
  });

  // NOTE the name: it asserts the per-arm MINIMUM is reached, nothing about
  // monotonicity. An earlier name ("the top-up only ever ADDS") claimed the
  // property the test below proves FALSE of this function — a test whose name
  // outran its assertions, which is the false-green shape this suite exists to
  // avoid. Monotonicity is a store property; see the live half.
  it('tops up to the per-arm minimum even when the filter selects nothing', () => {
    const assigned = assignCalibrationSample(rows, { campaignId: 'c', key: KEY, rate: 0.0 });
    for (const armId of ['opus', 'kimi']) {
      const n = rows.filter((r) => r.armId === armId && assigned.get(r.worksheetRowId)).length;
      assert.equal(n, CALIBRATION_MIN_PER_ARM, `${armId} must reach the minimum even at rate 0`);
    }
    const atRate = assignCalibrationSample(rows, { campaignId: 'c', key: KEY, rate: 0.5 });
    for (const r of rows) {
      if (assigned.get(r.worksheetRowId) && isCalibrationSelected(r.worksheetRowId, 'c', KEY, 0.5)) {
        assert.equal(atRate.get(r.worksheetRowId), true);
      }
    }
  });

  it('the TOP-UP is population-dependent, and pretending otherwise is the trap', () => {
    // Pinned as a limitation, not a bug: an exact per-arm minimum is a RANK over
    // the current population, so a lower-scoring arrival displaces a previously
    // topped-up row. No implementation of "exactly 5 lowest" can be
    // population-independent. This test exists so the incompatibility stays
    // visible — the plan asserted both properties of this function, and only the
    // filter half is true here.
    const at8 = assignCalibrationSample(rows.slice(0, 8), { campaignId: 'c', key: KEY, rate: 0.2 });
    const at12 = assignCalibrationSample(rows.slice(0, 12), { campaignId: 'c', key: KEY, rate: 0.2 });
    const dropped = [...at8].filter(([id, was]) => was && at12.get(id) !== true);
    assert.ok(dropped.length > 0,
      'if this ever passes with 0 drops, the top-up changed shape — re-derive which layer owns monotonicity');
    // The property that protects human work is enforced by the STORE
    // (`calibration_assigned OR EXCLUDED.calibration_assigned`), asserted in the
    // live half: "re-running the worksheet ... never lowers a calibration
    // assignment". Placed there because that is where it actually holds.
  });

  it('is deterministic given a population — two computations never disagree', () => {
    const a = assignCalibrationSample(rows, { campaignId: 'c', key: KEY, rate: 0.2 });
    const b = assignCalibrationSample([...rows].reverse(), { campaignId: 'c', key: KEY, rate: 0.2 });
    for (const [id, v] of a) assert.equal(b.get(id), v, `row ${id} depended on input ORDER`);
  });

  it('an arm with fewer rows than the minimum has ALL of them assigned', () => {
    const thin = [{ worksheetRowId: 'a', armId: 'thin' }, { worksheetRowId: 'b', armId: 'thin' }];
    const assigned = assignCalibrationSample(thin, { campaignId: 'c', key: KEY, rate: 0 });
    assert.equal([...assigned.values()].filter(Boolean).length, 2);
  });

  it('is stratified — a lopsided arm cannot be under-sampled', () => {
    const lopsided = [
      ...Array.from({ length: 60 }, (_, i) => ({ worksheetRowId: `big${i}`, armId: 'big' })),
      ...Array.from({ length: 6 }, (_, i) => ({ worksheetRowId: `small${i}`, armId: 'small' })),
    ];
    const assigned = assignCalibrationSample(lopsided, { campaignId: 'c', key: KEY, rate: 0.05 });
    const small = lopsided.filter((r) => r.armId === 'small' && assigned.get(r.worksheetRowId)).length;
    assert.ok(small >= CALIBRATION_MIN_PER_ARM, `the thin arm got ${small}, below the per-arm floor`);
  });
});

// ── the verdict contract ────────────────────────────────────────────────────

describe('adjudication verdict', () => {
  const evidence = { path: 'a.mjs', sha: 'abc', lineRange: '10-12', quotedSpan: 'x', absenceReason: null };

  it('a verified verdict lacking evidence is DOWNGRADED, never warned-and-kept', () => {
    const r = normaliseVerdict({
      worksheetRowId: 'w1', method: 'verified', outcome: 'accepted', confidence: 0.9,
      evidence: { path: null, sha: null, lineRange: null, quotedSpan: null, absenceReason: null },
    }, { worksheetRowId: 'w1' });
    assert.equal(r.ok, true);
    assert.equal(r.verdict.method, 'unverifiable');
    assert.equal(r.verdict.outcome, 'needs_triage');
    assert.match(r.downgraded, /lacked evidence/);
  });

  it('a dismissal without an absenceReason is downgraded too', () => {
    const r = normaliseVerdict({
      worksheetRowId: 'w1', method: 'verified', outcome: 'dismissed', confidence: 0.9,
      evidence: { ...evidence, absenceReason: null },
    }, { worksheetRowId: 'w1' });
    assert.equal(r.verdict.method, 'unverifiable');
  });

  it('a well-evidenced verdict survives intact', () => {
    const r = normaliseVerdict({ worksheetRowId: 'w1', method: 'verified', outcome: 'accepted', confidence: 0.9, evidence }, { worksheetRowId: 'w1' });
    assert.equal(r.verdict.method, 'verified');
    assert.equal(r.downgraded, null);
    assert.equal(routesToHumanQueue(r.verdict), false);
  });

  it('a mismatched worksheetRowId is REJECTED — it would file a verdict against the wrong finding', () => {
    const r = normaliseVerdict({ worksheetRowId: 'other', method: 'verified', outcome: 'accepted', confidence: 1, evidence }, { worksheetRowId: 'w1' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /mismatch/);
  });

  it('a malformed response is rejected, never a silent pending', () => {
    assert.equal(normaliseVerdict({ nonsense: true }, { worksheetRowId: 'w1' }).ok, false);
    assert.equal(normaliseVerdict(null, { worksheetRowId: 'w1' }).ok, false);
    // `.strict()`: an unknown key means the model answered a different contract.
    assert.equal(normaliseVerdict({ worksheetRowId: 'w1', method: 'verified', outcome: 'accepted', confidence: 1, evidence, extra: 1 }, { worksheetRowId: 'w1' }).ok, false);
  });

  it('unverifiable and needs_triage both route to the human queue', () => {
    assert.equal(routesToHumanQueue({ method: 'unverifiable', outcome: 'accepted' }), true);
    assert.equal(routesToHumanQueue({ method: 'verified', outcome: 'needs_triage' }), true);
  });

  it('the schema admits only the two methods — `judgement` is not auto-recordable', () => {
    assert.equal(AdjudicationVerdictSchema.safeParse({ worksheetRowId: 'w', method: 'judgement', outcome: 'accepted', confidence: 1, evidence }).success, false);
  });

  it('the adjudicator is offered exactly ONE tool, and it cannot be quietly granted more', () => {
    // Tool policy is explicitly none-but-this: retrieval happens in the CLI,
    // where it is bounded, sensitive-path-gated and reproducible from the
    // receipt. A `git show` tool here would be an unbounded unlogged read loop
    // inside a spend-bearing blind adjudication.
    assert.equal(ADJUDICATION_TOOL.name, 'record_verdict');
    assert.equal(ADJUDICATION_TOOL.input_schema.additionalProperties, false);
    const src = fs.readFileSync('scripts/campaign.mjs', 'utf-8');
    const tools = src.match(/tools:\s*\[([^\]]*)\]/g) ?? [];
    assert.deepEqual(tools, ['tools: [ADJUDICATION_TOOL]'], 'only one tool list, holding only the verdict tool');
    assert.ok(!/tool_choice:\s*\{\s*type:\s*'auto'/.test(src), 'the tool call must stay forced');
  });
});

// ── self_family ─────────────────────────────────────────────────────────────

describe('self_family', () => {
  it('is family-level, and unknown is null rather than a confident false', () => {
    assert.equal(isSelfFamily('claude-opus-4-8', 'claude-opus'), true);
    assert.equal(isSelfFamily('claude-opus-4-8', 'moonshotai/kimi-k2-thinking'), false);
    assert.equal(isSelfFamily('moonshotai/kimi-k2', 'moonshotai/other'), true);
    assert.equal(isSelfFamily(null, 'claude-opus'), null);
    assert.equal(isSelfFamily('claude-opus', null), null);
  });
});

// ── clustering refusals ─────────────────────────────────────────────────────

describe('clustering', () => {
  const opts = { threshold: 0.14, coverageFloor: 0.6 };

  it('REFUSES a snapshot whose findings cite no resolvable file path', () => {
    // Plan-mode findings cite §-sections, so the file-set prefilter can never
    // fire — the matcher is not an instrument for that comparison, and writing
    // a cluster set anyway would revert to "unique means total".
    const res = clusterSnapshotFindings([
      { findingId: 'f1', armId: 'a', section: '§0.3 (Activation Addendum)', category: 'X', detail: 'd', severity: 'HIGH' },
      { findingId: 'f2', armId: 'b', section: '§6.1', category: 'X', detail: 'd', severity: 'HIGH' },
    ], opts);
    assert.equal(res.coverage, 'unknown');
    assert.deepEqual(res.clusters, []);
    assert.match(res.reason, /cannot fire/);
  });

  it('an empty snapshot is unknown, not a measured zero', () => {
    assert.equal(clusterSnapshotFindings([], opts).coverage, 'unknown');
  });

  it('merges the same defect across arms and leaves distinct defects apart', () => {
    const res = clusterSnapshotFindings([
      { findingId: 'f1', armId: 'a', section: 'scripts/x.mjs:10', category: 'Backend', detail: 'the cost column sums only live rows so a superseded attempt vanishes', severity: 'HIGH' },
      { findingId: 'f2', armId: 'b', section: 'scripts/x.mjs:11', category: 'Backend', detail: 'superseded attempt rows are excluded from the cost column sum', severity: 'HIGH' },
      { findingId: 'f3', armId: 'b', section: 'scripts/y.mjs:1', category: 'Frontend', detail: 'the heading order is wrong on the standings pane', severity: 'MEDIUM' },
    ], opts);
    assert.notEqual(res.coverage, 'unknown');
    const sizes = res.clusters.map((c) => c.members.length).sort();
    assert.deepEqual(sizes, [1, 2], 'two arms describing one defect are one cluster; the unrelated finding is its own');
  });

  it('WITHIN-arm duplicates are merged — the anti-inflation rule §2.5c-i states', () => {
    // It was prose beside a loop that could not enforce it: clustering iterated
    // `i < k` over DISTINCT arms, so two findings from one arm could only merge
    // via a transitive bridge through a third. Measured: two byte-identical
    // findings from one arm produced 2 clusters at every threshold 0.00–0.50.
    const dup = 'the cost column sums only live rows so a superseded attempt vanishes';
    const rows = [
      { findingId: 'f1', armId: 'opus', section: 'scripts/x.mjs', category: 'Backend', detail: dup, severity: 'HIGH' },
      { findingId: 'f2', armId: 'opus', section: 'scripts/x.mjs', category: 'Backend', detail: dup, severity: 'HIGH' },
    ];
    const merged = clusterSnapshotFindings(rows, { ...opts, withinArmThreshold: 0.35 });
    assert.equal(merged.clusters.length, 1, 'a verbose arm must not inflate itself');
    assert.equal(merged.clusters[0].members.length, 2);

    // NEGATIVE CONTROL: without the within-arm threshold the duplicate survives,
    // so the assertion above is the new pass doing work — not the cross-arm loop
    // happening to catch it.
    const unmerged = clusterSnapshotFindings(rows, { ...opts, withinArmThreshold: null });
    assert.equal(unmerged.clusters.length, 2);
  });

  it('within-arm uses its OWN threshold — the cross-model cutoff would over-merge', () => {
    // Two DISTINCT defects from one arm in one file. They share category, path
    // and house style, so at the cross-model cutoff (0.14, driven down by ~17%
    // cross-vocabulary overlap) they merge — under-counting the arm, which is
    // the inverse of the inflation the rule targets.
    const rows = [
      { findingId: 'f1', armId: 'opus', section: 'scripts/x.mjs', category: 'Backend', detail: 'the cost column sums only live rows so a superseded attempt vanishes from the total', severity: 'HIGH' },
      { findingId: 'f2', armId: 'opus', section: 'scripts/x.mjs', category: 'Backend', detail: 'the retry path claims an exclusive receipt and never releases it on a crash', severity: 'HIGH' },
    ];
    assert.equal(clusterSnapshotFindings(rows, { ...opts, withinArmThreshold: 0.14 }).clusters.length, 1,
      'control: at the CROSS threshold these two distinct defects wrongly merge');
    assert.equal(clusterSnapshotFindings(rows, { ...opts, withinArmThreshold: 0.35 }).clusters.length, 2,
      'at the within-arm threshold they stay distinct');
  });

  it('is deterministic — two runs over one snapshot produce identical clusters', () => {
    const rows = [
      { findingId: 'f1', armId: 'a', section: 'scripts/x.mjs:10', category: 'B', detail: 'the same defect described one way', severity: 'HIGH' },
      { findingId: 'f2', armId: 'b', section: 'scripts/x.mjs:10', category: 'B', detail: 'the same defect described one way', severity: 'HIGH' },
    ];
    assert.deepEqual(clusterSnapshotFindings(rows, opts), clusterSnapshotFindings([...rows].reverse(), opts));
  });
});