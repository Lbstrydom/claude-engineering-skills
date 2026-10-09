/**
 * @fileoverview The OUTWARD half of /fleet's train: approval, confirmation and
 * reconciliation. Everything before approval is disposable and local; this is the
 * one boundary that is not, so it is deliberately the most defensive code here.
 *
 *  - `approveTrain` consumes the MANIFEST ONLY — it takes no config. Eligibility is
 *    the pure `overlap.mjs:approvable`; then every recorded fact is re-verified
 *    against the live world (URLs, the remote ref, the local base, each source
 *    head, the candidate's structure). A difference is a refusal that names what
 *    moved; an unreachable remote is a refusal, never a proceed on stale knowledge.
 *  - Direct modes write `push-pending` BEFORE the push and push to the RECORDED
 *    `pushUrl` (never the remote name) with an expected-old-OID lease.
 *  - `pr` mode emits an ordered plan and stays `awaiting-merge`; printing commands
 *    is never recorded as landing. `confirmTrain` observes each PR via `gh`.
 *  - `reconcileTrain` resolves `push-pending` from the REMOTE's truth.
 *  - Only the mutating verbs here write the derived `done` back into session
 *    files, as an idempotent cache under `fleet/.lock`; `status` never does.
 *
 * Plan: docs/plans/fleet-multi-session-coordination.md §2 (approval, confirm,
 * transition table, derived finalization), §2b, §7 (Phase 5).
 *
 * @module scripts/lib/fleet/train-approve
 */
import {
  headOf, isAncestor, remoteRefOid, resolveRemoteUrls, runGit,
} from './git-facts.mjs';
import { PR_VIEW_FIELDS, materializePrRef, repoFromPrUrl } from './gh-facts.mjs';
import { approvable, deriveDone } from './overlap.mjs';
import { describeVerdict, observeRequiredChecks, requiredInventory } from './required-checks.mjs';
import { fleetDir, listTrains, readSessions, readTrain, transact } from './registry.mjs';
import { buildStatusFrom, gatherFacts } from './facts.mjs';
import {
  branchOfRef, defaultDeps, patchTrain, removeTrainWorktree, withTrainLock,
} from './train.mjs';

/** Fields requested when re-checking a PR at approval (all real `gh pr view` fields — see the recorded fixture). */
export const PR_APPROVE_FIELDS = Object.freeze(['state', 'baseRefName', 'baseRefOid', 'headRefOid', 'url', 'isDraft']);

const refuse = (reason, extra = {}) => ({ ok: false, code: 'refused', reason, ...extra });
const short = (o) => String(o ?? '?').slice(0, 12);

/** Parse `gh pr view --json` stdout; `{ok:false, reason}` rather than a throw. */
function ghView(deps, cwd, src, fields) {
  const r = deps.gh(['pr', 'view', String(src.prNumber), '-R', src.repo, '--json', fields.join(',')], cwd);
  if (!r.ok) return { ok: false, reason: r.reason ?? 'gh failed' };
  try {
    const doc = JSON.parse(r.stdout);
    return doc && typeof doc === 'object' ? { ok: true, doc } : { ok: false, reason: 'gh returned a non-object' };
  } catch { return { ok: false, reason: 'gh returned unparseable JSON' }; }
}

/**
 * Structural candidate check — NOT reachability (squash and `--no-ff` commits are
 * created by the train and are reachable from no source head): the candidate
 * exists with the recorded tree, `baseOid` is its ancestor, the first-parent
 * chain `baseOid..candidate` has exactly `sources.length` commits, and in
 * `direct-merge` each commit's second parent equals the corresponding source oid.
 * @returns {string[]} problems (empty = sound)
 */
export function verifyCandidateStructure(cwd, train) {
  const problems = [];
  const cand = train.candidate;
  const h = headOf(cwd, cand.oid);
  if (!h.ok || h.oid !== cand.oid) return [`candidate ${short(cand.oid)} is not in this repository`];
  const tree = runGit(['rev-parse', `${cand.oid}^{tree}`], cwd);
  if (!tree.ok || tree.stdout.trim() !== cand.tree) problems.push('candidate tree does not match the recorded tree');
  const anc = isAncestor(cwd, train.baseOid, cand.oid);
  if (!anc.ok) problems.push(`cannot verify the base is an ancestor of the candidate: ${anc.reason}`);
  else if (!anc.value) problems.push('the base is not an ancestor of the candidate');
  const chain = runGit(['rev-list', '--first-parent', '--reverse', `${train.baseOid}..${cand.oid}`], cwd);
  if (!chain.ok) { problems.push(`cannot walk the candidate chain: ${chain.reason}`); return problems; }
  const commits = chain.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (commits.length !== train.sources.length) {
    problems.push(`the candidate chain has ${commits.length} commit(s) but the manifest lists ${train.sources.length} source(s)`);
    return problems;
  }
  if (train.mergeMethod === 'direct-merge') {
    commits.forEach((c, i) => {
      const p2 = runGit(['rev-parse', `${c}^2`], cwd);
      if (!p2.ok || p2.stdout.trim() !== train.sources[i].oid) problems.push(`commit ${i + 1} is not a merge of ${train.sources[i].id}'s recorded head`);
    });
  }
  return problems;
}

/**
 * Re-verify every recorded fact against the live world.
 * @returns {{ok: true} | {ok: false, reason: string, unreachable?: boolean}}
 */
export function verifyFacts({ cwd, train, dir, deps }) {
  const dest = train.destination;
  const urls = resolveRemoteUrls(cwd, dest.remote);
  if (!urls.ok) return { ok: false, reason: `cannot re-resolve remote ${dest.remote}: ${urls.reason}` };
  const urlProblems = [];
  if (urls.fetchUrl !== dest.fetchUrl) urlProblems.push(`fetch URL changed since the train was built (${dest.fetchUrl} -> ${urls.fetchUrl})`);
  if (urls.pushUrls.length !== 1) urlProblems.push(`remote now has ${urls.pushUrls.length} push URLs`);
  else if (urls.pushUrls[0] !== dest.pushUrl) urlProblems.push(`push URL changed since the train was built (${dest.pushUrl} -> ${urls.pushUrls[0]})`);
  if (urlProblems.length) return { ok: false, reason: `destination moved: ${urlProblems.join('; ')} — build a new train` };

  const rem = remoteRefOid(cwd, dest.fetchUrl, dest.ref);
  if (!rem.ok) return { ok: false, unreachable: true, reason: `remote unreachable (${rem.reason}) — refusing to proceed on stale local knowledge` };

  const problems = [];
  if (rem.oid !== dest.expectedOid) problems.push(`remote ${dest.ref} moved (expected ${short(dest.expectedOid)}, now ${short(rem.oid)})`);
  const base = headOf(cwd, dest.ref);
  if (!base.ok || base.oid !== train.baseOid) problems.push(`local base moved (recorded ${short(train.baseOid)}, now ${short(base.oid)})`);

  const sessions = readSessions(dir).sessions;
  for (const src of train.sources) {
    const s = sessions.find((x) => x.id === src.id && x.gen === src.gen);
    if (!s) { problems.push(`source ${src.id}: its session record (gen ${src.gen}) is gone or was re-registered`); continue; }
    if (src.kind === 'pr') {
      const m = materializePrRef(cwd, src.prNumber, src.oid, { remote: dest.remote });
      if (!m.ok) problems.push(`source ${src.id}: head moved or unfetchable (${m.reason})`);
      continue;
    }
    const branch = s.source?.branch;
    const cur = branch ? headOf(cwd, `refs/heads/${branch}`) : { ok: false };
    if (!cur.ok) problems.push(`source ${src.id}: branch ${branch ?? '(none)'} not found`);
    else if (cur.oid !== src.oid) problems.push(`source ${src.id}: head moved (recorded ${short(src.oid)}, now ${short(cur.oid)})`);
  }
  problems.push(...verifyCandidateStructure(cwd, train));
  return problems.length ? { ok: false, reason: `a recorded fact changed: ${problems.join('; ')} — build a new train` } : { ok: true, remoteOid: rem.oid };
}

/**
 * Each PR is re-checked at plan emission: open, not a draft, right base ref, head ==
 * recorded, `baseRefOid` == expected. An unverifiable base refuses. Then its
 * REQUIRED checks on that head (`required-checks.mjs`): `failed`/`not-run` refuse
 * (a skipped required check never ran); `missing`/`pending`/`unknown` let the plan
 * be printed but put a WAIT on that merge line — the commands are for a human, and a
 * just-pushed head registers its checks asynchronously.
 * @returns {{problems: string[], waits: Record<string, string>}}
 */
function verifyPrsForPlan({ cwd, train, deps, requiredChecks, requiredChecksError = null }) {
  const baseBranch = branchOfRef(train.destination.ref);
  const problems = []; const waits = {};
  const inventories = new Map();
  const inventoryFor = (repo) => {
    if (!inventories.has(repo)) inventories.set(repo, requiredInventory(cwd, { repo, base: baseBranch, configured: requiredChecks, configError: requiredChecksError, gh: deps.gh }));
    return inventories.get(repo);
  };
  for (const src of train.sources) {
    const v = ghView(deps, cwd, src, PR_APPROVE_FIELDS);
    if (!v.ok) { problems.push(`${src.id}: PR #${src.prNumber} cannot be verified (${v.reason})`); continue; }
    const d = v.doc;
    if (String(d.state).toUpperCase() !== 'OPEN') problems.push(`${src.id}: PR #${src.prNumber} is ${d.state}, not OPEN`);
    if (d.isDraft === true) problems.push(`${src.id}: PR #${src.prNumber} is a DRAFT — mark it ready, let its required checks run on the ready head, then approve (never ready + auto-merge on a draft)`);
    if (repoFromPrUrl(d.url) !== src.repo) problems.push(`${src.id}: PR #${src.prNumber} belongs to ${repoFromPrUrl(d.url) ?? '?'}, not ${src.repo}`);
    if (d.baseRefName !== baseBranch) problems.push(`${src.id}: PR #${src.prNumber} now targets ${d.baseRefName}, not ${baseBranch}`);
    if (d.headRefOid !== src.oid) problems.push(`${src.id}: PR #${src.prNumber} head moved (${short(src.oid)} -> ${short(d.headRefOid)})`);
    if (!d.baseRefOid) problems.push(`${src.id}: PR #${src.prNumber} base cannot be verified`);
    else if (d.baseRefOid !== train.destination.expectedOid) problems.push(`${src.id}: PR #${src.prNumber} baseRefOid ${short(d.baseRefOid)} != recorded base ${short(train.destination.expectedOid)}`);
    if (d.headRefOid !== src.oid || d.isDraft === true) continue;
    const rc = observeRequiredChecks(cwd, { pr: src.prNumber, repo: src.repo, inventory: inventoryFor(src.repo), expectHead: src.oid, gh: deps.gh });
    if (rc.verdict === 'failed' || rc.verdict === 'not-run') problems.push(`${src.id}: PR #${src.prNumber} required checks ${describeVerdict(rc)}`);
    else if (rc.verdict !== 'pass' && rc.verdict !== 'none-required') waits[src.id] = `required checks ${rc.verdict} (${describeVerdict(rc)}) — do not merge until they pass`;
  }
  return { problems, waits };
}

/**
 * The derived-`done` cache. Completion is derived OUTSIDE the lock from observed
 * facts, but what is WRITTEN is decided INSIDE `fleet/.lock` against the CURRENT
 * record: the session's (id, gen) must still be the one a landed train recorded
 * and its rev/ready.oid must still equal that manifest's (`deriveDone` re-run on
 * the freshly read record with the tip facts gathered before). A session that was
 * re-registered, touched or re-readied in between is NOT marked done.
 * Idempotent; only the mutating land verbs call it. Failure is reported, never
 * fatal - the train record is the truth and loses nothing.
 * `baseBranch` comes from the MANIFEST, so recovery needs no .fleet.json.
 */
export function writeDoneCache({ cwd, baseBranch, deps }) {
  try {
    const dir = fleetDir(cwd);
    const now = deps.now();
    const anyPr = readSessions(dir).sessions.some((x) => x.source?.kind === 'pr');
    const facts = gatherFacts({ cwd, config: { baseBranch }, now, prs: anyPr, patches: false, worktrees: false });
    const status = buildStatusFrom(facts);
    const branchNames = new Set((facts.branches.branches ?? []).map((x) => x.name));
    // Observed tip facts, per session id (what deriveDone needs besides the record itself).
    const observed = new Map();
    for (const it of status.items) {
      if (!it.tracked) continue;
      const tipObserved = Boolean(facts.branches.queried) && (it.kind !== 'pr' || Boolean(facts.prs.queried));
      observed.set(it.id, { observedOid: it.oid, tipObserved, branchGone: tipObserved && !(it.branch && branchNames.has(it.branch)) && !it.pr });
    }
    const candidates = status.items.filter((i) => i.tracked && i.state === 'done').map((i) => ({ id: i.id, gen: i.gen, rev: i.rev, readyOid: i.ready?.oid ?? null }));
    if (!candidates.length) return { written: [] };
    deps.hooks?.beforeDoneWrite?.();
    const landed = listTrains(dir).trains.filter((t) => t.phase === 'landed');
    const res = transact(dir, (ctx) => {
      const written = [];
      for (const c of candidates) {
        const cur = ctx.sessions.find((x) => x.id === c.id);
        if (!cur || cur.state === 'done' || cur.state === 'abandoned') continue;
        if (cur.gen !== c.gen || cur.rev !== c.rev || (cur.ready?.oid ?? null) !== c.readyOid) continue;
        const o = observed.get(c.id);
        if (!o || !deriveDone(cur, landed, o).done) continue;
        ctx.writeSession({ ...cur, rev: cur.rev + 1, state: 'done', updatedAt: now.toISOString() });
        written.push(c.id);
      }
      return written;
    });
    return res.ok ? { written: res.value } : { written: [], reason: res.reason };
  } catch (e) {
    return { written: [], reason: `done-cache write failed: ${e.message}` };
  }
}

const planFor = (train, waits = {}) => train.sources.map((s) => ({
  id: s.id, prNumber: s.prNumber,
  command: ['gh', 'pr', 'merge', String(s.prNumber), '-R', s.repo, '--squash', '--match-head-commit', s.oid],
  ...(waits[s.id] ? { wait: waits[s.id] } : {}),
}));

/**
 * `land --approve <trainId>`. See the file header. It takes NO config: approval
 * reads the manifest alone. `doneCache:false` skips the post-landing cache write
 * (status still derives done on read).
 *
 * @param {{cwd: string, trainId: string, acceptRerun?: boolean, doneCache?: boolean, deps?: ReturnType<typeof defaultDeps>}} args
 */
export function approveTrain({ cwd, trainId, acceptRerun = false, doneCache = true, cmd = 'fleet', deps = defaultDeps(), requiredChecks, requiredChecksError = null }) {
  const dir = fleetDir(cwd);
  return withTrainLock(dir, () => {
    const r = readTrain(dir, trainId);
    if (!r.ok) return refuse(`train ${trainId}: ${r.reason}`);
    const t = r.train;
    const elig = approvable(t, { acceptRerun });
    if (!elig.ok) return refuse(elig.reason, { needsAcceptRerun: elig.needsAcceptRerun === true });
    const ver = verifyFacts({ cwd, train: t, dir, deps });
    if (!ver.ok) return refuse(ver.reason, { unreachable: ver.unreachable === true });

    const deferred = t.deferredTiers ?? [];
    const common = { trainId, deferredTiers: deferred, ...(elig.note ? { note: elig.note } : {}) };

    if (t.mergeMethod === 'pr') {
      const { problems, waits } = verifyPrsForPlan({ cwd, train: t, deps, requiredChecks, requiredChecksError });
      if (problems.length) return refuse(`a PR changed or cannot be verified: ${problems.join('; ')}`);
      const train = patchTrain(dir, trainId, { phase: 'awaiting-merge' }, deps);
      return { ok: true, code: 'ok', ...common, train, mode: 'pr', plan: planFor(t, waits), landed: false, perMergeMainRuns: true };
    }

    // Direct modes: write the intent BEFORE the push, push to the RECORDED URL, lease on the recorded oid.
    const dest = t.destination;
    patchTrain(dir, trainId, {
      phase: 'push-pending',
      outcome: { intendedOid: t.candidate.oid, pushUrl: dest.pushUrl, ref: dest.ref, expectedOid: dest.expectedOid, at: deps.now().toISOString() },
    }, deps);
    deps.hooks?.afterPushPending?.();
    const argv = ['push', dest.pushUrl, `${t.candidate.oid}:${dest.ref}`, `--force-with-lease=${dest.ref}:${dest.expectedOid}`];
    const push = deps.git(argv, cwd, { timeoutMs: 120_000 });
    if (!push.ok) {
      return { ok: false, code: 'error', ...common, reason: `push failed (${push.reason}); the train stays push-pending — run \`land --reconcile ${trainId}\` to learn what the remote holds`, pushArgv: ['git', ...argv] };
    }
    const after = remoteRefOid(cwd, dest.fetchUrl, dest.ref);
    if (!after.ok || after.oid !== t.candidate.oid) {
      return { ok: false, code: 'error', ...common, reason: `push reported success but the remote shows ${after.ok ? short(after.oid) : `nothing readable (${after.reason})`}, not ${short(t.candidate.oid)}; the train stays push-pending — run \`land --reconcile ${trainId}\``, pushArgv: ['git', ...argv] };
    }
    const landed = patchTrain(dir, trainId, {
      phase: 'landed',
      outcome: { intendedOid: t.candidate.oid, resultOid: t.candidate.oid, pushUrl: dest.pushUrl, ref: dest.ref, landedAt: deps.now().toISOString() },
    }, deps);
    return finishLanded({ cwd, doneCache, deps, train: landed, extra: { ...common, mode: t.mergeMethod, pushArgv: ['git', ...argv], landed: true } });
  });
}

/** After `landed`: remove the worktree (only now) and write the derived-done cache. */
function finishLanded({ cwd, doneCache = true, deps, train, extra }) {
  const rm = removeTrainWorktree(cwd, train, deps);
  const cache = doneCache ? writeDoneCache({ cwd, baseBranch: branchOfRef(train.destination.ref), deps }) : { written: [], reason: 'cache write skipped' };
  return { ok: true, code: 'ok', ...extra, train, worktreeRemoved: rm.removed, ...(rm.reason ? { worktreeNote: rm.reason } : {}), doneCache: cache };
}

/** Observe ONE PR: merged only if state, repo, base ref and head all match the manifest. */
export function verifyMergedPr({ cwd, train, src, deps }) {
  const v = ghView(deps, cwd, src, PR_VIEW_FIELDS);
  const base = { id: src.id, prNumber: src.prNumber };
  if (!v.ok) return { ...base, status: 'unverifiable', reason: v.reason };
  const d = v.doc;
  const state = String(d.state).toUpperCase();
  if (state !== 'MERGED') return { ...base, status: state === 'CLOSED' ? 'closed-unmerged' : 'open', reason: `PR is ${state}` };
  const mismatches = [];
  if (repoFromPrUrl(d.url) !== src.repo) mismatches.push(`merged in ${repoFromPrUrl(d.url) ?? '?'}, not ${src.repo}`);
  if (d.baseRefName !== branchOfRef(train.destination.ref)) mismatches.push(`merged into ${d.baseRefName}, not ${branchOfRef(train.destination.ref)}`);
  if (d.headRefOid !== src.oid) mismatches.push(`merged with head ${short(d.headRefOid)}, not the tested ${short(src.oid)}`);
  if (mismatches.length) return { ...base, status: 'merged-unexpected', reason: mismatches.join('; ') };
  return { ...base, status: 'merged', mergeCommit: d.mergeCommit?.oid ?? null };
}

/**
 * `land --confirm <trainId>` (pr mode): observe every PR; the train becomes
 * `landed` only when ALL verify. A partial or unexpected merge leaves it
 * `awaiting-merge`, recorded and reported — never silently landed.
 */
export function confirmTrain({ cwd, trainId, deps = defaultDeps() }) {
  const dir = fleetDir(cwd);
  return withTrainLock(dir, () => {
    const r = readTrain(dir, trainId);
    if (!r.ok) return refuse(`train ${trainId}: ${r.reason}`);
    const t = r.train;
    if (t.phase !== 'awaiting-merge') {
      return refuse(t.phase === 'landed' ? 'train already landed' : `train is ${t.phase} — --confirm applies only to a pr-mode train that is awaiting-merge`);
    }
    const confirmations = t.sources.map((src) => verifyMergedPr({ cwd, train: t, src, deps }));
    const outcome = { confirmations, checkedAt: deps.now().toISOString() };
    const merged = confirmations.filter((c) => c.status === 'merged').length;
    if (merged !== confirmations.length) {
      const train = patchTrain(dir, trainId, { outcome }, deps);
      const unexpected = confirmations.filter((c) => c.status === 'merged-unexpected');
      return { ok: false, code: 'pending', trainId, train, confirmations, landed: false,
        reason: `${merged} of ${confirmations.length} PR(s) verified merged; the train stays awaiting-merge${unexpected.length ? ` — MERGED UNEXPECTEDLY: ${unexpected.map((c) => `${c.id} (${c.reason})`).join('; ')}` : ''}` };
    }
    const landed = patchTrain(dir, trainId, { phase: 'landed', outcome }, deps);
    return finishLanded({ cwd, deps, train: landed, extra: { trainId, confirmations, landed: true } });
  });
}

/**
 * `land --reconcile <trainId>` (direct modes): resolve `push-pending` from the
 * REMOTE's truth. remote == candidate → landed; remote == expectedOid → back to
 * `approved` (marked `reconciledFrom:'push-pending'` so `approvable` admits it
 * again); anything else → `diverged`, naming both oids. `diverged` is re-runnable.
 */
export function reconcileTrain({ cwd, trainId, deps = defaultDeps() }) {
  const dir = fleetDir(cwd);
  return withTrainLock(dir, () => {
    const r = readTrain(dir, trainId);
    if (!r.ok) return refuse(`train ${trainId}: ${r.reason}`);
    const t = r.train;
    if (t.phase !== 'push-pending' && t.phase !== 'diverged') return refuse(`nothing to reconcile: train is ${t.phase} (only push-pending or diverged trains are reconciled)`);
    const dest = t.destination;
    const rem = remoteRefOid(cwd, dest.fetchUrl, dest.ref);
    if (!rem.ok) return refuse(`cannot read the remote to reconcile (${rem.reason}) — try again when it is reachable`);
    const stamp = deps.now().toISOString();
    if (rem.oid === t.candidate.oid) {
      const landed = patchTrain(dir, trainId, { phase: 'landed', reconciledFrom: t.phase, outcome: { ...(t.outcome ?? {}), resultOid: rem.oid, reconciledAt: stamp } }, deps);
      return finishLanded({ cwd, deps, train: landed, extra: { trainId, reconciled: 'landed', remoteOid: rem.oid, landed: true } });
    }
    if (rem.oid === dest.expectedOid) {
      const back = patchTrain(dir, trainId, { phase: 'approved', reconciledFrom: 'push-pending', outcome: { ...(t.outcome ?? {}), reconciledAt: stamp, remoteOid: rem.oid } }, deps);
      return { ok: true, code: 'ok', trainId, train: back, reconciled: 'approved', remoteOid: rem.oid, landed: false };
    }
    const div = patchTrain(dir, trainId, {
      phase: 'diverged', outcome: { ...(t.outcome ?? {}), reconciledAt: stamp, remoteOid: rem.oid, candidateOid: t.candidate.oid, expectedOid: dest.expectedOid },
    }, deps);
    return { ok: false, code: 'refused', trainId, train: div, reconciled: 'diverged', remoteOid: rem.oid, landed: false,
      reason: `the remote holds ${short(rem.oid)}, which is neither the candidate (${short(t.candidate.oid)}) nor the expected base (${short(dest.expectedOid)}) — diverged; needs a human` };
  });
}

