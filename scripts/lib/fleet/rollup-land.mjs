/**
 * @fileoverview `fleet land --rollup` (docs/plans/ship-batch-member-outcomes.md section 2.9): n ready chips land as ONE squash commit
 * on ONE PR, so CI runs once per batch. It is the smallest extension of the train and the serial runner, not a new system:
 *
 *   build   grant -> admission per member (rollup mode) -> HOLD what fails (never fail it) -> overlap holds -> one live rollup
 *           (supersede a never-requested one) -> the existing train build with a rollup message mode -> a write-once record.
 *   approve re-admit every member -> push the candidate to `rollup/<date>-<n>` -> open ONE PR -> a one-step serial run under the
 *           `rollup` policy (checks, a final manifest, `--squash --match-head-commit`, never `--auto`) -> a post-landing cleanup.
 *
 * Evidence is recorded in two places and never composed into one verdict: each member against its OWN head and tree, the rollup's
 * CI against the CANDIDATE tree. The rollup commit carries no `AI-*` trailer.
 *
 * @module scripts/lib/fleet/rollup-land
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { OID_RE } from './contracts.mjs';
import { assertManaged, fleetDir, listTrains, readTrain } from './registry.mjs';
import { payloadFromStatus } from './facts.mjs';
import { approvable } from './overlap.mjs';
import { branchOfRef, patchTrain, withTrainLock, buildTrain } from './train.mjs';
import { observeRequiredChecks, requiredInventory } from './required-checks.mjs';
import { GRANT_VERSION } from './coordinator-grant.mjs';
import { readSerial, resumeSerial, startPolicyRun } from './serial.mjs';
import { RollupPolicySchema } from './member-outcome.mjs';
import {
  admitMember, commitMessage, createOnly, grantRefusal, listReadyMembers, runShippedHeadChild, summaryText,
} from './ship-batch.mjs';
import {
  bodyOfMessage, overlapHolds, renderRollupManifest, rollupBranchName, sha256Body, ROLLUP_BRANCH_RE,
} from './rollup.mjs';

export const ROLLUP_RECORD_SCHEMA = 1;
const TRAIN_REMOTE = 'origin';
const Oid = z.string().regex(OID_RE);
const short = (o) => String(o ?? '?').slice(0, 12);
const refused = (reason, text) => ({ ok: false, code: 'refused', reason, text: text ?? `REFUSED: ${reason}` });

// ---- the write-once build record ----------------------------------------------------------------------------------------------

export const RollupRecordSchema = z.strictObject({
  schemaVersion: z.literal(ROLLUP_RECORD_SCHEMA), trainId: z.string().min(1), grantVersion: z.string().min(1), checkedAt: z.string().min(1),
  base: z.string().min(1), remote: z.string().min(1), candidateTree: Oid,
  members: z.array(z.strictObject({
    id: z.string().min(1), branch: z.string().min(1), head: Oid, tree: Oid, runId: z.string().nullable(), gate: z.string().nullable(), finalReview: z.string().nullable(),
    repo: z.string().nullable(), prNumber: z.number().int().positive().nullable(), worktree: z.string().nullable(),
  })).min(1),
  held: z.array(z.strictObject({ id: z.string().min(1), reason: z.string().min(1) })),
});
const rollupDir = (dir) => path.join(dir, 'rollup');
export const rollupRecordPath = (dir, trainId) => assertManaged(dir, path.join(rollupDir(dir), `${trainId}.json`));
const bodyPath = (dir, trainId) => assertManaged(dir, path.join(rollupDir(dir), `${trainId}.body.md`));

export function readRollupRecord(dir, trainId) {
  let text;
  try { text = fs.readFileSync(rollupRecordPath(dir, trainId), 'utf-8'); } catch (e) { return { ok: false, reason: e.code === 'ENOENT' ? 'no rollup record' : `unreadable: ${e.message}` }; }
  try {
    const r = RollupRecordSchema.safeParse(JSON.parse(text));
    return r.success && r.data.trainId === trainId ? { ok: true, rec: r.data } : { ok: false, reason: 'the rollup record is invalid' };
  } catch (e) { return { ok: false, reason: `malformed JSON: ${e.message}` }; }
}
function writeRollupRecord(dir, rec) {
  const r = RollupRecordSchema.parse(rec);
  fs.mkdirSync(rollupDir(dir), { recursive: true });
  if (!createOnly(rollupRecordPath(dir, r.trainId), `${JSON.stringify(r, null, 2)}\n`).created) throw new Error(`the rollup record for ${r.trainId} already exists and is write-once`);
  return r;
}

// ---- admission, by branch ----------------------------------------------------------------------------------------------------

/** The remote tip of a branch, or null. */
function remoteTip(deps, cwd, remote, branch) {
  const r = deps.git(['ls-remote', remote, `refs/heads/${branch}`], cwd, { timeoutMs: 60_000 });
  const oid = r.ok ? r.stdout.trim().split(/\s+/)[0] : '';
  return OID_RE.test(oid) ? oid : null;
}

/** Gather a rollup candidate at `head` (the child and the branch tip, NO CI) and judge it with `admitMember`. */
export function admitRollupMember({ cwd, member, head, base, remote, deps }) {
  const checkChild = deps.shipBatch?.checkChild ?? runShippedHeadChild;
  const child = checkChild({ worktree: member.worktree, head, base, remote });
  const tip = remoteTip(deps, cwd, remote, member.branch);
  const a = admitMember('rollup', { base, remote }, { mode: 'rollup', head, child, branchTip: tip });
  return { ...a, child };
}

const envelopeEvidence = (env) => ({
  runId: typeof env?.runId === 'string' ? env.runId : null, gate: typeof env?.gate === 'string' ? env.gate : null,
  finalReview: Array.isArray(env?.conditions) && env.conditions.some((c) => /final/i.test(String(c?.id)) && c?.ok === true) ? 'approve' : null,
});

// ---- build ----------------------------------------------------------------------------------------------------------------------

const LIVE_PHASES = new Set(['landed', 'abandoned']);

/**
 * One live rollup per repo, with supersession (§2.9.1 step 4): a rollup whose approve never requested a merge is superseded
 * (kept, abandoned, never approvable again); anything that may have a merge in flight blocks the build.
 * @returns {{ok: true, supersede: string[]} | {ok: false, reason: string}}
 */
function liveRollups(dir) {
  const supersede = [];
  const all = listTrains(dir);
  if (!all.complete) return { ok: false, reason: `the trains directory is incomplete (${all.invalid.map((i) => i.file).join(', ')}): a rollup is never built on partial data` };
  for (const t of all.trains) {
    if (t.landing !== 'rollup' || LIVE_PHASES.has(t.phase)) continue;
    const run = readSerial(dir, t.trainId);
    if (!run.ok && !run.absent) return { ok: false, reason: `the serial record of rollup ${t.trainId} cannot be read (${run.reason}): its merge state is unknown, so a new rollup is blocked until it is recovered` };
    const requested = run.ok && run.run.steps.some((s) => s.attempt || s.step === 'merge' || s.step === 'merged');
    if (requested) return { ok: false, reason: `rollup ${t.trainId} may have a merge in flight (${t.phase}): settle it with land --resume ${t.trainId} --rollup before building another` };
    supersede.push(t.trainId);
  }
  return { ok: true, supersede };
}

/**
 * `fleet land --rollup [--select ids] [--hold ids]`. `buildFn` is injectable for tests; the default is `buildTrain`.
 * @returns {object} a land result
 */
export function buildRollup(ctx, flags, deps, { parseSelect }) {
  const { cwd, cmd } = ctx;
  const gr = grantRefusal(deps);
  if (gr) return refused(gr.reason, `REFUSED: ${gr.reason}\n(declaration check, not verified authority: Louis writes the grant in his own ~/.claude/CLAUDE.md)`);
  const dir = ctx.dir ?? fleetDir(cwd);
  const listed = deps.shipBatch?.members ? { ok: true, members: deps.shipBatch.members } : listReadyMembers(ctx);
  if (!listed.ok) return refused(listed.reason);
  const hold = flags['--hold'] !== undefined ? parseSelect(flags['--hold']) : [];
  const readyIds = new Set(listed.members.map((m) => m.id));
  const unknownHold = hold.filter((id) => !readyIds.has(id));
  if (unknownHold.length) return refused(`--hold names a session that is not ready to land: ${unknownHold.join(', ')}`);
  let members = listed.members;
  if (flags['--select'] !== undefined) { const want = new Set(parseSelect(flags['--select'])); members = members.filter((m) => want.has(m.id)); }
  const base = ctx.config.baseBranch;
  const held = [];
  const admitted = [];
  for (const m of members) {
    if (hold.includes(m.id)) { held.push({ id: m.id, reason: 'held-by-coordinator' }); continue; }
    if (!m.oid || !m.branch) { held.push({ id: m.id, reason: 'no ready oid or branch recorded' }); continue; }
    const a = admitRollupMember({ cwd, member: m, head: m.oid, base, remote: TRAIN_REMOTE, deps });
    if (!a.ok) { held.push({ id: m.id, reason: `${a.kind}: ${a.reasons.join('; ')}` }); continue; }
    admitted.push({ ...m, evidence: envelopeEvidence(a.child.envelope) });
  }
  // Overlap: two members that touch one path never share a rollup (the later one is held).
  const withPaths = admitted.map((m) => { const d = deps.git(['diff', '--name-only', '--no-renames', `${base}...${m.oid}`], cwd, { timeoutMs: 60_000 }); return { id: m.id, paths: d.ok ? d.stdout.split('\n').filter(Boolean) : null }; });
  const unreadable = withPaths.filter((p) => p.paths === null).map((p) => p.id);
  for (const id of unreadable) held.push({ id, reason: 'paths-unreadable: the changed paths could not be read, so overlap cannot be excluded' });
  const ov = overlapHolds(withPaths.filter((p) => p.paths !== null), ctx.config.appendOnlyGlobs ?? []);
  held.push(...ov.held);
  const kept = admitted.filter((m) => ov.kept.includes(m.id));
  const heldText = held.map((h) => `  held  ${h.id}: ${h.reason}`);
  if (!kept.length) return { ok: false, code: 'refused', reason: 'no member is admitted', held, text: `REFUSED: no member is admitted to the rollup; nothing was built, pushed or changed\n${heldText.join('\n')}` };
  // ONE critical section (R1-H4): the live-rollup check, the build, the record and the supersession can never interleave with another build.
  const sources = kept.map((m) => ({ id: m.id, gen: m.gen, rev: m.rev, oid: m.oid, kind: m.kind === 'pr' ? 'pr' : 'branch', repo: m.repo ?? null, prNumber: m.prNumber ?? null, headRepo: m.headRepo ?? null, baseRef: m.baseRef ?? null, pr: null }));
  const section = withTrainLock(dir, () => {
    const live = liveRollups(dir);
    if (!live.ok) return { fail: refused(live.reason) };
    const built = buildTrain({ cwd, config: { ...ctx.config, mergeMethod: 'direct-squash' }, sources, checkPayload: listed.payload ?? { sessions: [], overlaps: [] }, deps, rollup: true });
    if (!built.ok || !built.train) return { fail: { ...built, held, text: `${built.code === 'error' ? 'ERROR' : 'REFUSED'}: ${built.reason}${heldText.length ? `\n${heldText.join('\n')}` : ''}` } };
    const train = built.train;
    if (train.conflict) return { fail: { ok: false, code: 'refused', reason: `the candidate could not be built: ${train.conflict.reason} at ${train.conflict.sourceId}`, held, text: `REFUSED: the candidate could not be built (${train.conflict.reason} at ${train.conflict.sourceId}); no rollup record was written, nothing was pushed` } };
    const trees = kept.map((m) => deps.git(['rev-parse', `${m.oid}^{tree}`], cwd, { timeoutMs: 60_000 }));
    const bad = trees.findIndex((x) => !x.ok);
    if (!train.candidate?.tree || bad >= 0) return { fail: { ...built, ok: false, code: 'refused', reason: 'the candidate or a member tree could not be read', text: 'REFUSED: the candidate or a member tree could not be read; no rollup record was written', held } };
    writeRollupRecord(dir, {
      schemaVersion: ROLLUP_RECORD_SCHEMA, trainId: train.trainId, grantVersion: GRANT_VERSION, checkedAt: ctx.now.toISOString(), base, remote: train.destination.remote, candidateTree: train.candidate.tree,
      members: kept.map((m, i) => ({ id: m.id, branch: m.branch, head: m.oid, tree: trees[i].stdout.trim(), ...m.evidence, repo: m.repo ?? null, prNumber: m.prNumber ?? null, worktree: m.worktree ?? null })),
      held,
    });
    for (const id of live.supersede) {
      const old = readTrain(dir, id);
      if (old.ok) patchTrain(dir, id, { phase: 'abandoned', result: 'none', notes: [`superseded by ${train.trainId}`], ...(old.train.rollup ? { rollup: { ...old.train.rollup, superseded: train.trainId } } : {}) }, deps);
    }
    return { t: train, live };
  });
  if (section.fail) return section.fail;
  const { t, live } = section;
  const lines = [
    `rollup ${t.trainId}: ${kept.length} member(s) admitted, ${held.length} held`, ...kept.map((m) => `  admitted  ${m.id} (${m.branch} @ ${short(m.oid)}, gate ${m.evidence.gate ?? '?'})`), ...heldText,
    ...(live.supersede.length ? [`superseded (never requested a merge; artifacts kept): ${live.supersede.join(', ')}`] : []),
    `approve (the grant covers it): ${cmd} land --approve ${t.trainId} --rollup`,
  ];
  return { ok: true, code: 'ok', trainId: t.trainId, rollup: true, held, train: t, text: lines.join('\n') };
}

// ---- the policy ------------------------------------------------------------------------------------------------------------------

/** The ONE constructor of the persisted rollup policy: creation and adoption both call it, so they cannot drift (R3-H3). */
export function rollupPolicyFrom({ train, rec, branch, prNumber }) {
  return RollupPolicySchema.parse({
    name: 'rollup', grantVersion: rec.grantVersion, remote: rec.remote, candidateTree: rec.candidateTree, baseChain: [train.destination.expectedOid],
    excluded: rec.held.map((h) => ({ id: h.id, prNumber: null, reasons: [h.reason] })),
    members: rec.members.map((m) => ({ id: m.id, branch: m.branch, head: m.head, tree: m.tree, runId: m.runId, gate: m.gate, finalReview: m.finalReview })),
    rollup: { branch, repo: train.rollup?.repo ?? rec.members.find((m) => m.repo)?.repo ?? 'unknown/unknown', prNumber, candidate: { oid: train.candidate.oid, tree: train.candidate.tree } },
  });
}

/** The runtime policy of a rollup run: pure decisions the serial loop asks, and never writes through. */
export function makeRollupPolicy({ cwd, trainId, deps, rec, train, branch, prNumber, requiredChecks, requiredChecksError = null }) {
  return {
    name: 'rollup',
    treeIdentity: false,
    persisted: rollupPolicyFrom({ train, rec, branch, prNumber }),
    grantRefusal: () => grantRefusal(deps),
    testedTree: () => rec.candidateTree,
    admit: ({ s, h, run }) => {
      for (const m of rec.members) {
        const a = admitRollupMember({ cwd, member: m, head: m.head, base: run.base, remote: run.remote, deps });
        if (!a.ok) return { ok: false, kind: 'member-refused', reason: `${m.id}: ${a.kind}: ${a.reasons.join('; ')}` };
      }
      const tree = deps.git(['rev-parse', `${h}^{tree}`], cwd, { timeoutMs: 60_000 });
      if (!tree.ok) return { ok: false, kind: 'tree-unreadable', reason: `the tree of the rollup head ${short(h)} could not be read` };
      if (h !== train.candidate.oid || tree.stdout.trim() !== rec.candidateTree) return { ok: false, kind: 'member-refused', reason: `the rollup PR head ${short(h)} is not the tested candidate ${short(train.candidate.oid)}` };
      const inv = requiredInventory(cwd, { repo: s.repo, base: run.base, configured: requiredChecks, configError: requiredChecksError, gh: deps.gh });
      const obs = observeRequiredChecks(cwd, { pr: s.prNumber, repo: s.repo, inventory: inv, expectHead: h, gh: deps.gh });
      if (obs.verdict === 'none-required') return { ok: false, kind: 'ci-refused', reason: `no required checks are configured on ${run.base}, so nothing would measure the rollup's CI at ${short(h)}: declare them (branch rules or .fleet.json requiredChecks) before landing by rollup` };
      if (obs.verdict !== 'pass') return { ok: false, kind: 'ci-refused', reason: `the rollup's required checks are ${obs.verdict} at ${short(h)}` };
      const checks = (obs.observed ?? []).filter((o) => !inv.names.length || inv.names.includes(o.name)).map((o) => ({ name: String(o.name), conclusion: String(o.bucket ?? o.state ?? 'unknown') }));
      const ci = { head: h, tree: rec.candidateTree, observedAt: deps.now().toISOString(), checks };
      const manifest = renderRollupManifest({
        stage: 'final', rollupId: branch, base: run.base, candidate: { oid: train.candidate.oid, tree: rec.candidateTree },
        members: rec.members.map((m) => ({ id: m.id, branch: m.branch, head: m.head, tree: m.tree, runId: m.runId, gate: m.gate, finalReview: m.finalReview })), held: rec.held, ci,
      });
      return { ok: true, message: { subject: `fleet rollup ${branch}: ${rec.members.length} member${rec.members.length === 1 ? '' : 's'}`, body: manifest }, messageSha256: sha256Body(manifest), ci };
    },
    readBack: ({ s, mergeOid, doc, run }) => {
      const git = (args) => deps.git(args, cwd, { timeoutMs: 120_000 });
      const f = git(['fetch', '--no-tags', run.remote, `refs/heads/${run.base}`]);
      if (!f.ok) return { measured: false, why: `the base could not be fetched (${f.reason})` };
      const parents = git(['rev-list', '--parents', '-n', '1', mergeOid]);
      const tree = git(['rev-parse', `${mergeOid}^{tree}`]);
      const msg = commitMessage(deps, cwd, mergeOid);
      if (!parents.ok || !tree.ok || msg === null) return { measured: false, why: 'the squash commit could not be read' };
      const same = s.attempt?.messageSha256 && s.attempt.messageSha256 === sha256Body(bodyOfMessage(msg));
      return {
        measured: true, firstParent: parents.stdout.trim().split(/\s+/)[1] ?? null, tree: tree.stdout.trim(), gate: null, baseRefName: doc?.baseRefName ?? null,
        reasons: same ? [] : ['the squash body is not the final manifest that was pinned in the merge request'],
      };
    },
  };
}

// ---- the post-landing cleanup: close member PRs, bound to their admitted heads (R2-H3, R3-H2) --------------------------------------

/**
 * Close a PR ONLY while it still carries the admitted head, and verify the close (R2-H2, H3, M2-M4). `gh pr close` has no head
 * condition, so a push between the read and the close cannot be excluded; it is DETECTED by a second read, which must parse and name
 * the same head, else the close is UNVERIFIED (status `failed`, reconciled by the next run, which reads the PR first, so a close that
 * landed before a crash is simply found already closed).
 * @returns {{status: 'closed'|'failed'|'skipped-head-moved', reason: string|null}}
 */
function closeBoundToHead({ deps, cwd, repo, number, head, comment }) {
  const read = () => {
    const v = deps.gh(['pr', 'view', String(number), '-R', repo, '--json', 'state,headRefOid'], cwd);
    try {
      const d = v.ok ? JSON.parse(v.stdout) : null;
      return d && typeof d.state === 'string' && OID_RE.test(String(d.headRefOid)) ? d : null;
    } catch { return null; }
  };
  const before = read();
  if (!before) return { status: 'failed', reason: 'the PR could not be read before the close' };
  if (before.state.toUpperCase() !== 'OPEN') return { status: 'closed', reason: null }; // reconciled: nothing is left to close
  if (before.headRefOid !== head) return { status: 'skipped-head-moved', reason: `the PR head is ${short(before.headRefOid)}, not the admitted ${short(head)}: it holds work that did not land` };
  const x = deps.gh(['pr', 'close', String(number), '-R', repo, '--comment', comment], cwd);
  if (!x.ok) return { status: 'failed', reason: String(x.reason ?? 'gh pr close failed').slice(0, 200) };
  const after = read();
  if (!after) return { status: 'failed', reason: 'the PR could not be read after the close, so the close is unverified: re-run to reconcile' };
  if (after.headRefOid !== head) return { status: 'failed', reason: `the head moved to ${short(after.headRefOid)} around the close: gh pr reopen ${number} if those commits should stay open`.slice(0, 290) };
  if (after.state.toUpperCase() === 'OPEN') return { status: 'failed', reason: 'the PR is still OPEN after the close: re-run to reconcile' };
  return { status: 'closed', reason: null };
}

/** Member PRs are closed only when the candidate content is PROVEN on the base (verified or provenance-lost); never otherwise. */
function closeMemberPrs({ cwd, dir, trainId, deps, run, result }) {
  const o = run.steps[0]?.outcome;
  if (run.finalized === undefined || o?.status !== 'landed' || !['verified', 'provenance-lost'].includes(o.verdict)) return result;
  const t = readTrain(dir, trainId);
  if (!t.ok || !t.train.rollup) return result;
  const pending = new Map((t.train.rollup.closures ?? []).map((c) => [c.prNumber, c]));
  for (const src of t.train.sources) if (src.prNumber && !pending.has(src.prNumber)) pending.set(src.prNumber, { prNumber: src.prNumber, head: src.oid, status: 'pending', reason: null });
  const repoOf = (n) => t.train.sources.find((x) => x.prNumber === n)?.repo ?? t.train.rollup.repo;
  const next = [...pending.values()].map((c) => {
    if (c.status === 'closed' || c.status === 'skipped-head-moved') return c;
    return { ...c, ...closeBoundToHead({ deps, cwd, repo: repoOf(c.prNumber), number: c.prNumber, head: c.head, comment: `superseded by #${t.train.rollup.prNumber} (fleet rollup ${t.train.rollup.branch})` }) };
  });
  if (next.length) patchTrain(dir, trainId, { rollup: { ...t.train.rollup, closures: next } }, deps);
  const open = next.filter((c) => c.status !== 'closed');
  return open.length ? { ...result, cleanup: open } : result;
}

// ---- approve / resume --------------------------------------------------------------------------------------------------------------

/** Why the record is not about this train: the candidate, and every source in order (id, oid, repo, PR) against its member. @returns {string|null} */
export function rollupTrainProblem(rec, train) {
  if (train.candidate?.tree !== rec.candidateTree) return `the candidate tree ${short(train.candidate?.tree)} is not the recorded ${short(rec.candidateTree)}`;
  if (train.sources.length !== rec.members.length) return `the record names ${rec.members.length} member(s), the train merges ${train.sources.length}`;
  for (const [i, m] of rec.members.entries()) {
    const src = train.sources[i];
    if (src.id !== m.id || src.oid !== m.head) return `member ${i + 1} is ${m.id}@${short(m.head)} in the record but ${src.id}@${short(src.oid)} in the train`;
    if ((src.repo ?? null) !== (m.repo ?? null) || (src.prNumber ?? null) !== (m.prNumber ?? null)) return `member ${m.id}: the record and the train name different PRs`;
  }
  return null;
}

function preflight({ dir, trainId, deps }) {
  const gr = grantRefusal(deps);
  if (gr) return refused(gr.reason);
  const rec = readRollupRecord(dir, trainId);
  if (!rec.ok) return refused(`train ${trainId} is not a rollup (${rec.reason}): build it with \`land --rollup\``);
  const t = readTrain(dir, trainId);
  if (!t.ok) return refused(`the train ${trainId} cannot be read (${t.reason})`);
  if (t.train.landing !== 'rollup') return refused(`train ${trainId} is not a rollup train`);
  if (t.train.phase === 'abandoned') return refused(`train ${trainId} is abandoned (superseded or abandoned by hand): it is never approved or resumed`);
  const mismatch = rollupTrainProblem(rec.rec, t.train);
  if (mismatch) return refused(`the rollup record does not describe train ${trainId}: ${mismatch}`);
  return { ok: true, rec: rec.rec, train: t.train };
}

/** The lowest free `rollup/<date>-<n>` on the remote. */
function freeBranch(deps, cwd, remote, now) {
  const r = deps.git(['ls-remote', remote, 'refs/heads/rollup/*'], cwd, { timeoutMs: 60_000 });
  if (!r.ok) return null;
  const taken = new Set(r.stdout.split('\n').map((l) => l.split(/\s+/)[1]?.replace('refs/heads/', '')).filter(Boolean));
  for (let n = 1; n < 1000; n += 1) { const b = rollupBranchName(now, n); if (!taken.has(b)) return b; }
  return null;
}

const ghList = (deps, cwd, repo, branch, base) => {
  const r = deps.gh(['pr', 'list', '-R', repo, '--head', branch, '--base', base, '--state', 'all', '--json', 'number,state,headRefOid,baseRefName'], cwd);
  try { return r.ok ? { ok: true, rows: JSON.parse(r.stdout || '[]') } : { ok: false, reason: r.reason ?? 'gh failed' }; } catch { return { ok: false, reason: 'gh returned unparseable JSON' }; }
};

/**
 * The operation record's progress, reconciled from the REMOTE before each retry (R1-H7): push, then PR, then the serial run. Runs
 * under the train lock and returns before the serial loop, which takes `serial/<t>.lock` (the order is always train, then serial).
 */
function advanceOperation({ cwd, dir, trainId, deps, rec, train0, serialOpts }) {
  let t = train0;
  let repo = t.rollup?.repo ?? rec.members.find((m) => m.repo)?.repo ?? t.sources.find((s) => s.repo)?.repo;
  if (!repo) { // branch-only members name no repository: ask GitHub which one this checkout is
    const v = deps.gh(['repo', 'view', '--json', 'nameWithOwner'], cwd);
    try { repo = v.ok ? JSON.parse(v.stdout).nameWithOwner : null; } catch { repo = null; }
  }
  if (!repo) return refused('the rollup has no repository to open its PR in (no member names one and gh could not say)');
  const base = branchOfRef(t.destination.ref);
  if (!t.rollup) {
    const approv = approvable(t, { acceptRerun: false });
    if (!approv.ok) return refused(approv.reason);
    const tip = remoteTip(deps, cwd, t.destination.remote, base);
    if (tip !== t.destination.expectedOid) return refused(`base-moved: ${base} is ${short(tip)}, the candidate was built on ${short(t.destination.expectedOid)}: rebuild the rollup`);
    for (const m of rec.members) {
      const a = admitRollupMember({ cwd, member: m, head: m.head, base, remote: t.destination.remote, deps });
      if (!a.ok) return refused(`member-refused:${m.id}: ${a.kind}: ${a.reasons.join('; ')} (rebuild with --hold ${m.id})`);
    }
    const branch = freeBranch(deps, cwd, t.destination.remote, deps.now());
    if (!branch) return refused('could not read the remote to choose a free rollup branch');
    t = patchTrain(dir, trainId, { rollup: { branch, repo, candidate: { oid: t.candidate.oid, tree: t.candidate.tree }, phase: 'push-intent', prNumber: null } }, deps);
  }
  const op = () => t.rollup;
  if (op().phase === 'push-intent') {
    const tip = remoteTip(deps, cwd, t.destination.remote, op().branch);
    if (tip && tip !== op().candidate.oid) return refused(`rollup-branch-foreign: ${op().branch} exists at ${short(tip)}, not the candidate ${short(op().candidate.oid)}`);
    if (!tip) {
      const p = deps.git(['push', t.destination.pushUrl, `${op().candidate.oid}:refs/heads/${op().branch}`, `--force-with-lease=refs/heads/${op().branch}:`], cwd, { timeoutMs: 300_000 });
      if (!p.ok) return refused(`the candidate could not be pushed to ${op().branch} (${p.reason}); nothing else was done, re-run to retry`);
    }
    t = patchTrain(dir, trainId, { rollup: { ...op(), phase: 'pushed' } }, deps);
  }
  if (op().phase === 'pushed' || op().phase === 'pr-intent') {
    if (op().phase === 'pushed') t = patchTrain(dir, trainId, { rollup: { ...op(), phase: 'pr-intent' } }, deps);
    const l = ghList(deps, cwd, repo, op().branch, base);
    if (!l.ok) return refused(`rollup-pr-ambiguous: the PRs of ${op().branch} could not be listed (${l.reason})`);
    let number = null;
    if (l.rows.length === 0) {
      fs.mkdirSync(rollupDir(dir), { recursive: true });
      const body = renderRollupManifest({
        stage: 'provisional', rollupId: op().branch, base, candidate: op().candidate,
        members: rec.members.map((m) => ({ id: m.id, branch: m.branch, head: m.head, tree: m.tree, runId: m.runId, gate: m.gate, finalReview: m.finalReview })), held: rec.held,
      });
      atomicWriteFileSync(bodyPath(dir, trainId), body);
      const c = deps.gh(['pr', 'create', '-R', repo, '--base', base, '--head', op().branch, '--title', `fleet rollup ${op().branch}: ${rec.members.length} members`, '--body-file', bodyPath(dir, trainId)], cwd);
      const m = c.ok ? /\/pull\/(\d+)/.exec(String(c.stdout)) : null;
      if (!m) return refused(`the rollup PR could not be opened (${c.reason ?? 'no PR url in the answer'}); re-run to reconcile`);
      number = Number(m[1]);
    } else if (l.rows.length === 1 && String(l.rows[0].state).toUpperCase() === 'OPEN' && l.rows[0].headRefOid === op().candidate.oid && l.rows[0].baseRefName === base) {
      number = l.rows[0].number;
    } else return refused(`rollup-pr-ambiguous: ${l.rows.length} PR(s) exist for ${op().branch}, not exactly one OPEN PR at the candidate`);
    t = patchTrain(dir, trainId, { rollup: { ...op(), phase: 'pr-open', prNumber: number } }, deps);
  }
  if (op().phase === 'pr-open') {
    const existing = readSerial(dir, trainId);
    const policy = makeRollupPolicy({ cwd, trainId, deps, rec, train: t, branch: op().branch, prNumber: op().prNumber, requiredChecks: serialOpts?.requiredChecks, requiredChecksError: serialOpts?.requiredChecksError });
    if (existing.ok) {
      const r = existing.run;
      const same = JSON.stringify(r.policy.rollup) === JSON.stringify(policy.persisted.rollup) && r.policy.candidateTree === policy.persisted.candidateTree && r.policy.name === 'rollup' && r.steps.length === 1 && r.steps[0].id === op().branch && r.steps[0].prNumber === op().prNumber && r.steps[0].testedOid === op().candidate.oid;
      if (!same) return refused(`rollup-run-mismatch: the serial run of ${trainId} does not carry this rollup's identity`);
    } else {
      const stamp = deps.now().toISOString();
      const started = startPolicyRun({ dir, run: {
        schemaVersion: 1, trainId, startedAt: stamp, updatedAt: stamp, timeoutMs: serialOpts?.timeoutMs ?? 60 * 60 * 1000, base, remote: t.destination.remote, outcome: null, policy: policy.persisted,
        steps: [{ id: op().branch, prNumber: op().prNumber, repo, testedOid: op().candidate.oid, step: 'pending', head: op().candidate.oid, accounted: [op().candidate.oid], updates: 0, priorHead: null, mergedOid: null, note: null, at: stamp }],
      } });
      if (!started.ok) return refused(started.reason);
      t = patchTrain(dir, trainId, { phase: 'awaiting-merge' }, deps);
    }
    t = patchTrain(dir, trainId, { rollup: { ...op(), phase: 'run-started' } }, deps);
  }
  return { ok: true, train: t, rec };
}

function runPhase({ cwd, dir, trainId, deps, serialOpts, rec, train, supersededLines = [] }) {
  const policy = makeRollupPolicy({ cwd, trainId, deps, rec, train, branch: train.rollup.branch, prNumber: train.rollup.prNumber, requiredChecks: serialOpts?.requiredChecks, requiredChecksError: serialOpts?.requiredChecksError });
  const r = resumeSerial({ cwd, trainId, deps, ...serialOpts, policy });
  const rd = readSerial(dir, trainId);
  if (!rd.ok) return { ...r, ok: false, code: 'refused', reason: r.reason ?? rd.reason, text: `REFUSED: ${r.reason ?? rd.reason}` };
  const cleaned = rd.run.finalized ? withTrainLock(dir, () => closeMemberPrs({ cwd, dir, trainId, deps, run: rd.run, result: r })) : r;
  const extra = [...supersededLines, ...(cleaned.cleanup ?? []).map((c) => `  member PR #${c.prNumber}: ${c.status}${c.reason ? ` (${c.reason})` : ''}`), ...(!rd.run.finalized && r.reason ? [`stopped: ${r.reason}`] : [])];
  if (rd.run.steps[0]?.outcome?.status === 'not-run' && rd.run.steps[0].outcome.code === 'checks-pending') extra.push('the required checks have not finished: land --resume <train> --rollup keeps waiting');
  if (rd.run.steps[0]?.outcome?.code === 'checks-failed' || (r.reason && /checks-failed|required checks/.test(r.reason))) extra.push(`Eject a suspect and rebuild: land --rollup --hold <member>. A green rebuild without a member does NOT prove it at fault.`);
  const { res, text } = summaryText(rd.run, trainId, extra, 'rollup');
  const ok = Boolean(r.ok);
  return { ...r, ok, code: ok ? 'ok' : (r.code && r.code !== 'ok' ? r.code : 'refused'), ...(ok || r.reason ? {} : { reason: res.first }), rollup: true, text };
}

/**
 * Close the rollup PRs this train superseded. Progress is durable on the OLD train (`rollup.closures`), each close is checked, and an
 * outstanding one is retried on every approve and resume (R1-H9, M10). It never fails the landing: it reports.
 * @returns {string[]} lines for the summary
 */
function closeSuperseded({ cwd, dir, trainId, deps }) {
  const lines = [];
  const me = readTrain(dir, trainId);
  const number = me.ok ? me.train.rollup?.prNumber : null;
  if (!number) return lines;
  for (const old of listTrains(dir).trains) {
    if (old.rollup?.superseded !== trainId || !old.rollup.prNumber) continue;
    if ((old.rollup.closures ?? []).some((c) => c.prNumber === old.rollup.prNumber && (c.status === 'closed' || c.status === 'skipped-head-moved'))) continue;
    const r = closeBoundToHead({ deps, cwd, repo: old.rollup.repo, number: old.rollup.prNumber, head: old.rollup.candidate.oid, comment: `superseded by #${number} (fleet rollup ${me.train.rollup.branch})` });
    const entry = { prNumber: old.rollup.prNumber, head: old.rollup.candidate.oid, status: r.status, reason: r.reason };
    withTrainLock(dir, () => patchTrain(dir, old.trainId, { rollup: { ...old.rollup, closures: [...(old.rollup.closures ?? []).filter((c) => c.prNumber !== entry.prNumber), entry] } }, deps));
        if (r.status !== 'closed') lines.push(`  superseded rollup PR #${old.rollup.prNumber}: ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.status === 'failed' ? '; the next approve or resume reconciles it' : ''}`);
  }
  return lines;
}

/** `land --approve <train> --rollup`. */
export function approveRollup({ cwd, dir, trainId, deps, serialOpts }) {
  const p = preflight({ dir, trainId, deps });
  if (!p.ok) return p;
  const adv = withTrainLock(dir, () => advanceOperation({ cwd, dir, trainId, deps, rec: p.rec, train0: readTrain(dir, trainId).train, serialOpts }));
  if (!adv.ok) return adv;
  return runPhase({ cwd, dir, trainId, deps, serialOpts, rec: p.rec, train: adv.train, supersededLines: closeSuperseded({ cwd, dir, trainId, deps }) });
}

/** `land --resume <train> --rollup`: a finalized run needs no grant and no remote read (R3-M1); otherwise the operation is reconciled first. */
export function resumeRollup({ cwd, dir, trainId, deps, serialOpts }) {
  const rd = readSerial(dir, trainId);
  const rec = readRollupRecord(dir, trainId);
  const tr = readTrain(dir, trainId);
  if (!rec.ok || !tr.ok || tr.train.landing !== 'rollup') return refused(`train ${trainId} is not a rollup`);
  if (rd.ok && rd.run.finalized) return runPhase({ cwd, dir, trainId, deps, serialOpts, rec: rec.rec, train: tr.train, supersededLines: closeSuperseded({ cwd, dir, trainId, deps }) });
  return approveRollup({ cwd, dir, trainId, deps, serialOpts });
}

export { ROLLUP_BRANCH_RE };
