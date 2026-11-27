/**
 * @fileoverview Work-consumer report 2026-11-15, item 3: sessions stacked on one UNLANDED shared base all reported overlaps
 * on the base's own files. `claim --base <branch>` measures a session from its real fork point; what it inherited shows
 * once, collapsed (`inherited (N files)`), and a declared-path conflict is the first line under its branch.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
    assert.equal((text.match(/inherited \(2 files\) from stack base shared-base — commits it shares with that base, not counted as overlaps \(fork point recorded at claim, by --base or inferred from ancestry, not re-verified/g) ?? []).length, 6);
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

  /**
   * `late` stacks on shared-base with one commit of its own, commits the clashing work (before or after its claim), then the
   * base absorbs it. (A claim needs a commit of its own beyond the base to record a fork point — #379 review.)
   */
  function absorbed({ commitBeforeClaim, swallow }) {
    const s = stackedFleet(1);
    const r = s.fx.repo;
    git(['checkout', '-q', '-b', 'late', 'shared-base'], r);
    writeFile(r, 'late/own.txt', 'o\n'); git(['add', '--', 'late'], r); git(['commit', '-q', '-m', 'late own'], r);
    const commit = () => { writeFile(r, 'late/f.txt', 'l\n'); writeFile(r, 'child-1/f.txt', 'clash\n'); git(['add', '--', 'late', 'child-1'], r); git(['commit', '-q', '-m', 'late work'], r); };
    if (commitBeforeClaim) commit();
    assert.equal(s.f(['claim', '--id', 'late', '--intent', 'l', '--paths', 'late/**', '--base', 'shared-base']).status, 0);
    if (!commitBeforeClaim) commit();
    git(['checkout', '-q', 'main'], r);
    swallow(r);
    return { s, it: s.f(['status', '--json']).json.status.items.find((x) => x.id === 'late') };
  }
  const ff = (r) => git(['branch', '-f', 'shared-base', 'late'], r);
  const past = (r) => { git(['checkout', '-q', 'shared-base'], r); git(['merge', '-q', '--ff-only', 'late'], r); writeFile(r, 'z.txt', 'z\n'); git(['add', '--', 'z.txt'], r); git(['commit', '-q', '-m', 'z'], r); git(['checkout', '-q', 'main'], r); };

  for (const [what, opts] of [
    ['fast-forwarded onto commits made after the claim (audit R2 H1)', { commitBeforeClaim: false, swallow: ff }],
    ['moved past them (audit R1 H9)', { commitBeforeClaim: false, swallow: past }],
    ['fast-forwarded onto commits made BEFORE the claim (audit R3 H1/M1)', { commitBeforeClaim: true, swallow: ff }],
  ]) {
    it(`a base ${what}: the session is still measured from its recorded fork point, its own files kept`, () => {
      const { it } = absorbed(opts);
      assert.deepEqual([...it.inherited].sort(), ['base/x.txt', 'base/y.txt'], 'only the base files from before the claim are inherited');
      assert.ok(it.overlaps.some((o) => o.with === 'child-1' && o.files.includes('child-1/f.txt')), JSON.stringify(it.overlaps));
    });
  }

  it('re-running claim --base after the base absorbed the work KEEPS the recorded fork point (audit R4 H1/H4)', () => {
    const { s } = absorbed({ commitBeforeClaim: false, swallow: ff });
    git(['checkout', '-q', 'late'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'late', '--base', 'shared-base']).status, 0);
    git(['checkout', '-q', 'main'], s.fx.repo);
    const it = s.f(['status', '--json']).json.status.items.find((x) => x.id === 'late');
    assert.ok(it.overlaps.some((o) => o.with === 'child-1' && o.files.includes('child-1/f.txt')), JSON.stringify(it.overlaps));
  });

  /** `late` off shared-base commits its own file and a clash with child-1, then the base absorbs it BEFORE the claim. */
  function absorbedBeforeClaim(swallow) {
    const s = stackedFleet(1);
    const r = s.fx.repo;
    git(['checkout', '-q', '-b', 'late', 'shared-base'], r);
    writeFile(r, 'late/f.txt', 'l\n'); writeFile(r, 'child-1/f.txt', 'clash\n');
    git(['add', '--', 'late', 'child-1'], r); git(['commit', '-q', '-m', 'late work'], r);
    git(['checkout', '-q', 'main'], r);
    swallow(r);
    git(['checkout', '-q', 'late'], r);
    const c = s.f(['claim', '--id', 'late', '--intent', 'l', '--paths', 'late/**', '--base', 'shared-base']);
    git(['checkout', '-q', 'main'], r);
    const records = fs.readdirSync(path.join(r, '.git', 'fleet', 'stack-bases'));
    return { s, c, records, it: s.f(['status', '--json']).json.status.items.find((x) => x.id === 'late') };
  }

  for (const [what, swallow, why] of [
    ['fast-forwarded onto the session\'s tip', ff, /late and shared-base point at the same commit/],
    ['moved past the session\'s tip', past, /shared-base's tip is not an ancestor of late/],
  ]) {
    it(`a base ${what} BEFORE the claim: no fork point is recorded, overlap keeps the session's files, and it says why (#379 review)`, () => {
      const { c, records, it } = absorbedBeforeClaim(swallow);
      assert.equal(c.status, 0, c.stdout + c.stderr);
      assert.match(c.stderr, /warning: fleet claim --base shared-base: fork point not recorded — /);
      assert.match(c.stderr, why);
      assert.equal(records.length, 1, `only child-1's record: ${records}`);
      assert.equal(it.inherited, undefined, 'nothing is classed as inherited');
      assert.ok(it.overlaps.some((o) => o.with === 'child-1' && o.files.includes('child-1/f.txt')), JSON.stringify(it.overlaps));
    });
  }

  it('a fresh branch claimed at the base\'s tip records nothing until a re-claim after its first commit', () => {
    const s = stackedFleet(1);
    const r = s.fx.repo;
    git(['checkout', '-q', '-b', 'fresh', 'shared-base'], r);
    const c = s.f(['claim', '--id', 'fresh', '--intent', 'f', '--paths', 'fresh/**', '--base', 'shared-base', '--json']);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.match(c.json.stackBaseWarning, /point at the same commit/);
    writeFile(r, 'fresh/f.txt', 'f\n'); git(['add', '--', 'fresh'], r); git(['commit', '-q', '-m', 'fresh'], r);
    const again = s.f(['claim', '--id', 'fresh', '--base', 'shared-base']);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.doesNotMatch(again.stderr, /fork point not recorded/);
    git(['checkout', '-q', 'main'], r);
    const it = s.f(['status', '--json']).json.status.items.find((x) => x.id === 'fresh');
    assert.deepEqual([...it.inherited].sort(), ['base/x.txt', 'base/y.txt']);
  });

  it('a fork-point write that throws on the --override path leaves no session written (#379 review)', () => {
    const s = stackedFleet(1);
    const r = s.fx.repo;
    git(['checkout', '-q', '-b', 'ov', 'shared-base'], r);
    writeFile(r, 'ov/f.txt', 'o\n'); git(['add', '--', 'ov'], r); git(['commit', '-q', '-m', 'ov'], r);
    const claim = (extra) => s.f(['claim', '--id', 'ov', '--intent', 'o', '--paths', 'child-1/**', '--base', 'shared-base', ...extra]);
    assert.notEqual(claim([]).status, 0, 'control: without --override the claim is blocked');
    const sb = path.join(r, '.git', 'fleet', 'stack-bases');
    fs.rmSync(sb, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.writeFileSync(sb, 'not a directory'); // writeStackBase's mkdir now throws
    const before = JSON.stringify(sessionRec(s.fx, 'child-1'));
    assert.notEqual(claim(['--override']).status, 0);
    git(['checkout', '-q', 'main'], r);
    assert.equal(JSON.stringify(sessionRec(s.fx, 'child-1')), before, 'the other session\'s knownOverlaps were not written');
    assert.equal(sessionRec(s.fx, 'ov'), undefined, 'no session record for ov');
  });

  it('a base rewritten since the claim (recorded fork point no longer in it) is measured from the base, and said (audit R6)', () => {
    const { s } = absorbed({ commitBeforeClaim: false, swallow: () => {} });
    git(['branch', '-f', 'shared-base', 'main'], s.fx.repo); // rewound: the recorded commit is no longer the base's history
    const it = s.f(['status', '--json']).json.status.items.find((x) => x.id === 'late');
    assert.equal(it.inherited, undefined);
    assert.ok(it.notes.some((n) => /shared-base no longer contains the recorded fork point/.test(n)), JSON.stringify(it.notes));
  });

  it('a stacked claim with no recorded fork point (an older fleet) is measured from the base, and says so', () => {
    const { s, it: before } = absorbed({ commitBeforeClaim: false, swallow: () => {} });
    assert.ok(before.inherited?.length > 0, 'control: with the record, the stacked measure applies');
    fs.rmSync(path.join(s.fx.repo, '.git', 'fleet', 'stack-bases'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const it = s.f(['status', '--json']).json.status.items.find((x) => x.id === 'late');
    assert.equal(it.inherited, undefined);
    assert.ok(it.notes.some((n) => /stack base shared-base not measured \(no fork point recorded/.test(n)), JSON.stringify(it.notes));
  });

  it('the fork-point record is create-only: a repeat keeps the first, an invalid file is never replaced (audit R5)', async () => {
    const os = await import('node:os');
    const { writeStackBase, stackBaseFor, stackBasesDir } = await import('../scripts/lib/fleet/stack-bases.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sb-'));
    const A = 'a'.repeat(40); const B = 'b'.repeat(40);
    const sess = { id: 'late', gen: 1, source: { baseRef: 'shared-base' } };
    assert.equal(stackBaseFor(dir, sess).ok, false);
    assert.deepEqual(writeStackBase(dir, { id: 'late', gen: 1, base: 'shared-base', oid: A, at: 't' }), { created: true });
    assert.deepEqual(writeStackBase(dir, { id: 'late', gen: 1, base: 'shared-base', oid: B, at: 't' }), { created: false });
    assert.equal(stackBaseFor(dir, sess).oid, A, 'the first fork point stands');
    assert.equal(stackBaseFor(dir, { ...sess, gen: 2 }).ok, false, 'a new claim generation has none until it records one');
    assert.equal(stackBaseFor(dir, { ...sess, source: { baseRef: 'other' } }).ok, false, 'another base name is another key');
    const [file] = fs.readdirSync(stackBasesDir(dir));
    fs.writeFileSync(path.join(stackBasesDir(dir), file), '{not json');
    assert.deepEqual(writeStackBase(dir, { id: 'late', gen: 1, base: 'shared-base', oid: B, at: 't' }), { created: false });
    assert.equal(fs.readFileSync(path.join(stackBasesDir(dir), file), 'utf8'), '{not json', 'never overwritten');
    assert.match(stackBaseFor(dir, sess).reason, /unreadable/);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('--base refuses a branch that does not exist, and the session\'s own branch', () => {
    const s = setup();
    git(['checkout', '-q', '-b', 'feat', 'main'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'feat', '--intent', 'x', '--paths', 'x/**', '--base', 'nope']).status, 2);
    assert.equal(s.f(['claim', '--id', 'feat', '--intent', 'x', '--paths', 'x/**', '--base', 'feat']).status, 2);
  });
});
