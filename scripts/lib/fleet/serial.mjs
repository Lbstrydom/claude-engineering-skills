/**
 * @fileoverview `land --approve <trainId> --serial` — land a pr-mode train ONE PR
 * at a time, the way repos with a strict "branch must be up to date" rule have to:
 * per PR, in landing order, update the branch if it is behind, wait until every
 * REQUIRED check has actually run and passed on the new head, merge exactly that
 * head, observe it merged, then the next.
 *
 * Honest about what it lands: each PR merges at a head GitHub's CI tested, which
 * may differ from the locally tested train candidate. The human approval is the
 * same `--approve` and covers the whole sequence.
 *
 * Durable and resumable:
 *  - progress lives in a NEW file, `fleet/serial/<trainId>.json` (strict schema,
 *    v1) — `TrainSchema` and older readers are untouched;
 *  - every remote step is written as an INTENT before it is taken and as a RESULT
 *    after, so `land --resume <trainId>` re-enters at the recorded step and an
 *    already-merged PR is observed, never re-merged;
 *  - a per-train lease (`serial/<trainId>.lock`) is held for the run; each train
 *    transition is a short `trains/.lock` section, so other trains stay landable;
 *  - a head this run cannot account for (not the tested head, not an update it
 *    made — checked by ancestry AND by re-deriving the merge tree) stops the run
 *    for a fresh approval.
 *
 * Plan: docs/plans/fleet-consumer-feedback-oct.md §2.5.
 *
 * @module scripts/lib/fleet/serial
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { withFileLockSync } from '../file-lock.mjs';
import { OID_RE } from './contracts.mjs';
import { TRAIN_ID_RE, assertManaged, fleetDir, readTrain } from './registry.mjs';
import { approvable } from './overlap.mjs';
import { branchOfRef, defaultDeps, patchTrain, withTrainLock } from './train.mjs';
import { verifyFacts } from './train-approve.mjs';
import { describeVerdict, observeRequiredChecks, requiredInventory } from './required-checks.mjs';
import { renderCommand } from './shell-quote.mjs';

/** The restack remedy, rendered shell-safe (a branch name is data, never shell syntax). */
const restackCmd = (id) => renderCommand(['fleet', 'restack', id]);

export const SERIAL_POLL_MS = 30_000;
export const UPDATE_POLL_MS = 2_000;
export const UPDATE_WAIT_MS = 60_000;
export const MERGE_WAIT_MS = 120_000;
export const MAX_UPDATES_PER_PR = 3;
/** Fields serial reads with `gh pr view` (all real — see the recorded fixture). */
export const SERIAL_VIEW_FIELDS = Object.freeze(['state', 'isDraft', 'headRefOid', 'baseRefName', 'mergeStateStatus', 'mergeCommit', 'url']);

const Oid = z.string().regex(OID_RE);
const Iso = z.string().refine((s) => Number.isFinite(Date.parse(s)), 'must be an ISO timestamp');
const STEPS = ['pending', 'update', 'wait', 'merge', 'merged'];

export const SerialStepSchema = z.strictObject({
  id: z.string().min(1), prNumber: z.number().int().positive(), repo: z.string().min(1),
  testedOid: Oid, step: z.enum(STEPS), head: Oid,
  accounted: z.array(Oid), // every head this run can vouch for: the tested one and each update it made
  updates: z.number().int().min(0),
  priorHead: Oid.nullable(), mergedOid: Oid.nullable(), note: z.string().max(1000).nullable(), at: Iso,
});
export const SerialRunSchema = z.strictObject({
  schemaVersion: z.literal(1), trainId: z.string().regex(TRAIN_ID_RE), startedAt: Iso, updatedAt: Iso,
  timeoutMs: z.number().int().positive(), base: z.string().min(1), remote: z.string().min(1),
  steps: z.array(SerialStepSchema).min(1),
  outcome: z.strictObject({ status: z.enum(['landed', 'stopped']), reason: z.string().max(2000), at: Iso }).nullable(),
});

const serialDir = (dir) => path.join(dir, 'serial');
const serialPath = (dir, id) => assertManaged(dir, path.join(serialDir(dir), `${id}.json`));

/** @returns {{ok: true, run: object} | {ok: false, reason: string, absent?: boolean}} */
export function readSerial(dir, trainId) {
  let text;
  try { text = fs.readFileSync(serialPath(dir, trainId), 'utf-8'); } catch (e) { return { ok: false, absent: e.code === 'ENOENT', reason: e.code === 'ENOENT' ? 'no serial run' : `unreadable: ${e.message}` }; }
  try {
    const raw = JSON.parse(text);
    if (raw?.schemaVersion !== 1) return { ok: false, reason: `serial record schemaVersion ${JSON.stringify(raw?.schemaVersion)} is not understood by this fleet` };
    const r = SerialRunSchema.safeParse(raw);
    return r.success ? { ok: true, run: r.data } : { ok: false, reason: `schema: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
  } catch (e) { return { ok: false, reason: `malformed JSON: ${e.message}` }; }
}

function writeSerial(dir, run) {
  const r = SerialRunSchema.parse(run);
  fs.mkdirSync(serialDir(dir), { recursive: true });
  atomicWriteFileSync(serialPath(dir, r.trainId), `${JSON.stringify(r, null, 2)}\n`);
  return r;
}

function ghJson(deps, cwd, args) {
  const r = deps.gh(args, cwd);
  if (!r.ok) return { ok: false, reason: r.reason ?? 'gh failed', stderr: r.stderr ?? '' };
  try { return { ok: true, doc: JSON.parse(r.stdout || 'null') }; } catch { return { ok: false, reason: 'gh returned unparseable JSON' }; }
}

const viewPr = (deps, cwd, s) => ghJson(deps, cwd, ['pr', 'view', String(s.prNumber), '-R', s.repo, '--json', SERIAL_VIEW_FIELDS.join(',')]);
const short = (o) => String(o ?? '?').slice(0, 12);

/**
 * Bring PR `s`'s head and the base into local objects, then decide whether head
 * `h` is THIS run's own update of `priorHead`: two parents, the first `priorHead`,
 * the second an ancestor of the base, and the head's tree equal to a clean,
 * reproducible merge of the two. Acquisition failures are `unverifiable`
 * (resumable); a failed proof is `foreign`.
 * @returns {{verdict: 'own'|'foreign'|'unverifiable', reason?: string}}
 */
export function classifyUpdatedHead({ deps, cwd, s, run, h, priorHead }) {
  // Run-scoped refs (no other train or run writes them), read ONCE into immutable oids that every
  // later check uses — a concurrent fetch can never swap the base out from under the proof.
  const scope = `refs/fleet/serial/${run.trainId}`;
  const prRef = `${scope}/pr-${s.prNumber}`;
  const baseRef = `${scope}/base`;
  const f = deps.git(['fetch', '--no-tags', run.remote, `+refs/pull/${s.prNumber}/head:${prRef}`, `+refs/heads/${run.base}:${baseRef}`], cwd, { timeoutMs: 120_000 });
  if (!f.ok) return { verdict: 'unverifiable', reason: `could not fetch the PR head and base: ${f.reason}` };
  const got = deps.git(['rev-parse', prRef, baseRef], cwd);
  const [prOid, baseOid] = got.ok ? got.stdout.trim().split(/\s+/) : [];
  if (!prOid || !baseOid) return { verdict: 'unverifiable', reason: `cannot read the fetched refs: ${got.reason ?? 'missing'}` };
  if (prOid !== h) return { verdict: 'unverifiable', reason: `fetched PR head is ${short(prOid)}, not the observed head ${short(h)}` };
  const parents = deps.git(['rev-list', '--parents', '-n', '1', h], cwd);
  if (!parents.ok) return { verdict: 'unverifiable', reason: `cannot read the parents of ${short(h)}: ${parents.reason}` };
  const [, p1, p2, ...more] = parents.stdout.trim().split(/\s+/);
  if (!p2 || more.length) return { verdict: 'foreign', reason: `${short(h)} is not a two-parent merge` };
  if (p1 !== priorHead) return { verdict: 'foreign', reason: `${short(h)}'s first parent is ${short(p1)}, not ${short(priorHead)}` };
  const anc = deps.git(['merge-base', '--is-ancestor', p2, baseOid], cwd);
  if (anc.status === 1) return { verdict: 'foreign', reason: `${short(h)}'s second parent ${short(p2)} is not on ${run.base}` };
  if (anc.status !== 0) return { verdict: 'unverifiable', reason: `cannot check ancestry: ${anc.reason}` };
  const mt = deps.git(['merge-tree', '--write-tree', p1, p2], cwd);
  if (mt.status === 1) return { verdict: 'foreign', reason: `re-deriving ${short(h)} conflicts; it is not a clean update` };
  if (!mt.ok) return { verdict: 'unverifiable', reason: `git merge-tree --write-tree unavailable or failed (needs git >= 2.38): ${mt.reason}` };
  const tree = deps.git(['rev-parse', `${h}^{tree}`], cwd);
  if (!tree.ok) return { verdict: 'unverifiable', reason: `cannot read the tree of ${short(h)}` };
  return mt.stdout.trim().split('\n')[0] === tree.stdout.trim() ? { verdict: 'own' } : { verdict: 'foreign', reason: `${short(h)} carries content beyond a clean merge of the base` };
}

/**
 * Run (or resume) the serial loop for `trainId`. Never throws for remote
 * failures: each stop is recorded with its reason and is resumable.
 * @param {{cwd: string, trainId: string, deps?: object, requiredChecks?: string[], requiredChecksError?: string|null,
 *   sleep?: (ms: number) => void, timings?: object}} a
 */
export function runSerial({ cwd, trainId, deps = defaultDeps(), requiredChecks, requiredChecksError = null, sleep = sleepMs, timings = {} }) {
  const dir = fleetDir(cwd);
  const T = { poll: SERIAL_POLL_MS, updatePoll: UPDATE_POLL_MS, updateWait: UPDATE_WAIT_MS, mergeWait: MERGE_WAIT_MS, ...timings };
  const lease = withFileLockSync(path.join(serialDir(dir), `${trainId}.lock`), { attempts: 1 }, () => loop({ cwd, dir, trainId, deps, requiredChecks, requiredChecksError, sleep, T }));
  if (!lease.ok) return { ok: false, code: 'error', reason: `another process is landing ${trainId} serially (serial/${trainId}.lock is held)` };
  return lease.value;
}

function loop({ cwd, dir, trainId, deps, requiredChecks, requiredChecksError, sleep, T }) {
  let run = readSerial(dir, trainId);
  if (!run.ok) return { ok: false, code: 'refused', reason: `train ${trainId}: ${run.reason}` };
  run = run.run;
  const now = () => deps.now().toISOString();
  const save = (patch) => { run = writeSerial(dir, { ...run, ...patch, updatedAt: now() }); return run; };
  const setStep = (i, patch) => save({ steps: run.steps.map((s, j) => (j === i ? { ...s, ...patch, at: now() } : s)) });
  // A stop KEEPS the step it happened in (an 'update' intent must survive to be recognised on resume);
  // only the note and the run outcome record why.
  const stop = (i, reason) => {
    if (i !== null) setStep(i, { note: reason });
    save({ outcome: { status: 'stopped', reason, at: now() } });
    return { ok: false, code: 'refused', reason, trainId, run, resumable: true };
  };
  if (run.outcome?.status === 'landed') return { ok: true, code: 'ok', trainId, run, landed: true };
  if (run.outcome) save({ outcome: null }); // a resumed stop re-enters
  const inventory = new Map();
  const invFor = (repo) => {
    if (!inventory.has(repo)) inventory.set(repo, requiredInventory(cwd, { repo, base: run.base, configured: requiredChecks, configError: requiredChecksError, gh: deps.gh }));
    return inventory.get(repo);
  };
  for (let i = 0; i < run.steps.length; i += 1) {
    if (run.steps[i].step === 'merged') continue;
    if (run.steps[i].note) setStep(i, { note: null });
    for (;;) {
      const s = run.steps[i];
      if (s.step === 'merged') break;
      const v = viewPr(deps, cwd, s);
      if (!v.ok) return stop(i, `PR #${s.prNumber}: cannot read it (${v.reason})`);
      const d = v.doc;
      if (String(d.state).toUpperCase() === 'MERGED') {
        if (!s.accounted.includes(d.headRefOid)) return stop(i, `PR #${s.prNumber} was merged at ${short(d.headRefOid)}, a head this run did not account for — check it by hand`);
        setStep(i, { step: 'merged', mergedOid: d.mergeCommit?.oid ?? null, head: d.headRefOid });
        break;
      }
      if (String(d.state).toUpperCase() !== 'OPEN') return stop(i, `PR #${s.prNumber} is ${d.state}`);
      if (d.isDraft === true) return stop(i, `PR #${s.prNumber} is a draft`);
      if (d.baseRefName !== run.base) return stop(i, `PR #${s.prNumber} now targets ${d.baseRefName}, not ${run.base}`);
      const h = d.headRefOid;
      if (!s.accounted.includes(h)) {
        // Only an interrupted update of ours can explain a new head; prove it or stop.
        if (s.step !== 'update' || !s.priorHead) return stop(i, `PR #${s.prNumber} head ${short(h)} is not one this run accounts for — someone pushed; approve a new train`);
        if (h === s.priorHead) { setStep(i, { step: 'pending' }); continue; } // the update never applied
        const c = classifyUpdatedHead({ deps, cwd, s, run, h, priorHead: s.priorHead });
        if (c.verdict === 'unverifiable') return stop(i, `PR #${s.prNumber}: could not verify the updated head (acquisition): ${c.reason}`);
        if (c.verdict === 'foreign') return stop(i, `PR #${s.prNumber}: head ${short(h)} is UNACCOUNTED (${c.reason}) — approve a new train`);
        setStep(i, { step: 'wait', head: h, accounted: [...s.accounted, h] });
        continue;
      }
      const ms = String(d.mergeStateStatus ?? '').toUpperCase();
      if (ms === 'DIRTY') return stop(i, `PR #${s.prNumber} now conflicts with ${run.base} — run \`${restackCmd(s.id)}\` and push, then --resume`);
      if (ms === 'BEHIND') {
        if (s.updates >= MAX_UPDATES_PER_PR) return stop(i, `PR #${s.prNumber} fell behind ${run.base} ${s.updates} times; the base is moving too fast — resume later`);
        setStep(i, { step: 'update', priorHead: h, head: h });
        const u = deps.gh(['api', '-X', 'PUT', `repos/${s.repo}/pulls/${s.prNumber}/update-branch`, '-f', `expected_head_sha=${h}`], cwd);
        if (!u.ok) {
          if (/merge conflict|422/i.test(`${u.stderr ?? ''} ${u.reason ?? ''}`)) return stop(i, `PR #${s.prNumber} cannot be updated (merge conflict) — run \`${restackCmd(s.id)}\` and push, then --resume`);
          return stop(i, `PR #${s.prNumber}: update-branch failed (${u.reason})`);
        }
        // GitHub builds the merge commit in the background (202 Accepted): poll for the new head.
        const until = Date.now() + T.updateWait;
        let newHead = null;
        for (;;) {
          const w = viewPr(deps, cwd, s);
          if (w.ok && w.doc.headRefOid && w.doc.headRefOid !== h) { newHead = w.doc.headRefOid; break; }
          if (Date.now() >= until) break;
          sleep(T.updatePoll);
        }
        if (!newHead) return stop(i, `PR #${s.prNumber}: update not yet visible after ${Math.round(T.updateWait / 1000)}s — --resume to continue`);
        setStep(i, { updates: s.updates + 1 });
        continue; // the next pass proves the new head is ours and moves to wait
      }
      // ── wait for required checks on this exact head ──
      if (run.steps[i].step !== 'wait' && run.steps[i].step !== 'merge') setStep(i, { step: 'wait', head: h });
      const deadline = Date.now() + run.timeoutMs;
      let verdict;
      for (;;) {
        verdict = observeRequiredChecks(cwd, { pr: s.prNumber, repo: s.repo, inventory: invFor(s.repo), expectHead: h, gh: deps.gh });
        if (verdict.verdict === 'pass' || verdict.verdict === 'none-required') break;
        if (verdict.verdict === 'failed' || verdict.verdict === 'not-run') return stop(i, `PR #${s.prNumber} required checks ${describeVerdict(verdict)}`);
        if (verdict.headOid && verdict.headOid !== h) break; // the head moved: re-verify from the top
        if (verdict.inventory?.source === 'unknown') return stop(i, `PR #${s.prNumber}: ${verdict.reason}`);
        if (Date.now() >= deadline) {
          const missing = verdict.names?.missing ?? [];
          return stop(i, `PR #${s.prNumber}: required checks still ${verdict.verdict} after ${Math.round(run.timeoutMs / 60_000)} min (${describeVerdict(verdict)}${missing.length ? `; never registered on ${short(h)}: ${missing.join(', ')}` : ''}) — --resume to keep waiting`);
        }
        sleep(T.poll);
      }
      if (verdict.headOid && verdict.headOid !== h) continue;
      // ── merge exactly this head ──
      const again = viewPr(deps, cwd, s);
      if (!again.ok || again.doc.headRefOid !== h) continue;
      if (String(again.doc.mergeStateStatus ?? '').toUpperCase() === 'BEHIND') continue; // the base moved while we waited
      setStep(i, { step: 'merge', head: h });
      const m = deps.gh(['pr', 'merge', String(s.prNumber), '-R', s.repo, '--squash', '--match-head-commit', h], cwd);
      const until = Date.now() + T.mergeWait;
      for (;;) {
        const o = viewPr(deps, cwd, s);
        if (o.ok && String(o.doc.state).toUpperCase() === 'MERGED') { setStep(i, { step: 'merged', mergedOid: o.doc.mergeCommit?.oid ?? null }); break; }
        if (Date.now() >= until) {
          return stop(i, m.ok
            ? `PR #${s.prNumber}: merge accepted but not observed merged after ${Math.round(T.mergeWait / 1000)}s — check branch rules / merge queue, then --resume`
            : `PR #${s.prNumber}: gh pr merge failed (${m.reason})`);
        }
        sleep(Math.min(T.updatePoll * 2, 5_000));
      }
    }
  }
  save({ outcome: { status: 'landed', reason: 'every PR observed merged', at: now() } });
  return { ok: true, code: 'ok', trainId, run, landed: true };
}

/**
 * `land --approve <trainId> --serial`: approval eligibility and the recorded facts
 * are verified exactly as for any approval, the train moves to `awaiting-merge`,
 * the serial record is created, and the loop runs. Re-entering a stopped run is
 * `land --resume <trainId>`.
 */
export function approveSerial({ cwd, trainId, acceptRerun = false, requiredChecks, requiredChecksError = null, deps = defaultDeps(), sleep, timings, timeoutMs }) {
  const dir = fleetDir(cwd);
  const start = withTrainLock(dir, () => {
    const r = readTrain(dir, trainId);
    if (!r.ok) return { ok: false, code: 'refused', reason: `train ${trainId}: ${r.reason}` };
    const t = r.train;
    if (t.mergeMethod !== 'pr') return { ok: false, code: 'refused', reason: `--serial lands PRs one at a time; train ${trainId} is ${t.mergeMethod}` };
    const elig = approvable(t, { acceptRerun });
    if (!elig.ok) return { ok: false, code: 'refused', reason: elig.reason, needsAcceptRerun: elig.needsAcceptRerun === true };
    const shallow = deps.git(['rev-parse', '--is-shallow-repository'], cwd);
    if (!shallow.ok || shallow.stdout.trim() !== 'false') return { ok: false, code: 'refused', reason: 'serial landing needs full history to verify updated heads; this clone is shallow (or git could not say) — git fetch --unshallow' };
    if (readSerial(dir, trainId).ok) return { ok: false, code: 'refused', reason: `a serial run already exists for ${trainId} — use land --resume ${trainId}` };
    const ver = verifyFacts({ cwd, train: t, dir, deps });
    if (!ver.ok) return { ok: false, code: 'refused', reason: ver.reason };
    const stamp = deps.now().toISOString();
    writeSerial(dir, {
      schemaVersion: 1, trainId, startedAt: stamp, updatedAt: stamp, timeoutMs: timeoutMs ?? 60 * 60 * 1000,
      base: branchOfRef(t.destination.ref), remote: t.destination.remote, outcome: null,
      steps: t.sources.map((src) => ({
        id: src.id, prNumber: src.prNumber, repo: src.repo, testedOid: src.oid, step: 'pending', head: src.oid, accounted: [src.oid],
        updates: 0, priorHead: null, mergedOid: null, note: null, at: stamp,
      })),
    });
    patchTrain(dir, trainId, { phase: 'awaiting-merge' }, deps);
    return { ok: true };
  });
  if (!start.ok) return start;
  return finishSerial({ cwd, dir, trainId, deps, r: runSerial({ cwd, trainId, deps, requiredChecks, requiredChecksError, ...(sleep ? { sleep } : {}), ...(timings ? { timings } : {}) }) });
}

/** `land --resume <trainId>` for a train that has a serial run. */
export function resumeSerial({ cwd, trainId, requiredChecks, requiredChecksError = null, deps = defaultDeps(), sleep, timings }) {
  const dir = fleetDir(cwd);
  return finishSerial({ cwd, dir, trainId, deps, r: runSerial({ cwd, trainId, deps, requiredChecks, requiredChecksError, ...(sleep ? { sleep } : {}), ...(timings ? { timings } : {}) }) });
}

function finishSerial({ dir, trainId, deps, r }) {
  if (!r.landed) return r;
  const t = withTrainLock(dir, () => {
    const cur = readTrain(dir, trainId);
    if (!cur.ok || cur.train.phase === 'landed') return cur.ok ? cur.train : null;
    return patchTrain(dir, trainId, {
      phase: 'landed',
      outcome: { serial: true, merges: r.run.steps.map((s) => ({ id: s.id, prNumber: s.prNumber, testedOid: s.testedOid, mergedHead: s.head, mergeCommit: s.mergedOid })), landedAt: deps.now().toISOString() },
    }, deps);
  });
  return { ...r, train: t };
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
