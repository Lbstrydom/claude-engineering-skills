/**
 * @fileoverview `fleet lease` through the REAL CLI: two throwaway repos sharing ONE machine directory (the point of
 * the verb). Slot sharing, expiry and the token fence. Plan: docs/plans/fleet-machine-lease.md.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cleanupFleetRoots, runFleetAsync } from './helpers/fleet-repo.mjs';
import { T0, T0_PLUS_2H, deadPid, tokenOf, world } from './helpers/fleet-lease-world.mjs';

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
    // B is now waiting and A's turn survives a plain release for a short between-jobs gap (A may have a next job): B is
    // told it is A's turn; a holder with nothing further to run yields it.
    assert.equal(w.runA(['lease', 'release']).status, 0);
    const wait = w.runB(['lease', 'acquire', '--for', '10']);
    assert.equal(wait.status, 3, wait.stdout);
    assert.match(wait.stdout, /it is .* turn until/);
    assert.equal(w.runA(['lease', 'acquire', '--for', '10']).status, 0, 'A continues its batch');
    assert.equal(w.runA(['lease', 'release', '--end-turn']).status, 0);
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
  it('a stale token is refused and the current one works; an acquire without a token is refused while the slot is live (D12, finding 8182)', () => {
    const w = world();
    const t1 = tokenOf(w.runA(['lease', 'acquire']));
    assert.match(t1, /^[0-9a-f]{16}$/);
    // Two sessions of one checkout share the derived name: the second one's bare acquire must NOT take over the first one's job.
    const second = w.runA(['lease', 'acquire']);
    assert.equal(second.status, 3, second.stdout);
    assert.match(second.stdout, /already holds the slot until \d\d:\d\dZ; to extend it pass --token/);
    assert.match(second.stdout, /its own --id/);
    assert.doesNotMatch(second.stdout, /This repo is now waiting/, 'the same identity does not queue behind itself');
    assert.equal(w.read().heavy.token, t1, 'no rotation');
    const stale = w.runA(['lease', 'release', '--token', 'ffffffffffffffff']);
    assert.equal(stale.status, 3); assert.match(stale.stdout, /stale fence/);
    assert.equal(w.runA(['lease', 'acquire', '--token', t1, '--for', '60']).status, 0, 'the matching token renews');
    assert.equal(w.read().heavy.token, t1);
    assert.equal(w.runA(['lease', 'release', '--token', t1]).status, 0);
  });
  it('a renewal past the turn of the repo is refused while another repo waits, saying that the lease is not extended (D11, finding 20ec)', () => {
    const w = world();
    assert.equal(w.runA(['lease', 'turn', '--minutes', '15']).status, 0, 'a short turn, set before it starts');
    const t1 = tokenOf(w.runA(['lease', 'acquire', '--for', '30']));
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 3, 'repo B queues');
    const at = (min) => ({ FLEET_NOW: new Date(Date.parse(T0) + min * 60_000).toISOString() });
    assert.equal(w.runA(['lease', 'acquire', '--token', t1, '--for', '30'], at(10)).status, 0, 'inside the 15-minute turn a renewal is granted');
    const late = w.runA(['lease', 'acquire', '--token', t1, '--for', '30'], at(20));
    assert.equal(late.status, 3, late.stdout);
    assert.match(late.stdout, /this lease is not extended - finish and `lease release`/);
    assert.equal(w.read().heavy.token, t1, 'the job is not cut');
  });
});


describe('journal, waiting and the announce refusal through the real CLI (plan fleet-lease-turns-and-journal)', () => {
  it('a refused acquire is persisted: exit 3, the repo is queued, and `lease log` shows the episode in words', () => {
    const w = world();
    assert.equal(w.runA(['lease', 'acquire', '--for', '30']).status, 0);
    const refused = w.runB(['lease', 'acquire', '--for', '10']);
    assert.equal(refused.status, 3, refused.stdout);
    assert.match(refused.stdout, /This repo is now waiting for the slot/);
    const file = w.read();
    assert.equal(file.waiters.length, 1);
    assert.equal(file.waiters[0].refusals, 1);
    w.runB(['lease', 'acquire', '--for', '10']);
    assert.equal(w.read().waiters[0].refusals, 2, 'a repeat refusal bumps the count');
    assert.equal(w.read().journal.filter((e) => e.kind === 'waiting').length, 1, 'and adds no journal entry');
    const log = w.runB(['lease', 'log']);
    assert.equal(log.status, 0, log.stdout + log.stderr);
    assert.match(log.stdout, /acquired the slot \(granted(, no-waiters)?\)/);
    assert.match(log.stdout, /started waiting \(refusal, held/);
    const status = w.runB(['lease', 'status']);
    assert.match(status.stdout, /waiting: .* \(2 refusals, wants 10m\)/);
    assert.equal(w.runB(['lease', 'wait', '--cancel']).status, 0);
    assert.equal(w.read().waiters.length, 0);
    assert.match(w.runB(['lease', 'log']).stdout, /stopped waiting: cancelled/);
  });

  it('announce refuses a window over another repo\'s held slot (exit 3, names holder and expiry); --over-held records it acknowledged', () => {
    const w = world();
    assert.equal(w.runA(['lease', 'acquire', '--for', '40']).status, 0);
    const refused = w.runB(['lease', 'announce', '--kind', 'ci', '--until', '+30m']);
    assert.equal(refused.status, 3, refused.stdout);
    assert.match(refused.stdout, /held by main \(.*\) for gate until 20:40Z/);
    assert.equal(w.read().windows.length, 0, 'nothing was announced');
    assert.equal(w.read().journal.at(-1).kind, 'refused');
    const over = w.runB(['lease', 'announce', '--kind', 'ci', '--until', '+30m', '--over-held']);
    assert.equal(over.status, 0, over.stdout + over.stderr);
    assert.match(over.stdout, /recorded OVER the slot held by main/);
    assert.equal(w.read().windows[0].overHeld.holder, 'main');
  });

  it('wait queues the repo; log reports an empty journal honestly; flags that do not belong are refused', () => {
    const w = world();
    assert.match(w.runA(['lease', 'log']).stdout, /journal: empty/);
    const wt = w.runB(['lease', 'wait', '--for', '45', '--note', 'full suite']);
    assert.equal(wt.status, 0, wt.stdout + wt.stderr);
    assert.match(wt.stdout, /waiting since/);
    assert.equal(w.read().waiters[0].forMin, 45);
    assert.equal(w.runB(['lease', 'wait', '--kind', 'gate']).status, 2);
    assert.equal(w.runB(['lease', 'log', '--limit', '0']).status, 2);
    assert.equal(w.runB(['lease', 'wait', '--cancel', '--for', '5']).status, 2);
    const json = JSON.parse(w.runB(['lease', 'log', '--json']).stdout);
    assert.equal(json.measure.measured, true);
    assert.equal(json.measure.waits[0].open, true);
  });

  it('an older checkout\'s lease (no journal, no waiters) is read and extended without complaint', () => {
    const w = world();
    assert.equal(w.runA(['lease', 'acquire']).status, 0);
    const f = w.read();
    delete f.journal; delete f.waiters;
    fs.writeFileSync(w.leaseFile, JSON.stringify(f, null, 2));
    assert.equal(w.runB(['lease', 'status']).status, 0);
    assert.equal(w.runA(['lease', 'release']).status, 0);
    assert.equal(w.read().journal.at(-1).kind, 'released');
  });
});

describe('gaps and turns through the real CLI (plan fleet-lease-turns-and-journal D5, D6)', () => {
  it('a FREE slot is not a turn: the repo that waited longer is told it goes first, then gets the slot', () => {
    const w = world();
    // The clock advances between the requests: two waiters on the SAME tick are ordered by repoKey (a hash of the checkout
    // path), which would make this test depend on its temp directory name.
    assert.equal(w.runA(['lease', 'wait', '--for', '20']).status, 0);
    const early = w.runB(['lease', 'acquire', '--for', '10'], { FLEET_NOW: '2026-10-13T20:01:00.000Z' });
    assert.equal(early.status, 3, early.stdout);
    assert.match(early.stdout, /has waited since .* and goes first/);
    assert.match(early.stdout, /This repo is now waiting for the slot/);
    const mine = w.runA(['lease', 'acquire', '--for', '10'], { FLEET_NOW: '2026-10-13T20:02:00.000Z' });
    assert.equal(mine.status, 0, mine.stdout + mine.stderr);
    const status = w.runA(['lease', 'status'], { FLEET_NOW: '2026-10-13T20:02:00.000Z' });
    assert.match(status.stdout, /turn: .* until \d\d:\d\dZ/);
    assert.match(status.stdout, /waiting: /);
    const log = w.runA(['lease', 'log']).stdout;
    assert.match(log, /acquired the slot \(granted, head\)/);
    assert.match(log, /turn started until/);
  });

  /** Give each throwaway repo an explicit origin, so its display label is known and does not depend on the temp folder name. */
  const labelled = (w, a, b) => {
    // The fixture may already have an origin (a local bare repo): add it if absent, then point it at the label's URL.
    for (const [repo, label] of [[w.a.repo, a], [w.b.repo, b]]) {
      spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', `https://github.com/${label}.git`]);
      spawnSync('git', ['-C', repo, 'remote', 'set-url', 'origin', `https://github.com/${label}.git`]);
    }
  };

  it('grant lets a named repo through a window its owner announced; a longer request is still refused; only the owner grants', () => {
    const w = world();
    labelled(w, 'o/owner', 'o/grantee');
    assert.equal(w.runA(['lease', 'announce', '--kind', 'quiet', '--until', '+60m']).status, 0);
    const refused = w.runB(['lease', 'acquire', '--for', '10']);
    assert.equal(refused.status, 3);
    assert.match(refused.stdout, /announced a quiet window/);
    const id = w.read().windows[0].id;
    assert.equal(w.runB(['lease', 'grant', '--window', id, '--until', '+30m']).status, 3, 'B does not own the window');
    assert.equal(w.runA(['lease', 'grant', '--window', id, '--until', '+10m', '--to', 'nobody/known']).status, 3, 'a repo the lease has not seen cannot be named');
    assert.equal(w.runA(['lease', 'grant', '--until', '+10m']).status, 2, '--window is required');
    const g = w.runA(['lease', 'grant', '--window', id, '--until', '+30m', '--to', 'o/grantee']);
    assert.equal(g.status, 0, g.stdout + g.stderr);
    assert.match(g.stdout, /granted in window .* to o\/grantee/);
    const past = w.runB(['lease', 'acquire', '--for', '45']);
    assert.equal(past.status, 3);
    assert.match(past.stdout, /a gap is granted to you until/);
    const inside = w.runB(['lease', 'acquire', '--for', '10']);
    assert.equal(inside.status, 0, inside.stdout + inside.stderr);
    assert.match(w.runA(['lease', 'log']).stdout, /acquired the slot \(granted, gap\)/);
  });

  it('a label two checkouts share is refused as ambiguous, never guessed; an open gap needs no name', () => {
    const w = world();
    labelled(w, 'o/same', 'o/same');
    assert.equal(w.runA(['lease', 'announce', '--kind', 'quiet', '--until', '+60m']).status, 0);
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 3);
    const id = w.read().windows[0].id;
    const ambiguous = w.runA(['lease', 'grant', '--window', id, '--until', '+30m', '--to', 'o/same']);
    assert.equal(ambiguous.status, 3);
    assert.match(ambiguous.stdout, /more than one repo on this machine is labelled/);
    assert.equal(w.runA(['lease', 'grant', '--window', id, '--until', '+30m']).status, 0);
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 0);
  });

  it('turn sets and clears the machine turn length; release --end-turn yields the turn; bad combinations are argument errors', () => {
    const w = world();
    assert.equal(w.runA(['lease', 'turn', '--minutes', '5']).status, 2);
    assert.equal(w.runA(['lease', 'turn']).status, 2);
    assert.equal(w.runA(['lease', 'turn', '--minutes', '90', '--clear']).status, 2);
    const set = w.runA(['lease', 'turn', '--minutes', '90']);
    assert.equal(set.status, 0, set.stdout + set.stderr);
    assert.equal(w.read().turnMin, 90);
    assert.match(w.runB(['lease', 'status']).stdout, /turn length: 90m/);
    assert.equal(w.runA(['lease', 'acquire', '--for', '10']).status, 0);
    assert.equal(w.read().turn.endsAt, '2026-10-13T21:30:00.000Z');
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 3, 'B waits');
    assert.equal(w.runA(['lease', 'release', '--force', '--reason', 'x', '--end-turn'], {}).status, 2);
    assert.equal(w.runA(['lease', 'release', '--end-turn']).status, 0);
    assert.equal(w.read().turn, undefined, 'the turn was yielded');
    assert.match(w.runB(['lease', 'log']).stdout, /turn of .* ended \(yield\)/);
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 0, 'and B goes next');
    assert.equal(w.runA(['lease', 'turn', '--clear']).status, 0);
    assert.equal(w.read().turnMin, undefined);
  });
});

describe('--end-turn while the same repo still waits (D9, finding 3c6d)', () => {
  it('prints why the turn was kept, carries turnKept in --json, and a waiting job of the same repo then goes next', () => {
    const w = world();
    assert.equal(w.runA(['lease', 'acquire', '--for', '30']).status, 0);
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 3, 'repo B queues');
    const sibling = w.runA(['lease', 'acquire', '--for', '10', '--id', 'chip-2']);
    assert.equal(sibling.status, 3, 'a second job of repo A is refused and queues A');
    const rel = w.runA(['lease', 'release', '--end-turn', '--json']);
    assert.equal(rel.status, 0, rel.stderr + rel.stdout);
    assert.equal(rel.json.turnKept.reason, 'same-repo-waiting');
    const text = w.runA(['lease', 'status']).stdout;
    assert.match(text, /turn: .* until/, 'the turn is still A\'s');
    // The sibling now acquires in-turn (B is refused for the turn).
    assert.equal(w.runB(['lease', 'acquire', '--for', '10']).status, 3);
    assert.equal(w.runA(['lease', 'acquire', '--for', '10', '--id', 'chip-2']).status, 0);
  });
  it('the text form names the repo, the waiting time and the escape hatch', () => {
    const w = world();
    assert.equal(w.runA(['lease', 'acquire', '--for', '30']).status, 0);
    assert.equal(w.runA(['lease', 'acquire', '--for', '10', '--id', 'chip-2']).status, 3);
    const rel = w.runA(['lease', 'release', '--end-turn']);
    assert.equal(rel.status, 0, rel.stderr);
    assert.match(rel.stdout, /--end-turn not applied: .* has a job waiting since \d\d:\d\dZ, so the turn stays with .* for the between-jobs gap; to hand it over anyway, run `.*lease wait --cancel` first/);
  });
  it('with no sibling waiting, --end-turn yields and prints nothing about a kept turn', () => {
    const w = world();
    assert.equal(w.runA(['lease', 'acquire', '--for', '30']).status, 0);
    const rel = w.runA(['lease', 'release', '--end-turn', '--json']);
    assert.equal(rel.status, 0);
    assert.equal(rel.json.turnKept, undefined);
  });
});
