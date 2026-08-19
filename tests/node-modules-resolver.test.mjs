/**
 * @fileoverview Behavioural guard for countTopLevelEntries — the pre-push
 * sandbox's postcondition fingerprint for "did the main checkout's linked
 * node_modules lose content during this run" (see prepush-check.mjs's
 * mainModulesForGuard check).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countTopLevelEntries } from '../scripts/lib/node-modules-resolver.mjs';

describe('countTopLevelEntries', () => {
  let root;
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-count-entries-')); });
  after(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('counts top-level entries only, not nested files', () => {
    const dir = path.join(root, 'a');
    fs.mkdirSync(path.join(dir, 'pkg1', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'pkg2'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pkg1', 'nested', 'deep.js'), 'x');
    fs.writeFileSync(path.join(dir, 'pkg1', 'index.js'), 'x');

    assert.equal(countTopLevelEntries(dir), 2);
  });

  it('returns null for a missing directory instead of throwing', () => {
    assert.equal(countTopLevelEntries(path.join(root, 'does-not-exist')), null);
  });

  it('detects a shrink after entries are removed — the property the sandbox guard relies on', () => {
    const dir = path.join(root, 'b');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'pkg1'));
    fs.mkdirSync(path.join(dir, 'pkg2'));
    fs.mkdirSync(path.join(dir, 'pkg3'));
    const before3 = countTopLevelEntries(dir);

    fs.rmSync(path.join(dir, 'pkg2'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const after2 = countTopLevelEntries(dir);

    assert.equal(before3, 3);
    assert.equal(after2, 2);
    assert.ok(after2 < before3, 'a real content loss must read as a shrink');
  });
});
