/**
 * @fileoverview Work-consumer report 2026-11-15, item 3: sessions stacked on one UNLANDED shared base all reported overlaps
 * on the base's own files. `claim --base <branch>` measures a session from its real fork point; what it inherited shows
 * once, collapsed (`inherited (N files)`), and a declared-path conflict is the first line under its branch.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, writeFile } from './helpers/fleet-repo.mjs';
import { setup, sessionRec } from './helpers/fleet-cli-harness.mjs';

after(cleanupFleetRoots);

/** `shared-base` (unlanded, unclaimed) touches base/x.txt and base/y.txt; each child adds its own file on top. */
function stackedFleet(n, { declareBase = true } = {}) {
  const s = setup();
  const r = s.fx.repo;
  git(['checkout', '-q', '-b', 'shared-base', 'main'], r);
  writeFile(r, 'base/x.txt', 'x\n'); writeFile(r, 'base/y.txt', 'y\n');
  git(['add', '--', 'base'], r); git(['commit', '-q', '-m', 'shared base'], r);
  for (let i = 1; i <= n; i += 1) {
    git(['checkout', '-q', '-b', `child-${i}`, 'shared-base'], r);
    writeFile(r, `child-${i}/f.txt`, `${i}\n`);
    git(['add', '--', `child-${i}`], r); git(['commit', '-q', '-m', `child ${i}`], r);
    const c = s.f(['claim', '--id', `child-${i}`, '--intent', `child ${i}`, '--paths', `child-${i}/**`, ...(declareBase ? ['--base', 'shared-base'] : [])]);
    assert.equal(c.status, 0, c.stdout + c.stderr);
  }
  git(['checkout', '-q', 'main'], r);
  return s;
}

describe('claim --base: overlap from the real fork point', () => {
  it('six sessions on one unlanded base report ZERO overlaps from the base, and one collapsed inherited line each', () => {
    const s = stackedFleet(6);
    const st = s.f(['status', '--json']);
    for (let i = 1; i <= 6; i += 1) {
      const it = st.json.status.items.find((x) => x.id === `child-${i}`);
      assert.deepEqual(it.overlaps, [], `child-${i} has no overlap`);
      assert.deepEqual(it.inherited.sort(), ['base/x.txt', 'base/y.txt']);
    }
    const text = s.f(['status']).stdout;
    assert.equal((text.match(/inherited \(2 files\) from declared stack base shared-base — commits it shares with that base, not counted as overlaps \(declared by claim --base, not verified/g) ?? []).length, 6);
    assert.doesNotMatch(text, /overlaps child-/);
    assert.equal(sessionRec(s.fx, 'child-1').source.baseRef, 'shared-base', 'recorded in the existing baseRef field');
  });

  it('without --base (the control) the same sessions overlap on the base files', () => {
    const s = stackedFleet(2, { declareBase: false });
    const it = s.f(['status', '--json']).json.status.items.find((x) => x.id === 'child-1');
    const o = it.overlaps.find((x) => x.with === 'child-2');
    assert.ok(o, JSON.stringify(it.overlaps));
    assert.deepEqual(o.files.sort(), ['base/x.txt', 'base/y.txt']);
  });

  it('a new claim on the base\'s files is not blocked by what the stacked sessions inherited', () => {
    const s = stackedFleet(2);
    git(['checkout', '-q', '-b', 'other', 'main'], s.fx.repo);
    const c = s.f(['claim', '--id', 'other', '--intent', 'touch base', '--paths', 'base/**']);
    assert.equal(c.status, 0, c.stdout + c.stderr);
  });

  it('a real declared-path conflict is the FIRST line under its branch', () => {
    const s = stackedFleet(2);
    // A session widens its claim onto child-1's paths (adopt mode warns and records it; nothing marks it known).
    git(['checkout', '-q', '-b', 'widener', 'main'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'widener', '--intent', 'w', '--paths', 'w/**']).status, 0);
    assert.equal(s.f(['claim', '--id', 'widener', '--paths', 'child-1/**']).status, 0);
    git(['checkout', '-q', 'main'], s.fx.repo);
    const lines = s.f(['status']).stdout.split('\n');
    for (const id of ['child-1', 'widener']) {
      const at = lines.findIndex((l) => l.startsWith(`${id} `));
      assert.ok(at >= 0, lines.join('\n'));
      assert.match(lines[at + 1], /^ {4}overlaps (child-1|widener) \(paths\)/, `${id}: the declared conflict is the first line, before intent`);
    }
  });

  /** child-1 claims stacked on shared-base BEFORE it commits (participant rule 1), then commits its own file. */
  function claimThenCommit({ swallow }) {
    const s = stackedFleet(1);
    const r = s.fx.repo;
    git(['checkout', '-q', '-b', 'late', 'shared-base'], r);
    assert.equal(s.f(['claim', '--id', 'late', '--intent', 'l', '--paths', 'late/**', '--base', 'shared-base']).status, 0);
    writeFile(r, 'late/f.txt', 'l\n'); writeFile(r, 'child-1/f.txt', 'clash\n');
    git(['add', '--', 'late', 'child-1'], r); git(['commit', '-q', '-m', 'late work'], r);
    git(['checkout', '-q', 'main'], r);
    swallow(r);
    return s.f(['status', '--json']).json.status.items.find((x) => x.id === 'late');
  }

  for (const [what, swallow] of [
    ['fast-forwarded onto the session\'s commits (equal tips, audit R2 H1/M2)', (r) => git(['branch', '-f', 'shared-base', 'late'], r)],
    ['moved past them (contains the head, audit R1 H9)', (r) => { git(['checkout', '-q', 'shared-base'], r); git(['merge', '-q', '--ff-only', 'late'], r); writeFile(r, 'z.txt', 'z\n'); git(['add', '--', 'z.txt'], r); git(['commit', '-q', '-m', 'z'], r); git(['checkout', '-q', 'main'], r); }],
  ]) {
    it(`a declared base ${what} is not the fork point: measured from the base, and said`, () => {
      const it = claimThenCommit({ swallow });
      assert.equal(it.inherited, undefined, 'nothing is counted as inherited');
      assert.ok(it.notes.some((n) => /shared-base already contains late's head, so it is not its fork point/.test(n)), JSON.stringify(it.notes));
      assert.ok(it.overlaps.some((o) => o.with === 'child-1' && o.files.includes('child-1/f.txt')), 'the real file overlap is kept');
    });
  }

  it('control: the same session with its base NOT absorbing its work keeps the stacked measure', () => {
    const it = claimThenCommit({ swallow: () => {} });
    assert.ok(it.inherited?.length > 0);
    assert.ok(it.overlaps.some((o) => o.with === 'child-1' && o.files.includes('child-1/f.txt')), 'its own edit of child-1/f.txt still overlaps');
  });

  it('--base refuses a branch that does not exist, and the session\'s own branch', () => {
    const s = setup();
    git(['checkout', '-q', '-b', 'feat', 'main'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'feat', '--intent', 'x', '--paths', 'x/**', '--base', 'nope']).status, 2);
    assert.equal(s.f(['claim', '--id', 'feat', '--intent', 'x', '--paths', 'x/**', '--base', 'feat']).status, 2);
  });
});
