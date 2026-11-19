/**
 * @fileoverview Upstream 56773c7c: `fleet prune`'s evidence reaches a person. `status` summarises the prune plan into
 * one line and a derived cache; `next` relays it as FYI, never as an action; a count that was not measured never
 * reads as zero.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { git } from './helpers/git.mjs';
import { addBranch, cleanupFleetRoots, installFakeGh, makeFleetRepo, runFleet, scrubbedEnv } from './helpers/fleet-repo.mjs';
import {
  PRUNE_CACHE_FILE, invalidatePruneCache, pruneAlertCrossed, pruneAlertLine, pruneStatusLine, readPruneCache, summarisePrune, writePruneCache,
} from '../scripts/lib/fleet/prune-summary.mjs';
import { pruneNext, pruneNextLines } from '../scripts/lib/fleet/coordination.mjs';
import { statusPrune } from '../scripts/lib/fleet/commands.mjs';
import { planPrune } from '../scripts/lib/fleet/prune.mjs';
import { resolveConfig } from '../scripts/lib/fleet/config.mjs';

after(cleanupFleetRoots);

const AT = '2026-10-13T10:00:00.000Z';
const NOW = new Date('2026-10-13T12:00:00.000Z');
const review = (o = {}) => ({ postMerge: [], noPr: [], unjudged: 0, ...o });
const plan = (o = {}) => ({ candidates: [], excluded: [], notJudged: [], complete: true, unjudged: 0, review: review(), orphans: { roots: [], dirs: [] }, upstreamGone: [], ...o });
const cand = (fresh = false) => ({ branch: 'b', fresh });
const rev = (allOnBase) => ({ branch: 'r', files: [], allOnBase });

describe('summarisePrune — counts only what the plan holds', () => {
  test('a complete plan: removable, fresh, kept, review classes and orphans', () => {
    const r = summarisePrune(plan({
      candidates: [cand(), cand(true), cand()], excluded: [{ branch: 'k', reason: 'x' }],
      review: review({ postMerge: [rev(true), rev(false)], noPr: [rev(true)] }), orphans: { roots: [], dirs: [{ path: 'p', kind: 'empty' }] },
    }), AT);
    assert.deepEqual(r, {
      schemaVersion: 2, at: AT, complete: true, removable: 3, fresh: 1, kept: 1, unjudged: 0, orphans: 1,
      detached: { removable: 0, fresh: 0, kept: 0, stale: 0, unjudged: 0 }, worktrees: null,
      review: { postMerge: 2, postMergeOnBase: 1, noPr: 1, noPrOnBase: 1, unjudged: 0 },
    });
  });
  test('an incomplete plan carries its reason and is not a measurement', () => {
    const r = summarisePrune(plan({ complete: false, notJudged: ['the open-PR list is incomplete or was not read, so no branch can be shown to have no open PR'] }), AT);
    assert.equal(r.complete, false);
    assert.match(r.reason, /open-PR list/);
  });
});

describe('pruneStatusLine — unmeasured never reads as zero', () => {
  test('incomplete → unmeasured, with the reason and the command', () => {
    const line = pruneStatusLine(summarisePrune(plan({ complete: false, notJudged: ['the open-PR list is incomplete'] }), AT), 'fleet');
    assert.match(line, /^prune: unmeasured \(the open-PR list is incomplete\)/);
    assert.match(line, /fleet prune/);
    assert.doesNotMatch(line, /\b0\b|nothing/);
  });
  test('complete and empty → nothing removable', () => {
    assert.equal(pruneStatusLine(summarisePrune(plan(), AT), 'fleet'), 'prune: nothing removable, nothing to review');
  });
  test('counts, with the pointer to the read-only command', () => {
    const line = pruneStatusLine(summarisePrune(plan({ candidates: [cand(), cand(true)], review: review({ postMerge: [rev(true)], noPr: [rev(false), rev(true)] }) }), AT), 'fleet');
    assert.equal(line, 'prune: 2 removable with nothing lost (1 fresh) · review: 1 post-merge (1 content on base), 2 no-PR (1 content on base) — `fleet prune` (read-only) lists them');
  });
  test('a budget-cut plan is a lower bound and says how many were not judged', () => {
    const line = pruneStatusLine(summarisePrune(plan({ candidates: [cand()], unjudged: 3, review: review({ unjudged: 2 }) }), AT), 'fleet');
    assert.match(line, /^prune: ≥1 removable with nothing lost/);
    assert.match(line, /\(5 not judged within the status budget\)/);
  });
  test('under a budget cut the content-on-base subsets are lower bounds too', () => {
    const line = pruneStatusLine(summarisePrune(plan({ review: review({ postMerge: [rev(true)], unjudged: 1 }) }), AT), 'fleet');
    assert.match(line, /≥1 post-merge \(≥1 content on base\)/);
    assert.match(line, /≥0 no-PR \(≥0 content on base\)/);
  });
});

describe('the derived cache', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prune-cache-'));
  test('round trip; missing; schema mismatch reads as unreadable; invalidate', () => {
    const d = dir();
    assert.equal(readPruneCache(d).state, 'missing');
    const rec = summarisePrune(plan({ candidates: [cand()] }), AT);
    assert.deepEqual(writePruneCache(d, rec), { ok: true });
    assert.deepEqual(readPruneCache(d), { state: 'ok', record: rec });
    fs.writeFileSync(path.join(d, PRUNE_CACHE_FILE), JSON.stringify({ ...rec, schemaVersion: 99 }));
    assert.equal(readPruneCache(d).state, 'unreadable');
    // A v1 file (no detached block) is unreadable too: `next` then says unmeasured and one `status` run heals it.
    const { detached, worktrees, ...v1 } = rec;
    fs.writeFileSync(path.join(d, PRUNE_CACHE_FILE), JSON.stringify({ ...v1, schemaVersion: 1 }));
    assert.deepEqual(readPruneCache(d), { state: 'unreadable', reason: 'schema mismatch' });
    // A count known to be wrong is REPLACED by an unmeasured record, never left readable as ok.
    assert.deepEqual(writePruneCache(d, rec), { ok: true });
    assert.deepEqual(invalidatePruneCache(d, 'prune --apply changed the branches', AT), { ok: true });
    const after = readPruneCache(d);
    assert.equal(after.state, 'ok');
    assert.equal(after.record.complete, false);
    assert.match(after.record.reason, /prune --apply/);
    assert.equal(writePruneCache(null, rec).ok, false, 'no common dir: a failure to report, never a throw');
  });
  test('the schema refuses a record whose time does not parse, or whose subsets exceed their totals', () => {
    const d = dir();
    const rec = summarisePrune(plan({ candidates: [cand()] }), AT);
    assert.equal(writePruneCache(d, { ...rec, at: 'not-a-date' }).ok, false);
    assert.equal(writePruneCache(d, { ...rec, fresh: 2 }).ok, false);
    assert.equal(writePruneCache(d, { ...rec, review: { ...rec.review, noPrOnBase: 1 } }).ok, false);
    fs.writeFileSync(path.join(d, PRUNE_CACHE_FILE), JSON.stringify({ ...rec, at: 'not-a-date' }));
    assert.equal(readPruneCache(d).state, 'unreadable');
  });
});

describe('pruneNextLines — FYI for the user/coordinator, never an action', () => {
  const ok = (o) => ({ state: 'ok', record: summarisePrune(plan(o), AT) });
  test('missing, unreadable and stale ask for a status run; nothing reads as zero', () => {
    for (const c of [{ state: 'missing' }, { state: 'unreadable', reason: 'x' }]) {
      const [l] = pruneNextLines(c, NOW, 'fleet');
      assert.match(l, /prune count unmeasured/);
      assert.match(l, /`fleet status` \(read-only\)/);
    }
    const stale = pruneNextLines(ok({ candidates: [cand()] }), new Date('2026-10-15T12:00:00.000Z'), 'fleet');
    assert.match(stale.join('\n'), /prune count unmeasured: last measured 2d ago/);
  });
  test('complete and empty → silent; counts → one FYI line with the age', () => {
    assert.deepEqual(pruneNextLines(ok({}), NOW, 'fleet'), []);
    const [l, ...rest] = pruneNextLines(ok({ candidates: [cand()] }), NOW, 'fleet');
    assert.equal(rest.length, 0);
    assert.match(l, /^FYI for the user\/coordinator, not an action for this session: 1 removable with nothing lost/);
    assert.match(l, /\(measured 2h ago\)/);
  });
  test('a record from the future (a clock moved back) is of unknown age, never relayed as fresh', () => {
    const [l] = pruneNextLines(ok({ candidates: [cand()] }), new Date('2026-10-13T09:00:00.000Z'), 'fleet');
    assert.match(l, /prune count unmeasured: its age is unknown/);
  });
  test('an incomplete record relays its reason, not a count', () => {
    const [l] = pruneNextLines(ok({ complete: false, notJudged: ['the open-PR list is incomplete'] }), NOW, 'fleet');
    assert.match(l, /prune count unmeasured \(the open-PR list is incomplete\)/);
  });
});

describe('statusPrune — a failed measurement replaces the old count', () => {
  test('planning throws → the cache holds an unmeasured record, not the previous complete one', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-status-'));
    writePruneCache(d, summarisePrune(plan({ candidates: [cand()] }), AT));
    const r = statusPrune({ cwd: d, cmd: 'fleet' }, {}, AT, { dir: d, plan: () => { throw new Error('boom'); } });
    assert.match(r.line, /^prune: unmeasured \(the prune plan could not be made: boom\)/);
    assert.equal(r.record.complete, false);
    const c = readPruneCache(d);
    assert.equal(c.record.complete, false);
    assert.match(c.record.reason, /boom/);
    assert.equal(r.warning, null);
  });
  test('a cache that cannot be written is a warning, not silence', () => {
    const r = statusPrune({ cwd: '.', cmd: 'fleet' }, {}, AT, { dir: null, plan: () => plan() });
    assert.match(r.warning, /prune-count cache not written/);
  });
});

describe('planPrune under a deadline', () => {
  test('a spent budget counts branches as unjudged, never as kept or dropped', () => {
    const fx = makeFleetRepo();
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off', ...fake.env }, { prependPath: [fake.bin] });
    addBranch(fx.repo, 'done', { 'a.txt': 'A1\n' });
    git(['merge', '-q', '--squash', 'done'], fx.repo); git(['commit', '-q', '-m', 'done (#1)'], fx.repo);
    addBranch(fx.repo, 'scratch', { 's.txt': 'S\n' });
    const saved = { ...process.env };
    try {
      Object.assign(process.env, env);
      const ctx = { cwd: fx.repo, config: resolveConfig(fx.repo, { env }), now: new Date(), env, cmd: 'fleet' };
      const p = planPrune(ctx, { deadlineAt: 0 });
      assert.equal(p.complete, true);
      assert.equal(p.candidates.length, 0);
      assert.equal(p.excluded.length, 0);
      assert.equal(p.unjudged, 1);
      assert.equal(p.review.unjudged, 1);
    } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  });
});

describe('CLI — status computes, next relays', () => {
  test('next before any status says unmeasured; status prints the line and writes the cache; next then relays it', () => {
    const fx = makeFleetRepo();
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, FLEET_TELEMETRY: 'off', ...fake.env }, { prependPath: [fake.bin] });
    const f = (args, cwd = fx.repo) => runFleet(args, { cwd, env });
    const wt = path.join(fx.root, 'wt-mine');
    git(['worktree', 'add', '-q', '-b', 'mine', wt, 'main'], fx.repo);
    assert.equal(f(['claim', '--intent', 'mine', '--paths', 'm.txt'], wt).status, 0);
    addBranch(fx.repo, 'done', { 'a.txt': 'A1\n' });
    git(['merge', '-q', '--squash', 'done'], fx.repo); git(['commit', '-q', '-m', 'done (#1)'], fx.repo);

    const before = f(['next'], wt);
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, /prune count unmeasured: no status run has measured it yet/);

    const s = f(['status', '--json']);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.json.status.prune.removable, 1);
    assert.match(s.json.text, /^prune: 1 removable with nothing lost/m);

    const after = f(['next', '--json'], wt);
    assert.equal(after.json.prune.state, 'ok');
    assert.match(after.json.text, /FYI for the user\/coordinator, not an action for this session: 1 removable with nothing lost/);
    assert.ok(!after.json.obligations.some((o) => /prune/.test(JSON.stringify(o))), 'the count is information, never an obligation');
  });

  test('an unreadable PR list makes status say unmeasured, never 0 removable', () => {
    const fx = makeFleetRepo();
    const fake = installFakeGh(fx.root);
    fake.setState({ list: [], authFail: true });
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off', ...fake.env }, { prependPath: [fake.bin] });
    addBranch(fx.repo, 'done', { 'a.txt': 'A1\n' });
    const s = runFleet(['status'], { cwd: fx.repo, env });
    assert.match(s.stdout, /^prune: unmeasured \(/m);
    assert.doesNotMatch(s.stdout, /^prune: (0|nothing)/m);
  });

  test('prune --apply replaces the count with an unmeasured record, so next never relays a stale count', () => {
    const fx = makeFleetRepo();
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off', FLEET_NOW: new Date(Date.now() + 10 * 86_400_000).toISOString(), ...fake.env }, { prependPath: [fake.bin] });
    addBranch(fx.repo, 'done', { 'a.txt': 'A1\n' });
    git(['merge', '-q', '--squash', 'done'], fx.repo); git(['commit', '-q', '-m', 'done (#1)'], fx.repo);
    const cacheFile = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet-cache', PRUNE_CACHE_FILE);
    assert.equal(runFleet(['prune'], { cwd: fx.repo, env }).status, 0);
    assert.ok(fs.existsSync(cacheFile), 'a read-only prune run writes the count too');
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).complete, true);
    assert.equal(runFleet(['prune', '--apply'], { cwd: fx.repo, env }).status, 0);
    const rec = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.equal(rec.complete, false);
    assert.match(rec.reason, /prune --apply/);
  });
});

describe('pruneAlertCrossed / pruneAlertLine — the ASK threshold', () => {
  const A = { removable: 25, worktrees: 30 };
  const R = (o = {}) => {
    const { detached, ...rest } = o;
    return { ...summarisePrune(plan(), AT), ...rest, detached: { removable: 0, fresh: 0, kept: 0, stale: 0, unjudged: 0, ...(detached ?? {}) } };
  };
  test('boundary: exactly 25 removable / 30 registered crosses, one less does not (each side alone)', () => {
    assert.equal(pruneAlertCrossed(R({ removable: 25 }), A).crossed, true);
    assert.equal(pruneAlertCrossed(R({ removable: 24 }), A).crossed, false);
    assert.equal(pruneAlertCrossed(R({ worktrees: 30 }), A).crossed, true);
    assert.equal(pruneAlertCrossed(R({ worktrees: 29 }), A).crossed, false);
  });
  test('detached worktrees and stale registrations count toward the removable side (the 77-branch census undercounted without them)', () => {
    assert.equal(pruneAlertCrossed(R({ removable: 20, detached: { removable: 3, stale: 2 } }), A).crossed, true);
    assert.equal(pruneAlertCrossed(R({ removable: 20, detached: { removable: 3, stale: 1 } }), A).crossed, false);
  });
  test('off (null) never crosses; an unreadable worktree list (null count) never crosses on that side', () => {
    assert.equal(pruneAlertCrossed(R({ removable: 999, worktrees: 999 }), null).crossed, false);
    assert.equal(pruneAlertCrossed(R({ worktrees: null }), A).crossed, false);
  });
  test('an incomplete branch half is not counted, but detached judging still is; unjudged makes it a LOWER bound, never "below"', () => {
    const incomplete = R({ complete: false, reason: 'no PR list', removable: 40, detached: { removable: 25 } });
    const c = pruneAlertCrossed(incomplete, A);
    assert.deepEqual([c.crossed, c.lowerBound, c.applyRemovable], [true, true, 25], 'only the detached half counts');
    assert.equal(pruneAlertCrossed(R({ complete: false, reason: 'x', removable: 40 }), A).crossed, false, 'branch-only count under an incomplete list is not a measurement');
    const cut = pruneAlertCrossed(R({ detached: { removable: 20, unjudged: 10 } }), A);
    assert.deepEqual([cut.crossed, cut.lowerBound], [false, true], 'under the limit with 10 unjudged is "not shown crossed"');
    assert.match(pruneAlertLine(R({ detached: { removable: 25, unjudged: 3 } }), A), /≥25 removable/);
  });
  test('the ASK offers only the action that can address what crossed: stale-only, candidate-only, mixed, worktrees-only', () => {
    const stale = pruneAlertLine(R({ detached: { stale: 25 } }), A);
    assert.match(stale, /^ASK /);
    assert.match(stale, /git worktree prune/);
    assert.doesNotMatch(stale, /prune --apply/);
    const cand = pruneAlertLine(R({ removable: 25 }), A);
    assert.match(cand, /prune --apply/);
    assert.doesNotMatch(cand, /git worktree prune/);
    const mixed = pruneAlertLine(R({ removable: 20, detached: { removable: 2, stale: 4 } }), A);
    assert.match(mixed, /prune --apply/);
    assert.match(mixed, /git worktree prune/);
    const only = pruneAlertLine(R({ worktrees: 31 }), A);
    assert.match(only, /which worktrees to retire/);
    assert.doesNotMatch(only, /prune --apply|git worktree prune/);
    assert.equal(pruneAlertLine(R({ removable: 24, worktrees: 29 }), A), null);
  });
  test('next relays it after the FYI line, only for a fresh complete-or-not record; the status line says so too; v1 cache → unmeasured, no ASK', () => {
    const rec = R({ removable: 25 });
    const lines = pruneNext(null, NOW, 'fleet', { read: () => ({ state: 'ok', record: rec }), alert: A }).lines;
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^FYI /);
    assert.match(lines[1], /^ASK /);
    assert.equal(pruneNext(null, NOW, 'fleet', { read: () => ({ state: 'ok', record: rec }), alert: null }).lines.length, 1, 'off: FYI only');
    assert.match(pruneStatusLine(rec, 'fleet', A), /threshold crossed \(25 removable \(limit 25\)/);
    assert.doesNotMatch(pruneStatusLine(rec, 'fleet', null), /threshold/);
    const old = pruneNext(null, NOW, 'fleet', { read: () => ({ state: 'unreadable', reason: 'schema mismatch' }), alert: A }).lines;
    assert.match(old[0], /unmeasured/);
    assert.equal(old.some((l) => /^ASK /.test(l)), false);
  });
  test('CLI end to end: a repo with pruneAlert {worktrees: 3} prints the ASK after status (4 registered ≥ 3); pruneAlert:false does not', () => {
    const run = (fleetConfig) => {
      const fx = makeFleetRepo({ fleetConfig });
      git(['add', '.fleet.json'], fx.repo); git(['commit', '-q', '-m', 'fleet config'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
      const fake = installFakeGh(fx.root);
      const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, FLEET_TELEMETRY: 'off', ...fake.env }, { prependPath: [fake.bin] });
      for (const n of ['one', 'two']) git(['worktree', 'add', '-q', '--detach', path.join(fx.root, `wt-${n}`)], fx.repo);
      const f = (args) => runFleet(args, { cwd: fx.repo, env });
      const mine = path.join(fx.root, 'wt-mine');
      git(['worktree', 'add', '-q', '-b', 'mine', mine, 'main'], fx.repo);
      assert.equal(runFleet(['claim', '--intent', 'mine', '--paths', 'm.txt'], { cwd: mine, env }).status, 0);
      assert.equal(f(['status', '--json']).status, 0);
      return runFleet(['next', '--json'], { cwd: mine, env }).json.text;
    };
    assert.match(run({ pruneAlert: { worktrees: 3 } }), /^ASK for the coordinator's next pass.*4 registered worktrees \(limit 3\)/m);
    assert.doesNotMatch(run({ pruneAlert: false }), /^ASK /m);
  });
});
