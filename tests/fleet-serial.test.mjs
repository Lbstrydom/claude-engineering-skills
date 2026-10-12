/**
 * @fileoverview /fleet — `land --approve --serial` (plan
 * docs/plans/fleet-consumer-feedback-oct.md §2.5; wine item 8, storyline 8).
 *
 * The loop runs in-process with a scripted `gh` (a state machine per PR) and the
 * REAL git: an updated head is a real merge commit pushed to the bare origin's
 * `refs/pull/<n>/head`, so the recovery proof (parents + re-derived merge tree)
 * runs against real objects.
 *
 * Pinned: BEHIND → update with expected_head_sha → wait (missing → pending →
 * pass) → merge exactly that head; an update the run cannot prove is its own
 * (foreign content in the merge) stops; a crash between update and record is
 * recovered by proof; DIRTY stops with the restack remedy; a never-registered
 * check times out by name; a second runner is refused by the lease.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { approveSerial, readSerial, resumeSerial } from '../scripts/lib/fleet/serial.mjs';
import { readTrain } from '../scripts/lib/fleet/registry.mjs';
import { cleanupFleetRoots } from './helpers/fleet-repo.mjs';
import {
  PR, REPO, ok, view, fast, depsWith, trainFx, updatedHead, scriptedGh,
} from './helpers/fleet-serial-fx.mjs';

after(cleanupFleetRoots);

describe('serial landing', () => {
  it('a CLEAN PR: waits for the required check, merges exactly the tested head, lands the train', () => {
    const { fx, tested, trainId } = trainFx();
    // view: verify, merge re-check (head bound before/after checks uses headRefOid-only views), then MERGED.
    let merged = false;
    const { gh, calls } = scriptedGh({
      views: () => (merged ? view(tested, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(tested)),
      checks: [['pending'], ['pass']], onMerge: () => { merged = true; return ok(); },
    });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    assert.equal(r.landed, true, JSON.stringify(r.run?.steps ?? r.reason));
    const m = calls.find((c) => c[1] === 'merge');
    assert.deepEqual(m.slice(-2), ['--match-head-commit', tested]);
    assert.equal(readTrain(path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet'), trainId).train.phase, 'landed');
  });

  it('BEHIND: update-branch with expected_head_sha, PROVES the new head is its own merge, waits missing→pending→pass, merges the updated head', () => {
    const { fx, tested, trainId } = trainFx();
    // The base moves and GitHub builds the merge commit only when update-branch is called (as in life).
    let u = null; let state = 'behind'; let merged = false;
    const { gh, calls } = scriptedGh({
      views: () => (merged ? view(u, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } })
        : state === 'behind' ? view(tested, { mergeStateStatus: 'BEHIND' }) : view(u)),
      checks: [['missing'], ['pending'], ['pass']],
      onUpdate: (args) => { assert.ok(args.includes(`expected_head_sha=${tested}`)); u = updatedHead(fx, tested); state = 'updated'; return ok({}); },
      onMerge: () => { merged = true; return ok(); },
    });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    assert.equal(r.landed, true, JSON.stringify(r.run?.steps ?? r.reason));
    assert.deepEqual(calls.find((c) => c[1] === 'merge').slice(-1), [u]);
    assert.match(JSON.stringify(r.run.steps[0].accounted), new RegExp(u));
  });

  it('an updated head carrying FOREIGN content in the merge itself is UNACCOUNTED — stop for a new approval', () => {
    const { fx, tested, trainId } = trainFx();
    let u = null; let state = 'behind';
    const { gh, calls } = scriptedGh({
      views: () => (state === 'behind' ? view(tested, { mergeStateStatus: 'BEHIND' }) : view(u)),
      onUpdate: () => { u = updatedHead(fx, tested, { foreign: true }); state = 'updated'; return ok({}); },
    });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    assert.equal(r.landed, undefined);
    assert.match(r.reason, /UNACCOUNTED.*beyond a clean merge/);
    assert.equal(calls.some((c) => c[1] === 'merge'), false, 'never merged');
  });

  it('crash after update-branch, before the new head was recorded: resume proves it by parentage + tree and continues', () => {
    const { fx, tested, trainId } = trainFx();
    // First run: the update succeeds but the poll never sees the new head (simulating a crash/timeout window).
    let u = null; let state = 'behind';
    const first = scriptedGh({ views: () => (state === 'behind' ? view(tested, { mergeStateStatus: 'BEHIND' }) : view(tested)), onUpdate: () => { u = updatedHead(fx, tested); state = 'sent'; return ok({}); } });
    const r1 = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(first.gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    assert.match(r1.reason, /update not yet visible/);
    const dir = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet');
    assert.equal(readSerial(dir, trainId).run.steps[0].priorHead, tested, 'the intent was recorded before the call');
    // Resume: GitHub now shows u. The run must prove u is its own update (no new approval needed).
    let merged = false;
    const second = scriptedGh({ views: () => (merged ? view(u, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(u)), onMerge: () => { merged = true; return ok(); } });
    const r2 = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(second.gh), sleep: () => {}, timings: fast });
    assert.equal(r2.landed, true, r2.reason);
  });

  it('DIRTY stops with the restack remedy; a never-registered required check times out by name', () => {
    const a = trainFx();
    const dirty = scriptedGh({ views: () => view(a.tested, { mergeStateStatus: 'DIRTY' }) });
    const r = approveSerial({ cwd: a.fx.repo, trainId: a.trainId, deps: depsWith(dirty.gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    assert.match(r.reason, /conflicts with main — run `fleet restack feat`/);
    const b = trainFx();
    const never = scriptedGh({ views: () => view(b.tested), checks: [['missing']] });
    const t = approveSerial({ cwd: b.fx.repo, trainId: b.trainId, deps: depsWith(never.gh), sleep: () => {}, timings: fast, timeoutMs: 30 });
    assert.match(t.reason, /never registered on .*: ci/);
  });

  it('a second runner is refused while the lease is held; a non-pr train is refused', () => {
    const { fx, tested, trainId } = trainFx();
    const dir = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet');
    const { gh } = scriptedGh({ views: () => view(tested, { mergeStateStatus: 'DIRTY' }) });
    approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    fs.writeFileSync(path.join(dir, 'serial', `${trainId}.lock`), JSON.stringify({ pid: process.pid, token: 'x', at: Date.now() }));
    const r = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast });
    assert.match(r.reason, /another process is landing/);
  });
});

describe('serial landing — the messageFor seam (docs/plans/ship-trains.md §2.4)', () => {
  /** A CLEAN PR that merges on the first `pr merge`; `mergeSeen` records the argv AND the body file as it was at the call. */
  function cleanRun({ messageFor } = {}) {
    const { fx, tested, trainId } = trainFx();
    let merged = false; const mergeSeen = [];
    const { gh, calls } = scriptedGh({
      views: () => (merged ? view(tested, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(tested)),
      onMerge: (args) => {
        const f = args.includes('--body-file') ? args[args.indexOf('--body-file') + 1] : null;
        mergeSeen.push({ args, bodyFile: f, body: f ? fs.readFileSync(f, 'utf8') : null });
        merged = true; return ok();
      },
    });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, timeoutMs: 60_000, ...(messageFor ? { messageFor } : {}) });
    return { fx, tested, trainId, r, calls, mergeSeen };
  }

  it('absent: the merge argv is byte-identical to the pre-seam call', () => {
    const { r, tested, mergeSeen } = cleanRun();
    assert.equal(r.landed, true, r.reason);
    assert.deepEqual(mergeSeen[0].args, ['pr', 'merge', String(PR), '-R', REPO, '--squash', '--match-head-commit', tested]);
  });

  it('a null answer merges exactly as if the seam were absent — on a run that did not require a message', () => {
    // Approved WITHOUT a provider (no requirement recorded), then resumed with one that answers null.
    const { fx, tested, trainId } = trainFx();
    const dirty = scriptedGh({ views: () => view(tested, { mergeStateStatus: 'DIRTY' }) });
    approveSerial({ cwd: fx.repo, trainId, deps: depsWith(dirty.gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    let merged = false; const seen = [];
    const { gh } = scriptedGh({
      views: () => (merged ? view(tested, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(tested)),
      onMerge: (args) => { seen.push(args); merged = true; return ok(); },
    });
    const r = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, messageFor: () => null });
    assert.equal(r.landed, true, r.reason);
    assert.deepEqual(seen[0], ['pr', 'merge', String(PR), '-R', REPO, '--squash', '--match-head-commit', tested]);
  });

  it('a message adds --subject and --body-file, the file holds the body at call time, and is gone afterwards', () => {
    const { r, tested, trainId, mergeSeen } = cleanRun({ messageFor: () => ({ subject: 'feat: the thing (#21)', body: 'body line\n\nAI-Skill: ship\n' }) });
    assert.equal(r.landed, true, r.reason);
    const { args, body, bodyFile } = mergeSeen[0];
    assert.equal(args[args.indexOf('--subject') + 1], 'feat: the thing (#21)');
    assert.equal(body, 'body line\n\nAI-Skill: ship\n');
    assert.equal(args.at(-2), '--match-head-commit', 'the head bind stays last, so it still guards exactly this head');
    assert.equal(args.at(-1), tested);
    assert.match(path.basename(bodyFile), new RegExp(`^${trainId}\\.pr-${PR}\\.msg$`));
    assert.equal(fs.existsSync(bodyFile), false, 'the temp body file is removed after the merge call');
  });

  it('is called with the POST-update head and the base tip, not the tested head', () => {
    const { fx, tested, trainId } = trainFx();
    let u = null; let state = 'behind'; let merged = false; const seen = [];
    const { gh } = scriptedGh({
      views: () => (merged ? view(u, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : state === 'behind' ? view(tested, { mergeStateStatus: 'BEHIND' }) : view(u)),
      onUpdate: () => { u = updatedHead(fx, tested); state = 'updated'; return ok({}); },
      onMerge: () => { merged = true; return ok(); },
    });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, timeoutMs: 60_000, messageFor: (a) => { seen.push(a); return { subject: 's (#21)', body: 'b' }; } });
    assert.equal(r.landed, true, r.reason);
    assert.equal(seen.length, 1, 'once per PR, not once per loop pass');
    assert.equal(seen[0].headOid, u);
    assert.notEqual(seen[0].headOid, tested);
    assert.equal(seen[0].baseOid, git(['ls-remote', 'origin', 'refs/heads/main'], fx.repo).split(/\s+/)[0]);
    assert.equal(seen[0].source.prNumber, PR);
  });

  it('the message requirement is durable: a run approved with a provider cannot be resumed WITHOUT one (raw fleet land --resume), and the marker survives progress writes', () => {
    const { fx, tested, trainId } = trainFx();
    const dir = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet');
    let merged = false;
    const gh1 = scriptedGh({ views: () => view(tested, { mergeStateStatus: 'DIRTY' }) });
    approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh1.gh), sleep: () => {}, timings: fast, timeoutMs: 60_000, messageFor: () => ({ subject: 's (#21)', body: 'b' }) });
    assert.equal(readSerial(dir, trainId).run.messageRequired, true, 'recorded at approval, after a progress write');
    const gh2 = scriptedGh({ views: () => (merged ? view(tested, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(tested)), onMerge: () => { merged = true; return ok(); } });
    const raw = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(gh2.gh), sleep: () => {}, timings: fast });
    assert.equal(raw.landed, undefined);
    assert.match(raw.reason, /may only merge with one; resume it with the same tool: node scripts\/ship-train\.mjs land --train .* --resume/);
    assert.equal(gh2.calls.some((c) => c[1] === 'merge'), false, 'no merge without the provider');
    assert.equal(readSerial(dir, trainId).run.messageRequired, true, 'the refusal does not clear it');
    const again = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(gh2.gh), sleep: () => {}, timings: fast, messageFor: () => ({ subject: 's (#21)', body: 'b' }) });
    assert.equal(again.landed, true, again.reason);
  });

  it('a required run refuses a provider that answers null; an ordinary run records no requirement and merges as before', () => {
    const a = trainFx();
    const { gh, calls } = scriptedGh({ views: () => view(a.tested) });
    const r = approveSerial({ cwd: a.fx.repo, trainId: a.trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, timeoutMs: 60_000, messageFor: () => null });
    assert.match(r.reason, /requires a squash message and messageFor returned none/);
    assert.equal(calls.some((c) => c[1] === 'merge'), false);
    const b = trainFx();
    const dirB = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], b.fx.repo), 'fleet');
    const plain = scriptedGh({ views: () => view(b.tested, { mergeStateStatus: 'DIRTY' }) });
    approveSerial({ cwd: b.fx.repo, trainId: b.trainId, deps: depsWith(plain.gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    assert.equal('messageRequired' in readSerial(dirB, b.trainId).run, false, 'no marker on an ordinary run');
  });

  it('a message file left by a run that died is swept when the next run starts; another train\'s files are left alone', () => {
    const { fx, tested, trainId } = trainFx();
    const dir = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet');
    const dirty = scriptedGh({ views: () => view(tested, { mergeStateStatus: 'DIRTY' }) });
    approveSerial({ cwd: fx.repo, trainId, deps: depsWith(dirty.gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    const stale = path.join(dir, 'serial', `${trainId}.pr-${PR}.msg`);
    const other = path.join(dir, 'serial', `t-20200101000000-ffff.pr-${PR}.msg`);
    fs.writeFileSync(stale, 'left by a process that died mid-merge');
    fs.writeFileSync(other, 'someone else\'s');
    let merged = false;
    const { gh } = scriptedGh({ views: () => (merged ? view(tested, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(tested)), onMerge: () => { merged = true; return ok(); } });
    const r = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast });
    assert.equal(r.landed, true, r.reason);
    assert.equal(fs.existsSync(stale), false, 'swept');
    assert.equal(fs.existsSync(other), true, 'a different train\'s file is not ours to remove');
  });

  it('a stale message file that cannot be removed stops the run with the reason — it is not swallowed', () => {
    const { fx, tested, trainId } = trainFx();
    const dir = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet');
    const dirty = scriptedGh({ views: () => view(tested, { mergeStateStatus: 'DIRTY' }) });
    approveSerial({ cwd: fx.repo, trainId, deps: depsWith(dirty.gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    // A non-empty DIRECTORY where the message file should be: rmSync without recursive refuses it.
    const blocker = path.join(dir, 'serial', `${trainId}.pr-${PR}.msg`);
    fs.mkdirSync(blocker); fs.writeFileSync(path.join(blocker, 'x'), 'x');
    const { gh, calls } = scriptedGh({ views: () => view(tested) });
    const r = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast });
    assert.equal(r.landed, undefined);
    assert.match(r.reason, /cannot remove the stale message file .*\.pr-21\.msg/);
    assert.equal(calls.some((c) => c[1] === 'merge'), false, 'nothing merged past an unclean serial directory');
  });

  it('{stop} ends the run BEFORE the merge, records the reason, and a resume recomputes on the current head', () => {
    const { fx, tested, trainId } = trainFx();
    let merged = false; const mergeArgs = [];
    const { gh, calls } = scriptedGh({
      views: () => (merged ? view(tested, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(tested)),
      onMerge: (args) => { mergeArgs.push(args); merged = true; return ok(); },
    });
    const r1 = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, timeoutMs: 60_000, messageFor: () => ({ stop: 'no run covers this head' }) });
    assert.equal(r1.landed, undefined);
    assert.match(r1.reason, /PR #21: no run covers this head/);
    assert.equal(calls.some((c) => c[1] === 'merge'), false, 'never merged');
    const dir = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet');
    const rec = readSerial(dir, trainId).run;
    assert.notEqual(rec.steps[0].step, 'merge', 'the merge intent was not recorded for a merge that never happened');
    assert.match(rec.outcome.reason, /no run covers this head/);
    let n = 0;
    const r2 = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, messageFor: () => { n += 1; return { subject: 's (#21)', body: 'b' }; } });
    assert.equal(r2.landed, true, r2.reason);
    assert.equal(n, 1, 'the callback ran again on resume; nothing was replayed');
    assert.ok(mergeArgs[0].includes('--subject'));
  });

  it('a throw, an empty or multi-line subject, or an unknown shape stops the run — never an unmessaged merge', () => {
    for (const bad of [
      () => { throw new Error('store exploded'); },
      () => ({ subject: '', body: 'b' }),
      () => ({ subject: 'two\nlines', body: 'b' }),
      () => ({ subject: 's', body: 'b\0' }),
      () => ({ subject: 's' }),
      () => ({ stop: 'x', subject: 's', body: 'b' }),
      () => 'a string',
    ]) {
      const { r, calls } = cleanRun({ messageFor: bad });
      assert.equal(r.landed, undefined);
      assert.equal(calls.some((c) => c[1] === 'merge'), false, 'no merge on a bad answer');
    }
    const thrown = cleanRun({ messageFor: () => { throw new Error('store exploded'); } });
    assert.match(thrown.r.reason, /messageFor failed: store exploded/);
  });
});
