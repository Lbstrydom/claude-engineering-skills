/**
 * @fileoverview Unregistered-work SURFACES (docs/plans/fleet-unclaimed-work-and-switch-friction.md §2.2, Cluster B):
 * the status section, the derived cache and the checkpoint footer that reads it, the hidden-line note,
 * untracked-to-untracked overlap collapse, archive-tag durability, the runGit env allowlist and the config key.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv } from './helpers/fleet-repo.mjs';
import { UNREGISTERED_CACHE_MAX_AGE_MS, unregisteredFooter } from '../scripts/lib/fleet/coordination.mjs';
import { renderStatus, renderUnregistered } from '../scripts/lib/fleet/render.mjs';
import { PREPUSH_SANDBOX_RE, groupUnregistered, isPrepushSandbox, scanArchiveTags, unregisteredWork } from '../scripts/lib/fleet/unregistered.mjs';
import { SANDBOX_PREFIX } from '../scripts/lib/prepush-sandbox-cleanup.mjs';
import { RUN_GIT_ENV_ALLOWED, runGit } from '../scripts/lib/fleet/git-facts.mjs';
import { parseFleetConfig } from '../scripts/lib/fleet/config.mjs';

after(cleanupFleetRoots);

const NOW = Date.parse('2026-10-11T12:00:00Z');

describe('the checkpoint footer reads the cache and never scans', () => {
  const rec = (over = {}) => ({
    schemaVersion: 1, at: new Date(NOW - 2 * 3_600_000).toISOString(), staleDays: 3, partial: false, notProbed: 0,
    counts: { candidates: 5, total: 4, abandoned: 3, localOnly: 1, unverified: 0 }, ...over,
  });
  const none = { candidates: 1, total: 0, abandoned: 0, localOnly: 0, unverified: 0 };
  const footer = (r) => unregisteredFooter('D', new Date(NOW), 'fleet', { read: () => r });

  it('FYI when abandoned > 0, worded as NOT an action for this session; silent when nothing is abandoned (control)', () => {
    assert.deepEqual(footer({ state: 'ok', record: rec() }), [
      'FYI for the user/coordinator, not an action for this session: 3 worktree(s)/branch(es) idle >3d hold unlanded work, 1 of them local-only (no remote ref holds it) — fleet status (scan 2h old)',
    ]);
    assert.deepEqual(footer({ state: 'ok', record: rec({ counts: none }) }), []);
  });
  it('a refresh request when missing, unreadable or over 24 h old — and NOT when merely partial (a coverage notice instead)', () => {
    assert.deepEqual(footer({ state: 'missing' }), ['unregistered-work scan is missing — run `fleet status` (read-only) to refresh']);
    assert.deepEqual(footer({ state: 'unreadable', reason: 'x' }), ['unregistered-work scan is unreadable — run `fleet status` (read-only) to refresh']);
    const at = new Date(NOW - UNREGISTERED_CACHE_MAX_AGE_MS - 3_600_000).toISOString();
    assert.deepEqual(footer({ state: 'ok', record: rec({ at, counts: none }) }), ['unregistered-work scan is 1d old — run `fleet status` (read-only) to refresh']);
    const partial = footer({ state: 'ok', record: rec({ partial: true, notProbed: 4, counts: { ...none, candidates: 23 } }) });
    assert.deepEqual(partial, ['unregistered-work scan covered 19 of 23 worktrees/branches (4 not probed)'], 'information, never a request');
  });
  it('never more than three lines: every coverage gap is ONE line (round 4)', () => {
    const at = new Date(NOW - UNREGISTERED_CACHE_MAX_AGE_MS - 3_600_000).toISOString();
    const lines = footer({ state: 'ok', record: rec({ at, partial: true, notProbed: 4, branchesUnknown: 'branch inventory not read: x', counts: { candidates: 23, total: 5, abandoned: 3, localOnly: 1, unverified: 0 } }) });
    assert.equal(lines.length, 3);
    assert.match(lines[2], /covered 19 of 23 .*; branch inventory not read: x/);
  });
  it('a throwing reader cannot break the verb', () => {
    assert.match(unregisteredFooter('D', new Date(NOW), 'fleet', { read: () => { throw new Error('disk'); } })[0], /not derived/);
  });
  it('end to end: touch reports the cache missing; status writes it; touch then reads it (no scan in touch)', () => {
    const fx = makeFleetRepo();
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off' });
    assert.equal(runFleet(['claim', '--id', 'me', '--intent', 'x', '--paths', 'a.txt'], { cwd: fx.repo, env }).status, 0);
    assert.match(runFleet(['touch', '--id', 'me'], { cwd: fx.repo, env }).stdout, /unregistered-work scan is missing — run/);
    const st = runFleet(['status'], { cwd: fx.repo, env });
    assert.match(st.stdout, /Unregistered work — /);
    const cache = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet-cache', 'unregistered.json');
    assert.ok(fs.existsSync(cache), 'status wrote the derived cache');
    const after_ = runFleet(['touch', '--id', 'me'], { cwd: fx.repo, env });
    assert.equal(after_.status, 0);
    assert.doesNotMatch(after_.stdout, /unregistered-work scan is (missing|unreadable)/);
  });
});

describe('the status section and the hidden line', () => {
  it('possibly-abandoned in full, local-only first; superseded split by via; counts otherwise; partial is said', () => {
    const items = [
      { kind: 'branch', branch: 'pushed', verdict: 'unlanded', stale: true, preserved: 'remote', ahead: 3, idleDays: 30, risks: {}, reason: 'r' },
      { kind: 'branch', branch: 'local', verdict: 'unlanded', stale: true, preserved: 'none', ahead: 49, idleDays: 9, risks: { unpushed: 49 }, reason: 'r' },
      { kind: 'worktree', worktree: '/w', branch: 'gone', verdict: 'superseded', via: 'landed', stale: true, risks: {}, reason: 'r' },
      { kind: 'worktree', worktree: '/w2', branch: 'twin', verdict: 'superseded', via: 'duplicate', stale: true, risks: {}, reason: 'r' },
    ];
    const out = renderUnregistered({ queried: true, items, partial: true, notProbed: 2, staleDays: 3 }, { groups: groupUnregistered(items) }).join('\n');
    assert.match(out, /NOT FULLY MEASURED: 2 not probed/);
    assert.ok(out.indexOf('local (no worktree)') < out.indexOf('pushed (no worktree)'), 'local-only ranks first');
    assert.match(out, /superseded, on base \(removable — see fleet prune\) — 1/);
    assert.match(out, /covered by a live claim .*not removable yet.* — 1/);
    assert.doesNotMatch(out, /\/w2/, 'counted groups are not listed without --all');
    assert.match(renderUnregistered({ queried: true, items, partial: false, notProbed: 0, staleDays: 3 }, { groups: groupUnregistered(items), all: true }).join('\n'), /\/w2/);
  });
  it('the hidden line says how many hidden items are unlanded; untracked-to-untracked overlaps collapse, a live-claim overlap stays (control)', () => {
    const base = { registry: { complete: true, invalid: [] }, base: { name: 'main' }, observedAt: new Date(NOW).toISOString(), sources: { worktrees: { queried: true }, branches: { queried: true }, prs: { queried: true } }, landingOrder: [], cycles: [], trains: [] };
    const item = (id, tracked, overlaps) => ({ id, tracked, display: tracked ? 'working' : 'untracked', branch: id, ahead: 1, behind: 0, worktree: null, overlaps, waitingOn: [], duplicates: [], findings: [], notes: [], pr: null });
    const status = { ...base, items: [item('u1', false, [{ with: 'u2', via: ['files'], files: ['a'] }, { with: 'claim', via: ['files'], files: ['b'] }]), item('u2', false, []), item('claim', true, [])] };
    const text = renderStatus(status, { hidden: { count: 2, ids: ['h1', 'h2'], idle: 2, idleDays: 14 }, unregistered: { queried: true, items: [{ branch: 'h1', verdict: 'unlanded' }] } });
    assert.match(text, /2 hidden \(2 idle > 14 days\) \(1 of them unlanded — see Unregistered work\)/);
    assert.match(text, /overlaps 1 other untracked branch \(--all\)/);
    assert.match(text, /overlaps claim \(files\) on b/);
    assert.match(renderStatus(status, { all: true }), /overlaps u2 \(files\) on a/, '--all shows them in full');
  });
});

describe('archive tags: where each one lives (v)', () => {
  const tagsGit = ({ ls, tracking = '' }) => (args) => {
    if (args[0] === 'for-each-ref') return { ok: true, stdout: `archive/x\0${'a'.repeat(40)}\0\n` };
    if (args[0] === 'ls-remote') return ls;
    if (args[0] === 'branch') return { ok: true, stdout: tracking };
    return { ok: false, reason: 'unexpected' };
  };
  const run = (g, pid = 'p', window = new Map()) => scanArchiveTags('R', { baseRev: 'b'.repeat(40), git: g, patchIdOf: () => ({ id: pid }), squash: { byPatchId: window } }).tags[0];
  it('remote only with the SAME name at the SAME oid; tracking-only is last-fetch; a failed ls-remote is unknown; otherwise local-only', () => {
    assert.equal(run(tagsGit({ ls: { ok: true, stdout: `${'a'.repeat(40)}\trefs/tags/archive/x\n` } })).preserved, 'remote');
    assert.equal(run(tagsGit({ ls: { ok: true, stdout: `${'c'.repeat(40)}\trefs/tags/archive/x\n` } })).preserved, 'local-only', 'same name, different oid');
    assert.equal(run(tagsGit({ ls: { ok: true, stdout: '' }, tracking: '  origin/feature\n' })).preserved, 'last-fetch');
    assert.equal(run(tagsGit({ ls: { ok: false, reason: 'offline' } })).preserved, 'unknown');
    assert.equal(run(tagsGit({ ls: { ok: true, stdout: '' } })).preserved, 'local-only');
    const trackingFails = (args) => (args[0] === 'branch' ? { ok: false, reason: 'boom' } : tagsGit({ ls: { ok: true, stdout: '' } })(args));
    assert.equal(run(trackingFails).preserved, 'unknown', 'a failed tracking lookup is not "local-only"');
  });
  it('an empty whole diff or a patch-id in the squash window is superseded; otherwise unlanded', () => {
    const g = tagsGit({ ls: { ok: true, stdout: '' } });
    assert.equal(run(g, null).verdict, 'superseded');
    assert.equal(run(g, 'p', new Map([['p', 'c']])).verdict, 'superseded');
    assert.equal(run(g).verdict, 'unlanded');
  });
});

describe('archive-tag coverage is disclosed even with nothing unlanded (round 2)', () => {
  it('overflow with zero unlanded still prints a line; past the deadline the squash window is not read', () => {
    const items = [];
    const out = renderUnregistered({ queried: true, items, partial: false, notProbed: 0, staleDays: 3 }, {
      groups: groupUnregistered(items), tags: { queried: true, tags: [], overflow: 7, counts: { unlanded: 0, superseded: 0, 'local-only': 0, 'last-fetch': 0, remote: 0, unknown: 0 } },
    }).join('\n');
    assert.match(out, /archive tags: 7 not judged/);
    let squashRead = false;
    const g = (args) => (args[0] === 'for-each-ref' ? { ok: true, stdout: `archive/x\0${'a'.repeat(40)}\0\n` } : (squashRead = true, { ok: true, stdout: '' }));
    let t = 0; // the listing runs at t=0 (before the deadline at 1); every later check is past it
    const scan = scanArchiveTags('R', { baseRev: 'b'.repeat(40), git: g, deadlineAt: 1, clock: () => t++, patchIdOf: () => { throw new Error('no patch-id past the deadline'); } });
    assert.deepEqual([scan.tags.length, scan.overflow], [0, 1], 'nothing judged, the one tag disclosed as not judged');
    assert.equal(squashRead, false);
  });
});

describe('pre-push sandboxes are tooling, not unregistered work', () => {
  const tmp = os.tmpdir();
  const wt = (over) => ({ path: path.join(tmp, 'ces-prepush-e2815e98-74892'), detached: true, ...over });
  it('detached + directly under the temp dir + the exact name → tooling; each look-alike stays work (controls)', () => {
    assert.equal(isPrepushSandbox(wt({}), { tmpDirs: [tmp] }), true);
    assert.equal(isPrepushSandbox(wt({ detached: false }), { tmpDirs: [tmp] }), false, 'a branch checked out: work');
    assert.equal(isPrepushSandbox(wt({ path: path.join(tmp, 'sub', 'ces-prepush-e2815e98-74892') }), { tmpDirs: [tmp] }), false, 'not directly under the temp dir');
    assert.equal(isPrepushSandbox(wt({ path: path.join(tmp, 'ces-prepush-notasha-74892') }), { tmpDirs: [tmp] }), false, 'not the exact name');
  });
  it('the scan lists it as tooling, not as an item; a non-tooling worktree is still an item (control)', () => {
    const list = () => ({ queried: true, worktrees: [{ path: path.join(tmp, 'ces-prepush-abcdef12-1'), detached: true, head: 'a'.repeat(40) }, { path: '/w/x', branch: 'x', head: 'b'.repeat(40) }] });
    const scan = unregisteredWork('R', { config: { baseBranch: 'main' }, now: new Date(NOW) }, {}, {
      facts: { base: { name: 'main' }, baseOid: 'c'.repeat(40), branches: { queried: true, branches: [{ name: 'x', oid: 'b'.repeat(40), ahead: 1 }] }, merged: { evidence: {} } },
      list, report: () => ({ risks: { staged: [], unstaged: [], untracked: ['w.md'], ignored: [], unpushed: [] }, unverified: [] }), stat: () => { throw new Error('none'); },
    });
    assert.deepEqual(scan.tooling.map((t) => path.basename(t.worktree)), ['ces-prepush-abcdef12-1']);
    assert.deepEqual(scan.items.map((i) => i.branch), ['x']);
  });
  it('the shape is pinned to the pre-push code that makes the directory (a rename there fails here)', () => {
    const src = fs.readFileSync(new URL('../scripts/prepush-check.mjs', import.meta.url), 'utf8');
    assert.match(src, /path\.join\(os\.tmpdir\(\), `ces-prepush-\$\{shortSha\}-\$\{process\.pid\}`\)/);
    assert.match(src, /const shortSha = headSha\.slice\(0, 8\);/);
    assert.equal(SANDBOX_PREFIX, 'ces-prepush-');
    assert.match(`${SANDBOX_PREFIX}e2815e98-1`, PREPUSH_SANDBOX_RE);
  });
});

describe('runGit env allowlist and the staleWorktreeDays key', () => {
  it('admits only a temporary index and a fixed identity/date; anything else throws (control: an allowed key runs)', () => {
    const repo = makeFleetRepo().repo;
    assert.throws(() => runGit(['status'], repo, { env: { GIT_DIR: '/elsewhere' } }), /not allowed/);
    assert.equal(runGit(['status', '--porcelain'], repo, { env: { GIT_AUTHOR_NAME: 'x' } }).ok, true);
    for (const k of ['GIT_INDEX_FILE', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_EMAIL']) assert.match(k, RUN_GIT_ENV_ALLOWED);
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS']) assert.doesNotMatch(k, RUN_GIT_ENV_ALLOWED);
  });
  it('staleWorktreeDays: default 3, 1..3650, a non-integer is a named error', () => {
    assert.equal(parseFleetConfig({}).value.staleWorktreeDays, 3);
    assert.equal(parseFleetConfig({ staleWorktreeDays: 7 }).value.staleWorktreeDays, 7);
    assert.match(parseFleetConfig({ staleWorktreeDays: 0 }).errors.join(' '), /staleWorktreeDays/);
    assert.match(parseFleetConfig({ staleWorktreeDays: 1.5 }).errors.join(' '), /whole number/);
  });
});
