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
  listWorktrees, listBranches, changedFiles, patchId, baseFreshness, headOf, runGit,
} from './git-facts.mjs';
import { listPullRequests, prLocalRef } from './gh-facts.mjs';
import { ConfigError } from './config.mjs';
import { fleetDir, readSessions, readHold, listTrains } from './registry.mjs';
import { DEFAULT_LEASE_MS, buildStatus, liveness } from './overlap.mjs';
import { buildCheckPayload, resultsToFindings, runChecks } from './checks.mjs';

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
 * @returns {object} facts for `buildStatus`, plus `dir`
 */
export function gatherFacts({ cwd, config, now, env = process.env, prs = true, patches = true, worktrees = true, cmd = 'fleet', checks = true, maxBranches }) {
  const dir = fleetDir(cwd);
  const base = config.baseBranch;
  const registry = readSessions(dir);
  const trainsRead = listTrains(dir);
  const branches = listBranches(cwd, base);
  const anyPr = registry.sessions.some((x) => x.source?.kind === 'pr' && !['done', 'abandoned'].includes(x.state));
  const prFacts = prs || anyPr ? listPullRequests(cwd, { env }) : { queried: false, complete: false, reason: 'not requested', prs: [] };
  const names = new Set();
  for (const s of registry.sessions) if (s.source?.branch && s.source.kind === 'branch') names.add(s.source.branch);
  for (const b of branches.branches ?? []) if (b.name !== base && b.ahead > 0) names.add(b.name);
  let branchesNotAnalysed = null;
  const analyse = new Set(names);
  if (Number.isInteger(maxBranches) && maxBranches >= 0 && names.size > maxBranches) {
    // Registered sessions first (they are the ones someone is waiting on), then the most recently touched.
    const sessionNames = new Set(registry.sessions.map((x) => x.source?.branch).filter((n) => names.has(n)));
    const tip = new Map((branches.branches ?? []).map((b) => [b.name, b.tipTime ?? 0]));
    const rest = [...names].filter((n) => !sessionNames.has(n)).sort((a, b) => (tip.get(b) - tip.get(a)) || (a < b ? -1 : 1));
    const ordered = [...sessionNames, ...rest];
    branchesNotAnalysed = { count: ordered.length - maxBranches, names: ordered.slice(maxBranches) };
    for (const n of branchesNotAnalysed.names) analyse.delete(n);
  }
  // The budget covers EVERY per-ref analysis: the branches above AND the materialised PR refs in the loop below.
  let budget = Number.isInteger(maxBranches) && maxBranches >= 0 ? maxBranches - analyse.size : Infinity;
  const changed = {}; const patchIds = {}; const findings = []; const evidenceNotes = {}; const prTrusted = new Set();
  for (const n of analyse) {
    changed[n] = changedFiles(cwd, base, n);
    if (patches) patchIds[n] = patchId(cwd, base, n);
  }
  // PR-backed sessions: their evidence is only trusted while it IS the PR's current head. A session whose
  // evidence cannot be established gets a per-SESSION note + warning; the shared per-branch evidence in
  // `changed` is never overwritten (another consumer of that branch legitimately depends on it).
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
    if (budget <= 0) {
      branchesNotAnalysed = { count: (branchesNotAnalysed?.count ?? 0) + 1, names: [...(branchesNotAnalysed?.names ?? []), prKey(s)] };
      noFiles(s, 'not analysed: the maxBranches budget is spent');
      continue;
    }
    budget -= 1;
    const files = changedFiles(cwd, base, ref);
    if (!files.queried) { noFiles(s, files.reason); continue; }
    changed[prKey(s)] = files;
  }
  const up = resolveUpstream(cwd, base, trainsRead.trains);
  return {
    findings, evidenceNotes, prTrusted, dir, now, leaseMs: leaseMsFrom(env), baseOid: (() => { const h = headOf(cwd, `refs/heads/${base}`); return h.ok ? h.oid : null; })(),
    base: { name: base, upstream: up.upstream, freshness: baseFreshness(cwd, { base, upstream: up.upstream }) },
    registry, hold: readHold(dir), trains: trainsRead.trains, trainsInvalid: trainsRead.invalid,
    worktrees: worktrees ? listWorktrees(cwd) : { queried: false, reason: 'not requested', worktrees: [] },
    branches, prs: prFacts, changed, patchIds,
    ...(branchesNotAnalysed ? { branchesNotAnalysed } : {}),
    ...(checks === false ? { checks: { queried: false, reason: 'not requested' } } : {}),
  };
}

/** The hook's session/overlap payload, derived from a joined status. */
export function payloadFromStatus(status) {
  const sessions = status.items.filter((i) => i.tracked).map((i) => ({
    id: i.id, branch: i.branch, oid: i.oid, paths: i.paths, changedFiles: i.changedFiles ?? [], state: i.state,
    waitingOn: i.waitingOn.map(({ kind, ref, note, since }) => ({ kind, ref, note, since })),
  }));
  const overlaps = [];
  for (const i of status.items) for (const o of i.overlaps) if (i.id < o.with) overlaps.push({ a: i.id, b: o.with, via: o.via, files: o.files, known: o.known });
  return { sessions, overlaps };
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
    return { session: s, live, changedFiles: k && facts.changed?.[k]?.queried ? facts.changed[k].files : [] };
  });
}
