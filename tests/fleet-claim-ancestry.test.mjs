/**
 * @fileoverview Work-consumer report 2026-11-27: claims made on branches stacked over an UNLANDED parent recorded base
 * `main` and were BLOCKED by the parent's own claim (three sessions held for hours). A claim without `--base` is now based
 * on the nearest registered branch it descends from, and that ancestor's claim never blocks it; an unrelated session's
 * overlap still does. Also: `appendOnlyGlobs` is never read by a claim, and the BLOCKED hint now says so.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, writeFile } from './helpers/fleet-repo.mjs';
import { setup, sessionRec } from './helpers/fleet-cli-harness.mjs';
import { nearestOf } from '../scripts/lib/fleet/stack-ancestry.mjs';
import { decideClaim } from '../scripts/lib/fleet/overlap.mjs';
import { sharedFilesHint } from '../scripts/lib/fleet/render.mjs';

after(cleanupFleetRoots);

const commit = (r, file, msg = file) => { writeFile(r, file, `${msg}\n`); git(['add', '--', file], r); git(['commit', '-q', '-m', msg], r); };
const stackRecords = (fx) => { try { return fs.readdirSync(path.join(fx.repo, '.git', 'fleet', 'stack-bases')); } catch { return []; } };

/** `parent` (off main) claims p/** and goes ready; ends checked out on main. */
function withParent({ ready = true } = {}) {
  const s = setup();
  const r = s.fx.repo;
  git(['checkout', '-q', '-b', 'parent', 'main'], r);
  commit(r, 'p/a.txt');
  assert.equal(s.f(['claim', '--id', 'parent', '--intent', 'parent work', '--paths', 'p/**']).status, 0);
  if (ready) { const rd = s.f(['ready', '--id', 'parent']); assert.equal(rd.status, 0, rd.stdout + rd.stderr); }
  git(['checkout', '-q', 'main'], r);
  return s;
}

describe('claim without --base: the base is the nearest registered branch it descends from', () => {
  it('a child with commits of its own records the parent and its fork point', () => {
    const s = withParent();
    const r = s.fx.repo;
    git(['checkout', '-q', '-b', 'child', 'parent'], r);
    commit(r, 'c/a.txt');
    const c = s.f(['claim', '--id', 'child', '--intent', 'child work', '--paths', 'c/**', '--json']);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.equal(c.json.stackBaseInferred, 'parent');
    assert.equal(sessionRec(s.fx, 'child').source.baseRef, 'parent');
    assert.equal(stackRecords(s.fx).length, 1, 'fork point recorded');
  });

  it('a FRESH child (no commits) records the parent, no fork point, and a re-claim after its first commit records it', () => {
    const s = withParent();
    const r = s.fx.repo;
    git(['checkout', '-q', '-b', 'child', 'parent'], r);
    const c = s.f(['claim', '--id', 'child', '--intent', 'child work', '--paths', 'c/**', '--json']);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.equal(sessionRec(s.fx, 'child').source.baseRef, 'parent');
    assert.match(c.json.stackBaseWarning, /point at the same commit.*re-run claim after the session's first commit/);
    assert.equal(stackRecords(s.fx).length, 0);
    commit(r, 'c/a.txt');
    assert.equal(s.f(['claim', '--id', 'child']).status, 0);
    assert.equal(stackRecords(s.fx).length, 1, 'the re-claim recorded the fork point');
  });

  it('the nearest of a chain wins (grandparent → parent → child)', () => {
    const s = withParent();
    const r = s.fx.repo;
    git(['checkout', '-q', '-b', 'mid', 'parent'], r);
    commit(r, 'm/a.txt');
    assert.equal(s.f(['claim', '--id', 'mid', '--intent', 'mid work', '--paths', 'm/**']).status, 0);
    git(['checkout', '-q', '-b', 'child', 'mid'], r);
    commit(r, 'c/a.txt');
    assert.equal(s.f(['claim', '--id', 'child', '--intent', 'child work', '--paths', 'c/**']).status, 0);
    assert.equal(sessionRec(s.fx, 'child').source.baseRef, 'mid');
  });

  it('a branch off main records main (control), and a record stacked elsewhere is never silently re-pointed', () => {
    const s = withParent();
    const r = s.fx.repo;
    git(['checkout', '-q', '-b', 'solo', 'main'], r);
    commit(r, 's/a.txt');
    assert.equal(s.f(['claim', '--id', 'solo', '--intent', 'solo work', '--paths', 's/**']).status, 0);
    assert.equal(sessionRec(s.fx, 'solo').source.baseRef, 'main');
    // `other` is an unregistered branch named explicitly; `child` descends from `parent` too, but keeps the declared base.
    git(['checkout', '-q', '-b', 'other', 'parent'], r); commit(r, 'o/a.txt');
    git(['checkout', '-q', '-b', 'child', 'other'], r); commit(r, 'c/a.txt');
    assert.equal(s.f(['claim', '--id', 'child', '--intent', 'child work', '--paths', 'c/**', '--base', 'other']).status, 0);
    assert.equal(s.f(['claim', '--id', 'child']).status, 0);
    assert.equal(sessionRec(s.fx, 'child').source.baseRef, 'other');
  });

  it('two parents that cannot be ordered: no base is guessed, the warning names both, neither blocks', () => {
    const s = withParent();
    const r = s.fx.repo;
    git(['checkout', '-q', '-b', 'parent2', 'main'], r);
    commit(r, 'q/a.txt');
    assert.equal(s.f(['claim', '--id', 'parent2', '--intent', 'parent2 work', '--paths', 'q/**']).status, 0);
    git(['checkout', '-q', '-b', 'child', 'parent'], r);
    git(['merge', '-q', '--no-edit', 'parent2'], r);
    const c = s.f(['claim', '--id', 'child', '--intent', 'child work', '--paths', 'p/**,q/**', '--json']);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.deepEqual(c.json.stackBaseAmbiguous, ['parent', 'parent2']);
    assert.equal(sessionRec(s.fx, 'child').source.baseRef, 'main');
  });
});

describe('a claim is never blocked by its own ancestor', () => {
  it('a READY parent\'s claim does not block its child on the same paths (the reported case)', () => {
    const s = withParent();
    git(['checkout', '-q', '-b', 'child', 'parent'], s.fx.repo);
    const c = s.f(['claim', '--id', 'child', '--intent', 'child work', '--paths', 'p/**', '--json']);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.deepEqual(c.json.conflicts, []);
    assert.match(c.text ?? c.json.text, /stacked on parent \(its unlanded branch is history of this one\)/);
  });

  it('an UNRELATED session on the same paths still blocks (negative control)', () => {
    const s = withParent();
    git(['checkout', '-q', '-b', 'sibling', 'main'], s.fx.repo);
    const c = s.f(['claim', '--id', 'sibling', '--intent', 'sibling work', '--paths', 'p/**', '--json']);
    assert.equal(c.status, 3, c.stdout + c.stderr);
    assert.equal(c.json.verdict, 'blocked');
  });

  it('two fresh siblings at main never exempt each other', () => {
    const s = setup();
    const r = s.fx.repo;
    git(['checkout', '-q', '-b', 'a', 'main'], r);
    assert.equal(s.f(['claim', '--id', 'a', '--intent', 'a work', '--paths', 'x/**']).status, 0);
    git(['checkout', '-q', '-b', 'b', 'main'], r);
    assert.equal(s.f(['claim', '--id', 'b', '--intent', 'b work', '--paths', 'x/**']).status, 3);
  });
});

describe('pure parts', () => {
  const A = { id: 'a', branch: 'a', oid: '1'.repeat(40) };
  const B = { id: 'b', branch: 'b', oid: '2'.repeat(40) };
  it('nearestOf: one independent tip held by one session is the nearest; otherwise ambiguous', () => {
    assert.deepEqual(nearestOf([A, B], [B.oid]), { nearest: B, ambiguous: null });
    assert.deepEqual(nearestOf([A, B], [A.oid, B.oid]), { nearest: null, ambiguous: ['a', 'b'] });
    assert.deepEqual(nearestOf([A, { ...B, oid: A.oid }], [A.oid]), { nearest: null, ambiguous: ['a', 'b'] });
    assert.deepEqual(nearestOf([], []), { nearest: null, ambiguous: null });
  });

  it('decideClaim: an ancestor is skipped and disclosed; every other session is judged as before', () => {
    const sess = (id) => ({ session: { id, state: 'ready', intent: id, paths: ['p/**'], knownOverlaps: [] }, live: true, changedFiles: ['p/a.txt'] });
    const v = decideClaim({ claim: { id: 'child', intent: 'c', paths: ['p/**'] }, mode: 'new', others: [sess('parent'), sess('other')], complete: true, ancestors: ['parent'] });
    assert.equal(v.verdict, 'blocked');
    assert.deepEqual(v.conflicts.map((c) => c.with), ['other']);
    assert.deepEqual(v.stackedOn, [{ with: 'parent' }]);
    const control = decideClaim({ claim: { id: 'child', intent: 'c', paths: ['p/**'] }, mode: 'new', others: [sess('parent')], complete: true });
    assert.equal(control.verdict, 'blocked', 'without the ancestry the parent blocks');
  });

  it('sharedFilesHint names blocking files that match appendOnlyGlobs and points at hotFiles', () => {
    const v = { verdict: 'blocked', conflicts: [{ with: 'x', via: ['paths', 'files'], paths: [['docs/log.md', 'docs/**']], files: ['docs/log.md'], known: false }] };
    const h = sharedFilesHint(v, { appendOnlyGlobs: ['docs/*.md'], hotFiles: [] });
    assert.match(h, /docs\/log\.md matches \.fleet\.json appendOnlyGlobs, which applies only when fleet lands, restacks or rolls up — never to a claim.*hotFiles/);
    assert.equal(sharedFilesHint(v, { appendOnlyGlobs: ['other/**'], hotFiles: [] }), null, 'no match ⇒ no hint (configured repo)');
  });
});
