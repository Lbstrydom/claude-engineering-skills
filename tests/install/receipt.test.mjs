import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readReceipt, writeReceipt, buildReceipt } from '../../scripts/lib/install/receipt.mjs';

// PID-based root: collision requires same PID + same millisecond + same
// directory — the same reasoning this repo's Accepted Technical Debt table
// already applies to atomicWriteFileSync's temp naming; probability
// negligible. That covers uniqueness ACROSS process runs. Uniqueness WITHIN
// one run — so no two of the tests below can ever delete each other's
// fixtures via t.after() cleanup regardless of execution order or future
// concurrency — is `mkdtempSync`'s job below, not this root's.
const TMP = path.join(os.tmpdir(), 'receipt-test-' + process.pid);

describe('receipt', () => {
  after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  it('returns null for nonexistent receipt', () => {
    const { receipt, error } = readReceipt('/nonexistent/receipt.json');
    assert.equal(receipt, null);
    assert.equal(error, null);
  });

  it('round-trips a valid receipt', (t) => {
    fs.mkdirSync(TMP, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TMP, 'case-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
    const p = path.join(dir, 'receipt.json');
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
  });

  it('PRESERVES the `scope` discriminator across a read/write round trip', (t) => {
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
    const dir = fs.mkdtempSync(path.join(TMP, 'case-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
    const p = path.join(dir, 'scoped.json');
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
  });

  it('accepts a legacy receipt with no `scope` (absence means repo)', (t) => {
    // Pre-existing receipts carry no scope field; rejecting them would break
    // every installed consumer on upgrade. Absence is read as repo-scope by
    // partitionManagedFilesByScope and computeDeletes alike.
    fs.mkdirSync(TMP, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TMP, 'case-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
    const p = path.join(dir, 'legacy.json');
    writeReceipt(p, buildReceipt({
      bundleVersion: 'abc123',
      sourceUrl: 'https://example.com',
      surface: 'both',
      managedFiles: [{ path: '.agents/skills/x/SKILL.md', sha: 'ccc' }],
    }));
    const { receipt, error } = readReceipt(p);
    assert.equal(error, null);
    assert.equal(receipt.managedFiles[0].scope, undefined);
  });

  it('rejects an unknown scope value rather than silently coercing it', (t) => {
    fs.mkdirSync(TMP, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TMP, 'case-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
    const p = path.join(dir, 'badscope.json');
    fs.writeFileSync(p, JSON.stringify({
      receiptVersion: 1, bundleVersion: 'v', installedAt: new Date().toISOString(),
      sourceUrl: 'https://example.com', surface: 'both',
      managedFiles: [{ path: 'a.md', sha: 'x', scope: 'elsewhere' }],
    }));
    const { receipt, error } = readReceipt(p);
    assert.equal(receipt, null);
    assert.ok(error.includes('Invalid receipt'));
  });

  it('rejects invalid receipt JSON', (t) => {
    fs.mkdirSync(TMP, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TMP, 'case-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
    const p = path.join(dir, 'bad.json');
    fs.writeFileSync(p, '{"invalid": true}');
    const { receipt, error } = readReceipt(p);
    assert.equal(receipt, null);
    assert.ok(error.includes('Invalid receipt'));
  });

  it('cleanup runs even when the test fails (t.after() survives an assertion throw)', (t) => {
    // Regression for 5cf9d863: the original design put fs.rmSync as the last
    // statement in the test body, so a mid-test assertion failure skipped it.
    // Proving that here means proving t.after() runs on a FAILED test, which
    // cannot be observed from inside the same node:test process (a failed
    // it() terminates that test; nothing later in-process can react to it).
    // So this spawns a child process running a tiny fixture that deliberately
    // fails after registering t.after() cleanup, and checks from the outside
    // that the directory is gone once the child exits.
    const fixture = path.join(import.meta.dirname, 'fixtures', 'receipt-cleanup-on-failure.mjs');
    const markerFile = path.join(TMP, 'marker-' + Date.now() + '.txt');
    fs.mkdirSync(TMP, { recursive: true });
    t.after(() => { try { fs.rmSync(markerFile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ } });
    // NODE_TEST_CONTEXT leaks into a child's env from the parent `node --test`
    // run and makes the child think it's a nested test runner invocation —
    // it skips running the fixture entirely and exits, never writing the
    // marker file. Same scrub this repo's own run-tests.mjs SCRUBBED_RUNNER_ENV
    // applies for the identical reason.
    const childEnv = { ...process.env, MARKER_FILE: markerFile };
    delete childEnv.NODE_TEST_CONTEXT;
    let childThrew = false;
    try {
      execFileSync(process.execPath, ['--test', fixture], {
        encoding: 'utf-8',
        env: childEnv,
      });
    } catch (err) {
      // Expected — node --test exits non-zero because the fixture's own
      // test deliberately threw. The marker file (written before the throw)
      // is what we actually assert on, not the exit code.
      childThrew = true;
      assert.notEqual(err.status, 0);
    }
    assert.ok(childThrew, 'the fixture test is expected to fail');
    assert.ok(fs.existsSync(markerFile), 'fixture must have written the case dir path before throwing');
    const caseDir = fs.readFileSync(markerFile, 'utf-8');
    assert.equal(fs.existsSync(caseDir), false, 't.after() must have removed the directory despite the test failing');
  });

  it('two concurrently-created case directories never collide', async () => {
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => { fs.mkdirSync(TMP, { recursive: true }); return fs.mkdtempSync(path.join(TMP, 'case-')); }),
      Promise.resolve().then(() => { fs.mkdirSync(TMP, { recursive: true }); return fs.mkdtempSync(path.join(TMP, 'case-')); }),
    ]);
    assert.notEqual(a, b);
    fs.rmSync(a, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.rmSync(b, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});
