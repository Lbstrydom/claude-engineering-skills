/**
 * @fileoverview Executable `--selfcheck-relocation` smoke test (plan D2).
 *
 * Companion to `tests/relocation-guard.test.mjs`. That test proves the literal
 * `--selfcheck-relocation` string is *present* in every CLI_SMOKE_SET script.
 * This one proves the handler actually *works*: each script is spawned with the
 * flag and must exit 0 printing `OK` — catching a broken top-level import (or
 * the flag living only in a comment) that the grep-level test cannot see. This
 * is the silent-break-ships-to-consumer failure mode the contract exists for.
 *
 * Hermetic subprocess contract: the proof is "the handler short-circuits BEFORE
 * any credentialed/network/DB path." A blacklist env is insufficient (dotenv
 * loads .env from cwd; config.mjs autoloads ~/.audit-loop.env), so we build an
 * ALLOWLIST env from scratch + run in an .env-free mkdtemp cwd. If the script
 * can reach a secret, the test setup is wrong, not the assertion.
 *
 * Plan: docs/plans/testing-doctrine-and-egress-relocation-gaps.md (D2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _internals as verifyInternals } from '../scripts/lib/sync-isolation-verify.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

/** A regressed script that genuinely hangs fails fast and names itself, rather
 *  than stalling CI indefinitely. Concrete constant, not "e.g. 30s". */
const SELFCHECK_TIMEOUT_MS = 30_000;

/** Build a hermetic env from scratch: only what Node needs to start, plus the
 *  real shared-config bypass flag. NO provider keys / DB url / shared config. */
function hermeticEnv() {
  const env = { AUDIT_LOOP_DISABLE_SHARED: '1', CI: '1', NO_COLOR: '1' };
  for (const k of ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[k] != null) env[k] = process.env[k];
  }
  return env;
}

/** stderr markers that betray a config / shared-config / DB path was reached
 *  before the handler short-circuited — the whole point is to prove it wasn't. */
const LEAK_MARKERS = ['[config]', 'loaded shared', 'AUDIT_DB', 'Cloud store', 'postgres'];

/**
 * Run `node <scriptAbsPath> --selfcheck-relocation` in a hermetic env + an
 * .env-free temp cwd. Asserts exit 0, stdout trimmed === 'OK', AND that stderr
 * shows no config/credential-path diagnostics (proving the early short-circuit,
 * not just a clean exit). Synchronous (spawnSync) → callers use assert.throws.
 * @param {string} scriptAbsPath
 */
function assertSelfcheckOk(scriptAbsPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-'));
  try {
    const r = spawnSync(
      process.execPath,
      [scriptAbsPath, '--selfcheck-relocation'],
      { env: hermeticEnv(), cwd: tmpDir, timeout: SELFCHECK_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const name = path.basename(scriptAbsPath);
    if (r.error) throw new Error(`${name} --selfcheck-relocation failed to run: ${r.error.message}`);
    assert.equal(r.status, 0, `${name} --selfcheck-relocation should exit 0, got ${r.status}; stderr: ${(r.stderr || '').slice(0, 200)}`);
    assert.equal(
      (r.stdout || '').trim(),
      'OK',
      `${name} --selfcheck-relocation should print "OK", got: ${JSON.stringify((r.stdout || '').slice(0, 200))}`,
    );
    const stderr = r.stderr || '';
    const leaked = LEAK_MARKERS.find((m) => stderr.includes(m));
    assert.equal(leaked, undefined, `${name} reached a config/credential path before short-circuit (stderr marker: ${leaked}): ${stderr.slice(0, 200)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('every CLI_SMOKE_SET script runs --selfcheck-relocation → exit 0, prints OK (hermetic)', () => {
  // Non-vacuity guard: a narrowed/empty set must NOT let this test pass silently.
  assert.ok(
    Array.isArray(verifyInternals.CLI_SMOKE_SET) && verifyInternals.CLI_SMOKE_SET.length > 0,
    'CLI_SMOKE_SET must be a non-empty array — an empty set would make this smoke test vacuous',
  );
  for (const rel of verifyInternals.CLI_SMOKE_SET) {
    const absPath = path.join(SCRIPTS_DIR, rel);
    // Diagnostic pre-checks (resolved from import.meta.url, never process.cwd()).
    // Containment is against scripts/ specifically (not just repo root) — a
    // value like '../foo.mjs' would still be inside the repo but outside scripts/.
    const within = path.relative(SCRIPTS_DIR, absPath);
    assert.ok(
      !within.startsWith('..') && !path.isAbsolute(within),
      `CLI_SMOKE_SET entry escapes scripts/: ${rel}`,
    );
    assert.ok(fs.existsSync(absPath), `CLI_SMOKE_SET entry missing on disk: scripts/${rel}`);
    assertSelfcheckOk(absPath);
  }
});

test('negative control: assertSelfcheckOk rejects a missing/broken handler (deterministic, no hang)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-neg-'));
  try {
    // (a) arg-ignoring script that exits 0 but prints the wrong thing.
    const wrongOut = path.join(tmpDir, 'wrong-output.mjs');
    fs.writeFileSync(wrongOut, "console.log('NOT_OK'); process.exit(0);\n");
    assert.throws(
      () => assertSelfcheckOk(wrongOut),
      /should print "OK"/,
      'must reject a script that exits 0 but does not print OK',
    );

    // (b) script that exits non-zero (execFileSync throws on non-zero exit).
    const nonZero = path.join(tmpDir, 'non-zero.mjs');
    fs.writeFileSync(nonZero, "process.exit(1);\n");
    assert.throws(
      () => assertSelfcheckOk(nonZero),
      'must reject a script that exits non-zero',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
