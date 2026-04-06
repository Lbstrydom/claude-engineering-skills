import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executeTransaction } from '../../scripts/lib/install/transaction.mjs';

const TMP = path.join(os.tmpdir(), 'txn-test-' + process.pid);

describe('executeTransaction', () => {
  it('writes all files on success', () => {
    const dir = path.join(TMP, 'success');
    fs.mkdirSync(dir, { recursive: true });
    const writes = [
      { absPath: path.join(dir, 'a.txt'), content: 'hello' },
      { absPath: path.join(dir, 'b.txt'), content: 'world' },
    ];
    const result = executeTransaction(writes);
    assert.equal(result.success, true);
    assert.equal(result.written, 2);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8'), 'hello');
    assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf-8'), 'world');
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('creates directories as needed', () => {
    const dir = path.join(TMP, 'nested', 'deep');
    const writes = [{ absPath: path.join(dir, 'file.txt'), content: 'data' }];
    const result = executeTransaction(writes);
    assert.equal(result.success, true);
    assert.ok(fs.existsSync(path.join(dir, 'file.txt')));
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('preserves existing file content as snapshot', () => {
    const dir = path.join(TMP, 'snapshot');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'existing.txt');
    fs.writeFileSync(p, 'original');
    const writes = [{ absPath: p, content: 'updated' }];
    const result = executeTransaction(writes);
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(p, 'utf-8'), 'updated');
    fs.rmSync(TMP, { recursive: true, force: true });
  });
});
