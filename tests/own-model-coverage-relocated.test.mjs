/**
 * @fileoverview Tier 3 (consumer sync / relocation contract) guard for shipping
 * `own-model-coverage.mjs` and its floors config to consumers
 * (docs/plans/policy-private-consumer-stores.md Phase 3).
 *
 * A policy-private consumer must run the coverage check against ITS OWN store, so the CLI
 * and its three inputs have to land in the consumer and be found there. This drives the REAL
 * `sync-to-repos.mjs` into a real temp git repo, then runs the relocated CLI from the consumer
 * root: a resolver that counted `..` from `scripts/.claude-skills/` would miss every input.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { getSyncClosure } from '../scripts/lib/sync-inventory.mjs';
import { isCoOwnedJsonDest, LAYOUT_CONSTANTS } from '../scripts/lib/sync-path-map.mjs';
import {
  resolveCoverageInputs, loadCoverageConfig, loadSchemaColumns, loadMigrations, CoverageInputMissingError, tryLoadCoverageConfig,
} from '../scripts/lib/telemetry/coverage-inputs.mjs';
import { seedInstalledDeps, runSyncCli, whySyncFailed, git } from './helpers/consumer-fixture.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_SRC = 'scripts/own-model-coverage.mjs';
const CLI_DEST = 'scripts/.claude-skills/own-model-coverage.mjs';
const CFG_DEST = '.audit-loop/own-model-coverage.json';
const lf = (t) => t.split('\r\n').join('\n');

describe('sync closure declares the CLI and its config', () => {
  const { files } = getSyncClosure();
  it('contains the CLI', () => assert.ok(files.includes(CLI_SRC)));
  it('contains the config', () => assert.ok(files.includes(LAYOUT_CONSTANTS.OWN_MODEL_COVERAGE_SRC)));
  it('carries what `telemetry-export --report` imports (a consumer runs the report)', () => {
    for (const f of ['scripts/lib/telemetry-export/report.mjs', 'scripts/lib/telemetry/capture-queries.mjs', 'scripts/lib/telemetry/coverage-inputs.mjs', 'scripts/lib/capture-epoch.mjs', 'scripts/lib/audit/tiered-shadow-summary.mjs', 'scripts/lib/store/tiered-shadow.mjs']) {
      assert.ok(files.includes(f), `${f} is not in the sync closure`);
    }
  });
  it('the config is upstream-exclusive (replaced, never merged)', () => {
    assert.equal(isCoOwnedJsonDest(LAYOUT_CONSTANTS.OWN_MODEL_COVERAGE_SRC), false);
    // positive control: a genuinely co-owned JSON is still classified as such.
    assert.equal(isCoOwnedJsonDest('.claude/settings.json'), true);
  });
});

describe('the input resolver reads the right file in BOTH layouts', () => {
  let tmp;
  const write = (root, rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  const cfg = (marker) => JSON.stringify({ marker, entries: [] });
  const schema = (marker) => JSON.stringify({ tables: [{ table_name: marker, columns: [{ column_name: 'c' }] }] });
  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-covin-')));
    // source layout: SOURCE-marked content at source paths.
    write(path.join(tmp, 'src'), '.own-model-coverage.json', cfg('source'));
    write(path.join(tmp, 'src'), 'tests/fixtures/expected-schema.json', schema('t_source'));
    write(path.join(tmp, 'src'), 'supabase/migrations/001_source.sql', '-- source');
    // consumer layout: DIFFERENT content at the mapped paths, plus decoys at the source paths.
    write(path.join(tmp, 'con'), CFG_DEST, cfg('consumer'));
    write(path.join(tmp, 'con'), '.audit-loop/expected-schema.json', schema('t_consumer'));
    write(path.join(tmp, 'con'), '.audit-loop/migrations/002_consumer.sql', '-- consumer');
    write(path.join(tmp, 'con'), '.own-model-coverage.json', cfg('DECOY'));
    write(path.join(tmp, 'con'), 'supabase/migrations/999_decoy.sql', '-- decoy');
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  it('a bare-string column the validator accepts maps to its NAME (R3 H1)', () => {
    const root = path.join(tmp, 'bare');
    write(root, 'tests/fixtures/expected-schema.json', JSON.stringify({ tables: [{ table_name: 't_bare', columns: ['tool_sha', { column_name: 'mode' }] }] }));
    const cols = loadSchemaColumns(resolveCoverageInputs(root, 'source')).get('t_bare');
    assert.deepEqual([...cols].sort(), ['mode', 'tool_sha']);
  });

  it('source layout uses the source paths unchanged', () => {
    const inp = resolveCoverageInputs(path.join(tmp, 'src'), 'source');
    assert.equal(inp.config.rel, '.own-model-coverage.json');
    assert.equal(loadCoverageConfig(inp).marker, 'source');
    assert.ok(loadSchemaColumns(inp).has('t_source'));
    assert.deepEqual(loadMigrations(inp).map((m) => m.name), ['001_source.sql']);
  });
  it('consumer layout goes through the sync path map', () => {
    const inp = resolveCoverageInputs(path.join(tmp, 'con'), 'consumer');
    assert.equal(inp.config.rel, CFG_DEST);
    assert.equal(inp.schema.rel, '.audit-loop/expected-schema.json');
    assert.equal(inp.migrations.rel, '.audit-loop/migrations');
    assert.equal(loadCoverageConfig(inp).marker, 'consumer', 'must not read the decoy at the source path');
    assert.ok(loadSchemaColumns(inp).has('t_consumer'));
    assert.deepEqual(loadMigrations(inp).map((m) => m.name), ['002_consumer.sql']);
  });
  it('a schema fixture of the wrong shape is a typed error naming the mapped path, never an empty schema', () => {
    for (const [label, body] of [['empty tables', '{"tables": []}'], ['no tables key', '{}'], ['table without columns', '{"tables":[{"table_name":"t"}]}'], ['table without a name', '{"tables":[{"columns":[]}]}'], ['not JSON', 'nope'],
      ['nameless column object', '{"tables":[{"table_name":"t","columns":[{}]}]}'], ['empty column name', '{"tables":[{"table_name":"t","columns":[{"column_name":""}]}]}'],
      ['numeric column', '{"tables":[{"table_name":"t","columns":[7]}]}'], ['view column nameless', '{"tables":[{"table_name":"t","columns":[]}],"views":[{"view_name":"v","columns":[{}]}]}']]) {
      const root = path.join(tmp, `bad-${label.replace(/\W/g, '')}`);
      write(root, '.audit-loop/expected-schema.json', body);
      const inp = resolveCoverageInputs(root, 'consumer');
      assert.throws(() => loadSchemaColumns(inp), (e) => e instanceof CoverageInputMissingError && e.message.includes('.audit-loop/expected-schema.json') && /invalid/.test(e.message), label);
    }
    // control: a minimal valid fixture loads.
    const ok = path.join(tmp, 'ok-schema');
    write(ok, '.audit-loop/expected-schema.json', schema('t_ok'));
    assert.ok(loadSchemaColumns(resolveCoverageInputs(ok, 'consumer')).has('t_ok'));
    // control: the REAL fixture shape (object columns, views with a definition and no column list) loads.
    const real = path.join(tmp, 'real-schema');
    write(real, '.audit-loop/expected-schema.json', fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/expected-schema.json'), 'utf8'));
    assert.ok(loadSchemaColumns(resolveCoverageInputs(real, 'consumer')).size > 10);
  });
  it('an input that exists but cannot be READ says "could not read", not "not valid JSON" or "missing"', () => {
    // A directory where the file should be: EISDIR on every platform (no permission games needed).
    const root = path.join(tmp, 'unreadable');
    fs.mkdirSync(path.join(root, '.audit-loop/expected-schema.json'), { recursive: true });
    fs.mkdirSync(path.join(root, '.audit-loop/own-model-coverage.json'), { recursive: true });
    const inp = resolveCoverageInputs(root, 'consumer');
    assert.throws(() => loadSchemaColumns(inp), (e) => e instanceof CoverageInputMissingError && /could not read/.test(e.message) && !/not valid JSON|missing/.test(e.message));
    assert.deepEqual(tryLoadCoverageConfig(inp), { config: null, problem: 'config-unreadable' });
    assert.deepEqual(tryLoadCoverageConfig(resolveCoverageInputs(path.join(tmp, 'nowhere'), 'consumer')), { config: null, problem: 'config-missing' });
  });
  it('a missing input throws a typed error naming the MAPPED repo-relative path', () => {
    const inp = resolveCoverageInputs(path.join(tmp, 'nowhere'), 'consumer');
    assert.throws(() => loadCoverageConfig(inp), (e) => e instanceof CoverageInputMissingError && e.message.includes(CFG_DEST));
    assert.throws(() => loadMigrations(inp), (e) => e instanceof CoverageInputMissingError && e.message.includes('.audit-loop/migrations'));
  });
});

describe('the REAL sync ships the CLI + config and the relocated CLI runs', () => {
  let tmp; let consumer; let first; let nm;
  const run = (args) => spawnSync(process.execPath, [path.join(consumer, CLI_DEST), ...args], { cwd: consumer, encoding: 'utf8', windowsHide: true });

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-omc-')));
    consumer = path.join(tmp, 'consumer');
    fs.mkdirSync(consumer, { recursive: true });
    git(['init', '--initial-branch=main'], consumer);
    git(['config', 'user.email', 'test@example.invalid'], consumer);
    git(['config', 'user.name', 'Coverage Relocation Test'], consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'omc-fixture', type: 'module' }, null, 2));
    seedInstalledDeps(consumer);
    fs.writeFileSync(path.join(consumer, '.gitignore'), '');
    git(['add', '-A'], consumer);
    git(['commit', '-m', 'init', '--no-gpg-sign'], consumer);
    first = await runSyncCli(['--target-path', consumer, '--no-prompt']);
  });
  after(() => {
    // Detach a linked node_modules FIRST: a recursive remove must never follow it into the checkout's real one.
    try { if (nm) fs.unlinkSync(nm); } catch { /* not linked */ }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('syncs', () => assert.equal(first.code, 0, whySyncFailed(first)));

  it('lands the config and the CLI at their mapped destinations; the config content equals the source', () => {
    assert.ok(fs.existsSync(path.join(consumer, CLI_DEST)), `${CLI_DEST} missing`);
    const got = JSON.parse(fs.readFileSync(path.join(consumer, CFG_DEST), 'utf8'));
    const src = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.own-model-coverage.json'), 'utf8'));
    // `_description` is prose the sync's command rewriter localises (`node scripts/x.mjs` -> `scripts/.claude-skills/x.mjs`); the floors are data.
    const { _description: gd, ...gotData } = got;
    const { _description: sd, ...srcData } = src;
    assert.deepEqual(gotData, srcData);
    assert.ok(gd.includes('scripts/.claude-skills/own-model-coverage.mjs') && !sd.includes('.claude-skills'));
  });

  it('records both in the sync manifest', () => {
    const text = fs.readFileSync(path.join(consumer, 'scripts/.sync-manifest.json'), 'utf8');
    assert.ok(text.includes(CLI_DEST), 'CLI not in manifest');
    assert.ok(text.includes(CFG_DEST), 'config not in manifest');
  });

  it('a later sync REPLACES a locally edited config (upstream-exclusive), never merges it', async () => {
    const dest = path.join(consumer, CFG_DEST);
    const upstream = fs.readFileSync(dest, 'utf8');
    fs.writeFileSync(dest, JSON.stringify({ localEdit: 'x', entries: [] }));
    const second = await runSyncCli(['--target-path', consumer, '--no-prompt']);
    assert.equal(second.code, 0, whySyncFailed(second));
    const body = fs.readFileSync(dest, 'utf8');
    // Measured: the sync replaces it. The local key is gone, not merged into upstream's content.
    assert.equal(lf(body), lf(upstream));
    assert.ok(!body.includes('localEdit'));
    fs.writeFileSync(dest, upstream); // restore for the CLI tests below
  });

  it('relocated CLI: --selfcheck-relocation and `check --static` from the consumer root', () => {
    // The fixture's seeded deps are stubs; link the checkout's real node_modules so the CLI's static imports (pg, dotenv) resolve.
    const stub = path.join(consumer, 'node_modules');
    fs.rmSync(stub, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), stub, 'junction');
    nm = stub;
    const self = run(['--selfcheck-relocation']);
    assert.equal(self.status, 0, self.stderr);
    const r = run(['check', '--static']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).ok, true);
  });

  it('relocated `telemetry-export --report`: finds the mapped config, and with no store says so for every group', () => {
    const r = spawnSync(process.execPath, [path.join(consumer, 'scripts/.claude-skills/telemetry-export.mjs'), '--report'], {
      cwd: consumer, encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, AUDIT_DB_URL: '', TELEMETRY_DROP_DIR: '' },
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(r.stdout.trimEnd().split('\n').at(-1), 'Nothing was written or sent.');
    // `store-unconfigured`, not `config-missing`: the config WAS found at its mapped path (a miss would name it instead).
    assert.match(r.stdout, /Own-model coverage\n\s+unmeasured \(store-unconfigured\)/);
    assert.match(r.stdout, /Population: measured from 0 stores/);
  });

  it('config deleted: exit 1 naming the mapped path, no stack trace', () => {
    fs.unlinkSync(path.join(consumer, CFG_DEST));
    const r = run(['check', '--static']);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.ok(r.stderr.includes(CFG_DEST), r.stderr);
    assert.ok(!/\n\s+at /.test(r.stderr), `stack trace leaked: ${r.stderr}`);
  });
});
