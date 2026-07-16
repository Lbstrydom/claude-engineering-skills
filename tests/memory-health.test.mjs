import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { _internals } from '../scripts/memory-health.mjs';

const tmpDirs = [];
function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-health-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

describe('memory-health.mjs — atomicWrite (atomic-write-adoption plan)', () => {
  it('writes content atomically and creates parent directories', () => {
    const tmpDir = mkTmp();
    const target = path.join(tmpDir, 'nested', 'report.md');

    _internals.atomicWrite(target, '# Memory Health\n\nGREEN\n');

    assert.equal(fs.readFileSync(target, 'utf-8'), '# Memory Health\n\nGREEN\n');
  });

  it('overwrites existing content', () => {
    const tmpDir = mkTmp();
    const target = path.join(tmpDir, 'report.md');
    _internals.atomicWrite(target, 'first');
    _internals.atomicWrite(target, 'second');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'second');
  });
});
