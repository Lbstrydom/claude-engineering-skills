/**
 * @fileoverview 5bc2 - a consumer could not close a report CES had fixed: `upstream fix --commit <sha>` insisted the sha resolve in the
 * CONSUMER repo, where the upstream commit does not exist. The invariant (the stored commit is a commit object in THIS repo,
 * REQ-correctness-2f2c1d39) is kept; `resolveFixCommit` now brings the object in first - resolved on the remote, fetched without
 * touching HEAD, the index, refs, config or shallow state - and re-resolves it locally. Every failing step writes nothing.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveFixCommit, upstreamTransition } from '../scripts/lib/upstream/commands.mjs';

const UUID = '3f2a9c1e-5b7d-4e86-9a10-2d4f6b8c0e11';
let tmp, upstream, consumer, upstreamSha;
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const init = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
};
const snapshot = (cwd) => ({
  head: git(cwd, 'rev-parse', 'HEAD'),
  status: git(cwd, 'status', '--porcelain'),
  refs: git(cwd, 'for-each-ref'),
  config: fs.readFileSync(path.join(cwd, '.git', 'config'), 'utf8'),
  shallow: fs.existsSync(path.join(cwd, '.git', 'shallow')),
  isShallow: git(cwd, 'rev-parse', '--is-shallow-repository'),
});

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fix-commit-')));
  upstream = path.join(tmp, 'upstream');
  consumer = path.join(tmp, 'consumer');
  init(upstream);
  fs.writeFileSync(path.join(upstream, 'a.txt'), '1\n');
  git(upstream, 'add', '-A'); git(upstream, 'commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(upstream, 'a.txt'), '2\n');
  git(upstream, 'add', '-A'); git(upstream, 'commit', '-q', '-m', 'the fix');
  upstreamSha = git(upstream, 'rev-parse', 'HEAD');
  init(consumer);
  fs.writeFileSync(path.join(consumer, 'README'), 'consumer\n');
  fs.mkdirSync(path.join(consumer, 'scripts'));
  fs.writeFileSync(path.join(consumer, 'scripts', '.sync-manifest.json'), JSON.stringify({ repo: 'Acme/upstream', commitSha: upstreamSha, files: {} }));
  git(consumer, 'add', 'README'); git(consumer, 'commit', '-q', '-m', 'consumer root');
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

// The remote is faked at the two network seams; the FETCH is real, against the local upstream repo path.
const lookup = (repo, sha) => (repo === 'Acme/upstream' && upstreamSha.startsWith(sha) ? { ok: true, oid: upstreamSha } : { ok: false, error: 'HTTP 404' });
const realFetch = ({ repoRoot, oid }) => {
  try { git(repoRoot, 'fetch', '--no-tags', upstream, oid); return { ok: true }; } catch (e) { return { ok: false, error: String(e.stderr ?? e.message) }; }
};

describe('resolveFixCommit - a consumer closing a report fixed upstream', () => {
  it('fetches the upstream commit, then resolves it LOCALLY; HEAD, index, refs, config and shallow state are untouched', () => {
    const before = snapshot(consumer);
    const r = resolveFixCommit({ repoRoot: consumer, commit: upstreamSha.slice(0, 10), resolveUpstreamCommit: lookup, fetchObject: realFetch });
    assert.deepEqual(r, { ok: true, oid: upstreamSha, fetched: true });
    assert.equal(git(consumer, 'rev-parse', '--verify', `${upstreamSha}^{commit}`), upstreamSha, 'the object is now a commit in the CONSUMER repo');
    const after = snapshot(consumer);
    assert.deepEqual(after, before, 'the fetch must not change HEAD/index/refs/config');
    assert.equal(after.shallow, false);
    assert.equal(after.isShallow, 'false');
  });

  it('a commit already present locally needs no network at all', () => {
    const r = resolveFixCommit({
      repoRoot: consumer, commit: upstreamSha,
      resolveUpstreamCommit: () => { throw new Error('must not be called'); }, fetchObject: () => { throw new Error('must not be called'); },
    });
    assert.deepEqual(r, { ok: true, oid: upstreamSha, fetched: false });
  });

  it('NEGATIVE CONTROLS - each failing step is BAD_INPUT-worthy and names itself', () => {
    const fresh = path.join(tmp, 'consumer-fresh');
    fs.cpSync(consumer, fresh, { recursive: true });
    const missing = 'deadbeefcafe';
    // 1. not hex at all
    assert.match(resolveFixCommit({ repoRoot: fresh, commit: 'not-a-sha' }).error, /does not resolve/);
    // 2. remote does not know it
    assert.match(resolveFixCommit({ repoRoot: fresh, commit: missing, resolveUpstreamCommit: lookup }).error, /looking it up in Acme\/upstream failed: HTTP 404/);
    // 3. remote answers something that is not a 40-hex id (validated, never trusted)
    assert.match(resolveFixCommit({ repoRoot: fresh, commit: missing, resolveUpstreamCommit: () => ({ ok: true, oid: 'zzz' }) }).error, /no 40-hex commit id/);
    // 4. fetch fails
    const lookupOk = () => ({ ok: true, oid: 'a'.repeat(40) });
    assert.match(resolveFixCommit({ repoRoot: fresh, commit: missing, resolveUpstreamCommit: lookupOk, fetchObject: () => ({ ok: false, error: 'network down' }) }).error, /fetching aaaaaaaa from Acme\/upstream failed: network down/);
    // 5. fetch "succeeds" but the object still does not resolve locally - the invariant is checked, not assumed
    assert.match(resolveFixCommit({ repoRoot: fresh, commit: missing, resolveUpstreamCommit: lookupOk, fetchObject: () => ({ ok: true }) }).error, /still does not resolve to a commit locally/);
  });

  it('no synced manifest means no upstream to ask: refuses, naming why', () => {
    const bare = path.join(tmp, 'bare');
    init(bare);
    fs.writeFileSync(path.join(bare, 'x'), 'x\n'); git(bare, 'add', '-A'); git(bare, 'commit', '-q', '-m', 'x');
    const r = resolveFixCommit({ repoRoot: bare, commit: upstreamSha.slice(0, 10), resolveUpstreamCommit: lookup, fetchObject: realFetch });
    assert.equal(r.ok, false);
    assert.match(r.error, /no synced manifest names an upstream repo/);
  });

  it('a manifest repo that is not owner/name is never put in a URL', () => {
    const evil = path.join(tmp, 'evil');
    init(evil);
    fs.mkdirSync(path.join(evil, 'scripts'));
    fs.writeFileSync(path.join(evil, 'scripts', '.sync-manifest.json'), JSON.stringify({ repo: '../../etc/passwd --upload-pack=x' }));
    fs.writeFileSync(path.join(evil, 'x'), 'x\n'); git(evil, 'add', '-A'); git(evil, 'commit', '-q', '-m', 'x');
    const r = resolveFixCommit({ repoRoot: evil, commit: 'abcdef123456', resolveUpstreamCommit: () => { throw new Error('must not be called'); } });
    assert.match(r.error, /no synced manifest names an upstream repo/);
  });
});

describe('upstreamTransition --commit from a consumer', () => {
  const close = (commit, over = {}) => upstreamTransition({
    repoRoot: over.repoRoot ?? consumer, id: UUID, to: 'fixed', commit, note: 'fixed upstream', disposition: 'exempt:synthetic test reason',
    storeFingerprint: null, resolveUpstreamCommit: lookup, fetchObject: realFetch, transitionFn: over.transitionFn ?? (async (a) => ({ ok: true, stored: a })),
  });

  it('stores the FULL oid for an upstream-only short sha', async () => {
    const c2 = path.join(tmp, 'consumer-2');
    fs.cpSync(consumer, c2, { recursive: true });
    const res = await close(upstreamSha.slice(0, 9), { repoRoot: c2 });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.stored.commit, upstreamSha);
  });

  it('NEGATIVE CONTROL: an unresolvable commit stays BAD_INPUT and the store is never reached', async () => {
    let reached = false;
    const res = await close('deadbeefcafe', { transitionFn: async () => { reached = true; return { ok: true }; } });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'BAD_INPUT');
    assert.equal(reached, false);
  });
});
