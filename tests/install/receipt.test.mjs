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
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('rejects invalid receipt JSON', () => {
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'bad.json');
    fs.writeFileSync(p, '{"invalid": true}');
    const { receipt, error } = readReceipt(p);
    assert.equal(receipt, null);
    assert.ok(error.includes('Invalid receipt'));
    fs.rmSync(TMP, { recursive: true, force: true });
  });
});
