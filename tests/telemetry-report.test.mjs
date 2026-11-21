/**
 * @fileoverview `telemetry-export --report` (docs/plans/policy-private-consumer-stores.md Phase 4): group isolation,
 * unmeasured-never-zero, redaction, rendering, flag exclusivity, and the claim that report mode writes and sends nothing.
 * The SQL itself is exercised against a real Postgres in tests/audit-capture-db.test.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import module_ from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  runGroups, buildReportGroups, assembleReport, renderReport, sanitizeModelId, reasonForReportError, isConnectionError,
  GROUP_TIMEOUT_MS, REPORT_FOOTER,
} from '../scripts/lib/telemetry-export/report.mjs';
import { makeRowReader } from '../scripts/lib/telemetry-export/sources.mjs';
import { buildExport } from '../scripts/lib/telemetry-export/build.mjs';
import { ExportRefusedError } from '../scripts/lib/telemetry-export/redact.mjs';
import { buildPopulation, parsePopulationLine, renderPopulationLine } from '../scripts/lib/population.mjs';
import { CAPTURE_EPOCHS } from '../scripts/lib/telemetry/capture-queries.mjs';
import { main as telemetryMain } from '../scripts/telemetry-export.mjs';
import { summarize, windowProgress, normalizeDbRow } from '../scripts/lib/audit/tiered-shadow-summary.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'telemetry-export.mjs');
const COVERAGE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.own-model-coverage.json'), 'utf8'));

/** A scripted client: statements matched by a marker in their SQL; control statements are recorded and succeed. */
function fakeClient({ answers = {}, throwOn = {}, failRollback = false } = {}) {
  const seen = [];
  const answer = (sql) => {
    for (const [marker, rows] of Object.entries(answers)) if (sql.includes(marker)) return rows;
    return null;
  };
  return {
    seen,
    async query(sql) {
      seen.push(sql);
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|SET LOCAL)/.test(sql)) return { rows: [] };
      if (sql.startsWith('ROLLBACK TO SAVEPOINT')) { if (failRollback) throw Object.assign(new Error('gone'), { code: 'ECONNRESET' }); return { rows: [] }; }
      for (const [marker, err] of Object.entries(throwOn)) if (sql.includes(marker)) throw err;
      const rows = answer(sql);
      if (rows == null) throw Object.assign(new Error(`unscripted statement: ${sql.slice(0, 60)}`), { code: 'TEST_UNSCRIPTED' });
      return { rows };
    },
  };
}

const HEALTHY = {
  reraise_rate: [{ reraise_rate: '0.5', concerns: '4' }],
  reopen_rate: [{ reopen_rate: '0.25', dismissed_concerns: '4' }],
  dispute_rate: [{ dispute_rate: '0.1', rows_with_two_kinds: '10' }],
  runs_with_receipt: [{ runs_with_receipt: '3', expected: '6', written: '4', spilled: null, lost: '1', skipped: '1' }],
  unresolved: [{ source_model: 'gpt-6.1-terra', pass_name: 'backend', n: '7', accepted: '1', dismissed: '3', severity_adjusted: '1', unresolved: '2' }],
  one_model: [{ source_model: 'gpt-6.1-sol', n: '5', excluded: false }, { source_model: null, n: '2', excluded: true }],
  'result, count(*) AS n': [{ result: 'agree', n: '2' }, { result: 'disagree', n: '1' }],
  reversal_rate: [{ runs: '2', reversals: '3', presented_resolved: '5', reversal_rate: '0.6' }],
  incomplete_reviews: [{ incomplete_reviews: '0' }],
  'FROM audit_repos': [{ id: 'r1' }],
  'count(*)::int AS total': [{ total: 100, filled: 99 }],
};
const summariseShadow = (rows) => { const n = summarize(rows.map(normalizeDbRow)).comparedRuns; return { comparedRuns: n, window: windowProgress(n) }; };
const okShadow = async () => ({ ok: true, cloud: true, rows: [{ legacy_ok: false, shadow_ok: false, shadow_error: 'x', comparison: null, repo_id: 'r1' }] });

const groupsFor = (over = {}) => {
  const tally = { n: 0 };
  return { tally, groups: buildReportGroups({ coverageConfig: { windowDays: 30, entries: COVERAGE.entries.slice(0, 2) }, readTieredShadow: okShadow, summariseShadow, tally, ...over }) };
};

describe('runGroups: one group fails, the rest are still measured', () => {
  it('a schema fault is unmeasured(schema-fault), rolled back to its savepoint, and later groups still measure', async () => {
    const client = fakeClient({ answers: HEALTHY, throwOn: { dispute_rate: Object.assign(new Error('relation missing'), { code: '42P01' }) } });
    const { groups } = groupsFor();
    const r = await runGroups(client, groups);
    assert.deepEqual(r.dispute, { measured: false, reason: 'schema-fault' });
    assert.equal(r.reraise.measured, true);
    assert.equal(r.reraise.rate, 0.5);
    assert.equal(r.reversal.measured, true, 'a group AFTER the failed one measured');
    assert.ok(client.seen.some((s) => s.startsWith('ROLLBACK TO SAVEPOINT g_')), 'the failed group was rolled back to its savepoint');
    const n = client.seen.filter((s) => s.startsWith('SAVEPOINT g_')).length;
    assert.equal(n, groups.length, 'one savepoint per group');
  });

  it('every group is bounded at the CALLER: SET LOCAL statement_timeout', async () => {
    const client = fakeClient({ answers: HEALTHY });
    const { groups } = groupsFor();
    await runGroups(client, groups);
    const sets = client.seen.filter((s) => s.startsWith('SET LOCAL statement_timeout'));
    assert.equal(sets.length, groups.length);
    assert.ok(sets.every((s) => s === `SET LOCAL statement_timeout = ${GROUP_TIMEOUT_MS}`));
  });

  it('SQLSTATE 57014 is a timeout (our own bound), and is NOT folded into the export reasons', async () => {
    assert.equal(reasonForReportError({ code: '57014' }), 'timeout');
    const client = fakeClient({ answers: HEALTHY, throwOn: { reopen_rate: Object.assign(new Error('canceling'), { code: '57014' }) } });
    const r = await runGroups(client, groupsFor().groups);
    assert.deepEqual(r.reopen, { measured: false, reason: 'timeout' });
    assert.equal(r.dispute.measured, true, 'a timeout is not a connection loss');
  });

  it('a connection error ends the remaining groups as store-unreachable WITHOUT further statements', async () => {
    const client = fakeClient({ answers: HEALTHY, throwOn: { reopen_rate: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) } });
    const { groups } = groupsFor();
    const r = await runGroups(client, groups);
    assert.equal(r.reraise.measured, true);
    assert.deepEqual(r.reopen, { measured: false, reason: 'store-unreachable' });
    for (const g of groups.slice(2)) assert.deepEqual(r[g.id], { measured: false, reason: 'store-unreachable' }, g.id);
    const afterFailure = client.seen.slice(client.seen.findIndex((s) => s.includes('reopen_rate')) + 1);
    assert.equal(afterFailure.filter((s) => !s.startsWith('ROLLBACK TO SAVEPOINT')).length, 0, 'nothing issued after the connection error but the rollback attempt');
  });

  it('a failed ROLLBACK TO also ends the run as store-unreachable', async () => {
    const client = fakeClient({ answers: HEALTHY, failRollback: true, throwOn: { dispute_rate: Object.assign(new Error('x'), { code: '42703' }) } });
    const r = await runGroups(client, groupsFor().groups);
    assert.deepEqual(r.dispute, { measured: false, reason: 'store-unreachable' });
    assert.deepEqual(r.equivalence, { measured: false, reason: 'store-unreachable' });
  });

  it('isConnectionError: a pg "Connection terminated" with no code counts, a typed schema fault does not', () => {
    assert.equal(isConnectionError(new Error('Connection terminated unexpectedly')), true);
    assert.equal(isConnectionError({ code: '08006' }), true);
    assert.equal(isConnectionError({ code: '42P01' }), false);
  });
});

describe('a zero denominator is unmeasured, never a rate and never 0', () => {
  it('each rate group with nothing eligible reads unmeasured(no-eligible-rows)', async () => {
    const empty = {
      ...HEALTHY,
      reraise_rate: [{ reraise_rate: null, concerns: '0' }],
      reopen_rate: [{ reopen_rate: null, dismissed_concerns: '0' }],
      dispute_rate: [{ dispute_rate: null, rows_with_two_kinds: '0' }],
      runs_with_receipt: [{ runs_with_receipt: '0', expected: null, written: null, spilled: null, lost: null, skipped: null }],
      unresolved: [], one_model: [], 'result, count(*) AS n': [],
      reversal_rate: [{ runs: '0', reversals: null, presented_resolved: null, reversal_rate: null }],
      'FROM audit_repos': [], 'count(*)::int AS total': [{ total: 0, filled: 0 }],
    };
    const r = await runGroups(fakeClient({ answers: empty }), groupsFor().groups);
    for (const id of ['reraise', 'reopen', 'dispute', 'equivalence', 'qualityProspective', 'qualityHistorical', 'agreement', 'reversal', 'shadowTiered']) {
      assert.deepEqual(r[id], { measured: false, reason: 'no-eligible-rows' }, id);
    }
    // Control: the one group where 0 is a real answer (a count, not a rate) still measures.
    assert.deepEqual(r.incompleteReviews, { measured: true, count: 0 });
  });

  it('coverage: zero eligible rows is the committed unmeasured:no-eligible-rows status', async () => {
    const { groups, tally } = groupsFor();
    const results = await runGroups(fakeClient({ answers: { ...HEALTHY, 'count(*)::int AS total': [{ total: 0, filled: 0 }] } }), groups);
    const report = assembleReport({ doc: DOC, results, coverageConfig: { windowDays: 30, entries: COVERAGE.entries.slice(0, 2) }, tally });
    // No entry produced a rate, so the GROUP is unmeasured (R3 M1) — never "measured" with no numbers behind it.
    assert.equal(report.groups.coverage.measured, false);
    assert.equal(report.groups.coverage.reason, 'no-eligible-rows');
    assert.ok(report.groups.coverage.entries.length === 2 && report.groups.coverage.entries.every((e) => e.reason === 'no-eligible-rows'));
    assert.match(renderReport(report, POP), /no-eligible-rows/);
  });
});

describe('model ids and passes cannot carry an organisation detail', () => {
  it('only an EXACT known public id prints; anything else is <family>:other (or other) and is COUNTED', () => {
    const tally = { n: 0 };
    for (const known of ['gpt-6.1-terra', 'qwen/qwen3-coder', 'qwen3.8-max', 'grok-4.6']) assert.equal(sanitizeModelId(known, tally), known);
    assert.equal(tally.n, 0);
    // A private Azure deployment name: charset-clean and leak-scan-clean, so ONLY exact membership can catch it.
    assert.equal(sanitizeModelId('gpt-5-prod-eu-acme', tally), 'openai:other');
    assert.equal(sanitizeModelId('claude-opus-9-contoso', tally), 'anthropic:other');
    // A family that no public id has could itself be the organisation's name: it must not be printed.
    assert.equal(sanitizeModelId('acme-gpt-prod', tally), 'other');
    for (const bad of ['db.corp.example', 'Has Space', 'a@b.co', '10.0.0.1']) assert.equal(sanitizeModelId(bad, tally), 'other', bad);
    assert.equal(tally.n, 7);
    assert.equal(sanitizeModelId(null, tally), 'none');
    assert.equal(tally.n, 7, 'a missing id is not a redaction');
  });

  it('the groups apply it: bad ids merge into their family row and the report says how many, never printing the raw id', async () => {
    const row = (model, pass, n, acc, dis) => ({ source_model: model, pass_name: pass, n, accepted: acc, dismissed: dis, severity_adjusted: '0', unresolved: '0' });
    const answers = { ...HEALTHY, unresolved: [
      row('gpt-5-prod-eu-acme', 'backend', '2', '1', '1'),
      row('gpt-5-staging-acme', 'backend', '1', '1', '0'),
      row('NOT OK', 'my-secret-pass', '3', '0', '3'),
      row('gpt-6.1-terra', 'backend', '1', '1', '0'),
    ] };
    const { groups, tally } = groupsFor();
    const results = await runGroups(fakeClient({ answers }), groups);
    const rows = results.qualityProspective.rows;
    assert.deepEqual(rows.map((r) => `${r.model}/${r.pass}/${r.n}`).sort(), ['gpt-6.1-terra/backend/1', 'openai:other/backend/3', 'other/other/3']);
    const report = assembleReport({ doc: DOC, results, coverageConfig: null, tally });
    assert.equal(report.redactions, 4);
    const text = renderReport(report, POP);
    assert.ok(!text.includes('acme') && !text.includes('my-secret-pass') && !text.includes('NOT OK'));
    assert.match(text, /openai:other \/ backend: n=3/);
    assert.match(text, /replaced by "other"/);
  });

  it('every prospective bucket is printed so the parts add up to n (accepted + dismissed + severity-adjusted + unresolved)', async () => {
    const r = await runGroups(fakeClient({ answers: HEALTHY }), groupsFor().groups);
    const [row] = r.qualityProspective.rows;
    assert.equal(row.accepted + row.dismissed + row.severityAdjusted + row.unresolved, row.n);
    assert.match(renderReport(assembleReport({ doc: DOC, results: r, coverageConfig: null, tally: { n: 0 } }), POP), /severity-adjusted 1, unresolved 2/);
  });
});

const DOC = {
  generatedAt: '2026-11-21T10:00:00.000Z',
  health: { store: 'reachable', drift: { measured: true, unapplied: 0, shaMismatch: 0, liveBroken: 0 } },
  audit: { measured: true },
};
const POP = buildPopulation({ measured: [{ store: 'a1b2c3d4', scope: 'store' }], unknownBeyond: true });

describe('assembleReport + renderReport', () => {
  async function fullReport() {
    const { groups, tally } = groupsFor({ coverageConfig: COVERAGE });
    const results = await runGroups(fakeClient({ answers: HEALTHY }), groups);
    return assembleReport({ doc: DOC, results, coverageConfig: COVERAGE, tally });
  }

  it('the whole committed coverage config passes the leak check (table and column names are clean)', async () => {
    const r = await fullReport();
    assert.equal(r.groups.coverage.measured, true);
    assert.equal(r.groups.coverage.entries.length, COVERAGE.entries.length);
  });

  it('prints counts, rates with their denominators, the population line, and ends exactly with the footer', async () => {
    const text = renderReport(await fullReport(), POP);
    assert.match(text, /re-raise rate:\s+50\.0% over 4 concern\(s\)/);
    assert.match(text, /reversal rate:\s+60\.0% \(3 of 5 presented_resolved/);
    assert.match(text, /excluded .*: 2/);
    assert.match(text, /equivalence receipt: 3 run\(s\): expected 6, written 4, skipped 1, spilled 0, lost 1/);
    assert.match(text, /tiered pipeline: 0 compared run\(s\) of \d+-\d+ needed/);
    assert.match(text, /final-review shadow: unmeasured \(no-reader\)/);
    assert.ok(text.endsWith(`${REPORT_FOOTER}`));
    assert.equal(text.split('\n').at(-1), 'Nothing was written or sent.');
  });

  it('the population line parses back with parsePopulationLine and names one store', async () => {
    const text = renderReport(await fullReport(), POP);
    const parsed = parsePopulationLine(text);
    assert.ok(parsed, 'a population line is present and parses');
    assert.equal(parsed.measured.length, 1);
    assert.equal(parsed.measured[0].store, 'a1b2c3d4');
    assert.equal(parsed.measured[0].scope, 'store');
    assert.equal(parsed.unknownBeyond, true);
    assert.ok(text.includes(renderPopulationLine(POP)));
  });

  it('an unreadable group renders unmeasured(<reason>) and no number', async () => {
    const { groups, tally } = groupsFor();
    const results = await runGroups(fakeClient({ answers: HEALTHY, throwOn: { dispute_rate: Object.assign(new Error('x'), { code: '42P01' }) } }), groups);
    const text = renderReport(assembleReport({ doc: DOC, results, coverageConfig: null, tally }), POP);
    assert.match(text, /dispute rate:\s+unmeasured \(schema-fault\)/);
    assert.match(text, /Own-model coverage\n\s+unmeasured \(config-missing\)/);
    assert.ok(!/dispute rate:.*\d%/.test(text));
  });

  it('when the snapshot never opened, every group carries the export build\'s own reason', () => {
    const doc = { ...DOC, health: { store: 'configured-but-unreachable', drift: { measured: false, reason: 'store-unreachable' } }, audit: { measured: false, reason: 'store-unreachable' } };
    const report = assembleReport({ doc, results: null, coverageConfig: null, tally: { n: 0 } });
    assert.equal(report.anyMeasured, false);
    assert.deepEqual(report.groups.reraise, { measured: false, reason: 'store-unreachable' });
    const text = renderReport(report, buildPopulation({ unknownBeyond: true }));
    assert.match(text, /unmeasured \(store-unreachable\)/);
    assert.equal(text.split('\n').at(-1), REPORT_FOOTER);
  });

  it('a leak in the assembled report is REFUSED (negative control for the clean check)', async () => {
    const { groups, tally } = groupsFor();
    const results = await runGroups(fakeClient({ answers: HEALTHY }), groups);
    assert.throws(
      () => assembleReport({ doc: DOC, results, coverageConfig: { windowDays: 30, entries: [{ table: 'db.corp.example', column: 'c', since: '2026-01-01', expectFill: 0.5 }] }, tally }),
      (e) => e instanceof ExportRefusedError,
    );
  });

  it('shadow: comparedRuns only, with the window; a failed read is read-failed, a missing cloud is store-unconfigured', async () => {
    const r = await runGroups(fakeClient({ answers: HEALTHY }), groupsFor().groups);
    assert.equal(r.shadowTiered.comparedRuns, 0);
    assert.equal('totalRuns' in r.shadowTiered, false, 'totalRuns is never reported as progress');
    assert.equal(r.shadowTiered.window.met, false);
    const bad = await runGroups(fakeClient({ answers: HEALTHY }), groupsFor({ readTieredShadow: async () => ({ ok: false, cloud: true, rows: [] }) }).groups);
    assert.deepEqual(bad.shadowTiered, { measured: false, reason: 'read-failed' });
    const off = await runGroups(fakeClient({ answers: HEALTHY }), groupsFor({ readTieredShadow: async () => ({ ok: true, cloud: false, rows: [] }) }).groups);
    assert.deepEqual(off.shadowTiered, { measured: false, reason: 'store-unconfigured' });
  });
});

describe('the export is untouched by the report hook', () => {
  const fakeDeps = (calls) => ({
    withTx: async (fn) => fn({ marker: 'client' }),
    query: async (sql) => { calls.push(/^(SAVEPOINT|RELEASE|ROLLBACK TO)/.test(sql) ? `sp:${sql}` : 'q'); return { sql }; },
    many: async (sql) => { calls.push('many'); return sql.includes('upstream_issues') && sql.includes('count(*)') ? [{ n: 0 }] : []; },
    getRepoIdByUuid: async () => ({ id: 'r' }),
    resolveRepoIdentity: () => ({ repoUuid: 'u' }),
  });
  const build = (readRows) => buildExport({
    now: new Date('2026-11-21T10:00:00.000Z'), consumerAlias: 'report', storeFingerprint: null, toolBundleSha: null, exportId: '11111111-1111-4111-8111-111111111111',
    deps: { reachability: async () => ({ configured: true, ok: true }), drift: async () => ({ ok: false, reason: 'read-failed' }), readRows },
  });

  it('the document is byte-identical with and without the hook, and the hook runs once, AFTER the export reads, with the client', async () => {
    const callsA = []; const callsB = []; const hooked = [];
    const plain = await build(makeRowReader(fakeDeps(callsA)));
    const withHook = await build(makeRowReader(fakeDeps(callsB), { extraReads: async (c) => { hooked.push([c, callsB.length]); } }));
    assert.equal(JSON.stringify(withHook), JSON.stringify(plain));
    assert.equal(hooked.length, 1);
    assert.deepEqual(hooked[0][0], { marker: 'client' });
    assert.equal(hooked[0][1], callsA.length + 2, 'the hook ran after every export read (plus the SAVEPOINT pair the hooked path adds)');
  });

  it('the export reads are the same with and without the hook (it adds statements only through its own callback)', async () => {
    const callsA = []; const callsB = [];
    await build(makeRowReader(fakeDeps(callsA)));
    await build(makeRowReader(fakeDeps(callsB), { extraReads: async () => {} }));
    assert.deepEqual(callsB.filter((c) => !c.startsWith('sp:')), callsA);
    assert.ok(callsA.length > 0);
  });
});

describe('audit round 1 fixes', () => {
  it('the tiered-shadow read goes through the SNAPSHOT runner (same savepoint, same timeout), and its errors keep their SQLSTATE', async () => {
    const client = fakeClient({ answers: { ...HEALTHY, 'FROM tiered_shadow_observations': [] } });
    let sawQuery = false;
    const readTieredShadow = async (args, opts) => {
      assert.equal(typeof opts?.query, 'function', 'the runner is handed to the reader');
      sawQuery = true;
      await opts.query('SELECT * FROM tiered_shadow_observations');
      return { ok: true, cloud: true, rows: [] };
    };
    const { groups } = groupsFor({ readTieredShadow });
    await runGroups(client, groups);
    assert.ok(sawQuery);
    const i = client.seen.findIndex((s) => s.includes('FROM tiered_shadow_observations'));
    const lastSavepoint = client.seen.slice(0, i).findLastIndex((s) => s.startsWith('SAVEPOINT g_'));
    assert.ok(lastSavepoint >= 0 && client.seen.slice(lastSavepoint, i).some((s) => s.startsWith('SET LOCAL statement_timeout')), 'the read sits inside its own savepoint, after the timeout was set');
    // A timeout thrown by the injected runner is classified as a timeout, not folded into read-failed.
    const slow = async (args, opts) => { await opts.query('SELECT slow'); return { ok: true, cloud: true, rows: [] }; };
    const c2 = fakeClient({ answers: HEALTHY, throwOn: { 'SELECT slow': Object.assign(new Error('cancel'), { code: '57014' }) } });
    const r = await runGroups(c2, groupsFor({ readTieredShadow: slow }).groups);
    assert.deepEqual(r.shadowTiered, { measured: false, reason: 'timeout' });
  });

  it('a coverage entry that failed renders unmeasured(<reason>), not a bare status', async () => {
    const { groups, tally } = groupsFor();
    const results = await runGroups(fakeClient({ answers: HEALTHY, throwOn: { 'count(tool_sha)': Object.assign(new Error('x'), { code: '42703' }) } }), groups);
    const text = renderReport(assembleReport({ doc: DOC, results, coverageConfig: { windowDays: 30, entries: COVERAGE.entries.slice(0, 2) }, tally }), POP);
    assert.match(text, /learning_decisions\.\w+ \[\w+\]: unmeasured \(schema-fault\)/);
    assert.ok(!/unmeasured:store/.test(text));
  });

  it('an export read that throws a schema fault is rolled back to its savepoint and the report groups still run and stay measured', async () => {
    const calls = []; let hooked = 0;
    const d = {
      withTx: async (fn) => fn({ marker: 'client' }),
      query: async (sql) => { calls.push(sql); return {}; },
      many: async (sql) => { if (sql.includes('FROM audit_runs')) throw Object.assign(new Error('relation missing'), { code: '42P01' }); return []; },
      getRepoIdByUuid: async () => ({ id: 'r' }),
      resolveRepoIdentity: () => ({ repoUuid: 'u' }),
    };
    await assert.rejects(makeRowReader(d, { extraReads: async () => { hooked += 1; } })({ from: new Date(0), to: new Date(1) }), (e) => e.code === '42P01');
    assert.equal(hooked, 1, 'extraReads ran although the export read failed');
    assert.ok(calls.indexOf('ROLLBACK TO SAVEPOINT export_reads') > calls.indexOf('SAVEPOINT export_reads'));
    // End to end through the builder: the export's audit group is unmeasured(schema-fault); the report keeps what its groups measured.
    const { groups, tally } = groupsFor();
    let results = null;
    const doc = await buildExport({
      now: new Date('2026-11-21T10:00:00.000Z'), consumerAlias: 'report', storeFingerprint: null, toolBundleSha: null, exportId: '11111111-1111-4111-8111-111111111111',
      deps: {
        reachability: async () => ({ configured: true, ok: true }), drift: async () => ({ ok: false, reason: 'read-failed' }),
        readRows: makeRowReader(d, { extraReads: async (c) => { results = await runGroups(fakeClient({ answers: HEALTHY }), groups); void c; } }),
      },
    });
    assert.deepEqual(doc.audit, { measured: false, reason: 'schema-fault' });
    const report = assembleReport({ doc, results, coverageConfig: null, tally });
    assert.equal(report.groups.reraise.measured, true);
  });

  it('a historical model literally named like the excluded label stays a MODEL row (classified on the flag, not the text)', async () => {
    const answers = { ...HEALTHY, one_model: [
      { source_model: '(excluded:x)', n: '4', excluded: false },
      { source_model: null, n: '2', excluded: true },
    ] };
    const { groups, tally } = groupsFor();
    const r = await runGroups(fakeClient({ answers }), groups);
    assert.equal(r.qualityHistorical.excluded, 2);
    assert.deepEqual(r.qualityHistorical.models, [{ model: 'other', n: 4 }], 'the lookalike is a model row, redacted like any non-public id');
    assert.equal(tally.n, 1);
    // an unexpected flag value is an unreadable aggregate, never guessed
    const bad = await runGroups(fakeClient({ answers: { ...HEALTHY, one_model: [{ source_model: 'x', n: '1' }] } }), groupsFor().groups);
    assert.deepEqual(bad.qualityHistorical, { measured: false, reason: 'read-failed' });
  });

  it('when EVERY coverage entry fails, each entry keeps its own reason and the report prints them all', async () => {
    const { groups, tally } = groupsFor();
    const results = await runGroups(fakeClient({ answers: HEALTHY, throwOn: {
      'count(tool_sha)': Object.assign(new Error('x'), { code: '42703' }),
      'count(policy_version)': Object.assign(new Error('x'), { code: '57014' }),
    } }), groups);
    const report = assembleReport({ doc: DOC, results, coverageConfig: { windowDays: 30, entries: COVERAGE.entries.slice(0, 2) }, tally });
    assert.equal(report.groups.coverage.measured, false);
    assert.deepEqual(report.groups.coverage.entries.map((e) => e.reason), ['schema-fault', 'timeout']);
    const text = renderReport(report, POP);
    assert.match(text, /tool_sha \[\w+\]: unmeasured \(schema-fault\)/);
    assert.match(text, /policy_version \[\w+\]: unmeasured \(timeout\)/);
  });

  describe('store-wide groups do not depend on the repo', () => {
    const deps = (calls, ident, repo) => ({
      withTx: async (fn) => fn({ marker: 'client' }),
      query: async () => { calls.push('q'); return {}; },
      many: async () => { calls.push('many'); return []; },
      getRepoIdByUuid: async () => repo,
      resolveRepoIdentity: () => ident,
    });
    for (const [label, ident, repo, status] of [['unresolved', null, null, 'repo-unresolved'], ['unregistered', { repoUuid: 'u' }, null, 'repo-unregistered']]) {
      it(`repo ${label}: extraReads still run in the snapshot and the export keeps its status`, async () => {
        const calls = []; let ran = 0;
        const out = await makeRowReader(deps(calls, ident, repo), { extraReads: async () => { ran += 1; } })({ from: new Date(0), to: new Date(1) });
        assert.deepEqual(out, { status });
        assert.equal(ran, 1);
      });
      it(`repo ${label}: WITHOUT the hook nothing changes (no transaction is opened for an unresolved repo)`, async () => {
        const calls = []; let tx = 0;
        const d = deps(calls, ident, repo); const w = d.withTx; d.withTx = async (fn) => { tx += 1; return w(fn); };
        const out = await makeRowReader(d)({ from: new Date(0), to: new Date(1) });
        assert.deepEqual(out, { status });
        assert.equal(tx, ident ? 1 : 0);
      });
    }
    it('the report keeps the groups it measured while the export group is repo-unresolved', async () => {
      const { groups, tally } = groupsFor();
      const results = await runGroups(fakeClient({ answers: HEALTHY }), groups);
      const doc = { ...DOC, audit: { measured: false, reason: 'repo-unresolved' } };
      const report = assembleReport({ doc, results, coverageConfig: null, tally });
      assert.equal(report.groups.reraise.measured, true);
      assert.equal(report.anyMeasured, true);
    });
  });
});

describe('CLI: --report is exclusive with every delivery flag (usage, exit 2)', () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, env: { ...process.env, TELEMETRY_DROP_DIR: '' } });
  for (const extra of [['--print'], ['--push'], ['--drop-dir', 'x'], ['--if-older-than', '1']]) {
    it(`--report ${extra.join(' ')}`, () => {
      const r = run('--report', ...extra);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /mutually exclusive/);
      assert.deepEqual(JSON.parse(r.stdout.trim()), { ok: false, error: { code: 'USAGE' } });
    });
  }
  it('control: --report alone is not a usage error (it gets as far as the store)', () => {
    const r = spawnSync(process.execPath, [CLI, '--report'], {
      cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, AUDIT_DB_URL: '', TELEMETRY_DROP_DIR: '' },
    });
    assert.notEqual(r.status, 2, `${r.stdout}\n${r.stderr}`);
  });
});

describe('report mode writes and sends nothing', () => {
  it('only the drift child is spawned, and no file is written', async () => {
    const spawned = [];
    const writes = [];
    const restore = [];
    const patch = (obj, name, impl) => { const orig = obj[name]; obj[name] = impl; restore.push(() => { obj[name] = orig; }); };
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'fork']) patch(childProcess, name, (...a) => { spawned.push([name, ...a]); throw new Error(`unexpected ${name}`); });
    patch(childProcess, 'execFileSync', (cmd, args) => {
      spawned.push(['execFileSync', cmd, ...args]);
      return JSON.stringify({ hasDrift: false, drift: { unapplied: [], shaMismatch: [] }, liveConstraints: { measured: true, missing: [], altered: [] } });
    });
    for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'createWriteStream', 'rmdirSync', 'truncateSync']) {
      patch(fs, name, (...a) => { writes.push([name, a[0]]); throw new Error(`unexpected fs.${name}`); });
    }
    for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile']) {
      patch(fs.promises, name, async (...a) => { writes.push([`promises.${name}`, a[0]]); throw new Error(`unexpected fs.promises.${name}`); });
    }
    module_.syncBuiltinESMExports();

    const savedArgv = process.argv;
    const out = []; const codes = [];
    const client = fakeClient({ answers: HEALTHY });
    const modules = {
      reachability: { probeStoreReachability: async () => ({ configured: true, ok: true }) },
      client: { resolveDbUrl: () => null, storeFingerprint: () => null, closePool: async () => {} },
      query: {
        withTx: async (fn) => fn(client),
        query: async () => ({ rows: [] }),
        many: async (sql) => (sql.includes('count(*)::int AS n') ? [{ n: 0 }] : []),
      },
      repoStore: { getRepoIdByUuid: async () => ({ id: 'r1' }) },
      identity: { resolveRepoIdentity: () => ({ repoUuid: 'u1' }) },
      upstreamCmds: { readBundleStamp: () => null },
    };
    try {
      process.argv = [process.execPath, CLI, '--report'];
      await telemetryMain({
        io: { out: (t) => out.push(t), finish: (c) => { codes.push(c); } },
        modules, readTieredShadow: okShadow, population: async () => POP,
      });
    } finally {
      process.argv = savedArgv;
      for (const r of restore.reverse()) r();
      module_.syncBuiltinESMExports();
    }

    assert.deepEqual(codes, [0], out.join(''));
    assert.deepEqual(spawned, [['execFileSync', process.execPath, path.join(REPO_ROOT, 'scripts', 'setup-postgres.mjs'), '--check-drift', '--live', '--format', 'json']]);
    assert.deepEqual(writes, []);
    const text = out.join('');
    assert.equal(text.trimEnd().split('\n').at(-1), 'Nothing was written or sent.');
    assert.match(text, /Population: measured from 1 store/);
    assert.match(text, /re-raise rate:\s+50\.0%/);
    // The same transaction served the report's statements: one connection, every statement READ-only shaped.
    assert.ok(client.seen.some((s) => s.startsWith('SAVEPOINT g_0')));
    assert.ok(client.seen.filter((s) => !/^(SAVEPOINT|RELEASE|SET LOCAL|ROLLBACK)/.test(s)).every((s) => /^\s*(WITH|SELECT)/i.test(s)), 'only reads');
  });
});

describe('capture epochs', () => {
  it('the cohort is the one constant the capture writer stamps', () => {
    assert.deepEqual([...CAPTURE_EPOCHS], ['capture-v1']);
  });
});
