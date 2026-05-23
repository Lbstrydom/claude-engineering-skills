/**
 * @fileoverview Tests for resolveAndClassify in scripts/lib/sensitive-paths.mjs.
 * Symlink fixtures via mkdtemp + fs.symlinkSync; POSIX-only (Windows
 * symlink creation needs admin or developer mode — skipped on win32 per
 * the project's existing pattern).
 *
 * Plan: docs/plans/liveness-and-canonical-paths.md WS-CANON.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAndClassify, classifyPath } from '../scripts/lib/sensitive-paths.mjs';

const skipOnWin = process.platform === 'win32';

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-classify-'));
}

describe('resolveAndClassify — input validation', () => {
  it('throws when opts.repoRoot is missing', () => {
    assert.throws(() => resolveAndClassify('foo.ts'), /opts\.repoRoot is required/);
    assert.throws(() => resolveAndClassify('foo.ts', {}), /opts\.repoRoot is required/);
    assert.throws(() => resolveAndClassify('foo.ts', { repoRoot: 123 }), /opts\.repoRoot is required/);
  });
});

describe('resolveAndClassify — lexical fast-path', () => {
  it('returns sensitive immediately for lexically-sensitive paths (no FS touch)', () => {
    // .env is a lexical match — even an "fs.realpathSync would throw"
    // input is short-circuited because the lexical check fires first.
    const r = resolveAndClassify('.env', {
      repoRoot: '/anywhere-doesnt-matter',
      fs: { realpathSync: () => { throw new Error('SHOULD NOT BE CALLED'); } },
    });
    assert.equal(r.category, 'sensitive');
    assert.equal(r.lexical, 'sensitive');
    assert.equal(r.canonical, null);
    assert.equal(r.escapedRepo, false);
    assert.equal(r.resolutionFailed, false);
  });

  it('preserves the lexical fast-path even when the lexical pattern would match more deeply', () => {
    const r = resolveAndClassify('config/secrets/db.yaml', {
      repoRoot: '/anywhere-doesnt-matter',
      fs: { realpathSync: () => { throw new Error('SHOULD NOT BE CALLED'); } },
    });
    assert.equal(r.category, 'sensitive');
    assert.equal(r.lexical, 'sensitive');
  });
});

describe('resolveAndClassify — fail-closed on resolution errors', () => {
  it('returns sensitive + resolutionFailed when realpath throws ENOENT', () => {
    const repoRoot = mkdtemp();
    try {
      const r = resolveAndClassify('does-not-exist.ts', { repoRoot });
      assert.equal(r.category, 'sensitive');
      assert.equal(r.resolutionFailed, true);
      assert.equal(r.canonical, null);
      assert.equal(r.escapedRepo, false);
      // The lexical check ran and returned null — only the canonical step failed.
      assert.equal(r.lexical, null);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
  });

  it('returns sensitive + resolutionFailed for a broken symlink', () => {
    if (skipOnWin) return;
    const repoRoot = mkdtemp();
    try {
      const target = path.join(repoRoot, 'will-be-deleted.ts');
      fs.writeFileSync(target, '');
      fs.symlinkSync(target, path.join(repoRoot, 'innocent.ts'));
      fs.unlinkSync(target);  // target gone → symlink dangling
      const r = resolveAndClassify('innocent.ts', { repoRoot });
      assert.equal(r.category, 'sensitive');
      assert.equal(r.resolutionFailed, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
  });
});

describe('resolveAndClassify — symlink escape detection (WS-CANON)', () => {
  it('flags escapedRepo when the canonical path resolves outside repoRoot', () => {
    if (skipOnWin) return;
    const repoRoot = mkdtemp();
    const outside = mkdtemp();
    try {
      const target = path.join(outside, 'secret-target.txt');
      fs.writeFileSync(target, 'pretend-secret');
      fs.symlinkSync(target, path.join(repoRoot, 'notes.txt'));
      const r = resolveAndClassify('notes.txt', { repoRoot });
      assert.equal(r.category, 'sensitive', 'escape must classify as sensitive');
      assert.equal(r.escapedRepo, true);
      assert.equal(r.resolutionFailed, false);
      // canonical reported (the path the symlink resolved to).
      assert.ok(r.canonical && r.canonical.includes('secret-target'));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(outside,  { recursive: true, force: true });
    }
  });

  it('does NOT flag escape for a symlink that stays inside repoRoot', () => {
    if (skipOnWin) return;
    const repoRoot = mkdtemp();
    try {
      const target = path.join(repoRoot, 'src/real.ts');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '');
      fs.symlinkSync(target, path.join(repoRoot, 'link.ts'));
      const r = resolveAndClassify('link.ts', { repoRoot });
      assert.equal(r.escapedRepo, false);
      assert.equal(r.resolutionFailed, false);
      assert.equal(r.category, null);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
  });
});

describe('resolveAndClassify — canonical re-classification', () => {
  it('classifies canonical target as sensitive even when lexical name is innocent', () => {
    if (skipOnWin) return;
    // Repo contains an "innocent.ts" symlink that resolves into `secrets/`
    // INSIDE the repo. Lexical sees "innocent.ts" → null; canonical sees
    // `secrets/db.yaml` → sensitive. Classifier MUST flag it.
    const repoRoot = mkdtemp();
    try {
      const secretsDir = path.join(repoRoot, 'secrets');
      fs.mkdirSync(secretsDir);
      const realTarget = path.join(secretsDir, 'db.yaml');
      fs.writeFileSync(realTarget, '');
      fs.symlinkSync(realTarget, path.join(repoRoot, 'innocent.ts'));
      const r = resolveAndClassify('innocent.ts', { repoRoot });
      assert.equal(r.category, 'sensitive', 'canonical target inside secrets/ must classify sensitive');
      assert.equal(r.lexical, null, 'lexical name was innocent');
      assert.equal(r.escapedRepo, false);
      assert.equal(r.resolutionFailed, false);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
  });

  it('returns null category for an ordinary innocent file', () => {
    const repoRoot = mkdtemp();
    try {
      fs.writeFileSync(path.join(repoRoot, 'innocent.ts'), '');
      const r = resolveAndClassify('innocent.ts', { repoRoot });
      assert.equal(r.category, null);
      assert.equal(r.lexical, null);
      assert.equal(r.escapedRepo, false);
      assert.equal(r.resolutionFailed, false);
      assert.ok(r.canonical && r.canonical.endsWith('innocent.ts'));
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
  });
});

describe('resolveAndClassify — fs injection (drives all paths without real symlinks)', () => {
  it('uses opts.fs.realpathSync when provided', () => {
    let called = false;
    const r = resolveAndClassify('foo.ts', {
      repoRoot: '/anywhere',
      fs: {
        realpathSync: (p) => {
          called = true;
          // Resolve into a sensitive location to drive the canonical path.
          return '/anywhere/secrets/db.yaml';
        },
      },
    });
    assert.equal(called, true);
    assert.equal(r.category, 'sensitive');
    assert.equal(r.canonical, '/anywhere/secrets/db.yaml');
  });
});

// Sanity: ensure classifyPath (unchanged) still returns the same values.
describe('classifyPath regression-lock', () => {
  it('returns sensitive for .env, null for an innocent .ts', () => {
    assert.equal(classifyPath('.env'), 'sensitive');
    assert.equal(classifyPath('src/index.ts'), null);
  });
});
