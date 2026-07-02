/**
 * @fileoverview Theme-safety v2 — contrast parity-delta + coverage tests
 * (plan docs/plans/visual-audit-theme-safety-v2.md §9, Tier-1 test-first).
 *
 * Covers: XOR-pass delta detection, both-fail/both-pass silence, one-theme-only
 * skip, unresolved-backdrop skip, livePath join identity (>8-deep repeated
 * structures — Gemini-H1), within-theme collision guard, coverage contract
 * (unsupported_theme_count / fulldom_capture_empty / no_resolvable_backdrops),
 * scope-disjoint producer isolation, and the non-mutating clone normalizer
 * (Gemini-M1). Pure fixtures — no browser.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runContrastParityDelta, assessParityCoverage, runThemeParity, assessParityKeyAmbiguity, assessThemePairResolution } from '../scripts/lib/visual/theme-parity.mjs';
import { assembleLiveFindings } from '../scripts/lib/visual/findings.mjs';
import { VisualFindingSchema, VisualContractSchema } from '../scripts/lib/visual/schema.mjs';

// ── Fixtures ────────────────────────────────────────────────────────────────

const CONTRACT = {
  themes: [{ name: 'light' }, { name: 'dark' }],
  tolerances: { contrastRatio: 4.5 },
};

/** A full-DOM evidence node. Colors are CSS strings (computed) / normalized
 *  stacks (backgroundStack), matching the extract contract. */
function fdNode(overrides = {}) {
  return {
    scope: 'fullDom',
    surfaceId: null,
    nodeKey: 'div:1>p:1',
    livePath: 'html:1>body:1>main:1>p:1',
    tag: 'p',
    device: 'desktop',
    hasText: true,
    displayed: true,
    computed: { color: 'rgb(0, 0, 0)' },              // black text
    backgroundStack: ['255,255,255'],                  // white bg → 21:1
    ...overrides,
  };
}

/** The motivating bug shape: a color that did NOT adapt — same near-black text
 *  in both themes; white bg in light (passes), near-black bg in dark (fails). */
function unadaptedPair() {
  const light = fdNode({ theme: 'light' });
  const dark = fdNode({ theme: 'dark', backgroundStack: ['20,20,20'] }); // black-on-near-black
  return { light: [light], dark: [dark] };
}

// ── runContrastParityDelta ──────────────────────────────────────────────────

describe('runContrastParityDelta — the XOR-pass fingerprint', () => {
  test('fires when contrast passes in light and fails in dark', () => {
    const out = runContrastParityDelta(unadaptedPair(), CONTRACT);
    assert.equal(out.length, 1);
    const f = out[0];
    assert.equal(f.class, 'contrast_parity_delta');
    assert.equal(f.theme, 'dark'); // the failing theme
    assert.equal(f.reportOnly, true);
    assert.match(f.actual, /fails only in dark/);
    assert.ok(f.evidence.includes('html:1>body:1>main:1>p:1'), 'livePath in evidence');
  });

  test('fires in the reverse direction (passes dark, fails light)', () => {
    const light = fdNode({ theme: 'light', computed: { color: 'rgb(200, 200, 200)' } }); // light gray on white → fail
    const dark = fdNode({ theme: 'dark', computed: { color: 'rgb(200, 200, 200)' }, backgroundStack: ['20,20,20'] }); // on near-black → pass
    const out = runContrastParityDelta({ light: [light], dark: [dark] }, CONTRACT);
    assert.equal(out.length, 1);
    assert.equal(out[0].theme, 'light');
  });

  test('silent when contrast fails in BOTH themes (decorative — no delta)', () => {
    const light = fdNode({ computed: { color: 'rgb(230, 230, 230)' } });              // ~white on white → fail
    const dark = fdNode({ computed: { color: 'rgb(30, 30, 30)' }, backgroundStack: ['20,20,20'] }); // black on black → fail
    assert.equal(runContrastParityDelta({ light: [light], dark: [dark] }, CONTRACT).length, 0);
  });

  test('silent when contrast passes in BOTH themes (adapted correctly)', () => {
    const light = fdNode();                                                            // black on white → pass
    const dark = fdNode({ computed: { color: 'rgb(240, 240, 240)' }, backgroundStack: ['20,20,20'] }); // white on black → pass
    assert.equal(runContrastParityDelta({ light: [light], dark: [dark] }, CONTRACT).length, 0);
  });

  test('skips a node present in only one theme (legit theme-conditional)', () => {
    const { light } = unadaptedPair();
    assert.equal(runContrastParityDelta({ light, dark: [] }, CONTRACT).length, 0);
  });

  test('skips when either backdrop is unverified (gradient/image) — no false delta', () => {
    const pair = unadaptedPair();
    pair.dark[0].backgroundStack = ['unresolvable']; // image/gradient sentinel
    assert.equal(runContrastParityDelta(pair, CONTRACT).length, 0);
  });

  test('skips non-displayed and non-text pairs', () => {
    const hidden = unadaptedPair();
    hidden.dark[0].displayed = false;
    assert.equal(runContrastParityDelta(hidden, CONTRACT).length, 0);
    const noText = unadaptedPair();
    noText.light[0].hasText = false;
    assert.equal(runContrastParityDelta(noText, CONTRACT).length, 0);
  });

  test('returns [] (never throws) when contract declares !== 2 themes', () => {
    const pair = unadaptedPair();
    assert.equal(runContrastParityDelta(pair, { themes: [{ name: 'light' }] }).length, 0);
    assert.equal(runContrastParityDelta(pair, { themes: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }).length, 0);
  });

  test('theme pair comes from CONTRACT order, not object-key order', () => {
    // nodesByTheme keys deliberately reversed vs contract order — must still join.
    const { light, dark } = unadaptedPair();
    const out = runContrastParityDelta({ dark, light }, CONTRACT);
    assert.equal(out.length, 1);
    assert.equal(out[0].theme, 'dark');
  });
});

describe('runContrastParityDelta — livePath join identity (Gemini-H1)', () => {
  test('>8-deep repeated cards join per-card on livePath (nodeKey would collide)', () => {
    // Three sibling "cards" nested >8 levels deep: identical structural tails →
    // identical depth-8 nodeKeys, but distinct un-truncated livePaths.
    const deep = (i) => `html:1>body:1>div:1>div:1>div:1>div:1>div:1>section:1>ul:1>li:${i}>p:1`;
    const sharedKey = '…>div:1>div:1>div:1>section:1>ul:1>li:1>p:1'; // depth-8 truncation collides
    const mk = (theme, i, bg) => fdNode({ theme, nodeKey: sharedKey, livePath: deep(i), backgroundStack: [bg] });
    const light = [mk('light', 1, '255,255,255'), mk('light', 2, '255,255,255'), mk('light', 3, '255,255,255')];
    // Only card 2 fails in dark.
    const dark = [mk('dark', 1, '255,255,255'), mk('dark', 2, '20,20,20'), mk('dark', 3, '255,255,255')];
    const out = runContrastParityDelta({ light, dark }, CONTRACT);
    assert.equal(out.length, 1, 'exactly the one unadapted card fires — no collapse to one key');
    assert.ok(out[0].evidence.includes(deep(2)));
  });

  test('collision guard: a livePath duplicated WITHIN a theme is dropped, not matched', () => {
    const { light, dark } = unadaptedPair();
    const dupe = fdNode({ theme: 'light', computed: { color: 'rgb(255, 0, 0)' } }); // same livePath as light[0]
    const out = runContrastParityDelta({ light: [...light, dupe], dark }, CONTRACT);
    assert.equal(out.length, 0, 'ambiguous key must not fabricate a delta');
  });

  test('nodes without a livePath are ignored (never joined via nodeKey)', () => {
    const pair = unadaptedPair();
    delete pair.light[0].livePath;
    delete pair.dark[0].livePath;
    assert.equal(runContrastParityDelta(pair, CONTRACT).length, 0);
  });
});

// ── assessParityCoverage ────────────────────────────────────────────────────

describe('assessParityCoverage — the one explicit coverage contract', () => {
  test('themes !== 2 → unverified(unsupported_theme_count)', () => {
    const r = assessParityCoverage({ nodesByTheme: {}, contract: { themes: [{ name: 'light' }] } });
    assert.equal(r.status, 'unverified');
    assert.equal(r.reason, 'unsupported_theme_count');
  });

  test('fullDomRequested && emitted===0 && candidates>0 → unverified(fulldom_capture_empty)', () => {
    const r = assessParityCoverage({
      nodesByTheme: {},
      contract: CONTRACT,
      captureStatsByState: [{ device: 'desktop', theme: 'light', fullDomRequested: true, emitted: 0, displayedTextCandidatesAfterSkip: 12 }],
    });
    assert.equal(r.status, 'unverified');
    assert.equal(r.reason, 'fulldom_capture_empty');
    assert.equal(r.scopeStats.length, 1);
  });

  test('0 candidates after skip = legitimately nothing to assess, NOT a degrade (R2-M3)', () => {
    const r = assessParityCoverage({
      nodesByTheme: unadaptedPair(),
      contract: CONTRACT,
      captureStatsByState: [{ fullDomRequested: true, emitted: 0, displayedTextCandidatesAfterSkip: 0 }],
    });
    assert.equal(r.status, 'assessable');
  });

  test('eligible>0 && withEvidence===0 → unverified(no_resolvable_backdrops)', () => {
    const pair = unadaptedPair();
    pair.light[0].backgroundStack = ['unresolvable'];
    pair.dark[0].backgroundStack = ['unresolvable'];
    const r = assessParityCoverage({ nodesByTheme: pair, contract: CONTRACT });
    assert.equal(r.status, 'unverified');
    assert.equal(r.reason, 'no_resolvable_backdrops');
    assert.equal(r.eligible, 1);
    assert.equal(r.withEvidence, 0);
  });

  test('assessable with counts when evidence resolves', () => {
    const r = assessParityCoverage({ nodesByTheme: unadaptedPair(), contract: CONTRACT });
    assert.equal(r.status, 'assessable');
    assert.equal(r.eligible, 1);
    assert.equal(r.withEvidence, 1);
    assert.deepEqual(r.themePair, ['light', 'dark']);
  });
});

// ── Wiring: scope-disjoint producers + non-mutating normalizer ──────────────

describe('assembleLiveFindings — v2 wiring invariants', () => {
  /** A contracted-surface node shaped for the absolute producers. */
  function contractedNode(overrides = {}) {
    return {
      surfaceId: 'hero',
      nodeKey: 'div:1',
      tag: 'div',
      device: 'desktop',
      theme: 'light',
      hasText: true,
      displayed: true,
      computed: { color: 'rgb(230, 230, 230)' }, // near-white on white → contrast_failure fodder
      backgroundStack: ['255,255,255'],
      declarations: [],
      ...overrides,
    };
  }

  const EMPTY = { allowedSet: { families: {} }, tokenIndex: {}, contract: CONTRACT };

  test('isolation invariant: no gate-eligible finding ever derives from a fullDom node', () => {
    // A fullDom node with an ABSOLUTE contrast failure in one state only —
    // the absolute contrast_failure producer must never see it.
    const fd = fdNode({ theme: 'light', computed: { color: 'rgb(240, 240, 240)' } }); // ~white on white
    const perState = [
      { device: 'desktop', theme: 'light', viewportWidth: 1280, nodes: [fd] },
      { device: 'desktop', theme: 'dark', viewportWidth: 1280, nodes: [] },
    ];
    const findings = assembleLiveFindings({ perState, ...EMPTY });
    const gateEligible = findings.filter((f) => f.gateEligible);
    assert.equal(gateEligible.length, 0, `fullDom node leaked into a gate-eligible producer: ${JSON.stringify(gateEligible)}`);
    assert.equal(findings.filter((f) => f.class === 'contrast_failure').length, 0);
  });

  test('the delta fires through assembly over fullDom nodes and is NOT gateEligible', () => {
    const pair = unadaptedPair();
    const perState = [
      { device: 'desktop', theme: 'light', viewportWidth: 1280, nodes: pair.light },
      { device: 'desktop', theme: 'dark', viewportWidth: 1280, nodes: pair.dark },
    ];
    const findings = assembleLiveFindings({ perState, ...EMPTY });
    const deltas = findings.filter((f) => f.class === 'contrast_parity_delta');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].gateEligible, false);
    assert.equal(deltas[0].severity, 'P2');
  });

  test('contracted producers still run over contracted nodes (fence, not a blanket drop)', () => {
    const perState = [{ device: 'desktop', theme: 'light', viewportWidth: 1280, nodes: [contractedNode()] }];
    const findings = assembleLiveFindings({ perState, ...EMPTY });
    assert.ok(findings.some((f) => f.class === 'contrast_failure'), 'absolute contrast still fires on contracted nodes');
  });

  test('non-mutating normalizer (Gemini-M1): input perState node objects gain no scope prop', () => {
    const node = contractedNode();
    const fd = fdNode();
    const perState = [
      { device: 'desktop', theme: 'light', viewportWidth: 1280, nodes: [node, fd] },
      { device: 'desktop', theme: 'dark', viewportWidth: 1280, nodes: [] },
    ];
    const before = JSON.stringify(perState);
    assembleLiveFindings({ perState, ...EMPTY });
    assert.equal(Object.hasOwn(node, 'scope'), false, 'contracted input node must not be stamped in place');
    assert.equal(JSON.stringify(perState), before, 'perState serialized bytes unchanged by assembly');
  });

  test('inert when no fullDom nodes exist (flag-off): zero parity-delta findings', () => {
    const perState = [
      { device: 'desktop', theme: 'light', viewportWidth: 1280, nodes: [contractedNode()] },
      { device: 'desktop', theme: 'dark', viewportWidth: 1280, nodes: [contractedNode({ theme: 'dark' })] },
    ];
    const findings = assembleLiveFindings({ perState, ...EMPTY });
    assert.equal(findings.filter((f) => f.class === 'contrast_parity_delta').length, 0);
  });

  test('schema boundary (audit R1): a finalized delta finding parses under VisualFindingSchema', () => {
    const pair = unadaptedPair();
    const perState = [
      { device: 'desktop', theme: 'light', viewportWidth: 1280, nodes: pair.light },
      { device: 'desktop', theme: 'dark', viewportWidth: 1280, nodes: pair.dark },
    ];
    const findings = assembleLiveFindings({ perState, ...EMPTY });
    const delta = findings.find((f) => f.class === 'contrast_parity_delta');
    const parsed = VisualFindingSchema.parse(delta); // canonical shape only — no custom top-level props
    assert.equal(parsed.gateEligible, false);
    assert.equal(parsed.severity, 'P2');
    assert.ok(parsed.evidence.some((e) => e.includes('html:1>body:1')), 'livePath survives in evidence');
  });
});

// ── Audit R1 hardening fixes ────────────────────────────────────────────────

describe('audit R1 fixes — producer boundary + contracted-parity guards', () => {
  test('producer enforces fullDom scope itself: mixed-scope input never joins contracted nodes', () => {
    // A contracted node smuggled into BOTH theme lists with a delta-shaped
    // contrast difference — must be ignored by the producer's own filter.
    const smuggledL = fdNode({ scope: 'contracted', surfaceId: 'hero' });
    const smuggledD = fdNode({ scope: 'contracted', surfaceId: 'hero', theme: 'dark', backgroundStack: ['20,20,20'] });
    const out = runContrastParityDelta({ light: [smuggledL], dark: [smuggledD] }, CONTRACT);
    assert.equal(out.length, 0, 'contracted nodes must be rejected at the producer boundary');
  });

  test('duplicate theme names in the contract → not assessable (no self-join)', () => {
    const dupContract = { themes: [{ name: 'light' }, { name: 'light' }], tolerances: { contrastRatio: 4.5 } };
    assert.equal(runContrastParityDelta(unadaptedPair(), dupContract).length, 0);
    const cov = assessParityCoverage({ nodesByTheme: unadaptedPair(), contract: dupContract });
    assert.equal(cov.status, 'unverified');
    assert.equal(cov.reason, 'unsupported_theme_count');
  });

  test('unknown hasText (absent) is NOT eligible — no fabricated delta', () => {
    const pair = unadaptedPair();
    delete pair.light[0].hasText;
    assert.equal(runContrastParityDelta(pair, CONTRACT).length, 0);
  });

  test('runThemeParity (R1-H1): within-theme duplicate nodeKey is dropped, not cross-matched', () => {
    // Two distinct light-theme nodes colliding on one nodeKey with DIFFERENT
    // literal colors; dark theme has one node with the same key. A naive index
    // would pair last-write-wins and could fabricate theme_unmapped_token.
    const mkN = (theme, key, color) => ({
      nodeKey: key, tag: 'p', hasText: true, displayed: true, theme,
      computed: { color, 'background-color': 'rgba(0, 0, 0, 0)', 'border-top-style': 'none', 'border-top-width': '0px' },
      declarations: [],
    });
    const light = [mkN('light', 'p:1', 'rgb(10, 10, 10)'), mkN('light', 'p:1', 'rgb(99, 99, 99)')];
    const dark = [mkN('dark', 'p:1', 'rgb(10, 10, 10)')];
    const out = runThemeParity({ light, dark }, { themes: [{ name: 'light' }, { name: 'dark' }] });
    assert.equal(out.filter((f) => f.class === 'theme_unmapped_token').length, 0, 'ambiguous key must not produce a parity finding');
  });

  test('runThemeParity (R2-H2): fail-closed when declared themes don\'t match captured keys', () => {
    // Contract declares light/dark but capture keys are differently named (a
    // capture/config mismatch) — comparing arbitrary keys could pair the wrong
    // themes, so parity must be NOT assessable, not silently compared.
    const mkN = (theme) => ({
      nodeKey: 'p:1', tag: 'p', hasText: true, displayed: true, theme,
      computed: { color: 'rgb(10, 10, 10)', 'background-color': 'rgba(0, 0, 0, 0)', 'border-top-style': 'none', 'border-top-width': '0px' },
      declarations: [],
    });
    const nodesByTheme = { Light: [mkN('Light')], Dark: [mkN('Dark')] }; // case-mismatched keys
    const out = runThemeParity(nodesByTheme, { themes: [{ name: 'light' }, { name: 'dark' }] });
    assert.equal(out.length, 0, 'declared>=2 with <2 captured matches must fail closed');
    // No contract themes declared → captured-key fallback still works (synth default path).
    const ok = runThemeParity({ a: [mkN('a')], b: [mkN('b')] }, { themes: [] });
    assert.ok(ok.some((f) => f.class === 'theme_unmapped_token'), 'fallback preserved when contract declares <2');
  });

  test('assessParityKeyAmbiguity (R2-H1): within-theme duplicate keys are COUNTED, not silent', () => {
    const mkN = (theme, key) => ({ nodeKey: key, theme });
    const r = assessParityKeyAmbiguity({
      light: [mkN('light', 'p:1'), mkN('light', 'p:1'), mkN('light', 'q:1')],
      dark: [mkN('dark', 'p:1')],
    });
    assert.equal(r.ambiguousKeys, 1);
    assert.deepEqual(r.byTheme, { light: 1 });
    assert.deepEqual(assessParityKeyAmbiguity({ light: [mkN('light', 'p:1')] }), { ambiguousKeys: 0, byTheme: {} });
  });

  test('R3-H1: VisualContractSchema rejects duplicate theme names and surface ids at parse', () => {
    const base = { version: 1, surfaces: [], tokenSources: [], themes: [] };
    const theme = (name) => ({ name, apply: { mode: 'attribute', target: 'html', attribute: 'data-theme', value: name, settleSelector: null } });
    const surface = (id) => ({ id, selector: `#${id}` });
    assert.throws(() => VisualContractSchema.parse({ ...base, themes: [theme('light'), theme('light')] }), /unique/);
    assert.throws(() => VisualContractSchema.parse({ ...base, surfaces: [surface('a'), surface('a')] }), /unique/);
    assert.doesNotThrow(() => VisualContractSchema.parse({ ...base, themes: [theme('light'), theme('dark')], surfaces: [surface('a'), surface('b')] }));
  });

  test('R3-H2: coverage exposes ambiguousPaths; total ambiguity degrades, never reads clean', () => {
    const { light, dark } = unadaptedPair();
    const dupe = fdNode({ theme: 'light', computed: { color: 'rgb(255, 0, 0)' } }); // duplicates light[0].livePath
    const cov = assessParityCoverage({ nodesByTheme: { light: [...light, dupe], dark }, contract: CONTRACT });
    assert.equal(cov.status, 'unverified');
    assert.equal(cov.reason, 'all_candidates_ambiguous');
    assert.equal(cov.ambiguousPaths, 1);
    // Partial ambiguity: one clean join + one ambiguous pair → assessable, count exposed.
    const extraL = fdNode({ theme: 'light', livePath: 'html:1>body:1>main:1>p:2' });
    const extraD = fdNode({ theme: 'dark', livePath: 'html:1>body:1>main:1>p:2', backgroundStack: ['20,20,20'] });
    const cov2 = assessParityCoverage({ nodesByTheme: { light: [...light, dupe, extraL], dark: [...dark, extraD] }, contract: CONTRACT });
    assert.equal(cov2.status, 'assessable');
    assert.equal(cov2.ambiguousPaths, 1);
    assert.equal(cov2.eligible, 1);
  });

  test('structural join failure (arm-eval 93d107d7): zero matched livePaths across themes → unverified, not clean', () => {
    // Theme-conditional element shifted nth-of-type for everything below it:
    // both themes have candidates, but NO livePath matches.
    const light = [fdNode({ theme: 'light', livePath: 'html:1>body:1>main:1>p:1' })];
    const dark = [fdNode({ theme: 'dark', livePath: 'html:1>body:1>main:2>p:1', backgroundStack: ['20,20,20'] })];
    const cov = assessParityCoverage({ nodesByTheme: { light, dark }, contract: CONTRACT });
    assert.equal(cov.status, 'unverified');
    assert.equal(cov.reason, 'no_joinable_candidates');
    // But an EMPTY side (theme genuinely has no fullDom candidates) is not a join failure.
    const covEmpty = assessParityCoverage({ nodesByTheme: { light, dark: [] }, contract: CONTRACT });
    assert.equal(covEmpty.status, 'assessable');
  });

  test('R3-H3: assessThemePairResolution reports the unassessable state machine-readably', () => {
    const mkN = (theme) => ({ nodeKey: 'p:1', theme });
    // Mismatch: declared light/dark, captured Light/Dark.
    const mismatch = assessThemePairResolution({ Light: [mkN('Light')], Dark: [mkN('Dark')] }, CONTRACT);
    assert.equal(mismatch.status, 'contract_capture_mismatch');
    assert.deepEqual(mismatch.declaredThemes, ['light', 'dark']);
    assert.equal(mismatch.pair, null);
    // Single theme captured.
    assert.equal(assessThemePairResolution({ light: [mkN('light')] }, CONTRACT).status, 'single_theme');
    // OK: contract-order pair.
    const ok = assessThemePairResolution({ dark: [mkN('dark')], light: [mkN('light')] }, CONTRACT);
    assert.equal(ok.status, 'ok');
    assert.deepEqual(ok.pair, ['light', 'dark']);
    // runThemeParity delegates to the same resolution (single source of truth).
    const out = runThemeParity({ Light: [mkN('Light')], Dark: [mkN('Dark')] }, CONTRACT);
    assert.equal(out.length, 0);
  });

  test('runThemeParity (R1-H2): theme pair follows CONTRACT order, not capture-key order', () => {
    // An identical untokened literal in both themes → theme_unmapped_token fires
    // with evidence naming [tA, tB]. With reversed capture-key order, the pair
    // must still come out in contract order (deterministic evidence).
    const mkN = (theme) => ({
      nodeKey: 'p:1', tag: 'p', hasText: true, displayed: true, theme,
      computed: { color: 'rgb(10, 10, 10)', 'background-color': 'rgba(0, 0, 0, 0)', 'border-top-style': 'none', 'border-top-width': '0px' },
      declarations: [],
    });
    const nodesByTheme = { dark: [mkN('dark')], light: [mkN('light')] }; // insertion order: dark first
    const out = runThemeParity(nodesByTheme, { themes: [{ name: 'light' }, { name: 'dark' }] });
    const f = out.find((x) => x.class === 'theme_unmapped_token');
    assert.ok(f, 'expected the unmapped-token finding');
    assert.match(f.actual, /identical in light & dark/, 'contract order (light, dark) governs, not key order');
  });
});
