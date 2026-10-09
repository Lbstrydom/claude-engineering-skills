/**
 * @fileoverview /fleet — the capstone consumer's two asks (2026-10-08).
 * Plan: docs/plans/fleet-capstone-feedback.md.
 *   (a) the default `status` view hides untracked branches with no recent commit
 *       (no open PR, no registration, clean-or-absent worktree); every unknown
 *       keeps the item visible; `--all` shows them; overlaps INTO hidden items fold
 *       to one count line
 *   (b) `.fleet.json` `hotFiles`: overlaps made only of hot files are reported
 *       apart, never counted as conflicts and never blocking a claim — but always
 *       disclosed; mixed evidence still blocks
 *
 * Every "hides"/"does not block" assertion is paired with a negative control that
 * fires the other way on the same input, so a predicate that answered one value
 * for everything would fail here.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { git } from './helpers/git.mjs';
import {
  DEFAULT_IDLE_DAYS, buildStatus, decideClaim, hideReason, idleMsFrom, isBlockingConflict, isHotFile, isIdleTip, splitHidden,
} from '../scripts/lib/fleet/overlap.mjs';
import { probeWorktreeCleanliness, payloadFromStatus } from '../scripts/lib/fleet/facts.mjs';
import { MAX_HOT_FILES, parseFleetConfig } from '../scripts/lib/fleet/config.mjs';
import { renderClaimVerdict, renderStatus } from '../scripts/lib/fleet/render.mjs';
import {
  addBranch, cleanupFleetRoots, installFakeGh, makeFleetRepo, runFleet, scrubbedEnv, writeFile,
} from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-08T12:00:00Z');
const IDLE_MS = DEFAULT_IDLE_DAYS * DAY;
const ago = (days) => NOW - days * DAY;

// ── (a) idle hiding: the predicate ──────────────────────────────────────────
const item = (over = {}) => ({
  id: 'old', tracked: false, kind: 'branch', ahead: 6, pr: null, worktree: null, worktreeClean: null, tipTime: ago(60),
  state: 'untracked', display: 'untracked', branch: 'old', waitingOn: [], overlaps: [], hotOverlaps: [], duplicates: [], findings: [], notes: [], ...over,
});
const ctx = { prsComplete: true, now: NOW, idleMs: IDLE_MS };

describe('isIdleTip — every unknown answers false', () => {
  it('older than the window is idle; the same tip inside the window is not (control)', () => {
    assert.equal(isIdleTip(ago(15), NOW, IDLE_MS), true);
    assert.equal(isIdleTip(ago(13), NOW, IDLE_MS), false);
  });
  it('exactly at the window is not idle (strict)', () => assert.equal(isIdleTip(NOW - IDLE_MS, NOW, IDLE_MS), false));
  it('missing tip, missing clock, future-dated tip, non-positive window', () => {
    assert.equal(isIdleTip(null, NOW, IDLE_MS), false);
    assert.equal(isIdleTip(ago(60), null, IDLE_MS), false);
    assert.equal(isIdleTip(NOW + 30 * DAY, NOW, IDLE_MS), false);
    assert.equal(isIdleTip(ago(60), NOW, 0), false);
    assert.equal(isIdleTip(ago(60), NOW, NaN), false);
  });
});

describe('hideReason — idle untracked branches, on sufficient evidence only', () => {
  it('ahead, no PR, no registration, old tip, complete PR lookup => idle', () => assert.equal(hideReason(item(), ctx), 'idle'));
  it('ahead 0 keeps its existing reason (merged)', () => assert.equal(hideReason(item({ ahead: 0, tipTime: NOW }), ctx), 'merged'));
  it('a clean attached worktree may be hidden; a dirty or unknown one may not', () => {
    assert.equal(hideReason(item({ worktree: '/w', worktreeClean: true }), ctx), 'idle');
    assert.equal(hideReason(item({ worktree: '/w', worktreeClean: false }), ctx), null);
    assert.equal(hideReason(item({ worktree: '/w', worktreeClean: null }), ctx), null);
  });
  it('table of everything that must NOT be hidden', () => {
    const cases = {
      'recent commit': item({ tipTime: ago(2) }),
      'tip time unknown': item({ tipTime: null }),
      'future-dated tip': item({ tipTime: NOW + 10 * DAY }),
      'ahead unknown': item({ ahead: null }),
      'has an open PR': item({ pr: { number: 9 } }),
      'registered session': item({ tracked: true }),
      'detached worktree': item({ kind: 'worktree' }),
      'remote-only PR': item({ kind: 'remote-only' }),
    };
    for (const [why, it] of Object.entries(cases)) assert.equal(hideReason(it, ctx), null, why);
    assert.equal(hideReason(item(), { ...ctx, prsComplete: false }), null, 'PR lookup incomplete/unqueried');
    assert.equal(hideReason(item(), { ...ctx, now: null }), null, 'no clock');
  });
  it('the window comes from config; a longer window keeps a 60-day branch visible (control)', () => {
    assert.equal(idleMsFrom({}), IDLE_MS);
    assert.equal(hideReason(item(), { ...ctx, idleMs: idleMsFrom({ hideIdleAfterDays: 30 }) }), 'idle');
    assert.equal(hideReason(item(), { ...ctx, idleMs: idleMsFrom({ hideIdleAfterDays: 90 }) }), null);
  });
});

// ── (a) idle hiding: the presentation boundary ──────────────────────────────
describe('splitHidden — idle items, reasons, folded overlaps', () => {
  const status = (items, prsComplete = true) => ({ observedAt: new Date(NOW).toISOString(), sources: { prs: { complete: prsComplete } }, items });
  const scene = () => {
    const live = item({ id: 'live', branch: 'live', tipTime: ago(1), overlaps: [{ with: 'old', via: ['files'], files: ['x.js'], known: false }, { with: 'peer', via: ['files'], files: ['y.js'], known: false }], hotOverlaps: [{ with: 'old', files: ['tech-debt.json'] }] });
    const peer = item({ id: 'peer', branch: 'peer', tipTime: ago(1), overlaps: [{ with: 'live', via: ['files'], files: ['y.js'], known: false }] });
    const old = item({ id: 'old', overlaps: [{ with: 'live', via: ['files'], files: ['x.js'], known: false }], hotOverlaps: [{ with: 'live', files: ['tech-debt.json'] }] });
    const merged = item({ id: 'merged', ahead: 0, tipTime: ago(1) });
    return status([live, peer, old, merged]);
  };

  it('default hides idle and merged, counted by reason', () => {
    const v = splitHidden(scene(), { idleMs: IDLE_MS });
    assert.deepEqual(v.items.map((i) => i.id), ['live', 'peer']);
    assert.deepEqual(v.hidden, { count: 2, ids: ['old', 'merged'], unchecked: 0, merged: 1, landed: 0, idle: 1, idleDays: DEFAULT_IDLE_DAYS });
  });
  it('an overlap INTO a hidden item folds to overlapsWithHidden; an overlap between visible items stays', () => {
    const live = splitHidden(scene(), { idleMs: IDLE_MS }).items.find((i) => i.id === 'live');
    assert.deepEqual(live.overlaps.map((o) => o.with), ['peer']);
    assert.deepEqual(live.hotOverlaps, []);
    assert.deepEqual(live.overlapsWithHidden, ['old']);
  });
  it('--all shows everything unchanged; the input is never mutated', () => {
    const s = scene();
    const before = JSON.stringify(s);
    const v = splitHidden(s, { all: true, idleMs: IDLE_MS });
    assert.equal(v.items.length, 4);
    assert.equal(v.items.find((i) => i.id === 'live').overlapsWithHidden, undefined);
    splitHidden(s, { idleMs: IDLE_MS });
    assert.equal(JSON.stringify(s), before);
  });
  it('control: a window longer than the tip age hides only the merged item', () => {
    const v = splitHidden(scene(), { idleMs: 90 * DAY });
    assert.deepEqual(v.hidden.ids, ['merged']);
    assert.equal(v.items.find((i) => i.id === 'live').overlapsWithHidden, undefined);
  });
  it('PR list incomplete => nothing hidden', () => assert.equal(splitHidden(status(scene().items, false), { idleMs: IDLE_MS }).hidden.count, 0));
  it('an idle branch whose worktree cleanliness is unknown stays visible and is counted', () => {
    const v = splitHidden(status([item({ worktree: '/w', worktreeClean: null })]), { idleMs: IDLE_MS });
    assert.deepEqual([v.items.length, v.hidden.count, v.hidden.unchecked], [1, 0, 1]);
  });
});

describe('probeWorktreeCleanliness — idle branches are candidates too', () => {
  const branches = { queried: true, branches: [{ name: 'idle', ahead: 3, tipTime: ago(40) }, { name: 'busy', ahead: 3, tipTime: ago(1) }, { name: 'nocount', ahead: null, tipTime: ago(40) }] };
  const wts = { queried: true, worktrees: [{ path: '/i', branch: 'idle' }, { path: '/b', branch: 'busy' }, { path: '/n', branch: 'nocount' }] };
  it('probes the idle worktree only; the recent and the count-unknown ones are never probed', () => {
    const probed = [];
    const out = probeWorktreeCleanliness({ branches, worktreeList: wts, registry: { sessions: [] }, base: 'main', now: NOW, idleMs: IDLE_MS, probe: (p) => { probed.push(p); return { ok: true, stdout: '' }; } });
    assert.deepEqual(probed, ['/i']);
    assert.deepEqual(out, { '/i': true });
  });
  it('control: without a clock nothing ahead is a candidate (the pre-existing behaviour)', () => {
    let calls = 0;
    probeWorktreeCleanliness({ branches, worktreeList: wts, registry: { sessions: [] }, base: 'main', probe: () => { calls += 1; return { ok: true, stdout: '' }; } });
    assert.equal(calls, 0);
  });
});

// ── (b) hot files: config ───────────────────────────────────────────────────
describe('.fleet.json hotFiles / hideIdleAfterDays — strict validation', () => {
  it('defaults: no hot files, the default idle window', () => {
    const v = parseFleetConfig({}).value;
    assert.deepEqual([v.hotFiles, v.hideIdleAfterDays], [[], DEFAULT_IDLE_DAYS]);
  });
  it('accepted: literal paths and claim-grammar globs; a whole number of days', () => {
    const r = parseFleetConfig({ hotFiles: ['domainBudgets.json', '**/tech-debt.json', 'baselines/*.json'], hideIdleAfterDays: 30 });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.value.hotFiles, ['domainBudgets.json', '**/tech-debt.json', 'baselines/*.json']);
    assert.equal(r.value.hideIdleAfterDays, 30);
  });
  it('rejected, naming the entry: outside the grammar, escaping the repo, absolute, empty', () => {
    for (const bad of ['../x.json', '/abs.json', 'a/{b,c}.json', '', 'a//b.json', 'x**.json']) {
      const r = parseFleetConfig({ hotFiles: ['ok.json', bad] });
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.match(r.errors.join('\n'), /hotFiles(\.1)?:/, JSON.stringify(bad));
    }
  });
  it('rejected: not an array, a non-string entry, more than the cap', () => {
    assert.equal(parseFleetConfig({ hotFiles: 'tech-debt.json' }).ok, false);
    assert.equal(parseFleetConfig({ hotFiles: [7] }).ok, false);
    assert.equal(parseFleetConfig({ hotFiles: Array.from({ length: MAX_HOT_FILES + 1 }, (_, i) => `f${i}.json`) }).ok, false);
    assert.equal(parseFleetConfig({ hotFiles: Array.from({ length: MAX_HOT_FILES }, (_, i) => `f${i}.json`) }).ok, true, 'the cap itself is accepted');
  });
  it('rejected: hideIdleAfterDays zero, negative, fractional, a string', () => {
    for (const bad of [0, -1, 1.5, '14']) assert.equal(parseFleetConfig({ hideIdleAfterDays: bad }).ok, false, JSON.stringify(bad));
  });
  it('strictness intact: a near-miss key is refused by name', () => {
    const r = parseFleetConfig({ hotfiles: ['x.json'] });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /unknown key "hotfiles"/);
  });
});

// ── (b) hot files: the claim gate ───────────────────────────────────────────
describe('decideClaim — hot-only evidence is disclosed, never blocking', () => {
  const HOT = ['tech-debt.json', '**/domainBudgets.json'];
  const other = (over = {}) => ({ session: { id: 'a', intent: 'feature a', paths: ['src/a/**'], state: 'working', knownOverlaps: [], ...over.session }, live: true, changedFiles: over.changedFiles ?? ['src/a/x.js', 'tech-debt.json'] });
  const claim = (paths, intent = 'feature b') => ({ id: 'b', intent, paths, knownOverlaps: [] });

  it('my declared path meets only a hot changed file => ok, conflict marked hotOnly with the file', () => {
    const v = decideClaim({ claim: claim(['tech-debt.json', 'src/b/**']), mode: 'new', others: [other()], complete: true, hotFiles: HOT });
    assert.equal(v.verdict, 'ok');
    assert.deepEqual(v.conflicts.map((c) => [c.with, c.via, c.hotFiles, c.hotOnly, c.files]), [['a', ['hot-files'], ['tech-debt.json'], true, []]]);
    assert.equal(isBlockingConflict(v.conflicts[0]), false);
  });
  it('control: the same input without hotFiles BLOCKS', () => {
    const v = decideClaim({ claim: claim(['tech-debt.json', 'src/b/**']), mode: 'new', others: [other()], complete: true });
    assert.equal(v.verdict, 'blocked');
    assert.deepEqual(v.conflicts[0].files, ['tech-debt.json']);
  });
  it('two literal declarations of the same hot file => ok (the pair can only meet on that file)', () => {
    const v = decideClaim({ claim: claim(['pkg/domainBudgets.json']), mode: 'new', others: [other({ session: { paths: ['pkg/domainBudgets.json'] }, changedFiles: [] })], complete: true, hotFiles: HOT });
    assert.equal(v.verdict, 'ok');
    assert.deepEqual(v.conflicts[0].hotFiles, ['pkg/domainBudgets.json']);
  });
  it('a wildcard pair still blocks even when it also covers a hot file (it may cover non-hot files)', () => {
    const v = decideClaim({ claim: claim(['pkg/*.json']), mode: 'new', others: [other({ session: { paths: ['pkg/**'] }, changedFiles: [] })], complete: true, hotFiles: HOT });
    assert.equal(v.verdict, 'blocked');
    assert.equal(v.conflicts[0].hotOnly, undefined);
    // The hot glob matches the pattern TEXT `pkg/*.json` (`?` eats the `*`) but not `pkg/ab.json`, which the
    // pattern covers: only a literal path may be classified by matching its text.
    assert.equal(isHotFile('pkg/*.json', ['pkg/?.json']), true, 'precondition: the text matches');
    const w = decideClaim({ claim: claim(['pkg/*.json']), mode: 'new', others: [other({ session: { paths: ['pkg/**'] }, changedFiles: [] })], complete: true, hotFiles: ['pkg/?.json'] });
    assert.equal(w.verdict, 'blocked');
  });
  it('mixed evidence (a real file AND a hot file) blocks, with the hot file disclosed apart', () => {
    const v = decideClaim({ claim: claim(['lib/z.js', 'tech-debt.json']), mode: 'new', others: [other({ changedFiles: ['lib/z.js', 'tech-debt.json'] })], complete: true, hotFiles: HOT });
    assert.equal(v.verdict, 'blocked');
    const c = v.conflicts[0];
    assert.deepEqual([c.via, c.files, c.hotFiles, c.hotOnly], [['files', 'hot-files'], ['lib/z.js'], ['tech-debt.json'], false]);
  });
  it('identical intent is never hot: hot files plus same intent blocks', () => {
    const v = decideClaim({ claim: claim(['tech-debt.json'], 'feature a'), mode: 'new', others: [other()], complete: true, hotFiles: HOT });
    assert.equal(v.verdict, 'blocked');
  });
  it('adopt mode: hot-only is ok, not warn', () => {
    const v = decideClaim({ claim: claim(['tech-debt.json']), mode: 'adopt', others: [other()], complete: true, hotFiles: HOT });
    assert.equal(v.verdict, 'ok');
  });
  it('rendered: [hot] and "disclosed, not blocking"; mixed says "not counted"', () => {
    const ok = decideClaim({ claim: claim(['tech-debt.json']), mode: 'new', others: [other()], complete: true, hotFiles: HOT });
    assert.match(renderClaimVerdict(ok, { id: 'b' }), /^OK for b\n {2}\[hot\] a: hot-files — hot files tech-debt\.json \(disclosed, not blocking\)$/);
    const mixed = decideClaim({ claim: claim(['lib/z.js', 'tech-debt.json']), mode: 'new', others: [other({ changedFiles: ['lib/z.js', 'tech-debt.json'] })], complete: true, hotFiles: HOT });
    assert.match(renderClaimVerdict(mixed, { id: 'b' }), /BLOCKED[^\n]*\n {2}a: files\+hot-files — files lib\/z\.js; hot files tech-debt\.json \(not counted\)/);
  });
  it('isHotFile: dot-files and case-exact, like claim matching', () => {
    assert.equal(isHotFile('.cfg/tech-debt.json', ['**/tech-debt.json']), true);
    assert.equal(isHotFile('Tech-Debt.json', ['tech-debt.json']), false);
    assert.equal(isHotFile('tech-debt.json', []), false);
  });
});

// ── (b) hot files: the status join ──────────────────────────────────────────
describe('buildStatus — hot overlaps reported apart, not counted', () => {
  const facts = (hotFiles) => ({
    now: NOW, base: { name: 'main' }, hotFiles,
    registry: { complete: true, sessions: [
      { id: 'r1', rev: 1, gen: 1, state: 'ready', ready: { oid: 'o1', at: new Date(ago(2)).toISOString() }, intent: 'one', paths: [], waitingOn: [], knownOverlaps: [], leaseExpiresAt: new Date(NOW + DAY).toISOString(), source: { kind: 'branch', branch: 'r1' } },
      { id: 'r2', rev: 1, gen: 1, state: 'ready', ready: { oid: 'o2', at: new Date(ago(1)).toISOString() }, intent: 'two', paths: [], waitingOn: [], knownOverlaps: [], leaseExpiresAt: new Date(NOW + DAY).toISOString(), source: { kind: 'branch', branch: 'r2' } },
    ] },
    worktrees: { queried: true, worktrees: [] },
    branches: { queried: true, branches: [
      { name: 'r1', oid: 'o1', ahead: 1, behind: 0, tipTime: ago(1) },
      { name: 'r2', oid: 'o2', ahead: 1, behind: 0, tipTime: ago(1) },
      { name: 'u', oid: 'o3', ahead: 2, behind: 0, tipTime: ago(1) },
    ] },
    prs: { queried: true, complete: true, prs: [] },
    changed: {
      r1: { queried: true, files: ['tech-debt.json', 'src/one.js'] },
      r2: { queried: true, files: ['tech-debt.json'] },
      u: { queried: true, files: ['tech-debt.json', 'src/one.js'] },
    },
  });
  const byId = (s, id) => s.items.find((i) => i.id === id);

  it('a hot-only pair is a hotOverlap, not an overlap; a mixed pair keeps only its real files', () => {
    const s = buildStatus(facts(['tech-debt.json']));
    assert.deepEqual(byId(s, 'r2').overlaps, []);
    assert.deepEqual(byId(s, 'r2').hotOverlaps.map((o) => o.with).sort(), ['r1', 'u']);
    const r1u = byId(s, 'r1').overlaps.find((o) => o.with === 'u');
    assert.deepEqual(r1u.files, ['src/one.js']);
    assert.equal(byId(s, 'r1').overlaps.some((o) => o.with === 'r2'), false);
  });
  it('control: without hotFiles every pair is an overlap on the hot file too', () => {
    const s = buildStatus(facts([]));
    assert.deepEqual(byId(s, 'r2').overlaps.map((o) => o.with).sort(), ['r1', 'u']);
    assert.deepEqual(byId(s, 'r2').hotOverlaps, []);
  });
  it('landing order: a hot overlap does not count against a branch (r2 readied later, lands first once hot files are noise)', () => {
    // r2 has fewer REAL overlaps than r1 only when the shared hot file is discounted.
    assert.deepEqual(buildStatus(facts(['tech-debt.json'])).landingOrder, ['r2', 'r1']);
    assert.deepEqual(buildStatus(facts([])).landingOrder, ['r1', 'r2'], 'control: counted, the older ready wins the tie');
  });
  it('the hook payload carries hotOverlaps apart from overlaps', () => {
    const p = payloadFromStatus(buildStatus(facts(['tech-debt.json'])));
    assert.equal(p.overlaps.some((o) => (o.a === 'r1' && o.b === 'r2') || (o.a === 'r2' && o.b === 'r1')), false);
    assert.ok(p.hotOverlaps.some((o) => o.a === 'r1' && o.b === 'r2' && o.files[0] === 'tech-debt.json'));
  });
  it('rendered: one collapsed hot line per item, never an "overlaps" line', () => {
    const s = buildStatus(facts(['tech-debt.json']));
    const text = renderStatus({ ...s, items: [byId(s, 'r2')] });
    assert.match(text, /hot files shared with 2 items: tech-debt\.json \(not counted as conflicts\)/);
    assert.doesNotMatch(text, /overlaps r1/);
  });
});

describe('render — hidden reasons and folded overlaps', () => {
  const base = {
    registry: { complete: true, invalid: [] }, base: { name: 'main', freshness: null }, observedAt: 't', hold: null,
    sources: { worktrees: { queried: true }, branches: { queried: true }, prs: { queried: true, complete: true } },
    items: [], landingOrder: [], cycles: [], trains: [],
  };
  it('names each reason and the window', () => {
    const t = renderStatus(base, { hidden: { count: 7, ids: [], unchecked: 0, merged: 2, idle: 5, idleDays: 14 } });
    assert.match(t, /7 hidden \(2 merged into base, 5 idle > 14 days\) — use --all/);
  });
  it('a visible item with overlaps into hidden items gets one count line', () => {
    const it0 = item({ id: 'live', tipTime: NOW, overlapsWithHidden: ['a', 'b', 'c'] });
    assert.match(renderStatus({ ...base, items: [it0] }), /\+ overlaps 3 hidden items — use --all/);
  });
});

// ── end to end: the real CLI over a real repo ───────────────────────────────
describe('fleet CLI — idle hiding and hot files, end to end', () => {
  const FLEET_NOW = new Date(NOW).toISOString();
  const commitAt = (repo, branch, files, iso) => {
    git(['checkout', '-q', '-b', branch, 'main'], repo);
    for (const [rel, body] of Object.entries(files)) writeFile(repo, rel, body);
    git(['add', '--', ...Object.keys(files)], repo);
    execFileSync('git', ['commit', '-q', '-m', `work on ${branch}`], { cwd: repo, env: { ...scrubbedEnv(), GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso } });
    git(['checkout', '-q', 'main'], repo);
  };
  const setup = ({ fleetConfig = null, gh = true } = {}) => {
    const fx = makeFleetRepo({ fleetConfig });
    const fake = gh ? installFakeGh(fx.root) : null;
    const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, FLEET_NOW, ...(fake ? fake.env : {}) }, { prependPath: fake ? [fake.bin] : [] });
    return { fx, f: (args) => runFleet(args, { cwd: fx.repo, env }) };
  };
  const scene = (s) => {
    commitAt(s.fx.repo, 'squashed-long-ago', { 'shared.txt': 'old\n' }, new Date(ago(60)).toISOString());
    commitAt(s.fx.repo, 'fresh', { 'shared.txt': 'new\n' }, new Date(ago(1)).toISOString());
  };

  it('default hides the 60-day branch (and folds its overlap); --all shows it', () => {
    const s = setup(); scene(s);
    const r = s.f(['status']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /squashed-long-ago/);
    assert.match(r.stdout, /^fresh {2}\[untracked\]/m);
    assert.match(r.stdout, /1 hidden \(1 idle > 14 days\) — use --all/);
    assert.match(r.stdout, /\+ overlaps 1 hidden item — use --all/);
    const all = s.f(['status', '--all']);
    assert.match(all.stdout, /^squashed-long-ago {2}\[untracked\]/m);
    assert.match(all.stdout, /overlaps squashed-long-ago \(files\) on shared\.txt/);
    const json = JSON.parse(s.f(['status', '--json']).stdout);
    assert.deepEqual([json.status.hidden.idle, json.status.hidden.ids], [1, ['squashed-long-ago']]);
  });
  it('control: hideIdleAfterDays 90 keeps it visible', () => {
    const s = setup({ fleetConfig: { hideIdleAfterDays: 90 } }); scene(s);
    assert.match(s.f(['status']).stdout, /^squashed-long-ago {2}\[untracked\]/m);
  });
  it('control: PRs not queried (no gh) keeps it visible — "no open PR" is unknown', () => {
    const s = setup({ gh: false }); scene(s);
    const out = s.f(['status']).stdout;
    assert.match(out, /^squashed-long-ago {2}\[untracked\]/m);
    assert.doesNotMatch(out, /hidden/);
  });

  const claimHotScene = (s) => {
    addBranch(s.fx.repo, 'a', { 'src/a/x.txt': 'x\n', 'tech-debt.json': '{"a":1}\n' });
    git(['checkout', '-q', 'a'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'a', '--intent', 'feature a', '--paths', 'src/a/**']).status, 0);
    git(['checkout', '-q', 'main'], s.fx.repo);
    return s.f(['claim', '--id', 'b', '--intent', 'feature b', '--paths', 'tech-debt.json,src/b/**']);
  };
  it('claim: overlap only on a declared hot file is disclosed and admitted', () => {
    const r = claimHotScene(setup({ fleetConfig: { hotFiles: ['tech-debt.json'] } }));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[hot\] a: hot-files — hot files tech-debt\.json \(disclosed, not blocking\)/);
    assert.match(r.stdout, /registered b/);
  });
  it('control: the same claim without hotFiles is BLOCKED (exit 3)', () => {
    const r = claimHotScene(setup());
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.stdout, /BLOCKED for b/);
  });
});

// ── /audit-code round-1 fixes (session audit-code-1791459567) ───────────────
describe('audit R1 fixes', () => {
  it('H2/H3 Home in-flight: an UNKNOWN ahead count stays; a measured zero is dropped (control)', async () => {
    const { isInFlight } = await import('../scripts/lib/dashboard/collect-home-inflight.mjs');
    assert.equal(isInFlight({ kind: 'branch', branch: 'x', ahead: null }, 'main'), true, 'unknown is not "nothing ahead"');
    assert.equal(isInFlight({ kind: 'branch', branch: 'x', ahead: 0 }, 'main'), false);
    assert.equal(isInFlight({ kind: 'branch', branch: 'x', ahead: 3 }, 'main'), true);
    assert.equal(isInFlight({ kind: 'worktree', branch: 'main', ahead: null }, 'main'), false, 'the integration checkout itself');
  });
  it('L1 toMs: an invalid Date is null like every other invalid input, so isIdleTip reads it as unknown', async () => {
    const { toMs } = await import('../scripts/lib/fleet/overlap.mjs');
    assert.equal(toMs(new Date('nope')), null);
    assert.equal(toMs(new Date(NOW)), NOW, 'control: a valid Date passes through');
    assert.equal(isIdleTip(new Date('nope'), NOW, IDLE_MS), false);
  });
  it('H1 a user-config timeout above Node\'s timer limit is refused (check and tier); the limit itself is accepted', async () => {
    const { MAX_TIMER_MS, TierSchema } = await import('../scripts/lib/fleet/contracts.mjs');
    const check = (t) => parseFleetConfig({ checks: [{ name: 'c', script: 'scripts/c.mjs', timeoutMs: t }] });
    const tier = (t) => parseFleetConfig({ testCommand: { tiers: [{ name: 'u', command: ['npm', 'test'], timeoutMs: t }] } });
    for (const p of [check, tier]) {
      assert.equal(p(MAX_TIMER_MS).ok, true);
      const r = p(MAX_TIMER_MS + 1);
      assert.equal(r.ok, false);
      assert.match(r.errors.join('\n'), /timer limit/);
    }
    // The PERSISTED tier schema is deliberately unbounded, so a manifest written before the bound still reads.
    assert.equal(TierSchema.safeParse({ name: 'u', command: ['x'], timeoutMs: MAX_TIMER_MS + 1 }).success, true);
  });
});
