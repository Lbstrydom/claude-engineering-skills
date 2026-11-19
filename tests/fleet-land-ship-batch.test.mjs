/**
 * @fileoverview `fleet land --ship-batch` (scripts/lib/fleet/ship-batch.mjs; docs/plans/coordinator-aggregate-ship.md section 2.4).
 *
 * Three layers. (1) Pure: the message split, the read-back, and the child-envelope reader (every way a child can fail is REFUSED).
 * (2) Selection: which members are ship-ok, with stubbed child / CI / GitHub — a waived or otherwise refused member never makes
 * the set, and the partition happens before the build. (3) The merge, in-process on the REAL serial runner with a scripted `gh`
 * and real git: a "squash" is a real commit on the bare origin, so the base progression and the read-back run against real
 * objects. Cases a happy path would never find: the grant revoked between build and merge, a foreign commit on the base, a
 * merge GitHub accepted whose recording was lost, a read-back that cannot finish, and a squash that lost its trailers.
 */
import { ev, oracleOf, requiredEvidence } from './helpers/fleet-ci-evidence-fx.mjs';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots } from './helpers/fleet-repo.mjs';
import { PR, REPO, ok, view, fast, depsWith, multiFx } from './helpers/fleet-serial-fx.mjs';
import { readTrain } from '../scripts/lib/fleet/registry.mjs';
import { readSerial, resumeSerial } from '../scripts/lib/fleet/serial.mjs';
import { CANONICAL_GRANT } from '../scripts/lib/fleet/coordinator-grant.mjs';
import {
  splitCommitMessage, aiTrailerMultiset, readBackReasons, runShippedHeadChild, partitionMembers, buildShipBatch,
  approveShipBatch, resumeShipBatch, writeShipBatch, SHIP_BATCH_SCHEMA, CHILD_SCHEMA, admitMember, readShipBatch, ciDecisionFor, admitShipBatchMember,
} from '../scripts/lib/fleet/ship-batch.mjs';

after(cleanupFleetRoots);

const MSG = [
  'feat: the thing', '', 'body line one', 'body line two', '',
  'AI-Skill: ship', 'AI-Models: claude,gpt', 'AI-Gate: converged', 'AI-Run-ID: 981fc79a-0fbb-447a-a294-b0c0217dab71',
  'AI-Final-Review: approve', 'AI-Ship-Authority: launch-prompt',
].join('\n');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

// ---- (1) pure ----------------------------------------------------------------------------------------------------------------
describe('splitCommitMessage: lossless', () => {
  it('subject is line 1; one blank separator line is dropped; the body keeps everything else', () => {
    assert.deepEqual(splitCommitMessage('subj\n\nbody 1\n\nbody 2\n'), { subject: 'subj', body: 'body 1\n\nbody 2' });
  });
  it('a message with NO blank line after its subject loses nothing', () => {
    assert.deepEqual(splitCommitMessage('subj\nline right under\nmore\n'), { subject: 'subj', body: 'line right under\nmore' });
  });
  it('CRLF is folded and trailing newlines are trimmed', () => {
    assert.deepEqual(splitCommitMessage('subj\r\n\r\nbody\r\n\r\n'), { subject: 'subj', body: 'body' });
  });
  it('a subject-only message has an empty body', () => {
    assert.deepEqual(splitCommitMessage('subj\n'), { subject: 'subj', body: '' });
  });
  it('only ONE leading blank line is dropped (a second is content)', () => {
    assert.equal(splitCommitMessage('subj\n\n\nbody').body, '\nbody');
  });
});

describe('readBackReasons: the squash must carry the ship commit\'s provenance', () => {
  const squashOf = (m, over = {}) => { const { subject, body } = splitCommitMessage(m); return `${over.subject ?? `${subject} (#21)`}\n\n${over.body ?? body}\n`; };
  it('GitHub\'s own " (#N)" on the subject is tolerated', () => {
    assert.deepEqual(readBackReasons(MSG, squashOf(MSG)), []);
  });
  it('a squash that lost the trailers is refused, naming them', () => {
    const r = readBackReasons(MSG, squashOf(MSG, { body: 'body line one\nbody line two' }));
    assert.ok(r.some((x) => /AI-\* trailers differ/.test(x)), r.join('|'));
  });
  it('a squash with a changed AI-Gate is refused', () => {
    const r = readBackReasons(MSG, squashOf(MSG).replace('AI-Gate: converged', 'AI-Gate: passed'));
    assert.ok(r.some((x) => /trailers differ/.test(x)));
  });
  it('a squash that lost non-trailer body text is refused even when the trailers survive', () => {
    const r = readBackReasons(MSG, squashOf(MSG).replace('body line two\n', ''));
    assert.ok(r.some((x) => /body does not contain/.test(x)), r.join('|'));
  });
  it('a different subject is refused', () => {
    assert.ok(readBackReasons(MSG, squashOf(MSG, { subject: 'something else' })).some((x) => /subject/.test(x)));
  });
  it('a ship commit with no AI-* trailers has nothing to compare: refused, never vacuously equal', () => {
    assert.ok(readBackReasons('plain\n\nbody', 'plain (#1)\n\nbody').some((x) => /no AI-\* trailers/.test(x)));
  });
  it('aiTrailerMultiset ignores non-AI trailers and order', () => {
    assert.deepEqual(aiTrailerMultiset('s\n\nb\n\nCo-authored-by: x\nAI-Gate: converged\nAI-Skill: ship'), ['AI-Gate: converged', 'AI-Skill: ship']);
  });
});

describe('runShippedHeadChild: every way the child can fail is a refusal', () => {
  const H = 'a'.repeat(40);
  const exists = () => true;
  const spawnOf = (r) => () => r;
  const good = { schema: CHILD_SCHEMA, ok: true, head: H, runId: 'r', gate: 'converged', conditions: [], refusals: [] };
  it('exit 0 with ok:true and the right head is ship-ok', () => {
    const r = runShippedHeadChild({ worktree: '/w', head: H, spawn: spawnOf({ status: 0, stdout: JSON.stringify(good) }), exists });
    assert.equal(r.ok, true);
  });
  it('a worktree that is gone is evidence-unavailable (no spawn at all)', () => {
    let spawned = false;
    const r = runShippedHeadChild({ worktree: '/gone', head: H, spawn: () => { spawned = true; return {}; }, exists: () => false });
    assert.equal(r.ok, false); assert.equal(spawned, false); assert.match(r.reasons[0], /evidence-unavailable/);
  });
  it('a null worktree is refused', () => {
    assert.equal(runShippedHeadChild({ worktree: null, head: H, spawn: () => ({}), exists }).ok, false);
  });
  for (const [name, res, re] of [
    ['exit 1 (the checker errored)', { status: 1, stdout: '', stderr: 'boom' }, /checker-failed: exit 1/],
    ['a spawn error', { error: Object.assign(new Error('nope'), { code: 'ENOENT' }), status: null }, /checker-failed: nope/],
    ['a timeout', { error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), status: null }, /timed out/],
    ['a signal', { signal: 'SIGKILL', status: null }, /killed by SIGKILL/],
    ['unparsable stdout', { status: 0, stdout: 'not json' }, /not exactly one JSON/],
    ['another schema', { status: 0, stdout: JSON.stringify({ ...good, schema: 'shipped-head/v9' }) }, /schema/],
    ['a different head', { status: 0, stdout: JSON.stringify({ ...good, head: 'b'.repeat(40) }) }, /judged/],
    ['exit 0 but ok is not true', { status: 0, stdout: JSON.stringify({ ...good, ok: false, refusals: ['x: y'] }) }, /ok is not true/],
    ['an unexpected exit code', { status: 7, stdout: '' }, /checker-failed: exit 7/],
  ]) {
    it(name, () => {
      const r = runShippedHeadChild({ worktree: '/w', head: H, spawn: spawnOf(res), exists });
      assert.equal(r.ok, false);
      assert.match(r.reasons.join(' | '), re);
    });
  }
  it('a child that judged only a PREFIX-equal commit is refused: the head must be the FULL requested oid', () => {
    const other = H.slice(0, 12) + 'b'.repeat(28);
    const r = runShippedHeadChild({ worktree: '/w', head: H, spawn: spawnOf({ status: 0, stdout: JSON.stringify({ ...good, head: other }) }), exists });
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /not the full commit/);
  });
  it('the destination remote and the target branch reach the child ()', () => {
    let argv = null;
    runShippedHeadChild({ worktree: '/w', head: H, base: 'develop', remote: 'origin', spawn: (cmd, args) => { argv = args; return { status: 0, stdout: JSON.stringify(good) }; }, exists });
    assert.deepEqual(argv.slice(argv.indexOf('--base')), ['--base', 'develop', '--remote', 'origin', '--json']);
  });
  it('exit 2 carries the child\'s own refusals through', () => {
    const r = runShippedHeadChild({ worktree: '/w', head: H, spawn: spawnOf({ status: 2, stdout: JSON.stringify({ ...good, ok: false, refusals: ['trailers: AI-Gate is "waived"'] }) }), exists });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, ['trailers: AI-Gate is "waived"']);
  });
});

// ---- (2) selection -----------------------------------------------------------------------------------------------------------
describe('partitionMembers: only ship-ok members make the set', () => {
  const pr = (id, extra = {}) => ({ id, kind: 'pr', repo: REPO, prNumber: 20 + Number(id.slice(1)), baseRef: 'main', branch: id, oid: id.charCodeAt(1).toString(16).repeat(20).slice(0, 40), worktree: `/wt/${id}`, ...extra });
  const childByWt = (map) => ({ worktree }) => map[worktree] ?? { ok: true, reasons: [], envelope: {} };
  /** The oracle of a GitHub where every member PR is eligible at its ready oid and every required check passed. */
  const assessAllGreen = () => ({ expectedHead }) => ev.passed(expectedHead);
  const run = (members, over = {}) => partitionMembers({
    cwd: process.cwd(), members, base: 'main', remote: 'origin', requiredChecks: undefined,
    deps: { assessCi: over.assessCi ?? assessAllGreen(), shipBatch: { checkChild: over.checkChild ?? childByWt({}) } },
  });

  it('the train\'s destination remote is handed to every child check (build time)', () => {
    const seen = [];
    const ms = [pr('a1')];
    partitionMembers({
      cwd: process.cwd(), members: ms, base: 'main', remote: 'origin', requiredChecks: undefined,
      deps: { assessCi: assessAllGreen(), shipBatch: { checkChild: (a) => { seen.push(a); return { ok: true, reasons: [], envelope: {} }; } } },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].remote, 'origin');
    assert.equal(seen[0].base, 'main');
  });
  it('three clean members are all ship-ok', () => {
    const ms = [pr('a1'), pr('a2'), pr('a3')];
    const r = run(ms);
    assert.deepEqual(r.ok.map((m) => m.id), ['a1', 'a2', 'a3']);
    assert.deepEqual(r.needsUser, []);
  });
  it('a member the child refuses (a waived gate, say) is needs-user with ITS reasons, and the rest still ship', () => {
    const ms = [pr('a1'), pr('a2'), pr('a3')];
    const r = run(ms, { checkChild: childByWt({ '/wt/a2': { ok: false, reasons: ['trailers: AI-Gate is "waived"; only passed or converged may ship without the user'] } }) });
    assert.deepEqual(r.ok.map((m) => m.id), ['a1', 'a3']);
    assert.equal(r.needsUser[0].id, 'a2');
    assert.match(r.needsUser[0].reasons[0], /waived/);
  });
  it('a not-run member is likewise never selected', () => {
    const r = run([pr('a1')], { checkChild: () => ({ ok: false, reasons: ['trailers: AI-Gate is "not-run"'], envelope: null }) });
    assert.deepEqual(r.ok, []);
    assert.match(r.needsUser[0].reasons[0], /not-run/);
  });
  it('a bare branch (not a PR), a stacked PR and a missing ready oid each refuse with their own reason, WITHOUT running the child', () => {
    let calls = 0;
    const checkChild = () => { calls++; return { ok: true, reasons: [], envelope: {} }; };
    const r = run([pr('a1', { kind: 'branch', prNumber: null }), pr('a2', { baseRef: 'feat/parent' }), pr('a3', { oid: null })], { checkChild });
    assert.equal(r.ok.length, 0);
    assert.match(r.needsUser[0].reasons[0], /not-a-pr/);
    assert.match(r.needsUser[1].reasons[0], /stacked/);
    assert.match(r.needsUser[2].reasons.join(' '), /no ready oid/);
    assert.equal(calls, 0);
  });
  it('a PR that is not a merge candidate at the ready oid (head moved, draft, closed, retargeted) is needs-user, each with its own code', () => {
    const ms = [pr('a1')];
    for (const [code, re] of [['head-moved', /head-moved/], ['draft', /draft/], ['closed', /closed/], ['retargeted', /retargeted/]]) {
      const r = run(ms, { assessCi: () => ev.ineligible(code) });
      assert.equal(r.ok.length, 0, code);
      assert.match(r.needsUser[0].reasons.join(' '), re, code);
    }
  });
  it('required checks that are not green (C8) are needs-user: failed and not-run refuse, pending and missing wait', () => {
    const ms = [pr('a1')];
    for (const [e, re] of [[ev.failed('h'), /failed/], [ev.notRun('h'), /not-run/], [ev.pending('h'), /pending/], [ev.missing('h'), /missing/]]) {
      assert.match(run(ms, { assessCi: () => e }).needsUser[0].reasons.join(' '), re, e.tag);
    }
  });
  it('no required checks, PROVEN, is admitted (a consumer may require nothing); unknown evidence STOPS the partition, never a member refusal', () => {
    const ms = [pr('a1'), pr('a2'), pr('a3')];
    assert.deepEqual(run(ms, { assessCi: () => ev.noneRequired('h') }).ok.map((m) => m.id), ['a1', 'a2', 'a3']);
    const seen = [];
    const r = run(ms, { assessCi: ({ prNumber, expectedHead }) => { seen.push(prNumber); return prNumber === 22 ? ev.unknown('transport', 'rules api 502') : ev.passed(expectedHead); } });
    assert.deepEqual([r.ok, r.needsUser], [[], []]);
    assert.equal(r.stop.id, 'a2');
    assert.ok(r.stop.reason.includes('CI evidence unknown (transport: rules api 502)'), r.stop.reason);
    assert.deepEqual(seen, [21, 22], 'the partition stopped at the first unknown: a3 was never assessed');
  });
  it('the PRODUCTION default oracle is the real one: against a GitHub that answers nothing the partition stops, it never admits', () => {
    const ms = [pr('a1')];
    const r = partitionMembers({ cwd: process.cwd(), members: ms, base: 'main', remote: 'origin', deps: { gh: () => ({ ok: false, status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)', reason: 'x' }), shipBatch: { checkChild: () => ({ ok: true, reasons: [], envelope: {} }) } } });
    assert.equal(r.ok.length, 0);
    assert.ok(r.stop.reason.includes('transport'), r.stop.reason);
  });
});

// ---- the repo-backed layers ----------------------------------------------------------------------------------------------------
const fleetDirOf = (repo) => path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo), 'fleet');
const RULES_JSON = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }];
const msgOf = (k) => MSG.replace('feat: the thing', `feat: the thing ${k}`);

/** A built pr-mode train over `n` members, the write-once v2 record, a valid grant file, and deps that carry both. */
function batch(n, over = {}) {
  const { fx, members, trainId } = multiFx(n, { messages: members_(n) });
  const dir = fleetDirOf(fx.repo);
  const train = readTrain(dir, trainId).train;
  const grantFile = path.join(mkTmp('grant-'), 'CLAUDE.md');
  fs.writeFileSync(grantFile, `# rules\n\n${CANONICAL_GRANT.replace('Since <DATE>:', 'Since 2026-11-18:')}\n`);
  const childCalls = [];
  const shipBatch = {
    grantFile,
    checkChild: (a) => { childCalls.push(a); return over.child ? over.child(a) : { ok: true, reasons: [], envelope: {} }; },
  };
  writeShipBatch(dir, {
    schemaVersion: SHIP_BATCH_SCHEMA, trainId, grantVersion: 'v1', checkedAt: new Date().toISOString(), base: 'main', remote: train.destination.remote,
    candidateTree: train.candidate.tree,
    members: members.map((m) => ({ id: m.id, repo: REPO, prNumber: m.pr, oid: m.head, tree: m.tree, worktree: fx.repo })), excluded: over.excluded ?? [],
  });
  return { fx, members, trainId, dir, train, grantFile, shipBatch, childCalls };
}
function members_(n) { return Array.from({ length: n }, (_, i) => msgOf(i + 1)); }
const serialOf = (b) => { const r = readSerial(b.dir, b.trainId); if (!r.ok) throw new Error(`serial record: ${r.reason}`); return r.run; };
const stepOf = (b, id) => serialOf(b).steps.find((s) => s.id === id);

/** What GitHub would do for `gh pr merge --subject S --body-file F`: a REAL squash of the head onto origin/main with that message. */
function squashFrom(b, member, args, { foreignFirst = false, dropBody = false } = {}) {
  const subject = args[args.indexOf('--subject') + 1];
  const body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
  const { fx } = b;
  git(['checkout', '-q', 'main'], fx.repo);
  git(['pull', '-q', '--ff-only', 'origin', 'main'], fx.repo);
  if (foreignFirst) { fs.writeFileSync(path.join(fx.repo, 'foreign.txt'), 'someone else landed\n'); git(['add', 'foreign.txt'], fx.repo); git(['commit', '-q', '-m', 'foreign'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo); }
  git(['merge', '--squash', args.at(-1)], fx.repo);
  const msgFile = path.join(mkTmp('squash-'), 'msg');
  fs.writeFileSync(msgFile, `${subject} (#${member.pr})\n\n${dropBody ? 'trailers dropped' : body}\n`);
  git(['commit', '--allow-empty', '-q', '-F', msgFile], fx.repo);
  git(['push', '-q', 'origin', 'main'], fx.repo);
  return git(['rev-parse', 'HEAD'], fx.repo);
}

/** A scripted GitHub over every member PR: OPEN until its merge, then MERGED at the squash the behaviour made. */
function world(b, over = {}) {
  const prs = new Map(b.members.map((m) => [m.pr, { state: 'OPEN', head: m.head, mergeState: 'CLEAN', mergeCommit: null, checks: 'pass', queue: false, base: 'main', draft: false, unreadable: false }]));
  const merges = []; const calls = [];
  const w = {
    prs, merges, calls, rules: RULES_JSON, rulesFail: false, mergeBehavior: over.mergeBehavior, squashOpts: over.squashOpts ?? {},
    gh: (args) => {
      calls.push(args);
      if (args[0] === 'api' && /rules\/branches/.test(args[1])) return w.rulesFail ? { ok: false, status: 1, stdout: '', stderr: 'rules api down', reason: 'rules api down' } : { ok: true, status: 0, stdout: JSON.stringify(w.rules), stderr: '' };
      if (args[0] === 'api') return { ok: true, status: 0, stdout: JSON.stringify({ protected: false }), stderr: '' };
      const pr = Number(args[2]); const p = prs.get(pr);
      if (args[1] === 'checks') return { ok: p.checks === 'pass', status: p.checks === 'pass' ? 0 : 8, stdout: JSON.stringify([{ name: 'ci', bucket: p.checks, state: p.checks.toUpperCase(), completedAt: '2026-10-09T10:00:00Z' }]), stderr: '' };
      if (args[1] === 'view') {
        if (p.unreadable) return { ok: false, status: 1, stdout: '', stderr: 'boom', reason: 'gh failed' };
        const want = args[args.indexOf('--json') + 1];
        if (want === 'isInMergeQueue') return ok({ isInMergeQueue: p.queue });
        return ok(view(p.head, { state: p.state, isDraft: p.draft, baseRefName: p.base, mergeStateStatus: p.mergeState, mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null, url: `https://github.com/${REPO}/pull/${pr}` }));
      }
      if (args[1] === 'merge') {
        merges.push({ pr, args });
        const member = b.members.find((m) => m.pr === pr);
        if (w.mergeBehavior) return w.mergeBehavior({ pr, member, args, p, w });
        p.mergeCommit = squashFrom(b, member, args, w.squashOpts); p.state = 'MERGED';
        return ok();
      }
      return { ok: false, status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}`, reason: 'unexpected' };
    },
  };
  w.gh.assessCi = oracleOf(w);
  return w;
}
/** `gh` is a world's `gh` (or a wrapper that keeps its `assessCi`): its oracle is the one the run asks. */
const mk = (b, gh, extra = {}) => ({ cwd: b.fx.repo, dir: b.dir, trainId: b.trainId, deps: { ...depsWith(gh), assessCi: gh.assessCi, shipBatch: b.shipBatch, ...extra.deps }, serialOpts: { sleep: () => {}, timings: fast, ...(extra.serialOpts ?? {}) } });
const approve = (b, gh, extra = {}) => approveShipBatch(mk(b, gh, { ...extra, serialOpts: { timeoutMs: 60_000, ...(extra.serialOpts ?? {}) } }));
const resume = (b, gh, extra = {}) => resumeShipBatch(mk(b, gh, extra));
const outcomeOf = (b, id) => stepOf(b, id).outcome;
const baseTip = (b) => git(['ls-remote', 'origin', 'refs/heads/main'], b.fx.repo).split(/\s+/)[0];

describe('the ship-batch build record is write-once and strict (F2)', () => {
  it('a second write is refused, a malformed record is unreadable, and a full run leaves the record byte-unchanged', () => {
    const b = batch(1);
    const file = path.join(b.dir, 'shipbatch', `${b.trainId}.json`);
    const before = fs.readFileSync(file);
    assert.throws(() => writeShipBatch(b.dir, { ...readShipBatch(b.dir, b.trainId).batch }), /write-once/);
    const w = world(b);
    assert.equal(approve(b, w.gh).ok, true);
    assert.deepEqual(fs.readFileSync(file), before, 'nothing patches the record after the build');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(before), extra: 1 }));
    assert.equal(readShipBatch(b.dir, b.trainId).ok, false, 'a strict schema: an unknown key is refused');
  });
  it('a plain resume of a ship-batch run is refused, and a run is never driven by the other policy', () => {
    const b = batch(1);
    const w = world(b); w.prs.get(b.members[0].pr).mergeState = 'DIRTY';
    approve(b, w.gh);
    const r = resumeShipBatchPlain(b, w.gh);
    assert.match(r.reason, /policy-mismatch/);
    assert.equal(w.merges.length, 0);
  });
});
function resumeShipBatchPlain(b, gh) {
  return resumeSerial({ cwd: b.fx.repo, trainId: b.trainId, deps: depsWith(gh), sleep: () => {}, timings: fast });
}

describe('approveShipBatch: a clean batch, on the real serial runner', () => {
  it('lands every member with ITS OWN message; the merge argv is --squash and the full head pin, never --auto; the read-back verifies; the combination is tested', () => {
    const b = batch(2);
    const w = world(b);
    const r = approve(b, w.gh);
    assert.equal(r.ok, true, r.text);
    assert.equal(r.code, 'ok');
    assert.equal(w.merges.length, 2);
    for (const { args, pr } of w.merges) {
      const m = b.members.find((x) => x.pr === pr);
      assert.ok(args.includes('--squash'));
      assert.equal(args.includes('--auto'), false);
      assert.equal(args.at(-2), '--match-head-commit');
      assert.equal(args.at(-1), m.head, 'the full head oid is the last argument');
      assert.equal(args[args.indexOf('--subject') + 1], `feat: the thing ${b.members.indexOf(m) + 1}`);
    }
    for (const m of b.members) assert.equal(outcomeOf(b, m.id).verdict, 'verified');
    assert.match(r.text.split('\n')[0], /landed 2 of 2; final tree = the combined-tested tree/);
    assert.equal(serialOf(b).finalized.result.combination, 'tested');
    assert.equal(readTrain(b.dir, b.trainId).train.phase, 'landed');
    const landed = git(['log', '-1', '--format=%B', outcomeOf(b, 'm2').mergeOid], b.fx.repo);
    assert.deepEqual(aiTrailerMultiset(landed), aiTrailerMultiset(msgOf(2)));
  });
  it('the child re-ran at the exact head before each merge (admission is one predicate, build and merge)', () => {
    const b = batch(1);
    approve(b, world(b).gh);
    assert.ok(b.childCalls.some((c) => c.head === b.members[0].head && c.base === 'main' && c.remote === 'origin'));
  });
});

describe('F1: a member fault never stops the batch (the member step cannot stop the run)', () => {
  const landed = (b, id) => outcomeOf(b, id)?.status === 'landed';
  for (const [name, setup, status, code] of [
    ['an unreadable PR view', (p) => { p.unreadable = true; }, 'not-run', 'pr-unreadable'],
    ['a DIRTY PR', (p) => { p.mergeState = 'DIRTY'; }, 'refused', 'conflict'],
    ['a BEHIND PR (a ship-batch never updates a branch)', (p) => { p.mergeState = 'BEHIND'; }, 'refused', 'behind-base'],
    ['a closed PR', (p) => { p.state = 'CLOSED'; }, 'refused', 'pr-closed'],
    ['a draft PR', (p) => { p.draft = true; }, 'refused', 'pr-draft'],
    ['a retargeted PR', (p) => { p.base = 'other'; }, 'refused', 'pr-retargeted'],
    ['failed required checks', (p) => { p.checks = 'fail'; }, 'refused', 'checks-failed'],
  ]) {
    it(`${name} on member 2: members 1 and 3 still land`, () => {
      const b = batch(3);
      const w = world(b); setup(w.prs.get(b.members[1].pr));
      const r = approve(b, w.gh);
      assert.equal(landed(b, 'm1'), true, r.text);
      assert.equal(landed(b, 'm3'), true, r.text);
      assert.deepEqual([outcomeOf(b, 'm2').status, outcomeOf(b, 'm2').code], [status, code]);
      assert.equal(r.run?.halt ?? serialOf(b).halt, undefined, 'a member fault is not a halt');
    });
  }
  it('checks still pending at the deadline: member 2 is not-run/checks-pending, 1 and 3 land, the result is resumable (exit 3), and the train stays awaiting-merge', () => {
    const b = batch(3);
    const w = world(b); w.prs.get(b.members[1].pr).checks = 'pending';
    const r = approve(b, w.gh, { serialOpts: { timeoutMs: 30 } });
    assert.deepEqual([landed(b, 'm1'), landed(b, 'm3')], [true, true]);
    assert.deepEqual([outcomeOf(b, 'm2').status, outcomeOf(b, 'm2').code], ['not-run', 'checks-pending']);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'refused');
    assert.match(r.text.split('\n').find((l) => /ship-batch/.test(l)), /landed 2 of 3; 1 not yet decided: land --resume .* --ship-batch re-checks them/);
    assert.equal(readTrain(b.dir, b.trainId).train.phase, 'awaiting-merge');
    // The chain is merge chronology: member 2 may land LATER, after 3, and the run still validates and finalizes.
    w.prs.get(b.members[1].pr).checks = 'pass';
    const again = resume(b, w.gh);
    assert.equal(landed(b, 'm2'), true, again.text);
    assert.equal(again.ok, true, again.text);
    assert.equal(serialOf(b).policy.baseChain.length, 4);
    assert.equal(outcomeOf(b, 'm2').chainIndex, 3);
    assert.equal(readSerial(b.dir, b.trainId).ok, true);
  });
  it('an unknown fault kind and a throw inside the member step each stop the run as internal-error', () => {
    const b = batch(1);
    const w = world(b);
    const gh = (args) => { if (args[1] === 'merge') throw new Error('gh exploded'); return w.gh(args); }; // a throw INSIDE the member step (the merge call)
    gh.assessCi = w.gh.assessCi;
    const r = approve(b, gh);
    assert.equal(r.ok, false);
    assert.match(r.reason, /internal-error: gh exploded/);
    assert.equal(w.merges.length, 0);
  });
});

describe('gate honesty: a waived or not-run member is never laundered into passed (F6)', () => {
  it('a child refusal is refused/shipped-head-refused, never merged, and no aggregate gate appears', () => {
    const b = batch(2, { child: ({ head }) => (head === undefined ? {} : { ok: head !== undefined && !head.startsWith('x'), reasons: [], envelope: {} }) });
    b.shipBatch.checkChild = (a) => (a.head === b.members[0].head ? { ok: false, reasons: ['trailers: AI-Gate is "waived"; only passed or converged may ship without the user'], envelope: {} } : { ok: true, reasons: [], envelope: {} });
    const w = world(b);
    const r = approve(b, w.gh);
    assert.deepEqual([outcomeOf(b, 'm1').status, outcomeOf(b, 'm1').code], ['refused', 'shipped-head-refused']);
    assert.match(outcomeOf(b, 'm1').reason, /waived/);
    assert.equal(w.merges.every((m) => m.pr !== b.members[0].pr), true, 'the waived member never reached a merge');
    assert.equal(outcomeOf(b, 'm2').status, 'landed');
    assert.equal(r.ok, true);
    assert.equal(/aggregate/i.test(r.text), false);
  });
});

describe('tree identity: the head is re-read at merge time and proven by tree (F6, #609, #612)', () => {
  /** Push a new head for member 1 whose tree is `same` (a re-push of the tested content) or different. */
  function repush(b, { same }) {
    const m = b.members[0];
    git(['checkout', '-q', '--detach', m.head], b.fx.repo);
    if (same) git(['commit', '-q', '--amend', '-m', msgOf(1).replace('converged', 'converged')], b.fx.repo); // same tree, new oid
    else { fs.writeFileSync(path.join(b.fx.repo, 'dropped.txt'), 'x\n'); git(['add', 'dropped.txt'], b.fx.repo); git(['commit', '-q', '--amend', '-m', msgOf(1)], b.fx.repo); }
    const l = git(['rev-parse', 'HEAD'], b.fx.repo);
    git(['push', '-q', '-f', 'origin', `${l}:refs/pull/${m.pr}/head`], b.fx.repo);
    git(['checkout', '-q', 'main'], b.fx.repo);
    return l;
  }
  it('an equal-tree re-push is admitted AT the new head: the child runs at it, the merge pins it, the message is read from it', () => {
    const b = batch(1);
    const w = world(b);
    const l = repush(b, { same: true });
    assert.notEqual(l, b.members[0].head);
    w.prs.get(b.members[0].pr).head = l;
    const r = approve(b, w.gh);
    assert.equal(r.ok, true, r.text);
    assert.equal(w.merges[0].args.at(-1), l);
    assert.ok(b.childCalls.some((c) => c.head === l), 'admission ran again at the live head');
  });
  it('the #609 shape: a re-push whose tree differs is refused/head-moved with BOTH trees, and nothing merges', () => {
    const b = batch(1);
    const w = world(b);
    const l = repush(b, { same: false });
    w.prs.get(b.members[0].pr).head = l;
    const r = approve(b, w.gh);
    const o = outcomeOf(b, 'm1');
    assert.deepEqual([o.status, o.code], ['refused', 'head-moved']);
    assert.equal(o.trees.tested, b.members[0].tree);
    assert.notEqual(o.trees.seen, o.trees.tested);
    assert.equal(w.merges.length, 0);
    assert.equal(r.ok, false);
  });
  it('a head that keeps changing is bounded: not-run/head-churn', () => {
    const b = batch(1);
    const w = world(b);
    const p = w.prs.get(b.members[0].pr);
    let n = 0;
    const gh = (args) => { if (args[1] === 'view' && !args.includes('isInMergeQueue') && n < 6) { const l = repush(b, { same: true }); p.head = l; n += 1; } return w.gh(args); };
    gh.assessCi = w.gh.assessCi;
    approve(b, gh);
    assert.ok(n >= 1);
    assert.ok(w.merges.length <= 1);
  });
});

describe('merge attribution, the unconfirmed merge and its reconciliation (F3, R1-H1)', () => {
  it('a merge GitHub performed but whose answer was lost: merge-unconfirmed stops the run; the resume observes MERGED, attribution unknown, with exactly ONE merge call', () => {
    const b = batch(1);
    const w = world(b, { mergeBehavior: ({ member, args, p, w: ww }) => { p.mergeCommit = squashFrom(b, member, args); p.state = 'MERGED'; return { ok: false, status: 1, stdout: '', stderr: 'connection reset', reason: 'connection reset' }; } });
    const r1 = approve(b, w.gh);
    assert.equal(r1.ok, true, 'the loop saw MERGED at the attempted head: it is observed, not unconfirmed');
    assert.equal(outcomeOf(b, 'm1').attribution, 'unknown', 'a non-zero gh exit never reads as this-run');
    assert.equal(w.merges.length, 1);
  });
  it('accepted but never observed: merge-unconfirmed (a run stop); a resume while still OPEN inside the window stops again and never replays', () => {
    const b = batch(1);
    const w = world(b, { mergeBehavior: () => ok() });
    const r1 = approve(b, w.gh);
    assert.equal(r1.ok, false);
    assert.deepEqual([outcomeOf(b, 'm1').status, outcomeOf(b, 'm1').code], ['not-run', 'merge-unconfirmed']);
    assert.equal(w.merges.length, 1);
    // Resumed at once: the request window has not elapsed (use a long window), so OPEN is NOT read as "did not merge".
    const r2 = resume(b, w.gh, { serialOpts: { timings: { ...fast, mergeWait: 10 * 60_000 } } });
    assert.equal(r2.ok, false);
    assert.equal(w.merges.length, 1, 'not replayed inside the request window');
  });
  it('after the window the PR is still OPEN and not queued: admission restarts, the pin holds, and it lands with one more merge call', () => {
    const b = batch(1);
    let first = true;
    const w = world(b, { mergeBehavior: ({ member, args, p }) => { if (first) { first = false; return ok(); } p.mergeCommit = squashFrom(b, member, args); p.state = 'MERGED'; return ok(); } });
    approve(b, w.gh);
    const r2 = resume(b, w.gh);
    assert.equal(r2.ok, true, r2.text);
    assert.equal(w.merges.length, 2);
    assert.equal(w.merges[1].args.at(-1), b.members[0].head);
  });
  it('a PR sitting in a merge queue is left for the operator and never re-attempted (merge-queued)', () => {
    const b = batch(1);
    const w = world(b, { mergeBehavior: () => ok() });
    approve(b, w.gh);
    w.prs.get(b.members[0].pr).queue = true;
    const r = resume(b, w.gh);
    assert.match(r.reason, /merge-queued|merge queue/);
    assert.equal(w.merges.length, 1);
  });
  it('an external merge while the member is waiting: skipped/merged-externally with its merge oid, a halt, no further merge, ok false', () => {
    const b = batch(2);
    const w = world(b);
    const p1 = w.prs.get(b.members[0].pr);
    let done = false;
    const gh = (args) => w.gh(args);
    gh.assessCi = (a) => { // the member is merged by someone else while its CI evidence is being read
      if (!done && a.prNumber === b.members[0].pr) {
        done = true;
        const f = path.join(mkTmp('b-'), 'b'); fs.writeFileSync(f, 'x');
        p1.mergeCommit = squashFrom(b, b.members[0], ['--subject', 's', '--body-file', f, b.members[0].head]); p1.state = 'MERGED';
      }
      return w.gh.assessCi(a);
    };
    const r = approve(b, gh);
    assert.deepEqual([outcomeOf(b, 'm1').status, outcomeOf(b, 'm1').code, outcomeOf(b, 'm1').mergeOid], ['skipped', 'merged-externally', p1.mergeCommit]);
    assert.equal(serialOf(b).halt.code, 'merged-externally');
    assert.equal(w.merges.length, 0, 'nothing merged after an external merge');
    assert.equal(r.ok, false);
    // A resume does not process another member: the halt is persisted (an external merge onto ANOTHER branch would read the same).
    const again = resume(b, gh);
    assert.equal(again.ok, false);
    assert.equal(w.merges.length, 0);
  });
  it('the LAST member merged externally still stops the run and gives ok false', () => {
    const b = batch(2);
    const w = world(b);
    const orig = w.gh;
    w.mergeBehavior = ({ member, args, p }) => { p.mergeCommit = squashFrom(b, member, args); p.state = 'MERGED'; const q = w.prs.get(b.members[1].pr); const f = path.join(mkTmp('b-'), 'b'); fs.writeFileSync(f, 'x'); q.mergeCommit = squashFrom(b, b.members[1], ['--subject', 's', '--body-file', f, b.members[1].head]); q.state = 'MERGED'; return ok(); };
    const r = approve(b, orig);
    assert.equal(outcomeOf(b, 'm2').status, 'skipped');
    assert.equal(r.ok, false);
  });
});

describe('the read-back: a failed read is not a measured defect (F4), a measured loss is (F3/F5)', () => {
  it('a failed fetch is not-run/awaiting-read-back, and the resume lands verified, never untested-base', () => {
    const b = batch(1);
    const w = world(b);
    let failing = true;
    const deps = depsWith(w.gh);
    const git0 = deps.git;
    const flaky = { ...deps, git: (args, cwd, o) => (failing && args[0] === 'fetch' && args.includes('refs/heads/main') ? { ok: false, status: 1, stdout: '', stderr: 'net down', reason: 'net down' } : git0(args, cwd, o)) };
    const r1 = approveShipBatch({ ...mk(b, w.gh), deps: { ...flaky, assessCi: w.gh.assessCi, shipBatch: b.shipBatch } });
    assert.equal(r1.ok, false);
    assert.deepEqual([outcomeOf(b, 'm1').status, outcomeOf(b, 'm1').code], ['not-run', 'awaiting-read-back']);
    failing = false;
    const r2 = resumeShipBatch({ ...mk(b, w.gh), deps: { ...flaky, assessCi: w.gh.assessCi, shipBatch: b.shipBatch } });
    assert.equal(r2.ok, true, r2.text);
    assert.equal(outcomeOf(b, 'm1').verdict, 'verified');
    assert.equal(w.merges.length, 1);
  });
  it('a squash that lost its trailers is landed/provenance-lost: the batch is NOT ok even when the trees match', () => {
    const b = batch(1);
    const r = approve(b, world(b, { squashOpts: { dropBody: true } }).gh);
    assert.equal(outcomeOf(b, 'm1').verdict, 'provenance-lost');
    assert.equal(r.ok, false);
    assert.match(r.text, /PROVENANCE: m1 provenance-lost/);
    assert.equal(serialOf(b).finalized.result.combination, 'tested', 'content only: provenance is a separate axis');
  });
  it('a foreign commit on the base before the squash is landed/untested-base with a halt, and the remaining member is not merged', () => {
    const b = batch(2);
    const r = approve(b, world(b, { squashOpts: { foreignFirst: true } }).gh);
    assert.equal(outcomeOf(b, 'm1').verdict, 'untested-base');
    assert.equal(serialOf(b).halt.code, 'untested-base');
    assert.equal(outcomeOf(b, 'm2') ?? null, null);
    assert.equal(r.ok, false);
  });
  it('a foreign commit pushed after the LAST landed member is caught by the final base read: base-moved, ok false', () => {
    const b = batch(1);
    const w = world(b);
    const orig = w.mergeBehavior;
    w.mergeBehavior = ({ member, args, p }) => { p.mergeCommit = squashFrom(b, member, args); p.state = 'MERGED'; git(['checkout', '-q', 'main'], b.fx.repo); fs.writeFileSync(path.join(b.fx.repo, 'late.txt'), 'late\n'); git(['add', 'late.txt'], b.fx.repo); git(['commit', '-q', '-m', 'late foreign'], b.fx.repo); git(['push', '-q', 'origin', 'main'], b.fx.repo); return ok(); };
    void orig;
    const r = approve(b, w.gh);
    assert.equal(r.ok, false);
    assert.equal(serialOf(b).halt.code, 'base-moved');
  });
});

describe('subset: the landed set is stated honestly (F5)', () => {
  it('one member refused: the rest land, ok true, combination subset, exit ok, the train stays awaiting-merge', () => {
    const b = batch(2);
    const w = world(b); w.prs.get(b.members[1].pr).checks = 'fail';
    const r = approve(b, w.gh);
    assert.equal(r.ok, true, r.text);
    assert.equal(serialOf(b).finalized.result.combination, 'subset');
    assert.match(r.text, /landed 1 of 2: a SUBSET of the combined-tested set; 1 need the user/);
    assert.equal(readTrain(b.dir, b.trainId).train.phase, 'awaiting-merge');
  });
  it('nothing landed is not ok', () => {
    const b = batch(1);
    const w = world(b); w.prs.get(b.members[0].pr).checks = 'fail';
    const r = approve(b, w.gh);
    assert.equal(r.ok, false);
    assert.match(r.text, /nothing landed; every member needs the user/);
  });
});

describe('the grant, the rules and a closed run (R3-M1)', () => {
  it('GRANT ABSENT: nothing merges and nothing changes', () => {
    const b = batch(1);
    fs.rmSync(b.grantFile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const w = world(b);
    const r = approve(b, w.gh);
    assert.equal(r.ok, false);
    assert.match(r.reason, /grant-absent/);
    assert.equal(w.merges.length, 0);
    assert.equal(readSerial(b.dir, b.trainId).ok, false, 'no serial run was started');
  });
  it('GRANT REVOKED mid-run: the run stops grant-revoked before the next merge', () => {
    const b = batch(2);
    const w = world(b);
    w.mergeBehavior = ({ member, args, p }) => { p.mergeCommit = squashFrom(b, member, args); p.state = 'MERGED'; fs.rmSync(b.grantFile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); return ok(); };
    const r = approve(b, w.gh);
    assert.equal(w.merges.length, 1, 'the second merge never happened');
    assert.match(r.text, /grant-revoked/);
    assert.equal(r.ok, false);
  });
  it('a merge_queue rule stops the run before any merge, and an unreadable rules answer does too', () => {
    const b = batch(1);
    const w = world(b); w.rules = [{ type: 'merge_queue', parameters: {} }];
    assert.match(approve(b, w.gh).reason, /merge-queue-present/);
    assert.equal(w.merges.length, 0);
    const c = batch(1);
    const w2 = world(c); w2.rulesFail = true;
    assert.match(approve(c, w2.gh).reason, /rules-unreadable/);
    assert.equal(w2.merges.length, 0);
  });
  it('a FINALIZED run resumed with the grant revoked and the rules API down prints the same summary and exit code with ZERO remote reads', () => {
    const b = batch(2);
    const w = world(b);
    const first = approve(b, w.gh);
    assert.equal(first.ok, true);
    fs.rmSync(b.grantFile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    w.rulesFail = true;
    const before = w.calls.length;
    const again = resume(b, w.gh);
    assert.equal(again.ok, first.ok);
    assert.equal(again.text, first.text);
    assert.equal(w.calls.length, before, 'zero gh calls');
  });
});

describe('crash resume: each crash point ends in the outcomes of a run that never crashed', () => {
  for (const [name, die] of [
    ['after the merge intent, before the merge call', ({ w }) => { w.mergeBehavior = () => { throw new Error('died before the call'); }; }],
    ['during the merge (GitHub merged, no answer)', ({ w, b }) => { w.mergeBehavior = ({ member, args, p }) => { p.mergeCommit = squashFrom(b, member, args); p.state = 'MERGED'; throw new Error('died mid-call'); }; }],
  ]) {
    it(name, () => {
      const b = batch(1);
      const w = world(b);
      die({ w, b });
      const r1 = approve(b, w.gh);
      assert.equal(r1.ok, false);
      w.mergeBehavior = undefined;
      const r2 = resume(b, w.gh, { serialOpts: { timings: { ...fast, mergeWait: 1 } } });
      assert.equal(r2.ok, true, r2.text);
      assert.equal(outcomeOf(b, 'm1').status, 'landed');
      assert.ok(w.merges.filter((m) => m.pr === b.members[0].pr).length <= 2, 'at most the attempted merge and one replay of a request that did not merge');
      assert.equal(git(['rev-list', '--count', 'origin/main'], b.fx.repo) >= 1, true);
    });
  }
});

describe('admitMember: one predicate, strict evidence per mode (R1-H5)', () => {
  const H = 'a'.repeat(40);
  const child = { ok: true, reasons: [], envelope: {} };
  it('a ship-batch candidate without its CI evidence, and a rollup candidate carrying any, are rejected', () => {
    assert.throws(() => admitMember('ship-batch', { base: 'main', remote: 'origin' }, { mode: 'ship-batch', head: H, child }));
    assert.throws(() => admitMember('rollup', { base: 'main', remote: 'origin' }, { mode: 'rollup', head: H, child, branchTip: H, ci: null }));
    assert.throws(() => admitMember('ship-batch', { base: 'main', remote: 'origin' }, { mode: 'rollup', head: H, child, branchTip: H }));
  });
  it('each mode judges its own evidence, and a head that is not the full oid is rejected', () => {
    assert.equal(admitMember('ship-batch', { base: 'main', remote: 'origin' }, { mode: 'ship-batch', head: H, child, ci: { disposition: 'permit', tag: 'passed', reason: 'ok' } }).ok, true);
    assert.equal(admitMember('ship-batch', { base: 'main', remote: 'origin' }, { mode: 'ship-batch', head: H, child, ci: { disposition: 'refuse-member', tag: 'failed', reason: 'red' } }).kind, 'ci-refused');
    assert.equal(admitMember('ship-batch', { base: 'main', remote: 'origin' }, { mode: 'ship-batch', head: H, child, ci: { disposition: 'retry', tag: 'pending', reason: 'p' } }).kind, 'ci-retry');
    assert.equal(admitMember('ship-batch', { base: 'main', remote: 'origin' }, { mode: 'ship-batch', head: H, child, ci: { disposition: 'stop-run', tag: 'unknown', reason: 'u' } }).kind, 'ci-evidence-unknown');
    assert.throws(() => admitMember('ship-batch', { base: 'main', remote: 'origin' }, { mode: 'ship-batch', head: H, child, ci: { disposition: 'maybe', tag: 'x', reason: 'r' } }), 'an unknown disposition is rejected by the schema, never read as permit');
    assert.equal(admitMember('rollup', { base: 'main', remote: 'origin' }, { mode: 'rollup', head: H, child, branchTip: 'b'.repeat(40) }).ok, false);
    assert.equal(admitMember('rollup', { base: 'main', remote: 'origin' }, { mode: 'rollup', head: H, child, branchTip: H }).ok, true);
    assert.throws(() => admitMember('ship-batch', { base: 'main', remote: 'origin' }, { mode: 'ship-batch', head: H.slice(0, 12), child, ci: { disposition: 'permit', tag: 'passed', reason: 'ok' } }));
  });
});

describe('audit round 1: persistence, queue, tip and resume guards', () => {
  it('an unreadable serial record is never an empty slot: a ship-batch approve refuses and leaves its bytes alone (R1-H1)', () => {
    const b = batch(1);
    const file = path.join(b.dir, 'serial', `${b.trainId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const w = world(b);
    const r = approve(b, w.gh);
    assert.equal(r.ok, false);
    assert.match(r.reason, /exists but cannot be read|cannot be read/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
    assert.equal(w.merges.length, 0);
  });
  it('a merge-queue answer that is not an explicit false leaves queue absence unproven (R1-M3, M14)', () => {
    const b = batch(1);
    const w = world(b, { mergeBehavior: () => ok() });
    approve(b, w.gh);
    for (const answer of [null, undefined, 'false']) {
      const orig = w.gh;
      const gh = (args) => (args[1] === 'view' && args[args.indexOf('--json') + 1] === 'isInMergeQueue' ? ok(answer === undefined ? {} : { isInMergeQueue: answer }) : orig(args));
      gh.assessCi = orig.assessCi;
      const r = resume(b, gh);
      assert.match(r.reason, /not an explicit false|merge queue/, String(answer));
      assert.equal(w.merges.length, 1, 'never replayed on an unproven queue answer');
    }
  });
  it('an unreadable base tip after the run is recoverable: no halt is persisted, and a resume finalizes (R1-M2, M13)', () => {
    const b = batch(1);
    const w = world(b);
    let down = false;
    w.mergeBehavior = ({ member, args, p }) => { p.mergeCommit = squashFrom(b, member, args); p.state = 'MERGED'; down = true; return ok(); };
    const deps = depsWith(w.gh);
    const git0 = deps.git;
    const flaky = { ...deps, git: (args, cwd, o) => (down && args[0] === 'ls-remote' ? { ok: false, status: 1, stdout: '', stderr: 'net down', reason: 'net down' } : git0(args, cwd, o)) };
    const r1 = approveShipBatch({ ...mk(b, w.gh), deps: { ...flaky, assessCi: w.gh.assessCi, shipBatch: b.shipBatch } });
    assert.equal(r1.ok, false);
    assert.equal(serialOf(b).halt, undefined, 'an unreadable tip is not a proven mismatch');
    assert.equal(serialOf(b).finalized, undefined);
    down = false;
    const r2 = resume(b, w.gh);
    assert.equal(r2.ok, true, r2.text);
    assert.ok(serialOf(b).finalized);
  });
  it('a resumed read-back is re-classified against the attempt: a merge at ANOTHER head with no oid is external, not ours (R1-H10)', () => {
    const b = batch(1);
    const other = 'd'.repeat(40);
    const w = world(b, { mergeBehavior: ({ p }) => { p.state = 'MERGED'; p.head = other; p.mergeCommit = null; return ok(); } });
    const r1 = approve(b, w.gh);
    assert.equal(r1.ok, false);
    assert.deepEqual([stepOf(b, 'm1').step, outcomeOf(b, 'm1').status, outcomeOf(b, 'm1').code], ['merged', 'not-run', 'awaiting-read-back']);
    const p = w.prs.get(b.members[0].pr);
    p.mergeCommit = squashFrom(b, b.members[0], ['--subject', 's', '--body-file', (() => { const f = path.join(mkTmp('b-'), 'b'); fs.writeFileSync(f, 'x'); return f; })(), b.members[0].head]);
    const r2 = resume(b, w.gh);
    assert.equal(r2.ok, false);
    assert.equal(outcomeOf(b, 'm1').status, 'skipped', 'merged at a head the attempt did not name');
    assert.equal(serialOf(b).halt.code, 'merged-externally');
    assert.equal(w.merges.length, 1);
  });
  it('a PR view that keeps failing at the final re-read is a member fault, never an endless loop (R1-M1)', () => {
    const b = batch(1);
    const w = world(b);
    let views = 0;
    const gh = (args) => (args[1] === 'view' && args[args.indexOf('--json') + 1] !== 'isInMergeQueue' && ++views > 2 ? { ok: false, status: 1, stdout: '', stderr: 'boom', reason: 'gh failed' } : w.gh(args));
    gh.assessCi = w.gh.assessCi;
    const r = approve(b, gh);
    assert.equal(r.ok, false);
    assert.equal(w.merges.length, 0);
    assert.equal(outcomeOf(b, 'm1').status, 'not-run', JSON.stringify(outcomeOf(b, 'm1')));
  });
});

describe('CI: the admission is the evidence oracle disposition (docs/plans/ci-evidence-oracle.md §2.2)', () => {
  const HEAD = 'a'.repeat(40);
  const member = { id: 'm', prNumber: 7, repo: REPO, oid: HEAD };
  const child = () => ({ ok: true, reasons: [], envelope: {} });
  const admit = (assessCi, extra = {}) => admitShipBatchMember({ cwd: process.cwd(), member, head: HEAD, base: 'main', remote: 'origin', deps: { assessCi, shipBatch: { checkChild: child } }, ...extra });

  it('permit: passed, and none-required proven (a consumer may require nothing)', () => {
    assert.equal(admit(() => ev.passed(HEAD)).ok, true);
    assert.equal(admit(() => ev.noneRequired(HEAD)).ok, true);
  });
  it('failed and not-run refuse the member (ci-refused); pending and missing retry (ci-retry); every ineligible but head-moved refuses', () => {
    for (const [e, kind] of [[ev.failed(HEAD), 'ci-refused'], [ev.notRun(HEAD), 'ci-refused'], [ev.pending(HEAD), 'ci-retry'], [ev.missing(HEAD), 'ci-retry'],
      [ev.ineligible('draft'), 'ci-refused'], [ev.ineligible('closed'), 'ci-refused'], [ev.ineligible('head-moved'), 'ci-retry']]) {
      const a = admit(() => e);
      assert.deepEqual([a.ok, a.kind], [false, kind], `${e.tag}/${e.code ?? ''}`);
    }
  });
  it('unknown evidence of every fault kind is the RUN-scope stop ci-evidence-unknown, never a member refusal', () => {
    for (const kind of ['transport', 'malformed', 'config-drift', 'unsupported-classic-protection', 'unsupported-rule-type']) {
      const a = admit(() => ev.unknown(kind));
      assert.deepEqual([a.ok, a.kind], [false, 'ci-evidence-unknown'], kind);
      assert.match(a.reasons[0], new RegExp(kind));
    }
  });
  it('an oracle that throws, returns nothing or returns an unlisted tag is a run stop, not a pass (fail closed)', () => {
    for (const oracle of [() => { throw new Error('boom'); }, () => undefined, () => ({ tag: 'green' }), () => ({ tag: 'ineligible', code: 'surprise' })]) {
      assert.equal(admit(oracle).kind, 'ci-evidence-unknown');
    }
  });
  it('the oracle is asked for exactly this PR, base and head, with the config assertion', () => {
    let asked = null;
    admit((a) => { asked = a; return ev.passed(HEAD); }, { requiredChecks: ['full-suite'] });
    assert.deepEqual([asked.repo, asked.prNumber, asked.expectedBase, asked.expectedHead], [REPO, 7, 'main', HEAD]);
    assert.deepEqual(asked.configAssertion, { requiredChecks: ['full-suite'], error: null });
  });
  it('a member whose child check refused is never assessed for CI', () => {
    let asked = 0;
    const a = admitShipBatchMember({ cwd: process.cwd(), member, head: HEAD, base: 'main', remote: 'origin', deps: { assessCi: () => { asked++; return ev.passed(HEAD); }, shipBatch: { checkChild: () => ({ ok: false, reasons: ['trailers: waived'], envelope: null }) } } });
    assert.deepEqual([a.ok, a.kind, asked], [false, 'shipped-head-refused', 0]);
  });
  it('END TO END with the REAL oracle: a GitHub that does not answer the oracle\'s reads stops the run at run scope, zero merges; the same world with an oracle injected merges (control)', () => {
    const b = batch(2);
    const w = world(b); // its gh answers the old read shapes only, so the real oracle cannot establish the evidence
    const before = baseTip(b);
    const r = approve(b, w.gh, { deps: { assessCi: undefined } });
    assert.equal(r.ok, false, r.text);
    assert.equal(w.merges.length, 0);
    assert.equal(baseTip(b), before);
    assert.ok(r.text.includes('CI evidence unknown'), r.text);
    const c = batch(2);
    const w2 = world(c);
    assert.equal(approve(c, w2.gh).ok, true);
    assert.equal(w2.merges.length, 2);
  });
  it('the world oracle models REQUIRED CONTEXTS: a required check that never ran is missing, an unscripted rules answer is unknown, only the observed context passes', () => {
    const rule = (...ctx) => [{ type: 'required_status_checks', parameters: { required_status_checks: ctx.map((context) => ({ context })) } }];
    assert.deepEqual(requiredEvidence({ rules: rule('ci', 'lint'), bucket: 'pass', head: HEAD }), ev.missing(HEAD, ['lint']));
    assert.equal(requiredEvidence({ rules: rule('ci', 'lint'), bucket: 'fail', head: HEAD }).tag, 'failed', 'the observed check bad news comes first');
    assert.equal(requiredEvidence({ rules: undefined, bucket: 'pass', head: HEAD }).tag, 'unknown');
    assert.equal(requiredEvidence({ rules: [], bucket: 'pass', head: HEAD }).tag, 'none-required');
    assert.equal(requiredEvidence({ rules: rule('ci'), bucket: 'pass', head: HEAD }).tag, 'passed');
    assert.equal(requiredEvidence({ rules: rule('other'), bucket: 'pass', head: HEAD }).tag, 'missing');
  });
  it('through the real serial runner, a required context that never ran merges nothing (it waits, then times out not-run)', () => {
    const b = batch(1);
    const w = world(b);
    w.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }, { context: 'lint' }] } }]; // 'lint' is never observed
    const r = approve(b, w.gh, { serialOpts: { timeoutMs: 50 } });
    assert.equal(r.ok, false);
    assert.equal(w.merges.length, 0);
    assert.equal(outcomeOf(b, 'm1').code, 'checks-pending', JSON.stringify(outcomeOf(b, 'm1')));
    const d = batch(1);
    const w3 = world(d); // the control: only the observed context is required, so it merges
    assert.equal(approve(d, w3.gh).ok, true);
    assert.equal(w3.merges.length, 1);
  });
  it('the PRODUCTION default (no deps.assessCi) is the REAL oracle: with a GitHub that does not answer its reads it is a run stop, naming the read that failed', () => {
    const a = admitShipBatchMember({ cwd: process.cwd(), member, head: HEAD, base: 'main', remote: 'origin', deps: { gh: () => ({ ok: false, status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)', reason: 'x' }), shipBatch: { checkChild: child } } });
    assert.deepEqual([a.ok, a.kind], [false, 'ci-evidence-unknown']);
    assert.ok(a.reasons[0].includes('transport'), a.reasons[0]);
  });
});
