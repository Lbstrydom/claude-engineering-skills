/**
 * @fileoverview The doctor is itself synced tooling and must obey the rules
 * it checks (AGENTS.md, consumer-friction-doctor plan trap table). Runs the
 * SAME registry/context modules under BOTH candidate layouts — source
 * `scripts/` and the isolated `scripts/.claude-skills/` — never `existsSync`
 * on either candidate to decide which one it's in.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Copy `scripts/lib/doctor/context.mjs` (and its one dependency,
 * `scripts/lib/assert-repo-root.mjs`) into a fixture tree under the given
 * layout, then import it FROM THAT LOCATION and assert `bundleRoot` resolves
 * to the fixture root — proving `findRepoRootFromScript` derives the root
 * from where THIS COPY of the code lives, never a hardcoded source-repo path.
 */
async function bundleRootUnderLayout(layoutDir) {
  fs.mkdirSync(path.join(layoutDir, 'lib', 'doctor'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'lib', 'assert-repo-root.mjs'),
    path.join(layoutDir, 'lib', 'assert-repo-root.mjs'),
  );
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'lib', 'doctor', 'context.mjs'),
    path.join(layoutDir, 'lib', 'doctor', 'context.mjs'),
  );
  const url = pathToFileURL(path.join(layoutDir, 'lib', 'doctor', 'context.mjs')).href;
  // Cache-bust: two fixtures in the same test run must not resolve to Node's
  // memoised copy of a same-content-but-different-path module — they will
  // naturally differ by path, but the query string keeps this robust even if
  // a future refactor changes that.
  const mod = await import(`${url}?t=${Date.now()}-${Math.random()}`);
  const ctx = mod.buildDoctorContext(['node', 'context.mjs']);
  return ctx.bundleRoot;
}

describe('doctor layout derivation — never existsSync a candidate dir', () => {
  it('resolves bundleRoot correctly from the SOURCE layout (scripts/lib/doctor/)', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-layout-source-'));
    try {
      const scriptsDir = path.join(fixture, 'scripts');
      const root = await bundleRootUnderLayout(scriptsDir);
      assert.equal(fs.realpathSync(root), fs.realpathSync(fixture));
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('resolves bundleRoot correctly from the ISOLATED layout (scripts/.claude-skills/lib/doctor/)', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-layout-isolated-'));
    try {
      // findRepoRootFromScript walks up to the nearest `scripts` ANCESTOR
      // directory and returns its parent — under the isolated layout that
      // ancestor is `scripts/.claude-skills/`'s OWN `scripts` segment, i.e.
      // `.claude-skills` is not itself named `scripts`. The real consumer
      // layout is `<repo>/scripts/.claude-skills/lib/doctor/context.mjs`, so
      // the nearest `scripts`-named ancestor is `<repo>/scripts/`, and
      // bundleRoot resolves to `<repo>` — the SAME answer as the source
      // layout, which is the whole point: doctor.mjs behaves identically
      // regardless of which layout deployed it.
      const isolatedDir = path.join(fixture, 'scripts', '.claude-skills');
      const root = await bundleRootUnderLayout(isolatedDir);
      assert.equal(fs.realpathSync(root), fs.realpathSync(fixture));
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('BOTH candidate directories can exist simultaneously without confusing resolution', async () => {
    // The trap this test locks: a naive layout probe (`existsSync('scripts/.claude-skills')`)
    // would see BOTH exist in a real consumer post-migration (legacy files not yet
    // removed) and could pick the wrong one. findRepoRootFromScript never probes
    // either — it derives strictly from where THIS FILE was loaded from.
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-layout-both-'));
    try {
      fs.mkdirSync(path.join(fixture, 'scripts', '.claude-skills'), { recursive: true });
      const isolatedRoot = await bundleRootUnderLayout(path.join(fixture, 'scripts', '.claude-skills'));
      assert.equal(fs.realpathSync(isolatedRoot), fs.realpathSync(fixture));
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
