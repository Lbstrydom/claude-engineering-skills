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
