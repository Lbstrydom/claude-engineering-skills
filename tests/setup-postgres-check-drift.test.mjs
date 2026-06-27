/**
 * @fileoverview Hermetic tests for setup-postgres.mjs --check-drift mode.
 *
 * No live DB. The stub pool implements `query(text)` against an in-memory
 * `audit_loop_migrations` table; the migrations dir is a fresh `mkdtemp`
 * populated per test.
 *
 * Plan: docs/plans/migration-drift-detector.md §8.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { _internals } from '../scripts/setup-postgres.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

const { runCheckDrift, parseArgs } = _internals;

// ── helpers ────────────────────────────────────────────────────────────────

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'check-drift-'));
}

function writeMigrations(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
}

/**
 * In-memory stub pg.Pool — pattern-matches the small set of queries
 * runCheckDrift issues. Tests configure `state` to drive each branch.
 *
 * @param {{ledgerExists: boolean, rows?: {filename:string,sha256:string}[]}} state
 */
function stubPool(state) {
  return {
    async query(text /* string */) {
      if (text.includes(`to_regclass('public.audit_loop_migrations')`)) {
        return { rows: [{ t: state.ledgerExists ? 'audit_loop_migrations' : null }] };
      }
      if (text.includes('SELECT filename, sha256 FROM audit_loop_migrations')) {
        return { rows: state.rows || [] };
      }
      throw new Error(`stubPool: unexpected query: ${text.slice(0, 80)}`);
    },
  };
}

function collectStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf-8'));
      cb();
    },
  });
  stream.text = () => chunks.join('');
  return stream;
}

// Compute sha256 of a string body — matches setup-postgres.mjs::sha256
// (file-based) by spawning the same crypto path.
async function sha256OfString(body) {
  const crypto = await import('node:crypto');
  return crypto.createHash('sha256').update(Buffer.from(body, 'utf-8')).digest('hex');
}

// ── test matrix ────────────────────────────────────────────────────────────

describe('runCheckDrift — clean', () => {
  it('returns exitCode 0 + hasDrift:false when ledger matches source', async () => {
    const dir = mkdtemp();
    try {
      writeMigrations(dir, {
        '20260101_a.sql': '-- a',
        '20260102_b.sql': '-- b',
      });
      const rows = [
        { filename: '20260101_a.sql', sha256: await sha256OfString('-- a') },
        { filename: '20260102_b.sql', sha256: await sha256OfString('-- b') },
      ];
      const pool = stubPool({ ledgerExists: true, rows });
      const stdout = collectStream();
      const stderr = collectStream();
      const r = await runCheckDrift(pool, { format: 'json', migrationsDir: dir, stdout, stderr });
      assert.equal(r.exitCode, 0);
      assert.equal(r.hasDrift, false);
      assert.equal(r.needsBootstrap, false);
      assert.equal(r.applied, 2);
      assert.equal(r.sourceTotal, 2);
      // JSON-only mode: stdout has JSON, stderr should be empty
      assert.match(stdout.text(), /"hasDrift": false/);
      assert.equal(stderr.text(), '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runCheckDrift — drift kinds', () => {
  it('reports unapplied when source > ledger', async () => {
    const dir = mkdtemp();
    try {
      writeMigrations(dir, {
        '20260101_a.sql': '-- a',
        '20260102_b.sql': '-- b',
      });
      const rows = [
        { filename: '20260101_a.sql', sha256: await sha256OfString('-- a') },
      ];
      const pool = stubPool({ ledgerExists: true, rows });
      const stdout = collectStream();
      const stderr = collectStream();
      const r = await runCheckDrift(pool, { format: 'json', migrationsDir: dir, stdout, stderr });
      assert.equal(r.exitCode, 1);
      assert.equal(r.hasDrift, true);
      assert.deepEqual(r.drift.unapplied, ['20260102_b.sql']);
      assert.deepEqual(r.drift.shaMismatch, []);
      assert.deepEqual(r.drift.orphanLedger, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports shaMismatch when ledger sha ≠ source sha', async () => {
    const dir = mkdtemp();
    try {
      writeMigrations(dir, { '20260101_a.sql': '-- a (edited)' });
      const rows = [
        { filename: '20260101_a.sql', sha256: 'sha-from-before-edit-' + 'a'.repeat(40) },
      ];
      const pool = stubPool({ ledgerExists: true, rows });
      const stdout = collectStream();
      const stderr = collectStream();
      const r = await runCheckDrift(pool, { format: 'json', migrationsDir: dir, stdout, stderr });
      assert.equal(r.exitCode, 1);
      assert.equal(r.drift.shaMismatch.length, 1);
      assert.equal(r.drift.shaMismatch[0].filename, '20260101_a.sql');
      assert.ok(r.drift.shaMismatch[0].ledgerSha.startsWith('sha-from'));
      assert.ok(r.drift.shaMismatch[0].sourceSha.length === 64);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports orphanLedger when ledger row has no source file', async () => {
    const dir = mkdtemp();
    try {
      writeMigrations(dir, { '20260101_a.sql': '-- a' });
      const rows = [
        { filename: '20260101_a.sql', sha256: await sha256OfString('-- a') },
        { filename: '20259999_deleted.sql', sha256: 'orphan-' + 'b'.repeat(58) },
      ];
      const pool = stubPool({ ledgerExists: true, rows });
      const stdout = collectStream();
      const stderr = collectStream();
      const r = await runCheckDrift(pool, { format: 'json', migrationsDir: dir, stdout, stderr });
      assert.equal(r.exitCode, 1);
      assert.deepEqual(r.drift.orphanLedger, ['20259999_deleted.sql']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports all three drift kinds together (mixed-drift)', async () => {
    const dir = mkdtemp();
    try {
      writeMigrations(dir, {
        '20260101_a.sql': '-- a (edited)',
        '20260102_b.sql': '-- b',                // unapplied
      });
      const rows = [
        { filename: '20260101_a.sql', sha256: 'stale-' + 'a'.repeat(58) },
        { filename: '20259999_gone.sql', sha256: 'orphan-' + 'b'.repeat(57) }, // orphan
      ];
      const pool = stubPool({ ledgerExists: true, rows });
      const stdout = collectStream();
      const stderr = collectStream();
      const r = await runCheckDrift(pool, { format: 'json', migrationsDir: dir, stdout, stderr });
      assert.equal(r.exitCode, 1);
      assert.equal(r.drift.unapplied.length, 1);
      assert.equal(r.drift.shaMismatch.length, 1);
      assert.equal(r.drift.orphanLedger.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('empty-ledger (table exists, 0 rows) reports every source file as unapplied', async () => {
    const dir = mkdtemp();
    try {
      writeMigrations(dir, {
        '20260101_a.sql': '-- a',
        '20260102_b.sql': '-- b',
        '20260103_c.sql': '-- c',
      });
      const pool = stubPool({ ledgerExists: true, rows: [] });
      const stdout = collectStream();
      const stderr = collectStream();
      const r = await runCheckDrift(pool, { format: 'json', migrationsDir: dir, stdout, stderr });
      assert.equal(r.exitCode, 1);
      assert.equal(r.drift.unapplied.length, 3);
      assert.equal(r.applied, 0);
      assert.equal(r.sourceTotal, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runCheckDrift — needs-bootstrap (exit 3)', () => {
  it('reports exit 3 with actionable message when ledger TABLE is missing', async () => {
    const dir = mkdtemp();
    try {
      writeMigrations(dir, { '20260101_a.sql': '-- a' });
      const pool = stubPool({ ledgerExists: false });
      const stdout = collectStream();
      const stderr = collectStream();
      const r = await runCheckDrift(pool, { format: 'json', migrationsDir: dir, stdout, stderr });
      assert.equal(r.exitCode, 3);
      assert.equal(r.needsBootstrap, true);
      assert.match(stdout.text(), /audit_loop_migrations table missing/);
      assert.match(stdout.text(), /--adopt/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('human-format exit-3 message goes to stderr, not stdout', async () => {
    const dir = mkdtemp();
    try {
      writeMigrations(dir, { '20260101_a.sql': '-- a' });
      const pool = stubPool({ ledgerExists: false });
      const stdout = collectStream();
      const stderr = collectStream();
      const r = await runCheckDrift(pool, { format: 'human', migrationsDir: dir, stdout, stderr });
      assert.equal(r.exitCode, 3);
      assert.equal(stdout.text(), '');
      assert.match(stderr.text(), /audit_loop_migrations table missing/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runCheckDrift — output channel discipline', () => {
  it('format=json writes ONLY to stdout (stderr stays clean)', async () => {
    const dir = mkdtemp();
    try {
      writeMigrations(dir, { '20260101_a.sql': '-- a' });
      const pool = stubPool({
        ledgerExists: true,
        rows: [{ filename: '20260101_a.sql', sha256: await sha256OfString('-- a') }],
      });
      const stdout = collectStream();
      const stderr = collectStream();
      await runCheckDrift(pool, { format: 'json', migrationsDir: dir, stdout, stderr });
      assert.ok(stdout.text().length > 0);
      assert.equal(stderr.text(), '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('format=human writes ONLY to stderr (stdout stays clean)', async () => {
    const dir = mkdtemp();
    try {
      writeMigrations(dir, { '20260101_a.sql': '-- a' });
      const pool = stubPool({
        ledgerExists: true,
        rows: [{ filename: '20260101_a.sql', sha256: await sha256OfString('-- a') }],
      });
      const stdout = collectStream();
      const stderr = collectStream();
      await runCheckDrift(pool, { format: 'human', migrationsDir: dir, stdout, stderr });
      assert.equal(stdout.text(), '');
      assert.match(stderr.text(), /Migration drift check/);
      assert.match(stderr.text(), /no drift/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('JSON output is valid parseable JSON with the expected shape', async () => {
    const dir = mkdtemp();
    try {
      writeMigrations(dir, { '20260101_a.sql': '-- a' });
      const pool = stubPool({ ledgerExists: true, rows: [] });
      const stdout = collectStream();
      const stderr = collectStream();
      await runCheckDrift(pool, { format: 'json', migrationsDir: dir, stdout, stderr });
      const parsed = JSON.parse(stdout.text().trim());
      assert.equal(parsed.hasDrift, true);
      assert.equal(parsed.exitCode, 1);
      assert.deepEqual(parsed.drift.unapplied, ['20260101_a.sql']);
      assert.equal(typeof parsed.applied, 'number');
      assert.equal(typeof parsed.sourceTotal, 'number');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── parseArgs — flag wiring ───────────────────────────────────────────────

describe('parseArgs — --check-drift + --format wiring', () => {
  it('recognises --check-drift as a mode', () => {
    const r = parseArgs(['--check-drift']);
    assert.equal(r.mode, 'check-drift');
    assert.equal(r.format, 'human');  // default
  });

  it('captures --format json correctly (indexed-loop refactor)', () => {
    const r = parseArgs(['--check-drift', '--format', 'json']);
    assert.equal(r.mode, 'check-drift');
    assert.equal(r.format, 'json');
  });

  it('captures --format human explicitly', () => {
    const r = parseArgs(['--check-drift', '--format', 'human']);
    assert.equal(r.format, 'human');
  });

  it('preserves existing --migrate flag behaviour', () => {
    const r = parseArgs(['--migrate']);
    assert.equal(r.mode, 'migrate');
  });

  it('preserves existing --adopt flag behaviour', () => {
    const r = parseArgs(['--adopt']);
    assert.equal(r.mode, 'adopt');
  });

  it('preserves --dry-run + --preflight-only + --bootstrap-only', () => {
    const r = parseArgs(['--migrate', '--dry-run']);
    assert.equal(r.mode, 'migrate');
    assert.equal(r.dryRun, true);
  });
});

// ── contract assertions (no source-text regex, just behaviour) ────────────
//
// R1-audit H4: previous draft asserted source-text patterns like
// `for \(let i = 0;` which break on cosmetic refactors. Replaced with
// behaviour-only checks that survive any internal refactor.

describe('production wiring — behavioural contracts', () => {
  it('parseArgs returns mode=check-drift and accepts --format json', () => {
    // Behavioural: what the function DOES, not how it's written.
    const r = parseArgs(['--check-drift', '--format', 'json']);
    assert.equal(r.mode, 'check-drift');
    assert.equal(r.format, 'json');
  });

  it('parseArgs rejects unknown --format value (covers Gemini-R2-H1 validation)', () => {
    // Subprocess so parseArgs's process.exit doesn't kill our test process.
    const r = spawnNode(['--check-drift', '--format', 'bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--format must be 'human' or 'json'/);
  });

  it('package.json defines all four db:* scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    for (const s of ['db:check-drift', 'db:check-drift:json', 'db:migrate', 'db:adopt']) {
      assert.ok(pkg.scripts[s], `missing npm script: ${s}`);
    }
  });

  it('check:integration chains --check-drift after arch:refresh', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    // Behavioural: both halves must be present, drift check must come after.
    const cmd = pkg.scripts['check:integration'];
    const refreshIdx = cmd.search(/arch:refresh|refresh\.mjs/);
    const driftIdx = cmd.search(/check-drift|setup-postgres\.mjs/);
    assert.ok(refreshIdx >= 0, 'check:integration must include arch:refresh');
    assert.ok(driftIdx >= 0, 'check:integration must include drift check');
    assert.ok(driftIdx > refreshIdx, 'drift check must run after arch:refresh');
  });

  it('migration-drift workflow exists with three triggers + label', () => {
    const wf = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/migration-drift.yml'), 'utf-8');
    // Behavioural — three triggers (schedule/push/workflow_dispatch) and
    // the sticky-issue label. The exact cron expression or YAML formatting
    // can change without breaking the contract.
    assert.match(wf, /^on:/m);
    assert.match(wf, /schedule:/);
    assert.match(wf, /push:/);
    assert.match(wf, /workflow_dispatch:/);
    assert.match(wf, /supabase\/migrations/);
    assert.match(wf, /migration-drift/);
    assert.match(wf, /--check-drift/);
  });

  it('the runbook documents the operator self-service snippet with the contract markers', () => {
    // Snippet moved from AGENTS.md to the Postgres operations runbook (AGENTS.md
    // kept lean); the contract assertions follow it there.
    const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'postgres-parity-runbook.md'), 'utf-8');
    // Behavioural assertions about the snippet's CONTRACT, not the exact
    // formatting. The hook-snippet-behaviour test verifies the snippet
    // actually works under bash; this is the lighter "is it present?" gate.
    assert.match(doc, /managed-by: migration-drift-detector/, 'snippet marker must be present so the bash test can extract it');
    assert.match(doc, /DRIFT_EXIT=0[\s\S]+?\|\| DRIFT_EXIT=\$\?/, 'set -e-safe capture pattern required');
    // The four exit-code branches are required for the case-statement contract.
    for (const branch of ['0)', '1)', '3)', '*)']) {
      assert.ok(doc.includes(`    ${branch}`) || doc.includes(`   ${branch}`),
        `expected case branch '${branch}' in the runbook snippet`);
    }
  });
});

// ── end-to-end subprocess test (covers main() dispatch, exit codes) ───────

describe('production wiring — subprocess end-to-end', () => {
  it('--check-drift with AUDIT_DB_URL unset → exit 0 with cloud:false JSON (cloud-disabled graceful no-op)', () => {
    const r = spawnNode(['--check-drift', '--format', 'json'], { stripDbUrl: true });
    assert.equal(r.status, 0, `expected exit 0 (cloud-disabled), got ${r.status}; stderr=${r.stderr.slice(0, 400)}`);
    // stdout is JSON.stringify(..., null, 2) — multi-line. Parse the whole thing.
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.cloud, false);
    assert.equal(parsed.skipped, true);
    assert.equal(parsed.reason, 'AUDIT_DB_URL unset');
  });

  it('--check-drift with AUDIT_DB_URL unset, human format → exit 0 with "skipped" stderr message', () => {
    const r = spawnNode(['--check-drift'], { stripDbUrl: true });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /skipped.*AUDIT_DB_URL/);
  });

  it('--check-drift with unknown --format value → exit 2', () => {
    const r = spawnNode(['--check-drift', '--format', 'xml'], { stripDbUrl: true });
    assert.equal(r.status, 2);
  });
});

// ── subprocess helper ─────────────────────────────────────────────────────

function spawnNode(args, { stripDbUrl = false } = {}) {
  const env = { ...process.env };
  if (stripDbUrl) {
    delete env.AUDIT_DB_URL;
    delete env.AUDIT_POSTGRES_URL;
    delete env.SUPABASE_AUDIT_URL;
    // resolveDbUrl() now loads the shared ~/.audit-loop.env layer in the child;
    // disable it so "AUDIT_DB_URL unset" genuinely reaches the cloud-off path.
    env.AUDIT_LOOP_DISABLE_SHARED = '1';
  }
  const r = spawnSync(process.execPath, ['scripts/setup-postgres.mjs', ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
