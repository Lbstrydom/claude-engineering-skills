/**
 * @fileoverview Tests for `scripts/event-wiring-scan.mjs`'s CLI-level logic
 * (Phase-0 GO/NO-GO oracle comparison + flag/relocation-check ordering) —
 * previously untested (no test file existed for this script at all).
 *
 * The module runs `main()` unconditionally at import time UNLESS imported
 * by something other than the running script (`isMain` guard, added here,
 * mirrors `scripts/audit-clean.mjs`'s precedent) — that guard is what makes
 * `_internals` safely importable from a test process.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _internals } from '../scripts/event-wiring-scan.mjs';

const { compareOracle } = _internals;

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'event-wiring-scan.mjs');

// ---------------------------------------------------------------------------
// compareOracle — the Phase-0 oracle must check the STATED classification,
// not mere membership in `coverage` (audit finding ee68cf6d). `resolveSymmetry`
// (event-wiring.mjs) never actually pushes a non-dispatch-only entry to
// `coverage` today, so this drives compareOracle DIRECTLY with a synthetic
// coverage array — the only way to observe the guard the fix added, since
// the real pipeline can't currently produce the shape it defends against.
// ---------------------------------------------------------------------------
describe('compareOracle — checks the explicit dispatch-only classification (ee68cf6d)', () => {
  it('rejects an expected event present in coverage under a DIFFERENT class, not just by name', () => {
    const expected = { version: 1, events: [{ name: 'cart:updated', class: 'dispatch-only', disposition: 'REAL-BUG' }] };
    // A coverage entry that merely SHARES the event name but isn't classified
    // dispatch-only — unreachable via today's resolveSymmetry, but exactly
    // the shape a future edit to that function could introduce; this pins
    // the guard so such a regression is caught at THIS seam, not silently
    // waved through by a bare membership check.
    const coverage = [{ eventName: 'cart:updated', class: 'listen-only', totalDispatchSites: 1, pragmaSuppressedSites: 0 }];
    const mismatch = compareOracle(expected, coverage, []);
    assert.match(mismatch, /no dispatch-only entry/);
  });

  it('accepts an expected event correctly classified dispatch-only in coverage', () => {
    const expected = { version: 1, events: [{ name: 'cart:updated', class: 'dispatch-only', disposition: 'REAL-BUG' }] };
    const coverage = [{ eventName: 'cart:updated', class: 'dispatch-only', totalDispatchSites: 1, pragmaSuppressedSites: 0 }];
    const findings = [{ eventName: 'cart:updated' }];
    const mismatch = compareOracle(expected, coverage, findings);
    assert.equal(mismatch, null);
  });
});

// ---------------------------------------------------------------------------
// Flag validation vs --selfcheck-relocation ordering (audit finding 05db1476).
// Current, INTENTIONAL design (audit-code R2/M3,M6,M8, matching cross-skill.mjs's
// own precedent): assertKnownFlags runs first, so the bare, canonical
// `--selfcheck-relocation` invocation (no other flags) still short-circuits to
// exit 0/'OK' — but an invocation carrying an ALSO-unknown flag is rejected
// as an invocation error (exit 2) before the relocation branch runs. Pinned
// both ways so a future edit can't silently flip either half.
// ---------------------------------------------------------------------------
describe('event-wiring-scan --selfcheck-relocation (subprocess, 05db1476)', () => {
  it('the canonical bare invocation exits 0 and prints OK', () => {
    const r = spawnSync(process.execPath, [CLI, '--selfcheck-relocation'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'OK');
  });

  it('an unknown flag alongside --selfcheck-relocation is an invocation error (exit 2), not silently accepted', () => {
    const r = spawnSync(process.execPath, [CLI, '--selfcheck-relocation', '--totally-bogus-flag'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 2, `expected exit 2 (invocation error); got ${r.status}, stdout: ${r.stdout}, stderr: ${r.stderr}`);
    assert.match(r.stderr, /unknown flag/);
  });
});
