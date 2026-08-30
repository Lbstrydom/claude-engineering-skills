/**
 * @fileoverview Is the main checkout's node_modules still the tree its own
 * package-lock.json describes?
 *
 * The pre-push sandbox links that tree instead of paying `npm ci`, so getting
 * this wrong is asymmetric in exactly the way its sibling
 * (prepush-dependency-identity.test.mjs) describes:
 *
 *   - **Install when you needn't** — ~45s on every push. This is what the
 *     replaced mtime heuristic did SYSTEMATICALLY, not occasionally: `npm
 *     install` writes package-lock.json last, so on a tree npm had just called
 *     "up to date in 6s" the lockfile was 2 minutes NEWER than `node_modules/`
 *     and the oracle read STALE. It then flipped back to FRESH when an
 *     unrelated tool created `node_modules/.cache` — same tree, opposite
 *     verdict, decided by a coin-flip on an unrelated event. On 2026-08-30 it
 *     landed on STALE, forced an `npm ci` that failed, and blocked the push.
 *   - **Link when you should have installed** — runs the entire `check` chain
 *     against a dependency tree nobody's lockfile describes, and reports GREEN.
 *
 * So both directions are pinned here, and every ambiguous input must still take
 * the expensive branch.
 *
 * Fixtures are DERIVED FROM THE REAL `package-lock.json` rather than
 * hand-written, and one test asserts the SHAPE of the real npm-written hidden
 * lockfile — because a hand-built fixture only ever encodes what the reader
 * expects, which is the assumption under test (AGENTS.md, prose↔code seam).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { installedTreeStale } from '../scripts/lib/installed-tree-identity.mjs';
import { findNodeModules } from '../scripts/lib/node-modules-resolver.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const REAL_LOCK = fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf-8');

/**
 * The hidden lockfile npm WOULD write for this repo's real root lockfile: every
 * declared entry except the root project and the optional deps this platform
 * skips. Derived, not typed out, so the fixture cannot drift from the lockfile.
 */
function conformantHiddenLock(rootText = REAL_LOCK, mutate = () => {}) {
  const root = JSON.parse(rootText);
  const packages = {};
  for (const [location, entry] of Object.entries(root.packages)) {
    if (location === '') continue;
    if (entry.optional === true || entry.devOptional === true) continue;
    packages[location] = entry;
  }
  const hidden = {
    name: root.name, version: root.version, lockfileVersion: 3, requires: true, packages,
  };
  mutate(hidden);
  return JSON.stringify(hidden);
}

/** Edit the real root lockfile the way a commit or an `npm install` would. */
function editedRootLock(mutate) {
  const doc = JSON.parse(REAL_LOCK);
  mutate(doc);
  return JSON.stringify(doc);
}

describe('installedTreeStale — on this repo\'s real package-lock.json', () => {
  it('a conformant installed tree LINKS — the verdict the mtime oracle got wrong', () => {
    const { stale, reason } = installedTreeStale(REAL_LOCK, conformantHiddenLock());
    assert.equal(stale, false, `a tree that matches its lockfile must link — got: ${reason}`);
  });

  it('optional deps skipped for this platform are NOT staleness', () => {
    // Measured 2026-08-30: the root lockfile declares 455 entries, the hidden
    // one records 410, and every one of the 45 absentees is flagged `optional`.
    // Counting keys instead of comparing content would install on every push.
    const root = JSON.parse(REAL_LOCK);
    const optional = Object.entries(root.packages)
      .filter(([loc, e]) => loc !== '' && (e.optional === true || e.devOptional === true));
    assert.ok(optional.length > 0, 'precondition: this repo really does have optional deps');

    const hidden = conformantHiddenLock();
    for (const [loc] of optional) {
      assert.equal(JSON.parse(hidden).packages[loc], undefined, `${loc} must be absent from the fixture`);
    }
    assert.equal(installedTreeStale(REAL_LOCK, hidden).stale, false);
  });

  it('an OPTIONAL dep added to the lockfile but not installed still LINKS', () => {
    const withOptional = editedRootLock((d) => {
      d.packages['node_modules/some-platform-only-thing'] = {
        version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', optional: true,
      };
    });
    assert.equal(installedTreeStale(withOptional, conformantHiddenLock()).stale, false);
  });
});

describe('installedTreeStale — the direction that must never be silent', () => {
  it('a REQUIRED dep in the lockfile but not installed INSTALLS', () => {
    const withNewDep = editedRootLock((d) => {
      d.packages['node_modules/left-pad'] = {
        version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
      };
    });
    const { stale, reason } = installedTreeStale(withNewDep, conformantHiddenLock());
    assert.equal(stale, true);
    assert.match(reason, /left-pad/);
  });

  it('a VERSION BUMP in the lockfile that the tree has not taken INSTALLS', () => {
    // The literal scenario in the module docblock: edit (or pull) the lockfile,
    // never re-run npm install.
    const name = Object.keys(JSON.parse(REAL_LOCK).packages).find((k) => k.startsWith('node_modules/'));
    const bumped = editedRootLock((d) => { d.packages[name].version = '0.0.0-not-a-real-version'; });
    const { stale, reason } = installedTreeStale(bumped, conformantHiddenLock());
    assert.equal(stale, true);
    assert.match(reason, /0\.0\.0-not-a-real-version/);
  });

  it('a package resolved from a DIFFERENT tarball at the same version INSTALLS', () => {
    const name = Object.keys(JSON.parse(REAL_LOCK).packages).find((k) => k.startsWith('node_modules/'));
    const repointed = editedRootLock((d) => { d.packages[name].resolved = 'https://evil.example/x.tgz'; });
    assert.equal(installedTreeStale(repointed, conformantHiddenLock()).stale, true);
  });

  it('a package installed that the lockfile does not declare INSTALLS', () => {
    const hidden = conformantHiddenLock(REAL_LOCK, (h) => {
      h.packages['node_modules/not-in-the-lockfile'] = { version: '1.0.0' };
    });
    assert.equal(installedTreeStale(REAL_LOCK, hidden).stale, true);
  });

  it('a HALF-INSTALLED tree INSTALLS — a subset must not read as a match', () => {
    // Direction 2's reason for existing. The 2026-08-30 sandbox was exactly
    // this: 234 of 236 top-level entries, missing .bin and the hidden lockfile.
    const hidden = conformantHiddenLock(REAL_LOCK, (h) => {
      for (const k of Object.keys(h.packages).slice(0, 5)) delete h.packages[k];
    });
    assert.equal(installedTreeStale(REAL_LOCK, hidden).stale, true);
  });
});

describe('installedTreeStale — fails CLOSED on every ambiguous input', () => {
  const conformant = conformantHiddenLock();

  for (const [label, root, hidden] of [
    ['hidden lockfile absent (never installed, or npm < 7)', REAL_LOCK, null],
    ['hidden lockfile unreadable', REAL_LOCK, undefined],
    ['hidden lockfile is not JSON', REAL_LOCK, '{'],
    ['hidden lockfile root is an array', REAL_LOCK, '[]'],
    ['hidden lockfile has no packages map (lockfileVersion 1)', REAL_LOCK, '{"lockfileVersion":1,"dependencies":{}}'],
    ['root lockfile absent', null, conformant],
    ['root lockfile is not JSON', 'nope', conformant],
    ['root lockfile has no packages map', '{"lockfileVersion":1,"dependencies":{}}', conformant],
  ]) {
    it(`${label} → install`, () => {
      const { stale, reason } = installedTreeStale(root, hidden);
      assert.equal(stale, true, `must install rather than assume: ${reason}`);
      assert.ok(reason.length > 0, 'the verdict must always carry a reason the caller can log');
    });
  }

  it('an entry of an unexpected shape → install', () => {
    const hidden = conformantHiddenLock(REAL_LOCK, (h) => {
      h.packages[Object.keys(h.packages)[0]] = 'not-an-object';
    });
    assert.equal(installedTreeStale(REAL_LOCK, hidden).stale, true);
  });
});

describe('the real npm-written hidden lockfile still has the shape this check reads', () => {
  // Shape only, never health: a genuinely stale tree on the machine running
  // these tests must not fail the suite. What IS asserted is the contract — if
  // npm changes where or how it records the installed tree, the oracle goes
  // silently blind and only this test can say so.
  // Resolved the way NODE does, never as `<repoRoot>/node_modules` — a git
  // worktree has none of its own and walks up to the main checkout's. Hard-coding
  // it is the exact defect lib/node-modules-resolver.mjs exists to stop, and this
  // suite reproduced it on its first run.
  const modules = findNodeModules(REPO_ROOT);
  const hiddenPath = modules ? path.join(modules, '.package-lock.json') : null;

  it('exists — node_modules is provisioned in every environment this suite runs in', () => {
    assert.ok(modules, `no node_modules resolved at or above ${REPO_ROOT}`);
    assert.ok(
      fs.existsSync(hiddenPath),
      `npm has written no hidden lockfile at ${hiddenPath}. If npm stopped maintaining it, `
      + 'installedTreeStale() now fails closed on every push and needs a new oracle.',
    );
  });

  it('is a lockfileVersion >= 2 document with a packages map keyed by install location', () => {
    const doc = JSON.parse(fs.readFileSync(hiddenPath, 'utf-8'));
    assert.ok(doc.lockfileVersion >= 2, `expected lockfileVersion >= 2, got ${doc.lockfileVersion}`);
    assert.equal(typeof doc.packages, 'object');
    const keys = Object.keys(doc.packages);
    assert.ok(keys.length > 0, 'the hidden lockfile records no packages at all');
    for (const k of keys) {
      assert.ok(k.startsWith('node_modules/'), `unexpected hidden-lockfile key shape: ${JSON.stringify(k)}`);
    }
  });

  it('records a subset of the root lockfile, and every absentee is optional', () => {
    // The premise direction 2 rests on. If npm ever legitimately omits a
    // NON-optional entry, that rule would force an install on every push.
    const hidden = JSON.parse(fs.readFileSync(hiddenPath, 'utf-8'));
    const root = JSON.parse(REAL_LOCK);
    const rootKeys = new Set(Object.keys(root.packages).filter((k) => k !== ''));
    const extra = Object.keys(hidden.packages).filter((k) => !rootKeys.has(k));
    assert.deepEqual(extra, [], 'the installed tree contains packages the lockfile does not declare');
  });
});
