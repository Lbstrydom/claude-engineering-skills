/**
 * @fileoverview Gather everything `overlap.mjs:buildStatus` joins — git, gh, the
 * registry and the extension hook — into ONE facts object, outside any lock.
 *
 * Each block keeps its own provenance (`queried`, `reason`): an unasked question
 * is never rendered as an empty answer. Nothing here writes (the hook script is
 * consumer code and may do what it likes, but fleet itself writes nothing).
 *
 * `FLEET_NOW` — a hidden, documented test hook — is read in exactly ONE place
 * (`resolveNow`) and the resulting instant is passed down; no other module reads
 * a wall clock for a decision.
 *
 * @module scripts/lib/fleet/facts
 */
import {
  listWorktrees, listBranches, changedFiles, patchId, baseFreshness, headOf, runGit, resolveMeasurementBase,
} from './git-facts.mjs';
import { listPullRequests, prLocalRef } from './gh-facts.mjs';
import { ConfigError } from './config.mjs';
import { fleetDir, readSessions, readHold, listTrains } from './registry.mjs';
import {
  DEFAULT_LEASE_MS, buildStatus, checkBlocksApproval, idleMsFrom, isIdleTip, liveness,
} from './overlap.mjs';
import { buildCheckPayload, resultsToFindings, runChecks } from './checks.mjs';
import { CLEAN_PROBE, probeWorktrees, uncommittedPaths, worktreeStatus } from './worktree-status.mjs';
import { SQUASH_DEPTH, gitAdapters, listMergedPullRequests, mergedEvidenceFor, squashPatchIds } from './merged-facts.mjs';

/**
 * The one clock read. `FLEET_NOW` (ISO string or epoch ms) overrides it so a
 * test can be deterministic; unset means the real clock.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Date}
 */
export function resolveNow(env = process.env) {
  const raw = env.FLEET_NOW;
  if (raw !== undefined && raw !== '') {
    const d = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
    if (Number.isFinite(d.getTime())) return d;
    throw new Error(`FLEET_NOW is not a valid instant: ${JSON.stringify(raw)}`);
  }
  return new Date();
}

const MAX_LEASE_HOURS = 24 * 30;
const MIN_LEASE_MS = 60_000; // a lease under a minute is a typo; liveness would read it as already expired

/**
 * Lease length in ms from `FLEET_LEASE_HOURS` (default 4h when UNSET). An explicit
 * value must be a plain positive decimal no larger than 30 days; anything else
 * ('24hours', '0', '-1', 'NaN', '') is a CONFIG ERROR, never a silent default.
 * @throws {ConfigError}
 */
export function leaseMsFrom(env = process.env) {
  const raw = env.FLEET_LEASE_HOURS;
  if (raw === undefined) return DEFAULT_LEASE_MS;
  const h = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(h) || h <= 0 || h > MAX_LEASE_HOURS) {
    throw new ConfigError([`FLEET_LEASE_HOURS=${JSON.stringify(raw)} is invalid: expected a positive number of hours, at most ${MAX_LEASE_HOURS} (e.g. 4 or 0.5)`]);
  }
  const ms = Math.round(h * 3_600_000);
  if (ms < MIN_LEASE_MS) {
    throw new ConfigError([`FLEET_LEASE_HOURS=${JSON.stringify(raw)} is too short: the lease must be at least 1 minute (${MIN_LEASE_MS}ms), got ${ms}ms`]);
  }
  return ms;
}

/**
 * The remote-tracking ref the base is compared against. Order: the destination
 * remote recorded by an open train, then the base branch's configured upstream
 * (`@{upstream}`), then `origin`.
 * @returns {{upstream: string, source: 'train'|'upstream'|'origin'}}
 */
export function resolveUpstream(cwd, base, trains = []) {
  const open = trains
    .filter((t) => !['landed', 'abandoned'].includes(t.phase) && String(t.destination?.ref).replace(/^refs\/heads\//, '') === base)
    .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))[0];
  if (open) return { upstream: `${open.destination.remote}/${base}`, source: 'train' };
  const r = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${base}@{upstream}`], cwd);
  if (r.ok && r.stdout.trim()) return { upstream: r.stdout.trim(), source: 'upstream' };
  return { upstream: `origin/${base}`, source: 'origin' };
}

/**
 * @param {object} args
 * @param {string} args.cwd
 * @param {{baseBranch: string, checks?: object[]}} args.config
 * @param {Date} args.now
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {boolean} [args.prs=true]     query `gh`
 * @param {boolean} [args.patches=true] per-branch patch-ids
 * @param {boolean} [args.worktrees=true]
 * @param {boolean} [args.checks=true]  `false` records `facts.checks = {queried:false}`, which makes
 *   `statusChecks({..., facts})` skip the consumer-owned extension hook. `gatherFacts` never runs the hook
 *   itself (`statusChecks` does); the option exists so a read-only caller (the dashboard build) can say, in
 *   the facts it hands on, that consumer code must not run. Omitted ⇒ `facts` is unchanged.
 * @param {number} [args.maxBranches]  upper bound on branches analysed (one `changedFiles` + one
 *   `patchId` git call each). The overflow is LISTED in `facts.branchesNotAnalysed`, never silently
 *   skipped. Omitted ⇒ unbounded and `facts` is unchanged.
 * @param {boolean} [args.untracked=true] analyse UNTRACKED branches too. A verb that only ever compares
 *   against registered sessions (claim, add, ready, start — `othersFor` reads sessions only) passes
 *   `false`: each skipped branch is recorded in `changed` as `{queried:false, reason}`, never as an
 *   empty change set, and costs no git call.
 * @returns {object} facts for `buildStatus`, plus `dir`
 */
export function gatherFacts({ cwd, config, now, env = process.env, prs = true, patches = true, worktrees = true, cmd = 'fleet', checks = true, maxBranches, untracked = true, merged, uncommitted }) {
  const dir = fleetDir(cwd);
  const base = config.baseBranch;
  const registry = readSessions(dir);
  const trainsRead = listTrains(dir);
  const up = resolveUpstream(cwd, base, trainsRead.trains);
  // Every ahead/behind count and changed-file set is measured from the FRESHER of the local base and its
  // upstream (see resolveMeasurementBase): a local base that trails would make each branch cut from the
  // upstream look like it changed everything the upstream gained since.
  const measure = resolveMeasurementBase(cwd, { base, upstream: up.upstream });
  const branches = listBranches(cwd, measure.ok ? measure.oid : base);
  const anyPr = registry.sessions.some((x) => x.source?.kind === 'pr' && !['done', 'abandoned'].includes(x.state));
  const prFacts = prs || anyPr ? listPullRequests(cwd, { env }) : { queried: false, complete: false, reason: 'not requested', prs: [] };
  const sel = selectBranchesToAnalyse({ registry, branches, base, maxBranches, untracked });
  // Evidence is computed from the commit ids `listBranches` captured, not by re-resolving the NAMES: another
  // session can commit between the two reads, and the PR-trust comparison below uses the captured tip, so
  // evidence for a newer tip would be attributed to the older one. A name with no captured oid (a registered
  // branch that is not local) falls back to the name, which simply fails to resolve and says so.
  const tipOid = new Map((branches.branches ?? []).map((b) => [b.name, b.oid]));
  const baseOidSnap = measure.ok ? measure.oid : tipOid.get(base) ?? null;
  const baseRev = baseOidSnap ?? base;
  const { changed, patchIds } = branchEvidence({ cwd, analyse: sel.analyse, tipOid, baseRev, patches });
  for (const n of sel.skippedUntracked) changed[n] = { queried: false, files: [], reason: 'not requested: untracked branches are not analysed by this command' };
  // The budget covers EVERY per-ref analysis: the branches above AND the materialised PR refs below.
  const budget = Number.isInteger(maxBranches) && maxBranches >= 0 ? maxBranches - sel.analyse.size : Infinity;
  const pr = prSessionEvidence({ cwd, registry, prFacts, names: sel.names, branches, baseRev, budget, cmd });
  Object.assign(changed, pr.changed);
  const branchesNotAnalysed = mergeNotAnalysed(sel.branchesNotAnalysed, pr.notAnalysed);
  const worktreeList = worktrees ? listWorktrees(cwd) : { queried: false, reason: 'not requested', worktrees: [] };
  // Merged evidence (squash merges never make a tip an ancestor of base). The default follows `untracked`:
  // the full view judges every candidate branch; session-only verbs name the branches they need.
  const mergedWanted = merged === undefined ? (untracked ? 'all' : false) : merged;
  const mergedFacts = mergedWanted === false
    ? { prs: { queried: false, reason: 'not requested' }, squash: { queried: false, reason: 'not requested' }, evidence: {} }
    : gatherMerged({ cwd, base, baseRev, names: mergedWanted === 'all' ? [...sel.names] : mergedWanted, branches, patchIds, env });
  const tracked = new Set(registry.sessions.map((s) => s.source?.branch).filter(Boolean));
  const landed = new Set(Object.entries(mergedFacts.evidence).filter(([n, e]) => e.merged === true && !tracked.has(n)).map(([n]) => n));
  // Uncommitted evidence: every non-terminal session's worktree (`'all'`), the named branches, or none.
  const uncommittedWanted = uncommitted === undefined ? (untracked ? 'all' : false) : uncommitted;
  const uncommittedFacts = uncommittedWanted === false ? {}
    : probeSessionWorktrees({ registry, worktreeList, branches: uncommittedWanted === 'all' ? null : uncommittedWanted });
  return {
    worktreeClean: probeWorktreeCleanliness({ branches, worktreeList, base, registry, now, idleMs: idleMsFrom(config), landed }),
    merged: mergedFacts, uncommitted: uncommittedFacts,
    hotFiles: config.hotFiles ?? [],
    findings: pr.findings, evidenceNotes: pr.evidenceNotes, prTrusted: pr.prTrusted, dir, now, leaseMs: leaseMsFrom(env), baseOid: baseOidSnap ?? (() => { const h = headOf(cwd, `refs/heads/${base}`); return h.ok ? h.oid : null; })(),
    base: { name: base, upstream: up.upstream, freshness: baseFreshness(cwd, { base, upstream: up.upstream }), measure },
    registry, hold: readHold(dir), trains: trainsRead.trains, trainsInvalid: trainsRead.invalid,
    worktrees: worktreeList,
    branches, prs: prFacts, changed, patchIds,
    ...(branchesNotAnalysed ? { branchesNotAnalysed } : {}),
    ...(checks === false ? { checks: { queried: false, reason: 'not requested' } } : {}),
  };
}

/**
 * Which branches get per-branch evidence (`changedFiles`, `patchId`). Candidates (`names`): every
 * registered `branch` session's branch, plus every branch ahead of base — but with `untracked:false`
 * only those some registered session (of ANY kind) points at, so a PR session's local branch is still
 * a candidate. Over `maxBranches`: registered sessions first (they are the ones someone is waiting on),
 * then the most recently touched; the overflow is LISTED, never silently dropped.
 * @returns {{names: Set<string>, analyse: Set<string>, branchesNotAnalysed: {count: number, names: string[]}|null, skippedUntracked: string[]}}
 */
export function selectBranchesToAnalyse({ registry, branches, base, maxBranches, untracked = true }) {
  const names = new Set();
  const sessionBranches = new Set(registry.sessions.map((x) => x.source?.branch).filter(Boolean));
  const skippedUntracked = [];
  for (const s of registry.sessions) if (s.source?.branch && s.source.kind === 'branch') names.add(s.source.branch);
  for (const b of branches.branches ?? []) {
    if (b.name === base || !(b.ahead > 0)) continue;
    if (untracked || sessionBranches.has(b.name)) names.add(b.name);
    else skippedUntracked.push(b.name);
  }
  const analyse = new Set(names);
  let branchesNotAnalysed = null;
  if (Number.isInteger(maxBranches) && maxBranches >= 0 && names.size > maxBranches) {
    const sessionNames = new Set([...sessionBranches].filter((n) => names.has(n)));
    const tip = new Map((branches.branches ?? []).map((b) => [b.name, b.tipTime ?? 0]));
    const rest = [...names].filter((n) => !sessionNames.has(n)).sort((a, b) => (tip.get(b) - tip.get(a)) || (a < b ? -1 : 1));
    const ordered = [...sessionNames, ...rest];
    branchesNotAnalysed = { count: ordered.length - maxBranches, names: ordered.slice(maxBranches) };
    for (const n of branchesNotAnalysed.names) analyse.delete(n);
  }
  return { names, analyse, branchesNotAnalysed, skippedUntracked };
}

/** One `changedFiles` (and, with `patches`, one `patchId`) per analysed branch, at its captured tip. */
function branchEvidence({ cwd, analyse, tipOid, baseRev, patches }) {
  const changed = {}; const patchIds = {};
  for (const n of analyse) {
    const rev = tipOid.get(n) ?? n;
    changed[n] = changedFiles(cwd, baseRev, rev);
    if (patches) patchIds[n] = patchId(cwd, baseRev, rev);
  }
  return { changed, patchIds };
}

const mergeNotAnalysed = (a, b) => (!a && !b ? null
  : { count: (a?.count ?? 0) + (b?.count ?? 0), names: [...(a?.names ?? []), ...(b?.names ?? [])] });

/**
 * PR-backed sessions: their evidence is only trusted while it IS the PR's current head. A session whose
 * evidence cannot be established gets a per-SESSION note + warning; the shared per-branch evidence in
 * `changed` is never overwritten (another consumer of that branch legitimately depends on it), so this
 * returns only the `pr:<n>` keys it adds.
 * @returns {{changed: object, findings: object[], evidenceNotes: object, prTrusted: Set<string>, notAnalysed: {count: number, names: string[]}|null}}
 */
function prSessionEvidence({ cwd, registry, prFacts, names, branches, baseRev, budget, cmd }) {
  const changed = {}; const findings = []; const evidenceNotes = {}; const prTrusted = new Set();
  let notAnalysed = null;
  let left = budget;
  const noFiles = (s, reason) => { evidenceNotes[s.id] = { queried: false, reason }; findings.push({ level: 'warn', sessions: [s.id], message: `changed files not queried (${reason}) - overlap by files is unknown for ${s.id}` }); };
  for (const s of registry.sessions) {
    if (!needsEvidenceKey(s)) continue;
    const branch = s.source.branch;
    const pr = prFacts.queried ? prFacts.prs.find((x) => x.number === s.source.prNumber) : null;
    if (branch && names.has(branch)) {
      const tip = (branches.branches ?? []).find((x) => x.name === branch)?.oid;
      if (!prFacts.queried) noFiles(s, `the PR head cannot be verified: PRs not queried (${prFacts.reason})`);
      else if (!pr?.headOid) noFiles(s, `PR #${s.source.prNumber} is not in the open PR list; its head cannot be verified`);
      else if (tip !== pr.headOid) noFiles(s, `local branch tip ${String(tip).slice(0, 12)} != PR head ${pr.headOid.slice(0, 12)}`);
      else prTrusted.add(s.id); // tip == PR head: the branch's evidence IS this PR's evidence
      continue;
    }
    const ref = prLocalRef(s.source.prNumber);
    const have = headOf(cwd, ref);
    if (!have.ok) { noFiles(s, `PR #${s.source.prNumber} is not materialised locally; run ${cmd} ready to fetch it`); continue; }
    if (!prFacts.queried) { noFiles(s, `the PR head cannot be verified: PRs not queried (${prFacts.reason})`); continue; }
    if (!pr?.headOid) { noFiles(s, `PR #${s.source.prNumber} is not in the open PR list; its head cannot be verified`); continue; }
    if (pr.headOid !== have.oid) { noFiles(s, `materialised ref is stale (${have.oid.slice(0, 12)} != ${pr.headOid.slice(0, 12)}); run ${cmd} ready to refetch`); continue; }
    if (left <= 0) {
      notAnalysed = mergeNotAnalysed(notAnalysed, { count: 1, names: [prKey(s)] });
      noFiles(s, 'not analysed: the maxBranches budget is spent');
      continue;
    }
    left -= 1;
    const files = changedFiles(cwd, baseRev, have.oid); // the oid just verified against the PR head, not the ref name
    if (!files.queried) { noFiles(s, files.reason); continue; }
    changed[prKey(s)] = files;
  }
  return { changed, findings, evidenceNotes, prTrusted, notAnalysed };
}

export { CLEAN_PROBE };

/**
 * For each UNTRACKED branch the default view could hide (ahead 0, a known ahead
 * count with a tip older than `idleMs`, or committed work already landed — `landed`)
 * that has a worktree, is that worktree clean?
 * `{[path]: true|false|null}`; `null` = could not be established (probe failed,
 * timed out, over the cap, or past the aggregate deadline) and keeps the item
 * visible. Sequential probes (`probeWorktrees`), the deadline checked before each,
 * so the worst case is deadline + one timeout — never N x timeout.
 * @param {{branches: object, worktreeList: object, registry: object, base: string, now?: Date|number|null,
 *   idleMs?: number, landed?: Set<string>, clock?: () => number}} a - without `now`/`idleMs` only ahead-0 branches are candidates
 */
export function probeWorktreeCleanliness({ branches, worktreeList, registry, base, now = null, idleMs = 0, landed = new Set(), clock = Date.now, probe = (p) => runGit(['status', '--porcelain', '--untracked-files=normal'], p, { timeoutMs: CLEAN_PROBE.timeoutMs }) }) {
  if (!branches?.queried || !worktreeList?.queried) return {};
  const tracked = new Set((registry?.sessions ?? []).map((s) => s.source?.branch).filter(Boolean));
  const candidates = [];
  for (const b of branches.branches ?? []) {
    const hideable = b.ahead === 0 || (Number.isInteger(b.ahead) && isIdleTip(b.tipTime, now, idleMs)) || landed.has(b.name);
    if (b.name === base || tracked.has(b.name) || !hideable) continue;
    const wt = (worktreeList.worktrees ?? []).find((w) => w.branch === b.name && !w.bare);
    if (wt) candidates.push(wt.path);
  }
  const probed = probeWorktrees(candidates, { clock, probe: (p) => ({ queried: true, ...probe(p) }) });
  return Object.fromEntries(Object.entries(probed).map(([p, r]) => [p, r.queried && r.ok ? r.stdout.trim() === '' : null]));
}

/**
 * Uncommitted evidence for registered sessions' worktrees: the paths each holds
 * that are not committed (staged, unstaged, untracked — ignored excluded). Keyed
 * by BRANCH, like `changed`. Bounded by `CLEAN_PROBE`; a worktree over budget or
 * whose probe failed is `{queried:false, reason}`, never `[]`.
 * @param {{registry: object, worktreeList: object, branches?: string[]|null, now?: Date, clock?: () => number,
 *   probe?: (dir: string) => object}} a - `branches` limits the set (null = every non-terminal session)
 * @returns {Record<string, {queried: boolean, files: string[], worktree: string, reason?: string}>}
 */
export function probeSessionWorktrees({ registry, worktreeList, branches = null, clock = Date.now, probe = (d) => worktreeStatus(d) }) {
  if (!worktreeList?.queried) return {};
  const want = branches ? new Set(branches) : null;
  const byBranch = new Map();
  for (const s of registry?.sessions ?? []) {
    const b = s.source?.branch;
    if (!b || (want && !want.has(b))) continue;
    // Non-terminal only: a session with merged evidence is still non-terminal until its worktree is read.
    if (TERMINAL.has(s.state)) continue;
    const wt = (worktreeList.worktrees ?? []).find((w) => !w.bare && (w.branch === b || (s.worktree && samePathLoose(w.path, s.worktree))));
    if (wt) byBranch.set(b, wt.path);
  }
  const probed = probeWorktrees([...byBranch.values()], { clock, probe });
  const out = {};
  for (const [b, p] of byBranch) {
    const r = probed[p];
    out[b] = r?.queried ? { queried: true, files: uncommittedPaths(r.entries), worktree: p } : { queried: false, files: [], worktree: p, reason: r?.reason ?? 'not probed' };
  }
  return out;
}

const TERMINAL = new Set(['done', 'abandoned']);
const samePathLoose = (a, b) => String(a).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === String(b).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Merged evidence for `names` (the branches to judge): one `gh pr list --state
 * merged`, one squash patch-id window over base, then `mergedEvidenceFor` per
 * branch at its CAPTURED tip. Each source keeps its own provenance.
 */
export function gatherMerged({ cwd, base, baseRev, names, branches, patchIds, env }) {
  const prs = listMergedPullRequests(cwd, { base, env });
  const squash = squashPatchIds(cwd, baseRev);
  const tipOid = new Map((branches?.branches ?? []).map((b) => [b.name, b.oid]));
  const adapters = gitAdapters(cwd);
  const evidence = {};
  for (const n of names) {
    const tip = tipOid.get(n) ?? null;
    let pid = patchIds?.[n]?.queried ? patchIds[n].patchId : null;
    if (!pid && tip && squash.queried && squash.byPatchId.size) {
      const p = patchId(cwd, baseRev, tip);
      pid = p.queried ? p.patchId : null;
    }
    // A squash window shorter than base's history still COVERS this branch when its fork point is inside it.
    let covers = squash.complete;
    if (squash.queried && !squash.complete && tip) {
      const mb = runGit(['merge-base', baseRev, tip], cwd);
      const n2 = mb.ok ? runGit(['rev-list', '--count', '--first-parent', `${mb.stdout.trim()}..${baseRev}`], cwd) : null;
      covers = Boolean(n2?.ok) && Number.parseInt(n2.stdout.trim(), 10) <= SQUASH_DEPTH;
    }
    evidence[n] = mergedEvidenceFor({ branch: n, tipOid: tip, patchId: pid, mergedPrs: prs, squash: { ...squash, coversFork: covers }, ...adapters });
  }
  return { prs: { queried: prs.queried, complete: prs.complete, reason: prs.reason, count: prs.prs?.length ?? 0 }, squash: { queried: squash.queried, complete: squash.complete, reason: squash.reason }, evidence };
}

/** The hook's session/overlap payload, derived from a joined status. */
export function payloadFromStatus(status) {
  const sessions = status.items.filter((i) => i.tracked).map((i) => ({
    id: i.id, branch: i.branch, oid: i.oid, paths: i.paths, changedFiles: i.changedFiles ?? [], state: i.state,
    waitingOn: i.waitingOn.map(({ kind, ref, note, since }) => ({ kind, ref, note, since })),
  }));
  const overlaps = [];
  for (const i of status.items) for (const o of i.overlaps) if (i.id < o.with) overlaps.push({ a: i.id, b: o.with, via: o.via, files: o.files, known: o.known });
  // Hot-files-only evidence is NOT in `overlaps` (it is not a conflict) but stays visible to the hook.
  const hotOverlaps = [];
  for (const i of status.items) for (const o of i.hotOverlaps ?? []) if (i.id < o.with) hotOverlaps.push({ a: i.id, b: o.with, files: o.files });
  return { sessions, overlaps, hotOverlaps };
}

/**
 * Run the status-phase hook over the joined status; returns results + advisory findings.
 * Pass the `facts` it was built from: facts gathered with `checks:false` skip the hook.
 */
export function statusChecks({ cwd, config, status, facts }) {
  if (facts?.checks?.queried === false) return { results: [], findings: [] };
  const checks = (config.checks ?? []).filter((c) => (c.runIn ?? ['status', 'land']).includes('status'));
  if (!checks.length) return { results: [], findings: [] };
  const payload = buildCheckPayload({ phase: 'status', baseOid: status.baseOid ?? null, ...payloadFromStatus(status) });
  const results = runChecks({ cwd, checks, phase: 'status', payload });
  return { results, findings: resultsToFindings(results) };
}

/**
 * The ready-phase hook: runs every check whose `runIn` includes `ready` over the ONE
 * session being marked, at the oid `ready` is about to record. A `severity:'block'`
 * check that reports a block-level finding, or that fails or times out, refuses the
 * mark - `checkBlocksApproval`, the predicate that makes a train non-approvable, so
 * the two cannot disagree. Everything else is disclosed and does not refuse.
 * @param {{cwd: string, config: {checks?: object[]}, session: object, oid: string, baseOid: string|null}} a
 * @returns {{results: object[], findings: object[], blocks: string|null}}
 */
export function readyChecks({ cwd, config, session, oid, baseOid, exec }) {
  const checks = (config.checks ?? []).filter((c) => (c.runIn ?? ['status', 'land']).includes('ready'));
  if (!checks.length) return { results: [], findings: [], blocks: null };
  // Measured like status measures it; an unmeasured diff is sent as `changedFiles: []` plus the reason.
  const diff = baseOid ? changedFiles(cwd, baseOid, oid) : { queried: false, files: [], reason: 'base not measured' };
  const changed = diff.queried ? diff.files : [];
  const payload = buildCheckPayload({
    phase: 'ready', baseOid,
    sessions: [{ id: session.id, branch: session.source?.branch ?? null, oid, paths: session.paths ?? [], changedFiles: changed, state: 'ready',
      ...(diff.queried ? {} : { changedFilesUnknown: diff.reason }),
      waitingOn: (session.waitingOn ?? []).map(({ kind, ref, note, since }) => ({ kind, ref, note, since })) }],
  });
  const results = runChecks({ cwd, checks, phase: 'ready', payload, ...(exec ? { exec } : {}) });
  return { results, findings: resultsToFindings(results), blocks: checkBlocksApproval(results) };
}

/** Build status and attach `changedFiles` to each item (the hook's payload needs them). */
export function buildStatusFrom(facts) {
  // buildStatus joins overlaps over every item that has a branch (registered sessions AND untracked
  // local branches) - ONE join, ONE predicate. A PR session whose evidence is not the branch's (branchless,
  // or not verified as the PR head) is given its own key `pr:<n>` as a stand-in branch so that same join
  // includes it without borrowing the shared per-branch evidence; the stand-in is removed from the output.
  const real = new Map();
  const sessions = (facts.registry?.sessions ?? []).map((x) => {
    if (usesOwnKey(x, facts)) { real.set(x.id, x.source.branch ?? null); return { ...x, source: { ...x.source, branch: prKey(x) } }; }
    return x;
  });
  const status = buildStatus({ ...facts, registry: { ...facts.registry, sessions } });
  status.baseOid = facts.baseOid ?? null;
  for (const i of status.items) {
    i.changedFiles = i.branch && facts.changed?.[i.branch]?.queried ? facts.changed[i.branch].files : [];
    if (real.has(i.id)) i.branch = real.get(i.id);
  }
  return status;
}

/**
 * THE predicate: which sessions have PR-derived evidence that must be established (against the PR's
 * current head) before it is used. Used by BOTH `gatherFacts` and `buildStatusFrom`.
 * @param {{state: string, source?: {kind?: string, prNumber?: number|null}}} session
 */
export function needsEvidenceKey(session) {
  return session.source?.kind === 'pr' && Boolean(session.source.prNumber) && !['done', 'abandoned'].includes(session.state);
}

/** The key a PR session's OWN evidence is stored under. */
export const prKey = (session) => `pr:${session.source.prNumber}`;

/** Does this session read its own `pr:<n>` evidence (true) or the shared branch evidence (false)? */
function usesOwnKey(session, facts) {
  return needsEvidenceKey(session) && !facts.prTrusted?.has(session.id);
}

/** Key a session's changed-files evidence is read from. */
export function evidenceKey(session, facts) {
  if (usesOwnKey(session, facts)) return prKey(session);
  return session.source?.branch ?? null;
}

/**
 * The `others` argument of `decideClaim`: each non-self session with its
 * liveness (lease OR observed branch activity) and observed changed files.
 */
export function othersFor(facts, selfId, now, sessions = facts.registry.sessions) {
  const tipOf = new Map((facts.branches?.branches ?? []).map((b) => [b.name, b.tipTime]));
  return sessions.filter((s) => s.id !== selfId).map((s) => {
    const b = s.source?.branch;
    const k = evidenceKey(s, facts);
    const live = liveness(s, { now, leaseMs: facts.leaseMs, tipCommitAt: b ? tipOf.get(b) ?? null : null }).live;
    const u = b ? facts.uncommitted?.[b] : undefined;
    return {
      session: s, live, changedFiles: k && facts.changed?.[k]?.queried ? facts.changed[k].files : [],
      uncommittedFiles: u?.queried ? u.files : [], ...(u && !u.queried ? { uncommittedUnknown: u.reason } : {}),
    };
  });
}
