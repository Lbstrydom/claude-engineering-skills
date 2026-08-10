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

import {
  BLIND_ROW_FIELDS, buildBlindRow, buildModelRedactor, worksheetRowIdFor,
  calibrationScore, isCalibrationSelected, assignCalibrationSample, isSelfFamily,
  hmacKeyRefFor, requireCampaignHmacKey, CALIBRATION_MIN_PER_ARM,
} from '../scripts/lib/store/campaign.mjs';
import {
  centredWindow, citedLineOf, resolveCitedSources, clusterSnapshotFindings,
  normaliseVerdict, routesToHumanQueue, ADJUDICATION_TOOL, AdjudicationVerdictSchema,
  classifyLogEntry,
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

  it('tops up to the per-arm minimum, and the top-up only ever ADDS', () => {
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

  it('is deterministic — two runs over one snapshot produce identical clusters', () => {
    const rows = [
      { findingId: 'f1', armId: 'a', section: 'scripts/x.mjs:10', category: 'B', detail: 'the same defect described one way', severity: 'HIGH' },
      { findingId: 'f2', armId: 'b', section: 'scripts/x.mjs:10', category: 'B', detail: 'the same defect described one way', severity: 'HIGH' },
    ];
    assert.deepEqual(clusterSnapshotFindings(rows, opts), clusterSnapshotFindings([...rows].reverse(), opts));
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

  it('re-running the worksheet is idempotent and never lowers a calibration assignment', async () => {
    const before2 = await store.upsertWorksheetRows(ids.worksheetId, [
      { worksheetRowId: worksheetRowIdFor(ids.findingOpus, KEY), findingId: ids.findingOpus, calibrationAssigned: false },
    ]);
    assert.equal(before2.inserted, 0);
    const row = await client.query('SELECT calibration_assigned FROM campaign_worksheet_rows WHERE worksheet_id = $1 AND finding_id = $2', [ids.worksheetId, ids.findingOpus]);
    assert.equal(row.rows[0].calibration_assigned, true, 'a row once assigned is never unassigned');
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

  it('an arm-run with zero findings still appears — a silent arm is not an absent one', async () => {
    const runs = await store.loadCohortArmRuns(ids.cohortId);
    const ghost = runs.rows.filter((r) => r.arm_id === 'kimi');
    assert.equal(ghost.length, 2, 'superseded attempts are included: spend sums all of them');
  });
});
