/**
 * Tier 1 + Tier 2 — the campaign adjudication protocol (Phase 3).
 *
 * Plan: docs/plans/model-comparison-campaigns.md §2.5c, §9 cases 6 + 7, §7a.
 *
 * Two halves, and the split is deliberate:
 *
 *  - **Pure** (always runs): the blind DTO whitelist, the redactor and its leak
 *    canary, the calibration sample's stability, cited-source resolution, the
 *    verdict downgrade rules, and the cluster refusal.
 *  - **Live** (runs under `db:suites:gate`, gated on `AUDIT_DB_TEST_URL` +
 *    `assertDisposableDbUrl`): the claims that are only settleable against a
 *    real schema — "the blind query never returns `source_model`", "an override
 *    is append-only", "`self_family` is computed store-side". Asserting those
 *    from source text would prove a habit, not a behaviour. INC-002's loopback
 *    allowlist is what keeps the destructive-adjacent half off a production DSN.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BLIND_ROW_FIELDS, buildBlindRow, buildModelRedactor, worksheetRowIdFor,
  calibrationScore, isCalibrationSelected, assignCalibrationSample, isSelfFamily,
  hmacKeyRefFor, requireCampaignHmacKey, CALIBRATION_MIN_PER_ARM,
} from '../scripts/lib/store/campaign.mjs';
import {
  centredWindow, citedLineOf, resolveCitedSources, clusterSnapshotFindings,
  normaliseVerdict, routesToHumanQueue, ADJUDICATION_TOOL, AdjudicationVerdictSchema,
  classifyLogEntry, detailAnchors, anchorLine, resolvePromotionAttempt,
} from '../scripts/campaign.mjs';
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
  const redact = buildModelRedactor({
    armIds: REAL_CONFIG.arms.map((a) => a.id),
    armModels: REAL_CONFIG.arms.map((a) => a.model),
  });

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
    const short = buildModelRedactor({ armIds: ['a'], armModels: [] });
    assert.equal(short('a caching layer already allocates'), '[ARM] caching layer already [MODEL-A]llocates'.replace('[MODEL-A]llocates', 'allocates'),
      'ordinary words containing the letter must survive');
    assert.match(short('arm a failed'), /\[ARM\]/, 'the standalone arm id is still redacted');
    assert.ok(!short('a caching layer already allocates').includes('[ARM] c[ARM]ching'), 'no intra-word rewriting');
  });

  it('EVERY arm id is token-boundaried, whatever its length', () => {
    // The split is by KIND, not length. An arm id is a discrete label that
    // appears as a whole word; a three-character one has no more business
    // rewriting the inside of a word than a one-character one does.
    const r = buildModelRedactor({ armIds: ['abc'], armModels: [] });
    assert.equal(r('the abcdef helper'), 'the abcdef helper', 'a 3-char arm id must not match mid-word');
    assert.match(r('arm abc failed'), /\[ARM\]/, 'but still redacts standing alone');
  });

  it('a long model id embedded in a longer token still redacts', () => {
    const r = buildModelRedactor({ armIds: [], armModels: ['claude-opus'] });
    assert.ok(!r('running claude-opus-4-8-preview here').includes('claude-opus'));
  });

  it('a SHORT arm MODEL is redacted, not dropped for being short', () => {
    // The length floor is a readability heuristic for the ambient catalogue. It
    // must never decide whether THIS campaign's own arms are blind — and it did:
    // a two-character model id (which the schema permits) fell through the
    // `>= MIN_REDACTABLE_TERM` filter and stayed visible in the worksheet.
    const r = buildModelRedactor({ armIds: [], armModels: ['g5'] });
    assert.ok(!r('the g5 model found it').includes(' g5 '), 'a short arm model leaked');
    assert.match(r('the g5 model found it'), /\[MODEL-A\]/);
    assert.equal(r('a g5x identifier'), 'a g5x identifier', 'and it is boundary-guarded, not shredding longer tokens');
  });

  it('a provider NAME the resolver knows is redacted, not just its model ids', () => {
    // `flattenPool` walks values only, so the pool KEYS — google, openai,
    // anthropic — were absent from the term set: "gemini" redacted while
    // "Google's model" passed through. Half a vocabulary reads as a whole one.
    const r = buildModelRedactor({ armIds: ['opus'], armModels: ['claude-opus'] });
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

// ── cited sources ───────────────────────────────────────────────────────────

describe('cited sources', () => {
  const content = Array.from({ length: 1000 }, (_, i) => `line${i + 1}`).join('\n');

  it('the window is CENTRED on the cited line, not taken from the top', () => {
    // The failure this prevents: an arm correctly finds a defect at line 800 of
    // a file truncated at 500, the adjudicator sees a file without it, and the
    // arm is penalised for being right.
    const win = centredWindow(content, 800, 240);
    assert.ok(win.startLine < 800 && win.endLine > 800, `line 800 must be inside [${win.startLine}, ${win.endLine}]`);
    assert.equal(win.startLine, 680);
    assert.match(win.text, /^line680\n/);
    assert.equal(win.truncated, true);
  });

  it('a SINGLE line longer than the whole budget is CUT — the bound is a bound', () => {
    // The first version kept an oversized first line whole (`&& kept.length > 0`
    // on the break), so one minified line bypassed the ceiling entirely:
    // measured at 500,000 characters through a 24,000 budget. A limit with an
    // exception for the common bad case is not a limit.
    const one = 'x'.repeat(500000);
    const win = centredWindow(one, 1, 240, 24000);
    // `<= 24000` exactly, with no tolerance. An earlier version of this
    // assertion allowed `+ 120` to accommodate the truncation marker — a test
    // written around the bug rather than against it. The marker is paid for out
    // of the budget, so the ceiling holds for the WHOLE returned string.
    assert.ok(win.text.length <= 24000, `single line escaped the budget at ${win.text.length} chars`);
    assert.equal(win.truncated, true);
    assert.match(win.text, /truncated: single line exceeds/, 'and it says so, rather than silently losing the tail');

    // The ceiling holds at EVERY budget, including ones smaller than the
    // truncation marker itself — where reserving room for the marker still
    // overflows, because `room` clamps to 0 and the marker is appended anyway.
    // An exported function has to survive the degenerate arguments it is handed.
    for (const budget of [80, 40, 10, 1]) {
      const win2 = centredWindow(one, 1, 240, budget);
      assert.ok(win2.text.length <= budget, `budget ${budget} produced ${win2.text.length} chars`);
    }

    // A budget that merely LOOKS numeric must not disable the bound. `NaN`
    // defeats every comparison silently (`len <= NaN` is false), so an
    // unvalidated parameter is a bound a caller can switch off by accident.
    for (const bogus of [NaN, Infinity, -1, 0, undefined, null]) {
      const win3 = centredWindow(one, 1, 240, bogus);
      assert.ok(win3.text.length <= 24000, `budget ${String(bogus)} produced ${win3.text.length} chars`);
    }
  });

  it('the window is bounded by CHARACTERS as well as lines', () => {
    // 240 lines of a minified file is megabytes, and every character is paid
    // for on a spend-bearing call. A line budget is not a byte budget.
    const wide = Array.from({ length: 50 }, () => 'x'.repeat(5000)).join('\n');
    const win = centredWindow(wide, 1, 240, 24000);
    assert.ok(win.text.length <= 24000, `excerpt was ${win.text.length} chars`);
    assert.equal(win.truncated, true, 'a char-clamped excerpt is truncated, whatever the line count says');
    assert.ok(win.endLine < 50, 'endLine must follow the clamp, not the pre-clamp window');
  });

  it('recovers an anchor from the finding prose — the cited line is absent on EVERY real row', () => {
    // Measured 2026-08-10 against the live store: primary_file carries a :line
    // in 0 of 3993 rows, because recordFindings stores `_primaryFile || section`
    // and the resolved bare path wins. Without a prose anchor the centring
    // mitigation is inert in production while its test passes on a synthetic
    // section — a mitigation that reads as covered and never fires.
    const anchors = detailAnchors('The `resolveNextAttempt` helper wedges when store.maxArmRunAttempt returns 0.');
    assert.ok(anchors.includes('resolveNextAttempt'), `got ${JSON.stringify(anchors)}`);
    assert.ok(anchors.includes('store.maxArmRunAttempt'));
    assert.ok(!anchors.includes('The'), 'ordinary words are not anchors');

    const content = `${'filler\n'.repeat(600)}function resolveNextAttempt() {}\n${'more\n'.repeat(600)}`;
    const hit = anchorLine(content, anchors);
    assert.equal(hit.anchor, 'resolveNextAttempt');
    assert.equal(hit.line, 601);
  });

  it('an anchor is matched LITERALLY — model prose never becomes a regex', () => {
    // The detail is model-authored and arrives unvalidated; compiling it would
    // be an injection surface and a catastrophic-backtracking one.
    assert.equal(anchorLine('a.b.c', ['a.b.c']).line, 1);
    assert.equal(anchorLine('axbxc', ['a.b.c']), null, 'the dot must not match any character');
  });

  it('each cited path gets its OWN line — one path\'s line is never applied to another', () => {
    const seen = [];
    const res = resolveCitedSources({
      section: 'scripts/a.mjs:800 and scripts/b.mjs:5',
      detail: '', auditedSha: 'HEAD',
      show: (_root, _sha, p) => { seen.push(p); return { ok: true, content: Array.from({ length: 1000 }, (_, i) => `${p}-line${i + 1}`).join('\n') }; },
    });
    const a = res.sources.find((s) => s.path === 'scripts/a.mjs');
    const b = res.sources.find((s) => s.path === 'scripts/b.mjs');
    assert.ok(a.startLine < 800 && a.endLine > 800, `a centred on ${a.startLine}-${a.endLine}, not on 800`);
    assert.ok(b.startLine <= 5 && b.endLine > 5, `b centred on ${b.startLine}-${b.endLine}, not on 5`);
    assert.equal(a.anchorKind, 'cited-line');
    assert.equal(b.anchorKind, 'cited-line');
  });

  it('names WHICH anchor produced the window, so a head window is never ambiguous', () => {
    const long = Array.from({ length: 1000 }, (_, i) => (i === 700 ? 'const targetSymbol = 1;' : `pad${i}`)).join('\n');
    const viaDetail = resolveCitedSources({
      section: 'scripts/a.mjs', detail: 'the `targetSymbol` constant is wrong', auditedSha: 'HEAD',
      show: () => ({ ok: true, content: long }),
    });
    assert.equal(viaDetail.sources[0].anchorKind, 'detail-anchor');
    assert.equal(viaDetail.sources[0].anchor, 'targetSymbol');
    assert.ok(viaDetail.sources[0].startLine <= 701 && viaDetail.sources[0].endLine >= 701);

    const viaHead = resolveCitedSources({
      section: 'scripts/a.mjs', detail: 'nothing nameable here', auditedSha: 'HEAD',
      show: () => ({ ok: true, content: long }),
    });
    assert.equal(viaHead.sources[0].anchorKind, 'head', '"found nothing" must be distinguishable from "small file"');
    assert.equal(viaHead.sources[0].truncated, true, 'and a head window on a long file is honestly truncated');
  });

  it('a file that fits is not marked truncated', () => {
    const win = centredWindow('a\nb\nc', null, 240);
    assert.equal(win.truncated, false);
    assert.equal(win.endLine, 3);
  });

  it('reads the cited line out of a section reference', () => {
    assert.equal(citedLineOf('scripts/a.mjs:120'), 120);
    assert.equal(citedLineOf('scripts/a.mjs'), null);
    assert.equal(citedLineOf(null), null);
  });

  it('resolves a real file at a real revision, and reports resolvedAny honestly', () => {
    const fake = () => ({ ok: false, error: { code: 'BAD_REVISION' } });
    const none = resolveCitedSources({ section: 'scripts/campaign.mjs:10', auditedSha: 'deadbeef', show: fake });
    assert.equal(none.resolvedAny, false, 'an all-fail row must be forced to unverifiable BEFORE any provider call');
    assert.equal(none.sources[0].resolved, false);

    const ok = resolveCitedSources({
      section: 'scripts/campaign.mjs:10', auditedSha: 'HEAD',
      show: () => ({ ok: true, content: 'a\nb\nc' }),
    });
    assert.equal(ok.resolvedAny, true);
    assert.equal(ok.sources[0].path, 'scripts/campaign.mjs');
  });

  it('a sensitive path is refused and MARKED, never read', () => {
    let read = 0;
    const res = resolveCitedSources({
      section: 'secrets/config.mjs:3', auditedSha: 'HEAD', show: () => { read += 1; return { ok: true, content: 'SECRET=1' }; },
    });
    assert.equal(read, 0, 'the egress seam must not even fetch it');
    assert.equal(res.resolvedAny, false);
    assert.equal(res.sources[0]?.reason, 'sensitive-path');
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

// ── receipt-name parsing (consolidated gate G1) ─────────────────────────────

describe('receipt filename parsing', () => {
  it('round-trips an arm id containing a DOUBLE hyphen', async () => {
    // `solo--opus` is a legal arm id (`^[a-z0-9][a-z0-9-]*$`), and a greedy
    // parse read it as snapshotId="abcdef123456--solo", armId="opus". Both then
    // fail the caller's equality check, the receipt is SILENTLY skipped,
    // maxAttemptOnDisk returns 0, and every later run collides on `wx` — the
    // permanent wedge resolveNextAttempt exists to prevent, with the worst
    // possible symptom.
    const lock = await import('../scripts/lib/campaign/lock.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-'));
    const args = { campaignId: 'c1', cohortDigest: 'd1', snapshotId: 'abcdef123456', armId: 'solo--opus', repoRoot: root };
    const claim = lock.claimReceipt({ ...args, attempt: 1 });
    assert.equal(claim.ok, true);

    const max = lock.maxAttemptOnDisk(args);
    assert.equal(max, 1, 'the receipt just written must be visible to the disk scan');
    assert.equal(lock.resolveNextAttempt({ ...args, dbMaxAttempt: 0 }), 2, 'a wedge would resolve 1 forever');

    const scanned = lock.scanReceipts('c1', { repoRoot: root });
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].snapshotId, 'abcdef123456');
    assert.equal(scanned[0].armId, 'solo--opus');
    assert.equal(scanned[0].attempt, 1);
  });

  it('still parses the ordinary single-hyphen arm id', async () => {
    const lock = await import('../scripts/lib/campaign/lock.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt2-'));
    const args = { campaignId: 'c1', cohortDigest: 'd1', snapshotId: 'abcdef123456', armId: 'solo-opus', repoRoot: root };
    lock.claimReceipt({ ...args, attempt: 3 });
    const scanned = lock.scanReceipts('c1', { repoRoot: root });
    assert.equal(scanned[0].armId, 'solo-opus');
    assert.equal(scanned[0].attempt, 3);
  });
});

// ── promotion: the producer for the arm-run spine ───────────────────────────

describe('bake-off log promotion', () => {
  const ctx = { campaignId: 'camp', lockDigest: 'lock1', shaByRunId: { r1: 'abc123', r2: 'abc123', r3: 'def456' } };

  it('promotes a well-formed entry and derives audited_sha from the arms\' runs', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1', transcript: 't.json',
      arms: { opus: { runId: 'r1', costUsd: 1.5 }, kimi: { runId: 'r2', costUsd: 0.4 } },
    }, ctx);
    assert.equal(cls.eligible, true);
    assert.equal(cls.auditedSha, 'abc123');
    assert.deepEqual(cls.armRuns.map((a) => [a.armId, a.costStatus]), [['opus', 'priced'], ['kimi', 'priced']]);
  });

  it('an entry with no lockDigest is INELIGIBLE — never adopted into the current cohort', () => {
    // This is the five-false-greens rule: evidence collected under an unknown
    // contract cannot be relabelled into a cohort it was not produced under.
    const cls = classifyLogEntry({ snapshotId: 's1', campaignId: 'camp', arms: { opus: { runId: 'r1' } } }, ctx);
    assert.equal(cls.eligible, false);
    assert.match(cls.reason, /unknown contract/);
  });

  it('an entry under a SUPERSEDED lock is its own cohort, not this one', () => {
    const cls = classifyLogEntry({ snapshotId: 's1', campaignId: 'camp', lockDigest: 'oldlock', arms: { opus: { runId: 'r1' } } }, ctx);
    assert.equal(cls.eligible, false);
    assert.match(cls.reason, /superseded lock oldlock/);
  });

  it('arms disagreeing about the commit are not one snapshot', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1',
      arms: { opus: { runId: 'r1' }, kimi: { runId: 'r3' } },
    }, ctx);
    assert.equal(cls.eligible, false);
    assert.match(cls.reason, /one snapshot is one revision/);
  });

  it('an unresolvable revision is ineligible, never promoted with a guessed sha', () => {
    const cls = classifyLogEntry({ snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1', arms: { opus: { runId: 'unknown' } } }, ctx);
    assert.equal(cls.eligible, false);
    assert.match(cls.reason, /unadjudicatable/);
  });

  it('a missing cost is UNPRICED, never 0 — an unrecorded charge must not read as free', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1',
      arms: { opus: { runId: 'r1' }, kimi: { runId: 'r2', costUsd: 0 } },
    }, ctx);
    assert.deepEqual(cls.armRuns.map((a) => [a.armId, a.costUsd, a.costStatus]),
      [['opus', null, 'unpriced'], ['kimi', 0, 'priced']],
      'a genuinely measured 0 stays priced; an ABSENT cost is unpriced');
  });

  it('an errored arm still promotes, carrying its error — a silent gap is never allowed', () => {
    const cls = classifyLogEntry({
      snapshotId: 's1', campaignId: 'camp', lockDigest: 'lock1',
      arms: { opus: { runId: 'r1', costUsd: 1 }, kimi: { error: 'exit 1' } },
    }, ctx);
    assert.equal(cls.eligible, true);
    assert.equal(cls.armRuns.find((a) => a.armId === 'kimi').error, 'exit 1');
  });
});

// ── --force promotion (gap 2) ───────────────────────────────────────────────

describe('promotion attempt resolution (--force)', () => {
  it('first promotion is attempt 1 and supersedes nothing', () => {
    assert.deepEqual(resolvePromotionAttempt({ existingAttempt: 0, forced: false }),
      { skip: false, attempt: 1, supersedePrior: false });
  });

  it('re-running reconcile on an already-promoted arm SKIPS — idempotence, not a second charge', () => {
    assert.deepEqual(resolvePromotionAttempt({ existingAttempt: 1, forced: false }),
      { skip: true, attempt: 1, supersedePrior: false });
  });

  it('a FORCED re-collection appends attempt N+1 and supersedes the prior live row', () => {
    // Never an overwrite: the earlier attempt stays readable and its spend still
    // counts, which is exactly why armSpend sums superseded rows. Before --force
    // existed this branch was unreachable, so the attempt column, the partial
    // unique index and the receipt-attempt protocol were machinery no operator
    // action could trigger.
    assert.deepEqual(resolvePromotionAttempt({ existingAttempt: 1, forced: true }),
      { skip: false, attempt: 2, supersedePrior: true });
    assert.deepEqual(resolvePromotionAttempt({ existingAttempt: 4, forced: true }),
      { skip: false, attempt: 5, supersedePrior: true });
  });

  it('a garbage attempt count is treated as none, never as a negative attempt', () => {
    for (const bogus of [null, undefined, -3, NaN, 'two']) {
      assert.deepEqual(resolvePromotionAttempt({ existingAttempt: bogus, forced: true }),
        { skip: false, attempt: 1, supersedePrior: false });
    }
  });
});

// ── LIVE: the claims only a real schema can settle ──────────────────────────

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (runs under npm run db:suites:gate)';

describe('campaign store against a live schema', { skip }, () => {
  let client; let store; let ids = {};
  let savedUrl;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest, getPool } = await import('../scripts/lib/db/client.mjs');
    savedUrl = process.env.AUDIT_DB_URL;
    // Fail-closed BEFORE any connection — the loopback allowlist is what keeps
    // this suite off a production DSN (INC-002).
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    client = await getPool();
    store = await import('../scripts/lib/store/campaign.mjs');

    const repo = await client.query("INSERT INTO audit_repos (name) VALUES ('campaign-test-repo') RETURNING id");
    ids.repoId = repo.rows[0].id;
    const mkRun = async () => (await client.query(
      "INSERT INTO audit_runs (repo_id, plan_file, mode) VALUES ($1, 'docs/plans/x.md', 'code') RETURNING id", [ids.repoId],
    )).rows[0].id;
    ids.runOpus = await mkRun();
    ids.runKimi = await mkRun();

    const mkFinding = async (runId, model, detail) => (await client.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, primary_file, detail_snapshot, source_model)
       VALUES ($1, $2, 'backend', 'HIGH', 'Backend', 'scripts/x.mjs:10', $3, $4) RETURNING id`,
      [runId, `fp-${model}-${detail}`, detail, model],
    )).rows[0].id;
    ids.findingOpus = await mkFinding(ids.runOpus, 'claude-opus-4-8', 'the opus arm found this');
    ids.findingKimi = await mkFinding(ids.runKimi, 'moonshotai/kimi-k2-thinking', 'the kimi arm found this');

    const c = await store.ensureCampaign({ repoId: ids.repoId, campaignKey: 'live-test', configDigest: 'digest1' });
    ids.campaignId = c.id;
    const co = await store.ensureCohort({ campaignId: c.id, lockDigest: 'lock1', resolved: { a: 1 } });
    ids.cohortId = co.id;
    const snap = await store.upsertSnapshot({ cohortId: co.id, snapshotId: 'snapA', auditedSha: 'abc123', transcriptPath: 't.json' });
    ids.snapshotRowId = snap.id;
    for (const [armId, runId] of [['opus', ids.runOpus], ['kimi', ids.runKimi]]) {
      const r = await store.recordArmRun({
        cohortId: co.id, snapshotRowId: snap.id, snapshotId: 'snapA', armId, attempt: 1,
        auditRunId: runId, usage: { input_tokens: 10 }, costUsd: 1.5, costStatus: 'priced',
      });
      ids[`armRun_${armId}`] = r.id;
    }
  });

  after(async () => {
    try {
      const { closePool, _resetForTest } = await import('../scripts/lib/db/client.mjs');
      await closePool();
      await _resetForTest();
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
    }
  });

  it('§9 case 6 — the blind query never returns source_model', async () => {
    const key = KEY;
    const ws = await store.ensureWorksheet({ cohortId: ids.cohortId, hmacKeyRef: 'CAMPAIGN_HMAC_KEY_LIVE_TEST' });
    const rows = [ids.findingOpus, ids.findingKimi].map((f) => ({
      worksheetRowId: worksheetRowIdFor(f, key), findingId: f, calibrationAssigned: true,
    }));
    await store.upsertWorksheetRows(ws.id, rows);
    const blind = await store.loadBlindWorksheet(ws.id, { key, campaignId: 'live-test' });
    assert.equal(blind.rows.length, 2);
    for (const r of blind.rows) {
      assert.ok(!('source_model' in r), 'source_model is structurally absent, not merely unused');
      assert.ok(!('arm_id' in r));
      assert.ok(!('finding_id' in r), 'the agent must not be able to derive the finding id');
    }
    ids.worksheetId = ws.id;
  });

  it('THE monotonicity guarantee lives here: the store ratchets, it never lowers', async () => {
    // The pure `assignCalibrationSample` cannot be population-independent (an
    // exact per-arm minimum is a rank — see its own test). What protects
    // completed human review work is that the PERSISTED assignment only ever
    // goes up, so a later recompute that would have dropped this row cannot
    // discard the human's work.
    const before2 = await store.upsertWorksheetRows(ids.worksheetId, [
      { worksheetRowId: worksheetRowIdFor(ids.findingOpus, KEY), findingId: ids.findingOpus, calibrationAssigned: false },
    ]);
    assert.equal(before2.inserted, 0, 're-running inserts nothing');
    const row = await client.query('SELECT calibration_assigned FROM campaign_worksheet_rows WHERE worksheet_id = $1 AND finding_id = $2', [ids.worksheetId, ids.findingOpus]);
    assert.equal(row.rows[0].calibration_assigned, true, 'a row once assigned is never unassigned');

    // NEGATIVE CONTROL: the column is genuinely writable in the other
    // direction, so the assertion above is the OR clause holding, not a column
    // that simply never changes.
    await client.query('UPDATE campaign_worksheet_rows SET calibration_assigned = FALSE WHERE worksheet_id = $1 AND finding_id = $2', [ids.worksheetId, ids.findingOpus]);
    const lowered = await client.query('SELECT calibration_assigned FROM campaign_worksheet_rows WHERE worksheet_id = $1 AND finding_id = $2', [ids.worksheetId, ids.findingOpus]);
    assert.equal(lowered.rows[0].calibration_assigned, false, 'control: a direct UPDATE can lower it');
    await store.upsertWorksheetRows(ids.worksheetId, [
      { worksheetRowId: worksheetRowIdFor(ids.findingOpus, KEY), findingId: ids.findingOpus, calibrationAssigned: true },
    ]);
    const raised = await client.query('SELECT calibration_assigned FROM campaign_worksheet_rows WHERE worksheet_id = $1 AND finding_id = $2', [ids.worksheetId, ids.findingOpus]);
    assert.equal(raised.rows[0].calibration_assigned, true, 'and the upsert raises it again');
  });

  it('a needs_triage verdict MUST carry method=unverifiable — the constraint, not the convention', async () => {
    // The first draft of this CHECK permitted `method IS NULL`, making
    // provenance-free rows legal while its own comment forbade them.
    await assert.rejects(
      client.query(
        `INSERT INTO finding_adjudication_events (finding_id, adjudication_outcome, remediation_state, round, adjudicator_kind)
         VALUES ($1, 'needs_triage', 'pending', 1, 'human')`, [ids.findingOpus],
      ),
      (err) => /needs_triage_is_unverifiable/.test(err.message),
      'an undecided outcome with no method must be unrepresentable',
    );
    // Positive control: the same row WITH the method is accepted, so the
    // rejection above is the predicate binding rather than the insert being
    // impossible for some unrelated reason.
    const ok = await client.query(
      `INSERT INTO finding_adjudication_events (finding_id, adjudication_outcome, remediation_state, round, adjudicator_kind, method)
       VALUES ($1, 'needs_triage', 'pending', 1, 'human', 'unverifiable') RETURNING id`, [ids.findingOpus],
    );
    assert.ok(ok.rows[0].id);
    await client.query('DELETE FROM finding_adjudication_events WHERE id = $1', [ok.rows[0].id]);
  });

  it('self_family is computed store-side from the unblinded row', async () => {
    await store.recordAgentVerdict({
      findingId: ids.findingOpus, worksheetRowId: worksheetRowIdFor(ids.findingOpus, KEY), worksheetId: ids.worksheetId,
      armRunId: ids.armRun_opus, adjudicatorModel: 'claude-opus-4-8', method: 'verified', outcome: 'accepted',
      evidence: { path: 'scripts/x.mjs' }, selfFamily: isSelfFamily('claude-opus-4-8', 'claude-opus-4-8'),
    });
    await store.recordAgentVerdict({
      findingId: ids.findingKimi, worksheetRowId: worksheetRowIdFor(ids.findingKimi, KEY), worksheetId: ids.worksheetId,
      armRunId: ids.armRun_kimi, adjudicatorModel: 'claude-opus-4-8', method: 'verified', outcome: 'dismissed',
      evidence: { path: 'scripts/x.mjs' }, selfFamily: isSelfFamily('claude-opus-4-8', 'moonshotai/kimi-k2-thinking'),
    });
    const r = await client.query('SELECT finding_id, self_family FROM finding_adjudication_events WHERE adjudicator_kind = $1 ORDER BY finding_id', ['agent']);
    const map = new Map(r.rows.map((x) => [x.finding_id, x.self_family]));
    assert.equal(map.get(ids.findingOpus), true);
    assert.equal(map.get(ids.findingKimi), false);
  });

  it('re-adjudicating supersedes rather than stacking duplicate PAID verdicts', async () => {
    await store.recordAgentVerdict({
      findingId: ids.findingOpus, worksheetRowId: worksheetRowIdFor(ids.findingOpus, KEY), worksheetId: ids.worksheetId,
      armRunId: ids.armRun_opus, adjudicatorModel: 'claude-opus-4-8', method: 'verified', outcome: 'dismissed', selfFamily: true,
    });
    const live = await client.query(
      "SELECT COUNT(*)::int AS n FROM finding_adjudication_events WHERE finding_id = $1 AND adjudicator_kind = 'agent' AND superseded_at IS NULL", [ids.findingOpus],
    );
    assert.equal(live.rows[0].n, 1, 'the partial unique index means exactly one live agent verdict');
    const all = await client.query(
      "SELECT COUNT(*)::int AS n FROM finding_adjudication_events WHERE finding_id = $1 AND adjudicator_kind = 'agent'", [ids.findingOpus],
    );
    assert.equal(all.rows[0].n, 2, 'the superseded verdict stays readable — it was paid for');
  });

  it('§9 case 7 — a human override is append-only and NAMES the verdict it overrides', async () => {
    const beforeIds = (await client.query('SELECT id FROM finding_adjudication_events WHERE finding_id = $1', [ids.findingKimi])).rows.map((r) => r.id);
    const res = await store.recordHumanOverride({ findingId: ids.findingKimi, outcome: 'accepted', note: 'the defect is real', actor: 'louis' });
    assert.equal(res.ok, true);
    const after = await client.query('SELECT id, adjudicator_kind, overrides_event_id, adjudication_outcome FROM finding_adjudication_events WHERE finding_id = $1 ORDER BY created_at', [ids.findingKimi]);
    assert.equal(after.rows.length, beforeIds.length + 1, 'append-only: nothing was replaced');
    for (const id of beforeIds) assert.ok(after.rows.some((r) => r.id === id), 'the original agent verdict survives');
    const override = after.rows.find((r) => r.adjudicator_kind === 'human');
    assert.ok(beforeIds.includes(override.overrides_event_id), 'the override names its target');
    // The agent verdict it names is deliberately NOT superseded — the pair IS
    // the calibration datum.
    const target = await client.query('SELECT superseded_at FROM finding_adjudication_events WHERE id = $1', [override.overrides_event_id]);
    assert.equal(target.rows[0].superseded_at, null);
  });

  it('an override with no agent verdict to name is refused, with a reason', async () => {
    const orphan = (await client.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, detail_snapshot)
       VALUES ($1, 'fp-orphan', 'backend', 'HIGH', 'Backend', 'never adjudicated') RETURNING id`, [ids.runOpus],
    )).rows[0].id;
    const res = await store.recordHumanOverride({ findingId: orphan, outcome: 'accepted' });
    assert.equal(res.ok, false);
    assert.match(res.error, /must NAME the verdict it overrides/);
  });

  it('calibration arithmetic is computed from the paired rows, and a rate over zero verdicts is null', async () => {
    const summary = await store.calibrationSummary(ids.cohortId);
    assert.equal(summary.perArm.kimi.agentVerdicts, 1);
    assert.equal(summary.perArm.kimi.overrides, 1);
    assert.equal(summary.perArm.kimi.overrideRate, 1);
    assert.equal(summary.perArm.kimi.dispositioned, 1);
    assert.equal(summary.perArm.opus.overrides, 0);
    assert.equal(summary.perArm.opus.overrideRate, 0, 'measured zero disagreement');
    assert.equal(summary.perArm.opus.selfFamilyShare, 1);
  });

  it('a snapshot recorded at a different sha is REFUSED, not silently updated', async () => {
    const res = await store.upsertSnapshot({ cohortId: ids.cohortId, snapshotId: 'snapA', auditedSha: 'different', transcriptPath: 't.json' });
    assert.equal(res.ok, false);
    assert.equal(res.conflict, true);
    assert.match(res.error, /adjudication verifies against that sha/);
  });

  it('a --force retry appends an attempt and supersedes the prior live row', async () => {
    const r = await store.recordArmRun({
      cohortId: ids.cohortId, snapshotRowId: ids.snapshotRowId, snapshotId: 'snapA', armId: 'kimi', attempt: 2,
      auditRunId: ids.runKimi, costUsd: 0.5, costStatus: 'priced', supersedePrior: true,
    });
    assert.equal(r.ok, true);
    const rows = (await client.query('SELECT attempt, superseded_at, cost_usd FROM campaign_arm_runs WHERE cohort_id = $1 AND arm_id = $2 ORDER BY attempt', [ids.cohortId, 'kimi'])).rows;
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].superseded_at, null);
    assert.equal(rows[1].superseded_at, null);
    const maxAttempt = await store.maxArmRunAttempt({ cohortId: ids.cohortId, snapshotId: 'snapA', armId: 'kimi' });
    assert.equal(maxAttempt.attempt, 2, 'the DB half of resolveNextAttempt sees the retry');
  });

  it('an unpriced arm-run stores NULL, never 0 — the CHECK makes it unrepresentable', async () => {
    await assert.rejects(
      client.query(
        `INSERT INTO campaign_arm_runs (cohort_id, snapshot_row_id, snapshot_id, arm_id, attempt, cost_usd, cost_status)
         VALUES ($1, $2, 'snapA', 'ghost', 1, 0, 'unpriced')`, [ids.cohortId, ids.snapshotRowId],
      ),
      (err) => /cost_coherent/.test(err.message),
      'an unpriced run carrying a number must be rejected at the schema, not by convention',
    );
  });

  it('campaign_events is append-only, enforced by the trigger', async () => {
    const ev = await store.appendCampaignEvent({ campaignId: ids.campaignId, kind: 'rule_changed', actor: 'louis', detail: { before: 0.5, after: 0.4 } });
    assert.equal(ev.ok, true);
    await assert.rejects(
      client.query('UPDATE campaign_events SET kind = $1 WHERE id = $2', ['tampered', ev.id]),
      (err) => /append-only/.test(err.message),
    );
    await assert.rejects(
      client.query('DELETE FROM campaign_events WHERE id = $1', [ev.id]),
      (err) => /append-only/.test(err.message),
    );
  });

  it('a new lock digest opens a NEW cohort rather than relabelling the old one', async () => {
    const second = await store.ensureCohort({ campaignId: ids.campaignId, lockDigest: 'lock2', resolved: {} });
    assert.notEqual(second.id, ids.cohortId);
    const n = await client.query('SELECT COUNT(*)::int AS n FROM campaign_cohorts WHERE campaign_id = $1', [ids.campaignId]);
    assert.equal(n.rows[0].n, 2, 'orphaned evidence stays readable under its own cohort');
  });

  it('a worksheet under a different key ref is refused — rotation is not supported', async () => {
    const res = await store.ensureWorksheet({ cohortId: ids.cohortId, hmacKeyRef: 'CAMPAIGN_HMAC_KEY_SOMETHING_ELSE' });
    assert.equal(res.ok, false);
    assert.match(res.error, /rotation is not supported/);
  });

  it('adjudication overhead is unknown-honest and never folded into an arm', async () => {
    const wrRow = await store.resolveWorksheetRowAttempt({ worksheetId: ids.worksheetId, worksheetRowId: worksheetRowIdFor(ids.findingOpus, KEY) });
    assert.ok(wrRow.id);
    assert.equal(wrRow.attempt, 0);
    await store.recordAdjudicationAttempt({ worksheetRowUuid: wrRow.id, attempt: 1, status: 'verified', usage: { input_tokens: 5 }, costUsd: 0.02, costStatus: 'priced' });
    let overhead = await store.adjudicationOverhead(ids.cohortId);
    assert.equal(overhead.spendUsd, 0.02);
    assert.equal(overhead.costEvidence, 'known');

    await store.recordAdjudicationAttempt({ worksheetRowUuid: wrRow.id, attempt: 2, status: 'unverifiable', costStatus: 'unpriced' });
    overhead = await store.adjudicationOverhead(ids.cohortId);
    assert.equal(overhead.spendUsd, null, 'one unpriced attempt makes the total unknown, not smaller');
    assert.equal(overhead.costEvidence, 'unknown');
    assert.equal(overhead.attempts, 2, 'both attempts are counted — a superseded attempt was paid for');
  });

  it('the rule recorder writes a baseline, stays silent when unchanged, and appends before/after on a real edit', async () => {
    // §2.5b removes the analysis-time fields from every digest and names
    // `rule_changed` as the substitute protection. That substitute shipped with
    // a READER and no WRITER: verdict.mjs watermarked on an event nothing ever
    // wrote, so editing a cost ceiling recorded nothing.
    const { recordRuleState } = await import('../scripts/campaign.mjs');
    const cfg = { targetN: 12, calibration: { sampleRate: 0.2 }, decisionRule: { floorMargin: 0.5, costCeilingUsdPerAccepted: 8 } };

    // Its OWN campaign, not the suite's shared one. An earlier test appends a
    // `rule_changed` event to prove the append-only trigger, which would make
    // this recorder see a prior rule and take the `changed` branch on its first
    // call — a pass/fail decided by test ORDER rather than by the behaviour
    // under test.
    const own = await store.ensureCampaign({ repoId: ids.repoId, campaignKey: 'rule-recorder-isolated', configDigest: 'd0' });
    const campaignId = own.id;

    const first = await recordRuleState({ config: cfg, campaignId, actor: 'tester' });
    assert.equal(first.kind, 'rule_registered', 'declaring a rule is not moving one');

    const again = await recordRuleState({ config: cfg, campaignId, actor: 'tester' });
    assert.equal(again.kind, 'unchanged', 'an unchanged rule must not append noise');

    const edited = { ...cfg, decisionRule: { ...cfg.decisionRule, costCeilingUsdPerAccepted: 6 } };
    const moved = await recordRuleState({ config: edited, campaignId, actor: 'tester' });
    assert.equal(moved.kind, 'rule_changed');
    assert.equal(moved.before.decisionRule.costCeilingUsdPerAccepted, 8);
    assert.equal(moved.after.decisionRule.costCeilingUsdPerAccepted, 6);

    const rows = (await client.query(
      "SELECT kind FROM campaign_events WHERE campaign_id = $1 AND kind LIKE 'rule%' ORDER BY created_at", [campaignId],
    )).rows.map((r) => r.kind);
    assert.deepEqual(rows, ['rule_registered', 'rule_changed'], 'append-only, and the unchanged call added nothing');
  });

  it('an arm-run with zero findings still appears — a silent arm is not an absent one', async () => {
    const runs = await store.loadCohortArmRuns(ids.cohortId);
    const ghost = runs.rows.filter((r) => r.arm_id === 'kimi');
    assert.equal(ghost.length, 2, 'superseded attempts are included: spend sums all of them');
  });
});
