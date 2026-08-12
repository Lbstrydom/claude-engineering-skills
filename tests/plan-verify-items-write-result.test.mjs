/**
 * @fileoverview `record-plan-verify-items` must report what was PERSISTED.
 *
 * Guards the audit finding "Unverified write success": the handler awaited
 * `recordPlanVerificationItems()`, discarded its return value, and always emitted
 * `{ok: true, cloud: true, inserted: p.items.length}`. Every failure path inside
 * that store function logs to stderr and swallows — so a write that inserted
 * NOTHING was reported to the caller as a complete success, with a row count
 * derived from the request rather than from the database.
 *
 * The store function returned `undefined` on every path, success and failure
 * alike, so the caller had nothing to check even if it had tried. It now returns
 * `{ok, inserted, reason}` and `inserted` is the row count Postgres accepted.
 *
 * Hermetic, and it takes three things to actually BE hermetic here — deleting
 * `AUDIT_DB_URL` alone is not enough, and the first draft of this file silently
 * ran the negative control against the real production store:
 *   - `DOTENV_CONFIG_PATH` must be scrubbed. Importing anything under
 *     `scripts/lib/` runs `load-shared-env`, which searches up from cwd for a
 *     `.env` and writes the hit back into THIS process's env; the child then
 *     inherits it and loads the repo's real DSN from a temp cwd.
 *   - `AUDIT_LOOP_DISABLE_SHARED=1` blocks the `~/.audit-loop.env` layer.
 *   - HOME/USERPROFILE are redirected as defence in depth.
 * The failure case then points `AUDIT_DB_URL` at a closed local port —
 * ECONNREFUSED is immediate (~0.4s) and needs no server.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordPlanVerificationItems } from '../scripts/lib/store/plans-ship.mjs';

const CLI = fileURLToPath(new URL('../scripts/cross-skill.mjs', import.meta.url));

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvi-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const ITEMS = [{
  criterionHash: 'abc', criterionIndex: 0, severity: 'HIGH',
  category: 'contract', description: 'a criterion', passed: true,
}];

function recordItems({ dbUrl }) {
  const dir = fs.mkdtempSync(path.join(tmp, 'case-'));
  const env = {
    ...process.env,
    HOME: dir, USERPROFILE: dir,
    AUDIT_DB_SSL_MODE: 'disable',
    AUDIT_LOOP_DISABLE_SHARED: '1',
  };
  delete env.DOTENV_CONFIG_PATH; // see the header — this is the leak that matters
  if (dbUrl) env.AUDIT_DB_URL = dbUrl; else delete env.AUDIT_DB_URL;

  const r = spawnSync(process.execPath, [
    CLI, 'record-plan-verify-items', '--json', JSON.stringify({
      runId: '11111111-1111-4111-8111-111111111111',
      planId: '22222222-2222-4222-8222-222222222222',
      items: ITEMS,
    }),
  ], { encoding: 'utf8', env, cwd: dir, timeout: 60_000 });

  const line = r.stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
  assert.ok(line, `no JSON envelope on stdout (status ${r.status})\n${r.stdout}\n${r.stderr}`);
  return { ...JSON.parse(line), _status: r.status };
}

describe('record-plan-verify-items — reports persistence, not intent', () => {
  // The regression. Before the fix this emitted {ok:true, cloud:true, inserted:1}
  // for a database that refused the connection outright.
  it('an unreachable store is a failure, not a successful write of items.length', () => {
    const out = recordItems({ dbUrl: 'postgresql://u:p@127.0.0.1:1/postgres' });
    assert.equal(out.ok, false, 'a write that never reached the database cannot report ok');
    // WRITE_FAILED → REPO_RESOLVE_FAILED (D7 / Phase 8), and the change is an
    // improvement rather than a relabelling. The handler now resolves scope
    // BEFORE writing, to thread a repoId into the parent-ownership join — so an
    // unreachable store is caught one step earlier, by the first thing that
    // touches it. That the resolver REFUSES here is the point: treating a failed
    // lookup as "unresolved" would hand the writer a null repoId, which legally
    // RELAXES the tenant predicate — i.e. ownership checking would quietly
    // weaken exactly when the store is unhealthy. Both codes mean "the store is
    // unreachable" and both exit non-zero; this one says which step found out.
    assert.ok(['WRITE_FAILED', 'REPO_RESOLVE_FAILED'].includes(out.error?.code),
      `expected a store-unreachable refusal, got ${out.error?.code}`);
    // 2 → 1 (§2b F2, 2026-08-12). The assertion this test cares about is
    // NON-ZERO — "a caller reading only the exit code must still see the
    // failure" — and 2 was simply CommandError's default, not a decision. The
    // cluster gave the two codes distinct meanings across every converted
    // handler: 2 is "you asked wrong" (argv/contract), 1 is "we tried and it
    // did not work". An unreachable store is squarely the second, and leaving
    // it on 2 would put a DB outage in the same bucket as a malformed payload —
    // the exact conflation this whole conversion removes.
    assert.equal(out._status, 1, 'a caller reading only the exit code must still see the failure');
    assert.notEqual(out._status, 0, 'and it must never be zero');
    assert.ok(
      !JSON.stringify(out).includes('"inserted":1'),
      'the request size must never be reported as an insert count',
    );
  });

  // Vacuous-pass guard: the handler must still be able to return the OTHER
  // answer, or the assertion above passes for any unconditionally-failing build.
  it('still succeeds on the cloud-off no-op path (negative control)', () => {
    const out = recordItems({ dbUrl: null });
    assert.equal(out.ok, true);
    assert.equal(out.cloud, false);
    assert.equal(out.inserted, 0, 'cloud-off persists nothing and must say so');
    assert.equal(out._status, 0);
  });
});

describe('recordPlanVerificationItems — structured result contract', () => {
  // It returned `undefined` on every path, so no caller could distinguish
  // success from a swallowed failure however carefully it checked.
  it('returns a discriminating result rather than undefined', async () => {
    const res = await recordPlanVerificationItems(null, null, []);
    assert.ok(res && typeof res === 'object', 'callers need something to check');
    assert.equal(res.ok, false);
    assert.equal(res.inserted, 0);
    assert.equal(res.reason, 'bad-input');
  });

  it('names the reason for each refusal, so a caller can tell them apart', async () => {
    const missingItems = await recordPlanVerificationItems('run', 'plan', []);
    assert.equal(missingItems.reason, 'bad-input');
    const notAnArray = await recordPlanVerificationItems('run', 'plan', null);
    assert.equal(notAnArray.reason, 'bad-input');
  });
});
