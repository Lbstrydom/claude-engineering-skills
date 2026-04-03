import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MutexFileStore, AppendOnlyStore, readJsonlFile } from '../scripts/lib/file-store.mjs';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── MutexFileStore ──────────────────────────────────────────────────────────

describe('MutexFileStore', () => {
  it('saves and loads JSON state', () => {
    const store = new MutexFileStore(path.join(tmpDir, 'state.json'));
    store.save({ hello: 'world' });
    const loaded = store.load();
    assert.deepEqual(loaded, { hello: 'world' });
  });

  it('returns default state when file is missing', () => {
    const store = new MutexFileStore(path.join(tmpDir, 'missing.json'), {
      defaultState: { empty: true }
    });
    assert.deepEqual(store.load(), { empty: true });
  });

  it('mutate reads, applies mutator, and writes atomically', () => {
    const filePath = path.join(tmpDir, 'mutate.json');
    const store = new MutexFileStore(filePath, { defaultState: { count: 0 } });
    const result = store.mutate(state => ({ count: state.count + 1 }));
    assert.equal(result.count, 1);
    assert.equal(store.load().count, 1);
  });

  it('cleans up lock file after save', () => {
    const filePath = path.join(tmpDir, 'lock-test.json');
    const store = new MutexFileStore(filePath);
    store.save({ data: true });
    assert.ok(!fs.existsSync(filePath + '.lock'), 'Lock file should be cleaned up');
  });

  it('detects and breaks stale locks', () => {
    const filePath = path.join(tmpDir, 'stale.json');
    const lockPath = filePath + '.lock';
    // Create a stale lock (old timestamp)
    fs.writeFileSync(lockPath, `99999\n${Date.now() - 120000}`, { flag: 'wx' });

    const store = new MutexFileStore(filePath, { staleLockTimeoutMs: 60000 });
    store.save({ recovered: true });
    assert.deepEqual(store.load(), { recovered: true });
  });

  it('quarantines corrupted data on load with schema', async () => {
    const { z } = await import('zod');
    const schema = z.object({ name: z.string() });
    const filePath = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(filePath, JSON.stringify({ bad: 123 }));

    const store = new MutexFileStore(filePath, {
      schema,
      defaultState: { name: 'default' }
    });
    const loaded = store.load();
    assert.deepEqual(loaded, { name: 'default' });
  });
});

// ── AppendOnlyStore ─────────────────────────────────────────────────────────

describe('AppendOnlyStore', () => {
  it('appends and loads JSONL records', () => {
    const store = new AppendOnlyStore(path.join(tmpDir, 'log.jsonl'));
    store.append({ id: 1, value: 'a' });
    store.append({ id: 2, value: 'b' });
    const all = store.loadAll();
    assert.equal(all.length, 2);
    assert.equal(all[0].id, 1);
    assert.equal(all[1].id, 2);
  });

  it('returns empty array when file is missing', () => {
    const store = new AppendOnlyStore(path.join(tmpDir, 'missing.jsonl'));
    assert.deepEqual(store.loadAll(), []);
  });

  it('creates parent directories on append', () => {
    const store = new AppendOnlyStore(path.join(tmpDir, 'nested', 'deep', 'log.jsonl'));
    store.append({ test: true });
    assert.equal(store.loadAll().length, 1);
  });
});

// ── readJsonlFile ───────────────────────────────────────────────────────────

describe('readJsonlFile', () => {
  it('reads valid JSONL', () => {
    const filePath = path.join(tmpDir, 'data.jsonl');
    fs.writeFileSync(filePath, '{"a":1}\n{"b":2}\n');
    const result = readJsonlFile(filePath);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { a: 1 });
  });

  it('skips invalid lines', () => {
    const filePath = path.join(tmpDir, 'mixed.jsonl');
    fs.writeFileSync(filePath, '{"a":1}\nINVALID\n{"b":2}\n');
    const result = readJsonlFile(filePath);
    assert.equal(result.length, 2);
  });

  it('returns empty array for missing file', () => {
    assert.deepEqual(readJsonlFile(path.join(tmpDir, 'nope.jsonl')), []);
  });
});
