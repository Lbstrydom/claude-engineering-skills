/**
 * Tests for scripts/lib/module-graph.mjs
 * Plan: docs/plans/adaptive-context-blast-radius.md — Phase 1 (audit M1).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpecifier } from '../scripts/lib/module-graph.mjs';

const REPO = new Set([
  'scripts/foo.mjs',
  'scripts/lib/schemas.mjs',
  'scripts/lib/audit/prompt-builder.mjs',
  'scripts/lib/dir/index.mjs',
]);

describe('resolveSpecifier', () => {
  it('resolves a relative specifier with extension probing', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: './lib/schemas.mjs', repoFiles: REPO });
    assert.equal(r.kind, 'repo');
    assert.equal(r.resolved, 'scripts/lib/schemas.mjs');
  });

  it('resolves an extensionless relative specifier', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: './lib/schemas', repoFiles: REPO });
    assert.equal(r.kind, 'repo');
    assert.equal(r.resolved, 'scripts/lib/schemas.mjs');
  });

  it('resolves a directory specifier to index.mjs', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: './lib/dir', repoFiles: REPO });
    assert.equal(r.kind, 'repo');
    assert.equal(r.resolved, 'scripts/lib/dir/index.mjs');
  });

  it('resolves ../ correctly', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/lib/audit/prompt-builder.mjs', specifier: '../schemas.mjs', repoFiles: REPO });
    assert.equal(r.resolved, 'scripts/lib/schemas.mjs');
  });

  it('classifies a bare specifier as external (not a repo-existence question)', () => {
    assert.equal(resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: 'zod', repoFiles: REPO }).kind, 'external');
    assert.equal(resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: 'node:fs', repoFiles: REPO }).kind, 'external');
  });

  it('returns unresolvable when the importer is unknown', () => {
    const r = resolveSpecifier({ fromFile: null, specifier: './schemas.mjs', repoFiles: REPO });
    assert.equal(r.kind, 'unresolvable');
  });

  it('returns unresolvable for a genuinely-absent relative target', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: './nope.mjs', repoFiles: REPO });
    assert.equal(r.kind, 'unresolvable');
    assert.equal(r.resolved, null);
  });

  it('does not escape the repo root via ..', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: '../../etc/passwd', repoFiles: REPO });
    assert.equal(r.kind, 'unresolvable');
  });

  it('a leading-slash specifier is absolute, not a repo-root alias (audit M11)', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: '/scripts/lib/schemas.mjs', repoFiles: REPO });
    assert.equal(r.kind, 'unresolvable');
  });

  it('exact mode does NOT extension-probe — ESM rejects extensionless imports (audit H2)', () => {
    const probed = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: './lib/schemas', repoFiles: REPO });
    assert.equal(probed.kind, 'repo', 'default mode probes');
    const exact = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: './lib/schemas', repoFiles: REPO, exact: true });
    assert.equal(exact.kind, 'unresolvable', 'exact mode requires the extension');
  });
});
