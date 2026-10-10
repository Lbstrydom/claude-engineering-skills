/**
 * @fileoverview /fleet — merged-work detection (plan
 * docs/plans/fleet-consumer-feedback-oct.md §2.1, wine-cellar-app item 1).
 *
 * A squash merge never makes a branch tip an ancestor of base, so the old
 * status read squash-merged work as unlanded and kept proposing it for landing.
 * Pinned here: the two independent signals (merged PR head, squash patch-id),
 * the ONE predicate, and the rule that committed work merged is NOT "finished"
 * until the worktree is proven clean.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import {
  advanceTouching, baseAdvance, mergedEvidenceFor, parseAdvanceLog, parseMergedList, parsePatchIdPairs, squashPatchIds,
} from '../scripts/lib/fleet/merged-facts.mjs';
import { deriveDone, hideReason, mergedDone } from '../scripts/lib/fleet/overlap.mjs';
import { patchId } from '../scripts/lib/fleet/git-facts.mjs';
import {
  cleanupFleetRoots, commitFile, installFakeGh, makeFleetRepo, runFleet, scrubbedEnv, writeFile,
} from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const A = 'a'.repeat(40); const B = 'b'.repeat(40); const C = 'c'.repeat(40); const D = 'd'.repeat(40);

describe('parseMergedList — never a short list read as the whole', () => {
  const row = (n, over = {}) => ({ number: n, headRefName: `b${n}`, headRefOid: A, mergedAt: '2026-10-09T00:00:00Z', mergeCommit: { oid: B }, url: `https://github.com/o/n/pull/${n}`, baseRefName: 'main', ...over });
  it('parses identity, merge oid and repo', () => {
    const r = parseMergedList(JSON.stringify([row(1)]));
    assert.equal(r.complete, true);
    assert.deepEqual(r.prs[0], { number: 1, headRef: 'b1', headOid: A, baseRef: 'main', mergedAt: '2026-10-09T00:00:00Z', mergeOid: B, repo: 'o/n', isCrossRepository: false });
  });
  it('a malformed row is skipped AND counted; a full page is possibly truncated', () => {
    const r = parseMergedList(JSON.stringify([row(1), row(2, { headRefOid: 'nope' })]));
    assert.equal(r.prs.length, 1); assert.equal(r.complete, false); assert.match(r.reason, /1 malformed/);
    assert.equal(parseMergedList(JSON.stringify([row(1), row(2)]), { limit: 2 }).complete, false);
  });
  it('unparseable output is not queried, never an empty list', () => {
    assert.equal(parseMergedList('<html>').queried, false);
    assert.equal(parseMergedList('{}').queried, false);
  });
});

describe('parsePatchIdPairs / parseAdvanceLog', () => {
  it('maps patch-id to the FIRST (newest) commit', () => {
    const m = parsePatchIdPairs(`${A} ${B}\n${A} ${C}\n${D} ${C}\n`);
    assert.equal(m.get(A), B); assert.equal(m.get(D), C);
  });
  it('parses real `git log --first-parent --name-only -z` output, including the (#N) suffix', () => {
    const { repo } = makeFleetRepo();
    commitFile(repo, 'x.txt', 'x\n', 'add x (#12)');
    writeFile(repo, 'y.txt', 'y\n'); writeFile(repo, 'z.txt', 'z\n');
    git(['add', '.'], repo); git(['commit', '-q', '-m', 'two files'], repo);
    const out = git(['log', '--first-parent', '--name-only', '-z', '--no-renames', '--format=%x00%H%x00%s', '-n', '2'], repo);
    const recs = parseAdvanceLog(out);
    assert.deepEqual(recs.map((r) => [r.subject, r.pr, r.files.sort()]), [['two files', null, ['y.txt', 'z.txt']], ['add x (#12)', 12, ['x.txt']]]);
  });
});

describe('mergedEvidenceFor — the ONE predicate', () => {
  const prs = (list) => ({ queried: true, prs: list });
  const pr = (over) => ({ number: 7, headRef: 'feat', headOid: A, mergeOid: B, mergedAt: '2026-10-09T00:00:00Z', isCrossRepository: false, ...over });
  const anc = (pairs) => (x, y) => ({ ok: true, value: pairs.some(([p, q]) => p === x && q === y) });
  it('the merged PR head IS the tip → merged via pr', () => {
    assert.deepEqual(mergedEvidenceFor({ branch: 'feat', tipOid: A, mergedPrs: prs([pr()]) }), { known: true, merged: true, via: 'pr', pr: 7, commit: B, extraCommits: 0 });
  });
  it('the tip is contained in the merged head → merged', () => {
    assert.equal(mergedEvidenceFor({ branch: 'feat', tipOid: C, mergedPrs: prs([pr()]), ancestor: anc([[C, A]]) }).merged, true);
  });
  it('commits AFTER the merged head → partially, with the count', () => {
    const e = mergedEvidenceFor({ branch: 'feat', tipOid: C, mergedPrs: prs([pr()]), ancestor: anc([[A, C]]), countRange: () => 2 });
    assert.deepEqual([e.merged, e.extraCommits], ['partially', 2]);
  });
  it('a reused branch name with unrelated history is NOT this branch (control)', () => {
    assert.equal(mergedEvidenceFor({ branch: 'feat', tipOid: C, mergedPrs: prs([pr()]), ancestor: anc([]) }).merged, false);
  });
  it('a fork PR with the same head name is never matched', () => {
    assert.equal(mergedEvidenceFor({ branch: 'feat', tipOid: A, mergedPrs: prs([pr({ isCrossRepository: true })]) }).merged, false);
  });
  it('squash patch-id match → merged via squash; gh absent does not stop it', () => {
    const e = mergedEvidenceFor({ branch: 'feat', tipOid: C, patchId: D, mergedPrs: { queried: false }, squash: { queried: true, byPatchId: new Map([[D, B]]) } });
    assert.deepEqual([e.merged, e.via, e.commit], [true, 'squash', B]);
  });
  it('neither source queried → known:false (silence is never "not merged")', () => {
    const r = mergedEvidenceFor({ branch: 'feat', tipOid: C, mergedPrs: { queried: false }, squash: { queried: false } });
    assert.deepEqual([r.known, r.merged], [false, false]);
  });
  it('a truncated PR list and a short squash window cannot prove absence (audit C1-H4)', () => {
    const r = mergedEvidenceFor({ branch: 'feat', tipOid: C, mergedPrs: { queried: true, complete: false, prs: [] }, squash: { queried: true, complete: false, byPatchId: new Map() } });
    assert.deepEqual([r.known, r.merged], [false, false]);
    assert.match(r.reason, /incomplete/);
  });
  it('a complete PR list alone cannot prove "not merged" — a squash pushed without a PR needs the squash window (C1-R2-M1)', () => {
    const sqShort = { queried: true, complete: false, coversFork: false, byPatchId: new Map() };
    assert.equal(mergedEvidenceFor({ branch: 'feat', tipOid: C, mergedPrs: { queried: true, complete: true, prs: [] }, squash: sqShort }).known, false);
    assert.equal(mergedEvidenceFor({ branch: 'feat', tipOid: C, mergedPrs: { queried: true, complete: true, prs: [] }, squash: { ...sqShort, coversFork: true } }).known, true);
  });
  it('complete-merge evidence outranks an older partial PR match (audit C1-M3)', () => {
    const e = mergedEvidenceFor({
      branch: 'feat', tipOid: C, patchId: D, mergedPrs: prs([pr()]), ancestor: anc([[A, C]]), countRange: () => 1,
      squash: { queried: true, complete: true, byPatchId: new Map([[D, B]]) },
    });
    assert.deepEqual([e.merged, e.via], [true, 'squash']);
  });
});

describe('committed work merged ≠ session finished (audit H3)', () => {
  const merged = { known: true, merged: true, via: 'pr', pr: 7, commit: B, extraCommits: 0 };
  const session = { id: 's', state: 'working', gen: 1, rev: 1 };
  it('clean (or no) worktree → derived done', () => {
    assert.deepEqual(deriveDone(session, [], { merged, workRemaining: false }), { done: true, mergedVia: merged, note: 'derived done (PR #7 merged)' });
  });
  it('dirty worktree → NOT done, says why', () => {
    assert.deepEqual(deriveDone(session, [], { merged, workRemaining: true }), { done: false, note: 'PR #7 merged — worktree has uncommitted changes' });
  });
  it('uninspected worktree → NOT done', () => assert.equal(deriveDone(session, [], { merged, workRemaining: null }).done, false));
  it('partially merged → NOT done, names the restack', () => assert.match(mergedDone({ ...merged, merged: 'partially', extraCommits: 3 }, false).note, /3 newer commit\(s\).*restack/));
  it('no evidence → unchanged behaviour (control)', () => assert.deepEqual(deriveDone(session, [], {}), { done: false }));
});

describe('hideReason — a landed untracked branch hides only on sufficient evidence', () => {
  const item = (over = {}) => ({ tracked: false, kind: 'branch', ahead: 3, pr: null, worktree: null, worktreeClean: null, merged: { merged: true }, ...over });
  it('landed', () => assert.equal(hideReason(item(), { prsComplete: true }), 'landed'));
  it('partially merged, a dirty worktree, or an open PR stay visible', () => {
    assert.equal(hideReason(item({ merged: { merged: 'partially' } }), { prsComplete: true }), null);
    assert.equal(hideReason(item({ worktree: '/w', worktreeClean: false }), { prsComplete: true }), null);
    assert.equal(hideReason(item({ pr: { number: 1 } }), { prsComplete: true }), null);
  });
});

describe('squashPatchIds + baseAdvance on a real repo', () => {
  it('a squash-merged branch matches its squash commit; an unmerged one does not (control)', () => {
    const { repo } = makeFleetRepo();
    git(['checkout', '-q', '-b', 'feat'], repo);
    commitFile(repo, 'a.txt', 'a1\n'); commitFile(repo, 'b.txt', 'b1\n');
    git(['checkout', '-q', '-b', 'other', 'main'], repo);
    commitFile(repo, 'c.txt', 'c1\n');
    git(['checkout', '-q', 'main'], repo);
    git(['merge', '--squash', 'feat'], repo); git(['commit', '-q', '-m', 'feat (#5)'], repo);
    const sq = squashPatchIds(repo, 'main');
    assert.equal(sq.queried, true);
    const featPid = patchId(repo, 'main', 'feat').patchId;
    const otherPid = patchId(repo, 'main', 'other').patchId;
    assert.equal(sq.byPatchId.get(featPid), git(['rev-parse', 'main'], repo));
    assert.equal(sq.byPatchId.has(otherPid), false);
    const adv = baseAdvance(repo, { baseRev: 'main', tipOid: git(['rev-parse', 'other'], repo) });
    assert.equal(adv.complete, true);
    assert.deepEqual(advanceTouching(adv, ['a.txt', 'zzz']).map((c) => [c.pr, c.files]), [[5, ['a.txt']]]);
    assert.deepEqual(advanceTouching(adv, ['c.txt']), [], 'a file base never touched is no reason to rebase');
  });
});

describe('fleet status — squash-merged work is neither unlanded nor proposed for landing', () => {
  const setup = () => {
    const fx = makeFleetRepo();
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, ...fake.env }, { prependPath: [fake.bin] });
    return { fx, fake, f: (args, cwd = fx.repo) => runFleet(args, { cwd, env }) };
  };
  const squashInto = (repo, branch, msg) => { git(['merge', '--squash', branch], repo); git(['commit', '-q', '-m', msg], repo); };

  it('registered + clean worktree → done (squash); dirty → stays live and says why; untracked → hidden as landed', () => {
    const { fx, f } = setup();
    const wt = path.join(fx.root, 'wt-feat');
    git(['worktree', 'add', '-q', '-b', 'feat', wt, 'main'], fx.repo);
    assert.equal(f(['claim', '--intent', 'feat work', '--paths', 'a.txt'], wt).status, 0);
    commitFile(wt, 'a.txt', 'feat\n');
    assert.equal(f(['ready'], wt).status, 0);
    git(['checkout', '-q', '-b', 'loose', 'main'], fx.repo); commitFile(fx.repo, 'c.txt', 'loose\n'); git(['checkout', '-q', 'main'], fx.repo);
    squashInto(fx.repo, 'feat', 'feat (#9)');
    squashInto(fx.repo, 'loose', 'loose (#10)');

    let s = f(['status', '--json']).json.status;
    const feat = s.items.find((i) => i.id === 'feat');
    assert.equal(feat.state, 'done');
    assert.match(feat.notes.join(' '), /derived done \(squash-merged as/);
    assert.deepEqual(s.landingOrder, [], 'a landed session is never proposed for landing');
    assert.equal(s.items.some((i) => i.id === 'loose'), false);
    assert.equal(s.hidden.landed, 1);

    fs.writeFileSync(path.join(wt, 'scratch.md'), 'not committed\n');
    s = f(['status', '--json']).json.status;
    const dirty = s.items.find((i) => i.id === 'feat');
    assert.notEqual(dirty.state, 'done');
    assert.match(dirty.notes.join(' '), /worktree has uncommitted changes/);
  });

  it('a merged PR whose head is the tip → derived done (PR #N merged), with gh as the only signal', () => {
    const { fx, fake, f } = setup();
    const wt = path.join(fx.root, 'wt-g');
    git(['worktree', 'add', '-q', '-b', 'g', wt, 'main'], fx.repo);
    f(['claim', '--intent', 'g work', '--paths', 'b.txt'], wt);
    const tip = commitFile(wt, 'b.txt', 'g\n');
    // Base did NOT get a squash commit here: only the PR record says it merged.
    fake.setState({ list: [], merged: [{ number: 31, headRefName: 'g', headRefOid: tip, mergedAt: '2026-10-09T00:00:00Z', mergeCommit: { oid: tip }, url: 'https://github.com/o/n/pull/31', baseRefName: 'main', isCrossRepository: false }] });
    const g = f(['status', '--json']).json.status.items.find((i) => i.id === 'g');
    assert.equal(g.state, 'done');
    assert.match(g.notes.join(' '), /PR #31 merged/);
  });
});
