/**
 * @fileoverview The auth-liveness truth table must give the perceivability
 * predicate's `null` (UNKNOWN) its own arm (final-review shadow finding 6f2c0c96).
 *
 * `PERCEIVABLE_SOURCE` is tri-state, and its contract says a caller must treat
 * `null` as unknown and SURFACE it. `/nav-audit --verify` discarded a null match
 * (correct — an unknown cannot certify a live session) but then had nowhere to
 * record that it had done so: with every sentinel match unknown, `sentinelSeen`
 * stayed false and the run reported `dead` — "your token expired" — on the
 * strength of a predicate that never produced an answer.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideAuthLiveness } from '../scripts/lib/nav/verify.mjs';

const SENTINEL = { selector: '#account-menu' };
const base = { storageState: 'state.json', authSentinel: SENTINEL, sentinelSeen: false, sentinelError: null, sentinelUnknown: 0 };

describe('decideAuthLiveness', () => {
  it('an unknown-only sentinel is UNVERIFIED, never dead', () => {
    const r = decideAuthLiveness({ ...base, sentinelUnknown: 2 });
    assert.equal(r.authLiveness, 'unverified');
    assert.match(r.warning, /could not establish/);
  });

  it('a positive match still wins over unknown ones', () => {
    assert.equal(decideAuthLiveness({ ...base, sentinelSeen: true, sentinelUnknown: 3 }).authLiveness, 'live');
  });

  it('no match and no unknown is dead (negative control: the real signal survives)', () => {
    const r = decideAuthLiveness(base);
    assert.equal(r.authLiveness, 'dead');
    assert.equal(r.warning, null);
  });

  it('the pre-existing arms are unchanged', () => {
    assert.equal(decideAuthLiveness({ ...base, storageState: null }).authLiveness, 'n/a');
    assert.equal(decideAuthLiveness({ ...base, authSentinel: null }).authLiveness, 'unverified');
    const e = decideAuthLiveness({ ...base, sentinelError: 'bad selector' });
    assert.equal(e.authLiveness, 'unverified');
    assert.match(e.warning, /bad selector/);
  });
});
