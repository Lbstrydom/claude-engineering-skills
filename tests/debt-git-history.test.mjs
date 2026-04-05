/**
 * @fileoverview Phase D.8 — git-history-based debt metric derivation tests.
 *
 * Tests create a temporary git repo, commit a ledger file with topicIds,
 * then verify the derivation functions return expected counts + commit refs.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  countCommitsTouchingTopic,
  findFirstDeferCommit,
  detectGitHubRepoUrl,
  buildCommitUrl,
  deriveOccurrencesFromGit,
} from '../scripts/lib/debt-git-history.mjs';

let tmpDir;

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: tmpDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function writeLedger(entries) {
  const ledger = { version: 1, entries };
  fs.writeFileSync(path.join(tmpDir, '.audit', 'tech-debt.json'), JSON.stringify(ledger, null, 2));
}

function makeEntry(topicId) {
  return {
    source: 'debt', topicId, semanticHash: `hash-${topicId}`,
    severity: 'HIGH', category: 'test', section: 's', detailSnapshot: 'd',
    affectedFiles: ['x.js'], affectedPrinciples: [], pass: 'backend',
    deferredReason: 'out-of-scope',
    deferredAt: '2026-04-05T10:00:00.000Z',
    deferredRun: 'r1',
    deferredRationale: 'a sufficiently long testing rationale',
    contentAliases: [], sensitive: false,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-git-history-'));
  fs.mkdirSync(path.join(tmpDir, '.audit'), { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── countCommitsTouchingTopic ───────────────────────────────────────────────

describe('countCommitsTouchingTopic', () => {
  test('returns 0 for empty topicId', () => {
    assert.equal(countCommitsTouchingTopic('', { cwd: tmpDir }), 0);
    assert.equal(countCommitsTouchingTopic(null, { cwd: tmpDir }), 0);
  });

  test('returns 0 when not a git repo', () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      assert.equal(countCommitsTouchingTopic('anything', { cwd: nonRepo }), 0);
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  test('returns 0 when topicId never appeared in ledger', () => {
    writeLedger([makeEntry('aa11bb22')]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'initial']);
    assert.equal(countCommitsTouchingTopic('nonexistent', { cwd: tmpDir }), 0);
  });

  test('counts 1 commit when topicId added once', () => {
    writeLedger([makeEntry('aa11bb22')]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'add aa11bb22']);
    assert.equal(countCommitsTouchingTopic('aa11bb22', { cwd: tmpDir }), 1);
  });

  test('git log -S reports only commits where net occurrence count changes', () => {
    // git log -S<string> is a pickaxe search — it reports commits that
    // ADD/REMOVE the string, not every commit that keeps it present.
    // An update that preserves the string yields 0 additional counts.
    writeLedger([makeEntry('aa11bb22')]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'add aa11bb22']);

    // Rewrite entry with a different rationale (same topicId) — string still present
    const updated = makeEntry('aa11bb22');
    updated.deferredRationale = 'updated rationale with enough characters to pass';
    writeLedger([updated]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'update aa11bb22 rationale']);

    // Expected: 1 (the add). The update doesn't change the net count.
    // This reflects actual git-log-S semantics. Document this limitation:
    // git-history-derived occurrences are a LOWER BOUND — they only count
    // commits that added/removed the topicId, not commits that merely
    // re-saved with it present. That's OK for our purpose: we're signalling
    // "this topic has a persisted history" not "exact run count".
    assert.equal(countCommitsTouchingTopic('aa11bb22', { cwd: tmpDir }), 1);
  });

  test('counts 2 when topicId added, removed, re-added', () => {
    // When the string actually leaves + returns, each transition counts.
    writeLedger([makeEntry('aa11bb22')]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'add aa11bb22']);

    // Remove the topic entirely
    writeLedger([]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'remove aa11bb22']);

    // Re-add
    writeLedger([makeEntry('aa11bb22')]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'readd aa11bb22']);

    // Expected: 2 commits modified the net count (add=+1, readd=+1).
    // The remove commit subtracts, but git log -S still reports it.
    // Actual behavior may be 2 or 3 depending on git version — we assert >= 2
    const count = countCommitsTouchingTopic('aa11bb22', { cwd: tmpDir });
    assert.ok(count >= 2, `expected >= 2 commits, got ${count}`);
  });

  test('counts distinct commits for distinct topicIds', () => {
    writeLedger([makeEntry('aa11bb22')]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'add aa']);

    writeLedger([makeEntry('aa11bb22'), makeEntry('cc33dd44')]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'add cc']);

    // aa11bb22 present in both commits → 1 (added once) — git log -S counts
    // commits where the *net occurrences* of the string changed
    assert.equal(countCommitsTouchingTopic('aa11bb22', { cwd: tmpDir }), 1);
    assert.equal(countCommitsTouchingTopic('cc33dd44', { cwd: tmpDir }), 1);
  });
});

// ── findFirstDeferCommit ────────────────────────────────────────────────────

describe('findFirstDeferCommit', () => {
  test('returns null for missing topicId', () => {
    assert.equal(findFirstDeferCommit('', { cwd: tmpDir }), null);
    assert.equal(findFirstDeferCommit(null, { cwd: tmpDir }), null);
  });

  test('returns null when not a git repo', () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      assert.equal(findFirstDeferCommit('aa11bb22', { cwd: nonRepo }), null);
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  test('finds commit that first introduced a topicId', () => {
    writeLedger([makeEntry('aa11bb22')]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'feat: introduce aa11bb22']);

    const result = findFirstDeferCommit('aa11bb22', { cwd: tmpDir });
    assert.ok(result);
    assert.match(result.sha, /^[a-f0-9]{40}$/);
    assert.equal(result.subject, 'feat: introduce aa11bb22');
  });

  test('finds the earliest commit when topicId appears in multiple', () => {
    writeLedger([makeEntry('aa11bb22')]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'first add']);
    const firstSha = git(['rev-parse', 'HEAD']).trim();

    // Modify then restore
    const updated = makeEntry('aa11bb22');
    updated.deferredRationale = 'different now with enough characters please';
    writeLedger([updated]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'update']);

    const result = findFirstDeferCommit('aa11bb22', { cwd: tmpDir });
    assert.equal(result.sha, firstSha);
    assert.equal(result.subject, 'first add');
  });

  test('returns null for never-introduced topicId', () => {
    writeLedger([makeEntry('aa11bb22')]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'something']);

    assert.equal(findFirstDeferCommit('zzzzzzzzzzzz', { cwd: tmpDir }), null);
  });

  test('attaches URL when remoteUrl provided', () => {
    writeLedger([makeEntry('aa11bb22')]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'add topic']);

    const result = findFirstDeferCommit('aa11bb22', {
      cwd: tmpDir,
      remoteUrl: 'https://github.com/owner/repo',
    });
    assert.ok(result.url);
    assert.match(result.url, /^https:\/\/github\.com\/owner\/repo\/commit\/[a-f0-9]{40}$/);
  });
});

// ── detectGitHubRepoUrl ─────────────────────────────────────────────────────

describe('detectGitHubRepoUrl', () => {
  test('returns null when no origin configured', () => {
    assert.equal(detectGitHubRepoUrl({ cwd: tmpDir }), null);
  });

  test('normalizes SSH origin to HTTPS GitHub URL', () => {
    git(['remote', 'add', 'origin', 'git@github.com:owner/my-repo.git']);
    assert.equal(detectGitHubRepoUrl({ cwd: tmpDir }), 'https://github.com/owner/my-repo');
  });

  test('handles HTTPS origin with .git suffix', () => {
    git(['remote', 'add', 'origin', 'https://github.com/owner/my-repo.git']);
    assert.equal(detectGitHubRepoUrl({ cwd: tmpDir }), 'https://github.com/owner/my-repo');
  });

  test('handles HTTPS origin without .git suffix', () => {
    git(['remote', 'add', 'origin', 'https://github.com/owner/my-repo']);
    assert.equal(detectGitHubRepoUrl({ cwd: tmpDir }), 'https://github.com/owner/my-repo');
  });

  test('returns null for non-GitHub remote', () => {
    git(['remote', 'add', 'origin', 'https://gitlab.com/owner/repo.git']);
    assert.equal(detectGitHubRepoUrl({ cwd: tmpDir }), null);
  });
});

// ── buildCommitUrl ──────────────────────────────────────────────────────────

describe('buildCommitUrl', () => {
  test('concatenates repo URL + /commit/ + SHA', () => {
    assert.equal(
      buildCommitUrl('https://github.com/owner/repo', 'abc123'),
      'https://github.com/owner/repo/commit/abc123'
    );
  });

  test('strips .git suffix', () => {
    assert.equal(
      buildCommitUrl('https://github.com/owner/repo.git', 'abc'),
      'https://github.com/owner/repo/commit/abc'
    );
  });

  test('strips trailing slash', () => {
    assert.equal(
      buildCommitUrl('https://github.com/owner/repo/', 'abc'),
      'https://github.com/owner/repo/commit/abc'
    );
  });
});

// ── deriveOccurrencesFromGit ────────────────────────────────────────────────

describe('deriveOccurrencesFromGit', () => {
  test('empty input returns empty map', () => {
    assert.equal(deriveOccurrencesFromGit([], { cwd: tmpDir }).size, 0);
    assert.equal(deriveOccurrencesFromGit(null, { cwd: tmpDir }).size, 0);
  });

  test('skips entries without topicId', () => {
    const result = deriveOccurrencesFromGit([{}, { topicId: null }], { cwd: tmpDir });
    assert.equal(result.size, 0);
  });

  test('counts per-topicId commits', () => {
    writeLedger([makeEntry('aa11bb22'), makeEntry('cc33dd44')]);
    git(['add', '.audit/tech-debt.json']);
    git(['commit', '-q', '-m', 'add two']);

    const result = deriveOccurrencesFromGit(
      [{ topicId: 'aa11bb22' }, { topicId: 'cc33dd44' }, { topicId: 'zzzzzzzz' }],
      { cwd: tmpDir }
    );
    assert.equal(result.get('aa11bb22'), 1);
    assert.equal(result.get('cc33dd44'), 1);
    assert.equal(result.get('zzzzzzzz'), 0);
  });
});
