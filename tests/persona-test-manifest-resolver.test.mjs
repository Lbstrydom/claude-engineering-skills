/**
 * @fileoverview Phase 1 manifest-resolver tests.
 *
 * Resolver behaviour:
 *   - Priority order: .persona-test/ > <root>/ > src/
 *   - Returns null when no candidate present (bootstrap case)
 *   - Refuses symlink-traversal outside repo root
 *   - Throws on malformed JSON or Zod failure (don't silently fall through)
 *   - Honours injected resolver arrays (no global mutation per Gemini-R3-M2)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveManifest, DEFAULT_RESOLVERS } from '../scripts/lib/persona-test/manifest-resolver.mjs';

const VALID_MANIFEST = {
  version: 1,
  surfaces: [{
    id: 'status-chip',
    locator: { kind: 'role', role: 'status' },
    severityFloor: 'P0',
    engineFields: [{
      field: 'cellarOrganised',
      type: 'boolean',
    }],
  }],
};

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-resolver-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('DEFAULT_RESOLVERS', () => {
  it('is frozen and length 3 (the 3 documented priorities)', () => {
    assert.ok(Object.isFrozen(DEFAULT_RESOLVERS));
    assert.equal(DEFAULT_RESOLVERS.length, 3);
  });
});

describe('resolveManifest — priority order', () => {
  it('returns null when no candidate present', () => {
    const r = resolveManifest(tmpDir);
    assert.equal(r, null);
  });

  it('finds .persona-test/surfaces.json first', () => {
    fs.mkdirSync(path.join(tmpDir, '.persona-test'));
    const p = path.join(tmpDir, '.persona-test', 'surfaces.json');
    fs.writeFileSync(p, JSON.stringify(VALID_MANIFEST));
    const r = resolveManifest(tmpDir);
    assert.ok(r);
    assert.equal(r.path, p);
    assert.equal(r.manifest.surfaces.length, 1);
  });

  it('falls back to <root>/persona-test-manifest.json', () => {
    const p = path.join(tmpDir, 'persona-test-manifest.json');
    fs.writeFileSync(p, JSON.stringify(VALID_MANIFEST));
    const r = resolveManifest(tmpDir);
    assert.ok(r);
    assert.equal(r.path, p);
  });

  it('falls back to <root>/src/persona-test-surfaces.json', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    const p = path.join(tmpDir, 'src', 'persona-test-surfaces.json');
    fs.writeFileSync(p, JSON.stringify(VALID_MANIFEST));
    const r = resolveManifest(tmpDir);
    assert.ok(r);
    assert.equal(r.path, p);
  });

  it('prefers .persona-test/ over <root>/ when both exist', () => {
    fs.mkdirSync(path.join(tmpDir, '.persona-test'));
    fs.writeFileSync(path.join(tmpDir, '.persona-test', 'surfaces.json'), JSON.stringify(VALID_MANIFEST));
    fs.writeFileSync(path.join(tmpDir, 'persona-test-manifest.json'), JSON.stringify(VALID_MANIFEST));
    const r = resolveManifest(tmpDir);
    assert.ok(r);
    assert.match(r.path, /\.persona-test/);
  });
});

describe('resolveManifest — error handling', () => {
  it('throws on malformed JSON', () => {
    fs.mkdirSync(path.join(tmpDir, '.persona-test'));
    fs.writeFileSync(path.join(tmpDir, '.persona-test', 'surfaces.json'), '{not: valid}');
    assert.throws(() => resolveManifest(tmpDir), /invalid JSON/i);
  });

  it('throws on schema validation failure', () => {
    fs.mkdirSync(path.join(tmpDir, '.persona-test'));
    fs.writeFileSync(
      path.join(tmpDir, '.persona-test', 'surfaces.json'),
      JSON.stringify({ version: 2, surfaces: [] }),
    );
    assert.throws(() => resolveManifest(tmpDir), /schema validation failed/i);
  });

  it('throws on missing repoRoot', () => {
    assert.throws(() => resolveManifest(''), /repoRoot must be a non-empty string/);
    assert.throws(() => resolveManifest(null), /repoRoot must be a non-empty string/);
  });

  it('throws when resolvers array is empty', () => {
    assert.throws(() => resolveManifest(tmpDir, []), /resolvers must be a non-empty array/);
  });

  it('throws when repoRoot does not exist', () => {
    assert.throws(() => resolveManifest(path.join(tmpDir, 'does-not-exist')), /repoRoot does not exist/);
  });
});

describe('resolveManifest — custom resolver injection (Gemini-R3-M2)', () => {
  it('uses caller-supplied resolver list and skips defaults', () => {
    // Place a manifest where DEFAULT_RESOLVERS would NOT look.
    const customPath = path.join(tmpDir, 'custom', 'my-manifest.json');
    fs.mkdirSync(path.dirname(customPath));
    fs.writeFileSync(customPath, JSON.stringify(VALID_MANIFEST));
    const r = resolveManifest(tmpDir, [(root) => path.join(root, 'custom', 'my-manifest.json')]);
    assert.ok(r);
    assert.equal(r.path, customPath);
  });

  it('skips non-function entries in the resolver array', () => {
    fs.mkdirSync(path.join(tmpDir, '.persona-test'));
    const p = path.join(tmpDir, '.persona-test', 'surfaces.json');
    fs.writeFileSync(p, JSON.stringify(VALID_MANIFEST));
    const r = resolveManifest(tmpDir, [null, undefined, (root) => path.join(root, '.persona-test', 'surfaces.json')]);
    assert.ok(r);
    assert.equal(r.path, p);
  });
});
