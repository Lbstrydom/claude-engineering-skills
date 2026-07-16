import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  parseArgs,
  validateArgs,
  detectRepoName,
  appendLocalFallback,
  runFrictionLog,
} from '../scripts/friction-log.mjs';

// ── parseArgs ────────────────────────────────────────────────────────────

describe('friction-log / parseArgs', () => {
  it('parses positional message', () => {
    assert.deepEqual(
      parseArgs(['hello', 'world']),
      { severity: 'note', repo: null, message: 'hello world', json: false },
    );
  });

  it('parses --severity', () => {
    const r = parseArgs(['--severity', 'blocker', 'msg']);
    assert.equal(r.severity, 'blocker');
    assert.equal(r.message, 'msg');
  });

  it('parses --repo', () => {
    const r = parseArgs(['--repo', 'wine', 'msg']);
    assert.equal(r.repo, 'wine');
  });

  it('handles --help', () => {
    const r = parseArgs(['--help']);
    assert.equal(r.help, true);
  });

  it('returns null message when no positional given', () => {
    const r = parseArgs(['--severity', 'note']);
    assert.equal(r.message, null);
  });
});

// ── validateArgs ──────────────────────────────────────────────────────────

describe('friction-log / validateArgs', () => {
  it('passes valid input', () => {
    assert.deepEqual(
      validateArgs({ message: 'foo', severity: 'note' }),
      [],
    );
  });

  it('rejects missing message', () => {
    const errs = validateArgs({ message: null, severity: 'note' });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /message is required/);
  });

  it('rejects bad severity', () => {
    const errs = validateArgs({ message: 'foo', severity: 'critical' });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /note\|annoyance\|blocker/);
  });

  it('reports multiple errors', () => {
    const errs = validateArgs({ message: null, severity: 'bogus' });
    assert.equal(errs.length, 2);
  });
});

// ── detectRepoName ────────────────────────────────────────────────────────

describe('friction-log / detectRepoName', () => {
  it('returns flag value when provided', () => {
    const r = detectRepoName({ flagValue: 'wine' });
    assert.equal(r, 'wine');
  });

  it('falls back to cwd basename when git remote unavailable', () => {
    const r = detectRepoName({
      flagValue: null,
      cwd: '/foo/bar/myrepo',
      execGit: () => null,
    });
    assert.equal(r, 'myrepo');
  });

  it('extracts repo basename from git remote URL', () => {
    const r = detectRepoName({
      flagValue: null,
      cwd: '/foo',
      execGit: () => 'https://github.com/owner/wine-cellar-app.git\n',
    });
    assert.equal(r, 'wine-cellar-app');
  });

  it('handles SSH-style git remotes', () => {
    const r = detectRepoName({
      flagValue: null,
      cwd: '/foo',
      execGit: () => 'git@github.com:owner/ai-organiser.git',
    });
    assert.equal(r, 'ai-organiser');
  });
});

// ── appendLocalFallback ───────────────────────────────────────────────────

describe('friction-log / appendLocalFallback', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ } });

  it('writes JSONL line', () => {
    const fpath = path.join(tmp, 'out.jsonl');
    const ok = appendLocalFallback({ message: 'x' }, fpath);
    assert.equal(ok, true);
    assert.match(fs.readFileSync(fpath, 'utf-8'), /"message":"x"/);
  });

  it('appends multiple records', () => {
    const fpath = path.join(tmp, 'out.jsonl');
    appendLocalFallback({ id: 1 }, fpath);
    appendLocalFallback({ id: 2 }, fpath);
    const lines = fs.readFileSync(fpath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
  });

  it('creates parent dir if missing', () => {
    const fpath = path.join(tmp, 'nested', 'deep', 'out.jsonl');
    const ok = appendLocalFallback({ id: 1 }, fpath);
    assert.equal(ok, true);
    assert.equal(fs.existsSync(fpath), true);
  });
});

// ── runFrictionLog (cloud-offline path, deterministic) ───────────────────

describe('friction-log / runFrictionLog (cloud-offline)', () => {
  let tmp;
  let prevCwd;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-run-'));
    prevCwd = process.cwd();
    process.chdir(tmp);
    fs.mkdirSync('.audit', { recursive: true });
  });
  afterEach(() => {
    process.chdir(prevCwd);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('returns help when --help passed', async () => {
    const r = await runFrictionLog(['--help']);
    assert.equal(r.ok, true);
    assert.match(r.help, /Usage: audit:wtf/);
  });

  it('returns errors on bad input', async () => {
    const r = await runFrictionLog(['--severity', 'wrong', 'msg']);
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.errors));
    assert.match(r.errors[0], /severity/);
  });

  it('writes to local fallback when cloud disabled', async () => {
    const fakeStore = {
      isCloudEnabled: () => false,
      initLearningStore: async () => false,
    };
    const r = await runFrictionLog(['test message'], { learningStore: fakeStore, cwd: tmp });
    assert.equal(r.ok, true);
    assert.equal(r.cloud, false);
    assert.match(r.fallback || '', /friction-log\.jsonl/);
    // Verify file was written
    assert.equal(fs.existsSync('.audit/friction-log.jsonl'), true);
  });

  it('writes to cloud when enabled', async () => {
    let inserted = null;
    const fakeStore = {
      isCloudEnabled: () => true,
      initLearningStore: async () => true,
      getRepoIdByName: async () => 'repo-uuid-1',
      getMostRecentAuditRunIdForRepo: async () => 'run-uuid-1',
      insertFrictionNote: async (e) => { inserted = e; return { ok: true, id: 'note-uuid' }; },
    };
    const r = await runFrictionLog(['--severity', 'blocker', 'urgent'], { learningStore: fakeStore, cwd: tmp });
    assert.equal(r.ok, true);
    assert.equal(r.cloud, true);
    assert.equal(r.id, 'note-uuid');
    assert.equal(inserted.message, 'urgent');
    assert.equal(inserted.severity, 'blocker');
    assert.equal(inserted.repoId, 'repo-uuid-1');
    assert.equal(inserted.auditRunId, 'run-uuid-1');
  });

  it('falls back to local when cloud insert fails', async () => {
    const fakeStore = {
      isCloudEnabled: () => true,
      initLearningStore: async () => true,
      getRepoIdByName: async () => null,
      getMostRecentAuditRunIdForRepo: async () => null,
      insertFrictionNote: async () => ({ ok: false, error: 'simulated' }),
    };
    const r = await runFrictionLog(['msg'], { learningStore: fakeStore, cwd: tmp });
    assert.equal(r.ok, true); // exit 0 because we captured locally
    assert.equal(r.cloud, false);
    assert.match(r.fallback || '', /friction-log\.jsonl/);
  });

  // Audit-fix R1 H1: cloud throw must NOT bypass the local fallback.
  it('falls back to local when cloud insert THROWS (not just returns ok:false)', async () => {
    const fakeStore = {
      isCloudEnabled: () => true,
      initLearningStore: async () => true,
      getRepoIdByName: async () => null,
      getMostRecentAuditRunIdForRepo: async () => null,
      insertFrictionNote: async () => { throw new Error('network exploded'); },
    };
    const r = await runFrictionLog(['will it survive?'], { learningStore: fakeStore, cwd: tmp });
    assert.equal(r.ok, true, 'must capture locally even when cloud throws');
    assert.equal(r.cloud, false);
    assert.equal(fs.existsSync('.audit/friction-log.jsonl'), true);
    const stored = JSON.parse(fs.readFileSync('.audit/friction-log.jsonl', 'utf-8').trim());
    assert.equal(stored.message, 'will it survive?');
  });
});
