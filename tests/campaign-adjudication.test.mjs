/**
 * Tier 1 + Tier 2 — the campaign adjudication protocol (Phase 3).
 *
 * Plan: docs/plans/model-comparison-campaigns.md §2.5c, §9 cases 6 + 7, §7a.
 *
 * **Trimmed (Phase 4, plan: comparison-tooling-consolidation.md, D3)** — the
 * blind DTO / redaction / worksheet-identity / calibration / verdict /
 * self_family / clustering / cited-sources / promotion blocks moved verbatim
 * to tests/campaign-adjudicate.test.mjs, tests/campaign-cited-source.test.mjs,
 * and tests/campaign-promote.test.mjs. What remains:
 *
 *  - **D1c** (`resolveProviderIdentity` / `armRedactionTerms`) — not part of
 *    the original D3 matrix (added by Cluster A's D1c work after D3 was
 *    written). Kept HERE rather than forced into one of the three new files:
 *    it tests `store/campaign.mjs`'s own provider-identity resolution
 *    directly, not the adjudicate/cited-source/promote module boundary any
 *    of those three files owns.
 *  - **Live** (runs under `db:suites:gate`, gated on `AUDIT_DB_TEST_URL` +
 *    `assertDisposableDbUrl`): the claims that are only settleable against a
 *    real schema — "the blind query never returns `source_model`", "an override
 *    is append-only", "`self_family` is computed store-side". Asserting those
 *    from source text would prove a habit, not a behaviour. INC-002's loopback
 *    allowlist is what keeps the destructive-adjacent half off a production DSN.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveProviderIdentity, armRedactionTerms, buildModelRedactor,
  assignCalibrationSample, isSelfFamily, worksheetRowIdFor,
} from '../scripts/lib/store/campaign.mjs';

const KEY = 'a'.repeat(64);

// ── D1c: derived-per-arm redaction coverage ──────────────────────────────────────────

describe('resolveProviderIdentity / armRedactionTerms (D1c)', () => {
  it('a vendor not in ANY source resolves via the OpenRouter slug', () => {
    assert.equal(resolveProviderIdentity('cohere/command-r'), 'cohere');
  });

  it('the bare MODEL ALIAS of a slug id redacts too, not just the full "vendor/model" string', () => {
    // Redacting only the full slug leaves the bare alias exposed: prose
    // naming just "command-r" (no "cohere/" prefix) survived a redactor that
    // only knew "cohere/command-r" as one plain-substring token.
    const r = buildModelRedactor({ arms: [{ id: 'x', model: 'cohere/command-r' }] });
    assert.match(r('the cohere/command-r arm found this'), /\[MODEL-A\]/);
    assert.match(r('the command-r model found this'), /\[MODEL-A\]/, 'the bare alias must redact too');
    assert.equal(r('a command-recipe is unrelated text'), 'a command-recipe is unrelated text', 'boundary-guarded, not a mid-word match');
  });

  it('a genuinely unresolvable id, no override — buildModelRedactor REFUSES, naming the arm and the escape hatch', () => {
    assert.throws(
      () => buildModelRedactor({ arms: [{ id: 'mystery', model: 'mystery-model-9000' }] }),
      (err) => {
        assert.match(err.message, /"mystery"/);
        assert.match(err.message, /redactionTerms/);
        return true;
      },
    );
  });

  it('a genuinely unresolvable id WITH an explicit redactionTerms override — accepted; those exact terms redact', () => {
    const r = buildModelRedactor({ arms: [{ id: 'mystery', model: 'mystery-model-9000', redactionTerms: ['mysteryvendor'] }] });
    assert.match(r('built by MysteryVendor originally'), /\[MODEL-A\]/);
  });

  it('a RESOLVABLE model WITH an explicit redactionTerms override — the override ADDS, it never replaces the derived provider terms (G2)', () => {
    // Before the fix, declaring redactionTerms on a resolvable model silently
    // dropped the auto-derived provider aliases — an arm author adding one
    // extra term (a project codename, say) would unknowingly stop redacting
    // the standard vendor name too, under-redacting the blind worksheet.
    const terms = armRedactionTerms({ id: 'k1', model: 'moonshotai/kimi-k2-thinking', redactionTerms: ['project-codename'] });
    assert.ok(terms.includes('project-codename'), 'the declared override term must be present');
    assert.ok(terms.some((t) => /kimi|moonshot/i.test(t)), 'the auto-derived provider term must STILL be present, not dropped');

    const r = buildModelRedactor({ arms: [{ id: 'k1', model: 'moonshotai/kimi-k2-thinking', redactionTerms: ['project-codename'] }] });
    assert.match(r('this was reviewed under project-codename'), /\[MODEL-A\]/, 'the declared term redacts');
    assert.match(r('Kimi reviewed this'), /\[MODEL-A\]/, 'the derived provider term must ALSO redact, not be silently dropped');
  });

  it('an anthropic-routed arm — claude, opus, sonnet, haiku ALL still redact, not just "anthropic"', () => {
    const r = buildModelRedactor({ arms: [{ id: 'a1', model: 'claude-opus' }] });
    for (const word of ['Claude', 'Opus', 'Sonnet', 'Haiku', 'Anthropic']) {
      assert.match(r(`${word} reviewed this`), /\[MODEL-A\]/, `"${word}" must redact`);
    }
  });

  it('mixed-case arm model strings resolve to the same provider, and the derived term redacts case-insensitively', () => {
    for (const modelSpelling of ['qwen/qwen3.8-max', 'QWEN/Qwen3.8-Max', 'Qwen/QWEN3.8-MAX']) {
      assert.equal(resolveProviderIdentity(modelSpelling), 'qwen', `"${modelSpelling}" must resolve to "qwen"`);
    }
    const r = buildModelRedactor({ arms: [{ id: 'q1', model: 'qwen/qwen3.8-max' }] });
    for (const variant of ['QWEN', 'Qwen', 'qwen']) {
      assert.match(r(`the ${variant} model`), /\[MODEL-A\]/, `"${variant}" must redact`);
    }
    // A hyphenated compound is a DIFFERENT token under this file's existing
    // boundary convention (hyphen counts as a word character, same rule that
    // lets "claude-opus-4-8-preview" redact as one unit elsewhere in this
    // suite) — it does not fragment into a bare "qwen" match, and must not.
    assert.equal(r('the qwen-turbo model'), 'the qwen-turbo model');
  });

  it('the bare native-route ids (no vendor slash) resolve via STATIC_RESIDUE, not source 2 (D1c, G2 native-route follow-up)', () => {
    // qwen3.8-max (Alibaba) / deepseek-v4-pro (DeepSeek direct, since
    // 2026-08-17 — the Alibaba-hosted `-0813` snapshot pin was retired the
    // same day) replaced the OpenRouter-slug arms (qwen/qwen3.8-max,
    // deepseek/deepseek-v4-pro) — no '/', so the vendor-slug source no
    // longer matches and these must resolve through the explicit
    // STATIC_RESIDUE table added alongside the native routes, or
    // armRedactionTerms would refuse the whole campaign as unredactable.
    assert.equal(resolveProviderIdentity('qwen3.8-max'), 'qwen');
    assert.equal(resolveProviderIdentity('deepseek-v4-pro'), 'deepseek');
    // The retired Alibaba-hosted snapshot pin resolves too — STATIC_RESIDUE
    // matches on the shared "deepseek-" prefix, not the exact id, so old
    // logged arm-runs under the retired id remain redactable.
    assert.equal(resolveProviderIdentity('deepseek-v4-pro-0813'), 'deepseek');
    const r = buildModelRedactor({ arms: [{ id: 'q1', model: 'qwen3.8-max' }, { id: 'd1', model: 'deepseek-v4-pro' }] });
    const qwenRedacted = r('the Qwen model found this');
    const deepseekRedacted = r('reviewed by DeepSeek');
    assert.match(qwenRedacted, /\[MODEL-[AB]\]/, 'qwen must redact to SOME model placeholder');
    assert.match(deepseekRedacted, /\[MODEL-[AB]\]/, 'deepseek must redact to SOME model placeholder');
    assert.notEqual(qwenRedacted, 'the Qwen model found this', 'a leaked "Qwen" would defeat blind adjudication');
    assert.notEqual(deepseekRedacted, 'reviewed by DeepSeek', 'a leaked "DeepSeek" would defeat blind adjudication');
  });

  it('boundary-aware: "metadata" and "megawatt" are not redacted by an unrelated derived term', () => {
    const r = buildModelRedactor({ arms: [{ id: 'a1', model: 'claude-opus' }, { id: 'g1', model: 'grok-4.6' }] });
    assert.equal(r('check the metadata and the megawatt rating'), 'check the metadata and the megawatt rating');
  });

  it('the existing "meta" exclusion is unaffected by derivation — still never auto-redacted', () => {
    const r = buildModelRedactor({ arms: [{ id: 'a1', model: 'claude-opus' }] });
    assert.equal(r('metadata about the run'), 'metadata about the run');
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

  it('the producer\'s honest hand-off SATISFIES the constraint, and the pair it produced in the field does not', async () => {
    // The load-bearing case. `campaign.mjs adjudicate` died here on 2026-08-19:
    // the adjudicator returned `verified` + `needs_triage`, Postgres refused it
    // and the paid verdict was lost. Its own finding, so the supersede/count
    // assertions elsewhere in this suite stay independent of it.
    const finding = (await client.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, detail_snapshot)
       VALUES ($1, 'fp-pair-contract', 'backend', 'HIGH', 'Backend', 'a claim the instrument could not settle') RETURNING id`,
      [ids.runOpus],
    )).rows[0].id;

    const ok = await store.recordAgentVerdict({
      findingId: finding, adjudicatorModel: 'claude-opus-4-8',
      method: 'unverifiable', outcome: 'needs_triage',
      evidence: { path: null, sha: 'abc123', lineRange: null, quotedSpan: null, absenceReason: 'no cited path resolved at this revision' },
    });
    assert.equal(ok.ok, true, `the honest hand-off must be storable: ${ok.error ?? ''}`);
    const stored = (await client.query(
      "SELECT method, adjudication_outcome FROM finding_adjudication_events WHERE finding_id = $1", [finding],
    )).rows;
    assert.deepEqual(stored, [{ method: 'unverifiable', adjudication_outcome: 'needs_triage' }]);

    // NEGATIVE CONTROL: the constraint is live and WOULD have rejected the pair
    // the producer emitted, so the pass above is the coherent pair being legal
    // rather than the constraint having been dropped.
    await assert.rejects(
      client.query(
        `INSERT INTO finding_adjudication_events (finding_id, adjudication_outcome, remediation_state, round, adjudicator_kind, method)
         VALUES ($1, 'needs_triage', 'pending', 1, 'agent', 'verified')`, [finding],
      ),
      (err) => /needs_triage_is_unverifiable/.test(err.message),
    );

    // ...and the store refuses that pair itself, writing NOTHING — the caller
    // gets a named contract error instead of a driver-level constraint name,
    // and the row count is the proof no partial write happened.
    const before = (await client.query('SELECT COUNT(*)::int AS n FROM finding_adjudication_events WHERE finding_id = $1', [finding])).rows[0].n;
    const refused = await store.recordAgentVerdict({
      findingId: finding, adjudicatorModel: 'claude-opus-4-8', method: 'verified', outcome: 'needs_triage',
    });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /requires method "unverifiable"/);
    const after = (await client.query('SELECT COUNT(*)::int AS n FROM finding_adjudication_events WHERE finding_id = $1', [finding])).rows[0].n;
    assert.equal(after, before, 'a refused verdict writes nothing');

    // The OTHER half of the pair rule has no constraint behind it: nothing in
    // the schema stops `unverifiable` + `accepted` from being stored and
    // counted as evidence, so the store guard is the only thing that does.
    const uncaught = await store.recordAgentVerdict({
      findingId: finding, adjudicatorModel: 'claude-opus-4-8', method: 'unverifiable', outcome: 'accepted',
    });
    assert.equal(uncaught.ok, false, 'the silent half must be refused too');
    // Its own finding: the partial unique index permits ONE live agent verdict
    // per finding, and this control is about the CHECK constraints, not that.
    const other = (await client.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, detail_snapshot)
       VALUES ($1, 'fp-pair-control', 'backend', 'HIGH', 'Backend', 'the silent half') RETURNING id`,
      [ids.runOpus],
    )).rows[0].id;
    const raw = await client.query(
      `INSERT INTO finding_adjudication_events (finding_id, adjudication_outcome, remediation_state, round, adjudicator_kind, method)
       VALUES ($1, 'accepted', 'pending', 1, 'agent', 'unverifiable') RETURNING id`, [other],
    );
    assert.ok(raw.rows[0].id, 'control: the DATABASE accepts it — which is exactly why the producer must not emit it');
    await client.query('DELETE FROM finding_adjudication_events WHERE id = $1', [raw.rows[0].id]);
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

  it('the redo guard sees a human disposition, and fails CLOSED when it cannot look', async () => {
    // `--redo` supersedes a live agent verdict. A human override NAMES the
    // verdict it overrides, and that pair is the campaign's published
    // calibration figure — so a redo over a human-dispositioned finding would
    // leave the override pointing at a superseded row. findingKimi has an
    // override by this point in the suite; findingOpus does not.
    const seen = await store.findingsWithHumanDisposition([ids.findingKimi, ids.findingOpus]);
    assert.equal(seen.ok, true);
    assert.equal(seen.ids.has(ids.findingKimi), true, 'the overridden finding must be visible to the guard');
    assert.equal(seen.ids.has(ids.findingOpus), false, 'and a machine-only finding must NOT be blocked');

    // NEGATIVE CONTROL — fail-closed. An unreadable guard must refuse
    // everything rather than report "no human touched these", which is the
    // answer that would let a redo through. A malformed uuid makes the query
    // itself throw, which is the cheapest real fault to inject.
    const broken = await store.findingsWithHumanDisposition(['not-a-uuid']);
    assert.equal(broken.ok, false);
    assert.equal(broken.ids.has('not-a-uuid'), true, 'fail-closed: every id is refused when the guard cannot read');
  });

  it('resolveRedoRows refuses a finding a human has already dispositioned', async () => {
    const { _internals } = await import('../scripts/campaign.mjs');
    const candidates = [
      { findingId: ids.findingKimi, worksheetRowId: 'wr-kimi' },
      { findingId: ids.findingOpus, worksheetRowId: 'wr-opus' },
    ];
    const blindRows = { rows: [{ worksheet_row_id: 'wr-kimi' }, { worksheet_row_id: 'wr-opus' }] };

    const blocked = await _internals.resolveRedoRows({
      redo: [ids.findingKimi], candidates, blindRows, reason: 'wider citation window',
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /HUMAN disposition/);
    assert.match(blocked.error, /campaign\.mjs override/, 'and it names the supported alternative');

    // Positive control: the machine-only finding resolves, so the refusal above
    // is the guard binding rather than the function refusing everything.
    const allowed = await _internals.resolveRedoRows({
      redo: [ids.findingOpus], candidates, blindRows, reason: 'wider citation window',
    });
    assert.equal(allowed.ok, true);
    assert.deepEqual(allowed.rows.map((r) => r.worksheet_row_id), ['wr-opus']);
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
    // §7 Phase 3 (campaign-arm-state-and-identity-integrity.md): a retry is a
    // genuinely NEW review — a NEW audit_run_id — never the same run id
    // recorded twice. `recordArmRun`'s conflict-safe insert now refuses a
    // repeated audit_run_id outright (the exact double-promotion defect the
    // identity-keyed design exists to make impossible), so this fixture must
    // mint a real second run rather than reusing `ids.runKimi`.
    const retryRun = (await client.query(
      "INSERT INTO audit_runs (repo_id, plan_file, mode) VALUES ($1, 'docs/plans/x.md', 'code') RETURNING id", [ids.repoId],
    )).rows[0].id;
    const r = await store.recordArmRun({
      cohortId: ids.cohortId, snapshotRowId: ids.snapshotRowId, snapshotId: 'snapA', armId: 'kimi', attempt: 2,
      auditRunId: retryRun, costUsd: 0.5, costStatus: 'priced', supersedePrior: true,
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
