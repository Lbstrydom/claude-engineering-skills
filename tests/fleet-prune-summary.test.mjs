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
  PRUNE_CACHE_FILE, invalidatePruneCache, pruneStatusLine, readPruneCache, summarisePrune, writePruneCache,
} from '../scripts/lib/fleet/prune-summary.mjs';
import { pruneNextLines } from '../scripts/lib/fleet/coordination.mjs';
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
      schemaVersion: 1, at: AT, complete: true, removable: 3, fresh: 1, kept: 1, unjudged: 0, orphans: 1,
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
    fs.writeFileSync(path.join(d, PRUNE_CACHE_FILE), JSON.stringify({ ...rec, schemaVersion: 2 }));
    assert.equal(readPruneCache(d).state, 'unreadable');
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
