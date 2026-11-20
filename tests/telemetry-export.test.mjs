/**
 * @fileoverview `telemetry-export/v1` — Tier 3 (sensitive-path egress): the schema, the
 * redaction layer, the builder and the delivery land with their tests in ONE commit.
 *
 * The canary fixture is the heart of it: a planted token, a planted `~/.ssh` path, a planted
 * hostname, a planted repo name and a planted issue title are pushed through every layer, and
 * NONE of their bytes may appear in the serialised export.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_ID, validateExport, TelemetryExportSchema, MAX_UPSTREAM_ROWS, SEVERITIES, PASSES,
} from '../scripts/lib/telemetry-export/schema.mjs';
import { assertExportClean, ExportRefusedError } from '../scripts/lib/telemetry-export/redact.mjs';
import { buildExport, mapAuditRows, mapUpstreamRows, displayId, reasonForError } from '../scripts/lib/telemetry-export/build.mjs';
import { makeRowReader, SQL } from '../scripts/lib/telemetry-export/sources.mjs';
import { deliverExport, exportFileName } from '../scripts/lib/telemetry-export/deliver.mjs';
import { isReadOnlyStatement } from '../scripts/lib/db/query.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANARIES = Object.freeze({
  token: 'sk-ant-api03-CANARYCANARYCANARYCANARYCANARY',
  sshPath: '~/.ssh/id_rsa',
  host: 'audit-db.corp-internal.example.com',
  repo: 'acme-secret-repo-name',
  title: 'Customer Foobar breach in billing module',
});

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-')); roots.push(d); return d; };

const NOW = new Date('2026-11-20T10:00:00.000Z');
const EXPORT_ID = '0b9c1f3e-6d1a-4b6e-8a53-3f5a2f1c9d77';

function deps(over = {}) {
  return {
    reachability: async () => ({ configured: true, ok: true }),
    drift: async () => ({ ok: true, drift: { hasDrift: false, drift: { unapplied: [], shaMismatch: [] }, liveConstraints: { measured: true, missing: [], altered: [] } } }),
    readRows: async () => ({
      status: 'ok',
      runs: [{ mode: 'code', gemini_verdict: 'APPROVE', converged: true, n: 3 }, { mode: 'plan', gemini_verdict: null, converged: false, n: 1 }],
      findings: [{ severity: 'HIGH', adjudication_outcome: 'accepted', pass_name: 'backend', n: 2 }, { severity: 'LOW', adjudication_outcome: null, pass_name: 'structure', n: 5 }],
      upstream: [{ id: '11111111-1111-4111-8111-111111111111', severity: 'HIGH', created_at: '2026-11-10T10:00:00.000Z' }],
      totalOpen: 1,
    }),
    ...over,
  };
}
const build = (d = deps()) => buildExport({ now: NOW, consumerAlias: 'acme', storeFingerprint: 'a'.repeat(16), toolBundleSha: 'b'.repeat(40), exportId: EXPORT_ID, deps: d });

describe('schema: allowlist by construction', () => {
  it('a built export validates, and the schema id is the literal', async () => {
    const doc = await build();
    assert.equal(doc.schema, SCHEMA_ID);
    assert.equal(validateExport(doc).ok, true);
  });

  it('an unknown key is a rejection at every level (strict), never a pass-through', async () => {
    const doc = await build();
    for (const mutate of [
      (d) => { d.repoName = CANARIES.repo; },
      (d) => { d.health.host = CANARIES.host; },
      (d) => { d.audit.title = CANARIES.title; },
      (d) => { d.upstream.open[0].title = CANARIES.title; },
      (d) => { d.window.tz = 'x'; },
    ]) {
      const copy = structuredClone(doc); mutate(copy);
      assert.equal(validateExport(copy).ok, false);
    }
  });

  it('there is no free-text field: strings are enums or bounded formats', async () => {
    const doc = await build();
    for (const mutate of [
      (d) => { d.consumerAlias = 'Has Space'; },
      (d) => { d.consumerAlias = 'x'.repeat(33); },
      (d) => { d.storeFingerprint = 'not-hex'; },
      (d) => { d.toolBundleSha = 'abc'; },
      (d) => { d.generatedAt = 'yesterday'; },
      (d) => { d.exportId = 'nope'; },
      (d) => { d.upstream.open[0].severity = 'CRITICAL-ish'; },
      (d) => { d.upstream.open[0].id = CANARIES.title; },
      (d) => { d.health.store = CANARIES.host; },
    ]) {
      const copy = structuredClone(doc); mutate(copy);
      assert.equal(validateExport(copy).ok, false);
    }
  });

  it('a validation failure names a PATH, never the offending value', async () => {
    const doc = await build();
    doc.consumerAlias = CANARIES.token;
    const r = validateExport(doc);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.reason, /CANARY/);
  });

  it('an unmeasured group carries NO counts (it cannot be summed as zero)', () => {
    const bad = { measured: false, reason: 'store-unreachable', runs: 0 };
    assert.equal(TelemetryExportSchema.shape.audit.safeParse(bad).success, false);
  });

  it('cross-field checks: breakdowns must sum, flags must agree', async () => {
    const doc = await build();
    const a = structuredClone(doc); a.audit.byMode.code += 1;
    assert.equal(validateExport(a).ok, false);
    const b = structuredClone(doc); b.upstream.truncated = true;
    assert.equal(validateExport(b).ok, false);
    const c = structuredClone(doc); c.audit.convergedRuns = c.audit.runs + 1;
    assert.equal(validateExport(c).ok, false);
  });
});

describe('redaction layer (fail-closed, names the category, never the text)', () => {
  it('a clean export passes', async () => { const d = await build(); assert.doesNotThrow(() => assertExportClean(structuredClone(d))); });

  for (const [name, value, category] of [
    ['an API token', CANARIES.token, 'secret'],
    ['a sensitive path', CANARIES.sshPath, 'sensitive-path'],
    ['a hostname', CANARIES.host, 'hostname'],
    ['an IPv4 address', '10.20.30.40', 'ipv4-address'],
    ['a URL', 'https://corp.internal/path', 'url'],
    ['a DSN with userinfo', 'postgres://svc:hunter2@db:5432/x', 'dsn-userinfo'],
    ['an e-mail', 'jane.doe@corp.example', 'email'],
    ['a Windows path', 'C:\\Users\\jane\\repo', 'windows-path'],
  ]) {
    it(`refuses ${name} in a value`, () => {
      assert.throws(() => assertExportClean({ x: { y: value } }), (e) => e instanceof ExportRefusedError && e.categories.includes(category) && !e.message.includes(value));
    });
    it(`refuses ${name} in a KEY`, () => {
      assert.throws(() => assertExportClean({ [value]: 1 }), (e) => e instanceof ExportRefusedError);
    });
  }

  it('CONTROL — timestamps, hex digests, uuids and the enum vocabulary do not trip it (it is not a blanket refusal)', async () => {
    const doc = await build();
    assert.doesNotThrow(() => assertExportClean(doc));
  });
});

describe('builder: the canary never reaches the serialised bytes', () => {
  it('canary-laden source rows map to enums/handles; no canary byte survives', async () => {
    const d = deps({
      readRows: async () => ({
        status: 'ok',
        runs: [{ mode: CANARIES.repo, gemini_verdict: CANARIES.title, converged: false, n: 2, plan_file: CANARIES.sshPath }],
        findings: [{ severity: CANARIES.token, adjudication_outcome: CANARIES.host, pass_name: CANARIES.repo, n: 4, detail_snapshot: CANARIES.title, primary_file: CANARIES.sshPath }],
        upstream: [{ id: CANARIES.host, severity: CANARIES.title, created_at: '2026-11-19T10:00:00.000Z', title: CANARIES.title, body: CANARIES.token, name: CANARIES.repo }],
        totalOpen: 1,
      }),
    });
    const doc = await build(d);
    const bytes = JSON.stringify(doc);
    for (const v of Object.values(CANARIES)) assert.equal(bytes.includes(v), false, `canary leaked: ${v.slice(0, 12)}`);
    assert.ok(doc.redactions > 0, 'the misses were counted, not hidden');
    assert.equal(doc.audit.byMode.other, 2);
    assert.equal(doc.upstream.open[0].severity, 'other');
  });
});

describe('builder: measured honesty (idle is a measurement, unreadable is a gap)', () => {
  it('a store that is not reachable gives unmeasured groups with NO counts — never zeros', async () => {
    const doc = await build(deps({ reachability: async () => ({ configured: true, ok: false }) }));
    assert.equal(doc.health.store, 'configured-but-unreachable');
    for (const g of [doc.audit, doc.upstream, doc.health.drift]) {
      assert.equal(g.measured, false);
      assert.equal(g.reason, 'store-unreachable');
      assert.equal('runs' in g, false);
    }
  });

  it('no store configured is its own state', async () => {
    const doc = await build(deps({ reachability: async () => ({ configured: false }) }));
    assert.equal(doc.health.store, 'unconfigured');
    assert.equal(doc.audit.reason, 'store-unconfigured');
  });

  it('CONTROL — a week with no audits is a genuine zero, measured:true', async () => {
    const doc = await build(deps({ readRows: async () => ({ status: 'ok', runs: [], findings: [], upstream: [], totalOpen: 0 }) }));
    assert.equal(doc.audit.measured, true);
    assert.equal(doc.audit.runs, 0);
    assert.equal(doc.upstream.measured, true);
    assert.deepEqual(doc.upstream.open, []);
  });

  it('an unregistered repo is unmeasured with its own reason, not an empty week', async () => {
    const doc = await build(deps({ readRows: async () => ({ status: 'repo-unregistered' }) }));
    assert.deepEqual(doc.audit, { measured: false, reason: 'repo-unregistered' });
  });

  it('a reader that throws is unmeasured with a CLOSED reason (never the message, which can carry a host)', async () => {
    const err = Object.assign(new Error(`connect ECONNREFUSED ${CANARIES.host}:5432`), { code: 'ECONNREFUSED' });
    const doc = await build(deps({ readRows: async () => { throw err; } }));
    assert.equal(doc.audit.reason, 'store-unreachable');
    assert.equal(JSON.stringify(doc).includes(CANARIES.host), false);
    assert.equal(reasonForError(Object.assign(new Error('x'), { code: '42P01' })), 'schema-fault');
    assert.equal(reasonForError(new Error('boom')), 'read-failed');
  });

  it('drift with live constraints NOT measured is unmeasured, not "0 broken"', async () => {
    const doc = await build(deps({ drift: async () => ({ ok: true, drift: { hasDrift: false, drift: {}, liveConstraints: { measured: false } } }) }));
    assert.equal(doc.health.drift.measured, false);
  });

  it('upstream rows over the cap are truncated and say so; ids are display handles, ages are whole days', () => {
    const rows = Array.from({ length: MAX_UPSTREAM_ROWS + 1 }, (_, i) => ({ id: `row-${i}`, severity: 'LOW', created_at: '2026-11-18T10:00:00.000Z' }));
    const g = mapUpstreamRows(rows, 500, NOW, { n: 0 });
    assert.equal(g.open.length, MAX_UPSTREAM_ROWS);
    assert.equal(g.truncated, true);
    assert.match(g.open[0].id, /^[0-9a-f]{12}$/);
    assert.equal(g.open[0].ageDays, 2);
    assert.equal(displayId('row-0'), displayId('row-0'));
  });

  it('every enum key is present in a count object (a missing key would read as an unreported zero)', () => {
    const g = mapAuditRows({ runs: [], findings: [] }, { n: 0 });
    assert.deepEqual(Object.keys(g.findingsBySeverity).sort(), [...SEVERITIES].sort());
    assert.deepEqual(Object.keys(g.findingsByPass).sort(), [...PASSES].sort());
  });
});

describe('sources: read-only, one snapshot, repo-scoped, no writes', () => {
  it('every statement is a SELECT/SET TRANSACTION and the transaction is READ ONLY', () => {
    for (const [k, sql] of Object.entries(SQL)) {
      if (k === 'setTx') { assert.match(sql, /READ ONLY/); continue; }
      assert.equal(isReadOnlyStatement(sql), true, k);
    }
  });

  it('the SELECT lists name no free-text column (title, body, detail_snapshot, primary_file, plan_file, name)', () => {
    const all = Object.values(SQL).join('\n');
    for (const col of ['title', 'body', 'detail_snapshot', 'primary_file', 'plan_file', 'affected_path', 'branch']) {
      assert.equal(new RegExp(`\\b${col}\\b`).test(all), false, col);
    }
  });

  const fake = (over = {}) => {
    const seen = [];
    return {
      seen,
      deps: {
        withTx: async (fn) => fn({}),
        query: async (sql) => { seen.push(sql); return []; },
        many: async (sql, params) => { seen.push(sql); return sql === SQL.upstreamTotal ? [{ n: 3 }] : []; },
        getRepoIdByUuid: async () => ({ id: 'repo-1' }),
        resolveRepoIdentity: () => ({ repoUuid: 'u-1' }),
        ...over,
      },
    };
  };

  it('runs setTx FIRST, then the four reads inside the same transaction', async () => {
    const f = fake();
    const r = await makeRowReader(f.deps)({ from: new Date(NOW - 7 * 864e5), to: NOW });
    assert.equal(r.status, 'ok');
    assert.equal(r.totalOpen, 3);
    assert.equal(f.seen[0], SQL.setTx);
    assert.equal(f.seen.length, 5);
  });

  it('no repo identity / no registered repo are their own statuses (and no read runs)', async () => {
    const f1 = fake({ resolveRepoIdentity: () => ({ repoUuid: null }) });
    assert.deepEqual(await makeRowReader(f1.deps)({ from: NOW, to: NOW }), { status: 'repo-unresolved' });
    const f2 = fake({ getRepoIdByUuid: async () => null });
    assert.deepEqual(await makeRowReader(f2.deps)({ from: NOW, to: NOW }), { status: 'repo-unregistered' });
    assert.equal(f2.seen.length, 0);
  });

  it('a lookup error PROPAGATES (it is not "unregistered")', async () => {
    const f = fake({ getRepoIdByUuid: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } });
    await assert.rejects(() => makeRowReader(f.deps)({ from: NOW, to: NOW }));
  });
});

describe('delivery: one primitive — a file in the drop directory', () => {
  it('writes <alias>/<date>-<id8>.json atomically, leaving no temp file', async () => {
    const dir = tmp();
    const doc = await build();
    const r = deliverExport({ doc, dropDir: dir });
    assert.equal(r.pushed, false);
    assert.equal(path.relative(dir, r.file).split(path.sep).join('/'), exportFileName(doc));
    assert.equal(exportFileName(doc), 'acme/2026-11-20-0b9c1f3e.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')), doc);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'acme')), ['2026-11-20-0b9c1f3e.json']);
  });

  it('exports are IMMUTABLE: the same name is refused, a same-day repeat is a second file', async () => {
    const dir = tmp();
    const doc = await build();
    deliverExport({ doc, dropDir: dir });
    assert.throws(() => deliverExport({ doc, dropDir: dir }), /immutable/);
    const second = { ...doc, exportId: '1b9c1f3e-6d1a-4b6e-8a53-3f5a2f1c9d77' };
    deliverExport({ doc: second, dropDir: dir });
    assert.equal(fs.readdirSync(path.join(dir, 'acme')).length, 2);
  });

  it('a missing drop directory is refused (the exporter never creates its destination)', async () => {
    const doc = await build();
    assert.throws(() => deliverExport({ doc, dropDir: path.join(tmp(), 'nope') }), /does not exist/);
    assert.throws(() => deliverExport({ doc, dropDir: '' }), /no drop directory/);
  });

  it('an alias that is not a valid alias cannot reach the filesystem', async () => {
    const doc = { ...(await build()), consumerAlias: '../../etc' };
    assert.throws(() => deliverExport({ doc, dropDir: tmp() }), /valid alias/);
  });

  it('--push runs EXACTLY rev-parse, add, commit, push — never force, nothing else', async () => {
    const dir = tmp();
    const calls = [];
    const r = deliverExport({ doc: await build(), dropDir: dir, push: true, exec: (cmd, args) => { calls.push([cmd, ...args]); return ''; } });
    assert.equal(r.pushed, true);
    assert.deepEqual(calls.map((c) => c[1]), ['rev-parse', 'add', 'commit', 'push']);
    assert.ok(calls.every((c) => c[0] === 'git'));
    assert.equal(calls.flat().some((a) => /force|-f$|--delete|reset|checkout|branch|remote/.test(a)), false);
  });

  it('CONTROL — without --push git is never invoked', async () => {
    let called = 0;
    deliverExport({ doc: await build(), dropDir: tmp(), exec: () => { called++; return ''; } });
    assert.equal(called, 0);
  });

  it('a failing push surfaces (the file is already safely written, the caller is told)', async () => {
    const doc = await build();
    assert.throws(() => deliverExport({ doc, dropDir: tmp(), push: true, exec: (c, a) => { if (a[0] === 'push') throw new Error('rejected'); return ''; } }), /rejected/);
  });
});

describe('the CLI', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'telemetry-export.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf-8', timeout: 90000, windowsHide: true,
    env: { ...process.env, AUDIT_DB_URL: '', TELEMETRY_CONSUMER_ALIAS: '', TELEMETRY_DROP_DIR: '', ...env },
  });

  it('--selfcheck-relocation prints OK', () => assert.equal(run(['--selfcheck-relocation']).stdout.trim().split('\n').pop(), 'OK'));
  it('refuses an unknown flag, a bad alias, and a missing drop directory (exit 2, nothing written)', () => {
    assert.equal(run(['--alias', 'acme', '--bogus']).status, 2);
    assert.equal(run(['--alias', 'Not Valid', '--print']).status, 2);
    assert.equal(run(['--alias', 'acme']).status, 2);
  });

  it('end to end with no store configured: writes a valid export whose groups are unmeasured', () => {
    const dir = tmp();
    const r = run(['--alias', 'acme', '--drop-dir', dir]);
    assert.equal(r.status, 0, r.stderr);
    const file = JSON.parse(r.stdout.trim().split('\n').pop()).file;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(validateExport(doc).ok, true);
    assert.equal(doc.health.store, 'unconfigured');
    assert.equal(doc.audit.measured, false);
  });
});
