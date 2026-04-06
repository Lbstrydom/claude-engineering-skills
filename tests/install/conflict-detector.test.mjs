import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectConflicts, computeFileSha } from '../../scripts/lib/install/conflict-detector.mjs';

const TMP = path.join(os.tmpdir(), 'conflict-test-' + process.pid);

describe('computeFileSha', () => {
  it('computes 12-char hex SHA for a file', () => {
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'test.txt');
    fs.writeFileSync(p, 'hello world');
    const sha = computeFileSha(p);
    assert.match(sha, /^[0-9a-f]{12}$/);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('returns null for nonexistent file', () => {
    assert.equal(computeFileSha('/nonexistent'), null);
  });
});

describe('detectConflicts', () => {
  it('marks nonexistent targets as safe', () => {
    const writes = [{ path: 'x.md', absPath: '/nonexistent/x.md', sha: 'abc' }];
    const { safe, conflicts } = detectConflicts(writes, null);
    assert.equal(safe.length, 1);
    assert.equal(conflicts.length, 0);
  });

  it('marks managed unchanged files as safe', () => {
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'managed.md');
    fs.writeFileSync(p, 'content');
    const sha = computeFileSha(p);
    const receipt = { managedFiles: [{ path: 'managed.md', sha }] };
    const writes = [{ path: 'managed.md', absPath: p, sha: 'new' }];
    const { safe, conflicts } = detectConflicts(writes, receipt);
    assert.equal(safe.length, 1);
    assert.equal(conflicts.length, 0);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('flags unmanaged existing files as conflicts', () => {
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'unmanaged.md');
    fs.writeFileSync(p, 'operator content');
    const writes = [{ path: 'unmanaged.md', absPath: p, sha: 'new' }];
    const { safe, conflicts } = detectConflicts(writes, null);
    assert.equal(safe.length, 0);
    assert.equal(conflicts.length, 1);
    assert.ok(conflicts[0].reason.includes('not managed'));
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('allows --force to override conflicts', () => {
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'forced.md');
    fs.writeFileSync(p, 'operator content');
    const writes = [{ path: 'forced.md', absPath: p, sha: 'new' }];
    const { safe, conflicts } = detectConflicts(writes, null, { force: true });
    assert.equal(safe.length, 1);
    assert.equal(conflicts.length, 0);
    fs.rmSync(TMP, { recursive: true, force: true });
  });
});
