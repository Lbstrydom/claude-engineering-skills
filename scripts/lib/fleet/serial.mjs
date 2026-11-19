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
 * An optional `messageFor` seam (docs/plans/ship-trains.md §2.4) lets a caller
 * choose each squash commit's subject and body at merge time, on the exact head
 * being merged. See {@link MessageFor}. Absent, the merge call is byte-identical.
 *
 * A run MAY carry a persisted `policy` (docs/plans/ship-batch-member-outcomes.md): the ship-batch and rollup landings. Under a
 * policy each member has an `outcome` beside its phase, the member step cannot stop the run (it returns a closed result), and
 * the pure decisions live in `member-outcome.mjs`. Without a policy nothing below changes a byte of today's behaviour
 * (`tests/fleet-serial-golden.test.mjs`).
 *
 * @module scripts/lib/fleet/serial
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { retrySync } from '../retry-transient-fs.mjs';
import { withFileLockSync } from '../file-lock.mjs';
import { OID_RE } from './contracts.mjs';
import { TRAIN_ID_RE, assertManaged, fleetDir, readTrain } from './registry.mjs';
import { approvable } from './overlap.mjs';
import { branchOfRef, defaultDeps, patchTrain, withTrainLock } from './train.mjs';
import { verifyFacts } from './train-approve.mjs';
import { askCiOracle, decideCiAdmission, describeEvidence } from './required-checks.mjs';
import { readBranchRules } from './github-ci-facts.mjs';
import { renderCommand } from './shell-quote.mjs';
import {
  AttemptSchema, CHAIN_VERDICTS, FAULTS, FinalizedSchema, HALT_VERDICTS, HaltSchema, MAX_HEAD_CHURN, OutcomeSchema, PolicySchema,
  classifyMerged, isTerminal, summariseRun, validatePolicyRun, verdictOf,
} from './member-outcome.mjs';

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
  // Written ONLY under a policy (absent on every other run, so every other record keeps its bytes).
  outcome: OutcomeSchema.nullable().optional(), attempt: AttemptSchema.optional(),
});
export const SerialRunSchema = z.strictObject({
  schemaVersion: z.literal(1), trainId: z.string().regex(TRAIN_ID_RE), startedAt: Iso, updatedAt: Iso,
  timeoutMs: z.number().int().positive(), base: z.string().min(1), remote: z.string().min(1),
  // Set once, at approval, by a caller that supplied `messageFor`: the run may then only merge WITH a
  // message, so a later resume that lacks the provider cannot silently merge unmessaged. Absent on every
  // other run (and in every pre-existing record), which behave exactly as before.
  messageRequired: z.literal(true).optional(),
  steps: z.array(SerialStepSchema).min(1),
  // Policy runs only: the persisted policy, the chain-invalidating halt, and the finalization marker (§2.1 invariants 6 and 7).
  policy: PolicySchema.optional(), halt: HaltSchema.optional(), finalized: FinalizedSchema.optional(),
  outcome: z.strictObject({ status: z.enum(['landed', 'stopped']), reason: z.string().max(2000), at: Iso }).nullable(),
});

/**
 * @callback MessageFor
 * Called once per PR, immediately before its merge, with the head that is about to
 * be merged (AFTER any update-branch this run made) and the base tip observed just
 * now (`null` when it could not be read). A resumed run calls it again on the
 * current head, so no message is ever replayed.
 * @param {{source: object, headOid: string, baseOid: string|null}} a
 * @returns {{subject: string, body: string} | {stop: string} | null | undefined}
 *   `null`/`undefined`: merge as today. `{stop}`: end the run BEFORE this merge with that
 *   reason recorded. A throw, or any other shape, also stops the run: a caller that
 *   asked for a message must never get an unmessaged merge by accident.
 */

const serialDir = (dir) => path.join(dir, 'serial');
const serialPath = (dir, id) => assertManaged(dir, path.join(serialDir(dir), `${id}.json`));
const messagePath = (dir, id, prNumber) => assertManaged(dir, path.join(serialDir(dir), `${id}.pr-${prNumber}.msg`));

/**
 * Remove message files a previous run left behind. The merge call removes its own file in a `finally`,
 * but a process that dies mid-call never reaches it, and a resume that finds the PR already merged never
 * writes (or removes) one. Called under the run lease, so no live run owns any of them.
 * An absent directory is the only benign case; any other fault is returned as a reason, because a
 * file that cannot be removed is a file the next merge may not be able to write.
 * @returns {string|null} why the sweep could not finish, or null
 */
function sweepMessageFiles(dir, trainId) {
  let names;
  try { names = fs.readdirSync(serialDir(dir)); } catch (e) {
    return e.code === 'ENOENT' ? null : `cannot list ${serialDir(dir)} to clear stale message files (${e.code ?? e.message})`;
  }
  const prefix = `${trainId}.pr-`;
  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith('.msg')) continue;
    const file = assertManaged(dir, path.join(serialDir(dir), n));
    try { retrySync(() => fs.rmSync(file, { force: true })); } catch (e) { return `cannot remove the stale message file ${n} (${e.code ?? e.message})`; }
  }
  return null;
}

/** Validate a `messageFor` answer. @returns {{kind: 'none'} | {kind: 'stop', reason: string} | {kind: 'message', subject: string, body: string}} */
function readMessageAnswer(a) {
  if (a === null || a === undefined) return { kind: 'none' };
  if (typeof a === 'object' && typeof a.stop === 'string' && a.stop.length > 0 && a.subject === undefined && a.body === undefined) return { kind: 'stop', reason: a.stop.slice(0, 900) };
  if (typeof a === 'object' && typeof a.subject === 'string' && typeof a.body === 'string' && a.stop === undefined) {
    // A subject is one line; an empty one would make gh fall back to its default title.
    if (a.subject.trim() === '' || /[\r\n\0]/.test(a.subject) || a.body.includes('\0')) return { kind: 'stop', reason: 'messageFor returned an unusable subject or body' };
    return { kind: 'message', subject: a.subject, body: a.body };
  }
  return { kind: 'stop', reason: 'messageFor returned an unrecognised answer' };
}

/** @returns {{ok: true, run: object} | {ok: false, reason: string, absent?: boolean}} */
export function readSerial(dir, trainId) {
  let text;
  try { text = fs.readFileSync(serialPath(dir, trainId), 'utf-8'); } catch (e) { return { ok: false, absent: e.code === 'ENOENT', reason: e.code === 'ENOENT' ? 'no serial run' : `unreadable: ${e.message}` }; }
  try {
    const raw = JSON.parse(text);
    if (raw?.schemaVersion !== 1) return { ok: false, reason: `serial record schemaVersion ${JSON.stringify(raw?.schemaVersion)} is not understood by this fleet` };
    const r = SerialRunSchema.safeParse(raw);
    if (!r.success) return { ok: false, reason: `schema: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
    const bad = validatePolicyRun(r.data);
    return bad ? { ok: false, code: 'record-inconsistent', reason: `record-inconsistent: ${bad}` } : { ok: true, run: r.data };
  } catch (e) { return { ok: false, reason: `malformed JSON: ${e.message}` }; }
}

function writeSerial(dir, run) {
  const r = SerialRunSchema.parse(run);
  const bad = validatePolicyRun(r);
  if (bad) throw new Error(`record-inconsistent: ${bad}`); // a write that would violate an invariant never reaches the disk
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

/** The base branch's tip on the remote right now, for `messageFor`; `null` when it cannot be read. */
function baseTip({ deps, cwd, run }) {
  const r = deps.git(['ls-remote', run.remote, `refs/heads/${run.base}`], cwd, { timeoutMs: 60_000 });
  const oid = r.ok ? r.stdout.trim().split(/\s+/)[0] : '';
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid) ? oid : null;
}

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
 *
 * `policy` (ship-batch, rollup) is the RUNTIME half of a policy run: pure decisions the loop asks at fixed points, never a writer.
 * `messageFor` (ship-train) and `policy` are two seams for two callers; passing both throws.
 * @param {{cwd: string, trainId: string, deps?: object, requiredChecks?: string[], requiredChecksError?: string|null,
 *   sleep?: (ms: number) => void, timings?: object, messageFor?: MessageFor, policy?: object}} a
 */
export function runSerial({ cwd, trainId, deps = defaultDeps(), requiredChecks, requiredChecksError = null, sleep = sleepMs, timings = {}, messageFor, policy }) {
  if (policy && typeof messageFor === 'function') throw new Error('runSerial takes messageFor (ship-train) or policy (ship-batch, rollup), never both');
  const dir = fleetDir(cwd);
  const T = { poll: SERIAL_POLL_MS, updatePoll: UPDATE_POLL_MS, updateWait: UPDATE_WAIT_MS, mergeWait: MERGE_WAIT_MS, ...timings };
  const lease = withFileLockSync(path.join(serialDir(dir), `${trainId}.lock`), { attempts: 1 }, () => loop({ cwd, dir, trainId, deps, requiredChecks, requiredChecksError, sleep, T, messageFor, policy }));
  if (!lease.ok) return { ok: false, code: 'error', reason: `another process is landing ${trainId} serially (serial/${trainId}.lock is held)` };
  return lease.value;
}

// ---- the member step: it has NO `stop` in scope and returns one variant of a closed result (§2.2) -------------------------------

const NEXT = Object.freeze({ kind: 'next' });
const AGAIN = Object.freeze({ kind: 'again' });
const fault = (kind, reason, extra = {}) => ({ kind: 'fault', fault: { kind, reason, ...extra } });
const upper = (x) => String(x ?? '').toUpperCase();
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Persist an outcome pair (and optional run-level fields) in ONE write: phase and outcome are never written apart (§2.1 invariant 2). */
function commit(st, i, patch, extra = {}) {
  return st.save({ ...extra, steps: st.run.steps.map((s, j) => (j === i ? { ...s, ...patch, at: st.now() } : s)) });
}

/** The branch rules of the base: `{ok, queue}`, read by the ONE adapter. A merge queue makes a merge unobservable (the synchronous guarantee, §2.3). */
function readRules(st, s) {
  const r = readBranchRules(st.deps, st.cwd, { repo: s.repo, base: st.run.base });
  return r.ok ? { ok: true, queue: r.value.types.includes('merge_queue') } : { ok: false, reason: `${r.fault.kind}: ${r.fault.detail}` };
}

/** The CI evidence for member `s` at head `h`, asked through the one wrapper (the injected oracle in a test, else `assessRequiredCi`). */
function assessCiFor(st, s, h) {
  return askCiOracle(st.deps.assessCi, { repo: s.repo, prNumber: s.prNumber, expectedBase: st.run.base, expectedHead: h, configAssertion: st.configAssertion }, { ...st.deps, cwd: st.cwd });
}

/**
 * THE ONLY fleet `gh pr merge` (docs/plans/ci-evidence-oracle.md section 2.3). It asks the oracle FRESH, maps the evidence with the one table,
 * and only on `permit` (with evidence for exactly this head) runs `beforeMerge` and then the merge, pinning `--match-head-commit` to the
 * EVIDENCE's head. The caller passes the squash subject and body, never a head: it cannot pin a head the evidence was not read at.
 * @returns {{attempted: false, evidence: object, decision: object} | {attempted: true, evidence: object, m: object}}
 */
export function mergeWithCiPermit(st, s, h, { extraArgs = [], beforeMerge } = {}) {
  const evidence = assessCiFor(st, s, h);
  let decision = decideCiAdmission(evidence);
  if (decision.disposition === 'permit' && evidence.head !== h) {
    decision = { disposition: 'stop-run', tag: decision.tag, fault: { kind: 'unexpected-tag', detail: `the permitting evidence is for ${String(evidence.head).slice(0, 12)}, not the head ${String(h).slice(0, 12)} about to merge` } };
  }
  if (decision.disposition !== 'permit') return { attempted: false, evidence, decision };
  if (beforeMerge) beforeMerge(evidence);
  const m = st.deps.gh(['pr', 'merge', String(s.prNumber), '-R', s.repo, '--squash', ...extraArgs, '--match-head-commit', evidence.head], st.cwd);
  return { attempted: true, evidence, m };
}

/**
 * Post-merge verification (docs/plans/ci-evidence-oracle.md Amendment A item 2), from FRESH reads of a PR just observed MERGED: it merged into the
 * run's base, from the admitted head, and the required checks of that head are proven successes NOW (the oracle's `post-merge` phase). A DETECTIVE
 * control with a stated limit: it reads the state now, not at the instant GitHub accepted the merge. Anything not proven (a pending run included) fails.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function verifyMergedCi(st, s, doc, head) {
  const reasons = [];
  if (doc.baseRefName !== st.run.base) reasons.push(`it merged into ${doc.baseRefName ?? 'an unreadable base'}, not ${st.run.base}`);
  if (doc.headRefOid !== head) reasons.push(`it merged at head ${short(doc.headRefOid)}, not the admitted ${short(head)}`);
  const evidence = askCiOracle(st.deps.assessCi, { repo: s.repo, prNumber: s.prNumber, expectedBase: st.run.base, expectedHead: head, phase: 'post-merge', configAssertion: st.configAssertion }, { ...st.deps, cwd: st.cwd });
  const d = decideCiAdmission(evidence);
  if (d.disposition !== 'permit') reasons.push(`the required checks behind it are not proven successes now (${describeEvidence(evidence, d)})`);
  return reasons.length ? { ok: false, reason: `merged-unverified: PR #${s.prNumber} is MERGED but ${reasons.join('; ')} — do not report it as landed; check it by hand` } : { ok: true };
}

/**
 * A non-permitting CI decision as a member-step result (`where`: 'wait' while polling, 'merge' at the merge site). `null` means "keep waiting".
 * Plain serial stops the run on every fault (its reason text); a policy run maps the fault kind through `FAULTS`.
 */
function ciStepResult(st, s, evidence, d, where) {
  const why = `PR #${s.prNumber}: ${describeEvidence(evidence, d)}`;
  const policy = Boolean(st.policy);
  if (d.disposition === 'stop-run') return fault('ci-evidence-unknown', why);
  if (d.disposition === 'retry') {
    if (evidence.tag === 'ineligible') return bump(st, s, 'the head moved while the CI evidence was read');
    if (where === 'wait') return null;
    return policy ? fault('ci-retry', why) : AGAIN;
  }
  if (evidence.tag === 'ineligible') {
    if (evidence.code === 'closed') return fault('pr-closed', `PR #${s.prNumber} is closed`);
    if (evidence.code === 'draft') return fault('pr-draft', `PR #${s.prNumber} is a draft`);
    if (evidence.code === 'retargeted') return fault('pr-retargeted', `PR #${s.prNumber} now targets another branch than ${st.run.base}`);
    return bump(st, s, `the PR was observed ${evidence.code} while the CI evidence was read`); // merged: the top of the next pass classifies it
  }
  return fault('checks-failed', why); // failed or not-run: the required checks are red or never ran
}

/** Count one re-verification of member `s`; past `MAX_HEAD_CHURN` it is `not-run/head-churn`, never an endless loop (R1-M1, M9). */
function bump(st, s, why) {
  const n = (st.churn.get(s.id) ?? 0) + 1;
  st.churn.set(s.id, n);
  return n > MAX_HEAD_CHURN ? fault('head-churn', `PR #${s.prNumber}: re-verified ${n} times (${why})`) : AGAIN;
}

/** A head this run did not account for, under a policy: equal TREE = the tested content (re-admit at it); else head-moved (§2.3). */
function treeIdentity(st, i, s, h) {
  const { deps, cwd, run, policy } = st;
  const tested = policy.testedTree(run, s);
  if (!policy.treeIdentity || !tested) return fault('head-unaccounted', `PR #${s.prNumber} head ${short(h)} is not one this run accounts for — someone pushed; approve a new train`);
  const scope = `refs/fleet/serial/${run.trainId}`;
  const f = deps.git(['fetch', '--no-tags', run.remote, `+refs/pull/${s.prNumber}/head:${scope}/pr-${s.prNumber}`], cwd, { timeoutMs: 120_000 });
  const t = f.ok ? deps.git(['rev-parse', `${h}^{tree}`], cwd) : f;
  if (!t.ok) return fault('tree-unreadable', `PR #${s.prNumber}: the tree of the new head ${short(h)} could not be read (${t.reason ?? 'fetch failed'})`);
  const seen = t.stdout.trim();
  if (seen !== tested) return fault('head-moved', `PR #${s.prNumber} head ${short(h)} carries tree ${short(seen)}, not the tested ${short(tested)}`, { trees: { tested, seen } });
  st.setStep(i, { head: h, accounted: [...s.accounted, h] }); // the tested content, re-pushed: admission runs again AT this head
  return bump(st, s, 'the tested content was re-pushed');
}

/** The read-back of one merged member under a policy, then the ONE write that records landed (+ chain extension + halt). */
function readBackStep(st, i, doc) {
  const { run, policy } = st;
  const s = run.steps[i];
  const mergeOid = doc.mergeCommit?.oid ?? s.mergedOid;
  const rb = policy.readBack({ s, mergeOid, doc, run, deps: st.deps, cwd: st.cwd });
  if (!rb.measured) {
    commit(st, i, { step: 'merged', mergedOid: mergeOid, head: doc.headRefOid ?? s.head, outcome: { status: 'not-run', code: 'awaiting-read-back', reason: `the read-back could not be measured: ${String(rb.why).slice(0, 700)}` } });
    return fault('read-back-unmeasured', `PR #${s.prNumber} merged at ${short(mergeOid)} but its read-back could not be measured (${rb.why}) — --resume re-checks it`);
  }
  const chain = run.policy.baseChain;
  let v = verdictOf({ readBack: rb, runBase: run.base, chainTail: chain.at(-1), candidateTree: policy.name === 'rollup' ? run.policy.candidateTree : null });
  let unverified = null;
  if (CHAIN_VERDICTS.includes(v.verdict)) { // the merge is where it should be: now prove the CI behind it
    const pv = verifyMergedCi(st, s, doc, s.attempt?.head ?? s.head);
    if (!pv.ok) { v = { verdict: 'merged-unverified' }; unverified = pv.reason; }
  }
  const onChain = CHAIN_VERDICTS.includes(v.verdict);
  const outcome = {
    status: 'landed', code: 'merged', verdict: v.verdict, mergeOid, parent: rb.firstParent ?? null, chainIndex: onChain ? chain.length : null,
    attribution: s.attempt?.ghExit === 0 ? 'this-run' : 'unknown', gate: rb.gate ?? null,
    ...(unverified ? { reason: unverified.slice(0, 900) } : rb.reasons?.length ? { reason: rb.reasons.join('; ').slice(0, 900) } : {}),
    ...(policy.name === 'rollup' && s.attempt?.ci ? { ci: s.attempt.ci } : {}), ...(v.trees ? { trees: v.trees } : {}),
  };
  const halt = HALT_VERDICTS.includes(v.verdict) ? { halt: { code: v.verdict, member: s.id, at: st.now() } } : {};
  commit(st, i, { step: 'merged', mergedOid: mergeOid, head: doc.headRefOid ?? s.head, outcome }, { ...(onChain ? { policy: { ...run.policy, baseChain: [...chain, mergeOid] } } : {}), ...halt });
  if (!halt.halt) return NEXT;
  const why = { 'merged-unverified': unverified, 'wrong-target': `PR #${s.prNumber} merged into ${rb.baseRefName}, not ${run.base}`, 'untested-base': `landed-on-untested-base: PR #${s.prNumber} landed on ${short(rb.firstParent)}, not the tested ${short(chain.at(-1))} — a foreign commit reached the base in the merge window; the remaining members need a rebuild`, 'tree-mismatch': `PR #${s.prNumber} landed with tree ${short(rb.tree)}, not the candidate's ${short(v.trees?.expected)}: verify each member against the landed tree` }[v.verdict];
  return fault('base-moved', why);
}

/** A PR observed MERGED under a policy: classify, persist the pair, and read back when the merge was ours (§2.3). */
function mergedObserved(st, i, doc) {
  const s = st.run.steps[i];
  const c = classifyMerged({ step: s, doc });
  if (c.external) {
    commit(st, i, { step: 'merged', mergedOid: c.mergeOid, head: doc.headRefOid ?? s.head, outcome: c.outcome }, { halt: { code: 'merged-externally', member: s.id, at: st.now() } });
    return fault('base-moved', `PR #${s.prNumber} was merged outside this run at ${short(doc.headRefOid)}: it put a commit on ${st.run.base} that the chain does not hold; rebuild the train`);
  }
  if (c.outcome) { // no merge oid reported: non-terminal, resume re-reads
    commit(st, i, { step: c.step, mergedOid: null, head: doc.headRefOid ?? s.head, outcome: c.outcome });
    return fault('read-back-unmeasured', `PR #${s.prNumber} is MERGED but GitHub reported no merge commit — --resume re-reads it`);
  }
  commit(st, i, { step: 'merged', mergedOid: c.mergeOid, head: doc.headRefOid ?? s.head, outcome: { status: 'not-run', code: 'awaiting-read-back', reason: 'merged; the read-back follows' } });
  return readBackStep(st, i, { ...doc, mergeCommit: { oid: c.mergeOid } });
}

/** Merge under a policy, in the contract's order (§2.3): admit, base chain and rules, the final re-read, the intent, the merge, observe. */
function policyMerge(st, i, h) {
  const { deps, cwd, run, policy, T, sleep } = st;
  const s = run.steps[i];
  const gr = policy.grantRefusal?.();
  if (gr) return fault('grant-revoked', `grant-revoked: ${gr.reason}`);
  const a = policy.admit({ s, h, run, cwd, deps });
  if (!a.ok) return fault(a.kind, a.reason, a.trees ? { trees: a.trees } : {});
  const chainTail = run.policy.baseChain.at(-1);
  const tip = baseTip({ deps, cwd, run });
  if (!tip) return fault('base-moved', 'base-moved: the base tip could not be read, so the base progression cannot be verified');
  if (tip !== chainTail) return fault('base-moved', `base-moved: the base is ${short(tip)}, the batch expects ${short(chainTail)} (a commit that is not this batch's own landed): rebuild the train`);
  const rules = readRules(st, s);
  if (!rules.ok) return fault('rules-unreadable', `rules-unreadable: the branch rules of ${run.base} could not be read (${rules.reason}), so a merge queue cannot be excluded`);
  if (rules.queue) return fault('merge-queue-present', `merge-queue-present: ${run.base} has a merge queue, so a merge could not be observed synchronously`);
  const re = viewPr(deps, cwd, s);
  if (!re.ok) return fault('pr-unreadable', `PR #${s.prNumber}: cannot read it (${re.reason})`);
  const d = re.doc;
  if (upper(d.state) === 'MERGED') return mergedObserved(st, i, d);
  if (upper(d.state) !== 'OPEN') return fault('pr-closed', `PR #${s.prNumber} is ${d.state}`);
  if (d.isDraft === true) return fault('pr-draft', `PR #${s.prNumber} is a draft`);
  if (d.baseRefName !== run.base) return fault('pr-retargeted', `PR #${s.prNumber} now targets ${d.baseRefName}, not ${run.base}`);
  if (d.headRefOid !== h) return bump(st, s, 'the head changed while it was being admitted');
  let attempt = { head: h, at: st.now(), ghExit: null, doneAt: null, ...(a.messageSha256 ? { messageSha256: a.messageSha256 } : {}), ...(a.ci ? { ci: a.ci } : {}) };
  const bodyFile = messagePath(st.dir, run.trainId, s.prNumber);
  atomicWriteFileSync(bodyFile, a.message.body);
  let res;
  try {
    res = mergeWithCiPermit(st, s, h, {
      extraArgs: ['--subject', a.message.subject, '--body-file', bodyFile],
      beforeMerge: (e) => { attempt = { ...attempt, head: e.head }; commit(st, i, { step: 'merge', head: e.head, outcome: null, attempt }); },
    });
  } finally { retrySync(() => fs.rmSync(bodyFile, { force: true })); }
  if (!res.attempted) return ciStepResult(st, s, res.evidence, res.decision, 'merge') ?? AGAIN;
  const m = res.m;
  st.setStep(i, { attempt: { ...attempt, ghExit: m.ok ? 0 : (Number.isInteger(m.status) && m.status !== 0 ? m.status : 1), doneAt: st.now() } });
  const until = Date.now() + T.mergeWait;
  for (;;) {
    const o = viewPr(deps, cwd, s);
    if (o.ok && upper(o.doc.state) === 'MERGED') return mergedObserved(st, i, o.doc);
    if (Date.now() >= until) {
      const reason = m.ok ? `PR #${s.prNumber}: merge accepted but not observed merged after ${Math.round(T.mergeWait / 1000)}s — --resume reconciles it` : `PR #${s.prNumber}: gh pr merge failed (${m.reason}) — it may still have merged; --resume reconciles it`;
      commit(st, i, { outcome: { status: 'not-run', code: 'merge-unconfirmed', reason: reason.slice(0, 900) } });
      return fault('merge-unconfirmed', reason);
    }
    sleep(Math.min(T.updatePoll * 2, 5_000));
  }
}

/**
 * One pass over member `i`. Returns `NEXT` (decided or merged), `AGAIN` (re-verify from the top) or `fault(...)`. It cannot stop
 * the run: the loop alone holds `stop`, and maps every fault through `FAULTS` (§2.2).
 */
function stepMember(st, i) {
  const { cwd, deps, run, policy, T, sleep, messageFor } = st;
  const s = run.steps[i];
  if (policy && s.step === 'merged') { // an earlier run merged it and its read-back did not finish: read back now, never skip
    const v = viewPr(deps, cwd, s);
    if (!v.ok) return fault('pr-unreadable', `PR #${s.prNumber}: cannot read it (${v.reason})`);
    if (upper(v.doc.state) !== 'MERGED') return fault('read-back-unmeasured', `PR #${s.prNumber} is no longer MERGED (${v.doc.state}); verify it by hand`);
    const doc = { ...v.doc, mergeCommit: v.doc.mergeCommit ?? (s.mergedOid ? { oid: s.mergedOid } : null) };
    // The same table as the first observation, against the persisted attempt: a merge at ANOTHER head is external, whatever the phase says.
    const c = classifyMerged({ step: { ...s, step: 'merge' }, doc });
    return c.external || !c.mergeOid ? mergedObserved(st, i, doc) : readBackStep(st, i, doc);
  }
  const v = viewPr(deps, cwd, s);
  if (!v.ok) return fault('pr-unreadable', `PR #${s.prNumber}: cannot read it (${v.reason})`);
  const d = v.doc;
  if (upper(d.state) === 'MERGED') {
    if (policy) return mergedObserved(st, i, d);
    if (!s.accounted.includes(d.headRefOid)) return fault('merged-unaccounted', `PR #${s.prNumber} was merged at ${short(d.headRefOid)}, a head this run did not account for — check it by hand`);
    // A PR observed MERGED at an accounted head is verified BEFORE `merged` is persisted (a resume skips merged steps, so an unverified merge must never reach that state).
    // The head to verify against is the one this run PINNED when a merge was requested (step `merge`), not whatever head the PR shows now.
    const pv = verifyMergedCi(st, s, d, s.step === 'merge' && s.head ? s.head : d.headRefOid);
    if (!pv.ok) return fault('merged-unverified', pv.reason);
    st.setStep(i, { step: 'merged', mergedOid: d.mergeCommit?.oid ?? null, head: d.headRefOid });
    return NEXT;
  }
  if (upper(d.state) !== 'OPEN') return fault('pr-closed', `PR #${s.prNumber} is ${d.state}`);
  if (d.isDraft === true) return fault('pr-draft', `PR #${s.prNumber} is a draft`);
  if (d.baseRefName !== run.base) return fault('pr-retargeted', `PR #${s.prNumber} now targets ${d.baseRefName}, not ${run.base}`);
  if (policy && s.step === 'merge' && s.attempt) { // an unconfirmed merge request: OPEN counts as "did not merge" only after the request window (§2.3)
    if (Date.parse(st.now()) - Date.parse(s.attempt.at) < T.mergeWait) return fault('merge-unconfirmed', `PR #${s.prNumber}: still OPEN within ${Math.round(T.mergeWait / 1000)}s of the merge request — it may still be executing; --resume later`);
    const q = ghJson(deps, cwd, ['pr', 'view', String(s.prNumber), '-R', s.repo, '--json', 'isInMergeQueue']);
    if (!q.ok) return fault('merge-queued', `PR #${s.prNumber}: whether it sits in a merge queue could not be read (${q.reason})`);
    if (q.doc?.isInMergeQueue === true) return fault('merge-queued', `PR #${s.prNumber} sits in a merge queue: left for the operator, never re-attempted`);
    if (q.doc?.isInMergeQueue !== false) return fault('merge-queued', `PR #${s.prNumber}: the merge-queue answer was not an explicit false (${JSON.stringify(q.doc?.isInMergeQueue ?? null)}), so queue absence is unproven`);
    st.setStep(i, { step: 'pending', outcome: null }); // the request resolved without merging: admission starts again from the top
  }
  const h = d.headRefOid;
  if (!s.accounted.includes(h)) {
    if (policy) return treeIdentity(st, i, s, h);
    // Only an interrupted update of ours can explain a new head; prove it or stop.
    if (s.step !== 'update' || !s.priorHead) return fault('head-unaccounted', `PR #${s.prNumber} head ${short(h)} is not one this run accounts for — someone pushed; approve a new train`);
    if (h === s.priorHead) { st.setStep(i, { step: 'pending' }); return AGAIN; } // the update never applied
    const c = classifyUpdatedHead({ deps, cwd, s, run, h, priorHead: s.priorHead });
    if (c.verdict === 'unverifiable') return fault('update-unverifiable', `PR #${s.prNumber}: could not verify the updated head (acquisition): ${c.reason}`);
    if (c.verdict === 'foreign') return fault('update-foreign', `PR #${s.prNumber}: head ${short(h)} is UNACCOUNTED (${c.reason}) — approve a new train`);
    st.setStep(i, { step: 'wait', head: h, accounted: [...s.accounted, h] });
    return AGAIN;
  }
  const ms = upper(d.mergeStateStatus);
  if (ms === 'DIRTY') return fault('conflict', `PR #${s.prNumber} now conflicts with ${run.base} — run \`${restackCmd(s.id)}\` and push, then --resume`);
  if (ms === 'BEHIND' && policy) return fault('behind', `behind-base: PR #${s.prNumber} is behind ${run.base}; a policy run never updates a branch on the remote — restack, re-ship, or /ship`);
  if (ms === 'BEHIND') {
    if (s.updates >= MAX_UPDATES_PER_PR) return fault('update-churn', `PR #${s.prNumber} fell behind ${run.base} ${s.updates} times; the base is moving too fast — resume later`);
    st.setStep(i, { step: 'update', priorHead: h, head: h });
    const u = deps.gh(['api', '-X', 'PUT', `repos/${s.repo}/pulls/${s.prNumber}/update-branch`, '-f', `expected_head_sha=${h}`], cwd);
    if (!u.ok) {
      if (/merge conflict|422/i.test(`${u.stderr ?? ''} ${u.reason ?? ''}`)) return fault('update-failed', `PR #${s.prNumber} cannot be updated (merge conflict) — run \`${restackCmd(s.id)}\` and push, then --resume`);
      return fault('update-failed', `PR #${s.prNumber}: update-branch failed (${u.reason})`);
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
    if (!newHead) return fault('update-invisible', `PR #${s.prNumber}: update not yet visible after ${Math.round(T.updateWait / 1000)}s — --resume to continue`);
    st.setStep(i, { updates: s.updates + 1 });
    return AGAIN; // the next pass proves the new head is ours and moves to wait
  }
  // ── wait for required checks on this exact head ──
  if (st.run.steps[i].step !== 'wait' && st.run.steps[i].step !== 'merge') st.setStep(i, { step: 'wait', head: h });
  const deadline = Date.now() + run.timeoutMs;
  for (;;) {
    const ev = assessCiFor(st, s, h);
    const d = decideCiAdmission(ev);
    if (d.disposition === 'permit') break;
    const r = ciStepResult(st, s, ev, d, 'wait');
    if (r) return r;
    if (Date.now() >= deadline) {
      const missing = ev.names?.missing ?? [];
      return fault('checks-pending-deadline', `PR #${s.prNumber}: required checks still ${ev.tag} after ${Math.round(run.timeoutMs / 60_000)} min (${describeEvidence(ev, d)}${missing.length ? `; never registered on ${short(h)}: ${missing.join(', ')}` : ''}) — --resume to keep waiting`);
    }
    sleep(T.poll);
  }
  // ── merge exactly this head ──
  const again = viewPr(deps, cwd, s);
  if (policy && !again.ok) return fault('pr-unreadable', `PR #${s.prNumber}: cannot read it (${again.reason})`);
  if (!again.ok || again.doc.headRefOid !== h) return policy ? bump(st, s, 'the head changed while the checks were observed') : AGAIN;
  if (upper(again.doc.mergeStateStatus) === 'BEHIND') return AGAIN; // the base moved while we waited
  if (policy && upper(again.doc.state) === 'MERGED') return AGAIN; // merged while we waited: the top of the pass classifies it
  if (policy) return policyMerge(st, i, h);
  // The message is decided here, on the head that is about to be merged, so a refusal stops the run
  // BEFORE this merge and nothing stale is ever replayed.
  let message = { kind: 'none' };
  if (typeof messageFor === 'function') {
    let answer;
    try { answer = messageFor({ source: s, headOid: h, baseOid: baseTip({ deps, cwd, run }) }); } catch (e) { answer = { stop: `messageFor failed: ${e?.message ?? e}` }; }
    message = readMessageAnswer(answer);
    if (message.kind === 'stop') return fault('message-stop', `PR #${s.prNumber}: ${message.reason}`);
    if (message.kind === 'none' && run.messageRequired) return fault('message-stop', `PR #${s.prNumber}: this run requires a squash message and messageFor returned none`);
  }
  const extraArgs = [];
  let bodyFile = null;
  if (message.kind === 'message') {
    // gh reads --body-file during the call, so the file lives exactly that long.
    bodyFile = messagePath(st.dir, st.trainId, s.prNumber);
    atomicWriteFileSync(bodyFile, message.body);
    extraArgs.push('--subject', message.subject, '--body-file', bodyFile);
  }
  let res;
  try { res = mergeWithCiPermit(st, s, h, { extraArgs, beforeMerge: (e) => st.setStep(i, { step: 'merge', head: e.head }) }); } finally { if (bodyFile) retrySync(() => fs.rmSync(bodyFile, { force: true })); }
  if (!res.attempted) return ciStepResult(st, s, res.evidence, res.decision, 'merge') ?? AGAIN;
  const m = res.m;
  const until = Date.now() + T.mergeWait;
  for (;;) {
    const o = viewPr(deps, cwd, s);
    if (o.ok && upper(o.doc.state) === 'MERGED') {
      const pv = verifyMergedCi(st, s, o.doc, h); // verified first: on failure the step stays `merge`, so a resume observes the MERGED PR and verifies again
      if (!pv.ok) return fault('merged-unverified', pv.reason);
      st.setStep(i, { step: 'merged', mergedOid: o.doc.mergeCommit?.oid ?? null });
      return NEXT;
    }
    if (Date.now() >= until) {
      return fault('merge-unconfirmed', m.ok
        ? `PR #${s.prNumber}: merge accepted but not observed merged after ${Math.round(T.mergeWait / 1000)}s — check branch rules / merge queue, then --resume`
        : `PR #${s.prNumber}: gh pr merge failed (${m.reason})`);
    }
    sleep(Math.min(T.updatePoll * 2, 5_000));
  }
}

/** The result of a finalized (or finalizing) policy run, from the stored summary. */
const policyResult = (run, trainId, f, extra = {}) => ({ ok: f.result.ok, code: f.result.ok ? 'ok' : 'refused', trainId, run, landed: f.result.trainLanded, summary: f.result, ...extra });

/**
 * Finalize a policy run: the final live base read, the tail tree, the pure summary, and ONE write of `finalized`. Only when every
 * member is terminal or the run is halted; otherwise the run stays resumable. @returns {{finalized: boolean, summary: object}}
 */
function finalizeRun(st, stoppedReason) {
  const { run, deps, cwd } = st;
  const done = Boolean(run.halt) || run.steps.every((x) => isTerminal(x.outcome));
  const chain = run.policy.baseChain;
  let tailTree = null;
  if (chain.length > 1) {
    const r = deps.git(['rev-parse', `${chain.at(-1)}^{tree}`], cwd);
    tailTree = r.ok ? r.stdout.trim() : null;
    if (!tailTree) return { finalized: false, summary: { ...summariseRun(run, { tailTree: null, stoppedReason }), ok: false, first: `the landed tree of ${chain.at(-1).slice(0, 12)} could not be read: --resume re-checks it` } };
  }
  const summary = summariseRun(run, { tailTree, stoppedReason });
  if (!done) return { finalized: false, summary };
  st.save({ finalized: { at: st.now(), result: summary }, outcome: { status: summary.trainLanded ? 'landed' : 'stopped', reason: summary.first.slice(0, 1900), at: st.now() } });
  return { finalized: true, summary };
}

function loop({ cwd, dir, trainId, deps, requiredChecks, requiredChecksError, sleep, T, messageFor, policy }) {
  let run = readSerial(dir, trainId);
  if (!run.ok) return { ok: false, code: 'refused', reason: `train ${trainId}: ${run.reason}` };
  run = run.run;
  const now = () => deps.now().toISOString();
  const save = (patch) => { run = writeSerial(dir, { ...run, ...patch, updatedAt: now() }); st.run = run; return run; };
  const setStep = (i, patch) => save({ steps: run.steps.map((s, j) => (j === i ? { ...s, ...patch, at: now() } : s)) });
  const st = { cwd, dir, trainId, deps, T, sleep, policy, messageFor, run, now, save, setStep, churn: new Map(), configAssertion: null };
  // A stop KEEPS the step it happened in (an 'update' intent must survive to be recognised on resume);
  // only the note and the run outcome record why.
  const stop = (i, reason) => {
    if (i !== null) setStep(i, { note: reason });
    save({ outcome: { status: 'stopped', reason, at: now() } });
    if (policy && run.halt) finalizeRun(st, reason); // a halted run is finished: nothing further may land in it
    return { ok: false, code: 'refused', reason, trainId, run, resumable: true };
  };
  // A persisted policy and the driver must agree: a policy run is driven only by its own policy, and a plain driver never takes one.
  if (run.policy && policy?.name !== run.policy.name) return { ok: false, code: 'refused', reason: `policy-mismatch: this run belongs to a ${run.policy.name} policy and may only be resumed with it: fleet land --resume ${trainId} ${run.policy.name === 'rollup' ? '--rollup' : '--ship-batch'}`, trainId };
  if (!run.policy && policy) return { ok: false, code: 'refused', reason: `policy-mismatch: this run has no ${policy.name} policy; a plain run is resumed with: fleet land --resume ${trainId}`, trainId };
  if (run.finalized) { // a finalized run is a historical summary: only the local, idempotent train patch and the cleanup remain
    const out = policyResult(run, trainId, run.finalized);
    return policy.cleanup ? policy.cleanup({ run, result: out, cwd, deps, save }) ?? out : out;
  }
  if (!policy && run.outcome?.status === 'landed') return { ok: true, code: 'ok', trainId, run, landed: true };
  const sweepFault = sweepMessageFiles(dir, trainId);
  if (sweepFault) return stop(null, sweepFault);
  if (run.messageRequired && typeof messageFor !== 'function') {
    return stop(null, 'this run was started with a squash-message provider (ship-train land) and may only merge with one; resume it with the same tool: node scripts/ship-train.mjs land --train ' + trainId + ' --resume');
  }
  if (run.outcome) save({ outcome: null }); // a resumed stop re-enters
  if (policy) {
    const gr = policy.grantRefusal?.();
    if (gr) return stop(null, `grant-revoked: ${gr.reason}`);
    if (run.steps.some((x) => !isTerminal(x.outcome) || x.step === 'merged')) {
      const rules = readRules(st, run.steps[0]);
      if (!rules.ok) return stop(null, `rules-unreadable: the branch rules of ${run.base} could not be read (${rules.reason}), so a merge queue cannot be excluded`);
      if (rules.queue) return stop(null, `merge-queue-present: ${run.base} has a merge queue, so a merge could not be observed synchronously`);
    }
  }
  st.configAssertion = { requiredChecks, error: requiredChecksError };
  for (let i = 0; i < run.steps.length; i += 1) {
    if (policy ? (isTerminal(run.steps[i].outcome) || run.halt) : run.steps[i].step === 'merged') continue;
    if (!policy && run.steps[i].note) setStep(i, { note: null });
    for (;;) {
      let r;
      try { r = stepMember(st, i); } catch (e) {
        if (!policy) throw e;
        r = fault('internal-error', `internal-error: ${e?.message ?? e}`);
      }
      if (r.kind === 'again') continue;
      if (r.kind === 'next') break;
      if (r.kind !== 'fault') return stop(i, `internal-error: the member step returned ${JSON.stringify(r.kind)}`);
      const f = r.fault;
      const row = FAULTS[f.kind];
      if (!policy || !row) return policy ? stop(i, `internal-error: unknown fault kind ${JSON.stringify(f.kind)}`) : stop(i, f.reason);
      if (row.scope === 'run') return stop(i, f.reason);
      const outcome = { status: row.status, code: row.code, reason: f.reason.slice(0, 900), ...(f.trees ? { trees: f.trees } : {}) };
      commit(st, i, { step: run.steps[i].step === 'merge' ? 'pending' : run.steps[i].step, outcome, note: null });
      break;
    }
  }
  if (policy) {
    const touched = run.policy.baseChain.length > 1 || Boolean(run.halt);
    if (touched && !run.halt) { // before the result: the live base must still be the chain tail (R3-H1)
      const tip = baseTip({ deps, cwd, run });
      if (tip === null) return stop(null, `the base tip of ${run.base} could not be read after the run, so the chain cannot be verified: --resume re-checks it`);
      if (tip !== run.policy.baseChain.at(-1)) {
        save({ halt: { code: 'base-moved', member: run.steps.at(-1).id, at: now() } });
        return stop(null, `base-moved: the base is ${short(tip)}, the chain ends at ${short(run.policy.baseChain.at(-1))}: something else reached ${run.base} during the run`);
      }
    }
    const fin = finalizeRun(st, null);
    if (!fin.finalized) {
      const reason = fin.summary.first;
      save({ outcome: { status: 'stopped', reason: reason.slice(0, 1900), at: now() } });
      return { ok: false, code: 'refused', reason, trainId, run, resumable: true, summary: fin.summary };
    }
    const out = policyResult(run, trainId, run.finalized);
    return policy.cleanup ? policy.cleanup({ run, result: out, cwd, deps, save }) ?? out : out;
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
export function approveSerial({ cwd, trainId, acceptRerun = false, requiredChecks, requiredChecksError = null, deps = defaultDeps(), sleep, timings, timeoutMs, messageFor, policy }) {
  if (policy && typeof messageFor === 'function') throw new Error('approveSerial takes messageFor (ship-train) or policy (ship-batch), never both');
  const dir = fleetDir(cwd);
  const start = withTrainLock(dir, () => {
    const r = readTrain(dir, trainId);
    if (!r.ok) return { ok: false, code: 'refused', reason: `train ${trainId}: ${r.reason}` };
    const t = r.train;
    if (t.landing === 'rollup') return { ok: false, code: 'refused', reason: `train ${trainId} is a rollup: approve it with land --approve ${trainId} --rollup` };
    if (t.mergeMethod !== 'pr') return { ok: false, code: 'refused', reason: `--serial lands PRs one at a time; train ${trainId} is ${t.mergeMethod}` };
    const elig = approvable(t, { acceptRerun });
    if (!elig.ok) return { ok: false, code: 'refused', reason: elig.reason, needsAcceptRerun: elig.needsAcceptRerun === true };
    const shallow = deps.git(['rev-parse', '--is-shallow-repository'], cwd);
    if (!shallow.ok || shallow.stdout.trim() !== 'false') return { ok: false, code: 'refused', reason: 'serial landing needs full history to verify updated heads; this clone is shallow (or git could not say) — git fetch --unshallow' };
    if (readSerial(dir, trainId).ok) return { ok: false, code: 'refused', reason: `a serial run already exists for ${trainId} — use land --resume ${trainId}` };
    // A POLICY run is created only on a CONFIRMED absence: an unreadable record is state we cannot see, never an empty slot (a plain run keeps today's behaviour).
    if (policy) { const ex = readSerial(dir, trainId); if (!ex.absent) return { ok: false, code: 'refused', reason: `the serial record of ${trainId} exists but cannot be read (${ex.reason}): recover or quarantine it before a run is started` }; }
    const ver = verifyFacts({ cwd, train: t, dir, deps });
    if (!ver.ok) return { ok: false, code: 'refused', reason: ver.reason };
    const stamp = deps.now().toISOString();
    writeSerial(dir, {
      schemaVersion: 1, trainId, startedAt: stamp, updatedAt: stamp, timeoutMs: timeoutMs ?? 60 * 60 * 1000,
      base: branchOfRef(t.destination.ref), remote: t.destination.remote, outcome: null,
      ...(typeof messageFor === 'function' ? { messageRequired: true } : {}),
      ...(policy ? { policy: policy.persisted } : {}),
      steps: t.sources.map((src) => ({
        id: src.id, prNumber: src.prNumber, repo: src.repo, testedOid: src.oid, step: 'pending', head: src.oid, accounted: [src.oid],
        updates: 0, priorHead: null, mergedOid: null, note: null, at: stamp,
      })),
    });
    patchTrain(dir, trainId, { phase: 'awaiting-merge' }, deps);
    return { ok: true };
  });
  if (!start.ok) return start;
  return finishSerial({ cwd, dir, trainId, deps, r: runSerial({ cwd, trainId, deps, requiredChecks, requiredChecksError, ...(sleep ? { sleep } : {}), ...(timings ? { timings } : {}), ...(messageFor ? { messageFor } : {}), ...(policy ? { policy } : {}) }) });
}

/** `land --resume <trainId>` for a train that has a serial run. */
export function resumeSerial({ cwd, trainId, requiredChecks, requiredChecksError = null, deps = defaultDeps(), sleep, timings, messageFor, policy }) {
  const dir = fleetDir(cwd);
  return finishSerial({ cwd, dir, trainId, deps, r: runSerial({ cwd, trainId, deps, requiredChecks, requiredChecksError, ...(sleep ? { sleep } : {}), ...(timings ? { timings } : {}), ...(messageFor ? { messageFor } : {}), ...(policy ? { policy } : {}) }) });
}

/**
 * The ONE writer of a fresh policy run for a caller that builds its own record (the rollup, whose one step is a PR it just opened).
 * The run is validated (schema and the policy invariants) and refused if a run already exists. `approveSerial` writes ship-batch runs.
 */
export function startPolicyRun({ dir, run }) {
  if (!run.policy) throw new Error('startPolicyRun writes policy runs only');
  const existing = readSerial(dir, run.trainId);
  // Only a CONFIRMED absence permits creation: an invalid, unsupported or unreadable record is state we cannot see, never an empty slot.
  if (!existing.absent) return { ok: false, reason: existing.ok ? `a serial run already exists for ${run.trainId}` : `the serial record of ${run.trainId} exists but cannot be read (${existing.reason}): recover or quarantine it before a run is started` };
  writeSerial(dir, run);
  return { ok: true };
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
