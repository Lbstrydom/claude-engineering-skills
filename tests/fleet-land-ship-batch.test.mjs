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
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots } from './helpers/fleet-repo.mjs';
import { PR, REPO, ok, view, fast, depsWith, trainFx, scriptedGh } from './helpers/fleet-serial-fx.mjs';
import { readTrain } from '../scripts/lib/fleet/registry.mjs';
import { CANONICAL_GRANT } from '../scripts/lib/fleet/coordinator-grant.mjs';
import { resolveConfig } from '../scripts/lib/fleet/config.mjs';
import {
  splitCommitMessage, aiTrailerMultiset, readBackReasons, runShippedHeadChild, partitionMembers, buildShipBatch,
  approveShipBatch, resumeShipBatch, readShipBatch, writeShipBatch, SHIP_BATCH_SCHEMA, CHILD_SCHEMA,
} from '../scripts/lib/fleet/ship-batch.mjs';
import { approveSerial, resumeSerial } from '../scripts/lib/fleet/serial.mjs';

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
  const ghAllGreen = (members) => (args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      const n = Number(args[2]); const m = members.find((x) => x.prNumber === n);
      return ok({ state: 'OPEN', isDraft: false, headRefOid: m.oid, baseRefName: 'main' });
    }
    if (args[0] === 'api') return { ok: true, status: 0, stdout: JSON.stringify(/rules\/branches/.test(args[1]) ? [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }] : { protected: false }), stderr: '' };
    if (args[0] === 'pr' && args[1] === 'checks') return { ok: true, status: 0, stdout: JSON.stringify([{ name: 'ci', bucket: 'pass', state: 'SUCCESS', completedAt: '2026-10-09T10:00:00Z' }]), stderr: '' };
    return { ok: false, status: 1, stdout: '', stderr: 'unexpected', reason: 'unexpected' };
  };
  const run = (members, over = {}) => partitionMembers({
    cwd: process.cwd(), members, base: 'main', deps: { gh: over.gh ?? ghAllGreen(members) },
    checkChild: over.checkChild ?? childByWt({}), requiredChecks: undefined, ciFn: over.ciFn ?? (() => ({ verdict: 'full' })),
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
  it('a PR whose head is not the ready oid (C9) is needs-user', () => {
    const ms = [pr('a1')];
    const gh = (args) => (args[1] === 'view' ? ok({ state: 'OPEN', isDraft: false, headRefOid: 'f'.repeat(40), baseRefName: 'main' }) : ghAllGreen(ms)(args));
    const r = run(ms, { gh });
    assert.match(r.needsUser[0].reasons.join(' '), /identity: PR #\d+ head/);
  });
  it('a draft PR and a closed PR are needs-user', () => {
    const ms = [pr('a1')];
    const mk = (over) => (args) => (args[1] === 'view' ? ok({ state: 'OPEN', isDraft: false, headRefOid: ms[0].oid, baseRefName: 'main', ...over }) : ghAllGreen(ms)(args));
    assert.match(run(ms, { gh: mk({ isDraft: true }) }).needsUser[0].reasons.join(' '), /draft/);
    assert.match(run(ms, { gh: mk({ state: 'CLOSED' }) }).needsUser[0].reasons.join(' '), /CLOSED/);
  });
  it('required checks that are not green (C8) are needs-user', () => {
    const ms = [pr('a1')];
    const gh = (args) => (args[1] === 'checks' ? { ok: false, status: 8, stdout: JSON.stringify([{ name: 'ci', bucket: 'fail', state: 'FAILURE', completedAt: '2026-10-09T10:00:00Z' }]), stderr: '' } : ghAllGreen(ms)(args));
    assert.match(run(ms, { gh }).needsUser[0].reasons.join(' '), /ci: required checks/);
  });
  it('a declared full-suite workflow that is not `full` is needs-user; an UNDECLARED one is nothing to measure', () => {
    const ms = [pr('a1')];
    assert.match(run(ms, { ciFn: () => ({ verdict: 'pending', reason: 'queued' }) }).needsUser[0].reasons.join(' '), /full-suite run is pending/);
    assert.match(run(ms, { ciFn: () => ({ verdict: 'unverified', reason: 'no ciVerdict workflow is declared in .test-tiers.json on main' }) }).ok[0].id, /a1/);
    assert.match(run(ms, { ciFn: () => ({ verdict: 'unverified', reason: 'the Actions runs could not be read' }) }).needsUser[0].reasons.join(' '), /unverified/);
  });
});

// ---- the repo-backed layers ----------------------------------------------------------------------------------------------------
const fleetDirOf = (repo) => path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo), 'fleet');

/** A built pr-mode train for one member, a sidecar for it, a valid grant file and deps that carry both. */
function batchFx(over = {}) {
  const { fx, tested, trainId } = trainFx({ message: over.message ?? MSG });
  const dir = fleetDirOf(fx.repo);
  const t = readTrain(dir, trainId).train;
  const grantFile = path.join(mkTmp('grant-'), 'CLAUDE.md');
  fs.writeFileSync(grantFile, `# rules\n\n${CANONICAL_GRANT.replace('Since <DATE>:', 'Since 2026-11-18:')}\n`);
  const childCalls = [];
  const ciCalls = [];
  const shipBatch = {
    grantFile,
    checkChild: (a) => { childCalls.push(a); return over.child ? over.child(a) : { ok: true, reasons: [], envelope: {} }; },
    // The full-suite verdict `.test-tiers.json` declares; a test flips it to prove it is re-judged at merge time.
    ciVerdict: (a) => { ciCalls.push(a); return over.ci ? over.ci(a) : { verdict: 'full' }; },
  };
  writeShipBatch(dir, {
    schemaVersion: SHIP_BATCH_SCHEMA, trainId, grantVersion: 'v1', checkedAt: new Date().toISOString(), base: 'main',
    remote: t.destination.remote, expectedTip: t.destination.expectedOid,
    members: [{ id: 'feat', prNumber: PR, repo: REPO, oid: tested, worktree: fx.repo, state: 'pending', mergeOid: null, note: null }], excluded: [],
  });
  return { fx, tested, trainId, dir, grantFile, shipBatch, childCalls, t, member: () => readShipBatch(dir, trainId).batch.members[0], batch: () => readShipBatch(dir, trainId).batch };
}

/** What GitHub would do for `gh pr merge --subject S --body-file F`: a real commit on origin/main carrying that message. */
function squashFrom(fx, args, { foreignFirst = false, dropBody = false } = {}) {
  const subject = args[args.indexOf('--subject') + 1];
  const body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
  git(['checkout', '-q', 'main'], fx.repo);
  if (foreignFirst) { fs.writeFileSync(path.join(fx.repo, 'foreign.txt'), 'someone else landed\n'); git(['add', 'foreign.txt'], fx.repo); git(['commit', '-q', '-m', 'foreign'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo); }
  const msgFile = path.join(mkTmp('squash-'), 'msg');
  fs.writeFileSync(msgFile, `${subject} (#${PR})\n\n${dropBody ? 'trailers dropped' : body}\n`);
  git(['commit', '--allow-empty', '-q', '-F', msgFile], fx.repo);
  git(['push', '-q', 'origin', 'main'], fx.repo);
  return git(['rev-parse', 'HEAD'], fx.repo);
}

/** A scripted gh over a batch fixture: OPEN until the merge, then MERGED at the squash the callback made. */
function ghFor(b, { mergeOpts = {}, onBeforeMerge, mergeStateStatus = 'CLEAN', stayOpen = false, mergedFrom = null } = {}) {
  let squash = mergedFrom; const merges = [];
  const { gh, calls } = scriptedGh({
    views: () => (squash && !stayOpen ? view(b.tested, { state: 'MERGED', mergeCommit: { oid: squash } }) : view(b.tested, { mergeStateStatus })),
    onMerge: (args) => { merges.push(args); onBeforeMerge?.(args); squash = squashFrom(b.fx, args, mergeOpts); return ok(); },
  });
  return { gh, calls, merges, squash: () => squash };
}
const approve = (b, gh, extra = {}) => approveShipBatch({ cwd: b.fx.repo, dir: b.dir, trainId: b.trainId, deps: { ...depsWith(gh), shipBatch: b.shipBatch, ...extra.deps }, serialOpts: { sleep: () => {}, timings: fast, timeoutMs: 60_000 } });
const resume = (b, gh, extra = {}) => resumeShipBatch({ cwd: b.fx.repo, dir: b.dir, trainId: b.trainId, deps: { ...depsWith(gh), shipBatch: b.shipBatch, ...extra.deps }, serialOpts: { sleep: () => {}, timings: fast } });

describe('approveShipBatch: the merge, on the real serial runner', () => {
  it('lands a verified member with ITS OWN message: the emitted merge argv carries --subject and the body file, and the read-back verifies', () => {
    const b = batchFx();
    const g = ghFor(b);
    const r = approve(b, g.gh);
    assert.equal(r.ok, true, r.text);
    const merge = g.merges[0];
    assert.equal(merge[merge.indexOf('--subject') + 1], 'feat: the thing');
    assert.equal(merge.at(-2), '--match-head-commit');
    assert.equal(merge.at(-1), b.tested, 'the head bind stays last');
    assert.equal(b.member().state, 'verified');
    assert.equal(b.member().mergeOid, g.squash());
    assert.equal(b.batch().expectedTip, g.squash(), 'the recorded base progression advanced to the squash');
    assert.match(r.text, /verified\s+feat/);
    // The trailers are read back from the commit on the base, not from what was sent.
    const landed = git(['log', '-1', '--format=%B', g.squash()], b.fx.repo);
    assert.deepEqual(aiTrailerMultiset(landed), aiTrailerMultiset(MSG));
  });

  it('the child was re-run on the exact head immediately before the merge', () => {
    const b = batchFx();
    approve(b, ghFor(b).gh);
    assert.ok(b.childCalls.length >= 1);
    assert.equal(b.childCalls[0].head, b.tested);
    assert.equal(b.childCalls[0].worktree, b.fx.repo);
  });

  it('GRANT ABSENT: nothing merges, nothing is built or changed', () => {
    const b = batchFx();
    fs.rmSync(b.grantFile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const g = ghFor(b);
    const r = approve(b, g.gh);
    assert.equal(r.ok, false);
    assert.match(r.reason, /grant-absent/);
    assert.equal(g.merges.length, 0);
    assert.equal(b.member().state, 'pending');
  });

  it('GRANT MISMATCH (narrowed): refuses with grant-mismatch', () => {
    const b = batchFx();
    fs.writeFileSync(b.grantFile, `${CANONICAL_GRANT.replace('- never `--no-verify` in wine-cellar-app;\n', '')}\n`);
    const r = approve(b, ghFor(b).gh);
    assert.match(r.reason, /grant-mismatch/);
  });

  it('GRANT REVOKED between approval and the merge: the run stops with grant-revoked and merges nothing', () => {
    const b = batchFx();
    let n = 0;
    const g = ghFor(b, { onBeforeMerge: () => {} });
    // Revoke at the first PR view after approval started (the serial loop reads the PR before it asks for the message).
    const gh = (args) => { if (args[0] === 'pr' && args[1] === 'view' && n++ === 1) fs.rmSync(b.grantFile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); return g.gh(args); };
    const r = approve(b, gh);
    assert.equal(r.ok, false);
    assert.match(r.reason, /grant-revoked/);
    assert.equal(g.merges.length, 0, 'revoked before the merge: no merge call');
    assert.equal(b.member().state, 'pending');
  });

  it('a commit lands on the base between build and merge: base-moved, no merge', () => {
    const b = batchFx();
    git(['checkout', '-q', 'main'], b.fx.repo);
    fs.writeFileSync(path.join(b.fx.repo, 'meanwhile.txt'), 'x\n'); git(['add', 'meanwhile.txt'], b.fx.repo); git(['commit', '-q', '-m', 'meanwhile'], b.fx.repo); git(['push', '-q', 'origin', 'main'], b.fx.repo);
    const g = ghFor(b);
    const r = approve(b, g.gh);
    assert.equal(r.ok, false);
    assert.match(r.reason, /base-moved|recorded fact changed/);
    assert.equal(g.merges.length, 0);
  });

  it('a commit lands on the base DURING the run (after approval verified it): the per-merge base-tip check stops it, no merge', () => {
    // The check before the approval is the existing train check; this is the seam this module owns: the window between them.
    const b = batchFx();
    const g = ghFor(b);
    let n = 0;
    const gh = (args) => {
      if (args[0] === 'pr' && args[1] === 'view' && n++ === 0) {
        git(['checkout', '-q', 'main'], b.fx.repo);
        fs.writeFileSync(path.join(b.fx.repo, 'during.txt'), 'x\n'); git(['add', 'during.txt'], b.fx.repo); git(['commit', '-q', '-m', 'during'], b.fx.repo); git(['push', '-q', 'origin', 'main'], b.fx.repo);
      }
      return g.gh(args);
    };
    const r = approve(b, gh);
    assert.equal(r.ok, false);
    assert.match(r.reason, /base-moved: the base is/);
    assert.equal(g.merges.length, 0);
    assert.equal(b.member().state, 'pending');
  });

  it('the child refuses at merge time (the chip worktree vanished, say): needs-user, no merge', () => {
    const b = batchFx({ child: () => ({ ok: false, reasons: ['evidence-unavailable: the chip worktree is gone'], envelope: null }) });
    const g = ghFor(b);
    const r = approve(b, g.gh);
    assert.equal(r.ok, false, 'nothing landed, so the batch is not ok');
    assert.match(r.text, /needs-user.*evidence-unavailable/);
    assert.equal(g.merges.length, 0);
    assert.equal(b.member().state, 'needs-user');
  });

  it('a member BEHIND the base is never updated on the remote: it stops with behind-base and NO update-branch call is made', () => {
    const b = batchFx();
    const g = ghFor(b, { mergeStateStatus: 'BEHIND' });
    const r = approve(b, g.gh);
    assert.equal(r.ok, false, 'nothing landed, so the batch is not ok');
    assert.match(r.text, /behind-base/);
    assert.equal(g.calls.some((c) => c[0] === 'api' && c.includes('PUT')), false, 'no update-branch');
    assert.equal(g.merges.length, 0);
    assert.equal(b.member().state, 'needs-user');
  });

  it('a foreign commit lands in the merge window: landed-on-untested-base, the batch stops and the result is NOT ok', () => {
    const b = batchFx();
    const g = ghFor(b, { mergeOpts: { foreignFirst: true } });
    const r = approve(b, g.gh);
    assert.equal(r.ok, false);
    assert.equal(b.member().state, 'landed-on-untested-base');
    assert.match(r.text, /landed-on-untested-base/);
    assert.notEqual(b.batch().expectedTip, g.squash(), 'the base progression does not advance past an untested base');
  });

  it('a squash that LOST the trailers: provenance-lost, loud, the result is not ok, and the progression still advances', () => {
    const b = batchFx();
    const g = ghFor(b, { mergeOpts: { dropBody: true } });
    const r = approve(b, g.gh);
    assert.equal(r.ok, false);
    assert.equal(b.member().state, 'provenance-lost');
    assert.match(r.reason, /provenance: feat provenance-lost/);
    assert.match(r.text, /provenance-lost/);
    assert.equal(b.batch().expectedTip, g.squash());
  });

  it('the full-suite verdict is re-judged AT MERGE TIME: a verdict that flips after the build is needs-user, no merge', () => {
    const b = batchFx({ ci: () => ({ verdict: 'pending', reason: 'queued after the build' }) });
    const g = ghFor(b);
    const r = approve(b, g.gh);
    assert.equal(r.ok, false);
    assert.match(r.text, /full-suite run is pending/);
    assert.equal(g.merges.length, 0);
    assert.equal(b.member().state, 'needs-user');
  });

  it('a run with a ship-batch record cannot be driven by ANOTHER tool\'s messageFor (no read-back, no no-update rule)', () => {
    const b = batchFx();
    const g1 = ghFor(b, { stayOpen: true });
    approve(b, g1.gh); // leaves a serial run behind
    const g2 = ghFor(b, { mergedFrom: g1.squash() });
    const r = resumeSerial({ cwd: b.fx.repo, trainId: b.trainId, deps: depsWith(g2.gh), sleep: () => {}, timings: fast, messageFor: () => ({ subject: 'x', body: '' }) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /belongs to a ship-batch/);
    assert.equal(g2.merges.length, 0);
  });

  it('a rev-list that FAILED after the merge is retryable (state merged), never a confirmed landed-on-untested-base', () => {
    const b = batchFx();
    const g = ghFor(b);
    let fail = true;
    const base = depsWith(g.gh);
    const deps = { ...base, git: (args, cwd, o) => (fail && args[0] === 'rev-list' && args.includes('--parents') ? { ok: false, status: 1, stdout: '', stderr: 'boom', reason: 'rev-list boom' } : base.git(args, cwd, o)) };
    const r1 = approveShipBatch({ cwd: b.fx.repo, dir: b.dir, trainId: b.trainId, deps: { ...deps, shipBatch: b.shipBatch }, serialOpts: { sleep: () => {}, timings: fast, timeoutMs: 60_000 } });
    assert.equal(r1.ok, false);
    assert.equal(b.member().state, 'merged', 'not terminal: the read could not be done');
    fail = false;
    const r2 = resume(b, g.gh);
    assert.equal(r2.ok, true, r2.text);
    assert.equal(b.member().state, 'verified');
  });

  it('a commit message that could not be READ after the merge is retryable, not provenance-lost', () => {
    const b = batchFx();
    const g = ghFor(b);
    let fail = true;
    const base = depsWith(g.gh);
    const deps = { ...base, git: (args, cwd, o) => (fail && args[0] === 'log' && args.includes('--format=%B') && args.at(-1) === g.squash() ? { ok: false, status: 1, stdout: '', stderr: '', reason: 'cannot read' } : base.git(args, cwd, o)) };
    // the squash oid is only known once the merge ran: the wrapper compares lazily
    const r1 = approveShipBatch({ cwd: b.fx.repo, dir: b.dir, trainId: b.trainId, deps: { ...deps, shipBatch: b.shipBatch }, serialOpts: { sleep: () => {}, timings: fast, timeoutMs: 60_000 } });
    assert.equal(r1.ok, false);
    assert.equal(b.member().state, 'merged');
    fail = false;
    assert.equal(resume(b, g.gh).ok, true);
    assert.equal(b.member().state, 'verified');
  });

  it('a sidecar that is not about THIS train is refused before any merge', () => {
    const b = batchFx();
    const rec = readShipBatch(b.dir, b.trainId).batch;
    writeShipBatch(b.dir, { ...rec, members: [{ ...rec.members[0], oid: 'f'.repeat(40) }] });
    const g = ghFor(b);
    const r = approve(b, g.gh);
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not describe train/);
    assert.equal(g.merges.length, 0);
  });

  it('a sidecar with an invalid member is unreadable (field-level validation), not trusted', () => {
    const b = batchFx();
    const rec = readShipBatch(b.dir, b.trainId).batch;
    for (const bad of [{ state: 'launched' }, { oid: 'nope' }, { prNumber: 0 }, { id: '' }]) {
      writeShipBatch(b.dir, { ...rec, members: [{ ...rec.members[0], ...bad }] });
      const r = readShipBatch(b.dir, b.trainId);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.match(r.reason, /invalid/);
    }
    writeShipBatch(b.dir, { ...rec, expectedTip: 'not-a-sha' });
    assert.equal(readShipBatch(b.dir, b.trainId).ok, false);
  });

  it('an unknown train (no sidecar) is refused: a plain train cannot borrow the grant', () => {
    const b = batchFx();
    fs.rmSync(path.join(b.dir, 'shipbatch', `${b.trainId}.json`), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const r = approve(b, ghFor(b).gh);
    assert.equal(r.ok, false);
    assert.match(r.reason, /not a ship-batch train/);
  });
});

describe('resume: an interrupted merge is reconciled from GitHub, never repeated and never skipped', () => {
  it('GitHub merged but the run lost the record: the resume ADOPTS the merge, verifies it and does not merge twice', () => {
    const b = batchFx();
    // Run 1: the merge is accepted (a real squash exists) but the PR keeps reading OPEN, so the run stops "not observed merged".
    const g1 = ghFor(b, { stayOpen: true });
    const r1 = approve(b, g1.gh);
    assert.equal(r1.ok, false);
    assert.equal(b.member().state, 'merge-requested', 'the intent was recorded before the merge call');
    // Run 2: GitHub now reports MERGED at that squash.
    const g2 = ghFor(b, { mergedFrom: g1.squash() });
    const r2 = resume(b, g2.gh);
    assert.equal(r2.ok, true, r2.text);
    assert.equal(g2.merges.length, 0, 'the already-merged member is observed, never merged again');
    assert.equal(b.member().state, 'verified');
    assert.equal(b.batch().expectedTip, g1.squash(), 'its own unrecorded merge never reads as base-moved');
  });

  it('merged but the read-back could not finish (base unfetchable): the run stops, and the resume reads it back instead of skipping it', () => {
    const b = batchFx();
    const g = ghFor(b);
    let failFetch = true;
    const base = depsWith(g.gh);
    const deps = { ...base, git: (args, cwd, o) => (failFetch && args[0] === 'fetch' && args.includes('refs/heads/main') ? { ok: false, status: 1, stdout: '', stderr: 'offline', reason: 'offline' } : base.git(args, cwd, o)) };
    const r1 = approveShipBatch({ cwd: b.fx.repo, dir: b.dir, trainId: b.trainId, deps: { ...deps, shipBatch: b.shipBatch }, serialOpts: { sleep: () => {}, timings: fast, timeoutMs: 60_000 } });
    assert.equal(r1.ok, false);
    assert.equal(b.member().state, 'merged', 'merged is recorded, verified is not');
    failFetch = false;
    const r2 = resume(b, g.gh);
    assert.equal(r2.ok, true, r2.text);
    assert.equal(b.member().state, 'verified');
    assert.equal(g.merges.length, 1, 'one merge in total');
  });

  it('a foreign commit between the interrupted run and the resume is base-moved for the NEXT merge, not silently accepted', () => {
    const b = batchFx();
    const g1 = ghFor(b, { stayOpen: true });
    approve(b, g1.gh);
    // A commit that is not this batch's lands on top of the squash, then the member is reported unmerged again.
    git(['checkout', '-q', 'main'], b.fx.repo);
    fs.writeFileSync(path.join(b.fx.repo, 'foreign2.txt'), 'x\n'); git(['add', 'foreign2.txt'], b.fx.repo); git(['commit', '-q', '-m', 'foreign2'], b.fx.repo); git(['push', '-q', 'origin', 'main'], b.fx.repo);
    const g2 = ghFor(b, { mergedFrom: g1.squash() });
    const r2 = resume(b, g2.gh);
    // The merge itself is the batch's own (first parent = the tested tip), so it verifies; the foreign commit only matters to a later merge.
    assert.equal(b.member().state, 'verified', r2.text);
  });
});

describe('buildShipBatch: grant first, partition before the build', () => {
  function ctxFor(fx) {
    const env = { ...process.env };
    const ctx = { cwd: fx.repo, cmd: 'fleet', now: new Date(), env, dir: fleetDirOf(fx.repo) };
    Object.defineProperty(ctx, 'config', { get: () => resolveConfig(fx.repo, { env }) });
    return ctx;
  }
  const parseSelect = (v) => String(v).split(',');
  const membersOf = (b) => [{ id: 'feat', kind: 'pr', repo: REPO, prNumber: PR, baseRef: 'main', branch: 'feat', oid: b.tested, worktree: b.fx.repo }];
  const ghGreen = (tested) => (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return ok({ state: 'OPEN', isDraft: false, headRefOid: tested, baseRefName: 'main' });
    if (args[0] === 'api') return { ok: true, status: 0, stdout: JSON.stringify(/rules\/branches/.test(args[1]) ? [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }] : { protected: false }), stderr: '' };
    if (args[0] === 'pr' && args[1] === 'checks') return { ok: true, status: 0, stdout: JSON.stringify([{ name: 'ci', bucket: 'pass', state: 'SUCCESS', completedAt: '2026-10-09T10:00:00Z' }]), stderr: '' };
    return { ok: false, status: 1, stdout: '', stderr: 'unexpected', reason: 'unexpected' };
  };

  it('without the grant the build is refused before ANY member is looked at (the child is never run, nothing is built)', () => {
    const b = batchFx();
    fs.rmSync(b.grantFile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    let built = false;
    const r = buildShipBatch(ctxFor(b.fx), {}, { ...depsWith(ghGreen(b.tested)), shipBatch: { ...b.shipBatch, members: membersOf(b) } }, () => { built = true; return { ok: true, trainId: 'x' }; }, { parseSelect });
    assert.equal(r.ok, false);
    assert.match(r.reason, /grant-absent/);
    assert.match(r.text, /declaration check, not verified authority/);
    assert.equal(built, false);
    assert.equal(b.childCalls.length, 0);
  });

  it('a refused member is excluded BEFORE the build and the build receives only the ship-ok ids', () => {
    const b = batchFx();
    let sawSelect = null;
    const buildFn = (ctx, flags) => { sawSelect = flags['--select']; return { ok: true, trainId: b.trainId, text: 'built', train: b.t }; };
    const r = buildShipBatch(ctxFor(b.fx), {}, { ...depsWith(ghGreen(b.tested)), shipBatch: { ...b.shipBatch, members: membersOf(b), ciVerdict: () => ({ verdict: 'full' }) } }, buildFn, { parseSelect });
    assert.equal(r.ok, true, r.text);
    assert.equal(sawSelect, 'feat');
    assert.equal(r.shipBatch, true);
    assert.match(r.text, new RegExp(`land --approve ${b.trainId} --ship-batch`));
    assert.equal(readShipBatch(b.dir, b.trainId).batch.members[0].state, 'pending');
  });

  it('every member refused: nothing is built, nothing is merged, and each is told to wait for /ship', () => {
    const b = batchFx({ child: () => ({ ok: false, reasons: ['trailers: AI-Gate is "waived"; only passed or converged may ship without the user'], envelope: null }) });
    let built = false;
    const r = buildShipBatch(ctxFor(b.fx), {}, { ...depsWith(ghGreen(b.tested)), shipBatch: { ...b.shipBatch, members: membersOf(b), ciVerdict: () => ({ verdict: 'full' }) } }, () => { built = true; return {}; }, { parseSelect });
    assert.equal(r.ok, false);
    assert.equal(built, false);
    assert.match(r.reason, /no member is ship-ok/);
    assert.match(r.text, /waived/);
    assert.match(r.text, /\/ship/);
  });
});

describe('archive-check: a ready, unmerged member owes its evidence markers (plan section 2.2)', async () => {
  const { shipEvidenceOwed } = await import('../scripts/lib/fleet/lifecycle.mjs');
  it('a ready session with an open PR is owed: archiving would destroy the markers the batch re-check reads', () => {
    assert.match(shipEvidenceOwed({ ready: { oid: 'a'.repeat(40), at: 'x' } }, { number: 21 }), /PR #21 is ready but unmerged.*\.audit\//);
  });
  it('not ready, or no PR at all: nothing is owed (the direction it must NOT fire)', () => {
    assert.equal(shipEvidenceOwed({ ready: null }, { number: 21 }), null);
    assert.equal(shipEvidenceOwed({ ready: { oid: 'a'.repeat(40) } }, null), null);
    assert.equal(shipEvidenceOwed(null, { number: 21 }), null);
    assert.equal(shipEvidenceOwed({ ready: null }, { unknown: 'gh unavailable' }), null, 'a member that is not ready owes nothing even when the PR query failed');
  });
  it('a READY member whose PR could not be queried is UNCERTAIN, never clear to archive', () => {
    assert.match(shipEvidenceOwed({ ready: { oid: 'a'.repeat(40) } }, { unknown: 'gh unavailable' }), /could not be queried \(gh unavailable\).*unknown/);
  });
});

// ---- two members: the "rest still land" promise and the base progression across merges ----------------------------------------
import { addBranch, installFakeGh, makeFleetRepo, prRow, runFleet, scrubbedEnv } from './helpers/fleet-repo.mjs';
import { RULES, BRANCH, check } from './helpers/fleet-serial-fx.mjs';

const msgFor = (n) => MSG.replace('feat: the thing', `feat: thing ${n}`).replace('981fc79a-0fbb-447a-a294-b0c0217dab71', `0000000${n}-0fbb-447a-a294-b0c0217dab71`);

function twoMemberFx() {
  const fx = makeFleetRepo({ fleetConfig: { mergeMethod: 'pr', testCommand: { tiers: [{ name: 'ok', command: ['node', '-e', '0'] }] } } });
  git(['add', '.fleet.json'], fx.repo); git(['commit', '-q', '-m', 'cfg'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
  const fake = installFakeGh(fx.root);
  const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, ...fake.env }, { prependPath: [fake.bin] });
  const f = (args) => runFleet(args, { cwd: fx.repo, env });
  const base = git(['rev-parse', 'main'], fx.repo);
  const heads = {};
  for (const [id, n] of [['feat-a', 21], ['feat-b', 22]]) {
    heads[id] = addBranch(fx.repo, id, { [`${id}.txt`]: `${id}\n` }, msgFor(n));
    git(['push', '-q', 'origin', `${heads[id]}:refs/pull/${n}/head`], fx.repo);
    git(['checkout', '-q', id], fx.repo);
    assert.equal(f(['claim', '--id', id, '--intent', id, '--paths', `${id}.txt`]).status, 0);
    assert.equal(f(['ready', '--id', id]).status, 0);
    git(['checkout', '-q', 'main'], fx.repo);
  }
  const rows = [prRow({ number: 21, branch: 'feat-a', headOid: heads['feat-a'], baseOid: base }), prRow({ number: 22, branch: 'feat-b', headOid: heads['feat-b'], baseOid: base })];
  fake.setState({ list: rows, view: { 21: rows[0], 22: rows[1] } });
  const built = f(['land', '--json']);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  return { fx, heads, trainId: built.json.train.trainId };
}

function twoBatch({ childFor = () => null } = {}) {
  const { fx, heads, trainId } = twoMemberFx();
  const dir = fleetDirOf(fx.repo);
  const t = readTrain(dir, trainId).train;
  const grantFile = path.join(mkTmp('grant2-'), 'CLAUDE.md');
  fs.writeFileSync(grantFile, `${CANONICAL_GRANT}\n`);
  const shipBatch = {
    grantFile,
    checkChild: ({ head }) => childFor(head) ?? { ok: true, reasons: [], envelope: {} },
    ciVerdict: () => ({ verdict: 'full' }),
  };
  writeShipBatch(dir, {
    schemaVersion: SHIP_BATCH_SCHEMA, trainId, grantVersion: 'v1', checkedAt: new Date().toISOString(), base: 'main',
    remote: t.destination.remote, expectedTip: t.destination.expectedOid,
    members: [['feat-a', 21], ['feat-b', 22]].map(([id, n]) => ({ id, prNumber: n, repo: REPO, oid: heads[id], worktree: fx.repo, state: 'pending', mergeOid: null, note: null })),
    excluded: [],
  });
  return { fx, heads, trainId, dir, shipBatch, batch: () => readShipBatch(dir, trainId).batch };
}

/** A gh over TWO PRs: each is OPEN until its own merge, which makes a real squash (GitHub's message from --subject/--body-file). */
function ghTwo(b) {
  const squashes = {}; const merges = [];
  const num = (args) => Number(args[2]);
  const idOf = { 21: 'feat-a', 22: 'feat-b' };
  const gh = (args) => {
    if (args[0] === 'api' && /rules\/branches/.test(args[1])) return RULES;
    if (args[0] === 'api' && /\/branches\//.test(args[1])) return BRANCH;
    if (args[0] === 'pr' && args[1] === 'checks') return { ok: true, status: 0, stdout: JSON.stringify(check('pass')), stderr: '' };
    if (args[0] === 'pr' && args[1] === 'view') {
      const n = num(args); const head = b.heads[idOf[n]];
      return ok(squashes[n] ? view(head, { state: 'MERGED', mergeCommit: { oid: squashes[n] } }) : view(head));
    }
    if (args[0] === 'pr' && args[1] === 'merge') { merges.push(args); const n = num(args); squashes[n] = squashFrom(b.fx, args); return ok(); }
    return { ok: false, status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}`, reason: 'unexpected' };
  };
  return { gh, merges, squashes };
}
const approveTwo = (b, gh, extra = {}) => approveShipBatch({ cwd: b.fx.repo, dir: b.dir, trainId: b.trainId, deps: { ...depsWith(gh), shipBatch: b.shipBatch, ...extra }, serialOpts: { sleep: () => {}, timings: fast, timeoutMs: 60_000 } });

describe('a batch of two: the rest still land, and the base progression holds across merges', () => {
  it('both verify: both land IN ORDER, the second on the first\'s squash, each carrying its own trailers; the train lands', () => {
    const b = twoBatch();
    const g = ghTwo(b);
    const r = approveTwo(b, g.gh);
    assert.equal(r.ok, true, r.text);
    assert.equal(r.landed, true);
    assert.deepEqual(g.merges.map((m) => m[2]), ['21', '22']);
    const [a, c] = b.batch().members;
    assert.deepEqual([a.state, c.state], ['verified', 'verified']);
    assert.equal(git(['rev-parse', `${c.mergeOid}^`], b.fx.repo), a.mergeOid, 'the second squash sits directly on the first');
    assert.equal(b.batch().expectedTip, c.mergeOid);
    assert.match(git(['log', '-1', '--format=%B', a.mergeOid], b.fx.repo), /AI-Run-ID: 000000021-/);
    assert.match(git(['log', '-1', '--format=%B', c.mergeOid], b.fx.repo), /AI-Run-ID: 000000022-/);
  });

  it('the FIRST member fails its re-check: it waits for /ship and the SECOND still lands (ok, partial, exit-0 shape)', () => {
    const b = twoBatch();
    b.shipBatch.checkChild = ({ head }) => (head === b.heads['feat-a'] ? { ok: false, reasons: ['trailers: AI-Gate is "waived"; only passed or converged may ship without the user'], envelope: null } : { ok: true, reasons: [], envelope: {} });
    const g = ghTwo(b);
    const r = approveTwo(b, g.gh);
    assert.equal(r.ok, true, r.text);
    assert.equal(r.landed, false, 'the train is not fully landed');
    assert.deepEqual(g.merges.map((m) => m[2]), ['22'], 'only the verified member merged');
    const [a, c] = b.batch().members;
    assert.equal(a.state, 'needs-user');
    assert.match(a.note, /waived/);
    assert.equal(c.state, 'verified');
    assert.match(r.text, /partial: 1 member\(s\) wait for the user's \/ship/);
    assert.match(r.text, /needs-user\s+feat-a/);
  });

  it('a waived member is never merged under ANY order of the batch (the AI-Gate honesty control)', () => {
    const b = twoBatch();
    b.shipBatch.checkChild = ({ head }) => (head === b.heads['feat-b'] ? { ok: false, reasons: ['trailers: AI-Gate is "not-run"'], envelope: null } : { ok: true, reasons: [], envelope: {} });
    const g = ghTwo(b);
    approveTwo(b, g.gh);
    assert.equal(g.merges.some((m) => m[2] === '22'), false);
    assert.equal(b.batch().members[1].state, 'needs-user');
  });

  it('both refuse: nothing merges and the batch is not ok', () => {
    const b = twoBatch({ childFor: () => ({ ok: false, reasons: ['evidence-unavailable: gone'], envelope: null }) });
    const g = ghTwo(b);
    const r = approveTwo(b, g.gh);
    assert.equal(r.ok, false);
    assert.equal(g.merges.length, 0);
    assert.deepEqual(b.batch().members.map((m) => m.state), ['needs-user', 'needs-user']);
  });

  it('a skipped member is re-checked on --resume and lands once it verifies (nothing is lost by waiting)', () => {
    const b = twoBatch();
    let refuse = true;
    b.shipBatch.checkChild = ({ head }) => (refuse && head === b.heads['feat-a'] ? { ok: false, reasons: ['evidence-unavailable: gone'], envelope: null } : { ok: true, reasons: [], envelope: {} });
    const g = ghTwo(b);
    approveTwo(b, g.gh);
    assert.equal(b.batch().members[0].state, 'needs-user');
    refuse = false; // the chip's worktree is back
    const r2 = resumeShipBatch({ cwd: b.fx.repo, dir: b.dir, trainId: b.trainId, deps: { ...depsWith(g.gh), shipBatch: b.shipBatch }, serialOpts: { sleep: () => {}, timings: fast } });
    assert.equal(r2.ok, true, r2.text);
    assert.deepEqual(g.merges.map((m) => m[2]), ['22', '21'], 'the second member landed first, then the resumed first');
    assert.deepEqual(b.batch().members.map((m) => m.state), ['verified', 'verified']);
  });
});

describe('code-audit round 2: member isolation, CI evidence policy, bookkeeping honesty', () => {
  for (const [name, over, re] of [
    ['a PR that became a DRAFT after the build', { state: 'OPEN', isDraft: true }, /is a draft/],
    ['a PR that was CLOSED after the build', { state: 'CLOSED' }, /is CLOSED/],
    ['a PR that now CONFLICTS with the base', { mergeStateStatus: 'DIRTY' }, /conflicts with main/],
  ]) {
    it(`${name}: a member problem SKIPS that member (needs-user), it does not stop a batch`, () => {
      const b = batchFx();
      const g = scriptedGh({ views: () => view(b.tested, over) });
      const r = approve(b, g.gh);
      assert.equal(b.member().state, 'needs-user');
      assert.match(b.member().note, re);
      assert.equal(r.ok, false, 'nothing landed, so not ok');
      assert.equal(g.calls.some((c) => c[1] === 'merge'), false);
    });
  }
  it('the same problems STOP a plain serial run exactly as before (the skip is ship-batch only)', () => {
    const { fx, tested, trainId } = trainFx();
    const g = scriptedGh({ views: () => view(tested, { mergeStateStatus: 'DIRTY' }) });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(g.gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    assert.match(r.reason, /conflicts with main/);
    assert.equal(r.partial, undefined);
  });

  it('a PR observed MERGED at a head this run never accounted for is a stop, not "merged"', () => {
    const b = batchFx();
    let merged = false;
    const { gh } = scriptedGh({
      views: () => (merged ? view('9'.repeat(40), { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(b.tested)),
      onMerge: (args) => { squashFrom(b.fx, args); merged = true; return ok(); },
    });
    const r = approve(b, gh);
    assert.equal(r.ok, false);
    assert.match(r.reason, /did not account for/);
    assert.notEqual(b.member().state, 'verified');
  });

  it('no required checks configured AND no full-suite workflow declared: together they measure NOTHING, so the member is needs-user', () => {
    const none = { ok: true, status: 0, stdout: JSON.stringify([]), stderr: '' };
    const ms = [{ id: 'a1', kind: 'pr', repo: REPO, prNumber: 21, baseRef: 'main', branch: 'a1', oid: 'a'.repeat(40), worktree: '/wt/a1' }];
    const gh = (args) => (args[0] === 'pr' && args[1] === 'view' ? ok({ state: 'OPEN', isDraft: false, headRefOid: ms[0].oid, baseRefName: 'main' })
      : args[0] === 'api' ? { ok: true, status: 0, stdout: JSON.stringify(/rules\/branches/.test(args[1]) ? [] : { protected: false }), stderr: '' } : none);
    const undeclared = () => ({ verdict: 'unverified', reason: 'no ciVerdict workflow is declared in .test-tiers.json on main' });
    const r = partitionMembers({ cwd: process.cwd(), members: ms, base: 'main', deps: { gh }, checkChild: () => ({ ok: true, reasons: [], envelope: {} }), requiredChecks: [], ciFn: undeclared });
    assert.match(r.needsUser[0]?.reasons.join(' ') ?? 'NOT-REFUSED', /nothing measured CI/);
    // The control: ONE source present is enough (the declared workflow is green).
    const r2 = partitionMembers({ cwd: process.cwd(), members: ms, base: 'main', deps: { gh }, checkChild: () => ({ ok: true, reasons: [], envelope: {} }), requiredChecks: [], ciFn: () => ({ verdict: 'full' }) });
    assert.equal(r2.ok.length, 1, JSON.stringify(r2.needsUser));
  });

  it('a ship-batch record that becomes unreadable DURING the run makes the result NOT ok, naming why (never the serial result unchanged)', () => {
    const b = batchFx();
    const sidecar = path.join(b.dir, 'shipbatch', `${b.trainId}.json`);
    // The merge happens, then the record is corrupted before the read-back and the summary read it.
    const g = ghFor(b, { onBeforeMerge: () => { /* the message was already requested */ } });
    const gh = (args) => { const r = g.gh(args); if (args[0] === 'pr' && args[1] === 'merge') fs.writeFileSync(sidecar, '{ not json'); return r; };
    const r = approve(b, gh);
    assert.equal(r.ok, false);
    assert.match(`${r.reason} ${r.text}`, /ship-batch record could not be read after the run|per-member outcomes are unknown/);
  });
});
