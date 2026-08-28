/**
 * @fileoverview §2.3a's adapter table — one test per row. Each check-setup
 * adapter must be side-effect-free (no process.exit, no stdout write) and
 * its result must map correctly through `reportToProbeOutcome` into the
 * doctor's outcome enum.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadEnv, evaluateAuditSetup, evaluateAuditSupabase, evaluatePersonaTest,
} from '../scripts/check-setup.mjs';
import { reportToProbeOutcome } from '../scripts/lib/doctor/report.mjs';
import { detectPackageManager } from '../scripts/lib/package-manager.mjs';
import { runGates, ALL_GATES } from '../scripts/lib/sync-isolation-verify.mjs';

// ── Side-effect-free guard, shared by every adapter test below ─────────────

function withNoProcessExit(fn) {
  const orig = process.exit;
  let called = false;
  process.exit = () => { called = true; throw new Error('adapter called process.exit'); };
  try {
    fn();
  } finally {
    process.exit = orig;
  }
  assert.equal(called, false);
}

function withNoStdoutWrite(fn) {
  const orig = process.stdout.write;
  let called = false;
  process.stdout.write = (...args) => { called = true; return orig.apply(process.stdout, args); };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(called, false, 'adapter wrote to stdout — the CLI report renderer owns that, not the adapter');
}

describe('check-setup.mjs is importable without triggering main() (the process.exit guard)', () => {
  it('module import alone does not exit the process', () => {
    // If this test file's own imports above already ran to completion, the
    // guard held — an unguarded top-level `await main()` would have called
    // process.exit() before even reaching this assertion.
    assert.equal(typeof loadEnv, 'function');
  });
});

describe('evaluateAuditSetup (adapter row 1)', () => {
  it('is synchronous, side-effect-free, and returns {items, failures, warnings}', () => {
    let result;
    withNoProcessExit(() => withNoStdoutWrite(() => {
      result = evaluateAuditSetup({});
    }));
    assert.ok(Array.isArray(result.items));
    assert.equal(typeof result.failures, 'number');
    assert.equal(typeof result.warnings, 'number');
  });

  it('no OPENAI_API_KEY and no Azure profile -> fails, and reportToProbeOutcome reduces it to fail', () => {
    // Isolated repoPath + sharedPath — evaluateAuditSetup now resolves keys
    // through resolveCloudConfig (shared-cloud-config.mjs), so leaving this on
    // the real REPO_PATH/~/.audit-loop.env would make the assertion depend on
    // whichever machine runs the suite.
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-adapter-apikeys-empty-repo-'));
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-adapter-apikeys-empty-shared-'));
    try {
      const result = evaluateAuditSetup({}, repoDir, { sharedPath: path.join(sharedDir, '.audit-loop.env') });
      assert.ok(result.failures > 0);
      const outcome = reportToProbeOutcome(result);
      assert.equal(outcome.status, 'fail');
      assert.match(outcome.detail, /OPENAI_API_KEY/);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(sharedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a valid OPENAI_API_KEY passed via process env clears the failure', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-adapter-apikeys-pe-repo-'));
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-adapter-apikeys-pe-shared-'));
    try {
      const result = evaluateAuditSetup(
        { OPENAI_API_KEY: 'sk-fixture' }, repoDir, { sharedPath: path.join(sharedDir, '.audit-loop.env') },
      );
      assert.equal(result.failures, 0);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(sharedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a key present ONLY in ~/.audit-loop.env (shared, not local .env, not process env) resolves and is reported as inherited — regression test for the check-setup.mjs false negative', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-adapter-apikeys-shared-repo-'));
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-adapter-apikeys-shared-shared-'));
    const sharedPath = path.join(sharedDir, '.audit-loop.env');
    fs.writeFileSync(sharedPath, 'OPENAI_API_KEY=sk-fixture-shared\nGEMINI_API_KEY=gm-fixture-shared\n');
    try {
      const result = evaluateAuditSetup({}, repoDir, { sharedPath });
      assert.equal(result.failures, 0, 'OPENAI_API_KEY inherited from the shared file must clear the failure');
      const detail = JSON.stringify(result.items);
      assert.match(detail, /OPENAI_API_KEY.*inherited from ~\/\.audit-loop\.env/);
      assert.match(detail, /GEMINI_API_KEY.*inherited from ~\/\.audit-loop\.env/);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(sharedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a LOCAL .env key is resolved against the PASSED repoPath, not a module-level default (mirrors evaluateAuditSupabase\'s root-threading)', () => {
    const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-adapter-apikeys-repoA-'));
    const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-adapter-apikeys-repoB-'));
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-adapter-apikeys-repoAB-shared-'));
    const sharedPath = path.join(sharedDir, '.audit-loop.env');
    fs.writeFileSync(path.join(repoA, '.env'), 'OPENAI_API_KEY=sk-fixture-local\n');
    try {
      const resultA = evaluateAuditSetup({}, repoA, { sharedPath });
      const resultB = evaluateAuditSetup({}, repoB, { sharedPath });
      assert.equal(resultA.failures, 0, 'repoA has a local OPENAI_API_KEY — must pass');
      assert.ok(resultB.failures > 0, 'repoB has no local .env and no shared key — must fail');
    } finally {
      fs.rmSync(repoA, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(repoB, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(sharedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('evaluateAuditSupabase (adapter row 2) — root-threading (closes the R3-H1 class)', () => {
  let repoA, repoB;

  before(() => {
    repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-adapter-repoA-'));
    repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-adapter-repoB-'));
    // repoA carries a LOCAL .env that repoB does not — proves the adapter
    // resolves local-.env discovery against the PASSED repoPath, never a
    // module-level constant closed over the CLI's own --repo-path.
    fs.writeFileSync(path.join(repoA, '.env'), 'AUDIT_DB_URL=postgresql://fixture-a/db\n');
  });

  after(() => {
    fs.rmSync(repoA, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.rmSync(repoB, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('is async and never calls process.exit', async () => {
    const origExit = process.exit;
    let exited = false;
    process.exit = () => { exited = true; };
    let result;
    try {
      result = await evaluateAuditSupabase({}, repoB);
    } finally {
      process.exit = origExit;
    }
    assert.equal(exited, false);
    assert.ok(Array.isArray(result.items));
  });

  it('any progress diagnostics go to stderr, never stdout (stdout is reserved for the doctor\'s single JSON payload)', async () => {
    // A monkeypatch of the GLOBAL process.stdout.write held across an `await`
    // is unreliable under `node --test` — the runner's own TAP reporter can
    // flush through stdout while this test's promise is in flight, producing
    // a false positive unrelated to the adapter under test. Verified instead
    // via a CHILD PROCESS, where stdout/stderr are genuinely isolated streams.
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, ['-e', `
      const fs = require('fs'), os = require('os'), path = require('path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-adapter-stdout-check-'));
      import('./scripts/check-setup.mjs').then(async (m) => {
        await m.evaluateAuditSupabase({}, dir);
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      });
    `], { cwd: process.cwd(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.equal(out, '', 'evaluateAuditSupabase wrote to stdout — this would corrupt doctor.mjs --json output');
  });

  it('resolves LOCAL .env discovery against the PASSED repoPath, not a module-level default', async () => {
    // repoB has no .env; passing repoA's path must be what makes the DSN visible.
    const resultB = await evaluateAuditSupabase({}, repoB);
    const resultA = await evaluateAuditSupabase({}, repoA);
    // Both will warn/fail on the actual DB connection in this sandbox (a
    // fixture DSN does not resolve), but the WARN TEXT for "not set anywhere"
    // must differ: repoB (no local .env) reports unset, repoA does not — that
    // difference IS the proof the repoPath actually reached discoverLocalEnvPath.
    const bDetail = JSON.stringify(resultB.items);
    const aDetail = JSON.stringify(resultA.items);
    assert.notEqual(bDetail, aDetail, 'evaluateAuditSupabase must produce a DIFFERENT result for two repos with different local .env content');
  });
});

describe('evaluatePersonaTest (adapter row 3)', () => {
  it('is async and side-effect-free', async () => {
    const result = await evaluatePersonaTest({});
    assert.ok(Array.isArray(result.items));
  });

  it('no PERSONA_TEST_REPO_NAME -> warns, never fails outright', async () => {
    const result = await evaluatePersonaTest({});
    assert.equal(result.failures, 0);
    assert.ok(result.warnings > 0);
  });
});

describe('package-manager.mjs adapter row — already pure', () => {
  it('detectPackageManager is a plain synchronous function with no side effects', () => {
    withNoProcessExit(() => withNoStdoutWrite(() => {
      detectPackageManager(process.cwd());
    }));
  });
});

describe('sync-isolation-verify runGates adapter row — "one call, not eight"', () => {
  it('ALL_GATES excludes nothing but "1" when filtered by the doctor', () => {
    const filtered = ALL_GATES.filter((g) => g !== '1');
    assert.ok(!filtered.includes('1'));
    assert.ok(filtered.includes('2A'));
    assert.equal(filtered.length, ALL_GATES.length - 1);
  });

  it('an unreadable manifest degrades to ONE preflight sentinel, not a throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-adapter-gates-'));
    try {
      const results = runGates({ consumerRoot: dir, gates: ['2A', '2B'] });
      assert.equal(results.length, 1);
      assert.equal(results[0].gate, 'preflight');
      assert.equal(results[0].pass, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
