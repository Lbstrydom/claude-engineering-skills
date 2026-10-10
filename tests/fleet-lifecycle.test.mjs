/**
 * @fileoverview /fleet — session lifecycle and uncommitted evidence (plan
 * docs/plans/fleet-consumer-feedback-oct.md §2.3; wine items 2-4, storyline 2).
 *
 *  - `release` retires a claim now (it no longer blocks, it leaves the landing order);
 *  - `archive-check` reports EVERY way removing a worktree loses work and fails
 *    closed (storyline lost gitignored deliverables to an archive);
 *  - uncommitted edits in another live session's worktree are disclosed on claim
 *    and in status — advisory, never a block;
 *  - `status --fetch` measures against a freshly fetched base and never dies on a
 *    failed fetch.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { archiveReport, isIgnoredByConfig, measureSize, sizeBudget } from '../scripts/lib/fleet/lifecycle.mjs';
import { classifyEntries, parsePorcelainZ, probeWorktrees } from '../scripts/lib/fleet/worktree-status.mjs';
import { decideClaim, isBlockingConflict } from '../scripts/lib/fleet/overlap.mjs';
import { fetchBase } from '../scripts/lib/fleet/commands.mjs';
import {
  cleanupFleetRoots, commitFile, installFakeGh, makeFleetRepo, runFleet, scrubbedEnv, writeFile,
} from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const setup = (fleetConfig = null) => {
  const fx = makeFleetRepo({ fleetConfig });
  // Isolate from the machine's git template hooks (one here writes .claude/settings.local.json into every
  // new worktree — archive-check would rightly report it as an ignored file at risk).
  fs.mkdirSync(path.join(fx.root, 'no-hooks'));
  git(['config', 'core.hooksPath', path.join(fx.root, 'no-hooks')], fx.repo);
  const fake = installFakeGh(fx.root);
  const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, ...fake.env }, { prependPath: [fake.bin] });
  const f = (args, cwd = fx.repo) => runFleet(args, { cwd, env });
  const chip = (name, paths) => {
    const wt = path.join(fx.root, `wt-${name}`);
    git(['worktree', 'add', '-q', '-b', name, wt, 'main'], fx.repo);
    const c = f(['claim', '--intent', `work on ${name}`, '--paths', paths], wt);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    return wt;
  };
  return { fx, fake, env, f, chip };
};

describe('porcelain parsing', () => {
  it('classifies staged, unstaged (incl. deletions), untracked and ignored', () => {
    const e = parsePorcelainZ('M  a.txt\0 D b.txt\0D  c.txt\0?? new.md\0!! dist/\0MM d.txt\0');
    assert.deepEqual(classifyEntries(e), { staged: ['a.txt', 'c.txt', 'd.txt'], unstaged: ['b.txt', 'd.txt'], untracked: ['new.md'], ignored: ['dist/'] });
  });
  it('probeWorktrees: over the cap is not queried, never clean', () => {
    const out = probeWorktrees(['/a', '/b', '/c'], { probe: () => ({ queried: true, entries: [] }), bounds: { maxCandidates: 2, deadlineMs: 1e9 } });
    assert.equal(out['/c'].queried, false);
  });
});

describe('fleet release', () => {
  it('retires the claim: it stops blocking a new claim on the same paths; a second release is a no-op', () => {
    const s = setup();
    const wt = s.chip('one', 'a.txt');
    const other = path.join(s.fx.root, 'wt-two');
    git(['worktree', 'add', '-q', '-b', 'two', other, 'main'], s.fx.repo);
    assert.equal(s.f(['claim', '--intent', 'two', '--paths', 'a.txt'], other).status, 3, 'blocked while one holds a.txt');
    const r = s.f(['release', '--json'], wt);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.json.state, 'done');
    assert.equal(s.f(['claim', '--intent', 'two', '--paths', 'a.txt'], other).status, 0, 'released paths no longer block');
    const again = s.f(['release', '--json'], wt);
    assert.equal(again.json.changed, false);
  });
  it('--abandoned; an unknown session is refused', () => {
    const s = setup();
    const wt = s.chip('gone', 'b.txt');
    assert.equal(s.f(['release', '--abandoned', '--json'], wt).json.state, 'abandoned');
    assert.equal(s.f(['release', '--id', 'nobody']).status, 3);
  });
});

describe('fleet archive-check — fails closed', () => {
  it('clean worktree with pushed branch → CLEAN, exit 0 (control)', () => {
    const s = setup();
    const wt = s.chip('tidy', 'a.txt');
    const r = s.f(['archive-check', '--json'], wt);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.json.archive.verdict, 'CLEAN');
  });
  it('a staged DELETION alone is AT RISK', () => {
    const s = setup();
    const wt = s.chip('del', 'a.txt');
    git(['rm', '-q', 'a.txt'], wt);
    const r = s.f(['archive-check', '--json'], wt);
    assert.equal(r.status, 3);
    assert.deepEqual(r.json.archive.risks.staged, ['a.txt']);
  });
  it('gitignored deliverables count (even a 10-byte one); node_modules does not; unpushed commits count', () => {
    const s = setup();
    const wt = s.chip('deck', 'a.txt');
    commitFile(wt, '.gitignore', 'out/\nnode_modules/\n');
    fs.mkdirSync(path.join(wt, 'out'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'out', 'proof.pptx'), 'x'.repeat(10));
    fs.mkdirSync(path.join(wt, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'node_modules', 'dep', 'i.js'), '1');
    const r = s.f(['archive-check', '--json'], wt);
    assert.equal(r.status, 3);
    assert.deepEqual(r.json.archive.risks.ignored, ['out/']);
    assert.equal(r.json.archive.risks.unpushed.length, 1);
    assert.match(r.json.archive.text ?? r.stdout, /out\//);
    const txt = s.f(['archive-check'], wt).stdout;
    assert.match(txt, /gitignored files/);
    assert.match(txt, /what do you still owe\?/);
  });
  it('a failed probe makes an otherwise clean answer UNVERIFIED, exit 3', () => {
    const s = setup();
    const wt = s.chip('blind', 'a.txt');
    const fakeGit = (args, cwd, o) => (args[0] === 'status' ? { ok: false, reason: 'simulated failure' } : { ok: true, stdout: '' });
    const r = archiveReport({ cwd: s.fx.repo, env: s.env, config: { archiveIgnore: [] } }, { worktree: wt, branch: 'blind', git: fakeGit });
    assert.equal(r.verdict, 'UNVERIFIED');
  });
  it('measureSize over budget is incomplete, never zero-and-done', () => {
    const s = setup();
    const d = path.join(s.fx.root, 'big');
    fs.mkdirSync(d);
    for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(d, `f${i}`), 'x');
    assert.deepEqual(measureSize(d, { budget: sizeBudget({ bounds: { maxFiles: 2, deadlineMs: 1e9 } }) }).complete, false);
    assert.deepEqual(measureSize(d), { bytes: 5, complete: true });
  });
  it('the size budget is report-wide: a second path draws on what the first spent (C1-M5)', () => {
    const s = setup();
    const d = path.join(s.fx.root, 'two');
    fs.mkdirSync(d);
    for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(d, `f${i}`), 'x');
    const budget = sizeBudget({ bounds: { maxFiles: 4, deadlineMs: 1e9 } });
    assert.equal(measureSize(d, { budget }).complete, true);
    assert.equal(measureSize(d, { budget }).complete, false);
  });
  it('a directory is excluded only by a pattern covering everything under it (C1-H10)', () => {
    assert.equal(isIgnoredByConfig('node_modules/', ['node_modules/**']), true);
    assert.equal(isIgnoredByConfig('reports/', ['reports/_']), false, 'a pattern matching an imagined child does not cover the dir');
    assert.equal(isIgnoredByConfig('reports/', ['reports/*.tmp']), false);
    assert.equal(isIgnoredByConfig('a.log', ['*.log']), true);
  });
  it('a DETACHED worktree with a commit no remote holds is AT RISK (C1-H5)', () => {
    const s = setup();
    const wt = path.join(s.fx.root, 'wt-detached');
    git(['worktree', 'add', '-q', '--detach', wt, 'main'], s.fx.repo);
    commitFile(wt, 'z.txt', 'only here\n');
    const r = s.f(['archive-check', wt, '--json']);
    assert.equal(r.status, 3, r.stdout);
    assert.equal(r.json.archive.risks.unpushed.length, 1);
  });
  it('a worktree that switched off its registered branch: commits on its ACTUAL head count (C1-R2-H3)', () => {
    const s = setup();
    const wt = s.chip('reg', 'a.txt');
    git(['checkout', '-q', '-b', 'elsewhere'], wt);
    commitFile(wt, 'e.txt', 'only on elsewhere\n');
    const r = s.f(['archive-check', 'reg', '--json']);
    assert.equal(r.status, 3, r.stdout);
    assert.equal(r.json.archive.risks.unpushed.length, 1);
  });
  // POSIX only: a Windows file name cannot contain a backslash, and there it IS the separator.
  it('a literal backslash in a POSIX file name is not a path separator (C1-R2-H2)', { skip: process.platform === 'win32' && 'backslash is a separator on Windows' }, () => {
    assert.equal(isIgnoredByConfig('node_modules\\deck.pdf', ['node_modules/**']), false);
  });
  it('skip-worktree files make an otherwise clean answer UNVERIFIED (C1-H4)', () => {
    const s = setup();
    const wt = s.chip('hidden', 'a.txt');
    git(['update-index', '--skip-worktree', 'a.txt'], wt);
    fs.writeFileSync(path.join(wt, 'a.txt'), 'edited but invisible to status\n');
    const r = s.f(['archive-check', '--json'], wt);
    assert.equal(r.status, 3);
    assert.equal(r.json.archive.verdict, 'UNVERIFIED');
  });
  it('a failed worktree inventory is UNVERIFIED, never "no worktree, nothing to lose" (C1-H4)', () => {
    const r = archiveReport({ cwd: '.', env: {}, config: {} }, { branch: null, worktree: null, inventoryError: 'worktree list failed: simulated', git: () => ({ ok: true, stdout: '' }) });
    assert.equal(r.verdict, 'UNVERIFIED');
  });
});

describe('uncommitted overlaps — disclosed, advisory', () => {
  it('pure decideClaim: uncommitted-only overlap is WARN, never blocked; committed overlap still blocks (control)', () => {
    const other = (o) => ({ session: { id: 'A', state: 'working', paths: ['z/**'], intent: 'a', knownOverlaps: [] }, live: true, changedFiles: [], uncommittedFiles: [], ...o });
    const unc = decideClaim({ claim: { id: 'B', intent: 'b', paths: ['x.txt'] }, mode: 'new', complete: true, others: [other({ uncommittedFiles: ['x.txt'] })] });
    assert.equal(unc.verdict, 'warn');
    assert.equal(isBlockingConflict(unc.conflicts[0]), false);
    const com = decideClaim({ claim: { id: 'B', intent: 'b', paths: ['x.txt'] }, mode: 'new', complete: true, others: [other({ changedFiles: ['x.txt'] })] });
    assert.equal(com.verdict, 'blocked');
    const blind = decideClaim({ claim: { id: 'B', intent: 'b', paths: ['q.txt'] }, mode: 'new', complete: true, others: [other({ uncommittedUnknown: 'probe deadline reached' })] });
    assert.deepEqual([blind.verdict, blind.uninspected[0].with], ['ok', 'A']);
  });
  it('end to end: A edits c.txt without committing; B claims c.txt → WARN naming the uncommitted file; status shows it', () => {
    const s = setup();
    const a = s.chip('alpha', 'docs/**');
    writeFile(a, 'c.txt', 'edited, not committed\n');
    const bwt = path.join(s.fx.root, 'wt-beta');
    git(['worktree', 'add', '-q', '-b', 'beta', bwt, 'main'], s.fx.repo);
    const c = s.f(['claim', '--intent', 'beta', '--paths', 'c.txt'], bwt);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.match(c.stdout, /WARN/);
    assert.match(c.stdout, /UNCOMMITTED in their worktree: c\.txt/);
    commitFile(bwt, 'c.txt', 'beta\n');
    const st = s.f(['status']).stdout;
    assert.match(st, /overlaps alpha \(uncommitted\).*uncommitted: c\.txt|overlaps beta \(uncommitted\).*uncommitted: c\.txt/);
  });
});

describe('status --fetch', () => {
  it('fetches the base first; measured against the fresher origin', () => {
    const s = setup();
    const other = path.join(s.fx.root, 'other-clone');
    git(['clone', '-q', s.fx.origin, other], s.fx.root);
    for (const [k, v] of Object.entries({ 'user.email': 't@example.com', 'user.name': 'T' })) git(['config', k, v], other);
    commitFile(other, 'a.txt', 'upstream\n'); git(['push', '-q', 'origin', 'main'], other);
    const before = git(['rev-parse', 'origin/main'], s.fx.repo);
    assert.equal(s.f(['status', '--fetch']).status, 0);
    assert.notEqual(git(['rev-parse', 'origin/main'], s.fx.repo), before);
  });
  it('fetches the UPSTREAM branch, which need not share the base name (C1-R4-H1)', () => {
    const s = setup();
    git(['push', '-q', 'origin', 'main:trunk'], s.fx.repo);
    git(['branch', '-q', '--set-upstream-to=origin/trunk', 'main'], s.fx.repo);
    const calls = [];
    const r = fetchBase({ cwd: s.fx.repo, dir: path.join(s.fx.repo, '.git', 'fleet'), config: { baseBranch: 'main' } }, { git: (args) => { calls.push(args); return { ok: true }; } });
    assert.deepEqual([r.remote, r.branch], ['origin', 'trunk']);
    assert.deepEqual(calls[0].slice(-2), ['origin', 'trunk']);
  });
  it('a failed fetch is a warning, not an exit', () => {
    const s = setup();
    git(['remote', 'set-url', 'origin', path.join(s.fx.root, 'no-such-remote.git')], s.fx.repo);
    const r = s.f(['status', '--fetch']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--fetch failed/);
  });
});
