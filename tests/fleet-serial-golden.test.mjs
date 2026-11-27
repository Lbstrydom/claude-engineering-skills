/**
 * @fileoverview The byte-identity proof for the plain serial runner (docs/plans/ship-batch-member-outcomes.md §2.5).
 *
 * `tests/fixtures/fleet-serial-golden.json` was GENERATED from `origin/main`'s `serial.mjs` (d53272aa), BEFORE the member-outcome refactor
 * touched it, and was regenerated ONCE for the CI-evidence oracle (its header says exactly what changed: only the old CI reads and two CI stop reasons). Each scenario drives the runner through a scripted `gh` and the real git (the same fixtures as
 * `fleet-serial.test.mjs` and `ship-train-recovery.test.mjs`) and snapshots three things: the `gh` argv list, the final serial
 * record, and the result object (timestamps, oids, train ids and paths normalised to labels).
 *
 * A refactor of the runner that changes any argv, any stop reason (character for character), the record bytes or the result
 * shape fails here. Regenerating is deliberate: `UPDATE_GOLDEN=1 node --test tests/fleet-serial-golden.test.mjs` against the
 * code whose behaviour is to be pinned, and the fixture header names that source.
 *
 * @module tests/fleet-serial-golden
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './helpers/git.mjs';
import { approveSerial, readSerial, resumeSerial } from '../scripts/lib/fleet/serial.mjs';
import { cleanupFleetRoots } from './helpers/fleet-repo.mjs';
import { ok, view, fast, depsWith, trainFx, updatedHead, scriptedGh } from './helpers/fleet-serial-fx.mjs';

after(cleanupFleetRoots);

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fleet-serial-golden.json');
const MERGED = (oid = 'e'.repeat(40)) => ({ state: 'MERGED', mergeCommit: { oid } });
const fleetDirOf = (fx) => path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet');

/** Replace everything that varies between runs with a label, so the snapshot is a pure function of the runner's behaviour. */
function normaliser(labels) {
  const known = Object.entries(labels).filter(([, v]) => v);
  const map = new Map([...known.map(([k, v]) => [v, `<${k}>`]), ...known.map(([k, v]) => [v.slice(0, 12), `<${k}:short>`])]);
  return (value) => {
    let s = JSON.stringify(value ?? null);
    for (const [oid, label] of map) s = s.split(oid).join(label);
    s = s.replace(/"\\?"?[A-Za-z]:[\\/][^"]*?\.msg"/g, '"<msgfile>"').replace(/"\/[^"]*?\.msg"/g, '"<msgfile>"')
      .replace(/[A-Za-z]:(?:\\\\|\\|\/)[^\s"']+/g, '<path>')
      .replace(/\/[^\s"']*\/fleet-[^\s"']+/g, '<path>')
      .replace(/t-\d{14}-[0-9a-f]+/g, '<train>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>')
      .replace(/\b[0-9a-f]{40}\b/g, '<oid>');
    return JSON.parse(s);
  };
}

/** Polling loops repeat their calls for as long as a real-time window lasts, so the snapshot keeps each DISTINCT call once, in first-seen order: the sequence of kinds of call is the contract, never the count. */
const collapse = (calls) => { const seen = new Set(); return calls.filter((c) => { const k = JSON.stringify(c); if (seen.has(k)) return false; seen.add(k); return true; }); };

/** One snapshot: the gh argv list, the serial record on disk, and the returned result. */
function snap(fx, trainId, labels, calls, r) {
  const norm = normaliser({ ...labels, train: trainId });
  const rec = readSerial(fleetDirOf(fx), trainId);
  return { argv: norm(collapse(calls)), record: norm(rec.ok ? rec.run : { absent: true }), result: norm({ ...r, text: undefined }) };
}

const cleanViews = (tested) => { let merged = false; return { views: () => (merged ? view(tested, MERGED()) : view(tested)), onMerge: () => { merged = true; return ok(); }, merged: () => merged }; };
const APPROVE = { sleep: () => {}, timings: fast, timeoutMs: 60_000 };

const SCENARIOS = {
  'clean: waits for the check, merges exactly the tested head'() {
    const { fx, tested, trainId } = trainFx();
    const c = cleanViews(tested);
    const { gh, calls } = scriptedGh({ views: c.views, checks: [['pending'], ['pass']], onMerge: c.onMerge });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), ...APPROVE });
    return snap(fx, trainId, { tested }, calls, r);
  },
  'behind: update-branch, proves the updated head, merges it'() {
    const { fx, tested, trainId } = trainFx();
    let u = null; let state = 'behind'; let merged = false;
    const { gh, calls } = scriptedGh({
      views: () => (merged ? view(u, MERGED()) : state === 'behind' ? view(tested, { mergeStateStatus: 'BEHIND' }) : view(u)),
      checks: [['missing'], ['pending'], ['pass']],
      onUpdate: () => { u = updatedHead(fx, tested); state = 'updated'; return ok({}); },
      onMerge: () => { merged = true; return ok(); },
    });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), ...APPROVE });
    return snap(fx, trainId, { tested, updated: u }, calls, r);
  },
  'foreign content in the updated head stops the run'() {
    const { fx, tested, trainId } = trainFx();
    let u = null; let state = 'behind';
    const { gh, calls } = scriptedGh({
      views: () => (state === 'behind' ? view(tested, { mergeStateStatus: 'BEHIND' }) : view(u)),
      onUpdate: () => { u = updatedHead(fx, tested, { foreign: true }); state = 'updated'; return ok({}); },
    });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), ...APPROVE });
    return snap(fx, trainId, { tested, updated: u }, calls, r);
  },
  'crash after update-branch: resume proves the head and lands'() {
    const { fx, tested, trainId } = trainFx();
    let u = null; let state = 'behind';
    const first = scriptedGh({ views: () => (state === 'behind' ? view(tested, { mergeStateStatus: 'BEHIND' }) : view(tested)), onUpdate: () => { u = updatedHead(fx, tested); state = 'sent'; return ok({}); } });
    const r1 = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(first.gh), ...APPROVE });
    let merged = false;
    const second = scriptedGh({ views: () => (merged ? view(u, MERGED()) : view(u)), onMerge: () => { merged = true; return ok(); } });
    const r2 = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(second.gh), sleep: () => {}, timings: fast });
    const labels = { tested, updated: u };
    return { first: snap(fx, trainId, labels, first.calls, r1), second: snap(fx, trainId, labels, second.calls, r2) };
  },
  'DIRTY stops with the restack remedy'() {
    const { fx, tested, trainId } = trainFx();
    const { gh, calls } = scriptedGh({ views: () => view(tested, { mergeStateStatus: 'DIRTY' }) });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), ...APPROVE });
    return snap(fx, trainId, { tested }, calls, r);
  },
  'a never-registered required check times out by name'() {
    const { fx, tested, trainId } = trainFx();
    const { gh, calls } = scriptedGh({ views: () => view(tested), checks: [['missing']] });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, timeoutMs: 30 });
    return snap(fx, trainId, { tested }, calls, r);
  },
  'a failed required check stops the run'() {
    const { fx, tested, trainId } = trainFx();
    const { gh, calls } = scriptedGh({ views: () => view(tested), checks: [['fail']] });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), ...APPROVE });
    return snap(fx, trainId, { tested }, calls, r);
  },
  'an unreadable PR view stops the run'() {
    const { fx, tested, trainId } = trainFx();
    const { gh, calls } = scriptedGh({ views: () => view(tested) });
    const bad = (args) => (args[0] === 'pr' && args[1] === 'view' ? { ok: false, status: 1, stdout: '', stderr: 'boom', reason: 'gh failed' } : gh(args));
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(bad), ...APPROVE });
    return snap(fx, trainId, { tested }, calls, r);
  },
  'a closed PR, a draft and a retarget each stop the run'() {
    const out = {};
    for (const [k, over] of [['closed', { state: 'CLOSED' }], ['draft', { isDraft: true }], ['retargeted', { baseRefName: 'other' }]]) {
      const { fx, tested, trainId } = trainFx();
      const { gh, calls } = scriptedGh({ views: () => view(tested, over) });
      out[k] = snap(fx, trainId, { tested }, calls, approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), ...APPROVE }));
    }
    return out;
  },
  'a PR merged outside the run, at an unaccounted head, stops the run'() {
    const { fx, tested, trainId } = trainFx();
    const { gh, calls } = scriptedGh({ views: () => view('c'.repeat(40), MERGED()) });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), ...APPROVE });
    return snap(fx, trainId, { tested }, calls, r);
  },
  'a PR already merged at the tested head is observed, not re-merged'() {
    const { fx, tested, trainId } = trainFx();
    const { gh, calls } = scriptedGh({ views: () => view(tested, MERGED()) });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), ...APPROVE });
    return snap(fx, trainId, { tested }, calls, r);
  },
  'a merge call that fails stops the run'() {
    const { fx, tested, trainId } = trainFx();
    const { gh, calls } = scriptedGh({ views: () => view(tested), onMerge: () => ({ ok: false, status: 1, stdout: '', stderr: 'not mergeable', reason: 'gh failed' }) });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), ...APPROVE });
    return snap(fx, trainId, { tested }, calls, r);
  },
  'a merge that is accepted but never observed stops the run'() {
    const { fx, tested, trainId } = trainFx();
    const { gh, calls } = scriptedGh({ views: () => view(tested), onMerge: () => ok() });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), ...APPROVE });
    return snap(fx, trainId, { tested }, calls, r);
  },
  'a second runner is refused while the lease is held'() {
    const { fx, tested, trainId } = trainFx();
    const dirty = scriptedGh({ views: () => view(tested, { mergeStateStatus: 'DIRTY' }) });
    approveSerial({ cwd: fx.repo, trainId, deps: depsWith(dirty.gh), ...APPROVE });
    fs.writeFileSync(path.join(fleetDirOf(fx), 'serial', `${trainId}.lock`), JSON.stringify({ pid: process.pid, token: 'x', at: Date.now() }));
    const r = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(dirty.gh), sleep: () => {}, timings: fast });
    return snap(fx, trainId, { tested }, dirty.calls, r);
  },
  'messageFor: absent, null and a message produce the pinned merge argv'() {
    const out = {};
    for (const [k, mf] of [['absent', undefined], ['null', () => null], ['message', () => ({ subject: 'feat: the thing (#21)', body: 'body line\n\nAI-Skill: ship\n' })]]) {
      const { fx, tested, trainId } = trainFx();
      const c = cleanViews(tested);
      const { gh, calls } = scriptedGh({ views: c.views, onMerge: c.onMerge });
      const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), ...APPROVE, ...(mf ? { messageFor: mf } : {}) });
      out[k] = snap(fx, trainId, { tested }, calls, r);
    }
    return out;
  },
  'messageFor: a stop, a throw and bad shapes each stop before the merge'() {
    const out = {};
    const cases = [['stop', () => ({ stop: 'no run covers this head' })], ['throw', () => { throw new Error('store exploded'); }], ['empty-subject', () => ({ subject: '', body: 'b' })],
      ['multiline', () => ({ subject: 'two\nlines', body: 'b' })], ['nul-body', () => ({ subject: 's', body: 'b\0' })], ['no-body', () => ({ subject: 's' })], ['string', () => 'a string'], ['null', () => null]];
    for (const [k, mf] of cases) {
      const { fx, tested, trainId } = trainFx();
      const { gh, calls } = scriptedGh({ views: () => view(tested) });
      out[k] = snap(fx, trainId, { tested }, calls, approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), ...APPROVE, messageFor: mf }));
    }
    return out;
  },
  'messageRequired: a run approved with a provider cannot resume without one'() {
    const { fx, tested, trainId } = trainFx();
    const gh1 = scriptedGh({ views: () => view(tested, { mergeStateStatus: 'DIRTY' }) });
    const r1 = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh1.gh), ...APPROVE, messageFor: () => ({ subject: 's (#21)', body: 'b' }) });
    const gh2 = scriptedGh({ views: () => view(tested) });
    const raw = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(gh2.gh), sleep: () => {}, timings: fast });
    let merged = false;
    const gh3 = scriptedGh({ views: () => (merged ? view(tested, MERGED()) : view(tested)), onMerge: () => { merged = true; return ok(); } });
    const again = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(gh3.gh), sleep: () => {}, timings: fast, messageFor: () => ({ subject: 's (#21)', body: 'b' }) });
    return { approved: snap(fx, trainId, { tested }, gh1.calls, r1), raw: snap(fx, trainId, { tested }, gh2.calls, raw), again: snap(fx, trainId, { tested }, gh3.calls, again) };
  },
  'crash before and after the merge submission: the retry observes or re-decides'() {
    const CRASH = new Error('simulated process death');
    const before = trainFx();
    const g1 = scriptedGh({ views: () => view(before.tested), onMerge: () => { throw CRASH; } });
    let thrown = null;
    try { approveSerial({ cwd: before.fx.repo, trainId: before.trainId, deps: depsWith(g1.gh), ...APPROVE }); } catch (e) { thrown = e.message; }
    let merged = false;
    const g2 = scriptedGh({ views: () => (merged ? view(before.tested, MERGED()) : view(before.tested)), onMerge: () => { merged = true; return ok(); } });
    const r2 = resumeSerial({ cwd: before.fx.repo, trainId: before.trainId, deps: depsWith(g2.gh), sleep: () => {}, timings: fast });
    const after = trainFx();
    let m2 = false;
    const g3 = scriptedGh({ views: () => (m2 ? view(after.tested, MERGED()) : view(after.tested)), onMerge: () => { m2 = true; throw CRASH; } });
    let thrown2 = null;
    try { approveSerial({ cwd: after.fx.repo, trainId: after.trainId, deps: depsWith(g3.gh), ...APPROVE }); } catch (e) { thrown2 = e.message; }
    const g4 = scriptedGh({ views: () => view(after.tested, MERGED()) });
    const r4 = resumeSerial({ cwd: after.fx.repo, trainId: after.trainId, deps: depsWith(g4.gh), sleep: () => {}, timings: fast });
    return {
      beforeThrown: thrown, beforeRetry: snap(before.fx, before.trainId, { tested: before.tested }, g2.calls, r2),
      afterThrown: thrown2, afterRetry: snap(after.fx, after.trainId, { tested: after.tested }, g4.calls, r4),
    };
  },
};

const generated = process.env.UPDATE_GOLDEN === '1';
const golden = (() => { try { return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); } catch { return null; } })();

describe('serial runner: byte identity with origin/main (golden)', () => {
  if (generated) {
    it('UPDATE_GOLDEN=1: writes the fixture from the code under test', () => {
      const scenarios = {};
      for (const [name, fn] of Object.entries(SCENARIOS)) scenarios[name] = fn();
      const header = { _source: process.env.GOLDEN_SOURCE ?? 'unspecified', _command: 'UPDATE_GOLDEN=1 GOLDEN_SOURCE=<sha> node --test tests/fleet-serial-golden.test.mjs', _baseline: 'd53272aa1484', _note: "Pinned from origin/main d53272aa (the member-outcome refactor, #395). Regenerated ONCE for ci-evidence-oracle PR 2: only the argv entries of the OLD CI reads (pr checks, api rules/branches, pr view headRefOid) leave the lists, and two CI stop reasons change (a failed required check; a never-registered required check). Every other scenario, every merge argv included, is byte-identical to d53272aa (verified by a scripted diff, recorded in docs/plans/ci-evidence-oracle.md Implementation Log). Regenerated once more for fleet-train-landing-friction (PR 532): each tier result gains reasonCode only (every scenario here is green, so reasonCode green); no argv, stop reason or record field changed. Regenerate again only with the same discipline." };
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, `${JSON.stringify({ ...header, scenarios }, null, 2)}\n`);
    });
    return;
  }
  it('the fixture exists and names its source', () => {
    assert.ok(golden, 'tests/fixtures/fleet-serial-golden.json is missing');
    assert.match(golden._source, /^[0-9a-f]{12,40}$/, 'the fixture header must name the origin/main commit it was generated from');
    assert.deepEqual(Object.keys(golden.scenarios).sort(), Object.keys(SCENARIOS).sort(), 'scenario set differs from the fixture');
  });
  for (const [name, fn] of Object.entries(SCENARIOS)) {
    it(name, () => {
      assert.ok(golden, 'no fixture');
      assert.deepEqual(fn(), golden.scenarios[name]);
    });
  }
  it('the tested head carries a fixed PAST committer date, so the landing `commit -C <tested>` candidate can never equal it (CI flake: <tested> vs <oid>)', () => {
    // train.mjs builds the candidate from `tested` with `merge --squash` + `commit -C <tested>`: same parent, tree, author, author date,
    // message and committer identity, so only the committer date (1 s resolution) is free. Reproduced here without the race by
    // committing the candidate under a chosen date.
    const { fx, tested } = trainFx();
    const candidateAt = (date) => {
      git(['checkout', '-q', '--detach', 'main'], fx.repo);
      git(['merge', '--squash', '-q', tested], fx.repo);
      git(['commit', '-q', '--no-verify', '--allow-empty', '-C', tested], fx.repo, { GIT_COMMITTER_DATE: date });
      const oid = git(['rev-parse', 'HEAD'], fx.repo);
      git(['reset', '-q', '--hard', 'main'], fx.repo); git(['checkout', '-q', 'main'], fx.repo);
      return oid;
    };
    const testedDate = git(['show', '-s', '--format=%cI', tested], fx.repo);
    assert.equal(testedDate, '2026-01-01T00:00:00Z', 'tested carries the fixed past committer date');
    // Positive control (the mechanism): the same second reproduces tested's oid exactly, which is what the normaliser mislabels `<tested>`.
    assert.equal(candidateAt('2026-01-01T00:00:00Z'), tested, 'a candidate committed in the same second IS the tested oid');
    // The pin: any real `land` happens after it, so the candidate always differs.
    assert.notEqual(candidateAt(new Date().toISOString().replace(/\.\d+Z$/, 'Z')), tested);
  });
  it('negative control: a one-character change to a stop reason is detected', () => {
    const scenarioName = 'DIRTY stops with the restack remedy';
    const real = golden.scenarios[scenarioName];
    const mutated = JSON.parse(JSON.stringify(real).replace('conflicts with', 'conflict with'));
    assert.notDeepEqual(mutated, real, 'the mutation must change the snapshot');
    assert.throws(() => assert.deepEqual(mutated, real));
    assert.match(JSON.stringify(real), /conflicts with/, 'the pinned reason is really in the snapshot');
  });
});
