/**
 * @fileoverview Purpose tab — collector join correctness, hygiene universe,
 * config validation, escaping/XSS, a11y markup, and determinism. All pure
 * (no cloud). Plan: docs/plans/dashboard-purpose-view.md §9.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectPurposes } from '../scripts/lib/dashboard/collect-purposes.mjs';
import sectionPurpose from '../scripts/lib/dashboard/sections/purpose.mjs';
import sectionArchitecture from '../scripts/lib/dashboard/sections/architecture.mjs';
import { buildUi } from '../scripts/lib/dashboard/helpers.mjs';
import { purposeTitleElementId, archDomainElementId } from '../scripts/lib/dashboard/anchors.mjs';

// ── fixture helpers ──────────────────────────────────────────────────────

/** Write a temp repo root carrying a .audit-loop/domain-map.json. */
function fixtureRoot(t, mapBlocks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purpose-'));
  fs.mkdirSync(path.join(root, '.audit-loop'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.audit-loop', 'domain-map.json'),
    JSON.stringify({ rules: [], allowedDeps: {}, ...mapBlocks }),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const PURPOSES = [
  { id: 'audits', label: 'Deliver audits', summary: 'audit stuff', kind: 'skill-chain', flowNodes: ['audit-code'] },
  { id: 'trust', label: 'Preserve trust', summary: 'trust stuff', kind: 'curated', flowNodes: [] },
];
const RULES = [
  { pattern: 'a/**', domain: 'da' },
  { pattern: 'b/**', domain: 'db' },
  { pattern: 'c/**', domain: 'dc' },
];
const ARCH = [{ name: 'da' }, { name: 'db' }]; // dc has NO architecture entry
const FLOWS = { nodes: [{ id: 'audit-code' }, { id: 'ship' }] };

// ── join + dedupe (M1) ───────────────────────────────────────────────────

test('requirement spanning two domains in the SAME purpose appears once (dedupe)', (t) => {
  const root = fixtureRoot(t, {
    purposes: PURPOSES,
    domainPurposes: { da: ['audits'], db: ['audits'] },
  });
  const req = { id: 'REQ-1', kind: 'correctness', assertion: 'x', appliesTo: ['a/x.mjs', 'b/y.mjs'] };
  const out = collectPurposes(root, { architectureDomains: ARCH, flows: FLOWS, rules: RULES, requirements: [req], ledgerPresent: true });
  assert.equal(out.status, 'ok');
  const audits = out.nodes.find((n) => n.id === 'audits');
  assert.equal(audits.requirements.filter((r) => r.id === 'REQ-1').length, 1, 'no duplicate REQ-1');
});

test('requirement whose domains map to two purposes surfaces under both', (t) => {
  const root = fixtureRoot(t, {
    purposes: PURPOSES,
    domainPurposes: { da: ['audits'], db: ['trust'] },
  });
  const req = { id: 'REQ-2', kind: 'security', assertion: 'y', appliesTo: ['a/x.mjs', 'b/y.mjs'] };
  const out = collectPurposes(root, { architectureDomains: ARCH, flows: FLOWS, rules: RULES, requirements: [req], ledgerPresent: true });
  assert.ok(out.nodes.find((n) => n.id === 'audits').requirements.some((r) => r.id === 'REQ-2'));
  assert.ok(out.nodes.find((n) => n.id === 'trust').requirements.some((r) => r.id === 'REQ-2'));
});

// ── anchor contract (H2) ─────────────────────────────────────────────────

test('domain with arch entry → anchor=arch-domain-<id>; without → null + hygiene', (t) => {
  const root = fixtureRoot(t, {
    purposes: PURPOSES,
    domainPurposes: { da: ['audits'], dc: ['audits'] }, // dc has no arch entry
  });
  const out = collectPurposes(root, { architectureDomains: ARCH, flows: FLOWS, rules: RULES, requirements: [], ledgerPresent: true });
  const audits = out.nodes.find((n) => n.id === 'audits');
  const da = audits.domains.find((d) => d.id === 'da');
  const dc = audits.domains.find((d) => d.id === 'dc');
  assert.equal(da.anchor, 'arch-domain-da');
  assert.equal(dc.anchor, null);
  assert.ok(out.hygiene.domainsMissingArchitecture.includes('dc'));
});

test('alsoServes counts OTHER purposes a domain serves', (t) => {
  const root = fixtureRoot(t, {
    purposes: PURPOSES,
    domainPurposes: { da: ['audits', 'trust'] },
  });
  const out = collectPurposes(root, { architectureDomains: ARCH, flows: FLOWS, rules: RULES, requirements: [], ledgerPresent: true });
  const da = out.nodes.find((n) => n.id === 'audits').domains.find((d) => d.id === 'da');
  assert.equal(da.alsoServes, 1);
});

// ── hygiene universe (M2) ────────────────────────────────────────────────

test('hygiene: unmapped domains, unknown keys, unattached + skipped requirements', (t) => {
  const root = fixtureRoot(t, {
    rules: RULES,
    purposes: PURPOSES,
    domainPurposes: { da: ['audits'], nonsense: ['trust'] }, // db/dc unmapped; nonsense unknown
  });
  const reqs = [
    { id: 'REQ-unatt', kind: 'correctness', assertion: 'z', appliesTo: ['b/y.mjs'] }, // db unmapped → unattached
    { id: 'REQ-skip', kind: 'correctness', appliesTo: ['a/x.mjs'] },                  // no assertion → skipped
  ];
  const out = collectPurposes(root, { architectureDomains: ARCH, flows: FLOWS, rules: RULES, requirements: reqs, ledgerPresent: true });
  assert.ok(out.hygiene.unmappedDomains.includes('db'));
  assert.ok(out.hygiene.unmappedDomains.includes('dc'));
  assert.ok(out.hygiene.unknownDomains.includes('nonsense'));
  assert.ok(out.hygiene.unattachedRequirements.includes('REQ-unatt'));
  assert.equal(out.hygiene.skippedRequirements, 1);
});

// ── config validation (H1) ───────────────────────────────────────────────

test('domainPurposes referencing an unknown purpose id → invalid', (t) => {
  const root = fixtureRoot(t, { purposes: PURPOSES, domainPurposes: { da: ['ghost'] } });
  const out = collectPurposes(root, { architectureDomains: ARCH, flows: FLOWS, rules: RULES, requirements: [], ledgerPresent: true });
  assert.equal(out.status, 'invalid');
  assert.match(out.detail, /ghost/);
});

test('duplicate purpose id → invalid', (t) => {
  const dup = [...PURPOSES, { id: 'audits', label: 'dup', summary: 's', kind: 'curated', flowNodes: [] }];
  const root = fixtureRoot(t, { purposes: dup, domainPurposes: {} });
  const out = collectPurposes(root, { architectureDomains: ARCH, flows: FLOWS, rules: RULES, requirements: [], ledgerPresent: true });
  assert.equal(out.status, 'invalid');
  assert.match(out.detail, /duplicate/);
});

test('flowNodes referencing an unknown flow node → invalid (when flows present)', (t) => {
  const bad = [{ id: 'audits', label: 'A', summary: 's', kind: 'skill-chain', flowNodes: ['nope'] }];
  const root = fixtureRoot(t, { purposes: bad, domainPurposes: {} });
  const out = collectPurposes(root, { architectureDomains: ARCH, flows: FLOWS, rules: RULES, requirements: [], ledgerPresent: true });
  assert.equal(out.status, 'invalid');
  assert.match(out.detail, /nope/);
});

test('null flows does NOT crash flowNodes validation (Gemini3-M)', (t) => {
  const root = fixtureRoot(t, { purposes: PURPOSES, domainPurposes: { da: ['audits'] } });
  const out = collectPurposes(root, { architectureDomains: ARCH, flows: null, rules: RULES, requirements: [], ledgerPresent: true });
  assert.equal(out.status, 'ok');
});

// ── empty / determinism (M5) ─────────────────────────────────────────────

test('absent purposes block → missing-optional stable empty; ledgerPresent propagates', (t) => {
  const root = fixtureRoot(t, {}); // no purposes key
  const out = collectPurposes(root, { architectureDomains: ARCH, flows: FLOWS, rules: RULES, requirements: [], ledgerPresent: false });
  assert.equal(out.status, 'missing-optional');
  assert.deepEqual(out.nodes, []);
  assert.equal(out.ledgerPresent, false);
});

test('determinism: two identical calls deep-equal', (t) => {
  const root = fixtureRoot(t, { purposes: PURPOSES, domainPurposes: { da: ['audits'], db: ['trust'] } });
  const args = { architectureDomains: ARCH, flows: FLOWS, rules: RULES, requirements: [{ id: 'R', kind: 'correctness', assertion: 'a', appliesTo: ['a/x.mjs'] }], ledgerPresent: true };
  assert.deepEqual(collectPurposes(root, args), collectPurposes(root, args));
});

// ── renderer: escaping + a11y markup ─────────────────────────────────────

function renderFixture() {
  return {
    status: 'ok', detail: '', ledgerPresent: true,
    nodes: [{
      id: 'audits', label: '<script>alert(1)</script>', kind: 'skill-chain', summary: 'a & b "c"',
      flowNodes: ['audit-code'],
      domains: [{ id: 'da', anchor: 'arch-domain-da', alsoServes: 2 }, { id: 'd"x', anchor: null, alsoServes: 0 }],
      requirements: [{ id: 'REQ-1', kind: 'security', assertion: 'must <b>escape</b> & "quote"' }],
    }],
    hygiene: { unmappedDomains: ['db'], unattachedRequirements: ['REQ-z'], skippedRequirements: 0, unknownDomains: [], domainsMissingArchitecture: [] },
  };
}

test('renderer escapes all dynamic text/attrs (XSS — M3)', () => {
  const html = sectionPurpose({ src: { status: 'ok', detail: '' }, purposes: renderFixture() }, buildUi());
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="#arch-domain-da"[^>]*>da<[^/]*\/b>/); // sanity: assertion <b> not raw
  assert.match(html, /must &lt;b&gt;escape&lt;\/b&gt;/);
});

test('renderer emits a11y markup: section[aria-labelledby] + h3[id] + data-cross-tab', () => {
  const html = sectionPurpose({ src: { status: 'ok', detail: '' }, purposes: renderFixture() }, buildUi());
  assert.match(html, /<section class="purpose" aria-labelledby="purpose-audits-title">/);
  assert.match(html, /<h3 id="purpose-audits-title"/);
  assert.match(html, /<a class="domain-chip" data-cross-tab href="#arch-domain-da">/);
  assert.match(html, /data-testid="domain-also-serves"/);
  assert.match(html, /data-testid="purpose-hygiene"/);
});

test('renderer empty-state when status missing-optional', () => {
  const html = sectionPurpose({ src: { status: 'missing-optional', detail: 'no purposes' }, purposes: { status: 'missing-optional', detail: 'no purposes', ledgerPresent: false, nodes: [], hygiene: {} } }, buildUi());
  assert.match(html, /no purposes/);
});

test('renderer shows ledger hint when ledgerPresent=false', () => {
  const fx = renderFixture();
  fx.ledgerPresent = false;
  fx.nodes[0].requirements = [];
  const html = sectionPurpose({ src: { status: 'ok', detail: '' }, purposes: fx }, buildUi());
  assert.match(html, /npm run requirements/);
});

// ── v2 Part 1: coverage stratification ───────────────────────────────────

const V2_PURPOSES = [
  { id: 'audits', label: 'Deliver audits', summary: 's', kind: 'skill-chain', flowNodes: ['audit-code'] },
  { id: 'platform-foundation', label: 'Platform & tooling foundation', summary: 's', kind: 'curated', flowNodes: [] },
];
const V2_RULES = [
  { pattern: 'a/**', domain: 'da' },
  { pattern: 'lib/**', domain: 'shared-lib' },
  { pattern: 'b/**', domain: 'db' },
];
const V2_ARCH = [{ name: 'da' }, { name: 'shared-lib' }, { name: 'db' }];

test('coverage stratifies direct / platform / unmapped + catchAllPct', (t) => {
  const root = fixtureRoot(t, {
    rules: V2_RULES,
    purposes: V2_PURPOSES,
    domainPurposes: { da: ['audits'], 'shared-lib': ['platform-foundation'], db: ['platform-foundation'] },
  });
  const reqs = [
    { id: 'R1', kind: 'correctness', assertion: 'x', appliesTo: ['a/x.mjs'] },          // da → audits → direct
    { id: 'R2', kind: 'correctness', assertion: 'x', appliesTo: ['lib/y.mjs'] },        // shared-lib only → platform + catchAll
    { id: 'R3', kind: 'correctness', assertion: 'x', appliesTo: ['b/z.mjs'] },          // db → platform (NOT catchAll)
    { id: 'R4', kind: 'correctness', assertion: 'x', appliesTo: ['a/x.mjs', 'lib/y.mjs'] }, // direct wins tie
    { id: 'R5', kind: 'correctness', assertion: 'x', appliesTo: ['zzz/none.mjs'] },     // unmapped
  ];
  const out = collectPurposes(root, { architectureDomains: V2_ARCH, flows: { nodes: [{ id: 'audit-code' }] }, rules: V2_RULES, requirements: reqs, ledgerPresent: true });
  assert.deepEqual(out.coverage, { direct: 2, platform: 2, unmapped: 1, total: 5, catchAllPct: 50 });
});

test('catchAllPct is 0 (never NaN) when platform bucket is empty', (t) => {
  const root = fixtureRoot(t, { rules: V2_RULES, purposes: V2_PURPOSES, domainPurposes: { da: ['audits'] } });
  const out = collectPurposes(root, { architectureDomains: V2_ARCH, flows: null, rules: V2_RULES, requirements: [{ id: 'R1', kind: 'correctness', assertion: 'x', appliesTo: ['a/x.mjs'] }], ledgerPresent: true });
  assert.equal(out.coverage.platform, 0);
  assert.equal(out.coverage.catchAllPct, 0);
});

// ── v2 Part 2: inverse index + reverse-link rendering ────────────────────

test('domainPurposeIndex is the inverse edge, sorted', (t) => {
  const root = fixtureRoot(t, { purposes: V2_PURPOSES, domainPurposes: { da: ['audits', 'platform-foundation'], db: ['platform-foundation'] } });
  const out = collectPurposes(root, { architectureDomains: V2_ARCH, flows: null, rules: V2_RULES, requirements: [], ledgerPresent: true });
  assert.deepEqual(out.domainPurposeIndex.da, [
    { id: 'audits', label: 'Deliver audits' },
    { id: 'platform-foundation', label: 'Platform & tooling foundation' },
  ]);
  assert.deepEqual(out.domainPurposeIndex.db, [{ id: 'platform-foundation', label: 'Platform & tooling foundation' }]);
});

test('purposeTitleElementId mirrors the purpose section aria-labelledby', () => {
  assert.equal(purposeTitleElementId('audits'), 'purpose-audits-title');
});

test('architecture renders escaped serves: chips → purpose anchors; silent when none', () => {
  const ui = buildUi();
  const html = sectionArchitecture({
    src: { status: 'ok', detail: '' },
    architecture: {
      domains: [{ name: 'da', anchor: 'da', symbolCount: 5, summary: 'sum' }, { name: 'db', anchor: 'db', symbolCount: 2, summary: 'sum' }],
      deps: {}, depsSource: null, mapPath: 'm',
      domainPurposes: { da: [{ id: 'audits', label: '<b>Deliver</b> audits' }] },  // db has none
    },
  }, ui);
  assert.match(html, /class="serves-chip" data-cross-tab href="#purpose-audits-title"/);
  assert.match(html, /&lt;b&gt;Deliver&lt;\/b&gt; audits/);          // escaped
  // db has no purposes → no serves line. Exactly one serves-chip in the whole render.
  assert.equal((html.match(/class="serves-chip"/g) || []).length, 1);
  assert.equal((html.match(/class="arch-serves"/g) || []).length, 1);
});

test('purpose summary header shows stratified coverage', () => {
  const ui = buildUi();
  const html = sectionPurpose({
    src: { status: 'ok', detail: '' },
    purposes: {
      status: 'ok', detail: '', ledgerPresent: true,
      coverage: { direct: 31, platform: 84, unmapped: 0, total: 115, catchAllPct: 100 },
      nodes: [{ id: 'p', label: 'P', kind: 'curated', summary: 's', flowNodes: [], domains: [], requirements: [] }],
      hygiene: { unmappedDomains: [], unattachedRequirements: [], skippedRequirements: 0, unknownDomains: [], domainsMissingArchitecture: [] },
    },
  }, ui);
  assert.match(html, /31<\/strong> direct · <strong>84<\/strong> platform · <strong>0<\/strong> unmapped \(of 115\)/);
  assert.match(html, /substrate sweep/);
  assert.match(html, /Telemetry → Purpose Health/);
});

// ── v3 Part B: outcome×domain matrix ─────────────────────────────────────

test('matrix renders a real grid: th scope col/row, ✓ + visually-hidden, focusable scroll', () => {
  const ui = buildUi();
  const html = sectionPurpose({
    src: { status: 'ok', detail: '' },
    purposes: {
      status: 'ok', detail: '', ledgerPresent: true,
      coverage: { direct: 1, platform: 0, unmapped: 0, total: 1, catchAllPct: 0 },
      nodes: [
        { id: 'a', label: 'Alpha', kind: 'curated', summary: 's', flowNodes: [], domains: [{ id: 'd1', anchor: null, alsoServes: 0 }], requirements: [] },
        { id: 'b', label: 'Beta', kind: 'curated', summary: 's', flowNodes: [], domains: [{ id: 'd2', anchor: null, alsoServes: 0 }], requirements: [] },
      ],
      hygiene: { unmappedDomains: [], unattachedRequirements: [], skippedRequirements: 0, unknownDomains: [], domainsMissingArchitecture: [] },
    },
  }, ui);
  assert.match(html, /class="purpose-matrix"/);
  assert.match(html, /role="group" aria-labelledby="purpose-matrix-title" tabindex="0"/);
  assert.match(html, /<th scope="col">d1<\/th>/);
  assert.match(html, /<th scope="row">Alpha<\/th>/);
  // Alpha delivers d1 (✓ + SR text), not d2 (empty cell)
  assert.match(html, /<td class="cell-on">✓<span class="visually-hidden"> delivers<\/span><\/td>/);
  // exactly 2 ✓ cells (Alpha→d1, Beta→d2) across a 2×2 domain grid
  assert.equal((html.match(/class="cell-on"/g) || []).length, 2);
});

test('matrix escapes domain ids and purpose labels', () => {
  const ui = buildUi();
  const html = sectionPurpose({
    src: { status: 'ok', detail: '' },
    purposes: {
      status: 'ok', detail: '', ledgerPresent: true,
      nodes: [{ id: 'x', label: '<b>P</b>', kind: 'curated', summary: 's', flowNodes: [], domains: [{ id: 'd"<x', anchor: null, alsoServes: 0 }], requirements: [] }],
      hygiene: { unmappedDomains: [], unattachedRequirements: [], skippedRequirements: 0, unknownDomains: [], domainsMissingArchitecture: [] },
    },
  }, ui);
  assert.doesNotMatch(html, /<th scope="row"><b>P<\/b>/);
  assert.match(html, /&lt;b&gt;P&lt;\/b&gt;/);
});
