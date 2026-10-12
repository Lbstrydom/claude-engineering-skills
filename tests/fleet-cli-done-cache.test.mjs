/**
 * @fileoverview /fleet CLI end to end — the derived-done cache is decided inside
 * the lock against the CURRENT record. Split from tests/fleet-cli.test.mjs for
 * wall time; harness: tests/helpers/fleet-cli-harness.mjs.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupFleetRoots } from './helpers/fleet-repo.mjs';
import { OK_TIER, fleetDirOf, land, readyBranch, sessionRec, setup } from './helpers/fleet-cli-harness.mjs';
import { SessionSchema, readSessions, writeSession } from '../scripts/lib/fleet/registry.mjs';
import { approveTrain } from '../scripts/lib/fleet/train-approve.mjs';
import { defaultDeps } from '../scripts/lib/fleet/train.mjs';

after(cleanupFleetRoots);

describe('derived-done cache is decided INSIDE the lock against the current record', () => {
  const cfg = { mergeMethod: 'direct-squash', testCommand: { tiers: [OK_TIER] } };
  function landWith(hook) {
    const s = setup({ fleetConfig: cfg });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    readyBranch(s, 'feat-b', { 'b.txt': 'B\n' });
    const t = land(s).json.train;
    const dir = fleetDirOf(s.fx);
    const r = approveTrain({ cwd: s.fx.repo, trainId: t.trainId, deps: defaultDeps({ log: () => {}, hooks: { beforeDoneWrite: () => hook(dir, s) } }) });
    assert.equal(r.ok, true, JSON.stringify(r));
    return s;
  }

  it('a session RE-REGISTERED (gen bumped) between derivation and the write is NOT marked done; its sibling is', () => {
    const s = landWith((dir) => {
      const cur = readSessions(dir).sessions.find((x) => x.id === 'feat-a');
      writeSession(dir, SessionSchema.parse({ ...cur, rev: cur.rev + 1, gen: cur.gen + 1, state: 'working', ready: null }));
    });
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'working');
    assert.equal(sessionRec(s.fx, 'feat-a').gen, 2);
    assert.equal(sessionRec(s.fx, 'feat-b').state, 'done');
  });

  it('a session whose rev moved (touched) or whose ready.oid moved in between is NOT marked done', () => {
    const s = landWith((dir) => {
      const a = readSessions(dir).sessions.find((x) => x.id === 'feat-a');
      writeSession(dir, SessionSchema.parse({ ...a, rev: a.rev + 1 }));
      const b = readSessions(dir).sessions.find((x) => x.id === 'feat-b');
      writeSession(dir, SessionSchema.parse({ ...b, rev: b.rev + 1, ready: { oid: 'f'.repeat(40), at: b.ready.at } }));
    });
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'ready');
    assert.equal(sessionRec(s.fx, 'feat-b').state, 'ready');
  });

  it('control: with no interference both are marked done', () => {
    const s = landWith(() => {});
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'done');
    assert.equal(sessionRec(s.fx, 'feat-b').state, 'done');
  });
});
