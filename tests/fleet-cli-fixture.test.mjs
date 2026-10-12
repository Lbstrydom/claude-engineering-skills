/**
 * @fileoverview `makeFleetRepo` copies a per-process template instead of
 * building every fixture from nine git spawns. A copy is only a substitute if
 * nothing one test does can reach another test's fixture — these pin that, and
 * the last case is the negative control: the same probes, pointed at a fixture
 * that DOES share an origin, must see the leak.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, commitFile, makeFleetRepo, writeFile } from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const originMain = (fx) => git(['--git-dir', fx.origin, 'rev-parse', 'main'], fx.root);
const sameFile = (a, b) => path.relative(fs.realpathSync.native(a), fs.realpathSync.native(b)) === '';

/** Everything a test can observe about a fixture that another test's mutation could change. */
function probe(fx) {
  return {
    tracked: fs.readFileSync(path.join(fx.repo, 'a.txt'), 'utf8'),
    head: git(['rev-parse', 'HEAD'], fx.repo),
    originMain: originMain(fx),
    branches: git(['for-each-ref', '--format=%(refname)', 'refs/heads'], fx.repo),
    originRefs: git(['--git-dir', fx.origin, 'for-each-ref', '--format=%(refname)'], fx.root),
    status: git(['status', '--porcelain', '--untracked-files=all'], fx.repo),
  };
}

/**
 * Mutate every surface `probe` reads: an in-place overwrite of an EXISTING tracked file (what a
 * hard-linked or symlinked copy would leak through), a pushed commit, a branch, an untracked file.
 */
function mutate(fx) {
  fs.writeFileSync(path.join(fx.repo, 'a.txt'), 'overwritten in place\n');
  commitFile(fx.repo, 'leak.txt', 'leak\n');
  git(['push', '-q', 'origin', 'main'], fx.repo);
  git(['branch', 'leaky'], fx.repo);
  git(['push', '-q', 'origin', 'leaky'], fx.repo);
  writeFile(fx.repo, 'untracked.txt', 'u\n');
}

describe('makeFleetRepo: template copies are isolated', () => {
  it('each fixture is its own directory with its own origin, and origin is the copy\'s, never the template\'s', () => {
    const a = makeFleetRepo();
    const b = makeFleetRepo();
    assert.notEqual(a.root, b.root);
    for (const fx of [a, b]) {
      const url = git(['remote', 'get-url', 'origin'], fx.repo);
      assert.ok(sameFile(url, fx.origin), `origin of ${fx.repo} is ${url}, expected ${fx.origin}`);
      assert.equal(git(['rev-parse', '--abbrev-ref', 'main@{upstream}'], fx.repo), 'origin/main');
      assert.equal(originMain(fx), git(['rev-parse', 'main'], fx.repo), 'the copy starts pushed');
    }
  });

  it('a mutation of one fixture (commit, push, branch, untracked file) leaves an existing AND a later fixture untouched', () => {
    const victim = makeFleetRepo();
    const before = probe(victim);
    const actor = makeFleetRepo();
    assert.deepEqual(probe(actor), before, 'two fresh fixtures are indistinguishable');
    mutate(actor);
    assert.notDeepEqual(probe(actor), before, 'positive control: the mutation is visible where it was made');
    assert.deepEqual(probe(victim), before, 'an existing fixture saw nothing');
    assert.deepEqual(probe(makeFleetRepo()), before, 'a fixture copied AFTER the mutation saw nothing (the template is untouched)');
  });

  it('fleetConfig and custom files still apply per fixture', () => {
    const plain = makeFleetRepo();
    const cfg = makeFleetRepo({ fleetConfig: { mergeMethod: 'pr' } });
    const custom = makeFleetRepo({ files: { 'only.txt': 'o\n' } });
    assert.equal(fs.existsSync(path.join(plain.repo, '.fleet.json')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg.repo, '.fleet.json'), 'utf8')), { mergeMethod: 'pr' });
    assert.equal(git(['ls-files'], custom.repo), 'only.txt');
    assert.equal(git(['ls-files'], plain.repo), 'a.txt\nb.txt\nc.txt');
  });

  it('negative control: the same probes DO see a leak when two fixtures share an origin', () => {
    const victim = makeFleetRepo();
    const actor = makeFleetRepo();
    git(['remote', 'set-url', 'origin', victim.origin], actor.repo); // the defect a missed re-point would be
    const before = probe(victim);
    mutate(actor);
    assert.notDeepEqual(probe(victim), before, 'a shared origin must be detected, or the isolation case above proves nothing');
  });

  it('negative control: an in-place overwrite IS seen through a hard-linked working file, so the tracked-file probe can fail', () => {
    const victim = makeFleetRepo();
    const actor = makeFleetRepo();
    fs.rmSync(path.join(actor.repo, 'a.txt'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.linkSync(path.join(victim.repo, 'a.txt'), path.join(actor.repo, 'a.txt')); // the defect a link-based copy would be
    const before = probe(victim);
    fs.writeFileSync(path.join(actor.repo, 'a.txt'), 'overwritten in place\n');
    assert.notEqual(probe(victim).tracked, before.tracked, 'the overwrite must reach the victim, or `tracked` proves nothing');
  });
});
