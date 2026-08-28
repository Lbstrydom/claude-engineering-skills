/**
 * Consumer paths are siblings of the MAIN checkout, not of whichever worktree
 * loaded the module.
 *
 * The bug (field-found 2026-07-30): a `git push` from a linked worktree at
 * `<main>/.claude/worktrees/<wt>` ran the pre-push sync, which resolved every
 * registered consumer against the WORKTREE — so both looked for
 * `<main>/.claude/worktrees/wine-cellar-app`, neither existed, both were
 * skipped, and the run still printed a green "Sync complete". The push reported
 * success having propagated to zero consumers.
 *
 * Two properties are pinned here, because fixing only the first leaves the
 * second able to hide the next one:
 *   - the anchor is the main checkout (`mainCheckoutRoot`, driven over fixtures);
 *   - the resolved consumer paths are never inside a worktree directory.
 *
 * `assertNotSourceRepo` is checked too: the fix makes the sibling anchor and the
 * containment anchor DIFFERENT values in a worktree, so the guard has to know
 * about both or a registry entry naming the main checkout walks straight past it.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONSUMER_REPOS, sourceRepoRoot, sourceRepoRoots, assertNotSourceRepo,
  localRegistryStatus, _internals,
} from '../scripts/lib/consumer-repos.mjs';

const { mainCheckoutRoot, registryCandidatesFor, LOCAL_REGISTRY_BASENAME } = _internals;

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-wt-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

/** A main checkout: `.git` is a real directory. */
function seedMain(name = 'main') {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

/** A linked worktree: `.git` is a FILE pointing at <main>/.git/worktrees/<wt>. */
function seedWorktree(mainRoot, rel, { gitdir, relative = false } = {}) {
  const root = path.join(mainRoot, rel);
  fs.mkdirSync(root, { recursive: true });
  const target = gitdir ?? path.join(mainRoot, '.git', 'worktrees', path.basename(rel));
  const value = relative ? path.relative(root, target) : target;
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${value}\n`);
  return root;
}

describe('mainCheckoutRoot — which checkout do sibling paths hang off?', () => {
  test('a main checkout (.git is a directory) is its own anchor', () => {
    const main = seedMain();
    assert.equal(mainCheckoutRoot(main), main);
  });

  test('a linked worktree resolves to the main checkout — the reported bug', () => {
    const main = seedMain();
    const wt = seedWorktree(main, path.join('.claude', 'worktrees', 'feature-x'));
    assert.equal(mainCheckoutRoot(wt), main);
    assert.notEqual(mainCheckoutRoot(wt), wt, 'anchoring to the worktree is the defect');
  });

  test('a RELATIVE gitdir is resolved against the worktree, not the cwd', () => {
    const main = seedMain();
    const wt = seedWorktree(main, path.join('.claude', 'worktrees', 'rel'), { relative: true });
    assert.equal(mainCheckoutRoot(wt), main);
  });

  test('a worktree outside the main checkout still finds it', () => {
    const main = seedMain();
    const outside = path.join(tmp, 'elsewhere', 'wt');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, '.git'),
      `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
    assert.equal(mainCheckoutRoot(outside), main);
  });

  describe('unrecognised layouts return the starting root rather than guessing', () => {
    test('a submodule (.git/modules/<name>) is NOT treated as a worktree', () => {
      const main = seedMain();
      const sub = seedWorktree(main, 'vendor-sub', {
        gitdir: path.join(main, '.git', 'modules', 'vendor-sub'),
      });
      assert.equal(mainCheckoutRoot(sub), sub,
        "a submodule's siblings are its own — grandparent of .git/modules is not a checkout root");
    });

    test('no .git at all', () => {
      const bare = path.join(tmp, 'not-a-repo');
      fs.mkdirSync(bare, { recursive: true });
      assert.equal(mainCheckoutRoot(bare), bare);
    });

    test('a .git file with no gitdir: line', () => {
      const odd = path.join(tmp, 'odd');
      fs.mkdirSync(odd, { recursive: true });
      fs.writeFileSync(path.join(odd, '.git'), 'something else entirely\n');
      assert.equal(mainCheckoutRoot(odd), odd);
    });

    test('a gitdir whose common dir is not named .git', () => {
      const main = seedMain();
      const wt = seedWorktree(main, 'weird', {
        gitdir: path.join(main, '.gitfoo', 'worktrees', 'weird'),
      });
      assert.equal(mainCheckoutRoot(wt), wt);
    });
  });
});

describe('the registry resolves off the main checkout', () => {
  test('no consumer path lands inside a worktree directory', () => {
    // Holds in BOTH the main checkout and a worktree — which is the point. Run
    // from a worktree before the fix, every entry pointed at
    // <main>/.claude/worktrees/<consumer>.
    for (const r of CONSUMER_REPOS) {
      const segs = r.path.split(/[\\/]/);
      assert.ok(!segs.includes('worktrees'),
        `${r.alias} resolved into a worktree: ${r.path}`);
    }
  });

  test('every consumer is a sibling of the main checkout', () => {
    const main = _internals.SIBLING_ANCHOR;
    for (const r of CONSUMER_REPOS) {
      // Absolute entries in consumer-repos.local.json are used verbatim and are
      // legitimately anywhere; only the relative-anchored ones are pinned here.
      if (path.dirname(r.path) !== path.dirname(main)) continue;
      assert.equal(path.dirname(r.path), path.dirname(main));
    }
    assert.ok(CONSUMER_REPOS.length > 0, 'guard is not vacuously passing on an empty registry');
  });
});

describe('containment refuses every source root, not just the running one', () => {
  test('sourceRepoRoots always contains the running checkout, deduped and absolute', () => {
    const roots = sourceRepoRoots();
    assert.ok(roots.includes(sourceRepoRoot()));
    assert.equal(new Set(roots).size, roots.length, 'no duplicates');
    for (const r of roots) assert.ok(path.isAbsolute(r), `${r} is not absolute`);
  });

  test('every source root is refused as a sync destination', () => {
    // In the main checkout this is one root; from a worktree it is two, and the
    // second (the main checkout) is precisely the one a worktree-only guard
    // would have let through once consumers started resolving against it.
    for (const root of sourceRepoRoots()) {
      assert.throws(() => assertNotSourceRepo(root, 'test'), /source repo/i,
        `${root} must be refused`);
      assert.throws(() => assertNotSourceRepo(path.join(root, 'scripts'), 'test'), /source repo/i,
        `${root}/scripts must be refused`);
    }
  });

  test('a sibling whose name merely prefixes a source root is NOT refused', () => {
    // path.relative, not startsWith — `<root>-other` is a different directory.
    //
    // Only the OUTERMOST roots can demonstrate this. A worktree lives inside the
    // main checkout, so `<worktree>-other` is still under main and is refused
    // for that reason — correctly, and it would mask the property being tested.
    const roots = sourceRepoRoots();
    const inside = (p, root) => {
      const rel = path.relative(root, p);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    const outermost = roots.filter(r => !roots.some(o => o !== r && inside(r, o)));
    assert.ok(outermost.length > 0, 'guard is not vacuously passing');
    for (const root of outermost) {
      assert.doesNotThrow(() => assertNotSourceRepo(`${root}-other`, 'test'));
    }
  });
});

describe('the local registry FILE is found off the main checkout too', () => {
  // The second half of the same bug, field-found 2026-08-28 shipping bc6487f6.
  // The 2026-07-30 fix above anchored the registry's consumer PATHS to the main
  // checkout; the lookup of the file that LISTS them still used the worktree's
  // own `scripts/lib`. That file is gitignored, so `git worktree add` never
  // populates it: a /ship from a worktree resolved only the committed
  // BASE_REPOS, silently dropped every private consumer, and still printed
  // `Targets: 2/2 reached · Errors: 0`.

  const LIB = ['scripts', 'lib'];

  test('in the main checkout there is exactly ONE candidate', () => {
    // Not two identical ones. A duplicate would make localRegistryStatus report
    // a `main-checkout` fallback on a run that never fell back — a lie in the
    // very line added to make the fallback visible.
    const root = path.join(tmp, 'main');
    const cands = registryCandidatesFor(path.join(root, ...LIB), root, root);
    assert.equal(cands.length, 1);
    assert.equal(cands[0].source, 'running-checkout');
  });

  test('from a worktree the main checkout is offered as a second candidate', () => {
    const main = path.join(tmp, 'main');
    const wt = path.join(main, '.claude', 'worktrees', 'wt');
    const cands = registryCandidatesFor(path.join(wt, ...LIB), wt, main);
    assert.deepEqual(cands.map((c) => c.source), ['running-checkout', 'main-checkout']);
    // Order is load-bearing: a worktree that DOES have its own registry must
    // keep using it, so the running checkout is tried first.
    assert.equal(cands[0].path, path.join(wt, ...LIB, LOCAL_REGISTRY_BASENAME));
    assert.equal(cands[1].path, path.join(main, ...LIB, LOCAL_REGISTRY_BASENAME));
  });

  test('the failing case: worktree has no registry, main checkout does', () => {
    // This is the exact production shape. Under the old lookup the answer was
    // `absent` and the private consumer silently vanished from the target list.
    const main = path.join(tmp, 'main');
    const wt = path.join(main, '.claude', 'worktrees', 'wt');
    const mainRegistry = path.join(main, ...LIB, LOCAL_REGISTRY_BASENAME);
    const candidates = registryCandidatesFor(path.join(wt, ...LIB), wt, main);

    const status = localRegistryStatus({ candidates, exists: (p) => p === mainRegistry });
    assert.equal(status.source, 'main-checkout');
    assert.equal(status.path, mainRegistry);
  });

  test('a worktree with its OWN registry keeps it — the fallback never overrides', () => {
    const main = path.join(tmp, 'main');
    const wt = path.join(main, '.claude', 'worktrees', 'wt');
    const candidates = registryCandidatesFor(path.join(wt, ...LIB), wt, main);
    // Both exist: first match must win.
    const status = localRegistryStatus({ candidates, exists: () => true });
    assert.equal(status.source, 'running-checkout');
  });

  test('neither present is `absent`, not an error — most machines have no registry', () => {
    const main = path.join(tmp, 'main');
    const wt = path.join(main, '.claude', 'worktrees', 'wt');
    const candidates = registryCandidatesFor(path.join(wt, ...LIB), wt, main);
    const status = localRegistryStatus({ candidates, exists: () => false });
    assert.deepEqual(status, { path: null, source: 'absent' });
  });

  test('the real running checkout reports a coherent status', () => {
    // Weak by design — the answer depends on the machine — but it pins the
    // contract that the reported path, when there is one, actually exists.
    const status = localRegistryStatus();
    assert.ok(['running-checkout', 'main-checkout', 'absent'].includes(status.source));
    if (status.source === 'absent') assert.equal(status.path, null);
    else assert.ok(fs.existsSync(status.path), `${status.path} was reported but does not exist`);
  });
});
