/**
 * @fileoverview The wind-down stage's measurements (docs/plans/fleet-handover-winddown.md §2.1 to §2.4, §2.8, §2.9): the readiness
 * object, the safe-to-archive list (with the nested-worktree check), spent one-off tasks and the standard directive. Pure cases over
 * injected facts, plus the stage end to end over real git. Each "does not" has a control that fires the other way.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, commitFile, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { isSwitchWait } from '../scripts/lib/fleet/handover.mjs';
import { DEFAULT_ARCHIVE_IGNORE } from '../scripts/lib/fleet/config.mjs';
import { CONTEXT_SECTIONS, contextPath } from '../scripts/lib/fleet/handover-context.mjs';
import { parseVerbArgs } from '../scripts/lib/fleet/argv.mjs';
import { syncCommands } from '../scripts/lib/fleet/consumer-bundle.mjs';
import { ARCHIVE_GUARD, renderDirective, safeToArchive, spentOneOffs, toManifestWinddown, winddownReadiness, winddownRefusal } from '../scripts/lib/fleet/handover-winddown.mjs';

after(cleanupFleetRoots);

const okCtx = { state: 'ok', sha256: 'a'.repeat(64), sections: Object.fromEntries(CONTEXT_SECTIONS.map((n) => [n, 'filled'])) };
const parked = { id: 'p', waitingOn: [{ kind: 'human', ref: 'Account_Switch' }] };
const repoOf = (over = {}) => ({ path: '/r/a', fleet: 'present', sessions: [], unregistered: [], ...over });
const ready = (repos, over = {}) => winddownReadiness(repos, { contexts: new Map(repos.map((r) => [r.path, okCtx])), isSwitchWait, ...over });

describe('winddownReadiness', () => {
  it('a repo with a complete context and every claim parked on the switch (any spelling) is ready', () => {
    const w = ready([repoOf({ sessions: [parked] })]);
    assert.equal(w.ready, true);
    assert.deepEqual(w.repos[0].reasons, []);
  });
  it('an unparked claim names itself; parking it is the control', () => {
    const w = ready([repoOf({ sessions: [{ id: 'busy', waitingOn: [{ kind: 'human', ref: 'ci' }] }, parked] })]);
    assert.match(w.repos[0].reasons[0], /1 live claim\(s\) not parked on human:account-switch: busy/);
    assert.equal(w.repos[0].prerequisites.r2.ok, false);
  });
  it('R2 over an UNMEASURED live state is not ready, never a vacuous pass over an empty list', () => {
    const w = ready([repoOf({ fleet: 'error', error: 'registry incomplete (unreadable session records)', sessions: [] })]);
    assert.equal(w.ready, false);
    assert.match(w.repos[0].reasons.join(' | '), /live state not measured \(registry incomplete/);
  });
  it('blockers come from the SAME repo state and apply to every repo, required or not; a repo that needs no coordinator is not asked for a context (controls)', () => {
    const quiet = repoOf({ path: '/r/quiet' });
    const w = winddownReadiness([repoOf(), quiet, repoOf({ path: '/r/dirty', unregistered: [{ blocks: true, verdict: 'unlanded' }] })], {
      contexts: new Map([['/r/a', okCtx]]), isSwitchWait,
    });
    const by = Object.fromEntries(w.repos.map((r) => [path.basename(r.path), r]));
    assert.equal(by.quiet.required, false);
    assert.equal(by.quiet.ready, true, 'no context needed where no coordinator is');
    assert.match(by.dirty.blockers[0], /1 item\(s\) of blocking unregistered work/);
    assert.equal(by.dirty.required, true);
    assert.match(by.dirty.reasons.join(' | '), /coordinator context missing/);
  });
  it('R3 is checked only when bundles are given: behind and unknown are not ready, current is (control), absent is not-checked', () => {
    const r = repoOf();
    const check = (b) => ready([r], { bundles: new Map([[r.path, b]]) }).repos[0];
    assert.match(check({ state: 'behind', create: 1, update: 7 }).reasons[0], /consumer bundle behind \(the sync would create 1 and update 7/);
    assert.match(check({ state: 'unknown', reason: 'exited 1' }).reasons[0], /consumer bundle not measured \(exited 1\)/);
    assert.equal(check({ state: 'current' }).ready, true);
    assert.equal(ready([r]).repos[0].prerequisites.r3.checked, false);
  });
  it('a context already handed over is stale; prepare refuses on R1 and R2 only, and a waiver passes it', () => {
    const w = ready([repoOf({ sessions: [{ id: 'busy', waitingOn: [] }] })], { handedOver: () => '20261001T000000000Z-abcdef' });
    assert.match(w.repos[0].reasons.join(' | '), /identical to the one handed over in 20261001T000000000Z-abcdef/);
    const m = toManifestWinddown(w);
    assert.match(winddownRefusal(m), /^not ready: winddown incomplete in \/r\/a: .*identical.*; 1 live claim/);
    assert.equal(winddownRefusal(toManifestWinddown(w, 'at 2 percent')), null, 'a recorded waiver passes');
    const b = toManifestWinddown(ready([repoOf()], { bundles: new Map([['/r/a', { state: 'behind', create: 1, update: 0 }]]) }));
    assert.equal(winddownRefusal(b), null, 'prepare does not repeat the sync dry run: R3 is the winddown command\'s');
    assert.equal(b.ready, false);
  });
});

describe('safeToArchive', () => {
  const w = (p, over = {}) => ({ path: p, branch: path.basename(p), head: 'h', detached: false, locked: false, bare: false, missing: false, prunable: false, ...over });
  const list = [w('/r/main'), w('/r/wt/clean'), w('/r/wt/landed'), w('/r/wt/pushed'), w('/r/wt/dirty'), w('/r/wt/claimed'), w('/r/wt/locked', { locked: true }), w('/r/wt/outer'), w('/r/wt/outer/.claude/tmp/inner')];
  const items = [
    { worktree: '/r/wt/landed', verdict: 'superseded', via: 'landed', blocks: false },
    { worktree: '/r/wt/pushed', verdict: 'unlanded', blocks: false, preserved: 'remote' },
    { worktree: '/r/wt/dirty', verdict: 'unlanded', blocks: true },
  ];
  it('clean and landed worktrees are safe; unlanded-but-pushed is listed apart; dirty, claimed, locked and the main checkout are omitted', () => {
    const r = safeToArchive({ worktrees: list, items, claimedWorktrees: ['/r/wt/claimed'] });
    assert.equal(r.measured, true);
    assert.deepEqual(r.safe.map((x) => path.basename(x.path)), ['clean', 'landed', 'inner']);
    assert.deepEqual(r.heldRemotely.map((x) => path.basename(x.path)), ['pushed']);
  });
  it('bfc0: a worktree with another worktree nested inside it is NOT safe, and names what is nested', () => {
    const r = safeToArchive({ worktrees: list, items, claimedWorktrees: [] });
    assert.deepEqual(r.nested.map((x) => [path.basename(x.path), x.nested.map((n) => path.basename(n))]), [['outer', ['inner']]]);
    assert.ok(!r.safe.some((x) => x.path.endsWith('outer')), 'control: without the nested one it would be safe');
    assert.ok(safeToArchive({ worktrees: list.filter((x) => !x.path.includes('inner')), items, claimedWorktrees: [] }).safe.some((x) => x.path.endsWith('outer')));
  });
  it('H3: containment is by path SEGMENT: a child named ..cache is nested; a sibling is not (control)', () => {
    const outer = w('/r/wt/outer2');
    const child = w('/r/wt/outer2/..cache/inner');
    const r = safeToArchive({ worktrees: [w('/r/main'), outer, child], items: [], claimedWorktrees: [] });
    assert.deepEqual(r.nested.map((x) => path.basename(x.path)), ['outer2'], 'a child whose name starts with dots is still inside');
    const sibling = safeToArchive({ worktrees: [w('/r/main'), outer, w('/r/wt/other')], items: [], claimedWorktrees: [] });
    assert.deepEqual(sibling.nested, [], 'control: a sibling is not inside');
  });
  it('a scan that did not reach everything measured nothing', () => {
    const r = safeToArchive({ worktrees: list, items, claimedWorktrees: [], partial: 'scan deadline reached' });
    assert.deepEqual([r.measured, r.safe, r.heldRemotely], [false, [], []]);
  });
});

describe('spentOneOffs', () => {
  const NOW = new Date('2026-10-21T10:00:00Z');
  const snap = new Map([
    ['ran', { fireAt: '2026-10-13T08:00:00Z', lastRunAt: '2026-10-13T08:00:05Z', enabled: true }],
    ['off', { fireAt: '2026-10-13T08:00:00Z', enabled: false }],
    ['missed', { fireAt: '2026-10-13T08:00:00Z', enabled: true }],
    ['early', { fireAt: '2026-10-13T08:00:00Z', lastRunAt: '2026-10-12T00:00:00Z', enabled: true }],
    ['future', { fireAt: '2026-11-01T08:00:00Z', enabled: true }],
    ['recurring', { cronExpression: '0 9 * * 1', enabled: true, lastRunAt: '2026-10-19T09:00:00Z' }],
  ]);
  it('a one-off that ran at or after its time, or is disabled, is spent; one that never ran, a future one and a recurring one are not (controls)', () => {
    assert.deepEqual(spentOneOffs(snap, NOW).map((t) => t.id), ['ran', 'off']);
  });
});

describe('renderDirective', () => {
  const base = { repo: '/c/GIT/storyline', cli: 'node scripts/.claude-skills/fleet.mjs', contextFile: '/c/GIT/storyline/.git/fleet/handover/context.md', proposeCli: 'node /src/scripts/fleet.mjs' };
  it('is one fixed text with this repo\'s values; the card step depends on whether the repo\'s fleet has propose (H4: true, false, unknown)', () => {
    const t = renderDirective({ ...base, propose: true });
    assert.match(t, /^WIND-DOWN for storyline/);
    assert.match(t, /Finish merges that are already approved\. Start no new work/);
    assert.match(t, /touch --id <id> --waiting-on human:account-switch/);
    assert.match(t, /context\.md \(every section; none is a valid body; names only, never key values\)/);
    assert.match(t, /node scripts\/\.claude-skills\/fleet\.mjs propose --what/);
    assert.doesNotMatch(t, /source repo/);
    const f = renderDirective({ ...base, propose: false });
    assert.match(f, /node \/src\/scripts\/fleet\.mjs propose --what .* --theme storyline \(this repo's fleet has no propose verb/);
    const u = renderDirective({ ...base, propose: 'unknown' });
    assert.match(u, /fleet\.mjs propose --what .*\(if it refuses propose, use: node \/src\/scripts\/fleet\.mjs propose/);
  });
  it('H1/M4: the repo name is a quoted argument in every template, never raw text; sync commands quote the target', () => {
    const odd = '/c/my repo; echo pwned';
    for (const propose of [false, 'unknown']) {
      const t = renderDirective({ ...base, repo: odd, propose });
      assert.match(t, /--theme 'my repo; echo pwned'/, String(propose));
      assert.doesNotMatch(t, /--theme my repo/);
    }
    assert.deepEqual(syncCommands('my app; x'), ["node scripts/sync-to-repos.mjs --target 'my app; x'", "node scripts/sync-pr.mjs --target 'my app; x' --no-merge"]);
    assert.deepEqual(syncCommands('wine-cellar-app'), ['node scripts/sync-to-repos.mjs --target wine-cellar-app', 'node scripts/sync-pr.mjs --target wine-cellar-app --no-merge'], 'control: a plain name is left alone');
  });
  it('M6: every propose template satisfies the real CLI argument contract (--what --where --why), validated by the parser itself', () => {
    const tokens = (cmd) => [...cmd.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) => m[0].replace(/^["']|["']$/g, ''));
    for (const propose of [true, false, 'unknown']) {
      const line = renderDirective({ ...base, propose }).split('\n').find((l) => l.includes(' propose '));
      const after = line.slice(line.indexOf(' propose ') + ' propose '.length).replace(/\s*\(.*$/, '');
      const { flags } = parseVerbArgs('propose', tokens(after));
      for (const k of ['--what', '--where', '--why']) assert.ok(flags[k], `${propose}: ${k} missing from ${after}`);
    }
  });
  it('93b1/bfc0: the guard orders the host-side checks and the post-archive re-check', () => {
    const g = ARCHIVE_GUARD.join('\n');
    assert.ok(g.indexOf('get_session on the candidate') < g.indexOf('side sessions') && g.indexOf('side sessions') < g.indexOf('cascade is the unit of safety'));
    assert.match(g, /After EACH archive_session, run git worktree list/);
  });
});

describe('the stage over real git', () => {
  const envFor = (cfg) => scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: cfg, CLAUDE_AUDIT_LOOP_DIR: '' });
  it('lists a clean landed worktree as safe, omits one with an ignored file, flags a nested worktree, and lists a pushed-but-unlanded one apart', () => {
    const fx = makeFleetRepo({ fleetConfig: { archiveIgnore: [...DEFAULT_ARCHIVE_IGNORE, '.claude/tmp/**'] } });
    const A = tmpRoot('wd-real-'); fs.mkdirSync(path.join(A, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(fx.repo, '.gitignore'), 'journal.local\n.claude/tmp/\n');
    git(['add', '.gitignore'], fx.repo); git(['commit', '-q', '-m', 'ignore'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
    const wtRoot = tmpRoot('wd-real-wt-');
    const add = (name) => { const p = path.join(wtRoot, name); git(['worktree', 'add', '-q', '-b', name, p, 'main'], fx.repo); return p; };
    const clean = add('clean');
    const journal = add('journal'); fs.writeFileSync(path.join(journal, 'journal.local'), 'only copy\n');
    const outer = add('outer');
    git(['worktree', 'add', '-q', '--detach', path.join(outer, '.claude', 'tmp', 'inner'), 'main'], fx.repo);
    const pushed = add('pushed'); commitFile(pushed, 'p.txt', 'p\n'); git(['push', '-q', 'origin', 'pushed'], pushed);
    const f = path.join(contextPath(fx.repo));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, CONTEXT_SECTIONS.map((n) => `## ${n}\n\nnone\n`).join('\n'));
    const r = runFleet(['handover', 'winddown', '--json'], { cwd: fx.repo, env: envFor(A) });
    const safe = r.json.winddown.safe[fx.repo];
    const names = (l) => l.map((x) => path.basename(x.path)).sort();
    assert.equal(safe.measured, true, r.stdout);
    assert.ok(names(safe.safe).includes('clean'), JSON.stringify(safe));
    assert.ok(!names(safe.safe).includes('journal'), 'a worktree whose only state is an ignored file is not safe');
    assert.ok(!names(safe.safe).includes('outer'));
    assert.deepEqual(safe.nested.map((x) => path.basename(x.path)), ['outer']);
    assert.deepEqual(names(safe.heldRemotely), ['pushed']);
    assert.match(r.json.text, /nested worktree: .*outer contains .*inner: remove it first/);
    assert.match(r.json.text, /Before EACH archive_session/);
    assert.ok(clean);
  });
});
