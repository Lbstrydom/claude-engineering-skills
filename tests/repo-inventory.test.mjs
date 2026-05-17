/**
 * Tests for scripts/lib/repo-inventory.mjs
 * Plan: docs/plans/adaptive-context-blast-radius.md — Phase 1 (audit H4).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listRepoFiles } from '../scripts/lib/repo-inventory.mjs';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repo-inv-'));
}

describe('listRepoFiles — fs-walk fallback (non-git dir)', () => {
  it('lists files and reports inventorySource:fs-walk outside a git work-tree', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.mjs'), 'export const b = 2;');
    const r = listRepoFiles({ baseDir: dir });
    // A fresh tmp dir is not a git work-tree → fs-walk.
    assert.equal(r.inventorySource, 'fs-walk');
    assert.ok(r.files.includes('a.mjs'));
    assert.ok(r.files.includes('sub/b.mjs'));
  });

  it('NEVER emits a sensitive path (audit H4)', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'ok.mjs'), '1');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=x');
    fs.writeFileSync(path.join(dir, 'server.pem'), 'KEY');
    fs.mkdirSync(path.join(dir, 'secrets'));
    fs.writeFileSync(path.join(dir, 'secrets', 'prod.json'), '{}');
    const r = listRepoFiles({ baseDir: dir });
    assert.ok(r.files.includes('ok.mjs'));
    assert.ok(!r.files.some(f => f.includes('.env')), '.env excluded');
    assert.ok(!r.files.some(f => f.endsWith('.pem')), '*.pem excluded');
    assert.ok(!r.files.some(f => f.startsWith('secrets/')), 'secrets/ excluded — dir never descended');
  });

  it('skips node_modules / .git', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'a.mjs'), '1');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), '1');
    const r = listRepoFiles({ baseDir: dir });
    assert.ok(!r.files.some(f => f.startsWith('node_modules/')));
  });
});

describe('listRepoFiles — git inventory (real repo)', () => {
  it('uses git and returns a non-trivial filtered file list', () => {
    const r = listRepoFiles({ baseDir: process.cwd() });
    assert.equal(r.inventorySource, 'git');
    assert.ok(r.files.length > 50);
    assert.ok(r.files.includes('scripts/lib/repo-inventory.mjs'), 'includes a tracked file');
    assert.ok(!r.files.some(f => /\.(pem|key)$/.test(f)), 'no key material');
  });
});
