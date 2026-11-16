/**
 * @fileoverview Work-consumer report 2026-11-15, items 2 and 5:
 *  - a fast-tier probe (`land --dry-run --tier <name>`) builds the combined candidate, runs ONE tier, is never approvable,
 *    and `status` says when two or more ready branches were never tested together;
 *  - a ready mark on a branch ahead 0 of the base expires on its own, `land` leaves it out, `--include-stale` brings it back.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, tmpRoot } from './helpers/fleet-repo.mjs';
import { fleetDirOf, fwd, land, readyBranch, setup } from './helpers/fleet-cli-harness.mjs';
import { listTrains, probesDir } from '../scripts/lib/fleet/registry.mjs';
import { testedTogether, testedTogetherLine } from '../scripts/lib/fleet/tested-together.mjs';

after(cleanupFleetRoots);

const mark = (dir, name, { fail = false } = {}) => ({
  name, command: ['node', '-e', `require('fs').appendFileSync('${fwd(path.join(dir, `${name}.ran`))}','x')${fail ? ';process.exit(1)' : ''}`],
});
const ran = (dir, name) => (fs.existsSync(path.join(dir, `${name}.ran`)) ? fs.readFileSync(path.join(dir, `${name}.ran`), 'utf8').length : 0);

function twoReady(tiers) {
  const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers } } });
  readyBranch(s, 'feat-a', { 'feat-a/a.txt': 'A\n' });
  readyBranch(s, 'feat-b', { 'feat-b/b.txt': 'B\n' });
  return s;
}

describe('land --dry-run --tier: a fast-tier probe', () => {
  it('builds the combined candidate, runs ONLY the named tier, and can never be approved', () => {
    const dir = tmpRoot();
    const s = twoReady([mark(dir, 'fast'), mark(dir, 'full')]);
    const r = land(s, ['--dry-run', '--tier', 'fast']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(ran(dir, 'fast'), 1, 'the fast tier ran once');
    assert.equal(ran(dir, 'full'), 0, 'the full tier never ran');
    const t = r.json.train;
    assert.deepEqual(t.sources.map((x) => x.id), ['feat-a', 'feat-b'], 'both ready branches are in the candidate');
    assert.equal(t.phase, 'abandoned');
    assert.match(r.json.text, /^PROBE \(tier fast only, never approvable\) — green/m);
    // Not a train any reader of trains/ can see — approve finds nothing to approve.
    assert.equal(listTrains(fleetDirOf(s.fx)).trains.length, 0);
    assert.equal(listTrains(probesDir(fleetDirOf(s.fx))).trains.length, 1);
    const ap = s.f(['land', '--approve', t.trainId, '--json']);
    assert.notEqual(ap.status, 0, 'a probe id is never approvable');
    assert.equal(fs.existsSync(t.worktree), false, 'the probe worktree is removed');
  });

  it('a clash between two ready branches surfaces in the probe (conflict, exit 3) without running the full tier', () => {
    const dir = tmpRoot();
    const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers: [mark(dir, 'fast'), mark(dir, 'full')] } } });
    readyBranch(s, 'feat-a', { 'shared.txt': 'A\n' }, { paths: 'feat-a/**' });
    readyBranch(s, 'feat-b', { 'shared.txt': 'B\n' }, { paths: 'feat-b/**' });
    const r = land(s, ['--dry-run', '--tier', 'fast']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.json.text, /PROBE \(tier fast only, never approvable\) — CONFLICT at feat-b/);
    assert.equal(ran(dir, 'full'), 0);
  });

  it('a red probe exits 4; an unknown tier, or --tier without --dry-run, is refused', () => {
    const dir = tmpRoot();
    const s = twoReady([mark(dir, 'fast', { fail: true }), mark(dir, 'full')]);
    assert.equal(land(s, ['--dry-run', '--tier', 'fast']).status, 4);
    const unknown = land(s, ['--dry-run', '--tier', 'nope']);
    assert.equal(unknown.status, 3);
    assert.match(unknown.json.text, /no pre-land tier named "nope" \(pre-land tiers: fast, full\)/);
    assert.equal(land(s, ['--tier', 'fast']).status, 2);
  });

  it('status names ready branches never tested together, and stops once a probe covered them', () => {
    const dir = tmpRoot();
    const s = twoReady([mark(dir, 'fast'), mark(dir, 'full')]);
    const before = s.f(['status']);
    assert.match(before.stdout, /hint: 2 ready branches never tested together — `.* land --dry-run --tier fast`/);
    assert.equal(land(s, ['--dry-run', '--tier', 'fast']).status, 0);
    const afterProbe = s.f(['status']);
    assert.doesNotMatch(afterProbe.stdout, /never tested together/);
    assert.match(afterProbe.stdout, /ready set \(2 branches\) tested together in t-\d{14}-[0-9a-f]{4} \(fast\): green/);
  });
});

describe('testedTogether (pure)', () => {
  const r = [{ id: 'a', oid: '1'.repeat(40) }, { id: 'b', oid: '2'.repeat(40) }];
  const t = (sources, extra = {}) => ({ trainId: 't-1', createdAt: '2026-11-16T00:00:00Z', sources, tierResults: [{ name: 'fast', result: 'green' }], result: 'green', ...extra });
  it('under two ready branches says nothing', () => assert.equal(testedTogether(r.slice(0, 1), []), null));
  it('a moved head (different oid) is untested again', () => {
    const moved = testedTogether(r, [t([{ id: 'a', oid: '1'.repeat(40) }, { id: 'b', oid: '3'.repeat(40) }])]);
    assert.equal(moved.tested, false);
    assert.match(testedTogetherLine(moved, { probeTier: 'fast' }), /2 ready branches never tested together/);
  });
  it('a manifest that never reached a verdict does not count', () => {
    assert.equal(testedTogether(r, [t(r, { tierResults: [], result: null })]).tested, false);
    assert.equal(testedTogether(r, [t(r)]).tested, true);
  });
});

describe('a ready mark on a branch ahead 0 of the base is stale', () => {
  function aheadZero() {
    const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers: [{ name: 'default', command: ['node', '-e', 'process.exit(0)'] }] } } });
    git(['checkout', '-q', '-b', 'feat-z', 'main'], s.fx.repo); // no commit: ahead 0
    assert.equal(s.f(['claim', '--id', 'feat-z', '--intent', 'z', '--paths', 'z/**']).status, 0);
    assert.equal(s.f(['ready', '--id', 'feat-z']).status, 0);
    git(['checkout', '-q', 'main'], s.fx.repo);
    return s;
  }

  it('status shows it stale; land leaves it out and says how to bring it back', () => {
    const s = aheadZero();
    assert.match(s.f(['status']).stdout, /feat-z\s+\[ready \(stale — ahead 0 of base\)\]/);
    const r = land(s);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.json.text, /left out: 1 stale ready mark\(s\), ahead 0 of the base \(feat-z\) — `--include-stale` brings them back/);
    const sel = land(s, ['--select', 'feat-z']);
    assert.match(sel.json.text, /--include-stale` brings back a mark that is ahead 0 of the base/);
  });

  it('--include-stale brings it back into the train', () => {
    const s = aheadZero();
    const r = land(s, ['--include-stale']);
    assert.deepEqual(r.json.train.sources.map((x) => x.id), ['feat-z']);
  });
});
