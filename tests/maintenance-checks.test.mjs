/**
 * @fileoverview Unit tests for scripts/maintenance-checks.mjs — the local
 * replica of the 5 weekly GH Actions maintenance workflows.
 *
 * Tier 1 (deterministic seam) per AGENTS.md's testing doctrine: env-gating
 * and overdue-heartbeat logic have crisp inputs/outputs, so this is
 * test-first, not eval-style. Subprocess-spawning behaviour (runCheck's
 * happy path) is exercised indirectly by the CLI smoke test
 * (tests/relocation-selfcheck-smoke.test.mjs) and by hand against the real
 * store — this suite covers the pure logic: which checks get skipped, when
 * a run is due, and the round-1 audit fixes (per-step capture, newly-
 * eligible-check forcing, lock acquisition).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  CHECKS,
  missingEnv,
  positiveIntEnv,
  isOverdue,
  hasNewlyEligibleCheck,
  writeHeartbeat,
  loadHeartbeat,
  runCheck,
  runExclusive,
} from '../scripts/maintenance-checks.mjs';

describe('maintenance-checks — CHECKS manifest', () => {
  it('declares all 6 replicated workflows', () => {
    const keys = CHECKS.map((c) => c.key).sort();
    assert.deepEqual(keys, [
      'arch-maintenance',
      'cache-hitrate',
      'learning-weekly-review',
      'memory-health',
      'migration-drift',
      'model-freshness',
    ].sort());
  });

  it('every check declares a non-empty steps array + requiredEnv array', () => {
    for (const c of CHECKS) {
      assert.equal(typeof c.key, 'string');
      assert.ok(Array.isArray(c.steps) && c.steps.length > 0);
      for (const step of c.steps) {
        assert.equal(typeof step.script, 'string');
        assert.ok(Array.isArray(step.args));
      }
      assert.ok(Array.isArray(c.requiredEnv));
    }
  });

  it('arch-maintenance bundles refresh + drift + prune as one check (not three)', () => {
    const c = CHECKS.find((c) => c.key === 'arch-maintenance');
    assert.equal(c.steps.length, 3);
    assert.deepEqual(c.steps.map((s) => s.script), [
      'symbol-index/refresh.mjs',
      'symbol-index/drift.mjs',
      'symbol-index/prune.mjs',
    ]);
  });

  it('every step script resolves to a real sibling file (round-1 audit M6 — the relocation smoke flag alone never exercises CHECKS resolution)', () => {
    const scriptsDir = path.resolve(import.meta.dirname, '..', 'scripts');
    for (const c of CHECKS) {
      for (const step of c.steps) {
        const resolved = path.join(scriptsDir, step.script);
        assert.ok(fs.existsSync(resolved), `${c.key}: ${step.script} does not exist at ${resolved} — a renamed/moved sibling script would silently break this check`);
      }
    }
  });

  it('learning-weekly-review requires LEARNING_REPO_NAME (cross-tenant leakage guard)', () => {
    const c = CHECKS.find((c) => c.key === 'learning-weekly-review');
    assert.ok(c.requiredEnv.includes('LEARNING_REPO_NAME'));
    assert.ok(c.requiredEnv.includes('AUDIT_DB_URL'));
  });

  it('model-freshness has no required env — public provider catalogs, INSUFFICIENT_DATA is its own signal', () => {
    const c = CHECKS.find((c) => c.key === 'model-freshness');
    assert.deepEqual(c.requiredEnv, []);
  });
});

describe('maintenance-checks — missingEnv', () => {
  it('returns empty array when all required env vars are present', () => {
    const prior = process.env.MAINT_TEST_VAR;
    process.env.MAINT_TEST_VAR = 'x';
    try {
      assert.deepEqual(missingEnv(['MAINT_TEST_VAR']), []);
    } finally {
      if (prior === undefined) delete process.env.MAINT_TEST_VAR; else process.env.MAINT_TEST_VAR = prior;
    }
  });

  it('returns the missing var names, never throws', () => {
    delete process.env.MAINT_TEST_ABSENT_VAR;
    assert.deepEqual(missingEnv(['MAINT_TEST_ABSENT_VAR']), ['MAINT_TEST_ABSENT_VAR']);
  });

  it('an empty requiredEnv list is never "missing" anything', () => {
    assert.deepEqual(missingEnv([]), []);
  });
});

describe('maintenance-checks — positiveIntEnv (round-1 audit M2)', () => {
  const VAR = 'MAINT_TEST_INTERVAL';
  afterEach(() => { delete process.env[VAR]; });

  it('falls back to default when unset', () => {
    delete process.env[VAR];
    assert.equal(positiveIntEnv(VAR, 7), 7);
  });

  it('accepts a valid positive integer', () => {
    process.env[VAR] = '3';
    assert.equal(positiveIntEnv(VAR, 7), 3);
  });

  it('rejects Infinity (would make a heartbeat never overdue)', () => {
    process.env[VAR] = 'Infinity';
    assert.equal(positiveIntEnv(VAR, 7), 7);
  });

  it('rejects negative values (would make every push overdue)', () => {
    process.env[VAR] = '-5';
    assert.equal(positiveIntEnv(VAR, 7), 7);
  });

  it('rejects fractional values', () => {
    process.env[VAR] = '2.5';
    assert.equal(positiveIntEnv(VAR, 7), 7);
  });

  it('rejects zero', () => {
    process.env[VAR] = '0';
    assert.equal(positiveIntEnv(VAR, 7), 7);
  });

  it('rejects non-numeric garbage', () => {
    process.env[VAR] = 'abc';
    assert.equal(positiveIntEnv(VAR, 7), 7);
  });
});

describe('maintenance-checks — runCheck skips cleanly on missing env', () => {
  it('never spawns a subprocess when required env is absent', () => {
    delete process.env.MAINT_TEST_ABSENT_VAR_2;
    const result = runCheck({
      key: 'fake', label: 'Fake check', requiredEnv: ['MAINT_TEST_ABSENT_VAR_2'],
      steps: [{ script: 'this-file-does-not-exist.mjs', args: [] }],
    });
    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /MAINT_TEST_ABSENT_VAR_2/);
  });

  it('one check skipping never throws or affects sibling checks (the whole-run isolation contract)', () => {
    delete process.env.MAINT_TEST_ABSENT_VAR_3;
    assert.doesNotThrow(() => {
      const results = [
        runCheck({ key: 'a', label: 'A', requiredEnv: ['MAINT_TEST_ABSENT_VAR_3'], steps: [{ script: 'x.mjs', args: [] }] }),
        runCheck({ key: 'b', label: 'B', requiredEnv: [], steps: [{ script: 'lib/does-not-exist-either.mjs', args: [] }] }),
      ];
      assert.equal(results[0].status, 'skipped');
      // Missing script file → `node <path>` launches fine (node.exe exists)
      // but exits non-zero with MODULE_NOT_FOUND on stderr — round-1 audit
      // M3: this must surface in `output`, not be silently swallowed as an
      // empty 'attention' (the old `stdout || stderr` dropped stderr
      // whenever stdout was non-empty; here stdout is empty so the old code
      // happened to work, but the fix is about the general case).
      assert.equal(results[1].status, 'attention');
      assert.match(results[1].output, /Cannot find module|MODULE_NOT_FOUND/);
    });
  });

  it('a check with a failing first step still runs its later steps (per-step independence, like the workflow)', () => {
    const result = runCheck({
      key: 'multi', label: 'Multi', requiredEnv: [],
      steps: [
        { script: 'does-not-exist-1.mjs', args: [] },
        { script: 'does-not-exist-2.mjs', args: [] },
      ],
    });
    assert.equal(result.status, 'attention');
    assert.match(result.output, /\[does-not-exist-1\.mjs\]/);
    assert.match(result.output, /\[does-not-exist-2\.mjs\]/);
  });
});

describe('maintenance-checks — isOverdue', () => {
  it('a null heartbeat (never run) is always overdue', () => {
    assert.equal(isOverdue(null, 7), true);
  });

  it('a heartbeat with a missing/garbage lastRunAt is overdue', () => {
    assert.equal(isOverdue({ lastRunAt: 'not-a-date' }, 7), true);
    assert.equal(isOverdue({}, 7), true);
  });

  it('a fresh heartbeat (1 hour ago) is not overdue at a 7-day interval', () => {
    const lastRunAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    assert.equal(isOverdue({ lastRunAt }, 7), false);
  });

  it('a heartbeat older than the interval is overdue', () => {
    const lastRunAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isOverdue({ lastRunAt }, 7), true);
  });

  it('a heartbeat exactly at the interval boundary is not yet overdue (strictly-greater-than semantics)', () => {
    const lastRunAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isOverdue({ lastRunAt }, 7), false);
  });
});

describe('maintenance-checks — hasNewlyEligibleCheck (round-1 audit M1/M5/H2)', () => {
  it('false for a null heartbeat (isOverdue already covers "never run")', () => {
    assert.equal(hasNewlyEligibleCheck(null), false);
  });

  it('false when every previously-skipped check is still missing its env', () => {
    const prior = process.env.AUDIT_DB_URL;
    delete process.env.AUDIT_DB_URL;
    try {
      const heartbeat = { results: [{ key: 'migration-drift', status: 'skipped' }] };
      assert.equal(hasNewlyEligibleCheck(heartbeat), false);
    } finally {
      if (prior !== undefined) process.env.AUDIT_DB_URL = prior;
    }
  });

  it('true when a previously-skipped check now has all required env present', () => {
    const prior = process.env.AUDIT_DB_URL;
    process.env.AUDIT_DB_URL = 'postgres://mock';
    try {
      const heartbeat = { results: [{ key: 'migration-drift', status: 'skipped' }] };
      assert.equal(hasNewlyEligibleCheck(heartbeat), true);
    } finally {
      if (prior === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = prior;
    }
  });

  it('false when the prior run for that check was ok/attention, not skipped (no early retry on failure)', () => {
    const prior = process.env.AUDIT_DB_URL;
    process.env.AUDIT_DB_URL = 'postgres://mock';
    try {
      const heartbeat = { results: [{ key: 'migration-drift', status: 'attention' }] };
      assert.equal(hasNewlyEligibleCheck(heartbeat), false);
    } finally {
      if (prior === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = prior;
    }
  });
});

describe('maintenance-checks — heartbeat read/write round-trip', () => {
  let tmpDir, heartbeatPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-heartbeat-'));
    heartbeatPath = path.join(tmpDir, 'last-maintenance.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('loadHeartbeat returns null when the file does not exist', () => {
    assert.equal(loadHeartbeat(heartbeatPath), null);
  });

  it('writeHeartbeat then loadHeartbeat round-trips mode + per-check status', () => {
    const results = [
      { key: 'arch-maintenance', status: 'ok', exitCode: 0 },
      { key: 'learning-weekly-review', status: 'skipped', reason: 'missing env: LEARNING_REPO_NAME' },
    ];
    writeHeartbeat(results, 'opportunistic', heartbeatPath);
    const loaded = loadHeartbeat(heartbeatPath);
    assert.equal(loaded.mode, 'opportunistic');
    assert.equal(typeof loaded.lastRunAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(loaded.lastRunAt)));
    assert.deepEqual(loaded.results.map((r) => r.key), ['arch-maintenance', 'learning-weekly-review']);
    assert.equal(loaded.results[0].status, 'ok');
    assert.equal(loaded.results[1].status, 'skipped');
  });

  it('a corrupt heartbeat file is treated as "never run" rather than throwing', () => {
    fs.writeFileSync(heartbeatPath, '{not valid json');
    assert.equal(loadHeartbeat(heartbeatPath), null);
  });

  it('a shape-valid-but-incomplete heartbeat (round-1 audit L1) is treated as "never run", not thrown on', () => {
    fs.writeFileSync(heartbeatPath, JSON.stringify({ lastRunAt: new Date().toISOString() })); // missing `results`
    assert.equal(loadHeartbeat(heartbeatPath), null);
  });

  it('a future lastRunAt (round-1 audit L1) is rejected, not trusted indefinitely', () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(heartbeatPath, JSON.stringify({ lastRunAt: future, results: [] }));
    assert.equal(loadHeartbeat(heartbeatPath), null);
  });
});

describe('maintenance-checks — runExclusive (round-2 audit M3/M4: reuses lib/brainstorm/file-lock.mjs)', () => {
  let tmpDir, lockPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-lock-'));
    lockPath = path.join(tmpDir, '.maintenance.lock');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('runs fn and returns its result when the lock is free', async () => {
    const result = await runExclusive(lockPath, () => 'done');
    assert.equal(result, 'done');
    // withFileLock releases on completion — lock must not be left behind.
    assert.equal(fs.existsSync(lockPath), false);
  });

  it('returns null (silent no-op) instead of waiting when another instance already holds the lock', async () => {
    // Simulate a live holder — this test's own process.pid is definitionally alive.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'other-instance', acquiredAt: new Date().toISOString() }), { flag: 'wx' });
    let fnCalled = false;
    const result = await runExclusive(lockPath, () => { fnCalled = true; return 'should not run'; });
    assert.equal(result, null);
    assert.equal(fnCalled, false, 'fn must not run when another instance holds the lock');
  });

  it('propagates a genuine error from fn (not swallowed as a lock timeout)', async () => {
    await assert.rejects(
      () => runExclusive(lockPath, () => { throw new Error('boom'); }),
      /boom/,
    );
  });
});

describe('maintenance-checks — CLI: manual mode on lock contention (round-3 audit H1)', () => {
  // The lock now covers BOTH execution modes (round-3 audit H1: it
  // previously covered only --opportunistic, so an attended manual run
  // could overlap a backgrounded push-triggered one). This exercises the
  // real CLI against the real repo's own lock path — the only place
  // main()'s manual-vs-opportunistic messaging branch is observable —
  // pre-seeding and cleaning up the lock file within the test.
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const lockPath = path.join(repoRoot, '.audit-loop', '.maintenance.lock');
  const scriptPath = path.join(repoRoot, 'scripts', 'maintenance-checks.mjs');

  afterEach(() => {
    try { fs.unlinkSync(lockPath); } catch { /* not present */ }
  });

  it('prints a loud message and exits cleanly instead of running checks, when the lock is held', () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'held-by-test', acquiredAt: new Date().toISOString() }), { flag: 'wx' });

    const r = spawnSync(process.execPath, [scriptPath], { encoding: 'utf-8', timeout: 15_000 });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /already in progress/);
    // Must NOT have run any real checks — the heartbeat's mtime should be
    // untouched (or absent), not freshly written by this invocation.
    assert.doesNotMatch(r.stdout, /Local maintenance checks/);
  });
});
