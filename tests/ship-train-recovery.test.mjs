/**
 * @fileoverview Fault injection for `ship-train land` over REAL fleet serial
 * landing (docs/plans/ship-trains.md §2.9): the process dies immediately before
 * and immediately after a merge submission, and recovery reads ONLY owned state —
 * fleet's manifest and serial record, GitHub — never a ship-train record, because
 * there is none.
 *
 * Pinned: a merge GitHub already performed is observed, never resubmitted; a PR
 * still open is decided FRESH on its current head (strict protection removed
 * between attempts → the retry claims `converged`, not the `passed` the first
 * attempt would have claimed); a fresh decision that became a refusal stops the
 * run BEFORE the merge; and nothing of ship-train's lands on disk.
 *
 * The decision under test is the real one: `decideTrainGate` and
 * `composeSquashMessage` over a canned binding. Only the store read is canned.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { approveSerial, readSerial, resumeSerial } from '../scripts/lib/fleet/serial.mjs';
import { fleetDir, readTrain } from '../scripts/lib/fleet/registry.mjs';
import { runLand, TrainRefusal } from '../scripts/lib/ship-train/commands.mjs';
import { decideTrainGate, composeSquashMessage } from '../scripts/lib/ship-train/provenance.mjs';
import { cleanupFleetRoots } from './helpers/fleet-repo.mjs';
import {
  PR, REPO, ok, view, fast, depsWith, trainFx, scriptedGh,
} from './helpers/fleet-serial-fx.mjs';

after(cleanupFleetRoots);

const RUN_ID = 'bd49abc4-243e-42cc-85ec-e5d14328841d';
const TREE = 'a'.repeat(40);
const CRASH = new Error('simulated process death');
const composer = 'claude';
const overrides = { waive: [], allowUnaudited: [], endOfDay: false };

/** The decision the real `message` verb would make for this PR in this world. */
function decide(world, pr) {
  const binding = world.binding === 'tree'
    ? { kind: 'tree', run: { id: RUN_ID, auditedTree: TREE, roundConvergedAfter: 2 }, boundCommit: world.head, postAuditCommits: [] }
    : { kind: 'unbound' };
  const d = decideTrainGate({ binding, headTree: TREE, basePinning: world.pinning, tier: world.tier, waive: false, allowUnaudited: false });
  if (d.refusal) return { ok: true, verb: 'message', pr, headOid: world.head, refusal: d.refusal };
  const { subject, body } = composeSquashMessage({ number: pr, title: 'feat: the thing', commitSubjects: ['feat: one'], decision: d, models: ['claude', 'gpt'] });
  return { ok: true, verb: 'message', pr, headOid: world.head, decision: d, subject, body };
}

/** A land context over the real fleet repo; `gh` is the scripted GitHub of the attempt being made. */
function landCtx(fx, world, getGh, decided) {
  const dir = fleetDir(fx.repo);
  const base = { cwd: fx.repo, deps: () => depsWith(getGh()), sleep: () => {}, timings: fast };
  return {
    cwd: fx.repo,
    repo: () => REPO,
    readTrain: (id) => readTrain(dir, id),
    messageSync: ({ pr }) => { decided.push(world.pinning); return decide(world, pr); },
    serial: {
      approve: ({ trainId, acceptRerun, messageFor }) => approveSerial({ cwd: fx.repo, trainId, acceptRerun, deps: base.deps(), sleep: base.sleep, timings: base.timings, timeoutMs: 60_000, messageFor }),
      resume: ({ trainId, messageFor }) => resumeSerial({ cwd: fx.repo, trainId, deps: base.deps(), sleep: base.sleep, timings: base.timings, messageFor }),
    },
  };
}

const gateOf = (body) => /^AI-Gate: (\S+)$/m.exec(body)?.[1];
const bodyFileOf = (args) => (args.includes('--body-file') ? fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') : null);

describe('ship-train land — recovery from owned state only', () => {
  it('dies BEFORE the merge submission: the retry decides FRESH — strict protection removed in between → converged, not the passed the first attempt claimed', async () => {
    const { fx, tested, trainId } = trainFx();
    const world = { pinning: 'strict', binding: 'tree', tier: 'standard', head: tested };
    const decided = [];
    let gh = null;
    const ctx = landCtx(fx, world, () => gh.gh, decided);

    const seen1 = [];
    gh = scriptedGh({ views: () => view(tested), onMerge: (args) => { seen1.push(bodyFileOf(args)); throw CRASH; } });
    await assert.rejects(runLand(ctx, { train: trainId, composer, overrides }), (e) => e === CRASH);
    assert.equal(gateOf(seen1[0]), 'passed', 'under strict protection the first attempt claimed passed');
    const dir = fleetDir(fx.repo);
    assert.equal(readSerial(dir, trainId).run.steps[0].step, 'merge', 'the merge intent survived the crash');

    world.pinning = 'none'; // the protection was removed while the process was down
    let merged = false; const seen2 = [];
    gh = scriptedGh({
      views: () => (merged ? view(tested, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(tested)),
      onMerge: (args) => { seen2.push(bodyFileOf(args)); merged = true; return ok(); },
    });
    const env = await runLand(ctx, { train: trainId, resume: true, composer, overrides });
    assert.equal(env.landed, true);
    assert.equal(seen2.length, 1, 'merged exactly once on the retry');
    assert.equal(gateOf(seen2[0]), 'converged', 'the retry recomputed on today\'s facts; nothing stale was replayed');
    assert.equal(decided.length, 2, 'the decision ran once per attempt');
  });

  it('dies AFTER the merge submission: the retry observes MERGED, never resubmits, and never even decides a message', async () => {
    const { fx, tested, trainId } = trainFx();
    const world = { pinning: 'none', binding: 'tree', tier: 'standard', head: tested };
    const decided = [];
    let gh = null; let merged = false;
    const ctx = landCtx(fx, world, () => gh.gh, decided);

    gh = scriptedGh({
      views: () => (merged ? view(tested, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(tested)),
      onMerge: () => { merged = true; throw CRASH; }, // GitHub performed it; the process died before observing
    });
    await assert.rejects(runLand(ctx, { train: trainId, composer, overrides }), (e) => e === CRASH);

    const before = decided.length;
    // A real death inside the merge call never reaches its finally; the file stays, and a resume that finds
    // the PR already merged never writes (or removes) one of its own.
    const stale = path.join(fleetDir(fx.repo), 'serial', `${trainId}.pr-${PR}.msg`);
    fs.writeFileSync(stale, 'left by a process that died mid-merge');
    gh = scriptedGh({ views: () => view(tested, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) });
    const env = await runLand(ctx, { train: trainId, resume: true, composer, overrides });
    assert.equal(env.landed, true);
    assert.equal(fs.existsSync(stale), false, 'the dead run message file was swept');
    assert.equal(gh.calls.some((c) => c[0] === 'pr' && c[1] === 'merge'), false, 'no merge was resubmitted');
    assert.equal(decided.length, before, 'no message was decided for a PR that was already merged');
    assert.equal(readTrain(fleetDir(fx.repo), trainId).train.phase, 'landed');
  });

  it('a fresh decision that BECAME a refusal stops the run before the merge; fixing the cause lets --resume continue', async () => {
    const { fx, tested, trainId } = trainFx();
    const world = { pinning: 'none', binding: 'unbound', tier: 'standard', head: tested }; // the audit evidence vanished
    const decided = [];
    let gh = null; let merged = false;
    const ctx = landCtx(fx, world, () => gh.gh, decided);

    gh = scriptedGh({
      views: () => (merged ? view(tested, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(tested)),
      onMerge: () => { merged = true; return ok(); },
    });
    const err = await runLand(ctx, { train: trainId, composer, overrides }).then(() => null, (e) => e);
    assert.ok(err instanceof TrainRefusal);
    assert.match(err.message, /unaudited: no audit run's content matches/);
    assert.equal(err.details.resumable, true);
    assert.equal(gh.calls.some((c) => c[0] === 'pr' && c[1] === 'merge'), false, 'never merged');
    assert.notEqual(readSerial(fleetDir(fx.repo), trainId).run.steps[0].step, 'merge');

    world.binding = 'tree'; // the evidence is back
    const env = await runLand(ctx, { train: trainId, resume: true, composer, overrides });
    assert.equal(env.landed, true);
  });

  it('a message decided on a DIFFERENT head than the one serial is merging stops the run', async () => {
    const { fx, tested, trainId } = trainFx();
    const world = { pinning: 'none', binding: 'tree', tier: 'standard', head: 'f'.repeat(40) };
    let gh = null;
    const ctx = landCtx(fx, world, () => gh.gh, []);
    gh = scriptedGh({ views: () => view(tested) });
    const err = await runLand(ctx, { train: trainId, composer, overrides }).then(() => null, (e) => e);
    assert.match(err.message, /decided on head ffffffffffff, but serial is merging /);
    assert.equal(gh.calls.some((c) => c[0] === 'pr' && c[1] === 'merge'), false);
  });

  it('ship-train persists nothing: after crashes, stops and resumes, fleet\'s directory holds only fleet\'s own files', async () => {
    const { fx, tested, trainId } = trainFx();
    const world = { pinning: 'none', binding: 'tree', tier: 'standard', head: tested };
    let gh = null; let merged = false;
    const ctx = landCtx(fx, world, () => gh.gh, []);
    gh = scriptedGh({ views: () => view(tested), onMerge: () => { throw CRASH; } });
    await assert.rejects(runLand(ctx, { train: trainId, composer, overrides }), (e) => e === CRASH);
    // A THROWN crash runs the merge call's finally; a real process death does not and leaves its message file.
    fs.writeFileSync(path.join(fleetDir(fx.repo), 'serial', `${trainId}.pr-${PR}.msg`), 'left by a process that died mid-merge');
    gh = scriptedGh({
      views: () => (merged ? view(tested, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(tested)),
      onMerge: () => { merged = true; return ok(); },
    });
    await runLand(ctx, { train: trainId, resume: true, composer, overrides });
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = walk(fleetDir(fx.repo)).map((f) => path.relative(fleetDir(fx.repo), f).split(path.sep).join('/'));
    assert.deepEqual(files.filter((f) => /ship|\.msg$/i.test(f)), [], `unexpected ship-train artefacts: ${files.join(', ')}`);
    assert.ok(git(['rev-parse', '--git-dir'], fx.repo));
  });
});
