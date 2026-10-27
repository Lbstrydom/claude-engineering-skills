/**
 * Own-model telemetry PR 3 (docs/plans/own-model-telemetry-pr3.md): provenance stamps,
 * the per-call log, the null-rate coverage gate and the transcript archive.
 * Pure / filesystem only; the store halves are in own-model-pr3-db.test.mjs.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeSnapshot, stampDecision, allPassesPropensity, PROVENANCE_SCHEMA_VERSION, SNAPSHOT_MAX_BYTES } from '../scripts/lib/telemetry/provenance.mjs';
import {
  bindRun, record, drain, callIdFor, recordGptCall, routeFor, LLM_CALL_BUFFER_CAP, _resetLlmCallLog,
} from '../scripts/lib/telemetry/llm-call-log.mjs';
import {
  validateConfig, buildMeasureSql, evaluateEntry, exitCodeFor, addedColumns, checkStatic, APPLICABILITY,
} from '../scripts/lib/telemetry/coverage.mjs';
import { archiveTranscript, purgeRepo, verifyArchive, prepareArchive, repoSlug } from '../scripts/lib/telemetry/transcript-archive.mjs';
import { recordFinalReviewCall } from '../scripts/lib/telemetry/final-review-call.mjs';

// The poison pill for this gate is scripts/gate-contracts/own-model-coverage-gate.json; the id below is what ties this
// file's negative controls to it (scripts/check-gate-contracts.mjs refuses a test that does not name its gate).
export const COVERAGE_GATE_ID = 'own-model-coverage-gate-rejects-a-config-with-no-scan-boundary';
const RUN = '11111111-1111-4111-8111-111111111111';
const WORK_ITEM = '01939c4e-7b2a-7c3d-8e4f-0123456789ab';
const tmpDirs = [];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omp3-')); tmpDirs.push(d); return d; };
afterEach(() => {
  _resetLlmCallLog();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('normalizeSnapshot: the content-free promise is executable', () => {
  it('keeps allowed, well-formed keys and drops the rest', () => {
    const r = normalizeSnapshot({ diff_hash: 'abcdef12', prompt_hash: 'ZZ', secret_text: 'hello', precedent_ids: ['a:1', 'bad id with spaces', 'ok_2'] });
    assert.deepEqual(r.snapshot, { diff_hash: 'abcdef12', precedent_ids: ['a:1', 'ok_2'] });
    assert.equal(r.dropped, 3);   // prompt_hash (bad format), secret_text (unknown key), one bad precedent id
  });
  it('null for null, non-object and all-invalid input', () => {
    assert.equal(normalizeSnapshot(null).snapshot, null);
    assert.equal(normalizeSnapshot('x').rejected, 'not-an-object');
    assert.equal(normalizeSnapshot({ nothing: 1 }).snapshot, null);
  });
  it('caps precedent ids at 20 and rejects an oversize result', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `id${i}`);
    assert.equal(normalizeSnapshot({ precedent_ids: ids }).snapshot.precedent_ids.length, 20);
    // The allowlist bounds the worst case below the size cap, so the cap is a backstop that cannot be hit today.
    const worst = normalizeSnapshot({ diff_hash: 'a'.repeat(64), prompt_hash: 'b'.repeat(64), state_hash: 'c'.repeat(64), precedent_ids: Array.from({ length: 20 }, () => 'x'.repeat(64)) });
    assert.ok(Buffer.byteLength(JSON.stringify(worst.snapshot)) <= SNAPSHOT_MAX_BYTES);
  });
});

describe('stampDecision', () => {
  it('always carries version stamps; caller fields are validated, never fabricated', () => {
    const s = stampDecision({});
    assert.equal(s.schemaVersion, PROVENANCE_SCHEMA_VERSION);
    assert.ok(s.toolSha === null || /^[0-9a-f]{7,40}$/.test(s.toolSha));
    assert.ok(s.policyVersion === null || /^[0-9a-f]{16}$/.test(s.policyVersion));
    assert.equal(s.selectionRule, null);
    assert.equal(s.randomised, null);
    assert.equal(s.selectionProbability, null);
  });
  it('rejects an out-of-range probability and a non-boolean randomised flag', () => {
    const s = stampDecision({ selectionProbability: 1.5, randomised: 'yes', eligiblePopulation: -1 });
    assert.equal(s.selectionProbability, null);
    assert.equal(s.randomised, null);
    assert.equal(s.eligiblePopulation, null);
  });
  it('the all-passes propensity is a deterministic rule with probability 1 and nothing skipped', () => {
    const p = allPassesPropensity(5, 'ABCDEF1234');
    assert.deepEqual([p.selectionRule, p.selectionProbability, p.randomised, p.optionsNotChosen, p.eligiblePopulation], ['all-passes', 1, false, [], 5]);
    assert.deepEqual(normalizeSnapshot(p.inputSnapshot).snapshot, { diff_hash: 'abcdef1234' });
    assert.equal(allPassesPropensity(5, null).inputSnapshot, null);
  });
});

describe('llm-call-log', () => {
  it('an unbound log is a counted no-op, never a guess', () => {
    assert.equal(record({ model: 'm' }), false);
    assert.equal(drain(), null);
  });
  it('records metadata only, with a deterministic identity', () => {
    assert.equal(bindRun({ runId: RUN, repoId: null, workItemId: WORK_ITEM, producer: 'audit' }), true);
    record({ purpose: 'structure', model: 'gpt-x', route: 'native', promptHash: 'abcd1234', usage: { input_tokens: 10, output_tokens: 3 }, latencyMs: 120.4 });
    const log = drain();
    assert.equal(log.rows.length, 1);
    const row = log.rows[0];
    assert.equal(row.audit_run_id, RUN);
    assert.equal(row.work_item_id, WORK_ITEM);
    assert.equal(row.input_tokens, 10);
    assert.equal(row.latency_ms, 120);
    assert.equal(row.call_id, callIdFor({ runId: RUN, producer: 'audit', nonce: log.nonce, seq: 0 }));
    assert.deepEqual(Object.keys(row).filter((k) => /text|content|prompt$|response/.test(k)), []);   // no content-bearing column
  });
  it('a malformed work item id is dropped, not stored', () => {
    bindRun({ runId: RUN, workItemId: 'not-a-uuid', producer: 'audit' });
    record({ model: 'm' });
    assert.equal(drain().rows[0].work_item_id, null);
  });
  it('two processes (nonces) never collide on call_id', () => {
    assert.notEqual(callIdFor({ runId: RUN, producer: 'audit', nonce: 'aaaa', seq: 0 }), callIdFor({ runId: RUN, producer: 'audit', nonce: 'bbbb', seq: 0 }));
    assert.notEqual(callIdFor({ runId: RUN, producer: 'audit', nonce: 'aaaa', seq: 0 }), callIdFor({ runId: RUN, producer: 'final-review', nonce: 'aaaa', seq: 0 }));
  });
  it('overflow drops the OLDEST and counts it, so a survivor subset cannot read as complete', () => {
    bindRun({ runId: RUN, producer: 'audit' });
    for (let i = 0; i < LLM_CALL_BUFFER_CAP + 7; i++) record({ model: `m${i}` });
    const log = drain();
    assert.equal(log.rows.length, LLM_CALL_BUFFER_CAP);
    assert.equal(log.dropped, 7);
    assert.equal(log.recorded, LLM_CALL_BUFFER_CAP + 7);
    assert.equal(log.rows[0].model_resolved, 'm7');
  });
  it('recordGptCall hashes the SYSTEM prompt and never keeps it', () => {
    bindRun({ runId: RUN, producer: 'audit' });
    recordGptCall({ result: { model: 'gpt-x', usage: { input_tokens: 1 }, latencyMs: 5, _retried: true }, opts: { passName: 'wiring', system: 'secret rubric text' } });
    const row = drain().rows[0];
    assert.match(row.prompt_hash, /^[0-9a-f]{16}$/);
    assert.equal(row.retried, true);
    assert.equal(row.purpose, 'wiring');
    assert.ok(!JSON.stringify(row).includes('secret rubric'));
  });
  it('the drained payload satisfies the writer contract the finalizer relies on (runId, producer, nonce, rows)', () => {
    bindRun({ runId: RUN, producer: 'audit' });
    record({ model: 'm' });
    const log = drain();
    const payload = { ...log, run_id: RUN };   // exactly what run-persistence.mjs passes to durableWrite
    assert.equal(payload.runId, RUN);
    assert.equal(`${payload.run_id}:${payload.producer}:${payload.nonce}`, `${RUN}:audit:${log.nonce}`);
    assert.ok(Array.isArray(payload.rows) && Number.isInteger(payload.recorded) && Number.isInteger(payload.dropped));
  });
  it('routeFor distinguishes how a model was reached', () => {
    assert.equal(routeFor({ model: 'qwen/qwen3.8-max' }), 'openrouter');
    assert.equal(routeFor({ model: 'qwen3.8-max' }), 'native');
    assert.equal(routeFor({ azure: true, model: 'x' }), 'azure');
    assert.equal(routeFor({ cli: true, model: 'x' }), 'cli');
  });
  it('the final-review recorder skips without a run id and never throws', async () => {
    assert.equal(await recordFinalReviewCall({ runId: null, model: 'm', provider: 'gemini' }), 'skipped');
  });
});

describe('coverage gate: pure core', () => {
  const entry = { table: 'learning_decisions', column: 'tool_sha', since: '2026-10-29', expectFill: 0.9, tolerance: 0.05 };
  it('validateConfig rejects bad shapes, unknown predicates and duplicates', () => {
    assert.deepEqual(validateConfig({ coverageFromMigration: '20261028120000', entries: [entry] }), []);
    assert.ok(validateConfig({ entries: [entry] }).some((e) => e.includes('coverageFromMigration')), 'a missing scan boundary must not silently scan nothing');
    assert.ok(validateConfig({ coverageFromMigration: '20261028120000', entries: [{ ...entry, where: 'drop table' }] })[0].includes('applicability enum'));
    assert.ok(validateConfig({ coverageFromMigration: '20261028120000', entries: [{ ...entry, table: 'x; DROP' }] }).length > 0);
    assert.ok(validateConfig({ coverageFromMigration: '20261028120000', entries: [{ ...entry, expectFill: 2 }] }).length > 0);
    assert.ok(validateConfig({ coverageFromMigration: '20261028120000', entries: [entry, entry] }).some((e) => e.includes('duplicate')));
    assert.ok(validateConfig({}).length > 0);
  });
  it('buildMeasureSql only ever uses enum predicates and a bound date', () => {
    const { sql, params } = buildMeasureSql({ ...entry, where: 'pass_selection' });
    assert.ok(sql.includes(APPLICABILITY.pass_selection));
    assert.deepEqual(params, ['2026-10-29', 30]);
    assert.ok(sql.includes('now() -'), 'rolling window, not all-time');
    assert.deepEqual(buildMeasureSql(entry, 7).params, ['2026-10-29', 7]);
    assert.throws(() => buildMeasureSql({ ...entry, column: 'a b' }));
    assert.throws(() => buildMeasureSql({ ...entry, where: 'nope' }));
  });
  it('evaluateEntry: zero rows is unmeasured (never green), floor and drift are distinct', () => {
    assert.equal(evaluateEntry(entry, { total: 0, filled: 0 }).status, 'unmeasured:no-eligible-rows');
    assert.equal(evaluateEntry(entry, null).status, 'unmeasured:store');
    assert.equal(evaluateEntry(entry, { total: 10, filled: 10 }).status, 'ok');
    assert.equal(evaluateEntry(entry, { total: 10, filled: 5 }).status, 'below-floor');
    const withBase = { ...entry, expectFill: 0.5, baselineRate: 0.99 };
    assert.equal(evaluateEntry(withBase, { total: 100, filled: 80 }).status, 'drift');
    assert.equal(evaluateEntry(withBase, { total: 100, filled: 96 }).status, 'ok');
    assert.equal(evaluateEntry(entry, { total: 5, filled: 9 }).status, 'unmeasured:store');   // impossible counts are not a rate
  });
  it('exitCodeFor: a known-bad column outranks an unreadable one', () => {
    assert.equal(exitCodeFor([{ status: 'ok' }]), 0);
    assert.equal(exitCodeFor([{ status: 'ok' }, { status: 'unmeasured:store' }]), 3);
    assert.equal(exitCodeFor([{ status: 'unmeasured:store' }, { status: 'below-floor' }]), 1);
    assert.equal(exitCodeFor([{ status: 'drift' }]), 1);
  });
  it('addedColumns reads nullable ADD COLUMNs at or after a migration and ignores NOT NULL and comments', () => {
    const cols = addedColumns([
      { name: '20261027000000_old.sql', sql: 'ALTER TABLE a ADD COLUMN IF NOT EXISTS old_col text;' },
      { name: '20261028120000_new.sql', sql: '-- ALTER TABLE a ADD COLUMN commented text;\nALTER TABLE a ADD COLUMN IF NOT EXISTS fresh text;\nALTER TABLE a ADD COLUMN IF NOT EXISTS must_have boolean NOT NULL DEFAULT false;' },
    ], '20261028120000');
    assert.deepEqual(cols, [{ table: 'a', column: 'fresh', migration: '20261028120000_new.sql' }]);
  });
  it('addedColumns sees every ADD COLUMN action of one ALTER TABLE statement', () => {
    const cols = addedColumns([{ name: '20261028120000_m.sql', sql: 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a text, ADD COLUMN IF NOT EXISTS b numeric(10, 2), ADD COLUMN c boolean NOT NULL DEFAULT false, ADD COLUMN d jsonb;' }], '20261028120000');
    assert.deepEqual(cols.map((c) => c.column), ['a', 'b', 'd']);
  });
  it('checkStatic negative controls: a column the fixture lacks, an untracked new column, an unreasoned exemption', () => {
    const schema = new Map([['learning_decisions', new Set(['tool_sha'])]]);
    const mig = [{ name: '20261028120000_x.sql', sql: 'ALTER TABLE learning_decisions ADD COLUMN IF NOT EXISTS brand_new text;' }];
    const base = { coverageFromMigration: '20261028120000', entries: [entry] };
    const errs = checkStatic(base, schema, mig);
    assert.ok(errs.some((e) => e.includes('brand_new') && e.includes('no coverage entry')));
    assert.ok(checkStatic({ ...base, entries: [{ ...entry, column: 'ghost' }] }, schema, []).some((e) => e.includes('not in the schema fixture')));
    assert.ok(checkStatic({ ...base, exempt: [{ table: 'learning_decisions', column: 'brand_new', reason: ' ' }] }, schema, mig).some((e) => e.includes('needs a reason')));
    assert.deepEqual(checkStatic({ ...base, exempt: [{ table: 'learning_decisions', column: 'brand_new', reason: 'derived' }] }, schema, mig), []);
  });
  it('the COMMITTED config passes the static gate against the committed fixture and migrations', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.own-model-coverage.json'), 'utf8'));
    const fx = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'expected-schema.json'), 'utf8'));
    const schema = new Map(fx.tables.map((t) => [t.table_name, new Set(t.columns.map((c) => c.column_name))]));
    const dir = path.join(root, 'supabase', 'migrations');
    const migs = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => ({ name: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
    assert.ok(cfg.entries.length > 10, 'vacuous-pass guard: the config tracks real columns');
    assert.deepEqual(checkStatic(cfg, schema, migs), []);
  });
});

describe('transcript archive', () => {
  const args = (dir, over = {}) => ({ dir, repo: 'Lbstrydom/claude-engineering-skills', coordinator: 'CES', date: '2026-10-27', text: 'decision: use the ledger', flag: true, ...over });

  it('stores redacted content for an eligible repo and records a manifest row', () => {
    const dir = mkTmp();
    const r = archiveTranscript(args(dir, { text: 'key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD in text' }));
    assert.equal(r.state, 'archived');
    assert.equal(r.contentState, 'full');
    const row = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8').trim());
    assert.equal(row.training_eligible, true);
    const blob = fs.readFileSync(path.join(dir, 'blobs', repoSlug('Lbstrydom/claude-engineering-skills'), r.sha256), 'utf8');
    assert.ok(!blob.includes('sk-proj-abcdefghijklmnopqrstuvwxyz'));
  });
  it('NEVER stores content for a false, undecided or unreachable flag (the storyline rule)', () => {
    for (const flag of [false, null, 'unknown']) {
      const dir = mkTmp();
      const r = archiveTranscript(args(dir, { repo: 'wartsila/storyline', flag, text: 'confidential client material' }));
      assert.equal(r.contentState, 'structure-only');
      assert.equal(fs.existsSync(path.join(dir, 'blobs')), false, `blobs dir must not exist for flag=${flag}`);
      assert.ok(!fs.readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8').includes('confidential'));
    }
  });
  it('distinct repo names never share an identity, even when their readable parts collide', () => {
    assert.notEqual(repoSlug('a/b'), repoSlug('a__b'));
    assert.notEqual(repoSlug('A/B'), repoSlug('a/b'));
    assert.notEqual(repoSlug(`o/${'x'.repeat(120)}1`), repoSlug(`o/${'x'.repeat(120)}2`));
  });
  it('a structure-only row does not swallow a later eligible request, and a lost blob is restored', () => {
    const dir = mkTmp();
    assert.equal(archiveTranscript(args(dir, { flag: 'unknown' })).contentState, 'structure-only');
    const up = archiveTranscript(args(dir, { flag: true }));
    assert.equal(up.state, 'archived');
    assert.equal(up.contentState, 'full');
    fs.rmSync(path.join(dir, 'blobs', repoSlug('Lbstrydom/claude-engineering-skills'), up.sha256), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    assert.equal(archiveTranscript(args(dir, { flag: true })).state, 'archived', 'restored, not reported duplicate');
    assert.equal(archiveTranscript(args(dir, { flag: true })).state, 'duplicate', 'and a third identical request is a duplicate even though an older structure-only row exists');
    assert.equal(verifyArchive({ dir }).ok, true);
  });
  it('a crash-truncated LAST manifest line is tolerated; corruption elsewhere is not', () => {
    const dir = mkTmp();
    archiveTranscript(args(dir));
    fs.appendFileSync(path.join(dir, 'manifest.jsonl'), '{"repo":"trunc');
    assert.equal(archiveTranscript(args(dir, { text: 'next' })).state, 'archived');
    const m = fs.readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8').split('\n');
    assert.ok(m.every((l) => !l.includes('trunc')), 'the truncated tail was dropped when the next row was written');
    fs.writeFileSync(path.join(dir, 'manifest.jsonl'), ['{bad', ...m.filter(Boolean)].join('\n') + '\n');
    assert.throws(() => archiveTranscript(args(dir, { text: 'again' })), /corrupt/);
  });
  it('is idempotent per repo and content', () => {
    const dir = mkTmp();
    assert.equal(archiveTranscript(args(dir)).state, 'archived');
    assert.equal(archiveTranscript(args(dir)).state, 'duplicate');
    assert.equal(fs.readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8').trim().split('\n').length, 1);
  });
  it('identical content in two repos keeps two blobs, and purging one cannot remove the other', () => {
    const dir = mkTmp();
    archiveTranscript(args(dir, { repo: 'a/one' }));
    archiveTranscript(args(dir, { repo: 'b/two' }));
    const out = purgeRepo({ dir, repo: 'a/one' });
    assert.equal(out.blobsRemoved, 1);
    assert.equal(out.rowsRemoved, 1);
    assert.equal(fs.readdirSync(path.join(dir, 'blobs', repoSlug('b/two'))).length, 1);
    assert.equal(verifyArchive({ dir }).ok, true);
  });
  it('verify reports an orphan blob and a dangling row, and repair fixes both', () => {
    const dir = mkTmp();
    const r = archiveTranscript(args(dir));
    const slugDir = path.join(dir, 'blobs', repoSlug('Lbstrydom/claude-engineering-skills'));
    fs.writeFileSync(path.join(slugDir, 'deadbeef'), 'orphan');           // blob, no row
    archiveTranscript(args(dir, { text: 'second transcript' }));
    const second = fs.readdirSync(slugDir).find((f) => f !== r.sha256 && f !== 'deadbeef');
    fs.rmSync(path.join(slugDir, second), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });                              // row, no blob
    const v = verifyArchive({ dir });
    assert.equal(v.ok, false);
    assert.equal(v.orphanBlobs.length, 1);
    assert.equal(v.danglingRows.length, 1);
    verifyArchive({ dir, repair: true });
    assert.equal(verifyArchive({ dir }).ok, true);
  });
  it('refuses a stale-free concurrent writer: a held lock is a visible error', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, '.lock'), String(Date.now()));
    assert.throws(() => archiveTranscript(args(dir)), /holds the lock/);
  });
  it('rejects a bad coordinator, date and an unusable repo name', () => {
    const dir = mkTmp();
    assert.equal(archiveTranscript(args(dir, { coordinator: 'XYZ' })).reason, 'bad-coordinator');
    assert.equal(archiveTranscript(args(dir, { date: 'yesterday' })).reason, 'bad-date');
    assert.throws(() => repoSlug('..'));
    assert.throws(() => repoSlug(''));
  });
  it('prepareArchive: only an exact true flag yields content', () => {
    assert.equal(prepareArchive('x', true).contentState, 'full');
    assert.equal(prepareArchive('x', 'true').contentState, 'structure-only');
    assert.equal(prepareArchive('x', undefined).contentState, 'structure-only');
  });
});
