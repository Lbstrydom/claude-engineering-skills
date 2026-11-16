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

  it('a declared base that already contains the session\'s head is not its fork point: measured from the base, and said (audit R1 H9)', () => {
    const s = stackedFleet(2, { declareBase: false });
    git(['branch', 'swallowed', 'child-1'], s.fx.repo); // a branch that holds child-1's own commit
    git(['checkout', '-q', 'swallowed'], s.fx.repo);
    writeFile(s.fx.repo, 'other.txt', 'o\n'); git(['add', '--', 'other.txt'], s.fx.repo); git(['commit', '-q', '-m', 'later'], s.fx.repo);
    git(['checkout', '-q', 'child-1'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'child-1', '--base', 'swallowed']).status, 0);
    git(['checkout', '-q', 'main'], s.fx.repo);
    const st = s.f(['status', '--json']).json.status;
    const it = st.items.find((x) => x.id === 'child-1');
    assert.equal(it.inherited, undefined, 'nothing is counted as inherited');
    assert.ok(it.notes.some((n) => /swallowed already contains child-1's head, so it is not its fork point/.test(n)), JSON.stringify(it.notes));
    assert.ok(it.overlaps.some((o) => o.with === 'child-2'), 'its overlap evidence is kept');
  });

  it('--base refuses a branch that does not exist, and the session\'s own branch', () => {
    const s = setup();
    git(['checkout', '-q', '-b', 'feat', 'main'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'feat', '--intent', 'x', '--paths', 'x/**', '--base', 'nope']).status, 2);
    assert.equal(s.f(['claim', '--id', 'feat', '--intent', 'x', '--paths', 'x/**', '--base', 'feat']).status, 2);
  });
});
