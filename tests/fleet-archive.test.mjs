/**
 * @fileoverview `fleet archive` (docs/plans/fleet-unclaimed-work-and-switch-friction.md §2.3, §9).
 *
 * Every refusal has a control that passes; every race is injected between the snapshot and the removal by a
 * git wrapper that mutates the worktree right after the tag is written (the last step before the lock).
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import {
  ARCHIVE_MAX_BYTES, SESSION_LIST_CHECK, SNAPSHOT_IDENTITY, applyArchive, classifyListing, entryExists, existingArchiveTags, gateContent, planArchive, sanitiseTagStem,
} from '../scripts/lib/fleet/archive.mjs';
import { resolveArchiveTarget } from '../scripts/lib/fleet/lifecycle.mjs';
import { fleetDir } from '../scripts/lib/fleet/registry.mjs';
import { runGit } from '../scripts/lib/fleet/git-facts.mjs';
import { scanArchiveTags } from '../scripts/lib/fleet/unregistered.mjs';

after(cleanupFleetRoots);

const IGNORE = ['node_modules/**', '.claude/**'];
const FUTURE = () => new Date(Date.now() + 10 * 86_400_000); // past the fresh window for worktrees made seconds ago
const envFor = () => scrubbedEnv({ FLEET_TELEMETRY: 'off', FLEET_NOW: FUTURE().toISOString() });

function setup(name = 'wip', { branch = true } = {}) {
  // archiveIgnore declares the host-written .claude/ settings disposable, as a real repo does (see fleet-prune tests).
  const fx = makeFleetRepo({ fleetConfig: { archiveIgnore: IGNORE } });
  const wt = path.join(tmpRoot('archive-wt-'), name);
  git(['worktree', 'add', '-q', ...(branch ? ['-b', name] : ['--detach']), wt, 'main'], fx.repo);
  const ctx = { cwd: fx.repo, dir: fleetDir(fx.repo), env: envFor(), now: FUTURE(), config: { baseBranch: 'main', archiveIgnore: IGNORE, staleWorktreeDays: 3 }, cmd: 'fleet' };
  return { fx, wt, ctx, plan: (opts = {}) => planArchive(ctx, resolveArchiveTarget(ctx, wt), opts) };
}
/** The git subcommand, past any leading `-c key=value` pairs. */
const subcommand = (args) => { let i = 0; while (args[i] === '-c') i += 2; return args[i]; };
const objectCount = (repo) => git(['cat-file', '--batch-all-objects', '--batch-check'], repo).split('\n').filter(Boolean).length;
/** A git that runs `after()` once, right after the archive tag is written — between the snapshot and the lock. */
const raceAfterTag = (after) => { let done = false; return (args, cwd, opts) => { const r = runGit(args, cwd, opts); if (!done && subcommand(args) === 'tag') { done = true; after(); } return r; }; };

describe('fleet archive — the happy path', () => {
  it('dirty + untracked: the tag tree holds both, the branch tip did not move, the worktree is gone', () => {
    const { fx, wt, ctx, plan } = setup();
    fs.writeFileSync(path.join(wt, 'a.txt'), 'edited\n');
    fs.writeFileSync(path.join(wt, 'new.md'), 'untracked\n');
    const tipBefore = git(['rev-parse', 'wip'], fx.repo);
    const p = plan();
    assert.deepEqual(p.refusals, []);
    const r = applyArchive(ctx, p);
    assert.equal(r.status, 'archived', r.reason);
    assert.equal(r.tag, 'archive/wip');
    assert.equal(git(['show', 'archive/wip:a.txt'], fx.repo), 'edited');
    assert.equal(git(['show', 'archive/wip:new.md'], fx.repo), 'untracked');
    assert.equal(git(['rev-parse', 'wip'], fx.repo), tipBefore, 'the branch is untouched');
    assert.equal(fs.existsSync(wt), false);
    const author = git(['log', '-1', '--format=%an <%ae> %ct', 'archive/wip'], fx.repo);
    assert.equal(author, `${SNAPSHOT_IDENTITY.name} <${SNAPSHOT_IDENTITY.email}> ${git(['log', '-1', '--format=%ct', 'wip'], fx.repo)}`, 'fixed identity, HEAD\'s date');
  });

  it('a clean worktree whose tip is on base: the tag IS HEAD (no synthetic commit), so the tag scan does not list it; a WIP one is listed', () => {
    const clean = setup('clean');
    const r = applyArchive(clean.ctx, clean.plan());
    assert.equal(r.status, 'archived', r.reason);
    assert.equal(git(['rev-parse', 'archive/clean'], clean.fx.repo), git(['rev-parse', 'main'], clean.fx.repo));
    assert.equal(scanArchiveTags(clean.fx.repo, { baseRev: 'main' }).tags.length, 0);
    const dirty = setup('wip-only');
    fs.writeFileSync(path.join(dirty.wt, 'w.txt'), 'w\n');
    assert.equal(applyArchive(dirty.ctx, dirty.plan()).status, 'archived');
    const scan = scanArchiveTags(dirty.fx.repo, { baseRev: 'main' });
    assert.deepEqual(scan.tags.map((t) => [t.name, t.verdict, t.preserved]), [['archive/wip-only', 'unlanded', 'local-only']]);
  });

  it('the dry run writes nothing and ends with the session-list check', () => {
    const { fx, wt } = setup();
    fs.writeFileSync(path.join(wt, 'x.txt'), 'x\n');
    const r = runFleet(['archive', wt], { cwd: fx.repo, env: envFor() });
    assert.equal(r.status, 0, r.stdout);
    assert.ok(r.stdout.trimEnd().endsWith(SESSION_LIST_CHECK));
    assert.equal(git(['tag', '-l', 'archive/*'], fx.repo), '');
    assert.ok(fs.existsSync(wt));
  });
});

describe('fleet archive — refusals, each with a control', () => {
  it('a partially staged path refuses; staged and unchanged since is accepted (control)', () => {
    const { wt, plan } = setup();
    fs.writeFileSync(path.join(wt, 'a.txt'), 'v1\n'); git(['add', 'a.txt'], wt);
    assert.deepEqual(plan().refusals, [], 'control: staged, unchanged since');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'v2\n');
    assert.match(plan().refusals.join(' '), /partially staged.*a\.txt/);
  });
  it('unmerged index entries refuse', () => {
    assert.deepEqual(classifyListing('UU c.txt\0').unmerged, ['c.txt']);
    assert.deepEqual(classifyListing(' M c.txt\0').unmerged, [], 'control');
  });
  it('ignored data in a MIXED tree refuses without --discard-ignored; with it the run lists every discarded path (control)', () => {
    const { wt, plan } = setup();
    fs.writeFileSync(path.join(wt, '.gitignore'), 'build/\n'); git(['add', '.gitignore'], wt); git(['commit', '-q', '-m', 'ignore'], wt);
    fs.mkdirSync(path.join(wt, 'build')); fs.writeFileSync(path.join(wt, 'build', 'out.bin'), 'x');
    fs.writeFileSync(path.join(wt, 'real.md'), 'work\n');
    assert.match(plan().refusals.join(' '), /gitignored data.*build/);
    const ok_ = plan({ discardIgnored: true });
    assert.deepEqual([ok_.refusals, ok_.ignored], [[], ['build/']]);
  });
  it('a live claim, a locked worktree and the main checkout refuse', () => {
    const s = setup();
    assert.equal(runFleet(['claim', '--intent', 'x', '--paths', 'a.txt'], { cwd: s.wt, env: envFor() }).status, 0);
    assert.match(s.plan().refusals.join(' '), /live claim covers it/);
    const l = setup('locked');
    git(['worktree', 'lock', l.wt], l.fx.repo);
    assert.match(l.plan().refusals.join(' '), /locked/);
    assert.match(planArchive(l.ctx, { worktree: l.fx.repo, branch: 'main' }).refusals.join(' '), /main checkout/);
  });
  it('a symlinked (junction) worktree root refuses', () => {
    const { fx, wt, ctx } = setup();
    const link = path.join(tmpRoot('archive-link-'), 'via-link');
    fs.symlinkSync(wt, link, 'junction');
    const r = planArchive(ctx, { worktree: link, branch: 'wip' });
    assert.ok(r.refusals.length, 'refused');
    assert.ok(fs.existsSync(wt) && fs.existsSync(path.join(fx.repo, 'a.txt')));
  });
  it('a sensitive file refuses whether untracked, newly staged or a modified tracked file', () => {
    const u = setup('sens-untracked'); fs.writeFileSync(path.join(u.wt, '.env'), 'SECRET=1\n');
    assert.match(u.plan().refusals.join(' '), /sensitive.*\.env/);
    const st = setup('sens-staged'); fs.writeFileSync(path.join(st.wt, 'id_rsa'), 'k\n'); git(['add', '-f', 'id_rsa'], st.wt);
    assert.match(st.plan().refusals.join(' '), /sensitive.*id_rsa/);
    const t = setup('sens-tracked');
    fs.writeFileSync(path.join(t.wt, '.env.local'), 'A=1\n'); git(['add', '-f', '.env.local'], t.wt); git(['commit', '-q', '-m', 'oops'], t.wt);
    fs.writeFileSync(path.join(t.wt, '.env.local'), 'A=2\n');
    assert.match(t.plan().refusals.join(' '), /sensitive.*\.env\.local/);
    const ctrl = setup('plain'); fs.writeFileSync(path.join(ctrl.wt, 'notes.md'), 'n\n');
    assert.deepEqual(ctrl.plan().refusals, [], 'control');
  });
  it('.gitmodules refuses; the size cap refuses over 50 MiB and on an unmeasured path', () => {
    const g = setup(); fs.writeFileSync(path.join(g.wt, '.gitmodules'), '');
    assert.match(g.plan().refusals.join(' '), /gitmodules/);
    const big = gateContent('/w', ['a.bin'], { lstat: () => ({ isFile: () => true, isSymbolicLink: () => false, size: ARCHIVE_MAX_BYTES + 1 }), classify: () => ({ category: 'safe' }) });
    assert.equal(big.overCap, true);
    const fine = gateContent('/w', ['a.bin'], { lstat: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 10 }), classify: () => ({ category: 'safe' }) });
    assert.equal(fine.overCap, false, 'control');
    const unm = gateContent('/w', ['a.bin'], { lstat: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }, lexical: () => 'safe' });
    assert.deepEqual(unm.unmeasured, ['a.bin']);
  });
  it('a FRESH worktree refuses; --include-fresh accepts it (control)', () => {
    const { wt, ctx } = setup();
    const freshCtx = { ...ctx, now: new Date() };
    fs.writeFileSync(path.join(wt, 'x.md'), 'x\n');
    assert.match(planArchive(freshCtx, resolveArchiveTarget(freshCtx, wt)).refusals.join(' '), /fresh/);
    assert.deepEqual(planArchive(freshCtx, resolveArchiveTarget(freshCtx, wt), { includeFresh: true }).refusals, []);
  });
});

describe('fleet archive — determinism, retries and races', () => {
  it('a failed removal keeps the tag and the worktree; the re-run reproduces the SAME oid and reuses the tag', () => {
    const { ctx, wt, plan, fx } = setup();
    fs.writeFileSync(path.join(wt, 'n.md'), 'n\n');
    const noRemove = (args, cwd, opts) => (args[0] === 'worktree' && args[1] === 'remove' ? { ok: false, reason: 'boom' } : runGit(args, cwd, opts));
    const r1 = applyArchive(ctx, plan(), { git: noRemove });
    assert.deepEqual([r1.status, fs.existsSync(wt)], ['failed', true]);
    const r2 = applyArchive({ ...ctx, now: new Date(ctx.now.getTime() + 3_600_000) }, plan());
    assert.equal(r2.status, 'archived', r2.reason);
    assert.deepEqual([r2.oid, r2.tag], [r1.oid, r1.tag], 'same tree, parent, identity and date → same commit; the tag is reused');
    assert.equal(git(['tag', '-l', 'archive/*'], fx.repo), 'archive/wip');
  });
  it('edited again after the snapshot: a second edit to an ALREADY-modified file (status unchanged) aborts, tag and worktree kept', () => {
    const { ctx, wt, plan, fx } = setup();
    fs.writeFileSync(path.join(wt, 'a.txt'), 'first\n');
    const statusBefore = git(['status', '--porcelain'], wt);
    const r = applyArchive(ctx, plan(), { git: raceAfterTag(() => fs.writeFileSync(path.join(wt, 'a.txt'), 'second\n')) });
    assert.equal(git(['status', '--porcelain'], wt), statusBefore, 'the status text did not change');
    assert.equal(r.status, 'aborted');
    assert.match(r.reason, /working tree/);
    assert.ok(fs.existsSync(wt));
    assert.equal(git(['tag', '-l', 'archive/wip'], fx.repo), 'archive/wip');
  });
  it('stage a new version C, then restore the captured content B: only the real-index tree catches it (control: re-staging identical content passes)', () => {
    const s = setup();
    fs.writeFileSync(path.join(s.wt, 'a.txt'), 'B\n'); git(['add', 'a.txt'], s.wt);
    const r = applyArchive(s.ctx, s.plan(), { git: raceAfterTag(() => {
      fs.writeFileSync(path.join(s.wt, 'a.txt'), 'C\n'); runGit(['add', 'a.txt'], s.wt); fs.writeFileSync(path.join(s.wt, 'a.txt'), 'B\n');
    }) });
    assert.equal(r.status, 'aborted');
    const c = setup('restage');
    fs.writeFileSync(path.join(c.wt, 'a.txt'), 'B\n'); git(['add', 'a.txt'], c.wt);
    const ok_ = applyArchive(c.ctx, c.plan(), { git: raceAfterTag(() => runGit(['add', 'a.txt'], c.wt)) });
    assert.equal(ok_.status, 'archived', ok_.reason);
  });
  it('a sensitive file appearing after the capture aborts BEFORE any hash: the object database is unchanged', () => {
    const { ctx, wt, plan, fx } = setup();
    fs.writeFileSync(path.join(wt, 'n.md'), 'n\n');
    let afterTag = null;
    const r = applyArchive(ctx, plan(), { git: raceAfterTag(() => { afterTag = objectCount(fx.repo); fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n'); }) });
    assert.equal(r.status, 'aborted');
    assert.equal(objectCount(fx.repo), afterTag, 'no blob of the new file was written');
    const blob = git(['hash-object', path.join(wt, '.env')], fx.repo); // computes the id only; -w is what would write it
    assert.equal(runGit(['cat-file', '-e', blob], fx.repo).ok, false, 'and its content is not in the object database');
  });
  it('a new ignored file, a HEAD move and a new claim each abort; with nothing changed and --discard-ignored the run passes (control)', () => {
    const ign = setup('ign');
    fs.writeFileSync(path.join(ign.wt, '.gitignore'), 'tmp/\n'); git(['add', '.gitignore'], ign.wt); git(['commit', '-q', '-m', 'i'], ign.wt);
    fs.mkdirSync(path.join(ign.wt, 'tmp')); fs.writeFileSync(path.join(ign.wt, 'tmp', 'a'), 'a');
    const passes = applyArchive(ign.ctx, ign.plan({ discardIgnored: true }));
    assert.equal(passes.status, 'archived', `control: ${passes.reason}`);
    const ign2 = setup('ign2');
    fs.writeFileSync(path.join(ign2.wt, '.gitignore'), 'tmp/\n'); git(['add', '.gitignore'], ign2.wt); git(['commit', '-q', '-m', 'i'], ign2.wt);
    fs.mkdirSync(path.join(ign2.wt, 'tmp')); fs.writeFileSync(path.join(ign2.wt, 'tmp', 'a'), 'a');
    const r1 = applyArchive(ign2.ctx, ign2.plan({ discardIgnored: true }), { git: raceAfterTag(() => fs.writeFileSync(path.join(ign2.wt, 'debug.log'), 'l')) });
    assert.equal(r1.status, 'aborted', 'an untracked file appearing changes the listing');
    const h = setup('head');
    fs.writeFileSync(path.join(h.wt, 'n.md'), 'n\n');
    const r2 = applyArchive(h.ctx, h.plan(), { git: raceAfterTag(() => { runGit(['commit', '-q', '--allow-empty', '-m', 'moved'], h.wt); }) });
    assert.match(r2.reason, /HEAD or branch moved/);
    const c = setup('claimed-late');
    fs.writeFileSync(path.join(c.wt, 'n.md'), 'n\n');
    const r3 = applyArchive(c.ctx, c.plan(), { git: raceAfterTag(() => runFleet(['claim', '--intent', 'late', '--paths', 'n.md'], { cwd: c.wt, env: envFor() })) });
    assert.match(r3.reason, /live claim/);
  });
});

describe('fleet archive — round-1 audit fixes (cluster B)', () => {
  it('a FORCE-STAGED ignored file is preserved (the snapshot is seeded from the real index, not HEAD)', () => {
    const { fx, wt, ctx, plan } = setup();
    fs.writeFileSync(path.join(wt, '.gitignore'), 'secret-ish.txt\n'); git(['add', '.gitignore'], wt); git(['commit', '-q', '-m', 'ignore'], wt);
    fs.writeFileSync(path.join(wt, 'secret-ish.txt'), 'kept on purpose\n'); git(['add', '-f', 'secret-ish.txt'], wt);
    const p = plan();
    assert.deepEqual(p.refusals, []);
    assert.ok(p.set.includes('secret-ish.txt'), 'it is in the preservation set');
    const r = applyArchive(ctx, p);
    assert.equal(r.status, 'archived', r.reason);
    assert.equal(git(['show', `${r.tag}:secret-ish.txt`], fx.repo), 'kept on purpose');
  });
  it('a skip-worktree file is refused (git status cannot see its edits); control: without the flag the plan is clean', () => {
    const { wt, plan } = setup();
    fs.writeFileSync(path.join(wt, 'a.txt'), 'hidden edit\n');
    git(['update-index', '--skip-worktree', 'a.txt'], wt);
    assert.match(plan().refusals.join(' '), /skip-worktree/);
    git(['update-index', '--no-skip-worktree', 'a.txt'], wt);
    assert.deepEqual(plan().refusals, []);
  });
  it('a symbolic-ref failure other than "detached" is an error, never a silent detached HEAD', () => {
    const { ctx, wt } = setup();
    const broken = (args, cwd, opts) => (args[0] === 'symbolic-ref' ? { ok: false, status: 128, reason: 'git symbolic-ref exited 128: boom' } : runGit(args, cwd, opts));
    assert.match(planArchive(ctx, resolveArchiveTarget(ctx, wt), { git: broken }).refusals.join(' '), /symbolic-ref failed/);
    const detached = (args, cwd, opts) => (args[0] === 'symbolic-ref' ? { ok: false, status: 1, reason: 'not a symbolic ref' } : runGit(args, cwd, opts));
    assert.doesNotMatch(planArchive(ctx, resolveArchiveTarget(ctx, wt), { git: detached }).refusals.join(' '), /symbolic-ref/, 'control: exit 1 is detached');
  });
  it('an unreadable activity term makes the worktree FRESH (refused), never idle', () => {
    const { ctx, wt } = setup();
    fs.writeFileSync(path.join(wt, 'x.md'), 'x\n');
    const eacces = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    const p = planArchive(ctx, resolveArchiveTarget(ctx, wt), { stat: eacces });
    assert.equal(p.fresh, true);
    assert.match(p.refusals.join(' '), /fresh/);
  });
});

describe('fleet archive — round-2 audit fixes (cluster B)', () => {
  it('a sensitive file appearing between the plan and --apply aborts BEFORE the first hash: no object is written', () => {
    const { ctx, wt, plan, fx } = setup();
    fs.writeFileSync(path.join(wt, 'n.md'), 'n\n');
    const p = plan();
    assert.deepEqual(p.refusals, []);
    fs.writeFileSync(path.join(wt, '.env'), 'SECRET=2\n');
    const before = objectCount(fx.repo);
    const r = applyArchive(ctx, p);
    assert.equal(r.status, 'aborted');
    assert.match(r.reason, /nothing was written/);
    assert.equal(objectCount(fx.repo), before, 'the object database is unchanged');
    assert.equal(git(['tag', '-l', 'archive/*'], fx.repo), '', 'no tag');
  });
  it('an unreadable registry inside the lock aborts (a claim could be hiding there); control: an intact one passes', () => {
    const { ctx, wt, plan } = setup();
    fs.writeFileSync(path.join(wt, 'n.md'), 'n\n');
    const sessions = path.join(ctx.dir, 'sessions');
    const r = applyArchive(ctx, plan(), { git: raceAfterTag(() => { fs.mkdirSync(sessions, { recursive: true }); fs.writeFileSync(path.join(sessions, 'corrupt.json'), '{ nope'); }) });
    assert.equal(r.status, 'aborted');
    assert.match(r.reason, /registry is unreadable/);
    fs.rmSync(path.join(sessions, 'corrupt.json'));
    assert.equal(applyArchive(ctx, plan()).status, 'archived', 'control');
  });
  it('the tag must name the snapshot COMMIT, not merely a commit with the same tree', () => {
    const { ctx, wt, plan } = setup();
    fs.writeFileSync(path.join(wt, 'n.md'), 'n\n');
    const other = 'f'.repeat(40);
    const lying = (args, cwd, opts) => (args[0] === 'rev-parse' && String(args[1]).endsWith('^{commit}') ? { ok: true, stdout: `${other}\n` } : runGit(args, cwd, opts));
    const r = applyArchive(ctx, plan(), { git: lying });
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /snapshot commit/);
    assert.ok(fs.existsSync(wt), 'the worktree is kept');
  });
});

describe('fleet archive — round-3 audit fixes (cluster B)', () => {
  it('tag.gpgSign=true in the user\'s config still yields a LIGHTWEIGHT, unsigned tag', () => {
    const { fx, wt, ctx, plan } = setup();
    git(['config', 'tag.gpgSign', 'true'], fx.repo);
    fs.writeFileSync(path.join(wt, 'n.md'), 'n\n');
    const r = applyArchive(ctx, plan());
    assert.equal(r.status, 'archived', r.reason);
    assert.equal(git(['cat-file', '-t', `refs/tags/${r.tag}`], fx.repo), 'commit', 'a lightweight tag points straight at the commit');
  });
  it('"already archived" lists only this branch\'s tags, not a branch whose name extends it', () => {
    const { fx } = setup('feature');
    git(['branch', 'feature-cleanup', 'main'], fx.repo);
    git(['tag', 'archive/feature-cleanup', 'main'], fx.repo);
    git(['tag', `archive/feature-${'a'.repeat(12)}`, 'main'], fx.repo);
    git(['tag', 'archive/feature', 'main'], fx.repo);
    const listed = existingArchiveTags(runGit, fx.repo, 'feature');
    assert.deepEqual(listed.tags.map((t) => t.name).sort(), ['archive/feature', `archive/feature-${'a'.repeat(12)}`]);
  });
});

describe('fleet archive — round-5 audit fix (cluster B)', () => {
  it('an INTENT-TO-ADD entry for an ignored file is preserved (write-tree skips it; add -A skips ignored files)', () => {
    const { fx, wt, ctx, plan } = setup();
    fs.writeFileSync(path.join(wt, '.gitignore'), 'draft.md\n'); git(['add', '.gitignore'], wt); git(['commit', '-q', '-m', 'ignore draft'], wt);
    fs.writeFileSync(path.join(wt, 'draft.md'), 'unique draft\n');
    git(['add', '-N', '-f', 'draft.md'], wt);
    const p = plan();
    assert.ok(p.set.includes('draft.md'), 'it is in the preservation set');
    const r = applyArchive(ctx, p);
    assert.equal(r.status, 'archived', r.reason);
    assert.equal(git(['show', `${r.tag}:draft.md`], fx.repo), 'unique draft');
  });
});

describe('fleet archive — round-6 audit fixes (cluster B; proven by test, not re-audited: round 6 is the cap)', () => {
  it('a preservation path is a LITERAL name: a file called "[ab].md" does not also stage the ignored a.md', () => {
    const { fx, wt, ctx, plan } = setup();
    fs.writeFileSync(path.join(wt, '.gitignore'), '*.md\n'); git(['add', '.gitignore'], wt); git(['commit', '-q', '-m', 'ignore md'], wt);
    fs.writeFileSync(path.join(wt, '[ab].md'), 'the bracket file\n');
    fs.writeFileSync(path.join(wt, 'a.md'), 'ignored, never shown\n');
    git(['add', '-N', '-f', '--', ':(literal)[ab].md'], wt);
    const p = plan({ discardIgnored: true });
    assert.deepEqual(p.refusals, []);
    const r = applyArchive(ctx, p);
    assert.equal(r.status, 'archived', r.reason);
    assert.equal(git(['show', `${r.tag}:[ab].md`], fx.repo), 'the bracket file');
    assert.equal(runGit(['cat-file', '-e', `${r.tag}:a.md`], fx.repo).ok, false, 'the ignored a.md was not swept in by a pattern');
  });
  it('entryExists counts a dangling symlink (an entry git records); a missing path is absent (control)', (t) => {
    const dir = tmpRoot('archive-entry-');
    const link = path.join(dir, 'dangling');
    try { fs.symlinkSync(path.join(dir, 'nowhere'), link); } catch { t.skip('symlinks need privileges on this machine'); return; }
    assert.equal(fs.existsSync(link), false, 'existsSync follows the link (the defect)');
    assert.equal(entryExists(link), true);
    assert.equal(entryExists(path.join(dir, 'missing')), false);
  });
});

describe('fleet archive — names, failures and the no-push rule', () => {
  it('a detached worktree whose directory name has spaces and ~^:?*[ gets a valid tag; a plain name is unchanged (control)', () => {
    assert.equal(sanitiseTagStem('my wt ~^:?*[x'), 'my-wt-x');
    assert.equal(sanitiseTagStem('plain-name'), 'plain-name');
    assert.equal(sanitiseTagStem('~~~'), 'detached');
    const { fx, ctx, wt } = setup('weird ~name', { branch: false });
    fs.writeFileSync(path.join(wt, 'n.md'), 'n\n');
    const p = planArchive(ctx, resolveArchiveTarget(ctx, wt));
    assert.deepEqual(p.refusals, []);
    assert.match(p.stem, /^archive\/weird-name-[0-9a-f]{12}$/);
    assert.equal(runGit(['check-ref-format', `refs/tags/${p.stem}`], fx.repo).ok, true);
  });
  it('tag creation failing leaves the worktree intact', () => {
    const { ctx, wt, plan } = setup();
    fs.writeFileSync(path.join(wt, 'n.md'), 'n\n');
    const r = applyArchive(ctx, plan(), { git: (a, c, o) => (subcommand(a) === 'tag' ? { ok: false, reason: 'nope' } : runGit(a, c, o)) });
    assert.deepEqual([r.status, fs.existsSync(path.join(wt, 'n.md'))], ['failed', true]);
  });
  it('after removal the branch lists every archive tag and claims none of them; no tag at all refuses', () => {
    const { fx, wt } = setup();
    fs.writeFileSync(path.join(wt, 'n.md'), 'n\n');
    assert.equal(runFleet(['archive', wt, '--apply'], { cwd: fx.repo, env: envFor() }).status, 0);
    const again = runFleet(['archive', 'wip'], { cwd: fx.repo, env: envFor() });
    assert.equal(again.status, 0, again.stdout);
    assert.match(again.stdout, /already archived — 1 tag\(s\):\n {2}archive\/wip @/);
    git(['branch', 'bare-branch', 'main'], fx.repo);
    assert.equal(runFleet(['archive', 'bare-branch'], { cwd: fx.repo, env: envFor() }).status, 3);
  });
  it('archive.mjs has no code path that pushes', () => {
    const src = fs.readFileSync(new URL('../scripts/lib/fleet/archive.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /['"]push['"]/);
  });
});
