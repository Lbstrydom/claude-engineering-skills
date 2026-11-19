/**
 * @fileoverview The per-member outcome model of the serial runner (docs/plans/ship-batch-member-outcomes.md §2.1-§2.3, §2.7-§2.8).
 *
 * Pure: no I/O, no clock. The serial loop is the only writer of a run's state; everything here decides or validates.
 *
 *  - `FAULTS`        the closed table of fault kinds and their scope (a member fault ends ONE member's step; a run fault stops
 *                    the run). Under no policy every fault is today's `stop(i, reason)`.
 *  - `OutcomeSchema` a discriminated union on `status`; each variant has its own closed code enum and required evidence.
 *  - `PolicySchema`  the persisted policy block, a discriminated union on `name` (`ship-batch` | `rollup`).
 *  - `classifyMerged` the ONLY reader of `state === 'MERGED'` under a policy: it returns the `{step, outcome}` pair to persist.
 *  - `verdictOf`     the read-back verdict, from a measured read-back.
 *  - `validatePolicyRun` the load-time invariants (§2.1), checked on every read before any remote action.
 *  - `combinationOf`, `summariseRun` the landed set stated honestly (§2.7) and the truth table (§2.8).
 *
 * @module scripts/lib/fleet/member-outcome
 */
import { z } from 'zod';
import { OID_RE } from './contracts.mjs';

const Oid = z.string().regex(OID_RE);
const Iso = z.string().refine((s) => Number.isFinite(Date.parse(s)), 'must be an ISO timestamp');

export const MAX_HEAD_CHURN = 3;
export const VERDICTS = Object.freeze(['verified', 'provenance-lost', 'untested-base', 'wrong-target', 'tree-mismatch']);
/** Verdicts that extend the base chain (their squash sits on the chain tail and carries the tested content). */
export const CHAIN_VERDICTS = Object.freeze(['verified', 'provenance-lost']);
/** Verdicts that put something on the base the chain does not hold: the run halts (§2.1 invariant 7). */
export const HALT_VERDICTS = Object.freeze(['wrong-target', 'untested-base', 'tree-mismatch']);

const REFUSED_CODES = ['pr-closed', 'pr-draft', 'pr-retargeted', 'conflict', 'behind-base', 'head-moved', 'checks-failed', 'shipped-head-refused', 'ci-refused', 'message-invalid', 'member-refused', 'held'];
const NOT_RUN_CODES = ['pr-unreadable', 'checks-pending', 'tree-unreadable', 'message-unreadable', 'head-churn', 'merge-unconfirmed', 'awaiting-read-back', 'awaiting-merge-evidence'];

export const CiSchema = z.strictObject({
  head: Oid, tree: Oid, observedAt: Iso,
  checks: z.array(z.strictObject({ name: z.string().min(1), conclusion: z.string().min(1) })),
});
export const AttemptSchema = z.strictObject({
  head: Oid, at: Iso, ghExit: z.number().int().nullable(), doneAt: Iso.nullable(),
  messageSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), ci: CiSchema.optional(),
});

const Landed = z.strictObject({
  status: z.literal('landed'), code: z.literal('merged'), verdict: z.enum(VERDICTS), mergeOid: Oid, parent: Oid.nullable(),
  chainIndex: z.number().int().min(1).nullable(), attribution: z.enum(['this-run', 'unknown']), gate: z.string().nullable(),
  reason: z.string().max(1000).optional(), ci: CiSchema.optional(),
  trees: z.strictObject({ expected: Oid, observed: Oid }).optional(),
});
const Refused = z.strictObject({
  status: z.literal('refused'), code: z.enum(REFUSED_CODES), reason: z.string().min(1).max(1000),
  trees: z.strictObject({ tested: Oid, seen: Oid }).optional(),
});
const Skipped = z.strictObject({ status: z.literal('skipped'), code: z.literal('merged-externally'), mergeOid: Oid, seenHead: Oid });
const NotRun = z.strictObject({ status: z.literal('not-run'), code: z.enum(NOT_RUN_CODES), reason: z.string().min(1).max(1000) });
export const OutcomeSchema = z.discriminatedUnion('status', [Landed, Refused, Skipped, NotRun]);
const CODE_ENUMS = { refused: REFUSED_CODES, 'not-run': NOT_RUN_CODES };
export const isTerminal = (o) => Boolean(o) && o.status !== 'not-run';

const Excluded = z.strictObject({ id: z.string().min(1), prNumber: z.number().int().positive().nullable(), reasons: z.array(z.string()) });
const Common = { grantVersion: z.string().min(1), remote: z.string().min(1), candidateTree: Oid, baseChain: z.array(Oid).min(1), excluded: z.array(Excluded) };
export const ShipBatchPolicySchema = z.strictObject({
  name: z.literal('ship-batch'), ...Common,
  members: z.record(z.string().min(1), z.strictObject({ tree: Oid, worktree: z.string().nullable() })),
});
export const RollupMemberSchema = z.strictObject({
  id: z.string().min(1), branch: z.string().min(1), head: Oid, tree: Oid, runId: z.string().nullable(), gate: z.string().nullable(), finalReview: z.string().nullable(),
});
export const RollupPolicySchema = z.strictObject({
  name: z.literal('rollup'), ...Common, members: z.array(RollupMemberSchema).min(1),
  rollup: z.strictObject({ branch: z.string().min(1), repo: z.string().min(1), prNumber: z.number().int().positive(), candidate: z.strictObject({ oid: Oid, tree: Oid }) }),
});
export const PolicySchema = z.discriminatedUnion('name', [ShipBatchPolicySchema, RollupPolicySchema]);

export const HaltSchema = z.strictObject({ code: z.string().min(1), member: z.string().min(1), at: Iso });
export const FinalizedSchema = z.strictObject({
  at: Iso,
  result: z.strictObject({
    ok: z.boolean(), combination: z.enum(['tested', 'different', 'subset', 'unverified']), trainLanded: z.boolean(),
    first: z.string().max(1000), provenance: z.array(z.string().max(500)), tails: z.array(z.string().max(300)).max(5),
  }),
});

/**
 * The closed fault table. `scope` decides what a policy run does; the default (no policy) is always `stop(i, reason)` with
 * today's text. `status`/`code` give the member outcome a `member` fault writes, and the one a `run` fault writes first (if any).
 */
export const FAULTS = Object.freeze({
  'pr-unreadable': { scope: 'member', status: 'not-run', code: 'pr-unreadable' },
  'pr-closed': { scope: 'member', status: 'refused', code: 'pr-closed' },
  'pr-draft': { scope: 'member', status: 'refused', code: 'pr-draft' },
  'pr-retargeted': { scope: 'member', status: 'refused', code: 'pr-retargeted' },
  'head-moved': { scope: 'member', status: 'refused', code: 'head-moved' },
  'head-unaccounted': { scope: 'member', status: 'refused', code: 'head-moved' },
  'tree-unreadable': { scope: 'member', status: 'not-run', code: 'tree-unreadable' },
  'head-churn': { scope: 'member', status: 'not-run', code: 'head-churn' },
  'update-unverifiable': { scope: 'run' }, 'update-foreign': { scope: 'run' }, 'update-churn': { scope: 'run' }, 'update-failed': { scope: 'run' }, 'update-invisible': { scope: 'run' },
  conflict: { scope: 'member', status: 'refused', code: 'conflict' },
  behind: { scope: 'member', status: 'refused', code: 'behind-base' },
  'checks-failed': { scope: 'member', status: 'refused', code: 'checks-failed' },
  'checks-pending-deadline': { scope: 'member', status: 'not-run', code: 'checks-pending' },
  'merged-unaccounted': { scope: 'run' },
  'message-stop': { scope: 'run' },
  'merge-unconfirmed': { scope: 'run', status: 'not-run', code: 'merge-unconfirmed' },
  'shipped-head-refused': { scope: 'member', status: 'refused', code: 'shipped-head-refused' },
  'ci-refused': { scope: 'member', status: 'refused', code: 'ci-refused' },
  'ci-retry': { scope: 'member', status: 'not-run', code: 'checks-pending' },
  'ci-evidence-unknown': { scope: 'run' },
  'message-invalid': { scope: 'member', status: 'refused', code: 'message-invalid' },
  'message-unreadable': { scope: 'member', status: 'not-run', code: 'message-unreadable' },
  'member-refused': { scope: 'run' },
  'grant-revoked': { scope: 'run' }, 'base-moved': { scope: 'run' }, 'read-back-unmeasured': { scope: 'run', status: 'not-run', code: 'awaiting-read-back' },
  'record-inconsistent': { scope: 'run' }, 'merge-queue-present': { scope: 'run' }, 'rules-unreadable': { scope: 'run' }, 'merge-queued': { scope: 'run' },
  'policy-mismatch': { scope: 'run' }, 'internal-error': { scope: 'run' },
});

/**
 * `classifyMerged`: the pair `{step, outcome}` to persist when a PR is observed MERGED under a policy (§2.3 table). Pure.
 * @param {{step: object, doc: {headRefOid?: string, mergeCommit?: {oid?: string}|null}}} a
 * @returns {{step: string, outcome: object|null, attribution?: string, mergeOid?: string|null, external?: boolean, needsReadBack?: boolean}}
 */
export function classifyMerged({ step: s, doc }) {
  const mergeOid = doc.mergeCommit?.oid ?? null;
  const seen = doc.headRefOid ?? s.head;
  const ours = s.step === 'merge' && s.attempt && doc.headRefOid === s.attempt.head;
  if (!mergeOid) {
    if (s.step === 'merge') return { step: 'merged', outcome: { status: 'not-run', code: 'awaiting-read-back', reason: 'the PR is MERGED but GitHub reported no merge commit; resume re-reads it' }, mergeOid: null, needsReadBack: Boolean(ours) };
    return { step: s.step, outcome: { status: 'not-run', code: 'awaiting-merge-evidence', reason: 'the PR is MERGED but GitHub reported no merge commit; resume re-reads it' }, mergeOid: null };
  }
  if (ours) return { step: 'merged', outcome: null, attribution: s.attempt.ghExit === 0 ? 'this-run' : 'unknown', mergeOid, needsReadBack: true };
  return { step: 'merged', outcome: { status: 'skipped', code: 'merged-externally', mergeOid, seenHead: seen }, mergeOid, external: true };
}

/**
 * The read-back verdict (§2.3). A measured read-back gives the first matching verdict; `tree` only matters under the rollup policy.
 * @returns {{verdict: string, trees?: {expected: string, observed: string}}}
 */
export function verdictOf({ readBack, runBase, chainTail, candidateTree = null }) {
  if (readBack.baseRefName !== runBase) return { verdict: 'wrong-target' };
  if (readBack.firstParent !== chainTail) return { verdict: 'untested-base' };
  if (candidateTree && readBack.tree !== candidateTree) return { verdict: 'tree-mismatch', trees: { expected: candidateTree, observed: readBack.tree } };
  return { verdict: readBack.reasons?.length ? 'provenance-lost' : 'verified' };
}

const LEGAL_PAIRS = (s) => {
  const o = s.outcome ?? null;
  if (s.step === 'merged') return o !== null && (o.status === 'landed' || o.status === 'skipped' || (o.status === 'not-run' && o.code === 'awaiting-read-back'));
  if (s.step === 'merge') return o === null || (o.status === 'not-run' && o.code === 'merge-unconfirmed');
  if (o === null) return true;
  if (o.status === 'landed' || o.status === 'skipped') return false;
  if (o.status === 'not-run') return o.code !== 'merge-unconfirmed' && o.code !== 'awaiting-read-back';
  return true;
};

/**
 * The load-time invariants of §2.1. @returns {string|null} what is wrong, or null.
 */
export function validatePolicyRun(run) {
  const p = run.policy;
  if (!p) {
    if (run.finalized || run.halt || run.steps.some((s) => s.outcome || s.attempt)) return 'outcome, attempt, finalized and halt are written only by a policy run';
    return null;
  }
  const parsed = PolicySchema.safeParse(p);
  if (!parsed.success) return `policy: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
  const ids = run.steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) return 'step ids are not unique';
  if (p.name === 'ship-batch') {
    const keys = Object.keys(p.members).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...ids].sort())) return 'policy.members keys do not equal the step ids';
  } else if (run.steps.length !== 1 || run.steps[0].id !== p.rollup.branch || run.steps[0].testedOid !== p.rollup.candidate.oid) {
    return 'a rollup run is exactly one step, named by the rollup branch, at the candidate oid';
  }
  for (const s of run.steps) {
    if (s.outcome !== undefined && s.outcome !== null) {
      const r = OutcomeSchema.safeParse(s.outcome);
      if (!r.success) return `step ${s.id}: outcome ${r.error.issues[0]?.message ?? 'invalid'}`;
      const codes = CODE_ENUMS[s.outcome.status];
      if (codes && !codes.includes(s.outcome.code)) return `step ${s.id}: code ${s.outcome.code} is not one of ${s.outcome.status}'s`;
    }
    if (s.mergedOid && (s.outcome?.status === 'landed' || s.outcome?.status === 'skipped') && s.outcome.mergeOid !== s.mergedOid) return `step ${s.id}: mergedOid ${s.mergedOid.slice(0, 12)} is not its outcome's merge oid ${s.outcome.mergeOid.slice(0, 12)}`;
    if (!LEGAL_PAIRS(s)) return `step ${s.id}: phase ${s.step} with outcome ${s.outcome ? `${s.outcome.status}/${s.outcome.code}` : 'null'} is not a legal pair`;
    if (s.outcome?.status === 'not-run' && s.outcome.code === 'merge-unconfirmed' && !s.attempt) return `step ${s.id}: merge-unconfirmed needs an attempt`;
    const landed = s.outcome?.status === 'landed' ? s.outcome : null;
    if (p.name === 'rollup' && landed) {
      if (!landed.ci || !s.attempt?.ci || JSON.stringify(landed.ci) !== JSON.stringify(s.attempt.ci)) return `step ${s.id}: a rollup landed outcome carries the intent's ci, byte for byte`;
      if (s.attempt.ci.head !== s.attempt.head || s.attempt.ci.tree !== p.candidateTree) return `step ${s.id}: ci is not bound to the attempted head and the candidate tree`;
    }
    if (p.name === 'ship-batch' && (landed?.ci || s.attempt?.ci || s.attempt?.messageSha256)) return `step ${s.id}: ci and messageSha256 belong to the rollup policy`;
    if (landed && (landed.verdict === 'tree-mismatch') !== Boolean(landed.trees)) return `step ${s.id}: trees go with the tree-mismatch verdict, and only with it`;
  }
  const landedSteps = run.steps.filter((s) => s.outcome?.status === 'landed');
  const chained = landedSteps.filter((s) => s.outcome.chainIndex !== null);
  for (const s of landedSteps) {
    const o = s.outcome;
    const onChain = CHAIN_VERDICTS.includes(o.verdict);
    if (onChain !== (o.chainIndex !== null)) return `step ${s.id}: only ${CHAIN_VERDICTS.join(' and ')} take a chainIndex`;
  }
  const chain = p.baseChain;
  if (chained.length !== chain.length - 1) return 'the base chain does not match the landed records';
  for (let k = 1; k < chain.length; k += 1) {
    const hit = chained.filter((s) => s.outcome.chainIndex === k);
    if (hit.length !== 1 || hit[0].outcome.mergeOid !== chain[k] || hit[0].outcome.parent !== chain[k - 1]) return `the base chain entry ${k} is not held by exactly one landed record`;
  }
  const oids = [...landedSteps, ...run.steps.filter((s) => s.outcome?.status === 'skipped')].map((s) => s.outcome.mergeOid);
  if (new Set(oids).size !== oids.length) return 'a merge oid is repeated across members';
  if (run.finalized && !run.halt && !run.steps.every((s) => isTerminal(s.outcome))) return 'finalized needs every member terminal, or a halt';
  const haltedBy = run.steps.find((s) => s.outcome?.status === 'skipped' || (s.outcome?.status === 'landed' && HALT_VERDICTS.includes(s.outcome.verdict)));
  if (haltedBy && !run.halt) return 'a chain-invalidating outcome needs its halt record';
  return null;
}

/**
 * `combination` (§2.7): content only. The first matching rule wins.
 * @param {{steps: object[], policy: object}} run
 * @param {{tailTree: string|null}} trees  `tailTree`: the tree of the chain tail, or null when it could not be read
 */
export function combinationOf(run, { tailTree }) {
  const all = run.steps.every((s) => s.outcome?.status === 'landed');
  if (!all) return 'subset';
  if (run.steps.some((s) => s.outcome.chainIndex === null) || !tailTree || !run.policy.candidateTree) return 'unverified';
  return tailTree === run.policy.candidateTree ? 'tested' : 'different';
}

/**
 * The truth table of §2.8, computed once at finalization (or for a resumable stop). Pure.
 * @returns {{ok: boolean, combination: string, trainLanded: boolean, first: string, provenance: string[], tails: string[]}}
 */
export function summariseRun(run, { tailTree, stoppedReason = null }) {
  const steps = run.steps;
  const n = steps.length;
  const landed = steps.filter((s) => s.outcome?.status === 'landed');
  const verified = landed.filter((s) => s.outcome.verdict === 'verified');
  const notRun = steps.filter((s) => s.outcome?.status === 'not-run' || !s.outcome);
  const provenance = landed.filter((s) => s.outcome.verdict !== 'verified').map((s) => `PROVENANCE: ${s.id} ${s.outcome.verdict}`);
  const combination = combinationOf(run, { tailTree });
  const rollup = run.policy.name === 'rollup';
  const unproven = landed.some((s) => s.outcome.verdict === 'wrong-target' || s.outcome.verdict === 'tree-mismatch' || (rollup && s.outcome.verdict === 'untested-base'));
  const trainLanded = landed.length === n && !unproven;
  const tails = [];
  let first;
  let ok;
  if (run.halt && notRun.length) {
    ok = false; first = `halted: ${run.halt.code} on ${run.halt.member}; landed ${landed.length} of ${n}, ${notRun.length} not landed in this run: rebuild the train against the base as it is now (a resume does not continue a halted run)`;
  } else if (stoppedReason && notRun.length) {
    ok = false; first = `stopped: ${stoppedReason}; resumable: land --resume ${run.trainId} ${rollup ? '--rollup' : '--ship-batch'}`;
  } else if (notRun.length) {
    ok = false; first = `landed ${landed.length} of ${n}; ${notRun.length} not yet decided: land --resume ${run.trainId} ${rollup ? '--rollup' : '--ship-batch'} re-checks them`;
  } else if (landed.length === 0) {
    ok = false; first = 'nothing landed; every member needs the user';
  } else if (landed.length === n) {
    ok = provenance.length === 0 && combination === 'tested' && !run.halt;
    first = combination === 'tested' ? `landed ${n} of ${n}; final tree = the combined-tested tree` : `landed ${n} of ${n}; final tree is NOT the combined-tested tree: verify by hand`;
  } else {
    ok = verified.length > 0 && provenance.length === 0 && !run.halt;
    first = `landed ${landed.length} of ${n}: a SUBSET of the combined-tested set; ${n - landed.length} need the user (/ship in that session)`;
  }
  if (run.halt) tails.push(`HALT: ${run.halt.code} on ${run.halt.member}; no further member lands in this run, rebuild against the base as it is now`);
  return { ok, combination, trainLanded, first, provenance, tails };
}
