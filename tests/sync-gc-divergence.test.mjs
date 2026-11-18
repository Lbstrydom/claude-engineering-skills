/**
 * @fileoverview Debt 489588c47264 — gc deleted a tooling file upstream RETIRED even when the consumer had EDITED it since we
 * last wrote it, while the write path has never overwritten such a file. `planGarbageCollection` now asks the divergence
 * question through a probe, and `executeGarbageCollection` re-checks the hash immediately before the unlink.
 *
 * (The "override" half of the original claim is not a defect: an override may never claim the tooling dir, and gc only
 * deletes there — `sync-overrides.mjs`; plan section 8.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planGarbageCollection, executeGarbageCollection, isManifestHash } from '../scripts/lib/sync-gc.mjs';

const TOOLING = 'scripts/.claude-skills';
const h = (c) => `sha256:${c.repeat(64)}`;
const A = h('a');
const B = h('b');
const P = (rel) => `${TOOLING}/lib/${rel}.mjs`;

const plan = (probes, priorFiles) => planGarbageCollection({
  priorFiles, intendedDests: new Set(), toolingDir: TOOLING, exists: () => false,
  probe: (rel) => probes[rel] ?? { state: 'absent' },
});

describe('planGarbageCollection with a probe — each state beside an ordinary deletable candidate', () => {
  const ORDINARY = P('ordinary');
  const prior = { [ORDINARY]: A };
  const probes = { [ORDINARY]: { state: 'present', hash: A } };

  it('present and unchanged: a deletion; the plan remembers the hash it was made against', () => {
    const r = plan(probes, prior);
    assert.deepEqual([r.deletions, r.divergedHeld, r.probeFailed], [[ORDINARY], [], []]);
    assert.equal(r.probedHash[ORDINARY], A);
  });

  it('present but EDITED since we wrote it: held, never a deletion (red: the parent deleted it)', () => {
    const edited = P('edited');
    const r = plan({ ...probes, [edited]: { state: 'present', hash: B } }, { ...prior, [edited]: A });
    assert.deepEqual(r.divergedHeld, [edited]);
    assert.deepEqual(r.deletions, [ORDINARY], 'the ordinary candidate is unaffected');
    // The parent: no probe, every tooling-dir candidate is a deletion.
    const parent = planGarbageCollection({ priorFiles: { ...prior, [edited]: A }, intendedDests: new Set(), toolingDir: TOOLING, exists: () => false });
    assert.equal(parent.deletions.includes(edited), true, 'red evidence: with no probe the edited file is deleted');
  });

  it('a malformed stored base is its OWN disposition, never a deletion', () => {
    const odd = P('oddbase');
    for (const bad of ['garbage', 'sha256:short', '', null, 42]) {
      const r = plan({ [odd]: { state: 'present', hash: B } }, { [odd]: bad });
      assert.deepEqual([r.unknownBaseHeld, r.deletions, r.divergedHeld], [[odd], [], []], JSON.stringify(bad));
    }
  });

  it('already gone: dropped quietly (the goal state), nothing to delete or hold', () => {
    const gone = P('gone');
    const r = plan({}, { [gone]: A });
    assert.deepEqual([r.alreadyAbsent, r.deletions, r.probeFailed], [[gone], [], []]);
  });

  for (const state of ['refused', 'failed']) {
    it(`${state}: reported in probeFailed so the caller skips gc for the WHOLE target`, () => {
      const bad = P(state);
      const r = plan({ ...probes, [bad]: { state, reason: 'x' } }, { ...prior, [bad]: A });
      assert.equal(r.probeFailed.length, 1);
      assert.match(r.probeFailed[0].reason, new RegExp(state));
      assert.deepEqual(r.deletions, [ORDINARY], 'the plan still lists it; refusing to run is the caller\'s decision');
    });
  }

  it('a key outside the tooling dir stays advisory (never probed, never deleted) — unchanged behaviour', () => {
    let probed = 0;
    const r = planGarbageCollection({ priorFiles: { 'docs/x.md': A }, intendedDests: new Set(), toolingDir: TOOLING, exists: () => true, probe: () => { probed++; return { state: 'absent' }; } });
    assert.deepEqual([r.orphanedTracked, r.deletions, probed], [['docs/x.md'], [], 0]);
  });
});

describe('executeGarbageCollection — the hash is re-checked immediately before the unlink', () => {
  const deleted = [];
  const unlink = (abs) => { deleted.push(abs); };
  const contain = ({ relPath }) => `/root/${relPath}`;

  it('unchanged since the plan: deleted', () => {
    deleted.length = 0;
    const r = executeGarbageCollection({ root: '/root', deletions: [P('a')], unlink, contain, expectHash: { [P('a')]: A }, hashFile: () => A });
    assert.deepEqual([r.deleted, r.held, deleted.length], [[P('a')], [], 1]);
  });

  it('changed between the probe and the unlink: HELD, not deleted (a deterministic change at the boundary)', () => {
    deleted.length = 0;
    const r = executeGarbageCollection({ root: '/root', deletions: [P('a')], unlink, contain, expectHash: { [P('a')]: A }, hashFile: () => B });
    assert.deepEqual([r.deleted, r.held, deleted.length], [[], [P('a')], 0]);
  });

  it('vanished before the re-check: absent; unreadable at the re-check: failed (never deleted on a guess)', () => {
    deleted.length = 0;
    const enoent = executeGarbageCollection({ root: '/root', deletions: [P('a')], unlink, contain, expectHash: { [P('a')]: A }, hashFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
    assert.deepEqual([enoent.absent, enoent.failed.length, deleted.length], [[P('a')], 0, 0]);
    const eio = executeGarbageCollection({ root: '/root', deletions: [P('a')], unlink, contain, expectHash: { [P('a')]: A }, hashFile: () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } });
    assert.deepEqual([eio.failed.length, deleted.length], [1, 0]);
  });

  it('with no expectHash it behaves as before (existing callers)', () => {
    deleted.length = 0;
    const r = executeGarbageCollection({ root: '/root', deletions: [P('a')], unlink, contain });
    assert.deepEqual([r.deleted, r.held], [[P('a')], []]);
  });
});

describe('isManifestHash', () => {
  it('accepts exactly sha256:<64 lowercase hex>', () => {
    assert.equal(isManifestHash(A), true);
    for (const bad of ['sha256:' + 'A'.repeat(64), 'sha1:' + 'a'.repeat(64), 'sha256:' + 'a'.repeat(63), undefined, {}]) assert.equal(isManifestHash(bad), false);
  });
});
