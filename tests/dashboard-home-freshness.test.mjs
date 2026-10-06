/**
 * @fileoverview Home freshness and the content hash (docs/plans/dashboard-home-summary.md §2).
 *
 * (1) `dashboard.js` computes the page's age in the BROWSER from `data-built-at`; its pure
 * age function is exposed through a guarded `module.exports`, loaded here in a `vm`
 * sandbox (the file is a browser IIFE: a `require` of it in this ESM package would not
 * be CommonJS, and it needs a `document`). 23 h / 24 h / 25 h, and a missing or invalid
 * stamp (never throws, shows nothing).
 *
 * (2) `provenance.sourceHash` includes Home THROUGH `homeContentProjection`: identical
 * across timestamp-only differences, different for a changed measurement, and — the
 * negative control — different (so this test is red) against a mutant projection that
 * keeps timestamps.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { referenceSourceHash } from '../scripts/lib/dashboard/collect-reference.mjs';
import { homeContentProjection } from '../scripts/lib/dashboard/collect-home.mjs';

const JS = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'lib', 'dashboard', 'assets', 'dashboard.js'), 'utf8');
const H = 3_600_000;
const BUILT = '2026-10-06T12:00:00.000Z';
const BUILT_MS = Date.parse(BUILT);

/** Run dashboard.js in a sandbox. `doc` stands in for `document`; `withModule:false` is the browser case. */
function load({ doc, now = BUILT_MS, withModule = true } = {}) {
  const document = doc ?? { querySelector: () => null, getElementById: () => null };
  class FakeDate extends Date { static now() { return now; } }
  const sandbox = { document, Date: FakeDate, console, setTimeout };
  const mod = { exports: {} };
  if (withModule) sandbox.module = mod;
  vm.runInNewContext(JS, sandbox, { filename: 'dashboard.js' });
  return mod.exports;
}

describe('homeFreshness (pure)', () => {
  const { homeFreshness } = load();

  test('23 h is fresh, EXACTLY 24 h is fresh (stale means strictly older), 25 h is stale and names its age', () => {
    assert.equal(homeFreshness(BUILT, BUILT_MS + 23 * H).stale, false);
    assert.equal(homeFreshness(BUILT, BUILT_MS + 24 * H).stale, false);
    const f = homeFreshness(BUILT, BUILT_MS + 25 * H);
    assert.equal(f.stale, true);
    assert.equal(f.label, '25 hours');
    assert.equal(f.ageMs, 25 * H);
    assert.equal(homeFreshness(BUILT, BUILT_MS + 24 * H + 1).stale, true, 'one millisecond past the window');
  });

  test('labels: hours, then days from 48 h', () => {
    assert.equal(homeFreshness(BUILT, BUILT_MS + 1 * H).label, '1 hour');
    assert.equal(homeFreshness(BUILT, BUILT_MS + 47 * H).label, '47 hours');
    assert.equal(homeFreshness(BUILT, BUILT_MS + 72 * H).label, '3 days');
  });

  test('a missing or invalid stamp yields null and NEVER throws; a stamp in the future is age 0, not stale', () => {
    for (const bad of [undefined, null, '', 'not a date', '2026-13-45T99:99:99Z', 12345, {}, []]) {
      assert.equal(homeFreshness(bad, BUILT_MS + 99 * H), null, `${JSON.stringify(bad)} shows nothing`);
    }
    assert.equal(homeFreshness(BUILT, Number.NaN), null);
    assert.equal(homeFreshness(BUILT, undefined), null);
    const future = homeFreshness(BUILT, BUILT_MS - 5 * H);
    assert.deepEqual([future.ageMs, future.stale], [0, false]);
  });
});

describe('dashboard.js integration with the Home panel', () => {
  /** A fake DOM: one `.home[data-built-at]` root holding a banner and an age span. */
  function fakeDom(builtAt) {
    const age = { textContent: '' };
    const banner = { hidden: true, querySelector: (sel) => (sel === '[data-role="home-age"]' ? age : null) };
    const root = {
      getAttribute: (n) => (n === 'data-built-at' ? builtAt : null),
      querySelector: (sel) => (sel === '[data-testid="home-stale-banner"]' ? banner : null),
    };
    return { age, banner, document: { querySelector: (sel) => (sel === '.home[data-built-at]' ? root : null), getElementById: () => null } };
  }

  test('25 h after the build: the banner is revealed and names the age; 23 h: it stays hidden', () => {
    const stale = fakeDom(BUILT);
    load({ doc: stale.document, now: BUILT_MS + 25 * H });
    assert.equal(stale.banner.hidden, false);
    assert.equal(stale.age.textContent, '25 hours');

    const fresh = fakeDom(BUILT);
    load({ doc: fresh.document, now: BUILT_MS + 23 * H });
    assert.equal(fresh.banner.hidden, true);
    assert.equal(fresh.age.textContent, '');
  });

  test('an invalid or missing data-built-at leaves the banner hidden and does not throw into the rest of the script', () => {
    for (const bad of ['garbage', '', null]) {
      const d = fakeDom(bad);
      assert.doesNotThrow(() => load({ doc: d.document, now: BUILT_MS + 99 * H }));
      assert.equal(d.banner.hidden, true, `${JSON.stringify(bad)} shows nothing`);
    }
    // No Home panel at all (Telemetry page, audit-run page): nothing to do.
    assert.doesNotThrow(() => load({ doc: { querySelector: () => null, getElementById: () => null } }));
  });

  test('in a browser (no `module`) the export guard is inert and the script still runs', () => {
    assert.doesNotThrow(() => load({ withModule: false }));
  });

  test('the "NO network calls" contract of dashboard.js still holds', () => {
    const code = JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const api of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'importScripts']) {
      assert.ok(!code.includes(api), `dashboard.js must not use ${api}`);
    }
  });
});

describe('sourceHash includes Home through the content projection', () => {
  const rest = { skills: [{ name: 'a' }], plans: { active: [], completed: [] }, architecture: {}, flows: null, cli: [], sources: { home: { status: 'ok', detail: '' } }, purposes: {}, navAudit: {}, visualAudit: {} };
  const homeAt = (builtAt, { q2 = 4, asOf = builtAt } = {}) => ({
    builtAt,
    durations: { queues: 5, inflight: 7 },
    cards: { queues: { id: 'queues', measurements: [{ id: 'queue-q2', asOf, status: 'ok', value: { total: q2 }, source: 's', detail: '' }] } },
    health: [{ id: 'queue-q2', asOf, state: 'ok', value: String(q2) }],
    needs: { rows: [], total: 0, more: 0, unmeasured: 0, headline: 'Nothing needs you' },
  });

  test('identical across timestamp-only differences', () => {
    const a = referenceSourceHash({ ...rest, home: homeAt('2026-10-06T12:00:00.000Z') });
    const b = referenceSourceHash({ ...rest, home: homeAt('2026-10-06T12:03:41.000Z') });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{8}$/);
  });

  test('different for a changed measurement', () => {
    const a = referenceSourceHash({ ...rest, home: homeAt('2026-10-06T12:00:00.000Z', { q2: 4 }) });
    const c = referenceSourceHash({ ...rest, home: homeAt('2026-10-06T12:00:00.000Z', { q2: 5 }) });
    assert.notEqual(a, c);
  });

  test('Home is IN the hash at all (a build without it hashes differently)', () => {
    assert.notEqual(
      referenceSourceHash({ ...rest, home: homeAt('2026-10-06T12:00:00.000Z') }),
      referenceSourceHash({ ...rest, home: null }),
    );
  });

  test('NEGATIVE CONTROL: against a mutant projection that keeps timestamps, the timestamp-only pair DIFFERS (the stability test above would be red)', () => {
    const identity = (h) => JSON.parse(JSON.stringify(h));
    const a = referenceSourceHash({ ...rest, home: homeAt('2026-10-06T12:00:00.000Z') }, identity);
    const b = referenceSourceHash({ ...rest, home: homeAt('2026-10-06T12:03:41.000Z') }, identity);
    assert.notEqual(a, b);
  });

  test('the default projection IS homeContentProjection (wiring, not just a parameter)', () => {
    const a = homeAt('2026-10-06T12:00:00.000Z');
    const b = homeAt('2026-10-06T12:03:41.000Z');
    assert.equal(referenceSourceHash({ ...rest, home: a }), referenceSourceHash({ ...rest, home: b }, homeContentProjection));
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'lib', 'dashboard', 'collect-reference.mjs'), 'utf8');
    assert.match(src, /projectHome = homeContentProjection/);
    assert.match(src, /referenceSourceHash\(\{[\s\S]*?home,\s*\}\)/, 'collectReference hashes through referenceSourceHash with home');
  });
});
