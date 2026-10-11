/**
 * @fileoverview Unregistered work (docs/plans/fleet-unclaimed-work-and-switch-friction.md §2.1, §9):
 * the ordered verdict contract, the light probe, the one-deadline scan, idle age and branch-only candidates.
 *
 * Every "does not" case has a control that fires the other way, so a predicate answering one value for
 * everything fails here.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, commitFile, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { RECEIPT_PATH } from '../scripts/lib/sync-receipt.mjs';
import {
  DEFAULT_STALE_WORKTREE_DAYS, SYNC_OWNED_PATHS, classifyUnregistered, groupUnregistered, isAbandoned, lastActivity, rankAbandoned,
  readUnregisteredCache, unregisteredWork, writeUnregisteredCache, cacheRecord,
} from '../scripts/lib/fleet/unregistered.mjs';
import { archiveReport } from '../scripts/lib/fleet/lifecycle.mjs';
import { gatherMerged } from '../scripts/lib/fleet/facts.mjs';
import { hideReason, landedReason } from '../scripts/lib/fleet/overlap.mjs';
import { CLEAN_PROBE, probeWorktrees } from '../scripts/lib/fleet/worktree-status.mjs';

after(cleanupFleetRoots);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-11T12:00:00Z');

// ── the ordered verdict contract (pure) ─────────────────────────────────────

describe('classifyUnregistered — the ordered contract, one case per row with its inverse', () => {
  const base = { probed: true, local: [], syncOwned: [], committed: 'none', evidence: 'none' };
  const v = (over) => classifyUnregistered({ ...base, ...over });

  it('nothing local and nothing off base is not listed (the control every row is measured against)', () => {
    assert.equal(v({}), null);
    assert.equal(v({ evidence: 'incomplete' }), null, 'incomplete evidence about NO commits is not a reason to list');
  });
  it('1a: a failed probe blocks, even on an otherwise clean worktree; an unknown count blocks too', () => {
    assert.deepEqual([v({ probed: false, unverified: ['git status failed'] }).row, v({ probed: false }).blocks], ['1a', true]);
    assert.match(v({ probed: false, unverified: ['git status failed'] }).reason, /git status failed/);
    assert.deepEqual([v({ committed: 'unknown' }).verdict, v({ committed: 'unknown' }).blocks], ['unverified', true]);
  });
  it('1b vs 1c: incomplete evidence blocks exactly when the commits are unpushed', () => {
    assert.deepEqual(['row', 'blocks', 'preserved'].map((k) => v({ committed: 'unpushed', evidence: 'incomplete' })[k]), ['1b', true, 'none']);
    assert.deepEqual(['row', 'blocks', 'preserved'].map((k) => v({ committed: 'pushed', evidence: 'incomplete' })[k]), ['1c', false, 'remote']);
  });
  it('2: uncommitted files are unlanded and block — and say so when the committed part is landed', () => {
    const d = v({ local: ['x.md'], committed: 'unpushed', evidence: 'landed' });
    assert.deepEqual([d.verdict, d.row, d.blocks], ['unlanded', '2', true]);
    assert.match(d.reason, /committed part is already landed/);
    assert.doesNotMatch(v({ local: ['x.md'] }).reason, /landed/);
  });
  it('2 with DUPLICATE evidence never says "landed": it names the twin (control: landed evidence says landed)', () => {
    const dup = v({ local: ['x.md'], committed: 'pushed', evidence: 'duplicate', duplicateOf: 'live-claim' });
    assert.match(dup.reason, /same patch as live-claim, not landed/);
    assert.doesNotMatch(dup.reason, /already landed/);
    assert.match(v({ local: ['x.md'], committed: 'pushed', evidence: 'landed' }).reason, /already landed/);
  });
  it('an unreadable activity term (not ENOENT) is UNKNOWN, so never stale; a plain absence is not (control)', () => {
    const eacces = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    const enoent = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
    assert.equal(lastActivity({ worktree: '/w', tipTime: NOW - 30 * DAY, stat: eacces }).unknown, true);
    assert.equal(lastActivity({ worktree: '/w', tipTime: NOW - 30 * DAY, stat: enoent }).unknown, false);
    const run = (stat) => unregisteredWork('R', ctx, {}, {
      facts: factsFor({ branches: [{ name: 'f', oid: 'a'.repeat(40), ahead: 1, tipTime: NOW - 30 * DAY }], evidence: { f: KNOWN_NOT_MERGED } }),
      list: wtList({ path: '/wt/f', branch: 'f', head: 'a'.repeat(40) }), report: cleanReport({ risks: { untracked: ['n.md'] } }), stat, patchIdOf: () => null, refFilesOf: () => [],
    }).items[0];
    assert.equal(run(eacces).stale, false, 'unknown activity is not "possibly abandoned"');
    assert.equal(run(enoent).stale, true);
  });
  it('3: landed or duplicate commits on a clean tree are superseded, with via; a dirty tree never reaches row 3', () => {
    assert.deepEqual(['verdict', 'via', 'blocks'].map((k) => v({ committed: 'unpushed', evidence: 'landed' })[k]), ['superseded', 'landed', false]);
    const dup = v({ committed: 'pushed', evidence: 'duplicate', duplicateOf: 'live-claim' });
    assert.deepEqual([dup.via, dup.preserved], ['duplicate', 'claim']);
    assert.match(dup.reason, /live-claim/);
    assert.equal(v({ local: ['y'], committed: 'pushed', evidence: 'duplicate' }).verdict, 'unlanded', 'a duplicate never rests on a dirty tree');
  });
  it('4: unlanded commits — preserved remote and non-blocking when pushed, blocking when unpushed', () => {
    assert.deepEqual(['verdict', 'preserved', 'blocks'].map((k) => v({ committed: 'pushed' })[k]), ['unlanded', 'remote', false]);
    assert.deepEqual(['verdict', 'preserved', 'blocks'].map((k) => v({ committed: 'unpushed' })[k]), ['unlanded', 'none', true]);
  });
  it('5: the receipt discount applies to L alone', () => {
    assert.deepEqual([v({ syncOwned: [RECEIPT_PATH] }).verdict, v({ syncOwned: [RECEIPT_PATH] }).blocks], ['sync-owned', false]);
    const withCommits = v({ syncOwned: [RECEIPT_PATH], committed: 'unpushed' });
    assert.deepEqual([withCommits.verdict, withCommits.row, withCommits.syncOwnedDirty], ['unlanded', '4', true], 'receipt + unpushed unlanded commits is row 4, not row 5');
    assert.equal(v({ syncOwned: [RECEIPT_PATH], local: ['other.md'] }).verdict, 'unlanded', 'receipt + one other file');
  });
  it('the receipt list is pinned to the sync receipt contract', () => {
    assert.deepEqual([...SYNC_OWNED_PATHS], [RECEIPT_PATH]);
  });
});

describe('ranking within "possibly abandoned" (u)', () => {
  it('work that exists nowhere else first, then most commits ahead, then longest idle', () => {
    const items = [
      { id: 'pushed-idle-long', preserved: 'remote', ahead: 3, idleDays: 30 },
      { id: 'local-few', preserved: 'none', ahead: 2, idleDays: 5 },
      { id: 'local-many', preserved: 'none', ahead: 49, idleDays: 9 },
      { id: 'local-many-older', preserved: 'none', ahead: 49, idleDays: 20 },
    ];
    assert.deepEqual(items.sort(rankAbandoned).map((i) => i.id), ['local-many-older', 'local-many', 'local-few', 'pushed-idle-long']);
  });
  it('only stale unlanded or blocking-unverified items are "possibly abandoned"; superseded and fresh are not', () => {
    assert.equal(isAbandoned({ stale: true, verdict: 'unlanded' }), true);
    assert.equal(isAbandoned({ stale: true, verdict: 'unverified', blocks: true }), true);
    assert.equal(isAbandoned({ stale: true, verdict: 'unverified', blocks: false }), false);
    assert.equal(isAbandoned({ stale: true, verdict: 'superseded' }), false);
    assert.equal(isAbandoned({ stale: false, verdict: 'unlanded' }), false);
  });
});

// ── the scan, with injected probes ──────────────────────────────────────────

/** Facts as `gatherFacts` shapes them, for the fields the scan reads. */
function factsFor({ branches = [], evidence = {}, patchIds = {} } = {}) {
  return { base: { name: 'main' }, baseOid: 'b'.repeat(40), branches: { queried: true, branches }, merged: { evidence }, patchIds };
}
const wtList = (...worktrees) => () => ({ queried: true, worktrees: worktrees.map((w) => ({ bare: false, missing: false, prunable: false, detached: false, locked: false, ...w })) });
const cleanReport = (over = {}) => () => ({ risks: { staged: [], unstaged: [], untracked: [], ignored: [], unpushed: [], ...over.risks }, unverified: over.unverified ?? [] });
const ctx = { cwd: 'R', config: { baseBranch: 'main', staleWorktreeDays: 3 }, now: new Date(NOW) };
const statNone = () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); };
/**
 * A git stub for branch placement: `rev-list --branches --not --remotes` lists `localOnly` (or fails), and
 * `rev-list --count <oid> --not --remotes` answers from `counts`. Records every call.
 */
function placementGit({ localOnly = [], counts = {}, listFails = false } = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args.join(' '));
    // The placement listing names the captured tips: answer only for the tips it asked about.
    if (!args.includes('--count')) return listFails ? { ok: false, stdout: '', reason: 'boom' } : { ok: true, stdout: localOnly.filter((o) => args.includes(o)).join('\n') };
    if (args.includes('--count')) return { ok: true, stdout: `${counts[args[2]] ?? 0}\n` };
    return { ok: false, stdout: '', reason: 'unexpected' };
  };
  return Object.assign(fn, { calls });
}
const KNOWN_NOT_MERGED = { known: true, merged: false };

describe('unregisteredWork — candidates and verdicts over injected facts', () => {
  const tip = 'a'.repeat(40);
  it('a clean worktree whose commits are pushed but not landed is listed (unlanded, remote, non-blocking); tip on base is not (control)', () => {
    const run = (ahead) => unregisteredWork('R', ctx, {}, {
      facts: factsFor({ branches: [{ name: 'f', oid: tip, ahead, tipTime: NOW - DAY }], evidence: { f: KNOWN_NOT_MERGED } }),
      list: wtList({ path: '/wt/f', branch: 'f', head: tip }), report: cleanReport(), stat: statNone, patchIdOf: () => null, refFilesOf: () => [],
    });
    const [item] = run(2).items;
    assert.deepEqual([item.verdict, item.preserved, item.blocks, item.committed], ['unlanded', 'remote', false, 'pushed']);
    assert.deepEqual(run(0).items, []);
  });
  it('exact-tip evidence makes it superseded; evidence for an OLDER tip does not', () => {
    const run = (evTip) => unregisteredWork('R', ctx, {}, {
      facts: factsFor({ branches: [{ name: 'f', oid: evTip, ahead: 1, tipTime: NOW }], evidence: { f: { known: true, merged: true, via: 'squash' } } }),
      list: wtList({ path: '/wt/f', branch: 'f', head: tip }), report: cleanReport({ risks: { unpushed: [tip] } }), stat: statNone, patchIdOf: () => null, refFilesOf: () => [],
    }).items[0];
    assert.deepEqual([run(tip).verdict, run(tip).via], ['superseded', 'landed']);
    assert.equal(run('c'.repeat(40)).verdict, 'unverified', 'a tip one commit past the evidence is not covered by it');
  });
  it('a failed status probe on an otherwise clean worktree is 1a and blocks; the same worktree probing fine is not listed', () => {
    const run = (report) => unregisteredWork('R', ctx, {}, {
      facts: factsFor({ branches: [{ name: 'f', oid: tip, ahead: 0 }] }), list: wtList({ path: '/wt/f', branch: 'f', head: tip }), report, stat: statNone,
    }).items;
    const [failed] = run(cleanReport({ unverified: ['git status failed: timed out'] }));
    assert.deepEqual([failed.row, failed.blocks], ['1a', true]);
    assert.deepEqual(run(cleanReport()), []);
  });
  it('a detached HEAD with unpushed commits is unverified and blocks (no branch evidence to ask)', () => {
    const [item] = unregisteredWork('R', ctx, {}, {
      facts: factsFor(), list: wtList({ path: '/wt/d', branch: null, detached: true, head: tip }), report: cleanReport({ risks: { unpushed: [tip] } }), stat: statNone,
      git: () => ({ ok: true, stdout: '2\n' }), patchIdOf: () => null,
    }).items;
    assert.deepEqual([item.verdict, item.row, item.blocks], ['unverified', '1b', true]);
  });
  it('a duplicate of a LIVE claimed branch is superseded via duplicate; dirty, it is unlanded; twin released, it is not a duplicate', () => {
    const run = ({ claimed, untracked = [] }) => unregisteredWork('R', ctx, claimed, {
      facts: factsFor({ branches: [{ name: 'copy', oid: tip, ahead: 1 }, { name: 'live', oid: 'd'.repeat(40), ahead: 1 }], evidence: { copy: KNOWN_NOT_MERGED } }),
      list: wtList({ path: '/wt/copy', branch: 'copy', head: tip }), report: cleanReport({ risks: { untracked, unpushed: [tip] } }), stat: statNone,
      patchIdOf: () => 'same-patch',
    }).items.find((i) => i.branch === 'copy');
    const dup = run({ claimed: { branches: ['live'] } });
    assert.deepEqual([dup.verdict, dup.via, dup.duplicateOf], ['superseded', 'duplicate', 'live']);
    assert.equal(run({ claimed: { branches: ['live'] }, untracked: ['wip.md'] }).verdict, 'unlanded');
    assert.deepEqual([run({ claimed: {} }).verdict, run({ claimed: {} }).evidence], ['unlanded', 'none'], 'no live twin: no duplicate');
  });
  it('a branch inventory that was NOT read is unknown, never empty: the scan is partial and says why (control: a read inventory)', () => {
    const opts = (facts) => ({ facts, list: wtList(), stat: statNone, patchIdOf: () => null, refFilesOf: () => [], git: placementGit() });
    const notRead = unregisteredWork('R', ctx, {}, opts({ ...factsFor(), branches: { queried: false, reason: 'for-each-ref failed', branches: [] } }));
    assert.deepEqual([notRead.partial, notRead.branchesUnknown], [true, 'branch inventory not read: for-each-ref failed']);
    assert.match(unregisteredWork('R', ctx, {}, opts(null)).branchesUnknown, /not gathered/);
    const read = unregisteredWork('R', ctx, {}, opts(factsFor()));
    assert.deepEqual([read.partial, read.branchesUnknown], [false, undefined]);
  });
  it('a worktree whose HEAD moved since the branch was measured is counted from its own HEAD, not the stale count', () => {
    const counted = [];
    const run = (measuredOid) => unregisteredWork('R', ctx, {}, {
      facts: factsFor({ branches: [{ name: 'f', oid: measuredOid, ahead: 0, tipTime: NOW }] }), list: wtList({ path: '/wt/f', branch: 'f', head: tip }),
      report: cleanReport({ risks: { unpushed: [tip] } }), stat: statNone, patchIdOf: () => null, refFilesOf: () => [],
      git: (args) => { counted.push(args.join(' ')); return { ok: true, stdout: '3\n' }; },
    }).items;
    assert.deepEqual(run(tip), [], 'control: the measurement is for this HEAD (ahead 0) — not listed');
    assert.equal(counted.length, 0);
    const [moved] = run('c'.repeat(40));
    assert.deepEqual([moved.ahead, moved.committed], [3, 'unpushed']);
    assert.match(counted[0], new RegExp(`rev-list --count .*\\.\\.${tip}`));
  });
  it('no patch-id is computed past the deadline: no duplicate is claimed (control: before it, the duplicate is found)', () => {
    let t = 0; let pids = 0;
    const run = (deadlineAt) => unregisteredWork('R', ctx, { branches: ['live'] }, {
      facts: factsFor({ branches: [{ name: 'copy', oid: tip, ahead: 1 }, { name: 'live', oid: 'd'.repeat(40), ahead: 1 }], evidence: { copy: KNOWN_NOT_MERGED } }),
      list: wtList({ path: '/wt/copy', branch: 'copy', head: tip }), report: cleanReport({ risks: { unpushed: [tip] } }), stat: statNone, deadlineAt, clock: () => t,
      patchIdOf: () => { pids += 1; return 'same'; },
    }).items[0];
    assert.equal(run(null).evidence, 'duplicate');
    pids = 0; t = 5;
    const late = unregisteredWork('R', ctx, { branches: ['live'] }, {
      facts: factsFor({ branches: [{ name: 'copy', oid: tip, ahead: 1 }, { name: 'live', oid: 'd'.repeat(40), ahead: 1 }], evidence: { copy: KNOWN_NOT_MERGED } }),
      list: wtList({ path: '/wt/copy', branch: 'copy', head: tip }), stat: statNone, deadlineAt: 10, clock: () => (t += 3),
      report: cleanReport({ risks: { unpushed: [tip] } }), patchIdOf: () => { pids += 1; return 'same'; },
    });
    assert.equal(pids, 0, 'nothing computed once the deadline has passed');
    assert.notEqual(late.items[0]?.evidence, 'duplicate');
  });
  it('a claimed worktree or branch is never a candidate', () => {
    const opts = { facts: factsFor({ branches: [{ name: 'f', oid: tip, ahead: 1 }] }), list: wtList({ path: '/wt/f', branch: 'f', head: tip }), report: cleanReport({ risks: { untracked: ['x'] } }), stat: statNone };
    assert.equal(unregisteredWork('R', ctx, { worktrees: ['/wt/f'] }, opts).items.length, 0);
    assert.equal(unregisteredWork('R', ctx, { branches: ['f'] }, opts).items.length, 0);
    assert.equal(unregisteredWork('R', ctx, {}, opts).items.length, 1, 'control');
  });
});

describe('branch-only candidates (u, round 6)', () => {
  const tip = 'a'.repeat(40);
  const run = (branch, { local = true, evidence = {} } = {}) => unregisteredWork('R', ctx, {}, {
    facts: factsFor({ branches: [branch], evidence }), list: wtList(), report: () => { throw new Error('a branch-only candidate has no worktree to probe'); },
    git: placementGit({ localOnly: local ? [branch.oid] : [], counts: { [branch.oid]: branch.ahead } }), stat: statNone, patchIdOf: () => null, refFilesOf: () => [],
  }).items;
  it('49 commits no remote holds, no worktree: unlanded, preserved none, blocking — and outranks an idle pushed branch', () => {
    const [local] = run({ name: 'queue-burndown', oid: tip, ahead: 49, tipTime: NOW - 9 * DAY }, { evidence: { 'queue-burndown': KNOWN_NOT_MERGED } });
    assert.deepEqual([local.kind, local.verdict, local.preserved, local.blocks, local.stale], ['branch', 'unlanded', 'none', true, true]);
    const [pushed] = run({ name: 'pushed', oid: tip, ahead: 3, tipTime: NOW - 30 * DAY }, { local: false, evidence: { pushed: KNOWN_NOT_MERGED } });
    assert.deepEqual([pushed.preserved, pushed.blocks], ['remote', false], 'control: a remote ref holds it');
    assert.deepEqual([pushed, local].sort(rankAbandoned).map((i) => i.branch), ['queue-burndown', 'pushed']);
  });
  it('an UNKNOWN ahead count is row 1a and blocking; a known count of 0 is not listed (control)', () => {
    const [unknown] = run({ name: 'u', oid: tip, ahead: null, countsReason: 'rev-list failed', tipTime: NOW });
    assert.deepEqual([unknown.row, unknown.blocks], ['1a', true]);
    assert.deepEqual(run({ name: 'u', oid: tip, ahead: 0, tipTime: NOW }), []);
  });
  it('placement is ONE listing plus a count only for local-only tips; a failed listing falls back to a count per branch', () => {
    const branches = ['a', 'b', 'c'].map((n, i) => ({ name: n, oid: n.repeat(40), ahead: i + 1, tipTime: NOW }));
    const scan = (g) => unregisteredWork('R', ctx, {}, { facts: factsFor({ branches }), list: wtList(), stat: statNone, patchIdOf: () => null, refFilesOf: () => [], git: g }).items;
    const g1 = placementGit({ localOnly: ['b'.repeat(40)], counts: { ['b'.repeat(40)]: 2 } });
    assert.deepEqual(scan(g1).map((i) => [i.branch, i.committed, i.risks.unpushed]), [['a', 'pushed', 0], ['b', 'unpushed', 2], ['c', 'pushed', 0]]);
    assert.equal(g1.calls.length, 2, 'one listing + one count');
    assert.ok(branches.every((b) => g1.calls[0].includes(b.oid)) && !g1.calls[0].includes('--branches'), 'the listing is of the CAPTURED tips, not the current branches');
    const g2 = placementGit({ listFails: true, counts: { ['b'.repeat(40)]: 2 } });
    assert.deepEqual(scan(g2).map((i) => i.committed), ['pushed', 'unpushed', 'pushed'], 'the fallback reaches the same answer');
    assert.equal(g2.calls.length, 4, 'one failed listing + one count per branch');
  });
  it('a branch checked out in a listed worktree is that worktree\'s candidate, never a second branch-only one', () => {
    const items = unregisteredWork('R', ctx, {}, {
      facts: factsFor({ branches: [{ name: 'f', oid: tip, ahead: 1 }], evidence: { f: KNOWN_NOT_MERGED } }), list: wtList({ path: '/wt/f', branch: 'f', head: tip }),
      report: cleanReport({ risks: { unpushed: [tip] } }), stat: statNone, patchIdOf: () => null, refFilesOf: () => [],
    }).items;
    assert.deepEqual(items.map((i) => i.kind), ['worktree']);
  });
});

describe('the light probe and the one deadline', () => {
  it('scanIgnored:false makes no --ignored call and no size walk, yet still finds untracked, unpushed and skip-worktree', () => {
    const repo = makeFleetRepo().repo;
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');
    git(['update-index', '--skip-worktree', 'a.txt'], repo);
    const calls = [];
    const rec = (args, cwd, opts) => { calls.push(args.join(' ')); return archiveReportGit(args, cwd, opts); };
    const light = archiveReport({ cwd: repo, config: {} }, { worktree: repo, scanIgnored: false, git: rec });
    assert.equal(calls.some((c) => c.includes('--ignored')), false);
    assert.deepEqual(light.sizes, {}, 'no size walk');
    assert.deepEqual(light.risks.untracked, ['new.txt']);
    assert.match(light.unverified.join(' '), /skip-worktree/);
    calls.length = 0;
    const full = archiveReport({ cwd: repo, config: {} }, { worktree: repo, git: rec });
    assert.equal(calls.some((c) => c.includes('--ignored')), true, 'control: the default mode still asks');
    assert.ok(full.sizes['new.txt'], 'control: the default mode measures sizes');
  });
  it('a single slow call is clipped to the REMAINING budget, not its own cap; past the deadline it is not made', () => {
    let t = 0; const seen = [];
    const slow = (args, cwd, opts) => { seen.push(opts?.timeoutMs); t += 7_000; return { ok: true, stdout: '' }; };
    archiveReport({ cwd: 'R', config: {} }, { worktree: process.cwd(), scanIgnored: false, deadlineAt: 10_000, clock: () => t, git: slow });
    assert.equal(seen[0], 10_000, 'first call gets min(30s cap, 10s left)');
    assert.equal(seen[1], 3_000, 'second call gets what is left');
    assert.equal(seen.length, 2, 'nothing is started past the deadline');
  });
  it('45 candidates and a deadline that fits 30: the 30 OLDEST tips are probed, in order, and 15 are disclosed as not probed', () => {
    let t = 0; const order = [];
    const branches = Array.from({ length: 45 }, (_, i) => ({ name: `b${String(i).padStart(2, '0')}`, oid: String(i).padStart(40, '0').replace(/^0/, 'a'), ahead: 1, tipTime: NOW - (100 - i) * DAY }));
    const shuffled = [...branches].reverse();
    const scan = unregisteredWork('R', ctx, {}, {
      facts: factsFor({ branches: shuffled }), list: wtList(), stat: statNone, patchIdOf: () => null, refFilesOf: () => [], deadlineAt: 30, clock: () => t,
      git: (args) => {
        t += 1;
        if (!args.includes('--count')) return { ok: true, stdout: branches.map((b) => b.oid).join('\n') };
        order.push(args[2]); return { ok: true, stdout: '1\n' };
      },
    });
    // The one placement listing spends a unit of the budget too: 29 counts fit after it.
    assert.deepEqual([scan.partial, scan.notProbed, scan.items.length], [true, 16, 29]);
    assert.deepEqual(order, branches.slice(0, 29).map((b) => b.oid), 'oldest tip first');
  });
});

describe('probeWorktrees honours its bounds', () => {
  it('the DEFAULT probe hands bounds.timeoutMs to git; the default bounds hand CLEAN_PROBE.timeoutMs (control)', () => {
    const seen = [];
    const git = (args, cwd, opts) => { seen.push(opts?.timeoutMs); return { ok: true, stdout: '' }; };
    probeWorktrees(['/wt/a'], { bounds: { ...CLEAN_PROBE, timeoutMs: 1234 }, git });
    probeWorktrees(['/wt/b'], { git });
    assert.deepEqual(seen, [1234, CLEAN_PROBE.timeoutMs]);
  });
});

describe('idle age (last activity)', () => {
  const STALE = 3 * DAY;
  const at = (over) => lastActivity({ worktree: null, tipTime: null, ...over });
  it('exactly at, one second inside and one second past the window (frozen clock)', () => {
    const ctxNow = { ...ctx, now: new Date(NOW) };
    const run = (age) => unregisteredWork('R', ctxNow, {}, {
      facts: factsFor({ branches: [{ name: 'f', oid: 'a'.repeat(40), ahead: 1, tipTime: NOW - age }] }), list: wtList(), stat: statNone, patchIdOf: () => null, refFilesOf: () => [],
      git: () => ({ ok: true, stdout: '1\n' }),
    }).items[0];
    assert.equal(run(STALE).stale, false, 'exactly at the window is not past it');
    assert.equal(run(STALE - 1000).stale, false);
    assert.equal(run(STALE + 1000).stale, true);
    assert.equal(run(-DAY).stale, false, 'a future-dated commit is not stale');
    assert.equal(DEFAULT_STALE_WORKTREE_DAYS, 3);
  });
  it('a missing time is not stale (unknown never reads as abandoned)', () => {
    assert.equal(at({}).at, null);
  });
  it('a worktree created moments ago on a year-old commit is FRESH; with an old admin HEAD it is stale (control)', () => {
    const fx = makeFleetRepo();
    const wt = path.join(tmpRoot('unreg-fresh-'), 'old-commit');
    git(['worktree', 'add', '-q', '-b', 'old-commit', wt, 'main'], fx.repo);
    const yearAgo = NOW - 365 * DAY;
    const fresh = lastActivity({ worktree: wt, tipTime: yearAgo });
    assert.ok(fresh.at > yearAgo + DAY, 'the admin HEAD (or birth time) shows the creation');
    const statOld = (p) => ({ mtimeMs: yearAgo, birthtimeMs: 0 });
    assert.equal(lastActivity({ worktree: wt, tipTime: yearAgo, stat: statOld }).at, yearAgo, 'control: every term old reads old');
  });
  it('a very large dirty set does not overflow the argument limit (the maximum is kept incrementally)', () => {
    const dirty = Array.from({ length: 200_000 }, (_, i) => `f${i}`);
    const r = lastActivity({ worktree: '/wt', tipTime: null, dirty, stat: (p) => ({ mtimeMs: p.endsWith('f199999') ? NOW : NOW - DAY, birthtimeMs: 0 }) });
    assert.equal(r.at, NOW);
  });
  it('an unresolvable ref-evidence source (null) makes the age unknown, never idle; [] is simply no term (control)', () => {
    assert.equal(lastActivity({ worktree: null, tipTime: NOW - 30 * DAY, refFiles: null }).unknown, true);
    assert.equal(lastActivity({ worktree: null, tipTime: NOW - 30 * DAY, refFiles: [] }).unknown, false);
  });
  it('one recent edit among 300 older dirty files makes it fresh; paths past the deadline are counted, not dropped', () => {
    const dirty = Array.from({ length: 300 }, (_, i) => `f${i}.txt`);
    const stat = (p) => ({ mtimeMs: p.endsWith('f299.txt') ? NOW - 1000 : NOW - 30 * DAY, birthtimeMs: 0 });
    assert.equal(lastActivity({ worktree: '/wt', tipTime: NOW - 30 * DAY, dirty, stat }).at, NOW - 1000);
    let t = 0;
    const cut = lastActivity({ worktree: '/wt', tipTime: NOW - 30 * DAY, dirty, stat, deadlineAt: 100, clock: () => t++ });
    assert.ok(cut.notStatted > 0, 'paths not reached are disclosed');
  });
});

describe('the shared landed predicate', () => {
  it('landedReason: ahead 0 -> merged, exact merged evidence -> landed, partial or none -> null', () => {
    assert.equal(landedReason({ ahead: 0 }), 'merged');
    assert.equal(landedReason({ ahead: 3, merged: { merged: true } }), 'landed');
    assert.equal(landedReason({ ahead: 3, merged: { merged: 'partially' } }), null);
    assert.equal(landedReason({ ahead: null }), null);
  });
  it('hideReason keeps its reasons over the extraction', () => {
    const c = { prsComplete: true, now: NOW, idleMs: 14 * DAY };
    const item = { tracked: false, kind: 'branch', pr: null, worktree: null };
    assert.equal(hideReason({ ...item, ahead: 0 }, c), 'merged');
    assert.equal(hideReason({ ...item, ahead: 2, merged: { merged: true } }, c), 'landed');
    assert.equal(hideReason({ ...item, ahead: 2, tipTime: NOW - 20 * DAY }, c), 'idle');
    assert.equal(hideReason({ ...item, ahead: 2, tipTime: NOW - DAY }, c), null);
  });
});

describe('groups and cache', () => {
  it('superseded is split by via: only "on base" is removable; a duplicate is covered by a claim', () => {
    const g = groupUnregistered([
      { verdict: 'superseded', via: 'landed', stale: true }, { verdict: 'superseded', via: 'duplicate', stale: true },
      { verdict: 'unlanded', stale: true, preserved: 'none' }, { verdict: 'unlanded', stale: false },
    ]);
    assert.deepEqual([g.supersededOnBase.length, g.coveredByClaim.length, g.abandoned.length, g.fresh.length], [1, 1, 1, 1]);
  });
  it('the cache round-trips; a missing, corrupt or foreign file reads as such, never as zero', () => {
    const dir = tmpRoot('unreg-cache-');
    assert.equal(readUnregisteredCache(dir).state, 'missing');
    const rec = cacheRecord({ items: [{ verdict: 'unlanded', stale: true, preserved: 'none' }], partial: true, notProbed: 4, staleDays: 3 }, new Date(NOW));
    assert.equal(writeUnregisteredCache(dir, rec).ok, true);
    const back = readUnregisteredCache(dir);
    assert.deepEqual([back.state, back.record.counts.abandoned, back.record.counts.localOnly, back.record.notProbed], ['ok', 1, 1, 4]);
    fs.writeFileSync(path.join(dir, 'unregistered.json'), '{ nope');
    assert.equal(readUnregisteredCache(dir).state, 'unreadable');
    fs.writeFileSync(path.join(dir, 'unregistered.json'), JSON.stringify({ ...rec, extra: 1 }));
    assert.equal(readUnregisteredCache(dir).state, 'unreadable', 'strict schema');
  });
});

// ── end to end, real repos ──────────────────────────────────────────────────

describe('unregistered work in a handover — real repos', () => {
  const envFor = (cfg) => scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: cfg, CLAUDE_AUDIT_LOOP_DIR: '' });
  const addWorktree = (fx, name) => {
    const wt = path.join(tmpRoot('unreg-wt-'), name);
    git(['worktree', 'add', '-q', '-b', name, wt, 'main'], fx.repo);
    return wt;
  };
  const prepare = (fx) => {
    const A = tmpRoot('unreg-acct-');
    const r = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env: envFor(A) });
    return { r, entry: JSON.parse(fs.readFileSync(r.json.handover.json, 'utf8')).scope.repos[0] };
  };

  it('a clean worktree whose commits are PUSHED but not landed is listed and does not block (today\'s predicate missed it)', () => {
    const fx = makeFleetRepo();
    const wt = addWorktree(fx, 'pushed-work');
    commitFile(wt, 'p.txt', 'p\n');
    git(['push', '-q', 'origin', 'pushed-work'], wt);
    const { r, entry } = prepare(fx);
    assert.equal(r.status, 0, r.stdout);
    const item = entry.unregistered.find((u) => u.branch === 'pushed-work');
    assert.ok(item, JSON.stringify(entry.unregistered));
    assert.deepEqual([item.blocks, item.preserved], [false, 'remote']);
    assert.match(fs.readFileSync(r.json.handover.md, 'utf8'), /not blocking: .*pushed-work/);
  });

  it('a squash-merged worktree branch reads superseded; the same branch unmerged blocks (control)', () => {
    const fx = makeFleetRepo();
    const wt = addWorktree(fx, 'sq');
    commitFile(wt, 's.txt', 's\n');
    const before = prepare(fx);
    assert.equal(before.r.status, 3, 'unmerged, unpushed: blocks');
    git(['merge', '--squash', 'sq'], fx.repo); git(['commit', '-q', '-m', 'sq (#7)'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
    const after_ = prepare(fx);
    assert.equal(after_.r.status, 0, after_.r.stdout);
    const item = after_.entry.unregistered.find((u) => u.branch === 'sq');
    assert.deepEqual([item.verdict, item.via], ['superseded', 'landed']);
  });

  it('a BRANCH-ONLY candidate (no worktree) that was squash-merged reads superseded, not unverified', () => {
    const fx = makeFleetRepo();
    git(['checkout', '-q', '-b', 'loose', 'main'], fx.repo); commitFile(fx.repo, 'l.txt', 'l\n'); git(['checkout', '-q', 'main'], fx.repo);
    const unmerged = prepare(fx).entry.unregistered.find((u) => u.branch === 'loose');
    assert.deepEqual([unmerged.kind, unmerged.blocks], ['branch', true], 'control: unmerged and local-only, it blocks');
    git(['merge', '--squash', 'loose'], fx.repo); git(['commit', '-q', '-m', 'loose (#8)'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
    const item = prepare(fx).entry.unregistered.find((u) => u.branch === 'loose');
    assert.deepEqual([item.kind, item.verdict, item.via], ['branch', 'superseded', 'landed']);
  });

  it('prepare refuses when the registry cannot be read completely, as receive does (control: an intact registry)', () => {
    const fx = makeFleetRepo();
    const A = tmpRoot('unreg-acct-reg-');
    const env = envFor(A);
    assert.equal(runFleet(['claim', '--id', 'live-one', '--intent', 'x', '--paths', 'a.txt'], { cwd: fx.repo, env }).status, 0);
    const ok = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env });
    assert.equal(ok.status, 0, ok.stdout);
    const sessions = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet', 'sessions');
    fs.writeFileSync(path.join(sessions, 'corrupt.json'), '{ not json');
    const r = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env });
    assert.equal(r.status, 3, r.stdout);
    const entry = JSON.parse(fs.readFileSync(r.json.handover.json, 'utf8')).scope.repos[0];
    assert.deepEqual([entry.fleet, entry.error, entry.sessions.map((s) => s.id)], ['error', 'registry incomplete (unreadable session records)', ['live-one']]);
  });

  it('receipt-only dirt is sync-owned and does not block; receipt plus another file blocks', () => {
    const fx = makeFleetRepo();
    const wt = addWorktree(fx, 'synced');
    fs.writeFileSync(path.join(wt, RECEIPT_PATH), '{}\n');
    const a = prepare(fx);
    assert.equal(a.r.status, 0, a.r.stdout);
    assert.equal(a.entry.unregistered.find((u) => u.branch === 'synced').verdict, 'sync-owned');
    fs.writeFileSync(path.join(wt, 'other.md'), 'x\n');
    const b = prepare(fx);
    assert.equal(b.r.status, 3);
    assert.equal(b.entry.unregistered.find((u) => u.branch === 'synced').verdict, 'unlanded');
  });
});

/** The real git, for the call-recording probe test. */
import { runGit as archiveReportGit } from '../scripts/lib/fleet/git-facts.mjs';

describe('merged evidence stops at the caller deadline', () => {
  it('branches past the deadline read incomplete (known:false), never "not merged"; with no deadline every branch is judged (control)', () => {
    const repo = makeFleetRepo().repo;
    const tipA = commitFile(repo, 'z.txt', 'z\n'); // a commit on main is enough: we only need two resolvable names
    git(['branch', 'b1'], repo); git(['branch', 'b2'], repo);
    const base = git(['rev-parse', 'HEAD~1'], repo);
    const branches = { queried: true, branches: [{ name: 'b1', oid: tipA }, { name: 'b2', oid: tipA }] };
    let t = 0;
    const late = gatherMerged({ cwd: repo, base: 'main', baseRev: base, names: ['b1', 'b2'], branches, patchIds: {}, env: scrubbedEnv(), deadlineAt: 1, clock: () => t++ });
    assert.notEqual(late.evidence.b1.reason, 'merged evidence not computed: deadline reached', 'b1 was reached before the deadline');
    assert.deepEqual([late.evidence.b2.known, late.evidence.b2.reason], [false, 'merged evidence not computed: deadline reached']);
    const full = gatherMerged({ cwd: repo, base: 'main', baseRev: base, names: ['b1', 'b2'], branches, patchIds: {}, env: scrubbedEnv() });
    assert.notEqual(full.evidence.b2.reason, 'merged evidence not computed: deadline reached');
  });
});
