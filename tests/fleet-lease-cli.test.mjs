/**
 * @fileoverview `fleet lease` through the REAL CLI: two throwaway repos sharing ONE machine directory (the point of
 * the verb). Slot sharing, expiry and the token fence. Plan: docs/plans/fleet-machine-lease.md.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupFleetRoots, runFleetAsync } from './helpers/fleet-repo.mjs';
import { T0_PLUS_2H, deadPid, tokenOf, world } from './helpers/fleet-lease-world.mjs';

after(cleanupFleetRoots);

describe('the slot is shared between repos', () => {
  it('a second repo is refused while the first holds it, even with the SAME session name; release frees it', () => {
    const w = world();
    const first = w.runA(['lease', 'acquire', '--for', '30', '--kind', 'gate', '--note', 'full gate']);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.match(first.stdout, /heavy slot granted to main/);
    const second = w.runB(['lease', 'acquire', '--for', '10']);
    assert.equal(second.status, 3, second.stdout);
    assert.match(second.stdout, /held by main \(/);
    const stat = w.runB(['lease', 'status']);
    assert.equal(stat.status, 0);
    assert.match(stat.stdout, /HELD by main/);
    assert.doesNotMatch(stat.stdout, /\[this repo\]/, 'repo B is not the holder');
    assert.match(w.runA(['lease', 'status']).stdout, /\[this repo\]/);
    assert.equal(w.runB(['lease', 'release']).status, 3, 'repo B named main too, but it is not the holder');
    assert.equal(w.runA(['lease', 'release']).status, 0);
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 0);
  });

  it('two concurrent acquires from two repos grant exactly one', async () => {
    const w = world();
    const mk = (repo) => runFleetAsync(['lease', 'acquire', '--for', '15'], { cwd: repo.repo, env: w.env() });
    const [x, y] = await Promise.all([mk(w.a), mk(w.b)]);
    assert.deepEqual([x.status, y.status].sort(), [0, 3], `${x.stdout}${y.stdout}`);
  });

  it('fleet next in the other repo says who holds the slot, and is silent when it is free', () => {
    const w = world();
    assert.doesNotMatch(w.runB(['next']).stdout, /machine lease/, 'measured and free: silent');
    assert.equal(w.runA(['lease', 'acquire', '--for', '30', '--note', 'full gate']).status, 0);
    const next = w.runB(['next']);
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, /machine lease: heavy slot: HELD by main \(.*\) for gate until 20:30Z \(in 30m\) — full gate — `.*lease status`/);
    const json = w.runB(['next', '--json']).json;
    assert.equal(json.lease.heavy.state, 'held'); assert.equal(json.lease.holder.holder, 'main');
    assert.equal('events' in json.lease, false);
  });
});

describe('expiry is not proof the process stopped (D4)', () => {
  const acquireAt0 = (w, extra = []) => {
    const r = w.runA(['lease', 'acquire', '--for', '30', ...extra]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return r;
  };

  it('an expired lease whose recorded pid is still running refuses; a dead pid is taken over and recorded', () => {
    const w = world();
    acquireAt0(w, ['--pid', String(process.pid)]);
    const alive = w.runB(['lease', 'acquire', '--for', '10'], { FLEET_NOW: T0_PLUS_2H });
    assert.equal(alive.status, 3, alive.stdout);
    assert.match(alive.stdout, /still running/);

    const w2 = world();
    acquireAt0(w2, ['--pid', String(deadPid())]);
    const gone = w2.runB(['lease', 'acquire', '--for', '10'], { FLEET_NOW: T0_PLUS_2H });
    assert.equal(gone.status, 0, gone.stdout + gone.stderr);
    assert.match(gone.stdout, /taken over/);
    assert.equal(w2.read().events.at(-1).kind, 'taken-over');
  });

  it('attach records the job\'s pid after the fact; an expired lease with no pid is unverifiable until a person forces it', () => {
    const w = world();
    const got = acquireAt0(w);
    assert.match(got.stdout, /no pid recorded/);
    const att = w.runA(['lease', 'attach', '--pid', String(process.pid), '--token', tokenOf(got)]);
    assert.equal(att.status, 0, att.stdout + att.stderr);
    assert.equal(w.read().heavy.pid, process.pid);
    assert.equal(w.runB(['lease', 'acquire'], { FLEET_NOW: T0_PLUS_2H }).status, 3, 'attached live pid refuses');

    const w2 = world();
    acquireAt0(w2);
    const unv = w2.runB(['lease', 'acquire'], { FLEET_NOW: T0_PLUS_2H });
    assert.equal(unv.status, 3); assert.match(unv.stdout, /no pid was recorded/);
    assert.equal(w2.runB(['lease', 'release', '--force'], { FLEET_NOW: T0_PLUS_2H }).status, 2, '--force needs --reason');
    const forced = w2.runB(['lease', 'release', '--force', '--reason', 'owner confirmed the gate is gone'], { FLEET_NOW: T0_PLUS_2H });
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    assert.equal(w2.read().events.at(-1).kind, 'forced-release');
    assert.equal(w2.runB(['lease', 'acquire'], { FLEET_NOW: T0_PLUS_2H }).status, 0);
  });

  it('never forces a live lease', () => {
    const w = world();
    acquireAt0(w);
    const r = w.runB(['lease', 'release', '--force', '--reason', 'impatient']);
    assert.equal(r.status, 3); assert.match(r.stdout, /has not expired/);
    assert.ok(w.read().heavy, 'the slot is still held');
  });
});

describe('the token fence', () => {
  it('a stale token is refused and the current one works; an acquire without a token rotates it', () => {
    const w = world();
    const t1 = tokenOf(w.runA(['lease', 'acquire']));
    assert.match(t1, /^[0-9a-f]{16}$/);
    const t2 = tokenOf(w.runA(['lease', 'acquire']));
    assert.notEqual(t2, t1, 'a bare re-acquire rotates the token');
    const stale = w.runA(['lease', 'release', '--token', t1]);
    assert.equal(stale.status, 3); assert.match(stale.stdout, /stale fence/);
    assert.equal(w.runA(['lease', 'acquire', '--token', t2, '--for', '60']).status, 0, 'the matching token renews');
    assert.equal(w.read().heavy.token, t2);
    assert.equal(w.runA(['lease', 'release', '--token', t2]).status, 0);
  });
});

