/**
 * @fileoverview The `[Architecture]` category namespace is reserved for the
 * MECHANICAL architecture pass.
 *
 * Origin (2026-07-20): the general LLM passes do not receive the domain map
 * (`allowedDeps`), yet were emitting `[Architecture] Boundary Erosion` /
 * `Layer Boundary Violation` / … — 15 invented labels for one concept, each
 * fingerprinting differently, driving the memory-health cluster-density
 * trigger. The concrete case (`brainstorm → requirements`) is an edge the
 * domain map EXPLICITLY ALLOWS. `normalizeArchCategory` is the mechanical
 * backstop; the prompt is the primary fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizeArchCategory,
  MECHANICAL_ARCH_CATEGORIES,
  COUPLING_CONCERN_CATEGORY,
  findingFingerprint,
} from '../scripts/lib/audit/findings-pipeline.mjs';

test('an invented [Architecture] category is demoted to Coupling concern', () => {
  for (const invented of [
    '[Architecture] Boundary Erosion',
    '[Architecture] Layer Boundary Violation',
    '[Architecture] Cross-Domain Context Coupling',
    '[Architecture] Persistence Boundary Violation',
  ]) {
    const out = normalizeArchCategory({ category: invented, detail: 'x' });
    assert.equal(out.category, COUPLING_CONCERN_CATEGORY, invented);
    assert.equal(out.detail, 'x', 'only the category is touched');
  }
});

test('the mechanical pass categories pass through untouched', () => {
  for (const cat of MECHANICAL_ARCH_CATEGORIES) {
    const f = { category: cat, detail: 'd' };
    assert.equal(normalizeArchCategory(f), f, `${cat} must be the same reference`);
  }
});

test('non-architecture categories are never touched', () => {
  for (const cat of ['DRY Violation', 'Coupling concern', 'Missing Error Handling', '[Security] XSS']) {
    const f = { category: cat };
    assert.equal(normalizeArchCategory(f), f);
  }
});

test('missing / non-string category is a no-op, not a throw', () => {
  const a = { detail: 'no category' };
  assert.equal(normalizeArchCategory(a), a);
  const b = { category: 123 };
  assert.equal(normalizeArchCategory(b), b);
  assert.doesNotThrow(() => normalizeArchCategory(null));
});

test('after demotion, two invented labels for one issue collide on fingerprint', () => {
  // The whole point: identity is category|section|detail. Two passes naming the
  // SAME coupling with DIFFERENT invented arch categories must dedup once the
  // category is normalised. (Detail must match — normalisation fixes the
  // category axis, not prose drift, which is what trigram cluster-density is
  // for.)
  const base = { section: 'scripts/lib/brainstorm/policy-context.mjs', detail: 'couples brainstorm to requirements context' };
  const a = normalizeArchCategory({ ...base, category: '[Architecture] Boundary Erosion' });
  const b = normalizeArchCategory({ ...base, category: '[Architecture] Layer Boundary Violation' });
  assert.equal(findingFingerprint(a), findingFingerprint(b));
});

test('DRIFT GUARD: the mechanical detector emits exactly MECHANICAL_ARCH_CATEGORIES', () => {
  // Single source of truth: if someone adds a 5th `[Architecture]` category to
  // the mechanical pass without adding it to the shared set, this pins the
  // regression — the new mechanical finding would otherwise be wrongly demoted
  // to `Coupling concern` by the backstop.
  const src = fs.readFileSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
      '..', 'scripts/lib/audit/legacy-production-audit.mjs'),
    'utf-8',
  );
  const found = new Set(
    [...src.matchAll(/category:\s*'(\[Architecture\][^']*)'/g)].map((m) => m[1]),
  );
  assert.deepEqual(
    [...found].sort(),
    [...MECHANICAL_ARCH_CATEGORIES].sort(),
    'the mechanical pass\'s [Architecture] category literals must match the shared set exactly',
  );
});
