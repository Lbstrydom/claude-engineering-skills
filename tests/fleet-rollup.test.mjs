/**
 * @fileoverview `fleet land --rollup` (scripts/lib/fleet/rollup-land.mjs; docs/plans/ship-batch-member-outcomes.md section 2.9).
 * In-process on the REAL train build and serial runner, real git, a scripted `gh` that models ONE rollup PR: holds at the build,
 * the push and PR open, the final manifest, the squash pinned to the candidate, evidence honesty (no AI-* trailer, each member's
 * own tree), a red rollup, the base race, supersession, the post-landing cleanup and its refusals.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, makeFleetRepo, addBranch, installFakeGh, runFleet, scrubbedEnv } from './helpers/fleet-repo.mjs';
import { REPO, ok, view, fast, depsWith, multiFx } from './helpers/fleet-serial-fx.mjs';
import { readTrain, TrainSchema } from '../scripts/lib/fleet/registry.mjs';
import { readSerial } from '../scripts/lib/fleet/serial.mjs';
import { CANONICAL_GRANT } from '../scripts/lib/fleet/coordinator-grant.mjs';
import { resolveConfig, landingRollupLine } from '../scripts/lib/fleet/config.mjs';
import { approveTrain } from '../scripts/lib/fleet/train-approve.mjs';
import { patchTrain } from '../scripts/lib/fleet/train.mjs';
import { buildRollup, approveRollup, resumeRollup, readRollupRecord, rollupTrainProblem } from '../scripts/lib/fleet/rollup-land.mjs';
import { approveSerial } from '../scripts/lib/fleet/serial.mjs';
import { parseRollupManifest } from '../scripts/lib/fleet/rollup.mjs';
import { AI_TRAILER_KEYS, parseMessageTrailers } from '../scripts/lib/commit-trailers.mjs';

after(cleanupFleetRoots);

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
const fleetDirOf = (repo) => path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo), 'fleet');
const RULES_JSON = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }];
const parseSelect = (v) => String(v).split(',');
const hasAi = (message) => { const t = parseMessageTrailers(message); return (t.isTrailerBlock ? t.trailers : []).some((x) => AI_TRAILER_KEYS.includes(x.key)); };

/** n ready members on disjoint files, a valid grant, deps with a stubbed child, and the land ctx. */
function fixture(n, over = {}) {
  const { fx, members, base } = multiFx(n, { messages: Array.from({ length: n }, (_, i) => `feat: the thing ${i + 1}\n\nAI-Skill: ship\nAI-Gate: converged`) });
  const dir = fleetDirOf(fx.repo);
  const grantFile = path.join(mkTmp('grant-'), 'CLAUDE.md');
  fs.writeFileSync(grantFile, `# rules\n\n${CANONICAL_GRANT.replace('Since <DATE>:', 'Since 2026-11-18:')}\n`);
  const env = { ...process.env };
  const ctx = { cwd: fx.repo, cmd: 'fleet', now: new Date(), env, dir };
  Object.defineProperty(ctx, 'config', { get: () => resolveConfig(fx.repo, { env }) });
  const childCalls = [];
  const seam = {
    grantFile,
    checkChild: (a) => { childCalls.push(a); return over.child ? over.child(a) : { ok: true, reasons: [], envelope: { runId: `run-${a.head.slice(0, 6)}`, gate: 'converged', conditions: [{ id: 'final-review', ok: true }] } }; },
    members: members.map((m) => ({ id: m.id, gen: 1, rev: 1, kind: over.prs ? 'pr' : 'branch', repo: over.prs ? REPO : null, prNumber: over.prs ? m.pr : null, baseRef: 'main', branch: m.id, oid: m.head, worktree: fx.repo, headRepo: null })),
  };
  return { fx, members, base, dir, ctx, grantFile, seam, childCalls };
}

/** A scripted GitHub that models the rollup PR (and, optionally, the members' own PRs). */
function world(f, over = {}) {
  const w = {
    calls: [], merges: [], creates: [], closes: [], rollupPr: null, rules: RULES_JSON, checks: 'pass', memberPrs: new Map(f.members.map((m) => [m.pr, { state: 'OPEN', head: m.head }])),
    prsByBranch: new Map(), createFails: false, listHides: false, mergeBehavior: over.mergeBehavior, squashExtra: over.squashExtra ?? null, repoView: over.repoView ?? 'o/n',
    gh: (args) => {
      w.calls.push(args);
      if (args[0] === 'repo') return ok({ nameWithOwner: w.repoView });
      if (args[0] === 'api' && /rules\/branches/.test(args[1])) return { ok: true, status: 0, stdout: JSON.stringify(w.rules), stderr: '' };
      if (args[0] === 'api') return { ok: true, status: 0, stdout: JSON.stringify({ protected: false }), stderr: '' };
      if (args[1] === 'list') { const pr0 = w.prsByBranch.get(args[args.indexOf('--head') + 1]); return ok(pr0 && !w.listHides ? [{ number: pr0.number, state: pr0.state, headRefOid: pr0.head, baseRefName: 'main' }] : []); }
      if (args[1] === 'create') {
        w.creates.push(args);
        if (w.createFails) return { ok: false, status: 1, stdout: '', stderr: 'boom', reason: 'gh pr create failed' };
        const head = git(['ls-remote', 'origin', `refs/heads/${args[args.indexOf('--head') + 1]}`], f.fx.repo).split(/\s+/)[0];
        w.rollupPr = { number: 100 + w.creates.length, state: 'OPEN', head, mergeCommit: null, body: fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') };
        w.prsByBranch.set(args[args.indexOf('--head') + 1], w.rollupPr);
        w.allPrs = [...(w.allPrs ?? []), w.rollupPr];
        return { ok: true, status: 0, stdout: `https://github.com/${REPO}/pull/${w.rollupPr.number}\n`, stderr: '' };
      }
      const pr = Number(args[2]);
      if (args[1] === 'close') { w.closes.push({ pr, args }); const m = w.memberPrs.get(pr); if (m) m.state = 'CLOSED'; const rp0 = (w.allPrs ?? []).find((x) => x.number === pr); if (rp0) rp0.state = 'CLOSED'; return ok(); }
      if (args[1] === 'checks') return { ok: w.checks === 'pass', status: w.checks === 'pass' ? 0 : 8, stdout: JSON.stringify([{ name: 'ci', bucket: w.checks, state: w.checks.toUpperCase(), completedAt: '2026-10-09T10:00:00Z' }]), stderr: '' };
      if (args[1] === 'view') {
        const rp = (w.allPrs ?? []).find((x) => x.number === pr);
        if (rp) {
          const want = args[args.indexOf('--json') + 1];
          if (want === 'isInMergeQueue') return ok({ isInMergeQueue: false });
          return ok(view(rp.head, { state: rp.state, mergeCommit: rp.mergeCommit ? { oid: rp.mergeCommit } : null, url: `https://github.com/${REPO}/pull/${pr}` }));
        }
        const m = w.memberPrs.get(pr);
        return m ? ok({ ...view(m.head, { state: m.state }), headRefOid: m.head, state: m.state }) : { ok: false, status: 1, stdout: '', stderr: 'no such pr', reason: 'no such pr' };
      }
      if (args[1] === 'merge') {
        w.merges.push(args);
        if (w.mergeBehavior) return w.mergeBehavior({ w, args });
        w.rollupPr.mergeCommit = squash(f, args, w.squashExtra); w.rollupPr.state = 'MERGED';
        return ok();
      }
      return { ok: false, status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}`, reason: 'unexpected' };
    },
  };
  return w;
}

/** What GitHub does for the rollup merge: a real squash of the pinned head onto origin/main with the given message. */
function squash(f, args, extraFile = null) {
  const subject = args[args.indexOf('--subject') + 1];
  const body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
  const repo = f.fx.repo;
  git(['checkout', '-q', 'main'], repo);
  git(['pull', '-q', '--ff-only', 'origin', 'main'], repo);
  git(['merge', '--squash', args.at(-1)], repo);
  if (extraFile) { fs.writeFileSync(path.join(repo, extraFile), 'extra\n'); git(['add', extraFile], repo); }
  const msg = path.join(mkTmp('squash-'), 'msg');
  fs.writeFileSync(msg, `${subject} (#101)\n\n${body}\n`);
  git(['commit', '--allow-empty', '-q', '-F', msg], repo);
  git(['push', '-q', 'origin', 'main'], repo);
  return git(['rev-parse', 'HEAD'], repo);
}

const mkDeps = (f, w, extra = {}) => ({ ...depsWith(w.gh), shipBatch: f.seam, ...extra });
const build = (f, w, flags = {}) => buildRollup(f.ctx, flags, mkDeps(f, w), { parseSelect });
const approve = (f, w, extra = {}) => approveRollup({ cwd: f.fx.repo, dir: f.dir, trainId: extra.trainId, deps: mkDeps(f, w, extra.deps), serialOpts: { sleep: () => {}, timings: fast, timeoutMs: 60_000, ...(extra.serialOpts ?? {}) } });
const resume = (f, w, trainId, extra = {}) => resumeRollup({ cwd: f.fx.repo, dir: f.dir, trainId, deps: mkDeps(f, w, extra.deps), serialOpts: { sleep: () => {}, timings: fast, ...(extra.serialOpts ?? {}) } });
const runOf = (f, trainId) => { const r = readSerial(f.dir, trainId); if (!r.ok) throw new Error(`serial: ${r.reason}`); return r.run; };

describe('build: holds, never failures', () => {
  it('a member the child refuses (waived) and a member whose branch was never pushed are HELD with reasons; the rollup is built from the rest; the record is write-once', () => {
    const f = fixture(3, { child: ({ head }) => (head === undefined ? {} : { ok: true, reasons: [], envelope: { runId: 'r', gate: 'converged', conditions: [] } }) });
    f.seam.checkChild = (a) => (a.head === f.members[0].head ? { ok: false, reasons: ['trailers: AI-Gate is "waived"'], envelope: {} } : { ok: true, reasons: [], envelope: { runId: 'r', gate: 'converged', conditions: [] } });
    git(['push', '-q', 'origin', `:refs/heads/${f.members[1].id}`], f.fx.repo); // m2's branch is gone from the remote
    const w = world(f);
    const r = build(f, w);
    assert.equal(r.ok, true, r.text);
    assert.deepEqual(r.held.map((h) => h.id).sort(), ['m1', 'm2']);
    assert.match(r.held.find((h) => h.id === 'm1').reason, /shipped-head-refused: .*waived/);
    assert.match(r.held.find((h) => h.id === 'm2').reason, /branch-moved/);
    const rec = readRollupRecord(f.dir, r.trainId).rec;
    assert.deepEqual(rec.members.map((m) => m.id), ['m3']);
    assert.equal(rec.members[0].gate, 'converged');
    assert.equal(rec.members[0].tree, f.members[2].tree, "the member's own tree, not the candidate's");
    const t = readTrain(f.dir, r.trainId).train;
    assert.equal(t.landing, 'rollup');
    assert.equal(w.creates.length, 0, 'a build pushes and opens nothing');
  });
  it('--hold ejects a member (held-by-coordinator); an unknown --hold id is refused', () => {
    const f = fixture(2);
    const w = world(f);
    assert.match(build(f, w, { '--hold': 'zzz' }).reason, /--hold names a session that is not ready/);
    const r = build(f, w, { '--hold': 'm1' });
    assert.deepEqual(r.held, [{ id: 'm1', reason: 'held-by-coordinator' }]);
    assert.deepEqual(readRollupRecord(f.dir, r.trainId).rec.members.map((m) => m.id), ['m2']);
  });
  it('two members that touch one path never share a rollup: the later one is held', () => {
    const f = fixture(2);
    const w = world(f);
    const deps = mkDeps(f, w);
    const git0 = deps.git;
    deps.git = (args, cwd, o) => (args[0] === 'diff' && args[1] === '--name-only' ? { ok: true, status: 0, stdout: 'shared.txt\n', stderr: '' } : git0(args, cwd, o));
    const r = buildRollup(f.ctx, {}, deps, { parseSelect });
    assert.equal(r.ok, true, r.text);
    assert.match(r.held[0].reason, /^overlap:shared\.txt \(also changed by m1\)/);
    assert.deepEqual(readRollupRecord(f.dir, r.trainId).rec.members.map((m) => m.id), ['m1']);
  });
  it('the grant is read first: without it nothing is looked at or built', () => {
    const f = fixture(1);
    fs.rmSync(f.grantFile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const r = build(f, world(f));
    assert.equal(r.ok, false);
    assert.match(r.reason, /grant-absent/);
    assert.equal(f.childCalls.length, 0);
  });
  it('a rollup train can never be approved by a plain approve or a plain serial approve', () => {
    const f = fixture(1);
    const r = build(f, world(f));
    const plain = approveTrain({ cwd: f.fx.repo, trainId: r.trainId, deps: depsWith(world(f).gh) });
    assert.match(plain.reason, /is a rollup: land it with land --approve .* --rollup/);
    const serial = approveSerial({ cwd: f.fx.repo, trainId: r.trainId, deps: depsWith(world(f).gh) });
    assert.match(serial.reason, /is a rollup/);
  });
});

describe('approve: push, ONE PR, a one-step run under the rollup policy', () => {
  it('pushes the candidate to rollup/<date>-1, opens ONE PR, pins the squash to the candidate, and the read-back is verified and tested; no AI-* trailer anywhere', () => {
    const f = fixture(2);
    const w = world(f);
    const b = build(f, w);
    const r = approve(f, w, { trainId: b.trainId });
    assert.equal(r.ok, true, r.text);
    assert.equal(w.creates.length, 1);
    const branch = readTrain(f.dir, b.trainId).train.rollup.branch;
    assert.match(branch, /^rollup\/\d{8}-1$/);
    const candidate = readTrain(f.dir, b.trainId).train.candidate;
    assert.equal(git(['ls-remote', 'origin', `refs/heads/${branch}`], f.fx.repo).split(/\s+/)[0], candidate.oid);
    assert.equal(w.merges.length, 1);
    const m = w.merges[0];
    assert.ok(m.includes('--squash'));
    assert.equal(m.includes('--auto'), false);
    assert.equal(m.includes('--delete-branch'), false);
    assert.equal(m.at(-2), '--match-head-commit');
    assert.equal(m.at(-1), candidate.oid);
    const run = runOf(f, b.trainId);
    assert.equal(run.steps.length, 1);
    assert.equal(run.policy.name, 'rollup');
    const o = run.steps[0].outcome;
    assert.deepEqual([o.status, o.verdict], ['landed', 'verified']);
    assert.deepEqual(o.ci, run.steps[0].attempt.ci, 'the landed outcome carries the intent ci byte for byte');
    assert.equal(o.ci.tree, candidate.tree);
    assert.equal(run.finalized.result.combination, 'tested');
    assert.equal(readTrain(f.dir, b.trainId).train.phase, 'landed');
    // Evidence honesty: the rollup commit and every member commit on the rollup branch carry no AI-* trailer.
    const squashMsg = git(['log', '-1', '--format=%B', o.mergeOid], f.fx.repo);
    assert.equal(hasAi(squashMsg), false);
    assert.equal(parseRollupManifest(squashMsg).manifest.stage, 'final');
    for (const c of git(['rev-list', `${f.base}..${candidate.oid}`], f.fx.repo).split('\n').filter(Boolean)) assert.equal(hasAi(git(['log', '-1', '--format=%B', c], f.fx.repo)), false, `commit ${c.slice(0, 8)}`);
    // Each member is recorded against its OWN tree.
    for (const pm of run.policy.members) assert.equal(pm.tree, f.members.find((x) => x.id === pm.id).tree);
    assert.notEqual(run.policy.members[0].tree, run.policy.candidateTree);
    assert.equal(parseRollupManifest(w.rollupPr.body).manifest.stage, 'provisional', 'the PR body was the provisional manifest');
  });
  it('a member moved between build and approve refuses the approve (member-refused) with nothing pushed; a rebuild with --hold lands the rest', () => {
    const f = fixture(2);
    const w = world(f);
    const b = build(f, w);
    git(['checkout', '-q', f.members[0].id], f.fx.repo);
    fs.writeFileSync(path.join(f.fx.repo, 'more.txt'), 'x\n'); git(['add', 'more.txt'], f.fx.repo); git(['commit', '-q', '-m', 'more'], f.fx.repo);
    git(['push', '-q', 'origin', `${f.members[0].id}:refs/heads/${f.members[0].id}`], f.fx.repo); git(['checkout', '-q', 'main'], f.fx.repo);
    const r = approve(f, w, { trainId: b.trainId });
    assert.equal(r.ok, false);
    assert.match(r.reason, /member-refused:m1: shipped-head-refused: branch-moved/);
    assert.equal(w.creates.length, 0);
    assert.equal(git(['ls-remote', 'origin', 'refs/heads/rollup/*'], f.fx.repo), '', 'nothing was pushed');
  });
  it('the base moved after the build: base-moved, nothing pushed (pinning the head does not pin the base)', () => {
    const f = fixture(1);
    const w = world(f);
    const b = build(f, w);
    git(['checkout', '-q', 'main'], f.fx.repo);
    fs.writeFileSync(path.join(f.fx.repo, 'foreign.txt'), 'x\n'); git(['add', 'foreign.txt'], f.fx.repo); git(['commit', '-q', '-m', 'foreign'], f.fx.repo); git(['push', '-q', 'origin', 'main'], f.fx.repo);
    const r = approve(f, w, { trainId: b.trainId });
    assert.match(r.reason, /base-moved/);
    assert.equal(w.creates.length, 0);
  });
});

describe('a red rollup keeps its candidate and logs; no automatic bisect', () => {
  it('failed required checks stop the run; the branch, the PR and the train remain; the summary names --hold and says a green subset proves nothing', () => {
    const f = fixture(2);
    const w = world(f); w.checks = 'fail';
    const b = build(f, w);
    const r = approve(f, w, { trainId: b.trainId });
    assert.equal(r.ok, false);
    assert.equal(w.merges.length, 0);
    const o = runOf(f, b.trainId).steps[0].outcome;
    assert.deepEqual([o.status, o.code], ['refused', 'checks-failed']);
    const t = readTrain(f.dir, b.trainId).train;
    assert.equal(git(['ls-remote', 'origin', `refs/heads/${t.rollup.branch}`], f.fx.repo).split(/\s+/)[0], t.candidate.oid, 'the candidate branch remains');
    assert.ok(w.rollupPr && w.rollupPr.state === 'OPEN', 'the PR remains open');
    assert.ok(t.worktree && fs.existsSync(t.worktree), 'the candidate worktree remains');
    assert.match(r.text, /Eject a suspect and rebuild: land --rollup --hold <member>/);
    assert.match(r.text, /does NOT prove it at fault/);
  });
});

describe('operation recovery: each remote action is reconciled before it is retried (R1-H7)', () => {
  it('a PR whose create answer was lost is ADOPTED on retry (one PR); a refusal while it cannot be created leaves the branch pushed', () => {
    const f = fixture(1);
    const w = world(f); w.createFails = true;
    const b = build(f, w);
    const r1 = approve(f, w, { trainId: b.trainId });
    assert.equal(r1.ok, false);
    assert.equal(readTrain(f.dir, b.trainId).train.rollup.phase, 'pr-intent');
    w.createFails = false;
    const r2 = approve(f, w, { trainId: b.trainId });
    assert.equal(r2.ok, true, r2.text);
    assert.equal(w.creates.length, 2, 'the first attempt failed, the second created once');
    // A lost answer: the PR exists although `create` reported failure.
    const g = fixture(1);
    const w2 = world(g);
    const orig = w2.gh;
    let first = true;
    w2.gh = (args) => { const out = orig(args); if (args[1] === 'create' && first) { first = false; return { ok: false, status: 1, stdout: '', stderr: 'timeout', reason: 'timeout' }; } return out; };
    const b2 = build(g, w2);
    assert.equal(approve(g, w2, { trainId: b2.trainId }).ok, false);
    const r = approve(g, w2, { trainId: b2.trainId });
    assert.equal(r.ok, true, r.text);
    assert.equal(w2.creates.length, 1, 'the retry adopted the existing PR and sent no second create');
  });
  it('two PRs for the branch, or a foreign branch of that name, fail closed', () => {
    const f = fixture(1);
    const w = world(f);
    const b = build(f, w);
    const orig = w.gh;
    w.gh = (args) => (args[1] === 'list' ? ok([{ number: 7, state: 'OPEN', headRefOid: 'a'.repeat(40), baseRefName: 'main' }, { number: 8, state: 'CLOSED', headRefOid: 'a'.repeat(40), baseRefName: 'main' }]) : orig(args));
    assert.match(approve(f, w, { trainId: b.trainId }).reason, /rollup-pr-ambiguous/);
  });
  it('a finalized rollup resumed with the grant gone and the rules API down makes no landing read', () => {
    const f = fixture(1);
    const w = world(f);
    const b = build(f, w);
    const first = approve(f, w, { trainId: b.trainId });
    assert.equal(first.ok, true);
    fs.rmSync(f.grantFile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    w.rules = 'not json';
    const before = w.calls.length;
    const again = resume(f, w, b.trainId);
    assert.equal(again.ok, true);
    assert.equal(again.text, first.text);
    assert.ok(w.calls.slice(before).every((c) => c[0] === 'pr' && (c[1] === 'view' || c[1] === 'close')), 'only the idempotent member-PR cleanup may read');
    assert.equal(w.merges.length, 1);
  });
});

describe('supersession: one live rollup per repo (R1-H4)', () => {
  it('a rollup that never requested a merge is superseded by the next build (kept, abandoned, never approvable); one with a merge in flight blocks it', () => {
    const f = fixture(1);
    const w = world(f);
    const b1 = build(f, w);
    const b2 = build(f, w);
    assert.equal(b2.ok, true, b2.text);
    const t1 = readTrain(f.dir, b1.trainId).train;
    assert.equal(t1.phase, 'abandoned');
    assert.ok(t1.notes.some((n) => n.includes(`superseded by ${b2.trainId}`)));
    assert.match(approve(f, w, { trainId: b1.trainId }).reason ?? '', /./, 'an abandoned rollup is not approvable');
    // A rollup whose merge request was sent but not observed blocks the next build.
    w.mergeBehavior = () => ok();
    approve(f, w, { trainId: b2.trainId });
    const b3 = build(f, w);
    assert.equal(b3.ok, false);
    assert.match(b3.reason, /may have a merge in flight/);
  });
});

describe('the post-landing cleanup closes member PRs only when the candidate content is proven (R2-H3, R3-H1, R3-H2)', () => {
  it('a verified rollup closes each member PR "superseded by #N", bound to its admitted head; a PR whose head moved is left open', () => {
    const f = fixture(2, { prs: true });
    const w = world(f);
    const b = build(f, w);
    w.memberPrs.get(f.members[1].pr).head = 'f'.repeat(40); // m2's PR head moved after admission
    const r = approve(f, w, { trainId: b.trainId });
    assert.equal(r.ok, true, r.text);
    assert.deepEqual(w.closes.map((c) => c.pr), [f.members[0].pr]);
    assert.match(w.closes[0].args.join(' '), /superseded by #101 \(fleet rollup rollup\/\d{8}-1\)/);
    const closures = readTrain(f.dir, b.trainId).train.rollup.closures;
    assert.deepEqual(closures.map((c) => [c.prNumber, c.status]), [[f.members[0].pr, 'closed'], [f.members[1].pr, 'skipped-head-moved']]);
    assert.match(r.text, /skipped-head-moved/);
  });
  it('a squash whose tree is NOT the candidate (tree-mismatch) closes no member PR, halts, is not ok, and leaves the train awaiting-merge', () => {
    const f = fixture(2, { prs: true });
    const w = world(f, { squashExtra: 'extra.txt' });
    const b = build(f, w);
    const r = approve(f, w, { trainId: b.trainId });
    assert.equal(r.ok, false);
    const run = runOf(f, b.trainId);
    assert.equal(run.steps[0].outcome.verdict, 'tree-mismatch');
    assert.ok(run.steps[0].outcome.trees.expected && run.steps[0].outcome.trees.observed);
    assert.equal(run.halt.code, 'tree-mismatch');
    assert.equal(w.closes.length, 0);
    assert.equal(readTrain(f.dir, b.trainId).train.phase, 'awaiting-merge');
  });
  it('a foreign commit on the base before the squash (untested-base) closes nothing and halts', () => {
    const f = fixture(1, { prs: true });
    const w = world(f, { mergeBehavior: ({ w: ww, args }) => { git(['checkout', '-q', 'main'], f.fx.repo); fs.writeFileSync(path.join(f.fx.repo, 'foreign.txt'), 'x\n'); git(['add', 'foreign.txt'], f.fx.repo); git(['commit', '-q', '-m', 'foreign'], f.fx.repo); git(['push', '-q', 'origin', 'main'], f.fx.repo); ww.rollupPr.mergeCommit = squash(f, args); ww.rollupPr.state = 'MERGED'; return ok(); } });
    const b = build(f, w);
    const r = approve(f, w, { trainId: b.trainId });
    assert.equal(r.ok, false);
    assert.equal(runOf(f, b.trainId).steps[0].outcome.verdict, 'untested-base');
    assert.equal(w.closes.length, 0);
    assert.equal(readTrain(f.dir, b.trainId).train.phase, 'awaiting-merge');
  });
});

describe('the chip-side contract: .fleet.json landing: "rollup"', () => {
  function chipFx(landing) {
    const fx = makeFleetRepo({ fleetConfig: { mergeMethod: 'pr', testCommand: { tiers: [{ name: 'ok', command: ['node', '-e', '0'] }] }, ...(landing ? { landing } : {}) } });
    git(['add', '.fleet.json'], fx.repo); git(['commit', '-q', '-m', 'cfg'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, ...fake.env }, { prependPath: [fake.bin] });
    const f = (args) => runFleet(args, { cwd: fx.repo, env });
    addBranch(fx.repo, 'chip', { 'f.txt': 'f\n' });
    git(['checkout', '-q', 'chip'], fx.repo);
    assert.equal(f(['claim', '--id', 'chip', '--intent', 'chip', '--paths', 'f.txt']).status, 0);
    return f;
  }
  it('ready and next print the LANDING line in rollup mode, and neither prints it otherwise (byte-identical to today)', () => {
    const on = chipFx('rollup');
    const ready = on(['ready', '--id', 'chip']);
    assert.match(ready.stdout, new RegExp(landingRollupLine('fleet').slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(on(['next', '--id', 'chip']).stdout, /LANDING: this repo lands by rollup/);
    const off = chipFx(null);
    assert.doesNotMatch(off(['ready', '--id', 'chip']).stdout, /LANDING:/);
    assert.doesNotMatch(off(['next', '--id', 'chip']).stdout, /LANDING:/);
  });
  it('landing accepts only pr or rollup', () => {
    const fx = makeFleetRepo({ fleetConfig: { mergeMethod: 'pr', testCommand: { tiers: [{ name: 'ok', command: ['node', '-e', '0'] }] }, landing: 'nope' } });
    assert.throws(() => resolveConfig(fx.repo, { env: { ...process.env } }).landing, /landing/);
  });
});

describe('audit round 1: lifecycle, identity and cleanup guards', () => {
  it('an abandoned (superseded) rollup is never approved or resumed (R1-H3)', () => {
    const f = fixture(1);
    const w = world(f);
    const b1 = build(f, w);
    build(f, w); // supersedes b1
    assert.equal(readTrain(f.dir, b1.trainId).train.phase, 'abandoned');
    assert.match(approve(f, w, { trainId: b1.trainId }).reason, /is abandoned/);
    assert.match(resume(f, w, b1.trainId).reason, /is abandoned/);
    assert.equal(w.creates.length, 0);
  });
  it('the record must describe the train member by member, in order (R1-H5, H13)', () => {
    const f = fixture(2);
    const b = build(f, world(f));
    const train = readTrain(f.dir, b.trainId).train;
    const rec = readRollupRecord(f.dir, b.trainId).rec;
    assert.equal(rollupTrainProblem(rec, train), null);
    assert.match(rollupTrainProblem({ ...rec, members: [rec.members[1], rec.members[0]] }, train), /member 1 is m2@/);
    assert.match(rollupTrainProblem({ ...rec, members: [{ ...rec.members[0], head: 'e'.repeat(40) }, rec.members[1]] }, train), /member 1 is m1@e{12}/);
    assert.match(rollupTrainProblem({ ...rec, members: [{ ...rec.members[0], prNumber: 99, repo: 'x/y' }, rec.members[1]] }, train), /different PRs/);
    assert.match(rollupTrainProblem({ ...rec, candidateTree: 'f'.repeat(40) }, train), /candidate tree/);
    assert.match(rollupTrainProblem({ ...rec, members: [rec.members[0]] }, train), /names 1 member/);
  });
  it('no required checks configured: the rollup is refused as ci-refused, never merged on nothing (R1-H6); an unknown inventory stops the run', () => {
    const f = fixture(1);
    const w = world(f); w.rules = [];
    const b = build(f, w);
    const unknown = approve(f, w, { trainId: b.trainId });
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /neither rulesets nor branch protection require a status check/);
    const g = fixture(1);
    const w2 = world(g); w2.rules = []; // no ruleset requires a check, and the config says none are required either
    const b2 = build(g, w2);
    const r = approve(g, w2, { trainId: b2.trainId, serialOpts: { requiredChecks: [] } });
    assert.equal(r.ok, false, r.text);
    assert.equal(w2.merges.length, 0);
    assert.deepEqual([runOf(g, b2.trainId).steps[0].outcome.status, runOf(g, b2.trainId).steps[0].outcome.code], ['refused', 'ci-refused']);
    assert.match(runOf(g, b2.trainId).steps[0].outcome.reason, /no required checks are configured/);
  });
  it('the overlap read asks git for paths WITHOUT rename detection, so a rename source is never missed (R1-H7)', () => {
    const f = fixture(2);
    const w = world(f);
    const deps = mkDeps(f, w);
    const seen = [];
    const git0 = deps.git;
    deps.git = (args, cwd, o) => { if (args[0] === 'diff') seen.push(args); return git0(args, cwd, o); };
    assert.equal(buildRollup(f.ctx, {}, deps, { parseSelect }).ok, true);
    const ours = seen.filter((a) => a.some((x) => x.includes('...')));
    assert.ok(ours.length === 2 && ours.every((a) => a.includes('--no-renames')), JSON.stringify(seen));
  });
  it('a candidate that cannot be built (a member subject unreadable) leaves no record and no half-built rollup (L1)', () => {
    const f = fixture(1);
    const w = world(f);
    const deps = mkDeps(f, w);
    const git0 = deps.git;
    deps.git = (args, cwd, o) => (args.includes('log') && args.includes('--format=%s') ? { ok: false, status: 1, stdout: '', stderr: 'boom', reason: 'boom' } : git0(args, cwd, o));
    const r = buildRollup(f.ctx, {}, deps, { parseSelect });
    assert.equal(r.ok, false);
    assert.match(r.text, /could not be built/);
    assert.equal(fs.existsSync(path.join(f.dir, 'rollup')), false, 'no rollup record directory was written');
  });
  it('a superseded rollup PR that cannot be closed is reported, persisted on the old train and retried on the next resume (R1-H9, M10)', () => {
    const f = fixture(1);
    const w = world(f); w.checks = 'pending';
    const b1 = build(f, w);
    approve(f, w, { trainId: b1.trainId, serialOpts: { timeoutMs: 30 } }); // opens PR #101, never requests a merge
    const oldPr = readTrain(f.dir, b1.trainId).train.rollup.prNumber;
    w.checks = 'pass';
    const b2 = build(f, w);
    assert.match(b2.text, /superseded/);
    const orig = w.gh;
    w.gh = (args) => (args[1] === 'close' && Number(args[2]) === oldPr && w.closeFails ? { ok: false, status: 1, stdout: '', stderr: 'denied', reason: 'denied' } : orig(args));
    w.closeFails = true;
    const r = approve(f, w, { trainId: b2.trainId });
    assert.match(r.text, new RegExp(`superseded rollup PR #${oldPr}: failed \\(denied\\)`));
    assert.equal(readTrain(f.dir, b1.trainId).train.rollup.closures.at(-1).status, 'failed');
    w.closeFails = false;
    const again = resume(f, w, b2.trainId);
    assert.doesNotMatch(again.text, /superseded rollup PR/);
    assert.equal(readTrain(f.dir, b1.trainId).train.rollup.closures.at(-1).status, 'closed');
  });
  it('a member PR whose head moved around the close is flagged with how to reopen it (R1-H8, H12)', () => {
    const f = fixture(1, { prs: true });
    const w = world(f);
    const b = build(f, w);
    const orig = w.gh;
    let after = false;
    w.gh = (args) => { const out = orig(args); if (args[1] === 'close') { after = true; w.memberPrs.get(f.members[0].pr).head = 'a'.repeat(40); } void after; return out; };
    const r = approve(f, w, { trainId: b.trainId });
    assert.match(r.text, /the head moved to a{12} around the close: gh pr reopen/);
    assert.equal(readTrain(f.dir, b.trainId).train.rollup.closures[0].status, 'failed');
  });
  it('the operation record belongs to a rollup train only (R1-M11)', () => {
    const f = fixture(1);
    const b = build(f, world(f));
    const t = readTrain(f.dir, b.trainId).train;
    const withRollup = { ...t, rollup: { branch: 'rollup/20261118-1', repo: 'o/n', candidate: t.candidate, phase: 'pushed', prNumber: null } };
    assert.equal(TrainSchema.safeParse(withRollup).success, true);
    const { landing, ...noLanding } = withRollup;
    assert.equal(TrainSchema.safeParse(noLanding).success, false);
  });
});

describe('audit round 2: a close is bound to the admitted head and VERIFIED (R2-H2, H3, M2-M4)', () => {
  /** Two rollups where the first opened its PR but never requested a merge; returns what a close test needs. */
  function superseded() {
    const f = fixture(1);
    const w = world(f); w.checks = 'pending';
    const b1 = build(f, w);
    approve(f, w, { trainId: b1.trainId, serialOpts: { timeoutMs: 30 } });
    const oldPr = readTrain(f.dir, b1.trainId).train.rollup.prNumber;
    w.checks = 'pass';
    const b2 = build(f, w);
    return { f, w, b1, b2, oldPr, old: () => w.allPrs.find((p) => p.number === oldPr) };
  }
  it('a superseded rollup PR whose head moved is NOT closed: skipped-head-moved, no close call, reported', () => {
    const { f, w, b1, b2, oldPr, old } = superseded();
    old().head = 'c'.repeat(40);
    const r = approve(f, w, { trainId: b2.trainId });
    assert.equal(w.calls.some((c) => c[1] === 'close' && Number(c[2]) === oldPr), false);
    assert.match(r.text, new RegExp(`superseded rollup PR #${oldPr}: skipped-head-moved`));
    assert.equal(readTrain(f.dir, b1.trainId).train.rollup.closures.at(-1).status, 'skipped-head-moved');
  });
  it('an unreadable or malformed answer AFTER the close leaves it unverified (failed), and the next run reconciles it as already closed', () => {
    for (const bad of [{ ok: false, status: 1, stdout: '', stderr: 'x', reason: 'down' }, { ok: true, status: 0, stdout: '{"state":42}', stderr: '' }, { ok: true, status: 0, stdout: 'not json', stderr: '' }]) {
      const { f, w, b1, b2, oldPr } = superseded();
      const orig = w.gh;
      let closed = false;
      w.gh = (args) => {
        if (args[1] === 'close' && Number(args[2]) === oldPr) closed = true;
        if (closed && args[1] === 'view' && Number(args[2]) === oldPr && args[args.indexOf('--json') + 1] === 'state,headRefOid') { closed = 'seen'; return bad; }
        return orig(args);
      };
      const r = approve(f, w, { trainId: b2.trainId });
      assert.match(r.text, /the PR could not be read after the close, so the close is unverified/);
      assert.equal(readTrain(f.dir, b1.trainId).train.rollup.closures.at(-1).status, 'failed');
      w.gh = orig; // the next run reads the PR first: it is already closed, so it is reconciled without a second close
      const closesBefore = w.calls.filter((c) => c[1] === 'close' && Number(c[2]) === oldPr).length;
      resume(f, w, b2.trainId);
      assert.equal(readTrain(f.dir, b1.trainId).train.rollup.closures.at(-1).status, 'closed');
      assert.equal(w.calls.filter((c) => c[1] === 'close' && Number(c[2]) === oldPr).length, closesBefore, 'no second close of a PR that is already closed');
    }
  });
});

describe('audit round 3: a closed PR is reconciled against its head too (R3-H2, H3)', () => {
  it('a close followed by a head movement is never cleared by the next run: it becomes skipped-head-moved and is reported until resolved', () => {
    const f = fixture(1);
    const w = world(f); w.checks = 'pending';
    const b1 = build(f, w);
    approve(f, w, { trainId: b1.trainId, serialOpts: { timeoutMs: 30 } });
    const oldPr = readTrain(f.dir, b1.trainId).train.rollup.prNumber;
    w.checks = 'pass';
    const b2 = build(f, w);
    const rp = w.allPrs.find((p) => p.number === oldPr);
    const orig = w.gh;
    w.gh = (args) => { const out = orig(args); if (args[1] === 'close' && Number(args[2]) === oldPr) rp.head = 'c'.repeat(40); return out; }; // work is pushed around the close
    const r1 = approve(f, w, { trainId: b2.trainId });
    assert.match(r1.text, new RegExp(`superseded rollup PR #${oldPr}: failed \\(the head moved to c{12} around the close`));
    assert.equal(readTrain(f.dir, b1.trainId).train.rollup.closures.at(-1).status, 'failed');
    const r2 = resume(f, w, b2.trainId); // the PR is now CLOSED with a foreign head: it must NOT read as a clean close
    assert.match(r2.text, new RegExp(`superseded rollup PR #${oldPr}: skipped-head-moved`));
    assert.equal(readTrain(f.dir, b1.trainId).train.rollup.closures.at(-1).status, 'skipped-head-moved');
    const r3 = resume(f, w, b2.trainId);
    assert.match(r3.text, new RegExp(`superseded rollup PR #${oldPr}: skipped-head-moved`), 'reported on every run until an operator resolves it');
  });
});

describe('audit round 4: merged superseded PRs and unrecordable outcomes are told apart (R4-M1, M2)', () => {
  function twoRollups() {
    const f = fixture(1);
    const w = world(f); w.checks = 'pending';
    const b1 = build(f, w);
    approve(f, w, { trainId: b1.trainId, serialOpts: { timeoutMs: 30 } });
    const oldPr = readTrain(f.dir, b1.trainId).train.rollup.prNumber;
    w.checks = 'pass';
    const b2 = build(f, w);
    return { f, w, b1, b2, oldPr, rp: w.allPrs.find((p) => p.number === oldPr) };
  }
  it('a superseded PR that was MERGED at another head says it cannot be reopened and must be checked against the base', () => {
    const { f, w, b1, b2, rp } = twoRollups();
    rp.state = 'MERGED'; rp.head = 'e'.repeat(40);
    const r = approve(f, w, { trainId: b2.trainId });
    assert.match(r.text, /was MERGED at head e{12}, not the admitted [0-9a-f]{12}: check that work against the base by hand \(a merged PR cannot be reopened\)/);
    assert.doesNotMatch(r.text, /gh pr reopen/);
    assert.equal(readTrain(f.dir, b1.trainId).train.rollup.closures.at(-1).status, 'skipped-head-moved');
  });
  it('an outcome that cannot be persisted (the old train no longer records the supersession) is reported, not swallowed', () => {
    const { f, w, b1, b2, oldPr } = twoRollups();
    const orig = w.gh;
    w.gh = (args) => {
      if (args[1] === 'close' && Number(args[2]) === oldPr) { const cur = readTrain(f.dir, b1.trainId).train; patchTrain(f.dir, b1.trainId, { rollup: { ...cur.rollup, superseded: 't-20200101000000-ffff' } }, depsWith(orig)); }
      return orig(args);
    };
    const r = approve(f, w, { trainId: b2.trainId });
    assert.match(r.text, new RegExp(`the outcome of superseded rollup PR #${oldPr} \\(closed\\) could not be recorded: train .* no longer records this supersession or candidate`));
  });
});
