/**
 * Hermetic unit tests for scripts/db-test-container.mjs — no Docker, no
 * network. Pure helpers + the injectable-exec lifecycle state machine
 * (docs/plans/local-db-test-container.md §7/§9).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DB_TEST_IMAGE,
  CONTAINER_NAME,
  DEFAULT_PORT,
  DB_SEAM_PREFIXES,
  DESTRUCTIVE_SUITE_FILES,
  ISOLATED_SUITE_FILES,
  CONTRACT_SUITE_FILES,
  buildDsn,
  buildStepEnv,
  parseArgs,
  classifyRunFailure,
  createLifecycle,
  _internals,
} from '../scripts/db-test-container.mjs';
import { assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'postgres-parity.yml');
const WORKFLOW_TEXT = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

// ── parseArgs ────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults to suites mode, DEFAULT_PORT, keep=false', () => {
    const opts = parseArgs([]);
    assert.equal(opts.mode, 'suites');
    assert.equal(opts.port, DEFAULT_PORT);
    assert.equal(opts.keep, false);
  });

  it('accepts each valid mode', () => {
    for (const m of ['suites', 'regen-schema', 'up', 'down']) {
      assert.equal(parseArgs([m]).mode, m);
    }
  });

  it('rejects an unknown mode', () => {
    assert.throws(() => parseArgs(['bogus']), /Unknown mode/);
  });

  it('parses --keep and --port', () => {
    const opts = parseArgs(['up', '--keep', '--port', '5555']);
    assert.equal(opts.mode, 'up');
    assert.equal(opts.keep, true);
    assert.equal(opts.port, 5555);
  });

  it('rejects a non-numeric or out-of-range --port', () => {
    assert.throws(() => parseArgs(['--port', 'nope']), /valid TCP port/);
    assert.throws(() => parseArgs(['--port', '99999']), /valid TCP port/);
  });

  it('rejects an unknown flag rather than silently ignoring it (audit M1)', () => {
    assert.throws(() => parseArgs(['--keeep']), /Unknown flag "--keeep"/);
    assert.throws(() => parseArgs(['up', '--dry-run']), /Unknown flag "--dry-run"/);
  });

  it('rejects a second positional argument rather than silently dropping it', () => {
    assert.throws(() => parseArgs(['up', 'down']), /Unexpected extra argument "down"/);
  });
});

// ── buildDsn ─────────────────────────────────────────────────────────────

describe('buildDsn', () => {
  it('binds 127.0.0.1 with the postgres/postgres/postgres dummy creds', () => {
    assert.equal(buildDsn(5433), 'postgresql://postgres:postgres@127.0.0.1:5433/postgres');
  });

  it('passes the real assertDisposableDbUrl (loopback, never Supabase)', () => {
    assert.doesNotThrow(() => assertDisposableDbUrl(buildDsn(DEFAULT_PORT), { productionUrl: 'postgresql://x@real.supabase.co:5432/postgres' }));
  });
});

// ── buildStepEnv ─────────────────────────────────────────────────────────

describe('buildStepEnv', () => {
  const dsn = buildDsn(5433);

  it('migrate/schema-diff/contract steps get AUDIT_DB_URL + SSL disable', () => {
    for (const step of ['migrate', 'schema-diff', 'contract']) {
      const env = buildStepEnv(step, dsn, {});
      assert.equal(env.AUDIT_DB_URL, dsn);
      assert.equal(env.AUDIT_DB_SSL_MODE, 'disable');
      assert.equal(env.AUDIT_DB_TEST_URL, undefined);
    }
  });

  it('destructive-suites and drift-justification get AUDIT_DB_TEST_URL and DELETE AUDIT_DB_URL, even from a polluted parent env', () => {
    const pollutedParent = { AUDIT_DB_URL: 'postgresql://real:prod@internal.example.com:5432/audit_loop', PATH: '/usr/bin' };
    for (const step of ['destructive-suites', 'drift-justification']) {
      const env = buildStepEnv(step, dsn, pollutedParent);
      assert.equal(env.AUDIT_DB_TEST_URL, dsn);
      assert.equal('AUDIT_DB_URL' in env, false, `${step} must not inherit AUDIT_DB_URL`);
      assert.equal(env.AUDIT_DB_SSL_MODE, 'disable');
      assert.equal(env.PATH, '/usr/bin', 'unrelated parent env vars must survive');
    }
  });
});

// ── classifyRunFailure ───────────────────────────────────────────────────

describe('classifyRunFailure', () => {
  it('classifies a name conflict as exit 3', () => {
    const r = classifyRunFailure('Error response from daemon: Conflict. The container name "/ces-db-test" is already in use by container "abc123"', 5433);
    assert.equal(r.exitCode, 3);
  });

  it('classifies a port/bind conflict as exit 2 with a --port hint, never masked as a name conflict', () => {
    const r = classifyRunFailure('Error: bind: address already in use', 5433);
    assert.equal(r.exitCode, 2);
    assert.match(r.message, /--port/);
  });

  it('classifies an unrecognised docker error as exit 2 with the real stderr surfaced', () => {
    const r = classifyRunFailure('Cannot connect to the Docker daemon at unix:///var/run/docker.sock', 5433);
    assert.equal(r.exitCode, 2);
    assert.match(r.message, /Cannot connect to the Docker daemon/);
  });
});

// ── CI-parity guard (mechanical, both directions) ───────────────────────

/**
 * Extracts one top-level GitHub Actions job's YAML text, bounded at the
 * START of the NEXT top-level (2-space-indented) job key — not merely from
 * the job's own declaration to end-of-file (audit round-2/round-3 finding:
 * that unbounded form only "worked" because db-suite happened to be the
 * last job; a job added afterward would silently leak into the match).
 * Exported test-locally (not from the CLI — this is a test-authoring
 * concern, not part of db-test-container.mjs's own contract).
 */
function extractJobBlock(yamlText, jobName) {
  const startMarker = `\n  ${jobName}:`;
  const start = yamlText.indexOf(startMarker);
  if (start < 0) return null;
  const afterKey = start + startMarker.length;
  const nextJob = yamlText.slice(afterKey).match(/\n {2}[A-Za-z0-9_-]+:/);
  const end = nextJob ? afterKey + nextJob.index : yamlText.length;
  return yamlText.slice(start, end);
}

describe('extractJobBlock (test-local helper)', () => {
  const FIXTURE = [
    'jobs:',
    '  unit:',
    '    steps:',
    '      - run: echo tests/db-query.test.mjs',
    '  db-suite:',
    '    steps:',
    '      - run: echo pgvector/pgvector:pg16',
    '  publish:',
    '    steps:',
    '      - run: echo tests/db-query.test.mjs   # must NOT leak into db-suite block',
    '',
  ].join('\n');

  it('bounds the block at the NEXT job, excluding content from a job declared after it', () => {
    const block = extractJobBlock(FIXTURE, 'db-suite');
    assert.match(block, /pgvector\/pgvector:pg16/);
    assert.doesNotMatch(block, /publish/);
    assert.doesNotMatch(block, /must NOT leak/);
  });

  it('falls back to end-of-string when the job is last (today\'s real shape)', () => {
    const lastJobOnly = FIXTURE.split('  publish:')[0];
    const block = extractJobBlock(lastJobOnly, 'db-suite');
    assert.match(block, /pgvector\/pgvector:pg16/);
  });
});

describe('CI parity with .github/workflows/postgres-parity.yml', () => {
  // Scoped to the `db-suite:` job only (audit M11/round-2/round-3) — the
  // `unit:` job intentionally runs unrelated pure-unit files (db-query,
  // sync-packaging, ...) and a job added after db-suite in the future must
  // not leak into this block either — see extractJobBlock above.
  const DB_SUITE_TEXT = extractJobBlock(WORKFLOW_TEXT, 'db-suite');
  assert.ok(DB_SUITE_TEXT, 'workflow must contain a db-suite: job');

  it('the db-suite job contains DB_TEST_IMAGE verbatim', () => {
    assert.ok(DB_SUITE_TEXT.includes(DB_TEST_IMAGE), `db-suite job must reference ${DB_TEST_IMAGE}`);
  });

  it('every exported suite-file list member appears in the db-suite job', () => {
    for (const f of [...DESTRUCTIVE_SUITE_FILES, ...ISOLATED_SUITE_FILES, ...CONTRACT_SUITE_FILES]) {
      assert.ok(DB_SUITE_TEXT.includes(f), `db-suite job must reference ${f}`);
    }
  });

  it('the db-suite job uses --test-concurrency=1 for the destructive step', () => {
    assert.ok(DB_SUITE_TEXT.includes('--test-concurrency=1'));
  });

  it('negative control — matching text in the unit: job alone does not satisfy the guard', () => {
    // tests/db-query.test.mjs is real content in the unit: job, outside
    // db-suite:. If the scoping above were broken (whole-file search again),
    // this would still incorrectly "pass" as evidence for db-suite membership.
    assert.ok(WORKFLOW_TEXT.includes('tests/db-query.test.mjs'), 'sanity: unit: job must reference this file');
    assert.ok(!DB_SUITE_TEXT.includes('tests/db-query.test.mjs'), 'db-suite: job must NOT reference a unit:-only file');
  });

  it('reverse direction — every tests/*.test.mjs referenced in the db-suite job is covered by one of the exported lists', () => {
    const known = new Set([...DESTRUCTIVE_SUITE_FILES, ...ISOLATED_SUITE_FILES, ...CONTRACT_SUITE_FILES]);
    const referenced = [...new Set([...DB_SUITE_TEXT.matchAll(/tests\/[\w./-]+\.test\.mjs/g)].map((m) => m[0]))];
    const unknown = referenced.filter((f) => !known.has(f));
    assert.deepEqual(unknown, [], `db-suite job references test files not covered by db-test-container.mjs's exported lists: ${unknown.join(', ')}`);
  });
});

// ── hook-seam parity ─────────────────────────────────────────────────────

describe('DB_SEAM_PREFIXES', () => {
  it('is a subset of the CI workflow paths: filter (single source of truth for the seam)', () => {
    for (const prefix of DB_SEAM_PREFIXES) {
      assert.ok(
        WORKFLOW_TEXT.includes(prefix) || WORKFLOW_TEXT.includes(prefix.replace(/\/$/, '/**')),
        `DB_SEAM_PREFIXES entry "${prefix}" should correspond to a workflow paths: filter entry`,
      );
    }
  });
});

// ── --selfcheck-relocation smoke ─────────────────────────────────────────

describe('--selfcheck-relocation', () => {
  it('prints OK and exits 0 without touching Docker', () => {
    const res = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'db-test-container.mjs'), '--selfcheck-relocation'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 10000,
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), 'OK');
  });
});

// ── Lifecycle state machine (injectable exec — fake, no real Docker) ────

/**
 * Dispatches by `docker <subcommand>` (args[0]) for cmd==='docker', or by
 * `cmd` itself for anything else (all `node <script>` workload steps share
 * one 'node' handler — the fake doesn't care which script, only whether it
 * should simulate success or failure).
 */
function createFakeExec(handlers) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = cmd === 'docker' ? args[0] : cmd;
    const handler = handlers[key] || handlers.default;
    if (!handler) throw new Error(`no fake handler for ${cmd} ${args.join(' ')}`);
    return handler(args, opts, calls.length);
  };
  exec.calls = calls;
  return exec;
}

const ok = (stdout = '') => async () => ({ code: 0, stdout, stderr: '', signal: null, timedOut: false });
const fail = (stderr = 'boom', code = 1) => async () => ({ code, stdout: '', stderr, signal: null, timedOut: false });

describe('_internals.createLifecycle stays the same seam as the top-level export (audit round-2 L1)', () => {
  it('is the identical function object', () => {
    assert.equal(_internals.createLifecycle, createLifecycle);
  });
});

describe('createLifecycle — injectable-exec state machine (regen-schema mode)', () => {
  it('stale (non-running) container is reconciled (removed) before start; happy path exits 0', async () => {
    const exec = createFakeExec({
      version: ok('25.0.0'),
      pull: ok(),
      inspect: ok('false\n'), // exists, not running -> stale
      rm: ok(),
      run: ok('deadbeef0001\n'),
      node: ok(),
    });
    const lifecycle = createLifecycle({ exec, waitForReady: async () => ({ ok: true }) });
    const code = await lifecycle.run('regen-schema', { port: 5433 });
    assert.equal(code, 0);
    const rmCalls = exec.calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'rm');
    assert.equal(rmCalls.length, 2, 'expected one stale-reconcile rm + one teardown rm');
  });

  it('a running container is a loud conflict (exit 3), never implicitly removed', async () => {
    const exec = createFakeExec({
      version: ok('25.0.0'),
      pull: ok(),
      inspect: ok('true\n'), // running
      rm: fail('should not be called'),
      run: fail('should not be called'),
    });
    const lifecycle = createLifecycle({ exec, waitForReady: async () => ({ ok: true }) });
    const code = await lifecycle.run('regen-schema', { port: 5433 });
    assert.equal(code, 3);
    assert.equal(exec.calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'rm').length, 0);
  });

  it('a lost create-race (docker run name conflict) exits 3 with cleanup as a no-op — never masks a port conflict as a race', async () => {
    const exec = createFakeExec({
      version: ok('25.0.0'),
      pull: ok(),
      inspect: fail('No such object', 1), // absent
      run: fail('Error response from daemon: Conflict. The container name "/ces-db-test" is already in use by container "abc123"'),
      rm: fail('should not be called'),
    });
    const lifecycle = createLifecycle({ exec, waitForReady: async () => ({ ok: true }) });
    const code = await lifecycle.run('regen-schema', { port: 5433 });
    assert.equal(code, 3);
    assert.equal(exec.calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'rm').length, 0, 'no container was ever owned — nothing to clean up');
  });

  it('a port/bind failure on docker run is exit 2, not exit 3', async () => {
    const exec = createFakeExec({
      version: ok('25.0.0'),
      pull: ok(),
      inspect: fail('No such object', 1),
      run: fail('Error: bind: address already in use'),
    });
    const lifecycle = createLifecycle({ exec, waitForReady: async () => ({ ok: true }) });
    const code = await lifecycle.run('regen-schema', { port: 5433 });
    assert.equal(code, 2);
  });

  it('workload succeeds but teardown fails -> exit 4 (never masks a green workload as fully clean)', async () => {
    let rmCallCount = 0;
    const exec = createFakeExec({
      version: ok('25.0.0'),
      pull: ok(),
      inspect: fail('No such object', 1),
      run: ok('deadbeef0002\n'),
      node: ok(),
      rm: async () => { rmCallCount += 1; return { code: 1, stdout: '', stderr: 'permission denied', signal: null, timedOut: false }; },
    });
    const lifecycle = createLifecycle({ exec, waitForReady: async () => ({ ok: true }) });
    const code = await lifecycle.run('regen-schema', { port: 5433 });
    assert.equal(code, 4);
    assert.equal(rmCallCount, 1);
  });

  it('workload fails and teardown also fails -> exit 1 wins (workload failure has precedence)', async () => {
    const exec = createFakeExec({
      version: ok('25.0.0'),
      pull: ok(),
      inspect: fail('No such object', 1),
      run: ok('deadbeef0003\n'),
      node: fail('migration failed', 1),
      rm: fail('also failed', 1),
    });
    const lifecycle = createLifecycle({ exec, waitForReady: async () => ({ ok: true }) });
    const code = await lifecycle.run('regen-schema', { port: 5433 });
    assert.equal(code, 1);
  });

  it('readiness timeout -> exit 2, and the started container is still torn down', async () => {
    let rmCalled = false;
    const exec = createFakeExec({
      version: ok('25.0.0'),
      pull: ok(),
      inspect: fail('No such object', 1),
      run: ok('deadbeef0004\n'),
      rm: async () => { rmCalled = true; return { code: 0, stdout: '', stderr: '', signal: null, timedOut: false }; },
    });
    const lifecycle = createLifecycle({ exec, waitForReady: async () => ({ ok: false, error: new Error('connect timeout') }) });
    const code = await lifecycle.run('regen-schema', { port: 5433 });
    assert.equal(code, 2);
    assert.equal(rmCalled, true);
  });

  it('teardown is idempotent — calling it again after run() already tore down issues no second rm', async () => {
    const exec = createFakeExec({
      version: ok('25.0.0'),
      pull: ok(),
      inspect: fail('No such object', 1),
      run: ok('deadbeef0005\n'),
      node: ok(),
      rm: ok(),
    });
    const lifecycle = createLifecycle({ exec, waitForReady: async () => ({ ok: true }) });
    const code = await lifecycle.run('regen-schema', { port: 5433 });
    assert.equal(code, 0);
    const rmCallsAfterRun = exec.calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'rm').length;

    const second = await lifecycle.teardown();
    assert.equal(second.skipped, true);
    const rmCallsAfterSecondTeardown = exec.calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'rm').length;
    assert.equal(rmCallsAfterSecondTeardown, rmCallsAfterRun, 'no additional rm call from the redundant teardown');
  });

  it('`down` mode is idempotent when the container is absent', async () => {
    const exec = createFakeExec({
      version: ok('25.0.0'),
      inspect: fail('No such object', 1),
    });
    const lifecycle = createLifecycle({ exec });
    const code = await lifecycle.run('down', {});
    assert.equal(code, 0);
  });

  it('`down` mode removes a running container by name', async () => {
    const exec = createFakeExec({
      version: ok('25.0.0'),
      inspect: ok('true\n'),
      rm: ok(),
    });
    const lifecycle = createLifecycle({ exec });
    const code = await lifecycle.run('down', {});
    assert.equal(code, 0);
    const rmCall = exec.calls.find((c) => c.cmd === 'docker' && c.args[0] === 'rm');
    assert.ok(rmCall.args.includes(CONTAINER_NAME), 'down removes by NAME, not by a captured id');
  });

  it('docker preflight failure exits 2 without attempting anything else', async () => {
    const exec = createFakeExec({ version: fail('Cannot connect to the Docker daemon', 1) });
    const lifecycle = createLifecycle({ exec });
    const code = await lifecycle.run('regen-schema', { port: 5433 });
    assert.equal(code, 2);
    assert.equal(exec.calls.length, 1);
  });
});
