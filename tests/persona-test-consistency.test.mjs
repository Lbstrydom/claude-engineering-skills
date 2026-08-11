/**
 * @fileoverview Phase 1 consistency diff engine tests.
 *
 * Covers the contradiction grammar end-to-end:
 *   - Exact match (boolean / integer / enum / id)
 *   - Type coercion failure → value-coercion-error
 *   - Stale-projection emits at severityFloor (Gemini-R2-G4)
 *   - Null ground-truth → absent-not-rendered
 *   - Negative-space — undeclared engine claim → P0
 *   - Missing-surface gated by appliesTo (R1-M4)
 *   - Collection scope matching (R1-H2)
 *   - Cross-stream defence is in semantic-compare; this file asserts
 *     diffClaims doesn't invoke the comparator for non-prose types
 *   - Prose comparator routing — invoked only for llmSafe prose fields
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffClaims, coerceDomValue, coerceDomKey, manifestQualityWarnings,
  matchesRoutePattern, routePatternCoverageWarnings, _internals }
  from '../scripts/lib/persona-test/consistency.mjs';

// ────────────────────────────────────────────────────────────────────────────
// coerceDomValue
// ────────────────────────────────────────────────────────────────────────────

describe('coerceDomValue', () => {
  it('boolean: "true"/"false" round-trip', () => {
    assert.deepEqual(coerceDomValue('true', 'boolean'),  { ok: true, value: true });
    assert.deepEqual(coerceDomValue('false', 'boolean'), { ok: true, value: false });
  });
  it('boolean: rejects other strings', () => {
    assert.equal(coerceDomValue('yes', 'boolean').ok, false);
    assert.equal(coerceDomValue('', 'boolean').ok, false);
  });
  it('integer: accepts plain integer, rejects trailing fragments', () => {
    assert.deepEqual(coerceDomValue('42', 'integer'), { ok: true, value: 42 });
    assert.equal(coerceDomValue('42abc', 'integer').ok, false);
    assert.equal(coerceDomValue('', 'integer').ok, false);
    assert.equal(coerceDomValue('3.14', 'integer').ok, false);
  });
  it('enum: requires membership when semanticValues declared', () => {
    assert.equal(coerceDomValue('feasible',   'enum', ['feasible','infeasible']).ok, true);
    assert.equal(coerceDomValue('infeasible', 'enum', ['feasible','infeasible']).ok, true);
    assert.equal(coerceDomValue('mystery',    'enum', ['feasible','infeasible']).ok, false);
  });
  it('enum: accepts anything when semanticValues omitted', () => {
    assert.equal(coerceDomValue('whatever', 'enum').ok, true);
  });
  it('id / prose / freshness pass through as strings', () => {
    assert.deepEqual(coerceDomValue('abc', 'id'),        { ok: true, value: 'abc' });
    assert.deepEqual(coerceDomValue('hi',  'prose'),     { ok: true, value: 'hi' });
    assert.deepEqual(coerceDomValue('stale','freshness'),{ ok: true, value: 'stale' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// coerceDomKey (Gemini-R4-G2)
// ────────────────────────────────────────────────────────────────────────────

describe('coerceDomKey', () => {
  it('coerces number-typed keys', () => {
    assert.deepEqual(coerceDomKey('42',  'number'), { ok: true, value: 42 });
    assert.equal(coerceDomKey('abc', 'number').ok, false);
    assert.equal(coerceDomKey('',    'number').ok, false);
  });
  it('coerces boolean-typed keys', () => {
    assert.deepEqual(coerceDomKey('true', 'boolean'), { ok: true, value: true });
    assert.equal(coerceDomKey('TRUE', 'boolean').ok, false);
  });
  it('passes strings through', () => {
    assert.deepEqual(coerceDomKey('wine-abc', 'string'), { ok: true, value: 'wine-abc' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// diffClaims — fixtures + helpers
// ────────────────────────────────────────────────────────────────────────────

function makeManifest(overrides = {}) {
  const base = {
    version: 1,
    collections: [],
    surfaces: [{
      id: 'status-chip',
      locator: { kind: 'role', role: 'status', name: undefined, warn: undefined },
      severityFloor: 'P0',
      engineFields: [
        { field: 'cellarOrganised', type: 'boolean',
          llmSafe: false, llmMaxChars: 2000 },
      ],
    }],
  };
  return { ...base, ...overrides };
}

function makeDomClaim(o) {
  return {
    surfaceId: o.surfaceId ?? 'status-chip',
    engineField: o.engineField ?? 'cellarOrganised',
    domValueRaw: o.domValueRaw ?? 'true',
    freshness: o.freshness ?? 'current',
    scope: o.scope ?? null,
    key: o.key ?? null,
    locator: o.locator ?? { kind: 'role', role: 'status' },
    visible: o.visible ?? true,
  };
}

function makeNetClaim(o) {
  return {
    surfaceId: o.surfaceId ?? 'status-chip',
    engineField: o.engineField ?? 'cellarOrganised',
    scope: o.scope ?? null,
    key: o.key ?? null,
    value: o.value,
    sourceUrl: o.sourceUrl ?? '/api/cellar',
    receivedAt: o.receivedAt ?? new Date().toISOString(),
  };
}

function emptyWitness(over = {}) {
  return {
    stepIndex: 0,
    domClaims: over.domClaims ?? [],
    networkClaims: over.networkClaims ?? [],
    undeclaredDomClaims: over.undeclaredDomClaims ?? [],
    partialCapture: false,
    customClaims: {},
  };
}

// ────────────────────────────────────────────────────────────────────────────
// diffClaims — happy path + exact match
// ────────────────────────────────────────────────────────────────────────────

describe('diffClaims — exact match', () => {
  it('no findings when DOM matches engine (boolean true)', async () => {
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ domValueRaw: 'true' })],
      networkClaims: [makeNetClaim({ value: true })],
    });
    const f = await diffClaims(witness, makeManifest());
    assert.deepEqual(f, []);
  });

  it('emits value-mismatch when DOM and engine disagree on boolean', async () => {
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ domValueRaw: 'true' })],
      networkClaims: [makeNetClaim({ value: false })],
    });
    const f = await diffClaims(witness, makeManifest());
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, 'value-mismatch');
    assert.equal(f[0].severity, 'P0');
    assert.equal(f[0].surfaceId, 'status-chip');
  });

  it('integer round-trip', async () => {
    const m = makeManifest();
    m.surfaces[0].engineFields[0] = { field: 'count', type: 'integer', llmSafe: false, llmMaxChars: 2000 };
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ engineField: 'count', domValueRaw: '42' })],
      networkClaims: [makeNetClaim({ engineField: 'count', value: 42 })],
    });
    const f = await diffClaims(witness, m);
    assert.deepEqual(f, []);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// diffClaims — coercion failure
// ────────────────────────────────────────────────────────────────────────────

describe('diffClaims — coercion failure', () => {
  it('emits value-coercion-error when DOM not parseable as integer', async () => {
    const m = makeManifest();
    m.surfaces[0].engineFields[0] = { field: 'count', type: 'integer', llmSafe: false, llmMaxChars: 2000 };
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ engineField: 'count', domValueRaw: '42abc' })],
      networkClaims: [makeNetClaim({ engineField: 'count', value: 42 })],
    });
    const f = await diffClaims(witness, m);
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, 'value-coercion-error');
    assert.match(f[0].detail, /coerce/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// diffClaims — stale-projection (Gemini-R2-G4)
// ────────────────────────────────────────────────────────────────────────────

describe('diffClaims — stale-projection respects severityFloor', () => {
  it('P0-floor surface emits P0 stale-projection', async () => {
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ domValueRaw: 'true', freshness: 'stale' })],
      networkClaims: [makeNetClaim({ value: true })],   // values agree
    });
    const f = await diffClaims(witness, makeManifest());
    const stale = f.find((x) => x.kind === 'stale-projection');
    assert.ok(stale, 'must emit stale-projection');
    assert.equal(stale.severity, 'P0');
  });

  it('P2-floor surface emits P2 stale-projection (Gemini-R2-G4)', async () => {
    const m = makeManifest();
    m.surfaces[0].severityFloor = 'P2';
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ domValueRaw: 'true', freshness: 'stale' })],
      networkClaims: [makeNetClaim({ value: true })],
    });
    const f = await diffClaims(witness, m);
    const stale = f.find((x) => x.kind === 'stale-projection');
    assert.ok(stale);
    assert.equal(stale.severity, 'P2');
  });

  // Wine-cellar round-4 #2 — detail enrichment with three branches.
  it('detail includes engine "(match)" framing when stale value still agrees with engine', async () => {
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ domValueRaw: 'true', freshness: 'stale' })],
      networkClaims: [makeNetClaim({ value: true })],   // agrees
    });
    const f = await diffClaims(witness, makeManifest());
    const stale = f.find((x) => x.kind === 'stale-projection');
    assert.ok(stale);
    assert.match(stale.detail, /engine ground-truth: true \(match\)/i);
    assert.equal(stale.engineValue, true,
      'engineValue must be populated when ground-truth was captured');
  });

  it('detail includes "(DIVERGES)" framing when stale value disagrees with engine', async () => {
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ domValueRaw: 'true', freshness: 'stale' })],
      networkClaims: [makeNetClaim({ value: false })],   // diverges
    });
    const f = await diffClaims(witness, makeManifest());
    const stale = f.find((x) => x.kind === 'stale-projection');
    assert.ok(stale);
    assert.match(stale.detail, /\(DIVERGES\)/);
    assert.match(stale.detail, /Both stale AND value-mismatch/i);
    assert.equal(stale.engineValue, false);
  });

  it('detail flags "ground-truth NOT captured" when no matching network claim exists', async () => {
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ domValueRaw: 'true', freshness: 'stale' })],
      networkClaims: [],   // no ground truth
    });
    const f = await diffClaims(witness, makeManifest());
    const stale = f.find((x) => x.kind === 'stale-projection');
    assert.ok(stale);
    assert.match(stale.detail, /ground-truth NOT captured/i);
    assert.equal(stale.engineValue, null,
      'engineValue must be null when no ground-truth was captured');
  });

  it('detail always includes the stringified DOM value so ledger readers see both sides', async () => {
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ domValueRaw: 'feasible', freshness: 'stale' })],
      networkClaims: [makeNetClaim({ value: 'feasible' })],
    });
    const m = makeManifest();
    m.surfaces[0].engineFields[0] = { field: 'cellarOrganised', type: 'enum',
      semanticValues: ['feasible', 'infeasible'], llmSafe: false, llmMaxChars: 2000 };
    const f = await diffClaims(witness, m);
    const stale = f.find((x) => x.kind === 'stale-projection');
    assert.ok(stale);
    assert.match(stale.detail, /"feasible"/, 'DOM value must appear quoted in the detail');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// diffClaims — null ground-truth handling (Gemini-R4-G3)
// ────────────────────────────────────────────────────────────────────────────

describe('diffClaims — null engine value contract', () => {
  it('engine null + DOM freshness !== "absent" → absent-not-rendered', async () => {
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ domValueRaw: 'true', freshness: 'current' })],
      networkClaims: [makeNetClaim({ value: null })],
    });
    const f = await diffClaims(witness, makeManifest());
    const found = f.find((x) => x.kind === 'absent-not-rendered');
    assert.ok(found);
  });

  it('engine null + DOM freshness === "absent" → no finding', async () => {
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ domValueRaw: '',     freshness: 'absent' })],
      networkClaims: [makeNetClaim({ value: null })],
    });
    const f = await diffClaims(witness, makeManifest());
    assert.deepEqual(f, []);
  });

  it('engine present + DOM freshness === "absent" → absent-not-rendered', async () => {
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ domValueRaw: '', freshness: 'absent' })],
      networkClaims: [makeNetClaim({ value: true })],
    });
    const f = await diffClaims(witness, makeManifest());
    const found = f.find((x) => x.kind === 'absent-not-rendered');
    assert.ok(found);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// diffClaims — negative-space (P0 undeclared)
// ────────────────────────────────────────────────────────────────────────────

describe('diffClaims — negative-space', () => {
  it('undeclared engineField on declared surface → P0 undeclared-engine-claim (no double-flag)', async () => {
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ engineField: 'bogus.field' })],
      networkClaims: [],
    });
    const f = await diffClaims(witness, makeManifest());
    // Surface WAS matched (status-chip name was correct), so no missing-surface.
    const undeclared = f.find((x) => x.kind === 'undeclared-engine-claim');
    assert.ok(undeclared);
    assert.equal(undeclared.severity, 'P0');
    const missing = f.find((x) => x.kind === 'missing-surface');
    assert.equal(missing, undefined, 'surface name matched, no missing-surface expected');
  });

  it('undeclared surfaceId in DOM → P0 undeclared-engine-claim (plus missing-surface for the declared one)', async () => {
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ surfaceId: 'mystery-surface' })],
      networkClaims: [],
    });
    const f = await diffClaims(witness, makeManifest());
    const undeclared = f.find((x) => x.kind === 'undeclared-engine-claim');
    assert.ok(undeclared, 'must emit undeclared-engine-claim for the mystery surfaceId');
    assert.equal(undeclared.severity, 'P0');
    // Declared status-chip is genuinely absent from this DOM → missing-surface fires too.
    const missing = f.find((x) => x.kind === 'missing-surface');
    assert.ok(missing, 'declared status-chip was not seen → missing-surface');
  });

  it('witness.undeclaredDomClaims surfaces P0 from the negative-space scan', async () => {
    const witness = emptyWitness({
      undeclaredDomClaims: [{ engineField: 'unknown.bogus', selector: '.x' }],
    });
    const f = await diffClaims(witness, makeManifest());
    const found = f.find((x) => x.kind === 'undeclared-engine-claim' && x.engineField === 'unknown.bogus');
    assert.ok(found);
    assert.equal(found.severity, 'P0');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// diffClaims — missing-surface gated by appliesTo (R1-M4)
// ────────────────────────────────────────────────────────────────────────────

describe('diffClaims — missing-surface respects appliesTo', () => {
  it('surface absent + appliesTo matches current route → P3 missing-surface', async () => {
    const m = makeManifest();
    m.surfaces[0].appliesTo = { routePattern: '^/cellar' };
    const f = await diffClaims(emptyWitness(), m, { context: { currentRoute: '/cellar' } });
    const missing = f.find((x) => x.kind === 'missing-surface');
    assert.ok(missing);
    assert.equal(missing.severity, 'P3');
  });

  it('surface absent + appliesTo does not match → NO missing-surface finding', async () => {
    const m = makeManifest();
    m.surfaces[0].appliesTo = { routePattern: '^/admin' };
    const f = await diffClaims(emptyWitness(), m, { context: { currentRoute: '/cellar' } });
    const missing = f.find((x) => x.kind === 'missing-surface');
    assert.equal(missing, undefined);
  });

  it('surface absent + no appliesTo → always emits missing-surface', async () => {
    const f = await diffClaims(emptyWitness(), makeManifest());
    const missing = f.find((x) => x.kind === 'missing-surface');
    assert.ok(missing);
  });

  // Closes wine-cellar adoption issue #40 partial-gating: requiresState
  // was schema-accepted but the gate fired only when `activeStateTags`
  // was supplied by the caller. The runner now derives those tags from
  // state-projecting domClaims (stateV2 / state / mode / status); these
  // tests pin the contract that the gate honours them.
  it('requiresState present + matching activeStateTags → surface applies', async () => {
    const m = makeManifest();
    m.surfaces[0].appliesTo = { requiresState: ['blocked'] };
    const f = await diffClaims(emptyWitness(), m, {
      context: { activeStateTags: ['blocked'] },
    });
    const missing = f.find((x) => x.kind === 'missing-surface');
    assert.ok(missing, 'requiresState matches → missing-surface still fires');
  });

  it('requiresState present + non-matching activeStateTags → surface skipped', async () => {
    const m = makeManifest();
    m.surfaces[0].appliesTo = { requiresState: ['blocked'] };
    const f = await diffClaims(emptyWitness(), m, {
      context: { activeStateTags: ['major'] },
    });
    const missing = f.find((x) => x.kind === 'missing-surface');
    assert.equal(missing, undefined, 'requiresState mismatches → no false-positive');
  });

  it('requiresState present + activeStateTags omitted by caller → surface skipped (legacy callers)', async () => {
    const m = makeManifest();
    m.surfaces[0].appliesTo = { requiresState: ['blocked'] };
    const f = await diffClaims(emptyWitness(), m, { context: {} });
    const missing = f.find((x) => x.kind === 'missing-surface');
    // No activeStateTags ⇒ requiresState clause cannot evaluate ⇒ default
    // is "applies" (the existing behavior — backwards-compat).
    assert.ok(missing, 'no activeStateTags → assume applies (legacy callers preserved)');
  });

  // Upstream 8c62cfcc (wine-cellar-app): currentRoute was pathname-only, so a
  // query-routed SPA (`/?view=grid`) produced "/" at every step and a
  // routePattern naming a query param could never test true — the gate
  // abstained on every step for the whole life of the surface.
  it('routePattern matches a query-routed SPA (currentRoute carries ?search)', async () => {
    const m = makeManifest();
    m.surfaces[0].appliesTo = { routePattern: 'view=grid' };
    const f = await diffClaims(emptyWitness(), m, {
      context: { currentRoute: '/?view=grid' },
    });
    assert.ok(f.find((x) => x.kind === 'missing-surface'),
      'query-param routePattern must gate IN on the matching view');
  });

  it('routePattern on a query-routed SPA still gates OUT the non-matching view', async () => {
    const m = makeManifest();
    m.surfaces[0].appliesTo = { routePattern: 'view=grid' };
    const f = await diffClaims(emptyWitness(), m, {
      context: { currentRoute: '/?view=history' },
    });
    assert.equal(f.find((x) => x.kind === 'missing-surface'), undefined,
      'discrimination must survive the fix — not just "matches everything"');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// matchesRoutePattern + routePatternCoverageWarnings — upstream 8c62cfcc
// ────────────────────────────────────────────────────────────────────────────

describe('matchesRoutePattern', () => {
  it('matches on the query string, not just the pathname', () => {
    assert.equal(matchesRoutePattern('view=grid', '/?view=grid'), true);
    assert.equal(matchesRoutePattern('view=grid', '/'), false);
  });
  it('an uncompilable pattern degrades to "unrestricted", never to "excluded"', () => {
    assert.equal(matchesRoutePattern('([', '/anything'), true);
  });
});

describe('routePatternCoverageWarnings', () => {
  const withPattern = (pattern, id = 'status-chip') => {
    const m = makeManifest();
    m.surfaces[0].id = id;
    m.surfaces[0].appliesTo = { routePattern: pattern };
    return m;
  };

  it('emits nothing when the pattern matched at least one visited route', () => {
    const w = routePatternCoverageWarnings(withPattern('view=grid'), ['/?view=grid', '/?view=history']);
    assert.deepEqual(w, []);
  });

  it('emits route-pattern-never-matched when the pattern matched no visited route', () => {
    const w = routePatternCoverageWarnings(withPattern('view=analysis'), ['/?view=grid', '/?view=history']);
    assert.equal(w.length, 1);
    assert.equal(w[0].kind, 'route-pattern-never-matched');
    assert.equal(w[0].surfaceId, 'status-chip');
    assert.match(w[0].detail, /view=analysis/);
    assert.match(w[0].detail, /view=history/, 'the observed routes must be in the detail — that is the diagnosis');
  });

  it('names the anchored-before-query cause when stripping ?search would have matched', () => {
    const w = routePatternCoverageWarnings(withPattern('^/wines$'), ['/wines?tab=all']);
    assert.equal(w.length, 1);
    assert.match(w[0].detail, /anchored before the query/);
    assert.match(w[0].detail, /\^\/wines\(\\\?\|\$\)/, 'suggests a concrete re-anchored pattern');
  });

  it('does NOT claim anchoring when the pattern is simply wrong', () => {
    const w = routePatternCoverageWarnings(withPattern('^/admin'), ['/wines?tab=all']);
    assert.equal(w.length, 1);
    assert.doesNotMatch(w[0].detail, /anchored before the query/);
    assert.match(w[0].detail, /journeyStepLabels/, 'points at the working discriminator instead');
  });

  it('emits nothing when the run observed no routes at all (absence of evidence)', () => {
    assert.deepEqual(routePatternCoverageWarnings(withPattern('view=grid'), []), []);
    assert.deepEqual(routePatternCoverageWarnings(withPattern('view=grid'), [null, undefined, '']), []);
  });

  it('ignores surfaces that declare no routePattern', () => {
    assert.deepEqual(routePatternCoverageWarnings(makeManifest(), ['/?view=grid']), []);
  });

  it('caps the observed-route list and says how many were elided', () => {
    const routes = Array.from({ length: 12 }, (_, i) => `/?view=v${i}`);
    const w = routePatternCoverageWarnings(withPattern('view=nope'), routes);
    assert.equal(w.length, 1);
    assert.match(w[0].detail, /…\+4 more/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// diffClaims — prose routing
// ────────────────────────────────────────────────────────────────────────────

describe('diffClaims — prose routing', () => {
  it('prose field with llmSafe=false is skipped silently (no finding, no compare call)', async () => {
    const m = makeManifest();
    m.surfaces[0].engineFields[0] = { field: 'headline', type: 'prose', llmSafe: false, llmMaxChars: 2000 };
    let called = 0;
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ engineField: 'headline', domValueRaw: 'Cellar is full' })],
      networkClaims: [makeNetClaim({ engineField: 'headline', value: 'Cellar at capacity' })],
    });
    const f = await diffClaims(witness, m, { semanticCompare: async () => { called++; return {result:{matched:'no'}}; } });
    assert.equal(called, 0, 'semanticCompare must NOT be invoked for llmSafe:false');
    assert.equal(f.length, 0);
  });

  it('prose field with llmSafe=true routes to semanticCompare; mismatch verdict surfaces value-mismatch', async () => {
    const m = makeManifest();
    m.surfaces[0].engineFields[0] = { field: 'headline', type: 'prose', llmSafe: true, llmMaxChars: 2000 };
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ engineField: 'headline', domValueRaw: 'Cellar is empty' })],
      networkClaims: [makeNetClaim({ engineField: 'headline', value: 'Cellar at capacity' })],
    });
    const f = await diffClaims(witness, m, {
      semanticCompare: async (a, b, fieldType) => {
        assert.equal(fieldType, 'prose', 'diff must dispatch with fieldType=prose');
        return { result: { matched: 'no', reason: 'opposing claims' } };
      },
    });
    const v = f.find((x) => x.kind === 'value-mismatch');
    assert.ok(v);
    assert.match(v.detail, /opposing claims/i);
  });

  it('prose match → no finding', async () => {
    const m = makeManifest();
    m.surfaces[0].engineFields[0] = { field: 'headline', type: 'prose', llmSafe: true, llmMaxChars: 2000 };
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ engineField: 'headline', domValueRaw: 'A' })],
      networkClaims: [makeNetClaim({ engineField: 'headline', value: 'A' })],
    });
    const f = await diffClaims(witness, m, {
      semanticCompare: async () => ({ result: { matched: 'yes', score: 1 } }),
    });
    assert.deepEqual(f, []);
  });

  it('prose without comparator falls back to LOW-confidence string compare; floor still wins', async () => {
    // Surface with P3 floor — proposed fallback severity P2 wins (more severe).
    const m = makeManifest();
    m.surfaces[0].severityFloor = 'P3';
    m.surfaces[0].engineFields[0] = { field: 'headline', type: 'prose', llmSafe: true, llmMaxChars: 2000 };
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ engineField: 'headline', domValueRaw: 'A' })],
      networkClaims: [makeNetClaim({ engineField: 'headline', value: 'B' })],
    });
    const f = await diffClaims(witness, m, {});  // no semanticCompare
    const v = f.find((x) => x.kind === 'value-mismatch');
    assert.ok(v);
    assert.match(v.detail, /comparator unavailable/i);
    assert.equal(v.severity, 'P2', 'P2 proposed beats P3 floor');
  });

  it('prose-without-comparator on P0-floor surface clamps to P0', async () => {
    const m = makeManifest();
    m.surfaces[0].engineFields[0] = { field: 'headline', type: 'prose', llmSafe: true, llmMaxChars: 2000 };
    const witness = emptyWitness({
      domClaims:     [makeDomClaim({ engineField: 'headline', domValueRaw: 'A' })],
      networkClaims: [makeNetClaim({ engineField: 'headline', value: 'B' })],
    });
    const f = await diffClaims(witness, m, {});
    const v = f.find((x) => x.kind === 'value-mismatch');
    assert.ok(v);
    assert.equal(v.severity, 'P0', 'P0 floor wins over P2 proposed');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// _internals: severity clamp + locator stringification
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// manifestQualityWarnings (resolves wine-cellar adoption #2 + #3)
// ────────────────────────────────────────────────────────────────────────────

describe('manifestQualityWarnings', () => {
  it('emits a css-locator-prefer-semantic warning for css/warn:true surfaces', () => {
    const m = makeManifest();
    m.surfaces[0].locator = { kind: 'css', selector: '#cellar-status-badge', warn: true };
    const w = manifestQualityWarnings(m);
    assert.equal(w.length, 1);
    assert.equal(w[0].kind, 'css-locator-prefer-semantic');
    assert.equal(w[0].surfaceId, 'status-chip');
    // Critical: no `.` prefix mangling — selector flows through verbatim.
    assert.match(w[0].detail, /#cellar-status-badge/);
    assert.equal(/\.\s*#cellar-status-badge/.test(w[0].detail), false,
      'selector must NOT be prefixed with "." (wine-cellar adoption #2)');
  });
  it('does NOT emit for css/warn:false', () => {
    const m = makeManifest();
    m.surfaces[0].locator = { kind: 'css', selector: '.silenced', warn: false };
    assert.deepEqual(manifestQualityWarnings(m), []);
  });
  it('does NOT emit for semantic locators (role/label/testid/id)', () => {
    for (const locator of [
      { kind: 'role', role: 'status' },
      { kind: 'label', text: 'Cellar status' },
      { kind: 'testid', id: 'cellar' },
      { kind: 'id', id: 'cellar-badge' },
    ]) {
      const m = makeManifest();
      m.surfaces[0].locator = locator;
      assert.deepEqual(manifestQualityWarnings(m), [], `expected no warnings for ${locator.kind}`);
    }
  });
  it('does NOT emit as a contradiction (wine-cellar adoption #3 — warnings go in step.warnings[])', async () => {
    const m = makeManifest();
    m.surfaces[0].locator = { kind: 'css', selector: '#cellar-status-badge', warn: true };
    // Witness has zero claims so the diff path can't add a contradiction
    // for any other reason — anything that comes back is the false-emit.
    const f = await diffClaims(emptyWitness(), m);
    assert.equal(f.find((x) => x.kind === 'value-mismatch' && x.surfaceId === 'status-chip'), undefined,
      'CSS-locator nudge must NOT be emitted as a value-mismatch contradiction');
  });
});

describe('_internals', () => {
  it('clampToFloor raises proposed severity TOWARD floor only', () => {
    const { clampToFloor } = _internals;
    assert.equal(clampToFloor('P3', 'P1'), 'P1', 'P3 proposed, P1 floor → raise to P1');
    assert.equal(clampToFloor('P0', 'P1'), 'P0', 'P0 already higher than floor — unchanged');
    assert.equal(clampToFloor('P1', 'P1'), 'P1');
  });
  it('locatorToString handles every locator kind', () => {
    const { locatorToString } = _internals;
    assert.match(locatorToString({ kind: 'role', role: 'status' }),         /role=status/);
    assert.match(locatorToString({ kind: 'role', role: 'button', name: 'X' }), /role=button.*name="X"/);
    assert.match(locatorToString({ kind: 'label', text: 'Foo' }),           /label="Foo"/);
    assert.match(locatorToString({ kind: 'testid', id: 'bar' }),            /data-testid="bar"/);
    assert.equal(locatorToString({ kind: 'id', id: 'cellar-badge' }),       '#cellar-badge');
    assert.equal(locatorToString({ kind: 'css', selector: '.chip' }),       '.chip');
  });
});
