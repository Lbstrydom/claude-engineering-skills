/**
 * @fileoverview The commit-id cache (lib/fleet/oid-cache.mjs) and its wiring into
 * the git facts `fleet status` derives per branch. The load-bearing property is
 * EQUIVALENCE: a cached answer must equal the live one, for every key shape the
 * wiring produces (single merge-base, criss-cross, base moved), and the CLI's
 * output must be identical cold vs warm vs disabled.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CACHE_VERSION, cacheEnabled, createOidCache, memoPure, _resetOidCaches, flushAllCaches } from '../scripts/lib/fleet/oid-cache.mjs';
import { changedFiles, mergeBase, mergeBasesAll, patchId, runGit } from '../scripts/lib/fleet/git-facts.mjs';
import { squashPatchIds } from '../scripts/lib/fleet/merged-facts.mjs';
import { addBranch, cleanupFleetRoots, commitFile, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { git } from './helpers/git.mjs';

after(cleanupFleetRoots);

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('memoPure', () => {
  test('caches a success, never a failure, and bypasses non-ids and FLEET_CACHE=off', () => {
    const dir = tmpRoot('oid-cache-');
    _resetOidCaches();
    let calls = 0;
    const ok = () => { calls += 1; return { ok: true, value: 42 }; };
    assert.deepEqual(memoPure({ commonDir: dir, op: 't', oids: [A, B], compute: ok }), { ok: true, value: 42, cached: false });
    assert.deepEqual(memoPure({ commonDir: dir, op: 't', oids: [A, B], compute: ok }), { ok: true, value: 42, cached: true });
    assert.equal(calls, 1);
    memoPure({ commonDir: dir, op: 't', oids: ['main', B], compute: ok });
    memoPure({ commonDir: dir, op: 't', oids: [A.slice(0, 12), B], compute: ok });
    memoPure({ commonDir: dir, op: 't', oids: [A, B], compute: ok, env: { FLEET_CACHE: 'off' } });
    assert.equal(calls, 4, 'a ref name, a short sha, and the off switch all compute live');
    let fails = 0;
    const bad = () => { fails += 1; return { ok: false, reason: 'boom' }; };
    memoPure({ commonDir: dir, op: 'f', oids: [A], compute: bad });
    memoPure({ commonDir: dir, op: 'f', oids: [A], compute: bad });
    assert.equal(fails, 2, 'a failure is recomputed every time');
    const nul = () => ({ ok: true, value: null });
    memoPure({ commonDir: dir, op: 'n', oids: [A], compute: nul });
    assert.deepEqual(memoPure({ commonDir: dir, op: 'n', oids: [A], compute: () => { throw new Error('should hit'); } }), { ok: true, value: null, cached: true }, 'null (an empty diff) is a real answer');
    assert.equal(cacheEnabled({ FLEET_CACHE: '0' }), false);
  });
});

describe('createOidCache', () => {
  test('flush + reload round-trips; corrupt or foreign-version files start empty; LRU-bounded', () => {
    const file = path.join(tmpRoot('oid-cache-'), 'fleet-cache', 'oid-results.json');
    let t = 1;
    const c = createOidCache(file, { now: () => t++, maxEntries: 2 });
    c.put('k1', 1); c.put('k2', 2);
    c.get('k1'); // k1 is now the more recently used
    c.put('k3', 3); // over the cap: the least recently used (k2) goes
    assert.deepEqual(c.flush(), { written: true, entries: 2 });
    const re = createOidCache(file);
    assert.equal(re.get('k1'), 1, 'recently used survives');
    assert.equal(re.get('k3'), 3);
    assert.equal(re.get('k2'), undefined, 'least recently used was dropped');
    fs.writeFileSync(file, '{not json');
    assert.equal(createOidCache(file).size, 0);
    fs.writeFileSync(file, JSON.stringify({ version: CACHE_VERSION + 1, entries: { k: { v: 1, t: 1 } } }));
    assert.equal(createOidCache(file).size, 0);
    assert.deepEqual(createOidCache(file).flush(), { written: false }, 'nothing changed, nothing written');
  });
});

describe('cached git facts equal live ones', () => {
  test('changedFiles / patchId / mergeBase / squash window: cached == live == uncached, and a moved base reuses the fork-point key', () => {
    const { repo } = makeFleetRepo();
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo);
    const tip = addBranch(repo, 'feat', { 'a.txt': 'A\n', 'new.txt': 'n\n' });
    const base1 = git(['rev-parse', 'main'], repo);
    _resetOidCaches();
    const env = process.env.FLEET_CACHE;
    try {
      process.env.FLEET_CACHE = 'off';
      const liveFiles = changedFiles(repo, base1, tip).files;
      const livePid = patchId(repo, base1, tip).patchId;
      const liveSquash = squashPatchIds(repo, base1);
      delete process.env.FLEET_CACHE;
      assert.deepEqual(changedFiles(repo, base1, tip).files, liveFiles);
      assert.equal(patchId(repo, base1, tip).patchId, livePid);
      flushAllCaches();
      _resetOidCaches(); // read back from disk
      assert.deepEqual(changedFiles(repo, base1, tip).files, liveFiles);
      assert.equal(patchId(repo, base1, tip).patchId, livePid);
      const sq = squashPatchIds(repo, base1);
      const sq2 = squashPatchIds(repo, base1);
      assert.deepEqual([...sq2.byPatchId], [...liveSquash.byPatchId]);
      assert.equal(sq2.complete, liveSquash.complete);
      assert.deepEqual([...sq.byPatchId], [...liveSquash.byPatchId]);
      // Base moves on; the fork point does not: the three-dot answers are the same and keyed by the fork point.
      commitFile(repo, 'c.txt', 'C2\n');
      const base2 = git(['rev-parse', 'main'], repo);
      assert.deepEqual(changedFiles(repo, base2, tip).files, liveFiles);
      assert.equal(patchId(repo, base2, tip).patchId, livePid);
      flushAllCaches();
      const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(common, 'fleet-cache', 'oid-results.json'), 'utf8')).entries);
      const mb = git(['merge-base', base2, tip], repo);
      assert.ok(keys.includes(`changed:${mb}:${tip}`));
      assert.ok(!keys.some((k) => k.startsWith(`changed:${base2}:`)), 'not keyed by the moving base');
      assert.equal(mergeBase(repo, base2, tip).oid, mb);
      assert.equal(fs.existsSync(path.join(common, 'fleet')), false, 'the cache never creates the registry');
    } finally {
      if (env === undefined) delete process.env.FLEET_CACHE; else process.env.FLEET_CACHE = env;
    }
  });

  test('a criss-cross history (two merge-bases) keys on (base, branch) and mergeBase still matches git', () => {
    const { repo } = makeFleetRepo();
    git(['switch', '-q', '-c', 'x'], repo);
    commitFile(repo, 'x.txt', 'x1\n');
    git(['switch', '-q', 'main'], repo);
    git(['switch', '-q', '-c', 'y'], repo);
    commitFile(repo, 'y.txt', 'y1\n');
    const x1 = git(['rev-parse', 'x'], repo); const y1 = git(['rev-parse', 'y'], repo);
    git(['merge', '-q', '--no-edit', x1], repo); // y merges x
    git(['switch', '-q', 'x'], repo);
    git(['merge', '-q', '--no-edit', y1], repo); // x merges old y
    commitFile(repo, 'x.txt', 'x2\n');
    git(['switch', '-q', 'y'], repo);
    commitFile(repo, 'y.txt', 'y2\n');
    const xs = git(['rev-parse', 'x'], repo); const ys = git(['rev-parse', 'y'], repo);
    _resetOidCaches();
    const all = mergeBasesAll(repo, xs, ys);
    assert.ok(all.ok && all.value.length === 2, `expected a criss-cross (got ${all.value})`);
    assert.equal(mergeBase(repo, xs, ys).oid, git(['merge-base', xs, ys], repo), 'first of --all is what merge-base prints');
    const live = runGit(['diff', '--name-only', '-z', '--no-renames', `${xs}...${ys}`], repo);
    assert.ok(live.ok);
    assert.deepEqual(changedFiles(repo, xs, ys).files, live.stdout.split('\0').filter(Boolean));
    assert.deepEqual(changedFiles(repo, xs, ys).files, live.stdout.split('\0').filter(Boolean), 'and again from the cache');
  });
});

describe('fleet status through the CLI', () => {
  test('cold, warm and FLEET_CACHE=off produce the same status', () => {
    const { repo } = makeFleetRepo();
    addBranch(repo, 'feat-a', { 'a.txt': 'A\n' });
    addBranch(repo, 'feat-b', { 'b.txt': 'B\n' });
    const strip = (r) => JSON.stringify(r.json?.status, (k, v) => (k === 'observedAt' ? undefined : v));
    const off = runFleet(['status', '--json'], { cwd: repo, env: scrubbedEnv({ FLEET_CACHE: 'off', FLEET_TELEMETRY: 'off' }) });
    const cold = runFleet(['status', '--json'], { cwd: repo, env: scrubbedEnv({ FLEET_TELEMETRY: 'off' }) });
    const warm = runFleet(['status', '--json'], { cwd: repo, env: scrubbedEnv({ FLEET_TELEMETRY: 'off' }) });
    for (const r of [off, cold, warm]) assert.equal(r.status, 0, r.stderr);
    assert.equal(strip(cold), strip(off));
    assert.equal(strip(warm), strip(off));
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo);
    assert.ok(fs.existsSync(path.join(common, 'fleet-cache', 'oid-results.json')), 'the warm run had a cache to read');
  });
});

describe('guards (audit R1)', () => {
  test('a shallow, grafted or replace-ref repository is never cached', async () => {
    const { topologyStable } = await import('../scripts/lib/fleet/oid-cache.mjs');
    for (const setup of [
      (d) => fs.writeFileSync(path.join(d, 'shallow'), `${A}\n`),
      (d) => { fs.mkdirSync(path.join(d, 'info'), { recursive: true }); fs.writeFileSync(path.join(d, 'info', 'grafts'), `${A}\n`); },
      (d) => { fs.mkdirSync(path.join(d, 'refs', 'replace'), { recursive: true }); fs.writeFileSync(path.join(d, 'refs', 'replace', A), `${B}\n`); },
      (d) => fs.writeFileSync(path.join(d, 'packed-refs'), `# pack-refs\n${B} refs/replace/${A}\n`),
    ]) {
      const dir = tmpRoot('oid-topo-');
      assert.equal(topologyStable(dir), true);
      setup(dir);
      assert.equal(topologyStable(dir), false);
      _resetOidCaches();
      let calls = 0;
      const compute = () => { calls += 1; return { ok: true, value: 1 }; };
      memoPure({ commonDir: dir, op: 't', oids: [A], compute });
      memoPure({ commonDir: dir, op: 't', oids: [A], compute });
      assert.equal(calls, 2, 'computed live both times');
    }
  });

  test('a cached value failing its shape check is recomputed, not trusted', () => {
    const dir = tmpRoot('oid-valid-');
    _resetOidCaches();
    memoPure({ commonDir: dir, op: 'c', oids: [A], compute: () => ({ ok: true, value: 'not-a-count' }) });
    let calls = 0;
    const r = memoPure({ commonDir: dir, op: 'c', oids: [A], valid: (v) => Number.isInteger(v), compute: () => { calls += 1; return { ok: true, value: 7 }; } });
    assert.deepEqual(r, { ok: true, value: 7, cached: false });
    assert.equal(calls, 1);
  });

  test('the entry cap holds in memory, not only on disk', () => {
    const file = path.join(tmpRoot('oid-cap-'), 'c.json');
    let t = 0;
    const c = createOidCache(file, { now: () => t++, maxEntries: 10 });
    for (let i = 0; i < 25; i += 1) c.put(`k${i}`, i);
    assert.ok(c.size <= 10, `size ${c.size}`);
    assert.equal(c.get('k24'), 24, 'newest kept');
    assert.equal(c.get('k0'), undefined, 'oldest evicted');
  });

  test('sanitizeGitEnv on Windows removes git-local variables in any case', async () => {
    const { sanitizeGitEnv } = await import('../scripts/lib/git-env-sanitize.mjs');
    const env = sanitizeGitEnv(process.cwd(), { git_dir: 'x', Git_Work_Tree: 'y', GIT_DIR: 'z', PATH: 'p', Path: 'q' }, { platform: 'win32' });
    assert.deepEqual(Object.keys(env).sort(), ['PATH', 'Path']);
    const posix = sanitizeGitEnv(process.cwd(), { git_dir: 'x', GIT_DIR: 'z' }, { platform: 'linux' });
    assert.deepEqual(Object.keys(posix), ['git_dir'], 'case-sensitive elsewhere: git_dir is a different variable');
  });
});
