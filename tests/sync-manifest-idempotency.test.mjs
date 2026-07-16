/**
 * @fileoverview writeManifest idempotency — only rewrite the on-disk
 * manifest when the file content hashes actually changed. Without this,
 * every sync run created a new `generatedAt` timestamp (and possibly a
 * new commitSha), leaving scripts/.sync-manifest.json in a permanent
 * `M` state in git status after every push.
 *
 * Reported behaviour (2026-05-23): operator saw the manifest as
 * uncommitted after every push despite no content changes that round.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeManifest } from '../scripts/lib/sync-manifest.mjs';

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mft-'));
}

function setupRepo() {
  const root = mkdtemp();
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'b.txt'), 'world');
  return root;
}

describe('writeManifest — idempotency (no churn when files unchanged)', () => {
  it('first write creates the file and reports skipped:false', () => {
    const root = setupRepo();
    try {
      const r = writeManifest(root, ['a.txt', 'b.txt']);
      assert.equal(r.skipped, false);
      assert.ok(fs.existsSync(path.join(root, 'scripts/.sync-manifest.json')));
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('second write with identical file contents does NOT touch the file', () => {
    const root = setupRepo();
    try {
      writeManifest(root, ['a.txt', 'b.txt']);
      const manifestPath = path.join(root, 'scripts/.sync-manifest.json');
      const mtimeBefore = fs.statSync(manifestPath).mtimeMs;
      const contentBefore = fs.readFileSync(manifestPath, 'utf-8');

      // Wait a tick so any mtime change would be observable.
      const wait = Date.now() + 20;
      while (Date.now() < wait) { /* spin */ }

      const r2 = writeManifest(root, ['a.txt', 'b.txt']);
      assert.equal(r2.skipped, true, 'second write must report skipped:true');

      // File content + mtime must be unchanged.
      assert.equal(fs.readFileSync(manifestPath, 'utf-8'), contentBefore);
      assert.equal(fs.statSync(manifestPath).mtimeMs, mtimeBefore,
        'manifest mtime must not advance when content unchanged');
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('rewrites when a tracked file content actually changes', () => {
    const root = setupRepo();
    try {
      writeManifest(root, ['a.txt', 'b.txt']);
      const manifestPath = path.join(root, 'scripts/.sync-manifest.json');
      const before = fs.readFileSync(manifestPath, 'utf-8');

      fs.writeFileSync(path.join(root, 'a.txt'), 'CHANGED');
      const r2 = writeManifest(root, ['a.txt', 'b.txt']);
      assert.equal(r2.skipped, false);

      const after = fs.readFileSync(manifestPath, 'utf-8');
      assert.notEqual(after, before, 'manifest content must change when hashes change');
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('rewrites when the tracked file set changes (file added)', () => {
    const root = setupRepo();
    try {
      writeManifest(root, ['a.txt']);
      fs.writeFileSync(path.join(root, 'c.txt'), 'new');
      const r2 = writeManifest(root, ['a.txt', 'c.txt']);
      assert.equal(r2.skipped, false, 'adding a file to tracked set must rewrite');
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('rewrites when the tracked file set changes (file removed)', () => {
    const root = setupRepo();
    try {
      writeManifest(root, ['a.txt', 'b.txt']);
      const r2 = writeManifest(root, ['a.txt']);
      assert.equal(r2.skipped, false, 'removing a file from tracked set must rewrite');
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('recovers from a corrupt existing manifest by overwriting it', () => {
    const root = setupRepo();
    try {
      const manifestPath = path.join(root, 'scripts/.sync-manifest.json');
      fs.writeFileSync(manifestPath, '{not valid json');
      const r2 = writeManifest(root, ['a.txt']);
      assert.equal(r2.skipped, false);
      // The written manifest must now be valid JSON.
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      assert.ok(parsed.files);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});
