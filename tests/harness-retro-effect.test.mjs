/**
 * Harness retro — the effect metric, every verdict branch (plan §2 Telemetry).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeEffect, coveredAccounts } from '../scripts/lib/friction/retro/effect.mjs';

const DAY = 86_400_000;
const T = Date.parse('2026-10-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const FP = 'aaaaaaaaaaaaaaaa';
const decision = { identity: `fingerprint:${FP}`, evidenceFingerprints: [FP], fingerprintVersion: 1 };
const active = { status: 'active', at: iso(T), provenance: 'github-merge-commit' };
const fullScan = { accountKey: 'acct', repoUuid: 'r', since: iso(T - 20 * DAY), until: iso(T + 20 * DAY), completed: true };

function sessions({ before = 12, after = 12, hitsB = 6, hitsA = 1, version = 1 } = {}) {
  const out = [];
  for (let i = 0; i < before; i++) out.push({ sessionKey: `b${i}`, repoUuid: 'r', accountKey: 'acct', fingerprintVersion: 1, startedAt: iso(T - (i + 1) * DAY / 2), counts: i < hitsB ? { [FP]: 1 } : {} });
  for (let i = 0; i < after; i++) out.push({ sessionKey: `a${i}`, repoUuid: 'r', accountKey: 'acct', fingerprintVersion: version, startedAt: iso(T + (i + 1) * DAY / 2), counts: i < hitsA ? { [FP]: 1 } : {} });
  return out;
}
const run = (over = {}) => computeEffect({ decision, activation: active, repoUuid: 'r', sessions: sessions(), scans: [fullScan], now: T + 30 * DAY, source: 'test', ...over });

describe('coveredAccounts', () => {
  it('unions adjacent completed ranges of one account', () => {
    const scans = [
      { accountKey: 'a', repoUuid: 'r', since: iso(T - 20 * DAY), until: iso(T), completed: true },
      { accountKey: 'a', repoUuid: 'r', since: iso(T - DAY), until: iso(T + 20 * DAY), completed: true },
    ];
    assert.deepEqual([...coveredAccounts(scans, 'r', T - 14 * DAY, T + 14 * DAY)], ['a']);
  });
  it('a gap, an incomplete scan, or another repo is not coverage', () => {
    const gap = [
      { accountKey: 'a', repoUuid: 'r', since: iso(T - 20 * DAY), until: iso(T - DAY), completed: true },
      { accountKey: 'a', repoUuid: 'r', since: iso(T), until: iso(T + 20 * DAY), completed: true },
    ];
    assert.equal(coveredAccounts(gap, 'r', T - 14 * DAY, T + 14 * DAY).size, 0);
    assert.equal(coveredAccounts([{ ...fullScan, completed: false }], 'r', T - 14 * DAY, T + 14 * DAY).size, 0);
    assert.equal(coveredAccounts([{ ...fullScan, repoUuid: 'other' }], 'r', T - 14 * DAY, T + 14 * DAY).size, 0);
  });
});

describe('computeEffect', () => {
  it('reduced', () => {
    const r = run();
    assert.equal(r.verdict, 'reduced');
    assert.deepEqual(r.counts, { accounts: 1, before: 12, after: 12, hitsBefore: 6, hitsAfter: 1 });
    assert.equal(r.activation.provenance, 'github-merge-commit');
  });
  it('unchanged', () => { assert.equal(run({ sessions: sessions({ hitsA: 5 }) }).verdict, 'unchanged'); });
  it('regressed', () => { assert.equal(run({ sessions: sessions({ hitsB: 3, hitsA: 8 }) }).verdict, 'regressed'); });
  it('too few hits before is never "reduced"', () => { assert.equal(run({ sessions: sessions({ hitsB: 2, hitsA: 0 }) }).verdict, 'unchanged'); });
  it('pending-merge', () => { assert.equal(run({ activation: { status: 'pending-merge' } }).verdict, 'pending-merge'); });
  it('activation unknown is unmeasured with the reason', () => {
    const r = run({ activation: { status: 'unknown', reason: 'activation-unknown: no landing-time source' } });
    assert.equal(r.verdict, 'unmeasured'); assert.match(r.reason, /landing-time/);
  });
  it('pending until the after-window has elapsed', () => { assert.equal(run({ now: T + 5 * DAY }).verdict, 'pending'); });
  it('no covered account → unmeasured', () => { assert.equal(run({ scans: [{ ...fullScan, completed: false }] }).verdict, 'unmeasured'); });
  it('a short window → unmeasured naming it', () => {
    const r = run({ sessions: sessions({ before: 4 }) });
    assert.equal(r.verdict, 'unmeasured'); assert.match(r.reason, /^before-window/);
  });
  it('a fingerprint-version change inside the windows → unmeasured', () => {
    assert.match(run({ sessions: sessions({ version: 2 }) }).reason, /fingerprint-version-changed/);
  });
  it('sessions of an uncovered account are excluded from the population', () => {
    const extra = sessions().map((s) => ({ ...s, sessionKey: `x${s.sessionKey}`, accountKey: 'other', counts: { [FP]: 9 } }));
    assert.equal(run({ sessions: [...sessions(), ...extra] }).counts.before, 12);
  });
  it('a tripwire identity counts a session hit when ANY evidence fingerprint occurs', () => {
    const FP2 = 'bbbbbbbbbbbbbbbb';
    const ss = sessions({ hitsB: 0, hitsA: 0 }).map((s, i) => (s.sessionKey.startsWith('b') && i < 6 ? { ...s, counts: { [FP2]: 1 } } : s));
    const r = run({ decision: { identity: 'tripwire:m', evidenceFingerprints: [FP, FP2], fingerprintVersion: 1 }, sessions: ss });
    assert.equal(r.counts.hitsBefore, 6);
    assert.equal(r.verdict, 'reduced');
  });
});
