import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  computeOutcomeFromFileState,
  drainFrictionFallback,
  _internals,
} from '../scripts/learning/backfill-outcomes.mjs';

// ── computeOutcomeFromFileState ──────────────────────────────────────────

describe('backfill-outcomes / computeOutcomeFromFileState', () => {
  let tmpDir;
  let prevCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfo-'));
    prevCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('returns null when context is missing', () => {
    assert.equal(computeOutcomeFromFileState({}), null);
    assert.equal(computeOutcomeFromFileState({ context: null }), null);
    assert.equal(computeOutcomeFromFileState({ context: { file: 'a.js' } }), null);
  });

  it('file deleted → accept (assumed fix)', () => {
    const r = computeOutcomeFromFileState({
      context: { file: 'gone.js', snippet: 'console.log("hi")' },
    });
    assert.equal(r.action, 'accept');
    assert.equal(r.evidence, 'file-deleted');
  });

  it('snippet removed from file → accept', () => {
    fs.writeFileSync('a.js', 'function ok() { return 1; }\n');
    const r = computeOutcomeFromFileState({
      context: { file: 'a.js', snippet: 'console.log("hi")' },
    });
    assert.equal(r.action, 'accept');
    assert.equal(r.evidence, 'snippet-removed');
  });

  it('snippet still present, no marker → ignore', () => {
    fs.writeFileSync('a.js', 'function f() { console.log("hi") }\n');
    const r = computeOutcomeFromFileState({
      context: { file: 'a.js', snippet: 'console.log("hi")' },
    });
    assert.equal(r.action, 'ignore');
    assert.equal(r.evidence, 'still-present-no-marker');
  });

  it('snippet present + ignore-marker on same line → suppress', () => {
    fs.writeFileSync('a.js', 'function f() { console.log("hi") /* quickfix-hook:ignore */ }\n');
    const r = computeOutcomeFromFileState({
      context: { file: 'a.js', snippet: 'console.log("hi")' },
    });
    assert.equal(r.action, 'suppress');
    assert.equal(r.evidence, 'ignore-marker-found');
  });

  it('snippet present + ignore-marker on previous line → suppress', () => {
    fs.writeFileSync('a.js', 'function f() {\n  // quickfix-hook:ignore\n  console.log("hi")\n}\n');
    const r = computeOutcomeFromFileState({
      context: { file: 'a.js', snippet: 'console.log("hi")' },
    });
    assert.equal(r.action, 'suppress');
  });

  it('truncated snippet (...) is matched by its prefix', () => {
    fs.writeFileSync('a.js', 'console.log("a very long string that gets cut off in telemetry")\n');
    const r = computeOutcomeFromFileState({
      context: { file: 'a.js', snippet: 'console.log("a very long string that gets cut...' },
    });
    assert.equal(r.action, 'ignore');
  });

  it('very-short snippet → no_action (refusal to commit on weak evidence)', () => {
    fs.writeFileSync('a.js', 'foo\n');
    const r = computeOutcomeFromFileState({
      context: { file: 'a.js', snippet: 'foo' },
    });
    assert.equal(r.action, 'no_action');
    assert.equal(r.evidence, 'snippet-too-short');
  });

  it('returns null on file-read error (permission etc.)', () => {
    const fakeFs = {
      existsSync: () => true,
      readFileSync: () => { throw new Error('EACCES'); },
    };
    const r = computeOutcomeFromFileState(
      { context: { file: 'a.js', snippet: 'console.log("hi")' } },
      { fs: fakeFs },
    );
    assert.equal(r, null);
  });

  // ── Audit-fix R1 H7: path-safety gates ──────────────────────────────────

  it('rejects absolute paths (Unix-style)', () => {
    const r = computeOutcomeFromFileState({
      context: { file: '/etc/passwd', snippet: 'root:x:0:0:' },
    });
    assert.equal(r, null, 'absolute paths must be rejected');
  });

  it('rejects Windows drive-letter absolute paths', () => {
    const r = computeOutcomeFromFileState({
      context: { file: 'C:\\Windows\\System32\\config', snippet: 'console.log("hi")' },
    });
    assert.equal(r, null);
  });

  it('rejects parent-traversal sequences', () => {
    const r = computeOutcomeFromFileState({
      context: { file: '../../etc/passwd', snippet: 'root' },
    });
    assert.equal(r, null);
  });

  it('rejects mixed-separator traversal', () => {
    const r = computeOutcomeFromFileState({
      context: { file: 'src/..\\..\\etc/passwd', snippet: 'root' },
    });
    assert.equal(r, null);
  });

  it('rejects non-string file field', () => {
    assert.equal(computeOutcomeFromFileState({ context: { file: 12345, snippet: 'x' } }), null);
    assert.equal(computeOutcomeFromFileState({ context: { file: { evil: true }, snippet: 'x' } }), null);
  });

  it('accepts safe repo-relative path that resolves inside repoRoot', () => {
    fs.writeFileSync('safe.js', 'console.log("payload")\n');
    const r = computeOutcomeFromFileState(
      { context: { file: 'safe.js', snippet: 'console.log("payload")' } },
      { repoRoot: process.cwd() },
    );
    assert.ok(r);
    assert.equal(r.action, 'ignore');
  });
});

// ── Constants ─────────────────────────────────────────────────────────────

describe('backfill-outcomes / constants', () => {
  it('staleness window is 30 minutes', () => {
    assert.equal(_internals.STALENESS_MS, 30 * 60 * 1000);
  });

  it('hook-ignore marker matches the hook documentation', () => {
    assert.equal(_internals.HOOK_IGNORE_MARKER, 'quickfix-hook:ignore');
  });
});

// ── Friction-fallback drain (Audit-fix friction R1 H3) ─────────────────

describe('drainFrictionFallback', () => {
  let tmpDir;
  let prevCwd;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fric-drain-'));
    prevCwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync('.audit', { recursive: true });
  });
  afterEach(() => {
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('no-op when fallback file absent', async () => {
    const r = await drainFrictionFallback({ learningStore: {}, dryRun: false });
    assert.deepEqual(r, { processed: 0, inserted: 0, errors: 0 });
  });

  it('drains all lines on success and deletes the file', async () => {
    fs.writeFileSync('.audit/friction-log.jsonl',
      JSON.stringify({ ts: 't', message: 'a', severity: 'note' }) + '\n' +
      JSON.stringify({ ts: 't', message: 'b', severity: 'blocker' }) + '\n');
    const inserted = [];
    const fakeStore = {
      getRepoIdByName: async () => null,
      insertFrictionNote: async (e) => { inserted.push(e); return { ok: true, id: 'x' }; },
    };
    const r = await drainFrictionFallback({ learningStore: fakeStore, dryRun: false });
    assert.equal(r.processed, 2);
    assert.equal(r.inserted, 2);
    assert.equal(inserted[0].message, 'a');
    assert.equal(inserted[1].severity, 'blocker');
    assert.equal(fs.existsSync('.audit/friction-log.jsonl'), false, 'file deleted after full drain');
  });

  it('retains failed lines for retry on next drain', async () => {
    fs.writeFileSync('.audit/friction-log.jsonl',
      JSON.stringify({ ts: 't', message: 'ok', severity: 'note' }) + '\n' +
      JSON.stringify({ ts: 't', message: 'fail', severity: 'note' }) + '\n');
    const fakeStore = {
      getRepoIdByName: async () => null,
      insertFrictionNote: async (e) => e.message === 'fail' ? { ok: false, error: 'sim' } : { ok: true },
    };
    const r = await drainFrictionFallback({ learningStore: fakeStore, dryRun: false });
    assert.equal(r.inserted, 1);
    assert.equal(r.errors, 1);
    assert.equal(fs.existsSync('.audit/friction-log.jsonl'), true);
    const remaining = fs.readFileSync('.audit/friction-log.jsonl', 'utf-8').trim();
    assert.match(remaining, /"message":"fail"/);
    assert.doesNotMatch(remaining, /"message":"ok"/);
  });

  it('skips malformed JSON lines and counts them as errors', async () => {
    fs.writeFileSync('.audit/friction-log.jsonl',
      'not-json\n' +
      JSON.stringify({ ts: 't', message: 'good', severity: 'note' }) + '\n');
    const fakeStore = {
      getRepoIdByName: async () => null,
      insertFrictionNote: async () => ({ ok: true, id: 'x' }),
    };
    const r = await drainFrictionFallback({ learningStore: fakeStore, dryRun: false });
    assert.equal(r.errors, 1);
    assert.equal(r.inserted, 1);
  });

  it('--dry-run does not delete or modify the file', async () => {
    fs.writeFileSync('.audit/friction-log.jsonl',
      JSON.stringify({ ts: 't', message: 'a', severity: 'note' }) + '\n');
    const fakeStore = {
      getRepoIdByName: async () => null,
      insertFrictionNote: async () => ({ ok: true }),
    };
    const r = await drainFrictionFallback({ learningStore: fakeStore, dryRun: true });
    assert.equal(r.inserted, 1);
    assert.equal(fs.existsSync('.audit/friction-log.jsonl'), true, 'dry-run preserves file');
  });
});
