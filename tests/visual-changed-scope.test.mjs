/**
 * @fileoverview Tier-1 tests for the canonical gate-eligibility resolver
 * (GPT-R2-H4 unify + Gemini-G2-2 global blast radius).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChangedScope, globMatch } from '../scripts/lib/visual/changed-scope.mjs';

const surfaces = [
  { id: 'pricing', sourceGlobs: ['src/pricing/**'] },
  { id: 'home', sourceGlobs: ['src/home/**'] },
];
const finding = (surfaceId, property = 'color') => ({ surfaceId, property, class: 'token_violation' });

test('null changedPaths → empty (never false-block)', () => {
  assert.deepEqual(resolveChangedScope({ changedPaths: null, surfaces, findings: [finding('pricing')] }), []);
});

test('allSurfaces (--scope full) gates the WHOLE surface — non-empty findings → non-empty blockers', () => {
  // The silent-green bug: null was overloaded for both "no merge-base" and "audit all".
  const out = resolveChangedScope({ allSurfaces: true, changedPaths: null, surfaces, findings: [finding('pricing'), finding('home')] });
  assert.equal(out.length, 2, '--scope full must gate every finding on a contracted surface');
  // a finding on an UNKNOWN surface is still excluded (defensive)
  const unknown = resolveChangedScope({ allSurfaces: true, changedPaths: null, surfaces, findings: [finding('ghost')] });
  assert.deepEqual(unknown, []);
  // null WITHOUT allSurfaces stays a no-op (genuine no-merge-base case)
  assert.deepEqual(resolveChangedScope({ allSurfaces: false, changedPaths: null, surfaces, findings: [finding('pricing')] }), []);
});

test('rule (a): surface sourceGlob ∩ changed → eligible', () => {
  const out = resolveChangedScope({ changedPaths: ['src/pricing/Card.tsx'], surfaces, findings: [finding('pricing'), finding('home')] });
  assert.equal(out.length, 1);
  assert.equal(out[0].surfaceId, 'pricing');
});

test('rule (d): a global-style edit makes ALL surfaces eligible (G2-2)', () => {
  const out = resolveChangedScope({
    changedPaths: ['src/styles/global.css'],
    globalStyleGlobs: ['src/styles/**'],
    surfaces,
    findings: [finding('pricing'), finding('home')],
  });
  assert.equal(out.length, 2, 'global CSS cascades into every surface');
});

test('rule (c): a changed token family makes its findings eligible', () => {
  const out = resolveChangedScope({
    changedPaths: ['tailwind.config.js'],
    changedTokenFamilies: ['colors'],
    surfaces,
    findings: [finding('pricing', 'color'), finding('home', 'padding-top')],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].property, 'color');
});

test('rule (b): a contract change makes findings on known surfaces eligible', () => {
  const out = resolveChangedScope({ changedPaths: ['unrelated.md'], contractChanged: true, surfaces, findings: [finding('pricing')] });
  assert.equal(out.length, 1);
});

test('an unrelated change blocks nothing', () => {
  assert.deepEqual(resolveChangedScope({ changedPaths: ['README.md'], surfaces, findings: [finding('pricing')] }), []);
});

test('globMatch handles ** and *', () => {
  assert.ok(globMatch('src/**', 'src/a/b/c.ts'));
  assert.ok(globMatch('src/*.css', 'src/x.css'));
  assert.ok(!globMatch('src/*.css', 'src/a/x.css'));
  assert.ok(globMatch('src/**/*.css', 'src/a/x.css'));
});

test('item 1: rule (d) does NOT gate an unattributed finding (no surfaceId) — matches the allSurfaces branch\'s own attribution check', () => {
  const out = resolveChangedScope({
    changedPaths: ['src/styles/global.css'],
    globalStyleGlobs: ['src/styles/**'],
    surfaces,
    findings: [{ surfaceId: null, property: 'color', class: 'token_violation' }],
  });
  assert.deepEqual(out, [], 'a finding with no surface attribution has no surface for the global edit to have cascaded into');
});

test('item 1: rule (d) does NOT gate a finding whose surfaceId is unknown to the contract', () => {
  const out = resolveChangedScope({
    changedPaths: ['src/styles/global.css'],
    globalStyleGlobs: ['src/styles/**'],
    surfaces,
    findings: [finding('ghost-surface')],
  });
  assert.deepEqual(out, []);
});

test('item 1: rule (d) still gates a genuinely-attributed finding (regression guard for the fix above)', () => {
  const out = resolveChangedScope({
    changedPaths: ['src/styles/global.css'],
    globalStyleGlobs: ['src/styles/**'],
    surfaces,
    findings: [finding('pricing')],
  });
  assert.equal(out.length, 1);
});

test('item 2: familyOfFinding matches camelCase family names passed directly (inferred-outlier findings), not just kebab-case CSS properties', () => {
  const out = resolveChangedScope({
    changedPaths: ['tailwind.config.js'],
    changedTokenFamilies: ['fontSize'],
    surfaces,
    findings: [finding('pricing', 'fontSize'), finding('home', 'lineHeight')],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].property, 'fontSize');
});

test('item 2: lineHeight/fontWeight/borderWidth all match correctly (the exact camelCase family set that broke under lowercasing)', () => {
  for (const family of ['borderWidth', 'fontSize', 'lineHeight', 'fontWeight']) {
    const out = resolveChangedScope({
      changedPaths: ['tailwind.config.js'],
      changedTokenFamilies: [family],
      surfaces,
      findings: [finding('pricing', family)],
    });
    assert.equal(out.length, 1, `expected ${family} to match its own family`);
  }
});

test('item 3: contractChanged as a surface-id array gates only the named surfaces, not every attributed finding', () => {
  const out = resolveChangedScope({
    changedPaths: ['unrelated.md'],
    contractChanged: ['pricing'],
    surfaces,
    findings: [finding('pricing'), finding('home')],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].surfaceId, 'pricing');
});

test('item 3: contractChanged as a Set works identically to an array', () => {
  const out = resolveChangedScope({
    changedPaths: ['unrelated.md'],
    contractChanged: new Set(['home']),
    surfaces,
    findings: [finding('pricing'), finding('home')],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].surfaceId, 'home');
});

test('item 3: contractChanged===true still gates every attributed surface (back-compat, regression guard)', () => {
  const out = resolveChangedScope({
    changedPaths: ['unrelated.md'],
    contractChanged: true,
    surfaces,
    findings: [finding('pricing'), finding('home')],
  });
  assert.equal(out.length, 2);
});

test('item 3: contractChanged===false (default) gates nothing via rule (b)', () => {
  const out = resolveChangedScope({
    changedPaths: ['unrelated.md'],
    surfaces,
    findings: [finding('pricing'), finding('home')],
  });
  assert.deepEqual(out, []);
});
