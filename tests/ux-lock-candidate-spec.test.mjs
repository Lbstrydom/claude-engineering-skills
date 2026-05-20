/**
 * @fileoverview Phase 2 candidate-spec renderer tests.
 *
 * Covers:
 *   - Filename derives from surface + candidate fingerprint
 *   - Body has the three sections (Setup / Navigate / Assert)
 *   - storageState auth → test.use()
 *   - token auth → test.beforeEach with header injection
 *   - Navigate replay translates every action kind to Playwright calls
 *   - Determinism: same input → byte-identical body
 *   - Refuses when surfaceId or journeySteps missing
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderCandidateSpec, _internals } from '../scripts/lib/ux-lock/candidate-spec.mjs';

function baseWitness() {
  return {
    stepIndex: 1,
    domClaims: [{
      surfaceId: 'status-chip', engineField: 'cellarOrganised',
      domValueRaw: 'true', freshness: 'current',
      scope: null, key: null,
      locator: { kind: 'role', role: 'status' }, visible: true,
    }],
    networkClaims: [],
    undeclaredDomClaims: [],
    partialCapture: false,
    customClaims: {},
  };
}

function baseContradiction(over = {}) {
  return {
    kind: 'value-mismatch', severity: 'P0',
    surfaceId: 'status-chip', engineField: 'cellarOrganised',
    scope: null, key: null,
    domValue: 'true', engineValue: false, freshness: 'current',
    selector: '[role="status"]',
    detail: 'DOM says organised; engine says not.',
    suppressedByLockedSpec: null,
    ...over,
  };
}

function baseJourney(over = {}) {
  return {
    journeySteps: [
      { action: 'navigate', label: 'open cellar', routeKey: 'cellar', waitUntil: 'load' },
      { action: 'click', label: 'reorganise',
        locator: { kind: 'role', role: 'button', name: 'Reorganise' } },
    ],
    routes: { cellar: '/cellar' },
    authBootstrap: { kind: 'none' },
    candidateFingerprint: 'abc123def456789',
    ...over,
  };
}

describe('renderCandidateSpec — output shape', () => {
  it('filename is derived from surfaceId + short fingerprint', () => {
    const { filename } = renderCandidateSpec(baseWitness(), baseContradiction(), baseJourney());
    assert.match(filename, /^consistency-status-chip-abc123def4\.spec\.js$/);
  });

  it('body contains import, ROUTES, and the test block', () => {
    const { body } = renderCandidateSpec(baseWitness(), baseContradiction(), baseJourney());
    assert.match(body, /import \{ test, expect \} from '@playwright\/test';/);
    assert.match(body, /const ROUTES = \{/);
    assert.match(body, /test\("consistency lock — status-chip \(value-mismatch\)"/);
  });

  it('emits the navigate call with routeKey lookup', () => {
    const { body } = renderCandidateSpec(baseWitness(), baseContradiction(), baseJourney());
    assert.match(body, /await page\.goto\(ROUTES\["cellar"\], \{ waitUntil: "load" \}\);/);
  });

  it('emits a click call against the journey locator', () => {
    const { body } = renderCandidateSpec(baseWitness(), baseContradiction(), baseJourney());
    assert.match(body, /await page\.getByRole\("button", \{ name: "Reorganise" \}\)\.click\(\);/);
  });

  it('asserts on the contradicted selector + expected engine value + freshness', () => {
    const { body } = renderCandidateSpec(baseWitness(), baseContradiction(), baseJourney());
    assert.match(body, /const el = page\.locator\("\[role=\\"status\\"\]"\);/);
    assert.match(body, /expect\(observed\)\.toBe\(String\(false\)\);/);
    assert.match(body, /expect\(freshness\)\.not\.toBe\('stale'\);/);
  });
});

describe('renderCandidateSpec — auth bootstrap', () => {
  it('storageState → test.use({ storageState: ... })', () => {
    const { body } = renderCandidateSpec(baseWitness(), baseContradiction(),
      baseJourney({ authBootstrap: { kind: 'storageState', storageStatePath: '.auth/state.json' } }));
    assert.match(body, /test\.use\(\{ storageState: "\.auth\/state\.json" \}\);/);
  });

  it('token → test.beforeEach with bearer header', () => {
    const { body } = renderCandidateSpec(baseWitness(), baseContradiction(),
      baseJourney({ authBootstrap: { kind: 'token', tokenEnv: 'CELLAR_TOKEN' } }));
    assert.match(body, /test\.beforeEach\(async \(\{ context \}\) =>/);
    assert.match(body, /process\.env\["CELLAR_TOKEN"\]/);
    assert.match(body, /setExtraHTTPHeaders/);
  });

  it('none → no setup block emitted', () => {
    const { body } = renderCandidateSpec(baseWitness(), baseContradiction(), baseJourney());
    assert.equal(/test\.use\(/.test(body), false);
    assert.equal(/test\.beforeEach\(/.test(body), false);
  });
});

describe('renderCandidateSpec — every journey action', () => {
  it('navigate with explicit url instead of routeKey', () => {
    const j = baseJourney({ journeySteps: [
      { action: 'navigate', label: 'open', url: 'https://example.com/x', waitUntil: 'domcontentloaded' },
    ]});
    const { body } = renderCandidateSpec(baseWitness(), baseContradiction(), j);
    assert.match(body, /await page\.goto\("https:\/\/example\.com\/x", \{ waitUntil: "domcontentloaded" \}\);/);
  });

  it('fill → locator.fill() + locator.blur()', () => {
    const j = baseJourney({ journeySteps: [
      { action: 'fill', label: 'name', locator: { kind: 'label', text: 'Name' }, value: 'Cab 2018', blurAfter: true },
    ]});
    const { body } = renderCandidateSpec(baseWitness(), baseContradiction(), j);
    assert.match(body, /page\.getByLabel\("Name"\)\.fill\("Cab 2018"\);/);
    assert.match(body, /page\.getByLabel\("Name"\)\.blur\(\);/);
  });

  it('wait kinds: visible / hidden / url / network / timeout', () => {
    const j = baseJourney({ journeySteps: [
      { action: 'wait', label: 'v', condition: { kind: 'visible', locator: { kind: 'testid', id: 'x' }, timeoutMs: 1234 } },
      { action: 'wait', label: 'h', condition: { kind: 'hidden',  locator: { kind: 'testid', id: 'y' }, timeoutMs: 1234 } },
      { action: 'wait', label: 'u', condition: { kind: 'url', urlPattern: '/done', timeoutMs: 1234 } },
      { action: 'wait', label: 'n', condition: { kind: 'network', urlPattern: '/api', method: 'POST', timeoutMs: 1234 } },
      { action: 'wait', label: 't', condition: { kind: 'timeout', ms: 250 } },
    ]});
    const { body } = renderCandidateSpec(baseWitness(), baseContradiction(), j);
    assert.match(body, /getByTestId\("x"\)\.waitFor\(\{ state: 'visible'/);
    assert.match(body, /getByTestId\("y"\)\.waitFor\(\{ state: 'hidden'/);
    assert.match(body, /page\.waitForURL\(new RegExp\("\/done"\)/);
    assert.match(body, /page\.waitForResponse\(/);
    assert.match(body, /page\.waitForTimeout\(250\)/);
  });

  it('evaluate emits a TODO comment (v1 scope per §11b)', () => {
    const j = baseJourney({ journeySteps: [
      { action: 'evaluate', label: 'seed', scriptId: 'reset-fixture' },
    ]});
    const { body } = renderCandidateSpec(baseWitness(), baseContradiction(), j);
    assert.match(body, /TODO: replay evaluate step "reset-fixture"/);
  });
});

describe('renderCandidateSpec — null + non-string engine values', () => {
  it('null engine value → expect String(null)', () => {
    const { body } = renderCandidateSpec(baseWitness(),
      baseContradiction({ engineValue: null }), baseJourney());
    assert.match(body, /expect\(observed\)\.toBe\(String\(null\)\);/);
  });

  it('numeric engine value → expect String(<n>)', () => {
    const { body } = renderCandidateSpec(baseWitness(),
      baseContradiction({ engineValue: 42 }), baseJourney());
    assert.match(body, /expect\(observed\)\.toBe\(String\(42\)\);/);
  });

  it('string engine value is JSON-quoted', () => {
    const { body } = renderCandidateSpec(baseWitness(),
      baseContradiction({ engineValue: 'feasible' }), baseJourney());
    assert.match(body, /expect\(observed\)\.toBe\(String\("feasible"\)\);/);
  });
});

describe('renderCandidateSpec — determinism', () => {
  it('same input → byte-identical body', () => {
    const a = renderCandidateSpec(baseWitness(), baseContradiction(), baseJourney());
    const b = renderCandidateSpec(baseWitness(), baseContradiction(), baseJourney());
    assert.equal(a.filename, b.filename);
    assert.equal(a.body, b.body);
  });
});

describe('renderCandidateSpec — refuses bad input', () => {
  it('throws when contradiction.surfaceId missing', () => {
    assert.throws(
      () => renderCandidateSpec(baseWitness(), { ...baseContradiction(), surfaceId: null }, baseJourney()),
      /surfaceId/,
    );
  });
  it('throws when journeySteps missing', () => {
    assert.throws(
      () => renderCandidateSpec(baseWitness(), baseContradiction(), { routes: {} }),
      /journeySteps/,
    );
  });
});

describe('_internals', () => {
  it('slug strips non-alphanumerics and lower-cases', () => {
    assert.equal(_internals.slug('Status Chip!'), 'status-chip');
    assert.equal(_internals.slug('---x'), 'x');
  });
  it('locatorCall handles every kind', () => {
    const { locatorCall } = _internals;
    assert.match(locatorCall({ kind: 'role', role: 'button' }), /getByRole\("button"\)/);
    assert.match(locatorCall({ kind: 'role', role: 'button', name: 'OK' }), /getByRole\("button", \{ name: "OK" \}\)/);
    assert.match(locatorCall({ kind: 'label', text: 'Foo' }), /getByLabel\("Foo"\)/);
    assert.match(locatorCall({ kind: 'testid', id: 'bar' }), /getByTestId\("bar"\)/);
    assert.match(locatorCall({ kind: 'css', selector: '.x' }), /page\.locator\("\.x"\)/);
  });
});
