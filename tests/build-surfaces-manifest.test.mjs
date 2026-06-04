/**
 * Unit tests for scripts/build-surfaces-manifest.mjs — the merge +
 * collision-detection + render logic. Pure functions, no filesystem.
 *
 * The consumer-side contract test (in each consumer repo) covers the happy
 * path against real fragments on disk; this suite covers the collision
 * branches with synthetic fragments so we don't ship deliberately-broken JSON.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  mergeFragments,
  canonicalLocator,
  renderManifest,
} from '../scripts/build-surfaces-manifest.mjs';

// Regression guard (root cause of a wine-cellar vitest failure, 2026-06): this
// builder is import-intended (consumer contract tests `import()` it), but a
// `#!/usr/bin/env node` shebang throws "Invalid or unexpected token" under
// bundler test-runners (vitest 4) that don't strip it like node does. It's
// always invoked as `node <path>`, so the shebang is vestigial + harmful — keep
// it gone.
describe('build-surfaces-manifest.mjs — import portability', () => {
  it('has NO shebang (it is imported by consumer vitest contract tests)', () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL('../scripts/build-surfaces-manifest.mjs', import.meta.url)), 'utf-8');
    assert.ok(!src.startsWith('#!'),
      'build-surfaces-manifest.mjs must not start with a shebang — it breaks `import()` under vitest/esbuild module runners');
  });
});

function syntheticSurface(id, locator, field = 'stateV2') {
  return {
    id,
    locator,
    severityFloor: 'P1',
    engineFields: [
      {
        field,
        type: 'enum',
        semanticValues: ['organised', 'major'],
        networkSource: { urlPattern: '/api/cellar/status', method: 'GET', jsonPath: field },
      },
    ],
  };
}

describe('canonicalLocator — string form for collision detection', () => {
  it('id locator → "id:<id>"', () => {
    assert.equal(canonicalLocator({ kind: 'id', id: 'foo' }), 'id:foo');
  });
  it('css locator → "css:<selector>"', () => {
    assert.equal(canonicalLocator({ kind: 'css', selector: '.x' }), 'css:.x');
  });
  it('null / non-object → "<invalid>"', () => {
    assert.equal(canonicalLocator(null), '<invalid>');
    assert.equal(canonicalLocator(undefined), '<invalid>');
  });
});

describe('mergeFragments — happy path', () => {
  it('merges surfaces from multiple fragments + sorts by id', () => {
    const fragments = [
      { path: '/repo/public/js/b.persona-test.json', surfaces: [syntheticSurface('b-surface', { kind: 'id', id: 'b' })], collections: [] },
      { path: '/repo/public/js/a.persona-test.json', surfaces: [syntheticSurface('a-surface', { kind: 'id', id: 'a' })], collections: [] },
    ];
    const { manifest, errors } = mergeFragments(fragments);
    assert.deepEqual(errors, []);
    assert.deepEqual(manifest.surfaces.map((s) => s.id), ['a-surface', 'b-surface']);
  });

  it('preserves and sorts collections', () => {
    const fragments = [
      {
        path: '/repo/x.persona-test.json',
        surfaces: [syntheticSurface('s', { kind: 'id', id: 's' })],
        collections: [
          { id: 'zeta', urlPattern: '/z', jsonPath: 'z', keyField: 'k' },
          { id: 'alpha', urlPattern: '/a', jsonPath: 'a', keyField: 'k' },
        ],
      },
    ];
    const { manifest } = mergeFragments(fragments);
    assert.deepEqual(manifest.collections.map((c) => c.id), ['alpha', 'zeta']);
  });
});

describe('mergeFragments — collision detection (audit-r3/M2)', () => {
  it('flags duplicate surface ids across fragments', () => {
    const fragments = [
      { path: '/repo/public/js/a.persona-test.json', surfaces: [syntheticSurface('dup', { kind: 'id', id: 'a' })], collections: [] },
      { path: '/repo/public/js/b.persona-test.json', surfaces: [syntheticSurface('dup', { kind: 'id', id: 'b' })], collections: [] },
    ];
    const { errors } = mergeFragments(fragments);
    assert.ok(errors.some((e) => e.includes('"dup"')));
    const merged = errors.join('\n');
    assert.ok(merged.includes('public/js/a.persona-test.json'));
    assert.ok(merged.includes('public/js/b.persona-test.json'));
  });

  it('flags duplicate (locator, field) tuples across fragments', () => {
    const fragments = [
      { path: '/repo/public/js/chip-a.persona-test.json', surfaces: [syntheticSurface('chip-a', { kind: 'id', id: 'cellar-status-badge' }, 'stateV2')], collections: [] },
      { path: '/repo/public/js/chip-b.persona-test.json', surfaces: [syntheticSurface('chip-b', { kind: 'id', id: 'cellar-status-badge' }, 'stateV2')], collections: [] },
    ];
    const { errors } = mergeFragments(fragments);
    const merged = errors.join('\n');
    assert.ok(merged.includes('id:cellar-status-badge'));
    assert.ok(merged.includes('stateV2'));
    assert.ok(merged.includes('chip-a.persona-test.json'));
    assert.ok(merged.includes('chip-b.persona-test.json'));
  });

  it('allows two surfaces to share a locator IF they claim different engine fields', () => {
    const fragments = [
      { path: '/repo/a.persona-test.json', surfaces: [syntheticSurface('mod-a', { kind: 'id', id: 'modal' }, 'resultKind')], collections: [] },
      { path: '/repo/b.persona-test.json', surfaces: [syntheticSurface('mod-b', { kind: 'id', id: 'modal' }, 'state')], collections: [] },
    ];
    const { errors } = mergeFragments(fragments);
    assert.deepEqual(errors, []);
  });

  it('flags duplicate collection ids across fragments', () => {
    const fragments = [
      { path: '/repo/a.persona-test.json', surfaces: [], collections: [{ id: 'zones', urlPattern: '/a', jsonPath: 'a', keyField: 'k' }] },
      { path: '/repo/b.persona-test.json', surfaces: [], collections: [{ id: 'zones', urlPattern: '/b', jsonPath: 'b', keyField: 'k' }] },
    ];
    const { errors } = mergeFragments(fragments);
    assert.ok(errors.some((e) => e.includes('"zones"')));
  });

  it('flags missing/empty surface id', () => {
    const fragments = [
      { path: '/repo/bad.persona-test.json', surfaces: [{ locator: { kind: 'id', id: 'x' }, severityFloor: 'P1', engineFields: [] }], collections: [] },
    ];
    const { errors } = mergeFragments(fragments);
    assert.ok(errors.some((e) => e.includes('bad.persona-test.json')));
  });
});

describe('renderManifest — deterministic output', () => {
  const base = [{ path: '/repo/a.persona-test.json', surfaces: [syntheticSurface('s', { kind: 'id', id: 'x' })], collections: [] }];

  it('produces stable JSON (same input → same string)', () => {
    const { manifest } = mergeFragments(base);
    assert.equal(renderManifest(manifest), renderManifest(manifest));
  });

  it('ends with a single trailing newline', () => {
    const { manifest } = mergeFragments(base);
    const out = renderManifest(manifest);
    assert.ok(out.endsWith('\n'));
    assert.ok(!out.endsWith('\n\n'));
  });

  it('uses 2-space indent (matches the committed surfaces.json formatting)', () => {
    const { manifest } = mergeFragments(base);
    assert.ok(renderManifest(manifest).includes('\n  "version": 1'));
  });
});
