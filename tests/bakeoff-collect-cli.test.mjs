/**
 * @fileoverview End-to-end CLI smoke test for bakeoff-collect.mjs's
 * argument-ordering — regression guard for a real bug found live 2026-08-20:
 * `confirmMismatch` was referenced inside the §7 Phase 4 relatedness-check
 * block (added early in `main()`) but declared with `const` several lines
 * BELOW that block, so every invocation threw `ReferenceError: Cannot access
 * 'confirmMismatch' before initialization` before ever reaching the intended
 * ArgvError — caught only by running the real CLI against a live campaign,
 * not by any of the pure-function unit tests, since none of them exercise
 * `main()` itself.
 *
 * Deliberately uses the mismatched fixture (zero file overlap, no
 * `--confirm-mismatch`) so the CLI throws its OWN ArgvError before ever
 * touching the store or a provider — no DB, no network, no spend.
 *
 * @module tests/bakeoff-collect-cli
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'bakeoff-relatedness');

describe('bakeoff-collect.mjs CLI — a mismatched pair fails with the ArgvError, not a ReferenceError', () => {
  it('exits 2 with the relatedness-mismatch message, never "Cannot access \'confirmMismatch\'"', () => {
    const res = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'bakeoff-collect.mjs'),
      '--transcript', path.join(FIXTURES, 'mismatched-transcript.json'),
      '--plan', path.join(FIXTURES, 'second-reviewer-plan.md'),
      '--mode', 'plan',
    ], { encoding: 'utf-8', env: { ...process.env, AUDIT_DB_URL: '' } });

    assert.doesNotMatch(
      res.stderr, /Cannot access 'confirmMismatch'/,
      'regression: confirmMismatch used before its own declaration (TDZ)',
    );
    assert.equal(res.status, 2, `expected exit 2 (ArgvError); got ${res.status}. stderr:\n${res.stderr}`);
    assert.match(res.stderr, /do not look related/);
  });
});
