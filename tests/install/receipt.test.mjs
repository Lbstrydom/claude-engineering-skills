import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readReceipt, writeReceipt, buildReceipt } from '../../scripts/lib/install/receipt.mjs';

const TMP = path.join(os.tmpdir(), 'receipt-test-' + process.pid);

describe('receipt', () => {
  it('returns null for nonexistent receipt', () => {
    const { receipt, error } = readReceipt('/nonexistent/receipt.json');
    assert.equal(receipt, null);
    assert.equal(error, null);
  });

  it('round-trips a valid receipt', () => {
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'receipt.json');
    const r = buildReceipt({
      bundleVersion: 'abc123',
      sourceUrl: 'https://example.com',
      surface: 'both',
      managedFiles: [{ path: '.github/skills/audit/SKILL.md', sha: 'def456' }],
    });
    writeReceipt(p, r);
    const { receipt, error } = readReceipt(p);
    assert.equal(error, null);
    assert.equal(receipt.bundleVersion, 'abc123');
    assert.equal(receipt.managedFiles.length, 1);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('PRESERVES the `scope` discriminator across a read/write round trip', () => {
    // The receipt encodes a managed file's path format BY SCOPE: global entries
    // are absolute (they live in ~/.claude/skills, outside any repo), repo
    // entries are relative. Every reader branches on `scope` to decode them
    // again — so a schema that omits the field does not merely lose metadata,
    // it makes the decoder's global branch unreachable. Zod's z.object() strips
    // unknown keys, so `scope` reached disk and vanished on the way back:
    // computeDeletes then resolved every global path as
    // path.join(repoRoot, '<absolute path>'), which cannot exist, so the delete
    // silently no-op'd and the file was orphaned in the user's home directory.
    // Round-tripping the discriminator is the assertion that would have caught it.
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'scoped.json');
    writeReceipt(p, buildReceipt({
      bundleVersion: 'abc123',
      sourceUrl: 'https://example.com',
      surface: 'both',
      managedFiles: [
        { path: 'C:/Users/u/.claude/skills/ship/SKILL.md', sha: 'aaa', skill: 'ship', scope: 'global' },
        { path: '.agents/skills/ship/SKILL.md', sha: 'bbb', skill: 'ship', scope: 'repo' },
      ],
    }));

    const { receipt, error } = readReceipt(p);

    assert.equal(error, null);
    assert.equal(receipt.managedFiles[0].scope, 'global', 'the global discriminator must survive the read');
    assert.equal(receipt.managedFiles[1].scope, 'repo', 'and so must the repo one');
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('accepts a legacy receipt with no `scope` (absence means repo)', () => {
    // Pre-existing receipts carry no scope field; rejecting them would break
    // every installed consumer on upgrade. Absence is read as repo-scope by
    // partitionManagedFilesByScope and computeDeletes alike.
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'legacy.json');
    writeReceipt(p, buildReceipt({
      bundleVersion: 'abc123',
      sourceUrl: 'https://example.com',
      surface: 'both',
      managedFiles: [{ path: '.agents/skills/x/SKILL.md', sha: 'ccc' }],
    }));
    const { receipt, error } = readReceipt(p);
    assert.equal(error, null);
    assert.equal(receipt.managedFiles[0].scope, undefined);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('rejects an unknown scope value rather than silently coercing it', () => {
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'badscope.json');
    fs.writeFileSync(p, JSON.stringify({
      receiptVersion: 1, bundleVersion: 'v', installedAt: new Date().toISOString(),
      sourceUrl: 'https://example.com', surface: 'both',
      managedFiles: [{ path: 'a.md', sha: 'x', scope: 'elsewhere' }],
    }));
    const { receipt, error } = readReceipt(p);
    assert.equal(receipt, null);
    assert.ok(error.includes('Invalid receipt'));
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('rejects invalid receipt JSON', () => {
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'bad.json');
    fs.writeFileSync(p, '{"invalid": true}');
    const { receipt, error } = readReceipt(p);
    assert.equal(receipt, null);
    assert.ok(error.includes('Invalid receipt'));
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});
