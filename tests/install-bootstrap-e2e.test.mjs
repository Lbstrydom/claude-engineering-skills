/**
 * Hermetic end-to-end for the bootstrapper.
 *
 * `install-bootstrap.test.mjs` asserts on SOURCE — useful, but lint: it would
 * pass a rename, and it proves nothing about behaviour. The plan's own §9 makes
 * the point sharper: running `sync-to-repos.mjs --target-path` directly (which is
 * what the earlier "empirical check" did) bypasses **every part of install.mjs
 * this change rewrote** — cache acquisition, origin validation, ref→SHA
 * resolution, dependency-install ordering, delegation arguments, and the
 * sync-then-migrate order. A green suite there would have told us nothing.
 *
 * So this drives the REAL `bootstrap()` against a local fixture git remote.
 *
 * ## What is stubbed, and why that is stated rather than hidden
 *
 * Exactly one thing: `installDepsFn`. The real step is `npm ci --omit=dev`, which
 * needs a registry — running it would make this suite slow, network-dependent and
 * therefore not hermetic. It is replaced with a recorder, so its ORDERING (before
 * any target write) is still asserted even though its effect is not. Everything
 * else — including the parts most likely to break — runs for real.
 *
 * The bundle SOURCE is injected through `pkg`, the module seam, and NOT through
 * an env var. That is deliberate (D6d): a production-readable override would let
 * an ambient value choose which code gets cloned and executed.
 *
 * Plan: docs/plans/repo-scoped-skill-surfaces-and-installer.md §2 D6a/D6b/D6d, §9.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { bootstrap, bundleSource } from '../install.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The `node_modules` directory that actually serves THIS file — which is not
 * necessarily `<REPO_ROOT>/node_modules`.
 *
 * A git worktree has no `node_modules` of its own; its imports resolve by Node
 * walking UP into the checkout it is nested in. Linking `<REPO_ROOT>/node_modules`
 * from a worktree therefore linked a path that does not exist, the `catch` below
 * swallowed the ENOENT, and the cache — sitting in OS temp, where no upward walk
 * can reach the repo — got no `zod`. Every test in this file then died with
 * ERR_MODULE_NOT_FOUND: 8 failures, 0 passes, `npm test` red for anyone working
 * in a worktree (which the agent harness creates by default). It passed in the
 * main checkout and in the pre-push sandbox, which is why it went unnoticed.
 * Reported from a consumer 2026-08-01 and reproduced here before this fix.
 *
 * Asking the resolver where a real dependency lives is correct in both layouts.
 */
function hostNodeModules() {
  const entry = createRequire(import.meta.url).resolve('zod/package.json');
  const parts = entry.split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  if (i === -1) throw new Error(`cannot locate node_modules from resolved zod path: ${entry}`);
  return parts.slice(0, i + 1).join(path.sep);
}

let tmp, remote, fixturePkg, headSha, prevCache;

// `maxBuffer` raised well above the 1 MB default: the fixture bundle carries the
// whole `scripts/lib` tree, and `git add -A` / `clone` chatter over that many
// files overflows it — surfacing as a bare `spawnSync git ENOBUFS` from a
// `before` hook, which the runner reports only as "cancelledByParent" on every
// test in the file.
const git = (args, cwd) =>
  execFileSync('git', args, {
    cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  }).trim();

/**
 * Build a BARE git remote holding a minimal but genuinely functional bundle.
 *
 * Minimal on purpose: cloning the whole real repo per test would be slow and
 * would couple this suite to unrelated content. What it must contain is whatever
 * `bootstrap()` actually touches — a package.json, and a `scripts/` tree with the
 * two scripts it shells out to.
 */
function buildFixtureRemote() {
  const work = path.join(tmp, 'bundle-src');
  fs.mkdirSync(path.join(work, 'scripts', 'lib', 'install'), { recursive: true });

  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({
    name: 'fixture-bundle', version: '0.0.1', type: 'module',
    repository: { type: 'git', url: 'https://example.invalid/fixture' },
  }, null, 2));

  // Stand-in for sync-to-repos.mjs: records its argv and creates the consumer
  // layout, so the delegation contract is observable.
  fs.writeFileSync(path.join(work, 'scripts', 'sync-to-repos.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const i = argv.indexOf('--target-path');
const target = argv[i + 1];
fs.writeFileSync(path.join(target, 'SYNC_ARGV.json'), JSON.stringify(argv, null, 2));
if (!argv.includes('--dry-run')) {
  fs.mkdirSync(path.join(target, '.claude', 'skills', 'ship'), { recursive: true });
  fs.writeFileSync(path.join(target, '.claude', 'skills', 'ship', 'SKILL.md'), 'node scripts/.claude-skills/ship-commit.mjs\\n');
  fs.mkdirSync(path.join(target, 'scripts', '.claude-skills'), { recursive: true });
  fs.writeFileSync(path.join(target, 'scripts', '.claude-skills', 'ship-commit.mjs'), '// runner\\n');
}
`.trimStart());

  // Stand-in for install-skills.mjs --uninstall-legacy: records that it was
  // invoked, so "the install never deletes without consent" is observable.
  fs.writeFileSync(path.join(work, 'scripts', 'install-skills.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const i = argv.indexOf('--repo-root');
fs.writeFileSync(path.join(argv[i + 1], 'UNINSTALL_CALLED.json'), JSON.stringify(argv));
`.trimStart());

  // The real `scripts/lib` tree, copied WHOLESALE rather than file-by-file.
  //
  // `bootstrap()` imports `legacy-surfaces.mjs` from the bundle, so it must be the
  // production module — and its import closure is not something to enumerate by
  // hand. An earlier draft of this fixture listed
  // `['surface-paths', 'receipt', 'conflict-detector', 'schemas-install', 'file-io']`
  // and promptly failed on `retry-transient-fs.mjs`, two hops down. That is
  // precisely the hand-maintained-file-list rot this plan exists to delete from
  // `install.mjs`; reproducing it in the test that proves the deletion would be
  // absurd. Copy the tree and let the resolver do its job.
  fs.rmSync(path.join(work, 'scripts', 'lib'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.cpSync(path.join(REPO_ROOT, 'scripts', 'lib'), path.join(work, 'scripts', 'lib'), { recursive: true });
  // `node_modules` must NEVER enter the fixture repo.
  //
  // An earlier version symlinked the real `node_modules` into `work` for zod
  // resolution and then ran `git add -A`, which followed the junction and
  // committed the lot: **9,874 files per fixture**, cloned once per test. That
  // made the suite take ~50s AND made it fail outright under parallel load with
  // `inflate: data stream error` / `failed to read delta base object` — a
  // corrupted pack, not a flaky assertion. It surfaced first in the pre-push
  // sandbox, which is exactly where a slow, heavy test gets squeezed.
  //
  // Dependency resolution is handled instead by planting `node_modules` beside
  // the CACHE (see `linkDepsBesideCache`), where Node's upward walk finds it and
  // git never sees it.
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n');

  git(['init', '-q', '-b', 'main'], work);
  git(['config', 'user.email', 'fixture@example.invalid'], work);
  git(['config', 'user.name', 'Fixture'], work);
  git(['add', '-A'], work);
  git(['commit', '-q', '-m', 'fixture bundle'], work);
  headSha = git(['rev-parse', 'HEAD'], work);

  const bare = path.join(tmp, 'remote.git');
  git(['clone', '-q', '--bare', work, bare], tmp);
  return bare;
}

function mkTargetRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module' }, null, 2));
  return dir;
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-boot-e2e-')));
  remote = buildFixtureRemote();
  // `bundleSource` appends `.git`; point it at the bare repo so it round-trips.
  fixturePkg = { repository: { type: 'git', url: remote.replaceAll('\\', '/').replace(/\.git$/, '') } };
  prevCache = process.env.CES_BUNDLE_CACHE;
});

beforeEach(() => {
  // A distinct cache per test, so origin-validation and re-clone behaviour are
  // observed rather than inherited.
  process.env.CES_BUNDLE_CACHE = path.join(tmp, `cache-${Math.abs(headSha.length * 7 + Date.now() % 1)}`, 'bundle');
});

after(() => {
  if (prevCache === undefined) delete process.env.CES_BUNDLE_CACHE;
  else process.env.CES_BUNDLE_CACHE = prevCache;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/**
 * Make the bundle's own dependencies resolvable from the cache WITHOUT putting
 * them in git.
 *
 * `legacy-surfaces.mjs` → `receipt.mjs` → `schemas-install.mjs` needs `zod`, and
 * the real step that would provide it (`npm ci`) is the one thing this suite
 * stubs. Node resolves `node_modules` by walking UP from the importing file, so a
 * link one level above the cache (`<cache>/..`) is found from
 * `<cache>/scripts/lib/install/*.mjs` — and `acquireBundle` only ever touches the
 * cache directory itself, so it survives a delete-and-re-clone.
 */
function linkDepsBesideCache(cache) {
  const parent = path.dirname(cache);
  fs.mkdirSync(parent, { recursive: true });
  const link = path.join(parent, 'node_modules');
  if (fs.existsSync(link)) return;
  // Deliberately NOT swallowed. The cache lives in OS temp, so there is no
  // ambient resolution chain to fall back to — a failure here guarantees eight
  // ERR_MODULE_NOT_FOUND failures several frames away, which is exactly how the
  // worktree bug presented. Fail where the cause is, not where the symptom is.
  fs.symlinkSync(hostNodeModules(), link, 'junction');
}

/** Run the real bootstrap with deps stubbed and step order recorded. */
async function boot(target, opts = {}) {
  const steps = [];
  const cache = path.join(tmp, `c-${target.split(/[\\/]/).pop()}`, 'bundle');
  linkDepsBesideCache(cache);
  process.env.CES_BUNDLE_CACHE = cache;
  await bootstrap({
    pkg: fixturePkg,
    target,
    installDepsFn: () => steps.push('deps-installed'),
    onStep: (name) => steps.push(name),
    ...opts,
  });
  return { steps, cache };
}

describe('bootstrap — acquisition', () => {
  it('resolves the default branch to an immutable SHA and deploys', async () => {
    const target = mkTargetRepo('fresh');
    const { steps, cache } = await boot(target);

    assert.ok(fs.existsSync(path.join(cache, '.git')), 'the bundle must be cached');
    assert.equal(git(['rev-parse', 'HEAD'], cache), headSha,
      'the cache must be checked out at the resolved SHA, not a branch tip read later');

    // Delegation contract: the sync was invoked with the canonical target.
    const argv = JSON.parse(fs.readFileSync(path.join(target, 'SYNC_ARGV.json'), 'utf8'));
    assert.ok(argv.includes('--target-path'));
    assert.equal(argv[argv.indexOf('--target-path') + 1], target);
    assert.ok(argv.includes('--quiet-legacy-check'),
      'the parent reports legacy state, so the child must not duplicate the warning');
    assert.ok(!argv.includes('--dry-run'));

    assert.deepEqual(steps, ['acquire', 'deps-installed', 'deps', 'sync', 'migrate']);
  });

  it('installs dependencies BEFORE touching the target', async () => {
    const target = mkTargetRepo('order');
    const { steps } = await boot(target);
    assert.ok(steps.indexOf('deps') < steps.indexOf('sync'),
      'a dependency failure must leave the target untouched');
  });

  // The ordering that is invisible when both succeed, and destructive when wrong.
  it('syncs BEFORE migrating, so a repo is never left with neither copy', async () => {
    const target = mkTargetRepo('order2');
    const { steps } = await boot(target);
    assert.ok(steps.indexOf('sync') < steps.indexOf('migrate'));
  });

  it('honours an explicit --ref', async () => {
    const target = mkTargetRepo('pinned');
    const { cache } = await boot(target, { ref: headSha });
    assert.equal(git(['rev-parse', 'HEAD'], cache), headSha);
  });

  it('re-clones a cache whose origin no longer matches the canonical source', async () => {
    const target = mkTargetRepo('repointed');
    const { cache } = await boot(target);

    // Repoint the cache at something else, as a poisoned/stale run would leave it.
    const decoy = path.join(tmp, 'decoy.git');
    if (!fs.existsSync(decoy)) git(['clone', '-q', '--bare', path.join(tmp, 'bundle-src'), decoy], tmp);
    git(['remote', 'set-url', 'origin', decoy], cache);
    fs.writeFileSync(path.join(cache, 'POISON.txt'), 'should not survive');

    linkDepsBesideCache(cache);
    process.env.CES_BUNDLE_CACHE = cache;
    await bootstrap({
      pkg: fixturePkg, target: mkTargetRepo('repointed2'),
      installDepsFn: () => {}, onStep: () => {},
    });

    assert.equal(fs.existsSync(path.join(cache, 'POISON.txt')), false,
      'a repointed cache must be deleted and re-cloned, never fetched into');
    assert.equal(git(['remote', 'get-url', 'origin'], cache), bundleSource(fixturePkg));
  });
});

describe('bootstrap — --dry-run changes nothing', () => {
  it('writes no consumer layout and removes no legacy copy', async () => {
    const target = mkTargetRepo('dry');

    // Plant a legacy tree that a non-dry run would offer to remove.
    const home = path.join(tmp, 'dry-home');
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'ship'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'ship', 'SKILL.md'), 'legacy');

    await boot(target, { dryRun: true });

    assert.equal(fs.existsSync(path.join(target, '.claude', 'skills')), false,
      'dry-run must not create the consumer layout');
    assert.equal(fs.existsSync(path.join(target, 'UNINSTALL_CALLED.json')), false,
      'dry-run must never invoke the uninstaller — writing no replacement while '
      + 'deleting the legacy copy would leave the machine with NEITHER');
    assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'ship', 'SKILL.md')), true);
  });
});

describe('bootstrap — the migration never deletes without consent', () => {
  it('non-interactive: reports but does not invoke the uninstaller', async () => {
    const target = mkTargetRepo('noninteractive');

    // A receipt-backed legacy tree in the TARGET's .agents surface, so the real
    // inspector classifies it `removable`.
    const rel = path.join('.agents', 'skills', 'ship', 'SKILL.md');
    const abs = path.join(target, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'stale agents copy');
    const { createHash } = await import('node:crypto');
    fs.writeFileSync(path.join(target, '.audit-loop-install-receipt.json'), JSON.stringify({
      receiptVersion: 1, bundleVersion: 't', sourceUrl: 't', surface: 'agents',
      installedAt: new Date(0).toISOString(),
      managedFiles: [{
        path: rel.replaceAll('\\', '/'),
        sha: createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 12),
        skill: 'ship', scope: 'repo',
      }],
    }, null, 2));

    await boot(target, { interactive: false });

    assert.equal(fs.existsSync(path.join(target, 'UNINSTALL_CALLED.json')), false,
      'a non-interactive install must never delete — it prints the command instead');
    assert.equal(fs.existsSync(abs), true, 'the legacy file survives');
  });
});

describe('bootstrap — idempotency', () => {
  it('a second run reuses the cache and produces the same layout', async () => {
    const target = mkTargetRepo('idem');
    const { cache } = await boot(target);
    const firstHead = git(['rev-parse', 'HEAD'], cache);

    linkDepsBesideCache(cache);
    process.env.CES_BUNDLE_CACHE = cache;
    await bootstrap({ pkg: fixturePkg, target, installDepsFn: () => {}, onStep: () => {} });

    assert.equal(git(['rev-parse', 'HEAD'], cache), firstHead);
    assert.ok(fs.existsSync(path.join(target, '.claude', 'skills', 'ship', 'SKILL.md')));
  });
});
