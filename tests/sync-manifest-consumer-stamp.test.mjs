/**
 * @fileoverview Tier-3 guard: a consumer's `.sync-manifest.json` must carry the
 * SOURCE repo's HEAD sha.
 *
 * Why Tier 3 (hard test-first, same commit as the fix — see AGENTS.md "Testing
 * doctrine"): this is the consumer-sync/relocation contract. A regression here
 * ships SILENTLY to consumer repos we cannot observe, and the symptom is not a
 * crash but a *believable wrong answer* — a report that cannot say which bundle
 * it came from, or worse, one that names a stale commit.
 *
 * History: `commitSha` was hardcoded `null` in the consumer manifest writer from
 * the introduction of the isolated layout until 2026-07-31. Measured on disk that
 * day: the source manifest carried a real sha while wine-cellar-app and
 * ai-organiser both carried `null`, which made "is this reported bug already
 * fixed upstream?" unanswerable. Plan: docs/plans/upstream-issue-reports.md §Phase 1.
 */

import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  getGitMeta, SyncManifestSchema, writeManifest, buildConsumerManifest, listDirtyPaths,
} from '../scripts/lib/sync-manifest.mjs';

const SOURCE_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * `getGitMeta` deliberately supports non-git source trees (it returns nulls),
 * so any test asserting a real sha must not run in a source archive, vendored
 * copy, or a CI/container checkout built without `.git` — it would fail there
 * while indicating nothing about the code.
 */
const HAS_GIT = fs.existsSync(path.join(SOURCE_ROOT, '.git'));

function mkTempGitRepo(commitCount = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-stamp-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  for (let i = 0; i < commitCount; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), `v${i}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `c${i}`);
  }
  return { dir, git };
}

test('getGitMeta returns a real 40-char sha for a git checkout', () => {
  const { dir } = mkTempGitRepo();
  try {
    const meta = getGitMeta(dir);
    assert.match(meta.commitSha, /^[0-9a-f]{40}$/, 'commitSha must be a full sha');
    assert.ok(typeof meta.branch === 'string' && meta.branch.length > 0, 'branch must be non-empty');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('getGitMeta degrades to nulls outside a git checkout rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-nogit-'));
  try {
    const meta = getGitMeta(dir);
    assert.equal(meta.commitSha, null);
    assert.equal(meta.branch, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('this repo resolves a real HEAD sha — the value the sync stamps into consumers',
  { skip: HAS_GIT ? false : 'no .git in this checkout' }, () => {
    const meta = getGitMeta(SOURCE_ROOT);
    assert.match(
      meta.commitSha,
      /^[0-9a-f]{40}$/,
      'the source repo must resolve a HEAD sha, else every consumer stamp is null',
    );
  });

/**
 * The regression this file exists for, tested through the FUNCTION THE SYNC
 * ACTUALLY CALLS.
 *
 * An earlier version of this test hand-built its own manifest literal and
 * asserted on that — which an audit correctly flagged as testing nothing: the
 * real writer in `sync-to-repos.mjs` could have gone on returning
 * `commitSha: null` forever and this file would still have passed. The builder
 * was extracted specifically so the assertion lands on production code.
 */
test('buildConsumerManifest stamps the SOURCE sha and marks the layout isolated', () => {
  const manifest = buildConsumerManifest({
    generatedAt: '2026-07-31T08:05:44.915Z',
    repo: 'Lbstrydom/claude-engineering-skills',
    sourceGitMeta: { commitSha: 'd'.repeat(40), branch: 'main' },
    files: { 'scripts/.claude-skills/cross-skill.mjs': 'sha256:' + 'a'.repeat(64) },
  });

  assert.equal(manifest.commitSha, 'd'.repeat(40), 'the source sha must reach the manifest');
  assert.equal(manifest.branch, 'main');
  assert.equal(manifest.layout, 'isolated');
  assert.equal(manifest.generatedAt, '2026-07-31T08:05:44.915Z', 'consumer-owned field preserved');
  SyncManifestSchema.parse(manifest);          // shape contract holds
});

test('buildConsumerManifest keeps a null sha legal (tarball install / no git)', () => {
  const manifest = buildConsumerManifest({
    generatedAt: new Date().toISOString(),
    sourceGitMeta: { commitSha: null, branch: null },
    files: {},
  });
  assert.equal(manifest.commitSha, null, 'null means UNKNOWN — never coerced to a fake sha');
  assert.equal(manifest.branch, 'main', 'branch falls back; the sha deliberately does not');
  SyncManifestSchema.parse(manifest);
});

test('buildConsumerManifest is what sync-to-repos.mjs actually calls', () => {
  // Guards the extraction itself: if the writer is ever re-inlined, the tests
  // above silently stop covering production again — the exact failure the
  // extraction fixed.
  const raw = fs.readFileSync(path.join(SOURCE_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf-8');
  assert.ok(
    /const consumerManifest = buildConsumerManifest\(/.test(raw),
    'sync-to-repos.mjs must build the consumer manifest via the tested builder',
  );
  // Strip line comments first: the call site's own comment *narrates* the
  // removed `commitSha: null`, so scanning raw source flags the explanation
  // rather than a regression.
  const code = raw.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/commitSha:\s*null/.test(code),
    'a hardcoded `commitSha: null` must never return to the consumer write path',
  );
});

/**
 * Guards the specific trap this fix had to avoid: `writeManifest` returns the
 * EXISTING on-disk manifest on its idempotency-skip path, so its `commitSha` can
 * be stale. Anything needing the current HEAD must call `getGitMeta` directly.
 *
 * If this ever starts failing because the skip path returns a fresh sha, the
 * comment in sync-to-repos.mjs explaining why it reads git directly is obsolete —
 * update both together.
 */
test('writeManifest idempotency-skip returns the stale on-disk sha, not current HEAD', () => {
  const { dir, git } = mkTempGitRepo(1);
  try {
    const files = ['f0.txt'];
    const first = writeManifest(dir, files, { repo: 'test/repo' });
    assert.equal(first.skipped, false);
    const firstSha = first.manifest.commitSha;
    assert.match(firstSha, /^[0-9a-f]{40}$/);

    // New commit that does NOT change any manifested file's content.
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'unrelated');
    const headNow = getGitMeta(dir).commitSha;
    assert.notEqual(headNow, firstSha, 'precondition: HEAD moved');

    const second = writeManifest(dir, files, { repo: 'test/repo' });
    assert.equal(second.skipped, true, 'unchanged hashes must skip the rewrite');
    assert.equal(
      second.manifest.commitSha,
      firstSha,
      'the skip path returns the STALE sha — this is why the consumer writer reads git directly',
    );
    assert.notEqual(second.manifest.commitSha, headNow);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

// ── listDirtyPaths + the sourceDirty stamp ──────────────────────────────────
//
// Why this exists: `sync-to-repos.mjs` ships bytes read from the WORKING TREE
// while the manifest stamps HEAD. When they disagree the consumer holds code
// its own stamp cannot describe — measured 2026-08-01, where that produced a
// "10 commits behind" verdict for a bundle that was actually AHEAD.

describe('listDirtyPaths', () => {
  let repo;

  before(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dirty-')));
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'f@example.invalid']);
    git(['config', 'user.name', 'F']);
    fs.mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts', 'lib', 'clean.mjs'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'scripts', 'lib', 'edited.mjs'), 'export const b = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    // The two shapes that ship un-stamped bytes.
    fs.writeFileSync(path.join(repo, 'scripts', 'lib', 'edited.mjs'), 'export const b = 2;\n');
    fs.writeFileSync(path.join(repo, 'scripts', 'lib', 'brand-new.mjs'), 'export const c = 3;\n');
  });

  after(() => { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('reports modified AND untracked files, in POSIX form', () => {
    const dirty = listDirtyPaths(repo);
    assert.ok(dirty.has('scripts/lib/edited.mjs'), 'a modified source file must count');
    assert.ok(dirty.has('scripts/lib/brand-new.mjs'),
      'an untracked file counts too — a new lib module synced before its commit is the incident case');
    assert.ok(!dirty.has('scripts/lib/clean.mjs'));
  });

  it('returns null — not an empty set — when git is unavailable', () => {
    // The distinction is the whole point: an empty set means "checked, clean",
    // null means "could not determine". Collapsing the second into the first is
    // the silent false-negative this field exists to remove.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'));
    try {
      assert.equal(listDirtyPaths(bare), null);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('buildConsumerManifest — sourceDirty', () => {
  const meta = { commitSha: 'a'.repeat(40), branch: 'main' };

  it('records a boolean verdict when one was determined', () => {
    for (const v of [true, false]) {
      const m = buildConsumerManifest({
        generatedAt: 'T', repo: 'r', sourceGitMeta: meta, files: {}, sourceDirty: v,
      });
      assert.equal(m.sourceDirty, v);
    }
  });

  it('defaults to null, never false — "not determined" must not read as clean', () => {
    const m = buildConsumerManifest({ generatedAt: 'T', repo: 'r', sourceGitMeta: meta, files: {} });
    assert.equal(m.sourceDirty, null);
    const viaNull = buildConsumerManifest({
      generatedAt: 'T', repo: 'r', sourceGitMeta: meta, files: {}, sourceDirty: null,
    });
    assert.equal(viaNull.sourceDirty, null);
  });

  it('stays schema-valid', () => {
    const m = buildConsumerManifest({
      generatedAt: new Date(0).toISOString(), repo: 'r', sourceGitMeta: meta, files: {}, sourceDirty: true,
    });
    assert.doesNotThrow(() => SyncManifestSchema.parse(m));
  });
});
