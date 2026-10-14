import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  peakConcurrency, measurePeakSessions, measureLeaseSharing, fleetEvidence, LEASE_EVENT_FRESH_MS, SESSION_WINDOW_DAYS,
} from '../scripts/lib/fleet/operating-evidence.mjs';
import { LEASE_SCHEMA_VERSION, repoKeyOf } from '../scripts/lib/fleet/lease.mjs';
import { gitCommonDir } from '../scripts/lib/suite-run-record.mjs';

const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-evidence-'))); made.push(d); return d; };
const NOW = new Date('2026-10-14T12:00:00.000Z');
const iso = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();
const HOUR = 3_600_000;

describe('peakConcurrency', () => {
  const s = (state, createdMsAgo, updatedMsAgo) => ({ state, createdAt: iso(createdMsAgo), updatedAt: iso(updatedMsAgo) });
  it('counts overlap, and touching intervals do not overlap', () => {
    assert.equal(peakConcurrency([s('done', 5 * HOUR, 4 * HOUR), s('done', 4 * HOUR, 3 * HOUR)], NOW), 1);
    assert.equal(peakConcurrency([s('done', 5 * HOUR, 2 * HOUR), s('done', 4 * HOUR, 1 * HOUR), s('done', 3 * HOUR, 1.5 * HOUR)], NOW), 3);
  });
  it('a live session extends to now; a done one ends at updatedAt', () => {
    assert.equal(peakConcurrency([s('working', 2 * HOUR, 2 * HOUR), s('done', 3 * HOUR, 1 * HOUR)], NOW), 2);
    assert.equal(peakConcurrency([s('done', 4 * HOUR, 3 * HOUR), s('done', 2 * HOUR, 1 * HOUR)], NOW), 1);
  });
  it('a session wholly before the window is ignored; malformed dates are skipped', () => {
    assert.equal(peakConcurrency([s('done', 20 * 86_400_000, 19 * 86_400_000)], NOW), 0);
    assert.equal(peakConcurrency([{ state: 'working', createdAt: 'x', updatedAt: 'y' }], NOW), 0);
  });
});

describe('measurePeakSessions', () => {
  it('no sessions -> unmeasured; records -> an approximate peak, partial when some were unreadable', () => {
    const none = measurePeakSessions({ root: '/r', now: NOW }, { readSessions: () => ({ sessions: [], invalid: [], complete: true }) });
    assert.equal(none.measured, false);
    assert.match(none.why, /no fleet sessions/);
    const unreadable = measurePeakSessions({ root: '/r', now: NOW }, { readSessions: () => ({ sessions: [], invalid: [{ file: 'x', reason: 'y' }], complete: false }) });
    assert.match(unreadable.why, /unreadable \(1 invalid/);
    const r = measurePeakSessions({ root: '/r', now: NOW }, {
      readSessions: () => ({
        sessions: [{ state: 'working', createdAt: iso(HOUR), updatedAt: iso(HOUR) }, { state: 'working', createdAt: iso(2 * HOUR), updatedAt: iso(HOUR) }],
        invalid: [{ file: 'x', reason: 'y' }], complete: false,
      }),
    });
    assert.equal(r.value.peak, 2);
    assert.equal(r.value.approximate, true);
    assert.equal(r.value.partial, true);
    assert.equal(r.value.windowDays, SESSION_WINDOW_DAYS);
  });
  it('outside a git repo it is unmeasured, not a throw', () => {
    const r = measurePeakSessions({ root: tmp(), now: NOW });
    assert.equal(r.measured, false);
  });
});

describe('measureLeaseSharing: positive evidence only', () => {
  const root = tmp(); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const commonDir = gitCommonDir(root);
  const ownKey = repoKeyOf(commonDir);
  const exec = () => { throw new Error('no remote'); };
  const lease = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    heavy: { holder: 'h', repoKey: 'a'.repeat(12), repo: 'other/heavy', kind: 'gate', scope: 's', token: 'b'.repeat(16), startedAt: iso(HOUR), expiresAt: iso(-HOUR) },
    windows: [
      { id: 'w-20261014100000-abcd', repoKey: ownKey, repo: 'own/repo', kind: 'ci', from: iso(HOUR), until: iso(-HOUR) },
      { id: 'w-20261014100001-abce', repoKey: 'c'.repeat(12), repo: 'other/window', kind: 'ci', from: iso(HOUR), until: iso(-HOUR) },
    ],
    peakHours: [],
    events: [
      { at: iso(2 * HOUR), kind: 'forced-release', by: 'main@other/event', reason: 'r' },
      { at: iso(LEASE_EVENT_FRESH_MS + HOUR), kind: 'forced-release', by: 'main@other/old', reason: 'r' },
    ],
  };
  const run = (deps) => measureLeaseSharing({ root, commonDir, exec, now: NOW }, { machineDir: () => '/m', ...deps });

  it('names other repos from the heavy slot, windows and FRESH events; excludes this repo and stale events', () => {
    const r = run({ readLease: () => ({ state: 'ok', lease }) });
    assert.deepEqual(r.value.otherRepos, ['other/event', 'other/heavy', 'other/window']);
  });
  it('an event just inside 24 h counts and one just outside does not', () => {
    const at = (msAgo) => ({ ...lease, heavy: null, windows: [], events: [{ at: iso(msAgo), kind: 'forced-release', by: 'main@x/y', reason: 'r' }] });
    assert.deepEqual(run({ readLease: () => ({ state: 'ok', lease: at(LEASE_EVENT_FRESH_MS - 1000) }) }).value.otherRepos, ['x/y']);
    assert.deepEqual(run({ readLease: () => ({ state: 'ok', lease: at(LEASE_EVENT_FRESH_MS + 1000) }) }).value.otherRepos, []);
  });
  it('an empty lease is a MEASURED empty list (sharing unobserved), not an unmeasured one', () => {
    const r = run({ readLease: () => ({ state: 'ok', lease: { ...lease, heavy: null, windows: [], events: [] } }) });
    assert.equal(r.measured, true);
    assert.deepEqual(r.value.otherRepos, []);
  });
  it('IDENTITY: with no resolvable common dir the lease cannot be split, so it is unmeasured, never "everyone else"', () => {
    const r = measureLeaseSharing({ root, commonDir: null, exec, now: NOW }, { machineDir: () => '/m', readLease: () => ({ state: 'ok', lease }) });
    assert.equal(r.measured, false);
    assert.match(r.why, /identity could not be resolved/);
    const bad = measureLeaseSharing({ root, commonDir: path.join(root, 'does-not-exist'), exec, now: NOW }, { machineDir: () => '/m', readLease: () => ({ state: 'ok', lease }) });
    assert.equal(bad.measured, false);
  });
  it('absent / unreadable / newer-version leases are unmeasured with their reason', () => {
    assert.match(run({ readLease: () => ({ state: 'absent' }) }).why, /no lease file in \/m/);
    assert.match(run({ readLease: () => ({ state: 'unreadable', reason: 'malformed JSON' }) }).why, /unreadable \(malformed JSON\)/);
    assert.match(run({ readLease: () => ({ state: 'newer-version', reason: 'schemaVersion 9' }) }).why, /newer-version/);
  });
  it('an unresolvable lease directory is unmeasured', () => {
    const r = measureLeaseSharing({ root, commonDir, exec, now: NOW }, { machineDir: () => { throw new Error('FLEET_MACHINE_DIR must be absolute'); } });
    assert.match(r.why, /lease directory unresolved/);
  });
  it('the provider doctor hands to shared-lib exposes exactly the two inputs', () => {
    assert.deepEqual(Object.keys(fleetEvidence).sort(), ['leaseSharing', 'peakSessions']);
    assert.equal(Object.isFrozen(fleetEvidence), true);
  });
});
