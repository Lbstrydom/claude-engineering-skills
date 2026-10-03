/**
 * Cluster B/debt-2 — --verify pure logic (reconcile + live-target normalization).
 * The browser drive (runVerify) is exercised live; these lock the deterministic
 * reconciliation that decides confirmed / static-only / runtime-only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, normalizeLiveTarget, sentinelProbeInPage, resolveAuthLiveness } from '../scripts/lib/nav/verify.mjs';
import { PERCEIVABLE_SOURCE, PERCEIVABLE_FN_NAME } from '../scripts/lib/browser/perceivable.mjs';
import { composeCaptureVerdict, buildDraftCaptureWarning } from '../scripts/lib/nav/bootstrap-draft.mjs';

describe('normalizeLiveTarget', () => {
  it('maps query-param view routing to the view slug (vanilla SPA)', () => {
    assert.equal(normalizeLiveTarget('?view=today', 'https://app.test/'), 'today');
    assert.equal(normalizeLiveTarget('https://app.test/?view=drink-soon', 'https://app.test/'), 'drink-soon');
  });
  it('normalizes path routing', () => {
    assert.equal(normalizeLiveTarget('/wines/123', 'https://app.test/'), '/wines/:param');
  });
  it('drops external + non-nav targets', () => {
    assert.equal(normalizeLiveTarget('mailto:x@y.z'), null);
    assert.equal(normalizeLiveTarget('#section', 'https://app.test/'), null);
  });
});

describe('reconcile', () => {
  it('partitions confirmed / static-only / runtime-only', () => {
    const r = reconcile(['today', 'wines', 'drink-soon'], ['today', 'wines', 'admin-secret']);
    assert.deepEqual(r.confirmed, ['today', 'wines']);
    assert.deepEqual(r.staticOnly, ['drink-soon']);
    assert.deepEqual(r.runtimeOnly, ['admin-secret']);
  });
  it('excludes <dynamic> and modal: pseudo-destinations from the static set', () => {
    const r = reconcile(['<dynamic>', 'modal:settings', 'wines'], ['wines']);
    assert.deepEqual(r.confirmed, ['wines']);
    assert.deepEqual(r.staticOnly, []);
  });
});

/**
 * v1.5 capture honesty — the verify path used to compute `emptyNavShells` and
 * throw it away, so an expired token produced output byte-identical to a healthy
 * run. These lock the composition that replaced that silence.
 */
describe('composeCaptureVerdict — capture honesty (v1.5)', () => {
  it('an ordinary unauthenticated run does NOT degrade', () => {
    // The regression that matters most: an early design degraded whenever
    // `status !== "live"`, which would have suppressed findings on every
    // normal no-auth run and made the feature worse than useless.
    const v = composeCaptureVerdict({ authLiveness: 'n/a', hasStorageState: false });
    assert.equal(v.degrade, false);
    assert.equal(v.status, 'no-auth-state');
    assert.ok(v.warnings.length, 'it should still say so — advisory, not silent');
  });

  it('a dead session degrades and names the token, not the app', () => {
    const v = composeCaptureVerdict({ authLiveness: 'dead', hasStorageState: true });
    assert.equal(v.status, 'auth-dead');
    assert.equal(v.degrade, true);
    assert.match(v.warnings[0], /AUTH SESSION DEAD/);
  });

  it('storage-state with no declared sentinel is unverified, not live', () => {
    const v = composeCaptureVerdict({ authLiveness: 'unverified', hasStorageState: true });
    assert.equal(v.status, 'auth-unverified');
    assert.equal(v.degrade, true);
  });

  it('a live session with empty shells reports the shells but does not degrade', () => {
    const v = composeCaptureVerdict({ authLiveness: 'live', emptyNavShells: ['#nav'], hasStorageState: true });
    assert.equal(v.status, 'live-empty-shells');
    assert.equal(v.degrade, false);
  });

  it('a dead session SUBSUMES the empty-shell warning (one primary cause)', () => {
    // A dead session explains the empty shells; presenting both as co-equal
    // causes sends the operator chasing the wrong one.
    const v = composeCaptureVerdict({ authLiveness: 'dead', emptyNavShells: ['#nav', '#sub'], hasStorageState: true });
    assert.equal(v.status, 'auth-dead');
    assert.match(v.warnings[0], /AUTH SESSION DEAD/);
    assert.ok(v.warnings.some((w) => /#nav/.test(w)), 'shells survive as DETAIL, not as a second primary cause');
  });

  it('a fully live capture is clean and silent', () => {
    const v = composeCaptureVerdict({ authLiveness: 'live', hasStorageState: true });
    assert.deepEqual(v, { status: 'live', degrade: false, warnings: [] });
  });

  it('THROWS on the impossible n/a + storage-state pair', () => {
    // The domain invariant: `n/a` means "no auth attempted". If a caller ever
    // leaves liveness at its initial value on the authed path, that must be
    // loud — silently composing `live` would emit authoritative findings from
    // a capture that was never verified, which is the whole defect.
    assert.throws(
      () => composeCaptureVerdict({ authLiveness: 'n/a', hasStorageState: true }),
      /impossible with --storage-state/,
    );
  });
});

describe('buildDraftCaptureWarning — mode selects the REMEDY only', () => {
  it('verify mode never tells the operator to re-bootstrap their contract', () => {
    const w = buildDraftCaptureWarning({ emptyNavShells: ['#nav'], mode: 'verify' });
    assert.match(w, /--verify/);
    assert.ok(!/--bootstrap/.test(w), 'a verify run must not send you to redraft the contract');
  });
  it('bootstrap mode keeps its original remedy', () => {
    const w = buildDraftCaptureWarning({ emptyNavShells: ['#nav'], mode: 'bootstrap' });
    assert.match(w, /--bootstrap --from-url/);
  });
  it('the empty-shell decision is identical across modes', () => {
    assert.ok(buildDraftCaptureWarning({ emptyNavShells: ['#n'], hasStorageState: true, mode: 'verify' }));
    assert.ok(buildDraftCaptureWarning({ emptyNavShells: ['#n'], hasStorageState: true, mode: 'bootstrap' }));
    assert.equal(buildDraftCaptureWarning({ emptyNavShells: [], hasStorageState: true, mode: 'verify' }), null);
  });
});

/**
 * authSentinel tri-state. `PERCEIVABLE_SOURCE` returns `null` ("could not
 * establish") only when getBoundingClientRect/getComputedStyle throws. The probe
 * used to flatten that into "not rendered", so a sentinel whose EVERY match was
 * unestablishable read `dead` ("your token expired") — the opposite of the
 * file's own rule that unknown must never read as an expired session.
 *
 * The probe runs the REAL PERCEIVABLE_SOURCE; only the DOM elements are stubs.
 */
describe('authSentinel probe — unknown is not dead', () => {
  const rendered = (text = '') => ({ nodeType: 1, isConnected: true, textContent: text, getBoundingClientRect: () => ({ width: 10, height: 10 }), checkVisibility: () => true });
  const notRendered = (text = '') => ({ nodeType: 1, isConnected: true, textContent: text, getBoundingClientRect: () => ({ width: 0, height: 0 }) });
  const unestablishable = (text = '') => ({ nodeType: 1, isConnected: true, textContent: text, getBoundingClientRect: () => { throw new Error('detached mid-read'); } });

  const probe = (els, expectText = '') => {
    const prev = globalThis.document;
    globalThis.document = { querySelectorAll: () => els };
    try {
      return sentinelProbeInPage({ src: PERCEIVABLE_SOURCE, fnName: PERCEIVABLE_FN_NAME, selector: '#acct', expectText });
    } finally {
      if (prev === undefined) delete globalThis.document; else globalThis.document = prev;
    }
  };
  const resolve = (probed, over = {}) => resolveAuthLiveness({
    storageState: 'state.json', authSentinel: { selector: '#acct' },
    sentinelSeen: probed.hit, sentinelError: null, sentinelUnknown: probed.unknown, ...over,
  });

  it('subject probe: the stubs really exercise all three predicate outcomes', () => {
    assert.deepEqual(probe([rendered()]), { hit: true, unknown: 0 });
    assert.deepEqual(probe([notRendered()]), { hit: false, unknown: 0 });
    assert.deepEqual(probe([unestablishable()]), { hit: false, unknown: 1 });
  });

  it('every match unestablishable -> unverified with a warning naming the count, NOT dead', () => {
    const r = resolve(probe([unestablishable(), unestablishable()]));
    assert.equal(r.authLiveness, 'unverified');
    assert.match(r.warning, /2 element\(s\)/);
    assert.match(r.warning, /not reported as dead/);
  });

  it('negative control: every match established not-rendered still reads dead', () => {
    const r = resolve(probe([notRendered(), notRendered()]));
    assert.equal(r.authLiveness, 'dead');
    assert.equal(r.warning, null);
  });

  it('negative control: no match at all still reads dead', () => {
    assert.equal(resolve(probe([])).authLiveness, 'dead');
  });

  it('a mix of not-rendered and unestablishable is unknown (a null is a null, even beside falses)', () => {
    const r = resolve(probe([notRendered(), unestablishable()]));
    assert.equal(r.authLiveness, 'unverified');
    assert.match(r.warning, /1 element\(s\)/);
  });

  it('one rendered match wins over unestablishable ones -> live, no warning', () => {
    const r = resolve(probe([unestablishable(), rendered()]));
    assert.equal(r.authLiveness, 'live');
    assert.equal(r.warning, null);
  });

  it('a null on an element whose text can never match expectText is not counted', () => {
    // It would not have qualified even if rendered, so it says nothing about liveness.
    assert.equal(resolve(probe([unestablishable('Sign in')], 'my account')).authLiveness, 'dead');
    assert.equal(resolve(probe([unestablishable('My Account')], 'my account')).authLiveness, 'unverified');
  });

  it('expectText still gates a rendered match', () => {
    assert.deepEqual(probe([rendered('Sign in')], 'my account'), { hit: false, unknown: 0 });
    assert.deepEqual(probe([rendered('My  Account')], 'my account'), { hit: true, unknown: 0 });
  });

  it('the rest of the truth table is unchanged', () => {
    const base = { storageState: 'state.json', authSentinel: { selector: '#a' }, sentinelSeen: false, sentinelError: null };
    assert.equal(resolveAuthLiveness({ ...base, storageState: null }).authLiveness, 'n/a');
    assert.equal(resolveAuthLiveness({ ...base, authSentinel: null }).authLiveness, 'unverified');
    const bad = resolveAuthLiveness({ ...base, sentinelError: 'bad selector' });
    assert.equal(bad.authLiveness, 'unverified');
    assert.match(bad.warning, /selector failed to evaluate: bad selector/);
    assert.equal(resolveAuthLiveness({ ...base, sentinelSeen: true }).authLiveness, 'live');
    assert.equal(resolveAuthLiveness(base).authLiveness, 'dead');
  });

  it('the unknown outcome composes into a degraded (unverified) capture, never auth-dead', () => {
    const v = composeCaptureVerdict({ authLiveness: resolve(probe([unestablishable()])).authLiveness, hasStorageState: true });
    assert.equal(v.status, 'auth-unverified');
    assert.ok(!/AUTH SESSION DEAD/.test(v.warnings.join('\n')));
  });
});
